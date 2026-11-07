// Direct core connections (spec 14.5 DB connections and remote databases, 14.6 Sync in Remote Data).
// A person saves a login for the institution's core replica; DI tests it, proves it is read-only,
// lists what it can see and matches it to a ready-made mapping for that core. On approval DI records
// the connection and pulls every mapped table into its landing tables, then reconciles them against
// the curated tables row by row. Nothing ever writes to the core: the login must be read-only, and
// every session is set read-only as well. The login's password is encrypted at rest, is never
// returned by any call, and never reaches an agent: agents refer to it by number.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import mysql from 'mysql2/promise';
import { landingTable, SYMITAR_CODES, type Pool } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';
import { compileMapExpr, MapExprError } from './mapExpr.ts';

const rows = async <T>(pool: Pool | mysql.Connection, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

// ---- core systems and their mappings ------------------------------------------------------------

export type Transform =
  | { kind: 'same' }
  | { kind: 'number' }
  | { kind: 'date8' }
  | { kind: 'code'; codes: Record<string, string> }
  | { kind: 'rate1000' }
  | { kind: 'daysPast' }
  | { kind: 'not' }
  | { kind: 'nonzero' };

export interface ColumnMap {
  /** DI's column. */
  di: string;
  /** The core's column, as alias.COLUMN within the mapping's FROM. */
  their: string;
  how: Transform;
}

export interface TableMap {
  diTable: string;
  label: string;
  theirTables: string[];
  /** The core tables joined, written by Kinective for the template; never from a person or a model. */
  from: string;
  key: string;
  columns: ColumnMap[];
}

export interface CoreSystem {
  id: string;
  label: string;
  short: string;
  /** Kinective's ready-made mapping for this core, when there is one. */
  mappings?: TableMap[];
  /** The core's own process date, for figures such as days past due. */
  processDate?: string;
}

const invert = (codes: Record<string, number>) => Object.fromEntries(Object.entries(codes).map(([k, v]) => [String(v), k]));
const c = (di: string, their: string, how: Transform = { kind: 'same' }): ColumnMap => ({ di, their, how });

const SYMITAR: TableMap[] = [
  {
    diTable: 'cdm_party',
    label: 'Members',
    theirTables: ['ACCOUNT', 'NAME'],
    from: 'ACCOUNT a JOIN NAME n ON n.PARENTACCOUNT = a.ACCOUNTNUMBER AND n.TYPE = 0',
    key: 'party_id',
    columns: [
      c('party_id', 'a.ACCOUNTNUMBER', { kind: 'number' }),
      c('first_name', 'n.FIRST'),
      c('last_name', 'n.LAST'),
      c('birth_date', 'n.BIRTHDATE', { kind: 'date8' }),
      c('join_date', 'a.OPENDATE', { kind: 'date8' }),
      c('primary_branch_id', 'a.BRANCH', { kind: 'number' }),
      c('segment_code', 'a.TYPE', { kind: 'code', codes: invert(SYMITAR_CODES.memberType) }),
      c('household_id', 'a.HOUSEHOLDACCOUNT', { kind: 'number' }),
      c('is_member', 'a.NONMEMBER', { kind: 'not' }),
    ],
  },
  {
    diTable: 'cdm_deposit_account',
    label: 'Deposit accounts',
    theirTables: ['SAVINGS'],
    from: 'SAVINGS s',
    key: 'account_id',
    columns: [
      c('account_id', 's.SERIAL', { kind: 'number' }),
      c('party_id', 's.PARENTACCOUNT', { kind: 'number' }),
      c('branch_id', 's.BRANCH', { kind: 'number' }),
      c('deposit_category', 's.TYPE', { kind: 'code', codes: invert(SYMITAR_CODES.shareType) }),
      c('open_date', 's.OPENDATE', { kind: 'date8' }),
      c('close_date', 's.CLOSEDATE', { kind: 'date8' }),
      c('maturity_date', 's.MATURITYDATE', { kind: 'date8' }),
      c('balance', 's.BALANCE', { kind: 'number' }),
      c('rate', 's.DIVRATE', { kind: 'rate1000' }),
    ],
  },
  {
    diTable: 'cdm_loan',
    label: 'Loan accounts',
    theirTables: ['LOAN'],
    from: 'LOAN l',
    key: 'loan_id',
    columns: [
      c('loan_id', 'l.SERIAL', { kind: 'number' }),
      c('party_id', 'l.PARENTACCOUNT', { kind: 'number' }),
      c('branch_id', 'l.BRANCH', { kind: 'number' }),
      c('officer_id', 'l.LOANOFFICER', { kind: 'number' }),
      c('loan_category', 'l.TYPE', { kind: 'code', codes: invert(SYMITAR_CODES.loanType) }),
      c('is_indirect', 'l.DEALERNUMBER', { kind: 'nonzero' }),
      c('open_date', 'l.OPENDATE', { kind: 'date8' }),
      c('close_date', 'l.CLOSEDATE', { kind: 'date8' }),
      c('charge_off_date', 'l.CHARGEOFFDATE', { kind: 'date8' }),
      c('original_amount', 'l.ORIGINALBALANCE', { kind: 'number' }),
      c('balance', 'l.BALANCE', { kind: 'number' }),
      c('rate', 'l.INTERESTRATE', { kind: 'rate1000' }),
      c('days_delinquent', 'l.DUEDATE', { kind: 'daysPast' }),
    ],
  },
];

export const CORE_SYSTEMS: CoreSystem[] = [
  { id: 'symitar', label: 'Jack Henry Symitar', short: 'Symitar', mappings: SYMITAR, processDate: 'SELECT PROCESSDATE AS d FROM CONTROL' },
  { id: 'dna', label: 'Fiserv DNA', short: 'DNA' },
  { id: 'keystone', label: 'Corelation KeyStone', short: 'KeyStone' },
  { id: 'premier', label: 'Fiserv Premier', short: 'Premier' },
  { id: 'other', label: 'Another MySQL database', short: 'Database' },
];
export const coreSystem = (id: string) => CORE_SYSTEMS.find((s) => s.id === id) ?? null;

/** How a mapping reads, for a person: "a.OPENDATE (YYYYMMDD date)". */
export function describeTransform(t: Transform) {
  switch (t.kind) {
    case 'same':
      return 'as is';
    case 'number':
      return 'number';
    case 'date8':
      return 'YYYYMMDD to date, 00000000 is blank';
    case 'code':
      return `type code to name (${Object.keys(t.codes).length} codes)`;
    case 'rate1000':
      return 'thousandths of a percent to percent';
    case 'daysPast':
      return 'due date to days past due, as of the process date';
    case 'not':
      return 'non-member flag reversed';
    case 'nonzero':
      return 'a dealer number means indirect';
  }
}

type Raw = string | number | null;
const date8 = (v: Raw) => {
  const s = v === null ? '' : String(v).trim();
  return /^\d{8}$/.test(s) && s !== '00000000' ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
};
const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;

/** One core value in DI's terms. Unknown codes stay visible rather than becoming a wrong name. */
export function transform(v: Raw, t: Transform, processDate: string | null): Raw {
  switch (t.kind) {
    case 'same':
      return typeof v === 'string' ? v.trim() : v;
    case 'number':
      return v === null || String(v).trim() === '' ? null : Number(v);
    case 'date8':
      return date8(v);
    case 'code':
      return v === null ? null : (t.codes[String(Number(v))] ?? `Code ${v}`);
    case 'rate1000':
      return v === null ? null : Math.round(Number(v)) / 1000;
    case 'daysPast': {
      const due = date8(v);
      return due && processDate ? Math.max(0, dayNumber(processDate) - dayNumber(due)) : 0;
    }
    case 'not':
      return Number(v) ? 0 : 1;
    case 'nonzero':
      return Number(v) ? 1 : 0;
  }
}

/** Core tables a custom mapping may read, besides its own (Symitar's, here). */
export const CUSTOM_TABLES = ['ACCOUNT', 'NAME', 'SAVINGS', 'LOAN', 'LOANTRANSACTION', 'ACCOUNTTRACKING'];

// ---- results ------------------------------------------------------------------------------------

export interface SavedLogin {
  credentialId: number;
  system: CoreSystem;
  host: string;
  port: number;
  database: string;
  login: string;
}

export interface MappingCheck {
  map: TableMap;
  /** The core's rows behind it. */
  rows: number;
  /** Core columns the mapping needs that the login can't see. */
  missing: string[];
}

export interface ConnectionTest {
  login: SavedLogin;
  readOnly: boolean;
  /** What the login may do beyond reading, when it may. */
  writeGrants: string[];
  version: string;
  tables: { name: string; rows: number }[];
  processDate: string | null;
  mappings: MappingCheck[] | null;
}

export interface TableReconcile {
  diTable: string;
  label: string;
  pulled: number;
  inDi: number;
  matched: number;
  newInCore: number;
  notInCore: number;
  differ: number;
}

export interface Difference {
  diTable: string;
  label: string;
  key: number | string;
  field: string;
  di: Raw;
  core: Raw;
}

export interface PullResult {
  runId: number;
  connection: SourceConnection;
  at: string;
  rows: number;
  processDate: string | null;
  tables: TableReconcile[];
  differences: Difference[];
  replayed?: boolean;
}

export interface SourceConnection {
  connectionId: number;
  name: string;
  system: CoreSystem;
  host: string;
  database: string;
  login: string;
  schedule: string;
  state: string;
  inUse: boolean;
  inUseSince: string | null;
  createdName: string;
  createdOn: string;
  tables: { diTable: string; label: string; theirTables: string[] }[];
  lastRun: { at: string; state: string; rows: number } | null;
}

// ---- the service --------------------------------------------------------------------------------

const ALGO = 'aes-256-gcm';
/** A key from DI_SECRET_KEY, or a fixed local one so the demo runs without setup. */
export const secretKeyFrom = (value = process.env.DI_SECRET_KEY) => scryptSync(value ?? 'dinext-local-development-only', 'dinext-src-credential', 32);

const WRITE_PRIVS = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|INDEX|TRIGGER|EXECUTE|GRANT OPTION|SUPER|FILE|EVENT|REFERENCES|LOCK TABLES|CREATE ROUTINE|ALTER ROUTINE)\b/i;
const IDENT = /^[A-Za-z0-9_$-]{1,64}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const BATCH = 2000;

// ---- custom column mappings --------------------------------------------------------------------

export type CustomValueType = 'text' | 'number' | 'date' | 'flag';
export interface ColumnMapRow {
  diTable: string;
  target: string;
  field: string;
  label: string;
  /** The core column or expression, as a person reads it. */
  source: string;
  how: string;
  origin: 'Kinective' | 'Custom';
  /** Standard rows can't be changed; custom rows can be replaced or removed, each by approval. */
  locked: boolean;
  addedBy?: string;
  addedOn?: string;
  note?: string;
  mapId?: number;
  valueType?: CustomValueType;
  /** Records with a value after the last pull, for custom rows. */
  filled?: number;
}
export interface MapPreview {
  connectionId: number;
  target: string;
  diTable: string;
  expression: string;
  valueType: CustomValueType;
  total: number;
  filled: number;
  distinct: number;
  top: { value: string; count: number }[];
  sample: { key: string; value: string }[];
}
export interface MapSuggestion {
  target: string;
  label: string;
  expression: string;
  valueType: CustomValueType;
  why: string;
  filled: number;
  samples: string[];
}
/** Where a custom mapping can put its values: DI's tables a core connection feeds. */
export const MAP_TARGETS: Record<string, string> = { members: 'cdm_party', deposits: 'cdm_deposit_account', loans: 'cdm_loan' };
const targetOf = (diTable: string) => Object.entries(MAP_TARGETS).find(([, t]) => t === diTable)?.[0] ?? diTable;
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
const n = (x: number) => x.toLocaleString('en-US');
const fieldKey = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'field';
const customValue = (v: Raw, type: CustomValueType): { text: string | null; num: number | null } => {
  if (v === null || v === undefined || String(v).trim() === '') return { text: null, num: null };
  if (type === 'number') return Number.isFinite(Number(v)) ? { text: null, num: Number(v) } : { text: null, num: null };
  if (type === 'flag') {
    const t = String(v).trim().toUpperCase();
    return { text: null, num: t === 'Y' || t === 'YES' || t === 'TRUE' || (Number.isFinite(Number(t)) && Number(t) !== 0) ? 1 : 0 };
  }
  if (type === 'date') return { text: date8(v) ?? (/^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null), num: null };
  return { text: String(v).trim().slice(0, 200), num: null };
};
const showValue = (v: Raw, type: CustomValueType) => {
  const c = customValue(v, type);
  if (type === 'flag') return c.num === null ? '—' : c.num ? 'Yes' : 'No';
  return c.num !== null ? String(c.num) : (c.text ?? '—');
};

export interface SourceOptions {
  secretKey: Buffer;
  /** Hosts DI's network can reach: the institution's VPN or private link endpoints. */
  allowedHosts: string[];
  ssl?: mysql.SslOptions;
}

export class SourceService {
  constructor(
    private readonly pool: Pool,
    private readonly opts: SourceOptions,
  ) {}

  private seal(secret: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.opts.secretKey, iv);
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
  }

  private unseal(sealed: string) {
    const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv(ALGO, this.opts.secretKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  /** Saves a login. The password is encrypted here and never leaves DI Core again. */
  async saveLogin(input: { system: string; host: string; port: number; database: string; login: string; password: string }, owner: { userId: string }): Promise<SavedLogin> {
    const system = coreSystem(input.system);
    if (!system) throw new CoreError('INVALID', 'Choose which core system this is.');
    const host = input.host.trim().toLowerCase();
    if (!HOST.test(host)) throw new CoreError('INVALID', 'Enter the server’s host name or address, such as replica.core.example.org.');
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new CoreError('INVALID', 'The port is a number from 1 to 65535.');
    if (!IDENT.test(input.database.trim())) throw new CoreError('INVALID', 'Enter the database name the login can read.');
    if (!IDENT.test(input.login.trim())) throw new CoreError('INVALID', 'Enter the login’s user name.');
    if (!input.password || input.password.length > 200) throw new CoreError('INVALID', 'Enter the login’s password.');
    if (!this.opts.allowedHosts.map((h) => h.toLowerCase()).includes(host)) throw new CoreError('NO_ACCESS', `DI can only reach networks Kinective has opened for this institution, through a VPN or private link. ${host} isn’t one of them yet. Ask Kinective to open it, then try again.`);
    const [r] = (await this.pool.query('INSERT INTO src_credential (system_id, host, port, database_name, login, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [system.id, host, input.port, input.database.trim(), input.login.trim(), this.seal(input.password), owner.userId, nowSql()])) as unknown as [{ insertId: number }];
    return { credentialId: r.insertId, system, host, port: input.port, database: input.database.trim(), login: input.login.trim() };
  }

  /** A saved login, without its password. Only the person who saved it can use it. */
  async login(credentialId: number, userId: string): Promise<SavedLogin> {
    const [r] = await rows<{ credential_id: number; system_id: string; host: string; port: number; database_name: string; login: string; created_by: string }>(this.pool, 'SELECT credential_id, system_id, host, port, database_name, login, created_by FROM src_credential WHERE credential_id = ?', [credentialId]);
    if (!r || r.created_by !== userId) throw new CoreError('NOT_FOUND', `There are no connection details #${credentialId} saved by you. Enter them under “Connect a source” on Integrations.`);
    return { credentialId: r.credential_id, system: coreSystem(r.system_id)!, host: r.host, port: r.port, database: r.database_name, login: r.login };
  }

  /** The connection details this person saved most recently, by number. */
  async latestLogin(userId: string) {
    const [r] = await rows<{ credential_id: number }>(this.pool, 'SELECT credential_id FROM src_credential WHERE created_by = ? ORDER BY credential_id DESC LIMIT 1', [userId]);
    return r?.credential_id ?? null;
  }

  private async open(credentialId: number) {
    const [r] = await rows<{ host: string; port: number; database_name: string; login: string; secret: string }>(this.pool, 'SELECT host, port, database_name, login, secret FROM src_credential WHERE credential_id = ?', [credentialId]);
    if (!r) throw new CoreError('NOT_FOUND', 'Those connection details are no longer saved.');
    if (!this.opts.allowedHosts.map((h) => h.toLowerCase()).includes(r.host)) throw new CoreError('NO_ACCESS', `DI can no longer reach ${r.host}. Ask Kinective whether the network link changed.`);
    let conn: mysql.Connection;
    try {
      conn = await mysql.createConnection({ host: r.host, port: r.port, user: r.login, password: this.unseal(r.secret), database: r.database_name, connectTimeout: 6000, dateStrings: true, decimalNumbers: true, ...(this.opts.ssl ? { ssl: this.opts.ssl } : {}) });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ER_ACCESS_DENIED_ERROR') throw new CoreError('INVALID', `The core refused the login ${r.login}. Check the user name and password with the core’s administrator.`);
      if (code === 'ER_BAD_DB_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR') throw new CoreError('INVALID', `The login works, but it can’t open a database called ${r.database_name}. Check the name with the core’s administrator.`);
      if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') throw new CoreError('INVALID', `Nothing answered at ${r.host}:${r.port}. Check the host and port, and that the replica is running.`);
      throw new CoreError('INVALID', `The connection to ${r.host}:${r.port} failed (${code ?? 'no reason given'}).`);
    }
    // A second guard: even a login that could write runs here in read-only sessions.
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    return conn;
  }

  private async withCore<T>(credentialId: number, work: (conn: mysql.Connection) => Promise<T>) {
    const conn = await this.open(credentialId);
    try {
      return await work(conn);
    } finally {
      await conn.end().catch(() => {});
    }
  }

  /** What a login can do: read only, or more. */
  private async grants(conn: mysql.Connection, database: string) {
    const lines = (await rows<Record<string, string>>(conn, 'SHOW GRANTS')).map((g) => Object.values(g)[0] ?? '');
    const writes = lines.filter((l) => {
      const m = /^GRANT (.+) ON (\S+) TO/i.exec(l);
      if (!m) return false;
      const scope = m[2]!.replaceAll('`', '');
      return WRITE_PRIVS.test(m[1]!) && (scope === '*.*' || scope.startsWith(`${database}.`));
    });
    return writes.map((l) => /^GRANT (.+) ON (\S+) TO/i.exec(l)!.slice(1, 3).join(' on '));
  }

  /** Connects, proves the login is read-only, lists the tables and checks the ready-made mapping. Changes nothing. */
  async test(credentialId: number, userId: string): Promise<ConnectionTest> {
    const login = await this.login(credentialId, userId);
    return this.withCore(credentialId, async (conn) => {
      const writeGrants = await this.grants(conn, login.database);
      const [{ v: version }] = (await rows<{ v: string }>(conn, 'SELECT VERSION() AS v')) as [{ v: string }];
      const tableList = await rows<{ name: string }>(conn, 'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [login.database]);
      const tables: { name: string; rows: number }[] = [];
      for (const t of tableList.slice(0, 60)) {
        const [n] = await rows<{ n: number }>(conn, `SELECT COUNT(*) AS n FROM \`${t.name.replaceAll('`', '')}\``);
        tables.push({ name: t.name, rows: Number(n?.n ?? 0) });
      }
      const processDate = await this.processDate(conn, login.system);
      let mappings: MappingCheck[] | null = null;
      if (login.system.mappings) {
        const cols = await rows<{ t: string; c: string }>(conn, 'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?', [login.database]);
        const have = new Set(cols.map((x) => `${x.t}.${x.c}`.toUpperCase()));
        mappings = login.system.mappings.map((map) => {
          const alias = aliases(map);
          const missing = map.columns.map((col) => `${alias[col.their.split('.')[0]!] ?? ''}.${col.their.split('.')[1]}`).filter((q) => !have.has(q.toUpperCase()));
          const main = tables.find((t) => t.name.toUpperCase() === map.theirTables[0]!.toUpperCase());
          return { map, rows: main?.rows ?? 0, missing };
        });
      }
      return { login, readOnly: writeGrants.length === 0, writeGrants, version, tables, processDate, mappings };
    });
  }

  private async processDate(conn: mysql.Connection, system: CoreSystem) {
    if (!system.processDate) return null;
    const [r] = await rows<{ d: string }>(conn, system.processDate).catch(() => []);
    return r ? date8(r.d) : null;
  }

  /** Records a connection and its mappings, once per approval. Refuses a login that could write. */
  async create(p: { credentialId: number; name: string; schedule: string; tables: string[] }, owner: { userId: string; name: string }, meta: { approvalId: string; on: string }) {
    const [done] = await rows<{ connection_id: number }>(this.pool, 'SELECT connection_id FROM src_connection WHERE approval_id = ?', [meta.approvalId]);
    if (done) return done.connection_id;
    const t = await this.test(p.credentialId, owner.userId);
    if (!t.readOnly) throw new CoreError('INVALID', 'This login can change data in the core, so DI won’t connect with it.');
    const maps = (t.mappings ?? []).filter((m) => p.tables.includes(m.map.diTable) && !m.missing.length);
    if (!maps.length) throw new CoreError('INVALID', 'None of the tables to map can be read with this login.');
    const [r] = (await this.pool.query("INSERT INTO src_connection (name, system_id, credential_id, schedule, state, in_use, created_by, created_name, created_on, approval_id) VALUES (?, ?, ?, ?, 'Connected', 0, ?, ?, ?, ?)", [p.name.slice(0, 80), t.login.system.id, p.credentialId, p.schedule.slice(0, 40), owner.userId, owner.name, meta.on, meta.approvalId])) as unknown as [{ insertId: number }];
    for (const m of maps) await this.pool.query('INSERT INTO src_mapping (connection_id, di_table, their_tables, definition) VALUES (?, ?, ?, ?)', [r.insertId, m.map.diTable, m.map.theirTables.join(', '), JSON.stringify(m.map)]);
    return r.insertId;
  }

  /** Every connection, newest first, with its last pull. */
  async connections(): Promise<SourceConnection[]> {
    const list = await rows<{ connection_id: number; name: string; system_id: string; credential_id: number; schedule: string; state: string; in_use: number; in_use_since: string | null; created_name: string; created_on: string }>(this.pool, "SELECT connection_id, name, system_id, credential_id, schedule, state, in_use, DATE_FORMAT(in_use_since, '%Y-%m-%d') AS in_use_since, created_name, DATE_FORMAT(created_on, '%Y-%m-%d') AS created_on FROM src_connection ORDER BY connection_id DESC");
    if (!list.length) return [];
    const ids = list.map((c) => c.connection_id);
    const logins = await rows<{ credential_id: number; host: string; database_name: string; login: string }>(this.pool, `SELECT credential_id, host, database_name, login FROM src_credential WHERE credential_id IN (${list.map(() => '?').join(',')})`, list.map((c) => c.credential_id));
    const maps = await rows<{ connection_id: number; di_table: string; their_tables: string; definition: string | TableMap }>(this.pool, `SELECT connection_id, di_table, their_tables, definition FROM src_mapping WHERE connection_id IN (${ids.map(() => '?').join(',')}) ORDER BY mapping_id`, ids);
    const runs = await rows<{ connection_id: number; at: string; state: string; rows_pulled: number }>(this.pool, `SELECT r.connection_id, DATE_FORMAT(COALESCE(r.finished_at, r.started_at), '%Y-%m-%d %H:%i') AS at, r.state, r.rows_pulled FROM src_sync_run r JOIN (SELECT connection_id, MAX(run_id) AS id FROM src_sync_run GROUP BY connection_id) m ON m.id = r.run_id`);
    return list.map((c) => {
      const l = logins.find((x) => x.credential_id === c.credential_id);
      const run = runs.find((x) => x.connection_id === c.connection_id);
      return {
        connectionId: c.connection_id,
        name: c.name,
        system: coreSystem(c.system_id)!,
        host: l?.host ?? '—',
        database: l?.database_name ?? '—',
        login: l?.login ?? '—',
        schedule: c.schedule,
        state: c.state,
        inUse: c.in_use === 1,
        inUseSince: c.in_use_since,
        createdName: c.created_name,
        createdOn: c.created_on,
        tables: maps.filter((m) => m.connection_id === c.connection_id).map((m) => ({ diTable: m.di_table, label: (typeof m.definition === 'string' ? (JSON.parse(m.definition) as TableMap) : m.definition).label, theirTables: m.their_tables.split(', ') })),
        lastRun: run ? { at: run.at, state: run.state, rows: Number(run.rows_pulled) } : null,
      };
    });
  }

  /** A connection by name or number; the only one when nothing is named. */
  async connection(ref?: string | number) {
    const list = await this.connections();
    if (!list.length) throw new CoreError('NOT_FOUND', 'There’s no core connection yet. Enter the replica’s details under “Connect a source” on Integrations.');
    if (ref === undefined || ref === '') {
      if (list.length === 1) return list[0]!;
      throw new CoreError('INVALID', `Which connection: ${list.map((c) => c.name).join(' or ')}?`);
    }
    const want = String(ref).toLowerCase().replace(/^#/, '').trim();
    const found = list.find((c) => String(c.connectionId) === want || c.name.toLowerCase() === want) ?? list.find((c) => c.name.toLowerCase().includes(want) || want.includes(c.name.toLowerCase()) || want.includes(c.system.short.toLowerCase()));
    if (!found) throw new CoreError('NOT_FOUND', `There’s no connection called ${ref}. There ${list.length === 1 ? 'is' : 'are'}: ${list.map((c) => c.name).join(', ')}.`);
    return found;
  }

  /**
   * Pulls every mapped table into its landing table, replacing what landed before, then reconciles
   * it against the curated table. Once per approval: a second call returns the first run.
   */
  async pull(connectionId: number, meta: { approvalId: string }): Promise<PullResult> {
    const [done] = await rows<{ run_id: number }>(this.pool, 'SELECT run_id FROM src_sync_run WHERE approval_id = ?', [meta.approvalId]);
    if (done) return { ...(await this.run(done.run_id)), replayed: true };
    const conn = (await this.connections()).find((x) => x.connectionId === connectionId);
    if (!conn) throw new CoreError('NOT_FOUND', 'That connection isn’t there any more.');
    const [cred] = await rows<{ credential_id: number }>(this.pool, 'SELECT credential_id FROM src_connection WHERE connection_id = ?', [connectionId]);
    const maps = (await rows<{ definition: string | TableMap }>(this.pool, 'SELECT definition FROM src_mapping WHERE connection_id = ? ORDER BY mapping_id', [connectionId])).map((m) => (typeof m.definition === 'string' ? (JSON.parse(m.definition) as TableMap) : m.definition));
    const started = nowSql();
    const [ins] = (await this.pool.query("INSERT INTO src_sync_run (connection_id, started_at, state, approval_id) VALUES (?, ?, 'Running', ?)", [connectionId, started, meta.approvalId])) as unknown as [{ insertId: number }];
    const runId = ins.insertId;
    try {
      let total = 0;
      let processDate: string | null = null;
      const custom = await this.activeCustom(conn.system.id);
      const customValues: { diTable: string; rows: { record: number; field: string; text: string | null; num: number | null }[]; fields: { field: string; label: string; filled: number }[] }[] = [];
      await this.withCore(cred!.credential_id, async (core) => {
        processDate = await this.processDate(core, conn.system);
        for (const map of maps) {
          const select = map.columns.map((col, i) => `${col.their} AS c${i}`).join(', ');
          const found = await rows<Record<string, Raw>>(core, `SELECT ${select} FROM ${map.from}`);
          const typed = found.map((r) => map.columns.map((col, i) => transform(r[`c${i}`] ?? null, col.how, processDate)));
          await this.land(map, typed);
          total += typed.length;
          // The institution's own mappings for this table, compiled by DI from their checked expressions.
          const mine = custom.filter((c) => c.di_table === map.diTable);
          if (mine.length) customValues.push(await this.readCustom(core, map, mine, processDate));
        }
      });
      for (const c of customValues) await this.landCustom(c.diTable, c.fields.map((f) => f.field), c.rows);
      const recon = await this.reconcile(maps);
      const detail = { processDate, ...recon, customFields: customValues.flatMap((c) => c.fields.map((f) => ({ ...f, diTable: c.diTable }))) };
      await this.pool.query("UPDATE src_sync_run SET finished_at = ?, state = 'Done', rows_pulled = ?, detail = ? WHERE run_id = ?", [nowSql(), total, JSON.stringify(detail), runId]);
      return this.run(runId);
    } catch (e) {
      await this.pool.query("UPDATE src_sync_run SET finished_at = ?, state = 'Failed', detail = ? WHERE run_id = ?", [nowSql(), JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 300) : String(e) }), runId]);
      throw e;
    }
  }

  /** Replaces a landing table's rows in one transaction, so a reader never sees half a pull. */
  private async land(map: TableMap, typed: Raw[][]) {
    const table = landingTable(map.diTable);
    const cols = map.columns.map((col) => col.di).join(', ');
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM ${table}`);
      for (let i = 0; i < typed.length; i += BATCH) await conn.query(`INSERT INTO ${table} (${cols}) VALUES ?`, [typed.slice(i, i + BATCH)]);
      await conn.commit();
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Landing against curated, by key: what matches, what's only on one side, and which values differ. */
  private async reconcile(maps: TableMap[]) {
    const tables: TableReconcile[] = [];
    const differences: Difference[] = [];
    for (const map of maps) {
      const land = landingTable(map.diTable);
      const k = map.key;
      const others = map.columns.map((col) => col.di).filter((x) => x !== k);
      const same = others.map((x) => `l.${x} <=> d.${x}`).join(' AND ');
      const [counts] = await rows<{ pulled: number; in_di: number; joined: number; matched: number }>(
        this.pool,
        `SELECT (SELECT COUNT(*) FROM ${land}) AS pulled, (SELECT COUNT(*) FROM ${map.diTable}) AS in_di, COUNT(*) AS joined, COALESCE(SUM(${same}), 0) AS matched FROM ${land} l JOIN ${map.diTable} d ON d.${k} = l.${k}`,
      );
      const pulled = Number(counts!.pulled);
      const inDi = Number(counts!.in_di);
      const joined = Number(counts!.joined);
      const matched = Number(counts!.matched);
      tables.push({ diTable: map.diTable, label: map.label, pulled, inDi, matched, newInCore: pulled - joined, notInCore: inDi - joined, differ: joined - matched });
      if (joined > matched) {
        const diff = await rows<Record<string, Raw>>(this.pool, `SELECT l.${k} AS k, ${others.map((x) => `l.${x} AS l_${x}, d.${x} AS d_${x}`).join(', ')} FROM ${land} l JOIN ${map.diTable} d ON d.${k} = l.${k} WHERE NOT (${same}) ORDER BY l.${k} LIMIT 20`);
        for (const r of diff) for (const x of others) if (String(r[`l_${x}`]) !== String(r[`d_${x}`])) differences.push({ diTable: map.diTable, label: map.label, key: r.k as number, field: x, di: r[`d_${x}`] ?? null, core: r[`l_${x}`] ?? null });
      }
      if (pulled > joined) {
        const extra = await rows<{ k: number }>(this.pool, `SELECT l.${k} AS k FROM ${land} l LEFT JOIN ${map.diTable} d ON d.${k} = l.${k} WHERE d.${k} IS NULL ORDER BY l.${k} LIMIT 10`);
        for (const r of extra) differences.push({ diTable: map.diTable, label: map.label, key: r.k, field: '(whole row)', di: null, core: 'In the core, not in DI' });
      }
    }
    return { tables, differences };
  }

  private async run(runId: number): Promise<PullResult> {
    const [r] = await rows<{ connection_id: number; at: string; rows_pulled: number; detail: string | { processDate: string | null; tables: TableReconcile[]; differences: Difference[] } }>(this.pool, "SELECT connection_id, DATE_FORMAT(COALESCE(finished_at, started_at), '%Y-%m-%d %H:%i') AS at, rows_pulled, detail FROM src_sync_run WHERE run_id = ?", [runId]);
    const conn = (await this.connections()).find((x) => x.connectionId === r!.connection_id)!;
    const detail = (typeof r!.detail === 'string' ? JSON.parse(r!.detail) : r!.detail) ?? { processDate: null, tables: [], differences: [] };
    return { runId, connection: conn, at: r!.at, rows: Number(r!.rows_pulled), processDate: detail.processDate ?? null, tables: detail.tables ?? [], differences: detail.differences ?? [] };
  }

  /** The latest finished pull for a connection, if any. */
  // ---- custom column mappings ----

  private async activeCustom(system: string) {
    return rows<{ map_id: number; di_table: string; field: string; label: string; expression: string; value_type: CustomValueType }>(this.pool, "SELECT map_id, di_table, field, label, expression, value_type FROM src_column_map WHERE system_id = ? AND state = 'Active' ORDER BY map_id", [system]).catch(() => []);
  }

  /** The record key and each custom field's value, read in one query from the core. */
  private async readCustom(core: mysql.Connection, map: TableMap, mine: { field: string; label: string; expression: string; value_type: CustomValueType }[], processDate: string | null) {
    const keyCol = map.columns.find((c) => c.di === map.key)!;
    const scope = { aliases: aliases(map), tables: CUSTOM_TABLES };
    const compiled = mine.map((m) => compileMapExpr(m.expression, scope).sql);
    const found = await rows<Record<string, Raw>>(core, `SELECT ${keyCol.their} AS k, ${compiled.map((sql, i) => `${sql} AS f${i}`).join(', ')} FROM ${map.from}`);
    const out: { record: number; field: string; text: string | null; num: number | null }[] = [];
    const filled = mine.map(() => 0);
    for (const r of found) {
      const record = Number(transform(r.k ?? null, keyCol.how, processDate));
      mine.forEach((m, i) => {
        const v = customValue(r[`f${i}`] ?? null, m.value_type);
        if (v.text === null && v.num === null) return;
        filled[i]!++;
        out.push({ record, field: m.field, ...v });
      });
    }
    return { diTable: map.diTable, rows: out, fields: mine.map((m, i) => ({ field: m.field, label: m.label, filled: filled[i]! })) };
  }

  /** Replaces the values of the fields a pull read, in one transaction. */
  private async landCustom(diTable: string, fields: string[], values: { record: number; field: string; text: string | null; num: number | null }[]) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM cdm_custom_field WHERE di_table = ? AND field IN (?)', [diTable, fields]);
      const tuples = values.map((v) => [diTable, v.record, v.field, v.text, v.num]);
      for (let i = 0; i < tuples.length; i += BATCH) await conn.query('INSERT INTO cdm_custom_field (di_table, record_id, field, value_text, value_num) VALUES ?', [tuples.slice(i, i + BATCH)]);
      await conn.commit();
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Every mapping for a core: Kinective's standard columns, locked, then the institution's own. */
  async columnMaps(systemId = 'symitar'): Promise<ColumnMapRow[]> {
    const system = coreSystem(systemId);
    const standard: ColumnMapRow[] = (system?.mappings ?? []).flatMap((map) => map.columns.map((c) => ({ diTable: map.diTable, target: targetOf(map.diTable), field: c.di, label: c.di, source: c.their, how: describeTransform(c.how), origin: 'Kinective' as const, locked: true })));
    const custom = await rows<{ map_id: number; di_table: string; field: string; label: string; expression: string; value_type: CustomValueType; note: string | null; added_name: string; added_on: unknown }>(this.pool, "SELECT map_id, di_table, field, label, expression, value_type, note, added_name, added_on FROM src_column_map WHERE system_id = ? AND state = 'Active' ORDER BY map_id", [systemId]).catch(() => []);
    const filled = await rows<{ di_table: string; field: string; n: number }>(this.pool, 'SELECT di_table, field, COUNT(*) AS n FROM cdm_custom_field GROUP BY di_table, field').catch(() => []);
    return [
      ...standard,
      ...custom.map((c) => ({ diTable: c.di_table, target: targetOf(c.di_table), field: c.field, label: c.label, source: c.expression, how: c.value_type, origin: 'Custom' as const, locked: false, addedBy: c.added_name, addedOn: day(c.added_on), ...(c.note ? { note: c.note } : {}), mapId: c.map_id, valueType: c.value_type, filled: Number(filled.find((f) => f.di_table === c.di_table && f.field === c.field)?.n ?? 0) })),
    ];
  }

  /** The connection a mapping is tried on: the one named, or the first that's connected. */
  private async mappingConnection(connectionId?: number) {
    const all = await this.connections();
    const conn = connectionId ? all.find((c) => c.connectionId === connectionId) : all[0];
    if (!conn) throw new CoreError('NOT_FOUND', 'There’s no core connection yet. Connect the core replica first; a mapping is tried on real rows before it’s saved.');
    const [cred] = await rows<{ credential_id: number }>(this.pool, 'SELECT credential_id FROM src_connection WHERE connection_id = ?', [conn.connectionId]);
    const map = conn.system.mappings?.find((m) => m.diTable === MAP_TARGETS.members) ? conn.system : null;
    if (!map) throw new CoreError('INVALID', `Kinective hasn’t mapped ${conn.system.label} yet, so there’s nothing to add a column to.`);
    return { conn, credentialId: cred!.credential_id };
  }

  /** Compiles and runs a proposed mapping on the core, read-only: coverage, top values and ten records. Changes nothing. */
  async previewMap(input: { target: string; expression: string; valueType: CustomValueType; connectionId?: number }): Promise<MapPreview> {
    const diTable = MAP_TARGETS[input.target];
    if (!diTable) throw new CoreError('INVALID', `A custom field can go on ${Object.keys(MAP_TARGETS).join(', ')}.`);
    const { conn, credentialId } = await this.mappingConnection(input.connectionId);
    const map = conn.system.mappings!.find((m) => m.diTable === diTable)!;
    return this.withCore(credentialId, async (core) => {
      const [{ db }] = (await rows<{ db: string }>(core, 'SELECT DATABASE() AS db')) as [{ db: string }];
      const cols = await rows<{ t: string; c: string }>(core, 'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?', [db]);
      const columns: Record<string, string[]> = {};
      for (const x of cols) (columns[x.t.toUpperCase()] ??= []).push(x.c.toUpperCase());
      let sql: string;
      try {
        sql = compileMapExpr(input.expression, { aliases: aliases(map), tables: CUSTOM_TABLES.filter((t) => columns[t]), columns }).sql;
      } catch (e) {
        if (e instanceof MapExprError) throw new CoreError('INVALID', `That expression can’t be used: ${e.message}`);
        throw e;
      }
      const keyCol = map.columns.find((c) => c.di === map.key)!;
      // A preview never runs long against the core.
      await core.query('SET SESSION MAX_EXECUTION_TIME = 15000').catch(() => {});
      const inner = `SELECT ${keyCol.their} AS k, ${sql} AS v FROM ${map.from}`;
      const [counts] = await rows<{ total: number; filled: number; distinct_n: number }>(core, `SELECT COUNT(*) AS total, SUM(v IS NOT NULL AND TRIM(v) <> '') AS filled, COUNT(DISTINCT v) AS distinct_n FROM (${inner}) t`);
      const top = await rows<{ v: Raw; n: number }>(core, `SELECT v, COUNT(*) AS n FROM (${inner}) t WHERE v IS NOT NULL AND TRIM(v) <> '' GROUP BY v ORDER BY n DESC LIMIT 6`);
      const sample = await rows<{ k: Raw; v: Raw }>(core, `SELECT k, v FROM (${inner}) t WHERE v IS NOT NULL AND TRIM(v) <> '' ORDER BY k LIMIT 10`);
      return {
        connectionId: conn.connectionId,
        target: input.target,
        diTable,
        expression: input.expression.trim(),
        valueType: input.valueType,
        total: Number(counts?.total ?? 0),
        filled: Number(counts?.filled ?? 0),
        distinct: Number(counts?.distinct_n ?? 0),
        top: top.map((t) => ({ value: showValue(t.v, input.valueType), count: Number(t.n) })),
        sample: sample.map((r) => ({ key: String(transform(r.k ?? null, keyCol.how, null)), value: showValue(r.v, input.valueType) })),
      };
    });
  }

  /** Records a custom mapping, once per approval; it takes effect from the next pull. A field of the same name is replaced. */
  async addColumnMap(p: { target: string; label: string; expression: string; valueType: CustomValueType; note?: string; systemId?: string }, owner: { userId: string; name: string }, meta: { approvalId: string; on: string }) {
    const [done] = await rows<{ map_id: number; field: string }>(this.pool, 'SELECT map_id, field FROM src_column_map WHERE approval_id = ?', [meta.approvalId]);
    if (done) return { mapId: done.map_id, field: done.field, replayed: true };
    const diTable = MAP_TARGETS[p.target];
    if (!diTable) throw new CoreError('INVALID', `A custom field can go on ${Object.keys(MAP_TARGETS).join(', ')}.`);
    const system = coreSystem(p.systemId ?? 'symitar');
    const map = system?.mappings?.find((m) => m.diTable === diTable);
    if (!map) throw new CoreError('INVALID', 'That core has no standard mapping to add to.');
    // Checked again at apply: what was approved is what runs.
    compileMapExpr(p.expression, { aliases: aliases(map), tables: CUSTOM_TABLES });
    const field = fieldKey(p.label);
    if (map.columns.some((c) => c.di === field)) throw new CoreError('INVALID', `${field} is one of Kinective’s standard columns, which can’t be changed.`);
    await this.pool.query("UPDATE src_column_map SET state = 'Replaced' WHERE system_id = ? AND di_table = ? AND field = ? AND state = 'Active'", [system!.id, diTable, field]);
    const [ins] = (await this.pool.query("INSERT INTO src_column_map (system_id, di_table, field, label, expression, value_type, state, note, added_by, added_name, added_on, approval_id) VALUES (?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?)", [system!.id, diTable, field, p.label.slice(0, 80), p.expression.trim(), p.valueType, p.note?.slice(0, 200) ?? null, owner.userId, owner.name, meta.on, meta.approvalId])) as unknown as [{ insertId: number }];
    return { mapId: ins.insertId, field, replayed: false };
  }

  /** Stops a custom mapping and clears the values it brought in. */
  async removeColumnMap(mapId: number) {
    const [m] = await rows<{ di_table: string; field: string; state: string }>(this.pool, 'SELECT di_table, field, state FROM src_column_map WHERE map_id = ?', [mapId]);
    if (!m) throw new CoreError('NOT_FOUND', 'That custom mapping isn’t there.');
    if (m.state !== 'Active') return { removed: false };
    await this.pool.query("UPDATE src_column_map SET state = 'Removed' WHERE map_id = ?", [mapId]);
    await this.pool.query('DELETE FROM cdm_custom_field WHERE di_table = ? AND field = ?', [m.di_table, m.field]);
    return { removed: true };
  }

  /**
   * Core fields Kinective's mapping doesn't cover, with a proposed mapping for each: for Symitar, the
   * institution's account tracking records, by TYPE and USER field, with how many members have a value.
   */
  async suggestColumnMaps(connectionId?: number): Promise<MapSuggestion[]> {
    const { conn, credentialId } = await this.mappingConnection(connectionId);
    const mapped = new Set((await this.activeCustom(conn.system.id)).map((m) => m.expression.replace(/\s+/g, ' ').toUpperCase()));
    return this.withCore(credentialId, async (core) => {
      const [has] = await rows<{ n: number }>(core, "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ACCOUNTTRACKING'");
      if (!Number(has?.n)) return [];
      const types = await rows<{ t: number; n: number; c1: number; c2: number; code: number; d1: number; a1: number }>(core, "SELECT TYPE AS t, COUNT(*) AS n, SUM(USERCHAR1 <> '') AS c1, SUM(USERCHAR2 <> '') AS c2, SUM(USERCODE1 <> 0) AS code, SUM(USERDATE1 <> '00000000') AS d1, SUM(USERAMOUNT1 <> 0) AS a1 FROM ACCOUNTTRACKING GROUP BY TYPE ORDER BY TYPE");
      const out: MapSuggestion[] = [];
      for (const t of types) {
        const fields: [string, number, CustomValueType][] = [
          ['USERCHAR1', Number(t.c1), 'text'],
          ['USERCHAR2', Number(t.c2), 'text'],
          ['USERCODE1', Number(t.code), 'number'],
          ['USERDATE1', Number(t.d1), 'date'],
          ['USERAMOUNT1', Number(t.a1), 'number'],
        ];
        for (const [f, filled, type0] of fields) {
          if (!filled) continue;
          const samples = (await rows<{ v: Raw }>(core, `SELECT ${f} AS v FROM ACCOUNTTRACKING WHERE TYPE = ? GROUP BY ${f} ORDER BY COUNT(*) DESC LIMIT 4`, [t.t])).map((r) => String(r.v ?? ''));
          // A field holding only Y and N is a yes-or-no.
          const type: CustomValueType = type0 === 'text' && samples.every((v) => /^[YN]$/.test(v)) ? 'flag' : type0;
          const expression = `FIRST_OF(ACCOUNTTRACKING, ${f}, PARENTACCOUNT = a.ACCOUNTNUMBER AND TYPE = ${t.t})`;
          if (mapped.has(expression.toUpperCase())) continue;
          out.push({ target: 'members', label: `Tracking type ${t.t} ${f}`, expression, valueType: type, why: `${n(filled)} members have a value in tracking type ${t.t}’s ${f}; Kinective’s standard mapping doesn’t read tracking records.`, filled, samples });
        }
      }
      return out;
    });
  }

  async lastPull(connectionId: number) {
    const [r] = await rows<{ run_id: number }>(this.pool, "SELECT run_id FROM src_sync_run WHERE connection_id = ? AND state = 'Done' ORDER BY run_id DESC LIMIT 1", [connectionId]);
    return r ? this.run(r.run_id) : null;
  }

  /** Makes a connection the source of its tables from the next build on, or stops that. Once per approval. */
  async setInUse(connectionId: number, inUse: boolean, meta: { on: string }) {
    if (inUse) await this.pool.query('UPDATE src_connection SET in_use = 0, in_use_since = NULL WHERE connection_id <> ? AND in_use = 1', [connectionId]);
    await this.pool.query('UPDATE src_connection SET in_use = ?, in_use_since = ? WHERE connection_id = ?', [inUse ? 1 : 0, inUse ? meta.on : null, connectionId]);
  }

  /** Which DI tables an in-use connection feeds, for lineage. */
  async feeds() {
    const out = new Map<string, { name: string; system: string; theirTables: string[]; lastPull: string | null; since: string | null; schedule: string }>();
    for (const c of await this.connections().catch(() => [])) {
      if (!c.inUse) continue;
      for (const t of c.tables) out.set(t.diTable, { name: c.name, system: c.system.label, theirTables: t.theirTables, lastPull: c.lastRun?.state === 'Done' ? c.lastRun.at : null, since: c.inUseSince, schedule: c.schedule });
    }
    return out;
  }
}

/** Alias to table in a mapping's FROM: "ACCOUNT a JOIN NAME n" gives { a: 'ACCOUNT', n: 'NAME' }. */
function aliases(map: TableMap) {
  const out: Record<string, string> = {};
  for (const m of map.from.matchAll(/(?:^|\bJOIN\s+)([A-Z][A-Z0-9_]*)\s+([a-z])\b/g)) out[m[2]!] = m[1]!;
  return out;
}
