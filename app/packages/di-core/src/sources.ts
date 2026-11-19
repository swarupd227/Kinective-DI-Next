// Direct core connections (spec 14.5 DB connections and remote databases, 14.6 Sync in Remote Data).
// A person saves a login for the institution's core replica; DI tests it, proves it is read-only,
// lists what it can see and matches it to a ready-made mapping for that core. On approval DI records
// the connection and pulls every mapped table into its landing tables, then reconciles them against
// the curated tables row by row. Nothing ever writes to the core: the login must be read-only, and
// every session is set read-only as well. The login's password is encrypted at rest, is never
// returned by any call, and never reaches an agent: agents refer to it by number.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import mysql from 'mysql2/promise';
import { landingTable, rawDatabase, SOURCE_TARGETS, SYMITAR_CODES, type Pool } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';
import { compileMapExpr, MapExprError } from './mapExpr.ts';
import { fromAliases, ontology } from '@dinext/ontology';
import { assign, compareWith, proposeCrosswalk, scoreAll, type MapTransform, type ColumnProfile, type CoreProfile, type CoreTableProfile, type Proposal, type Signals } from './mappingEngine.ts';

const rows = async <T>(pool: Pool | mysql.Connection, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

// ---- core systems and their mappings ------------------------------------------------------------

export type Transform =
  | { kind: 'same' }
  | { kind: 'number' }
  | { kind: 'date8' }
  | { kind: 'code'; codes: Record<string, string>; /** The vendor's code list, such as shareType, when the mapping came from a vendor pack. */ set?: string }
  | { kind: 'rate1000' }
  | { kind: 'daysPast' }
  | { kind: 'not' }
  | { kind: 'nonzero' }
  | { kind: 'mdy' }
  | { kind: 'cents' }
  | { kind: 'bps' }
  | { kind: 'flag' };

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
/** A core's standard mapping, from its vendor pack in the ontology (packages/ontology/model/vendors). */
const fromPack = (id: string, codes: Record<string, Record<string, number>>): TableMap[] => {
  const pack = ontology().vendors.get(id);
  if (!pack) return [];
  return pack.tables.map((t) => ({
    diTable: t.di_table,
    label: t.label,
    theirTables: t.their_tables,
    from: t.from,
    key: t.key,
    columns: t.columns.map((c): ColumnMap => ({ di: c.di, their: c.their, how: c.how === 'code' ? { kind: 'code', codes: invert(codes[c.codes!] ?? {}), set: c.codes } : ({ kind: c.how } as Transform) })),
  }));
};

const SYMITAR: TableMap[] = fromPack('symitar', SYMITAR_CODES);

export const CORE_SYSTEMS: CoreSystem[] = [
  { id: 'symitar', label: 'Jack Henry Symitar', short: 'Symitar', mappings: SYMITAR, processDate: ontology().vendors.get('symitar')?.process_date },
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
    case 'mdy':
      return 'MM/DD/YYYY to date';
    case 'cents':
      return 'cents to dollars';
    case 'bps':
      return 'basis points to percent';
    case 'flag':
      return 'Y, T or 1 is yes';
  }
}

type Raw = string | number | null;
const date8 = (v: Raw) => {
  const s = v === null ? '' : String(v).trim();
  return /^\d{8}$/.test(s) && s !== '00000000' ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
};
/** A US-style date, MM/DD/YYYY, as an ISO date; anything else is blank. */
const mdy = (v: Raw) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v === null ? '' : String(v).trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};
const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;

/** A core code as a crosswalk keys it: numbers without leading zeros (09 is 9), text trimmed (CHK). */
export const codeKey = (v: Raw) => {
  const s = String(v ?? '').trim();
  return /^-?\d+$/.test(s) ? String(Number(s)) : s;
};
/** A flag's value: Y, YES, T, TRUE and any number but 0 are yes; empty, N, F and 0 are no. */
const truthy = (v: Raw) => {
  const s = String(v ?? '').trim().toUpperCase();
  if (!s) return false;
  if (['Y', 'YES', 'T', 'TRUE'].includes(s)) return true;
  if (['N', 'NO', 'F', 'FALSE'].includes(s)) return false;
  return Number.isFinite(Number(s)) ? Number(s) !== 0 : true;
};

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
      return v === null ? null : (t.codes[codeKey(v)] ?? `Code ${codeKey(v)}`);
    case 'rate1000':
      return v === null ? null : Math.round(Number(v)) / 1000;
    case 'daysPast': {
      const due = date8(v) ?? mdy(v) ?? (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : null);
      return due && processDate ? Math.max(0, dayNumber(processDate) - dayNumber(due)) : 0;
    }
    case 'not':
      return truthy(v) ? 0 : 1;
    case 'nonzero':
      return truthy(v) ? 1 : 0;
    case 'mdy':
      return mdy(v);
    case 'cents':
      return v === null || String(v).trim() === '' ? null : Math.round(Number(v)) / 100;
    case 'bps':
      return v === null || String(v).trim() === '' ? null : Number(v) / 100;
    case 'flag':
      return truthy(v) ? 1 : 0;
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
  /** The mapping version the pull used. */
  version?: number | null;
  /** Rows whose code the crosswalk doesn't know: landed without that value until someone decides. */
  held?: HeldCodes[];
  /** Raw-zone tables the pull refreshed, with their rows. */
  raw?: { table: string; rows: number }[];
  /** The connection's raw-zone database, where those tables are. */
  rawZone?: string;
  /** How many drift items the pull found. */
  drift?: number;
}

// ---- mapping versions and drift (Core Mapping and Ontology, phase 3) ------------------------------

export interface VersionDefinition {
  tables: TableMap[];
  /** The core's columns, by table, when the version was first pulled with. */
  seen?: Record<string, string[]> | null;
}
export interface MappingVersion {
  versionId: number;
  versionNo: number;
  source: string;
  summary: string;
  createdName: string;
  createdAt: string;
  definition: VersionDefinition;
}
export interface CodeProposal {
  value: string;
  /** Whether the held rows really look like the value's rows; when not, the value is only the nearest of the types mapped so far. */
  close?: boolean;
  /** How far the held rows sit from the value's, in spreads between the known types: on the worst feature, and on average. */
  distance?: { worst: number; mean: number };
  /** DI's values for this code list the core's codes don't use yet: what the held code may be instead. */
  options?: string[];
  runnerUp: string | null;
  evidence: { label: string; held: string; proposed: string }[];
}
export interface HeldCodes {
  diTable: string;
  diColumn: string;
  table: string;
  column: string;
  set: string | null;
  code: string;
  count: number;
  proposal: CodeProposal | null;
}
/** A code column's proposed crosswalk: each core code, how many rows have it, and its DI value (null when nothing fits). */
export interface Crosswalk {
  diTable: string;
  diColumn: string;
  core: string;
  /** The ontology's code list for the DI column (deposit_category); a vendor pack names its own (shareType). */
  set: string | null;
  codes: { code: string; count: number; value: string | null; score: number }[];
}
/** The ontology's code lists a vendor pack's code lists answer to, either way round. */
const SET_ALIASES: Record<string, string> = { shareType: 'deposit_category', loanType: 'loan_category', memberType: 'member_segment', deposit_category: 'shareType', loan_category: 'loanType', member_segment: 'memberType' };
const DI_KEYS: Record<string, string> = { cdm_party: 'party_id', cdm_deposit_account: 'account_id', cdm_loan: 'loan_id' };
const DI_LABELS: Record<string, string> = { cdm_party: 'Members', cdm_deposit_account: 'Deposit accounts', cdm_loan: 'Loan accounts' };

interface DriftFinding {
  kind: 'new_code' | 'new_column' | 'missing_column' | 'tie_out';
  table: string;
  column: string;
  value: string;
  detail: unknown;
}
export interface DriftItem {
  driftId: number;
  kind: DriftFinding['kind'];
  table: string;
  column: string;
  value: string;
  state: string;
  foundAt: string;
  versionNo: number | null;
  detail: Record<string, unknown>;
}

/** A profiled table's source: the core table and, for one slice of it (TABLE[COLUMN=VALUE]), the filter. */
export function coreSource(name: string): { table: string; column: string | null; value: string | null; where: string } {
  const m = /^(.+)\[([A-Za-z0-9_]+)=(.*)\]$/.exec(name);
  if (!m) return { table: name, column: null, value: null, where: '' };
  return { table: m[1]!, column: m[2]!, value: m[3]!, where: `\`${m[2]}\` = '${m[3]!.replace(/'/g, "''")}'` };
}

/** "shareType" as a person says it: "share type". */
export const codeSetWords = (set: string | null | undefined) => (set ? set.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase() : 'code');

/**
 * The known code whose rows the held rows look most like: the average of each number the mapping
 * reads (balance, rate) and the share with each date (a maturity date), compared group by group,
 * each feature scaled by how much it varies across the groups. Null when there's nothing to compare.
 */
export function nearestCode(map: TableMap, typed: Raw[][], codeIdx: number, heldRows: number[]): CodeProposal | null {
  const feats = map.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => i !== codeIdx && c.di !== map.key && !/_id$/.test(c.di) && (['number', 'rate1000', 'date8'].includes(c.how.kind) || ontology().properties.get(ontology().columnIndex.get(`${map.diTable}.${c.di}`) ?? '')?.type === 'date'));
  if (!feats.length) return null;
  const held = new Set(heldRows);
  const groups = new Map<string, number[]>();
  typed.forEach((r, j) => {
    if (held.has(j)) return;
    const v = r[codeIdx];
    if (v === null || v === undefined) return;
    (groups.get(String(v)) ?? groups.set(String(v), []).get(String(v))!).push(j);
  });
  if (!groups.size) return null;
  // Shown by what the DI column holds: dates as the share that have one, rates as percents, dollars, or plain numbers.
  const typeOf = (f: (typeof feats)[number]) => ontology().properties.get(ontology().columnIndex.get(`${map.diTable}.${f.c.di}`) ?? '')?.type;
  const isDate = (f: (typeof feats)[number]) => f.c.how.kind === 'date8' || typeOf(f) === 'date';
  const stat = (idx: number[], f: (typeof feats)[number]) => {
    if (isDate(f)) return idx.filter((j) => typed[j]![f.i] !== null).length / Math.max(1, idx.length);
    const xs = idx.map((j) => typed[j]![f.i]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
  };
  const heldStats = feats.map((f) => stat(heldRows, f));
  const groupStats = [...groups].map(([value, idx]) => ({ value, stats: feats.map((f) => stat(idx, f)) }));
  const scale = feats.map((_, k) => {
    const xs = [...groupStats.map((g) => g.stats[k]!), heldStats[k]!];
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length) || 1;
  });
  // Only the features that tell the known codes apart count: a date every type has, or a rate every type
  // shares, would make anything look close to anything.
  const spread = feats.map((_, k) => {
    const xs = groupStats.map((g) => g.stats[k]!);
    const mean = xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length;
    return mean ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length) / mean : 0;
  });
  const useful = feats.map((_, k) => k).filter((k) => spread[k]! > 0.05);
  if (!useful.length) return { value: '', close: false, runnerUp: null, evidence: [] };
  const gap = (stats: number[], k: number) => Math.abs(stats[k]! - heldStats[k]!) / scale[k]!;
  const ranked = groupStats.map((g) => ({ ...g, d: useful.reduce((s, k) => s + gap(g.stats, k), 0) / useful.length })).sort((a, b) => a.d - b.d);
  const best = ranked[0]!;
  const show = (f: (typeof feats)[number], x: number) => {
    const t = typeOf(f);
    if (isDate(f)) return `${Math.round(x * 100)}% have one`;
    if (f.c.how.kind === 'rate1000' || t === 'rate') return `${x.toFixed(2)}% on average`;
    if (t === 'money') return `$${Math.round(x).toLocaleString('en-US')} on average`;
    return `${(Math.round(x * 10) / 10).toLocaleString('en-US')} on average`;
  };
  const label = (f: (typeof feats)[number]) => ontology().properties.get(ontology().columnIndex.get(`${map.diTable}.${f.c.di}`) ?? '')?.label ?? f.c.di.replace(/_/g, ' ');
  // The evidence worth showing: the features that tell the known codes apart most, at most three.
  const telling = [...useful].sort((a, b) => spread[b]! - spread[a]!).slice(0, 3);
  const worst = Math.max(...useful.map((k) => gap(best.stats, k)));
  // Close when, on average over those features, the held rows sit well within the spread between the
  // known types: a rough guide, not a match, so DI also lists the types the core doesn't use yet.
  return { value: best.value, close: best.d <= 0.65, distance: { worst: Math.round(worst * 100) / 100, mean: Math.round(best.d * 100) / 100 }, runnerUp: ranked[1]?.value ?? null, evidence: telling.map((k) => ({ label: label(feats[k]!), held: show(feats[k]!, heldStats[k]!), proposed: show(feats[k]!, best.stats[k]!) })) };
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
/** Rows per core table a mapping profile reads to see what the values look like. Totals, keys and tie-outs read every row. */
export const PROFILE_SAMPLE = 20_000;

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
        const cols = await rows<{ t: string; c: string }>(conn, 'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND EXTRA NOT LIKE \'%INVISIBLE%\'', [login.database]);
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
    // A core Kinective hasn't mapped connects with nothing mapped yet: its mapping comes from proposals DI makes and someone approves.
    if (t.mappings && !maps.length) throw new CoreError('INVALID', 'None of the tables to map can be read with this login.');
    const [r] = (await this.pool.query("INSERT INTO src_connection (name, system_id, credential_id, schedule, state, in_use, created_by, created_name, created_on, approval_id) VALUES (?, ?, ?, ?, 'Connected', 0, ?, ?, ?, ?)", [p.name.slice(0, 80), t.login.system.id, p.credentialId, p.schedule.slice(0, 40), owner.userId, owner.name, meta.on, meta.approvalId])) as unknown as [{ insertId: number }];
    for (const m of maps) await this.pool.query('INSERT INTO src_mapping (connection_id, di_table, their_tables, definition) VALUES (?, ?, ?, ?)', [r.insertId, m.map.diTable, m.map.theirTables.join(', '), JSON.stringify(m.map)]);
    // The raw zone, from the core's own columns, so a core Kinective has never seen needs no seed step.
    // If it can't be made now (a tenant without the grant), the first pull tries again.
    await this.withCore(p.credentialId, (core) => this.createRawZone(core, r.insertId)).catch((e: unknown) => console.warn(`[sources] the raw zone for connection ${r.insertId} wasn’t created: ${(e as Error).message}`));
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
    // The mapping the pull uses: the connection's current version, or the mapping recorded when it was connected.
    const version = await this.currentVersion(conn);
    const maps = version?.definition.tables ?? (await rows<{ definition: string | TableMap }>(this.pool, 'SELECT definition FROM src_mapping WHERE connection_id = ? ORDER BY mapping_id', [connectionId])).map((m) => (typeof m.definition === 'string' ? (JSON.parse(m.definition) as TableMap) : m.definition));
    if (!maps.length) throw new CoreError('INVALID', `The ${conn.name} has nothing mapped yet, so there’s nothing to pull. Propose a mapping and freeze it first.`);
    const started = nowSql();
    const [ins] = (await this.pool.query("INSERT INTO src_sync_run (connection_id, started_at, state, approval_id) VALUES (?, ?, 'Running', ?)", [connectionId, started, meta.approvalId])) as unknown as [{ insertId: number }];
    const runId = ins.insertId;
    const findings: DriftFinding[] = [];
    try {
      let total = 0;
      let processDate: string | null = null;
      const custom = await this.activeCustom(conn.system.id);
      const customValues: { diTable: string; rows: { record: number; field: string; text: string | null; num: number | null }[]; fields: { field: string; label: string; filled: number }[] }[] = [];
      const held: HeldCodes[] = [];
      const raw: { table: string; rows: number }[] = [];
      let rawZone: string | null = null;
      await this.withCore(cred!.credential_id, async (core) => {
        processDate = await this.processDate(core, conn.system);
        // The core's columns now, against the ones the mapping was made for.
        const [{ db }] = (await rows<{ db: string }>(core, 'SELECT DATABASE() AS db')) as [{ db: string }];
        const now = new Map<string, Set<string>>();
        for (const r of await rows<{ t: string; c: string }>(core, 'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND EXTRA NOT LIKE \'%INVISIBLE%\'', [db])) (now.get(r.t.toUpperCase()) ?? now.set(r.t.toUpperCase(), new Set()).get(r.t.toUpperCase())!).add(r.c.toUpperCase());
        const missing: string[] = [];
        for (const map of maps) {
          const al = aliases(map);
          for (const col of map.columns) {
            const [a, c] = col.their.split('.') as [string, string];
            const table = (al[a] ?? '').toUpperCase();
            if (!now.get(table)?.has(c.toUpperCase())) {
              missing.push(`${table}.${c}`);
              findings.push({ kind: 'missing_column', table, column: c, value: '', detail: { diTable: map.diTable, diColumn: col.di } });
            }
          }
          for (const t of map.theirTables) {
            const seen = version?.definition.seen?.[t.toUpperCase()];
            if (seen) for (const c of now.get(t.toUpperCase()) ?? []) if (!seen.includes(c)) findings.push({ kind: 'new_column', table: t.toUpperCase(), column: c, value: '', detail: { diTable: map.diTable } });
          }
        }
        if (missing.length) throw new CoreError('INVALID', `The core no longer has ${missing.join(', ')}, which the mapping reads, so the pull stopped and nothing was replaced. Ask what changed in the core.`);
        // The first pull on a version records the columns it was made for.
        if (version && !version.definition.seen) {
          const seen = Object.fromEntries([...new Set(maps.flatMap((m) => m.theirTables.map((t) => t.toUpperCase())))].map((t) => [t, [...(now.get(t) ?? [])].sort()]));
          await this.pool.query('UPDATE map_version SET definition = ? WHERE version_id = ?', [JSON.stringify({ ...version.definition, seen }), version.versionId]);
        }
        for (const map of maps) {
          const select = map.columns.map((col, i) => `${col.their} AS c${i}`).join(', ');
          const found = await rows<Record<string, Raw>>(core, `SELECT ${select} FROM ${map.from}`);
          const typed = found.map((r) => map.columns.map((col, i) => transform(r[`c${i}`] ?? null, col.how, processDate)));
          // For each code list, DI's values its codes don't use yet: what a held code may be instead.
          const unused = new Map<number, string[]>();
          for (const [i, col] of map.columns.entries()) {
            if (col.how.kind !== 'code' || !col.how.set) continue;
            const o = ontology();
            const vsName = o.valueSets.has(col.how.set) ? col.how.set : (o.vendors.get(conn.system.id)?.codes[col.how.set]?.code_set_of ?? SET_ALIASES[col.how.set]);
            const vs = vsName ? o.valueSets.get(vsName) : undefined;
            if (!vs) continue;
            const inUse = new Set((await rows<{ v: string }>(this.pool, `SELECT DISTINCT \`${col.di}\` AS v FROM \`${map.diTable}\` WHERE \`${col.di}\` IS NOT NULL LIMIT 60`).catch(() => [])).map((r) => String(r.v)));
            const mapped = new Set(Object.values(col.how.codes));
            unused.set(i, Object.values(vs.codes).map((c) => c.values.find((v) => inUse.has(v)) ?? (inUse.size ? null : c.values[0]!)).filter((v): v is string => !!v && !mapped.has(v)));
          }
          // A code the crosswalk doesn't know lands without a value, so no report counts it under a wrong name; it's held for a decision.
          map.columns.forEach((col, i) => {
            if (col.how.kind !== 'code') return;
            const codes = col.how.codes;
            const byCode = new Map<string, number[]>();
            found.forEach((r, j) => {
              const v = r[`c${i}`];
              if (v === null || v === undefined) return;
              const code = codeKey(v);
              if (codes[code] !== undefined) return;
              typed[j]![i] = null;
              (byCode.get(code) ?? byCode.set(code, []).get(code)!).push(j);
            });
            for (const [code, idx] of byCode) {
              const near = nearestCode(map, typed, i, idx);
              const options = unused.get(i) ?? [];
              const proposal: CodeProposal | null = near ? { ...near, options } : options.length ? { value: '', close: false, runnerUp: null, evidence: [], options } : null;
              const [a, c] = col.their.split('.') as [string, string];
              const table = (aliases(map)[a] ?? a).toUpperCase();
              held.push({ diTable: map.diTable, diColumn: col.di, table, column: c, set: col.how.set ?? null, code, count: idx.length, proposal });
              findings.push({ kind: 'new_code', table, column: c, value: code, detail: { diTable: map.diTable, diColumn: col.di, set: col.how.set ?? null, count: idx.length, proposal } });
            }
          });
          await this.land(map, typed);
          total += typed.length;
          const mine = custom.filter((c) => c.di_table === map.diTable);
          if (mine.length) customValues.push(await this.readCustom(core, map, mine, processDate));
          // The raw zone: each core table this mapping reads, copied as it is (made now if the connection predates it).
          const toCopy = map.theirTables.filter((t) => !raw.some((x) => x.table === t));
          if (toCopy.length) {
            rawZone = await this.createRawZone(core, connectionId, toCopy).then((z) => z.database, () => null);
            if (rawZone) for (const t of toCopy) raw.push({ table: t, rows: await this.copyRaw(core, t, rawZone) });
          }
        }
      });
      for (const c of customValues) await this.landCustom(c.diTable, c.fields.map((f) => f.field), c.rows);
      const recon = await this.reconcile(maps);
      // Landed totals against the regulatory return.
      for (const t of await this.landedTieOuts(maps)) if (!t.pass) findings.push({ kind: 'tie_out', table: t.table, column: t.column, value: t.code, detail: t });
      await this.recordDrift(connectionId, version?.versionId ?? 0, runId, findings);
      const detail = { processDate, version: version?.versionNo ?? null, held, raw, rawZone, drift: findings.length, ...recon, customFields: customValues.flatMap((c) => c.fields.map((f) => ({ ...f, diTable: c.diTable }))) };
      await this.pool.query("UPDATE src_sync_run SET finished_at = ?, state = 'Done', rows_pulled = ?, detail = ? WHERE run_id = ?", [nowSql(), total, JSON.stringify(detail), runId]);
      return this.run(runId);
    } catch (e) {
      await this.recordDrift(connectionId, version?.versionId ?? 0, runId, findings).catch(() => {});
      await this.pool.query("UPDATE src_sync_run SET finished_at = ?, state = 'Failed', detail = ? WHERE run_id = ?", [nowSql(), JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 300) : String(e) }), runId]);
      throw e;
    }
  }

  /**
   * The connection's current mapping version. A connection to a core Kinective has mapped gets
   * version 1, Kinective's standard mapping for the tables it was connected for, the first time it's
   * needed. Null where the tables aren't there yet or the core has no standard mapping.
   */
  async currentVersion(conn: SourceConnection): Promise<MappingVersion | null> {
    const latest = async () => {
      const [v] = await rows<{ version_id: number; version_no: number; source: string; summary: string; created_name: string; created_at: string; definition: string | VersionDefinition }>(this.pool, "SELECT version_id, version_no, source, summary, created_name, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at, definition FROM map_version WHERE connection_id = ? ORDER BY version_no DESC LIMIT 1", [conn.connectionId]);
      return v ? { versionId: v.version_id, versionNo: v.version_no, source: v.source, summary: v.summary, createdName: v.created_name, createdAt: v.created_at, definition: typeof v.definition === 'string' ? (JSON.parse(v.definition) as VersionDefinition) : v.definition } : null;
    };
    let v: MappingVersion | null;
    try {
      v = await latest();
    } catch {
      return null;
    }
    if (v) return v;
    if (!conn.system.mappings?.length) return null;
    const mine = new Set(conn.tables.map((t) => t.diTable));
    const tables = conn.system.mappings.filter((m) => mine.has(m.diTable));
    await this.pool.query("INSERT IGNORE INTO map_version (connection_id, version_no, source, summary, definition, created_by, created_name, created_at, approval_id) VALUES (?, 1, 'standard', ?, ?, 'kinective', 'Kinective', ?, ?)", [conn.connectionId, `Kinective’s standard ${conn.system.short} mapping`, JSON.stringify({ tables, seen: null }), nowSql(), `standard:${conn.connectionId}`]);
    return latest();
  }

  /** Every mapping version of a connection, newest first. */
  /** The core Kinective hasn't mapped that DI proposed a mapping for most recently, if any. */
  private async latestProposed() {
    const runs = await rows<{ connection_id: number }>(this.pool, "SELECT connection_id FROM map_run WHERE mode = 'propose' ORDER BY run_id DESC LIMIT 20").catch(() => []);
    const all = await this.connections();
    for (const r of runs) {
      const c = all.find((x) => x.connectionId === r.connection_id);
      if (c && !c.system.mappings?.length) return c.connectionId;
    }
    return null;
  }

  /** The connection a mapping question is about: the one named, else the one feeding DI, else the newest. */
  private async mappingTarget(connectionId?: number) {
    if (connectionId) return this.connection(connectionId);
    const all = await this.connections();
    const conn = all.find((c) => c.inUse) ?? all[0];
    if (!conn) throw new CoreError('NOT_FOUND', 'There’s no core connection yet. Connect the core replica first.');
    return conn;
  }

  async versions(connectionId?: number): Promise<{ connection: SourceConnection; versions: MappingVersion[] }> {
    const conn = await this.mappingTarget(connectionId);
    await this.currentVersion(conn);
    const list = await rows<{ version_id: number; version_no: number; source: string; summary: string; created_name: string; created_at: string; definition: string | VersionDefinition }>(this.pool, "SELECT version_id, version_no, source, summary, created_name, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at, definition FROM map_version WHERE connection_id = ? ORDER BY version_no DESC", [conn.connectionId]).catch(() => []);
    return { connection: conn, versions: list.map((v) => ({ versionId: v.version_id, versionNo: v.version_no, source: v.source, summary: v.summary, createdName: v.created_name, createdAt: v.created_at, definition: typeof v.definition === 'string' ? (JSON.parse(v.definition) as VersionDefinition) : v.definition })) };
  }

  /** What pulls found that the mapping doesn't expect, open first. */
  async drift(connectionId?: number, includeResolved = false): Promise<{ connection: SourceConnection; items: DriftItem[] }> {
    const conn = await this.mappingTarget(connectionId);
    const list = await rows<{ drift_id: number; kind: DriftItem['kind']; core_table: string; core_column: string; value: string; state: string; found_at: string; detail: unknown; version_no: number | null }>(
      this.pool,
      `SELECT d.drift_id, d.kind, d.core_table, d.core_column, d.value, d.state, DATE_FORMAT(d.found_at, '%Y-%m-%d %H:%i') AS found_at, d.detail, v.version_no
         FROM map_drift d LEFT JOIN map_version v ON v.version_id = d.version_id
        WHERE d.connection_id = ?${includeResolved ? '' : " AND d.state = 'open'"} ORDER BY d.state = 'open' DESC, d.found_at DESC, d.drift_id`,
      [conn.connectionId],
    ).catch(() => []);
    return { connection: conn, items: list.map((d) => ({ driftId: d.drift_id, kind: d.kind, table: d.core_table, column: d.core_column, value: d.value, state: d.state, foundAt: d.found_at, versionNo: d.version_no, detail: (typeof d.detail === 'string' ? JSON.parse(d.detail) : d.detail) ?? {} })) };
  }

  /**
   * Checks a change to a code crosswalk, without making it: which columns use the code list, the
   * value in DI's terms (a DI value, or one of the ontology's code labels), and the rows held for it.
   */
  async checkCrosswalk(p: { set: string; code: string; value: string; connectionId?: number }) {
    const conn = await this.mappingTarget(p.connectionId);
    const version = await this.currentVersion(conn);
    if (!version) throw new CoreError('INVALID', `${conn.name} has no mapping version to change yet.`);
    // A code list by its own name, or by the name it answers to (shareType for deposit_category).
    const names = new Set([p.set.toLowerCase(), (SET_ALIASES[p.set] ?? '').toLowerCase()].filter(Boolean));
    const cols = version.definition.tables.flatMap((m) => m.columns.filter((c) => c.how.kind === 'code' && !!c.how.set && names.has(c.how.set.toLowerCase())).map((c) => ({ map: m, col: c })));
    if (!cols.length) {
      const sets = [...new Set(version.definition.tables.flatMap((m) => m.columns.map((c) => (c.how.kind === 'code' ? c.how.set : undefined)).filter((x): x is string => !!x)))];
      throw new CoreError('INVALID', `The mapping has no ${codeSetWords(p.set)} list. It has ${sets.map(codeSetWords).join(', ')}.`);
    }
    // A number, a short code (VISA) or a core's description of a few words (Visa Platinum), spelled as the
    // core holds it: a held code or one the crosswalk has, in any case.
    const asked = codeKey(p.code);
    if (!/^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+){0,4}$/.test(asked) || asked.length > 40) throw new CoreError('INVALID', 'A core code is a number, a short code such as 14 or VISA, or the core’s description of a few words, such as Visa Platinum.');
    const { items: drifted } = await this.drift(conn.connectionId);
    const known = [...new Set([...Object.keys((cols[0]!.col.how as { codes: Record<string, string> }).codes), ...drifted.filter((d) => d.kind === 'new_code').map((d) => d.value)])];
    const code = known.find((k) => k === asked) ?? known.find((k) => k.toLowerCase() === asked.toLowerCase()) ?? asked;
    const set = (cols[0]!.col.how as { set?: string }).set!;
    const current = (cols[0]!.col.how as { codes: Record<string, string> }).codes;
    // The value in DI's terms: one the crosswalk already uses, or a code of the ontology's list for this set.
    const pack = ontology().vendors.get(conn.system.id);
    const valueSet = pack?.codes[set] ? ontology().valueSets.get(pack.codes[set]!.code_set_of) : (ontology().valueSets.get(set) ?? null);
    const used = [...new Set(Object.values(current))];
    const want = p.value.trim().toLowerCase();
    let value = used.find((v) => v.toLowerCase() === want) ?? null;
    if (!value && valueSet) {
      const hit = Object.values(valueSet.codes).find((c) => c.label.toLowerCase() === want || Object.values(c.labels_by_type ?? {}).some((l) => l?.toLowerCase() === want) || c.values.some((v) => v.toLowerCase() === want));
      if (hit) value = hit.values.find((v) => used.includes(v)) ?? hit.values[0]!;
    }
    if (!value) throw new CoreError('INVALID', `“${p.value}” isn’t a ${codeSetWords(set)} DI knows. It can be ${used.join(', ')}.`);
    const heldItems = drifted.filter((d) => d.kind === 'new_code' && d.value === code && cols.some(({ col }) => col.their.endsWith(`.${d.column}`)));
    return { conn, version, set, code, value, before: current[code] ?? null, columns: cols.map(({ map, col }) => `${map.diTable}.${col.di}`), held: heldItems.reduce((s, d) => s + Number((d.detail as { count?: number }).count ?? 0), 0), driftIds: heldItems.map((d) => d.driftId) };
  }

  /** Records a new mapping version with the code added to the crosswalk, and resolves the drift it answers. Once per approval. */
  async setCrosswalk(p: { set: string; code: string; value: string; connectionId?: number }, owner: { userId: string; name: string }, meta: { approvalId: string }) {
    const [done] = await rows<{ version_no: number }>(this.pool, 'SELECT version_no FROM map_version WHERE approval_id = ?', [meta.approvalId]);
    const c = await this.checkCrosswalk(p);
    if (done) return { ...c, versionNo: done.version_no, replayed: true };
    const tables = c.version.definition.tables.map((m) => ({ ...m, columns: m.columns.map((col) => (col.how.kind === 'code' && col.how.set === c.set ? { ...col, how: { ...col.how, codes: { ...col.how.codes, [c.code]: c.value } } } : col)) }));
    const versionNo = c.version.versionNo + 1;
    const summary = `${codeSetWords(c.set)} ${c.code} → ${c.value}`.replace(/^./, (x) => x.toUpperCase());
    const [ins] = (await this.pool.query("INSERT INTO map_version (connection_id, version_no, source, summary, definition, created_by, created_name, created_at, approval_id) VALUES (?, ?, 'crosswalk', ?, ?, ?, ?, ?, ?)", [c.conn.connectionId, versionNo, summary, JSON.stringify({ tables, seen: c.version.definition.seen ?? null }), owner.userId, owner.name, nowSql(), meta.approvalId])) as unknown as [{ insertId: number }];
    if (c.driftIds.length) await this.pool.query(`UPDATE map_drift SET state = 'resolved', resolved_at = ?, resolved_version_id = ? WHERE drift_id IN (${c.driftIds.map(() => '?').join(',')})`, [nowSql(), ins.insertId, ...c.driftIds]);
    return { ...c, versionNo, replayed: false };
  }

  /**
   * What freezing the latest proposed mapping for a connection would record, without recording it:
   * per DI table, the core tables joined (an extension table on its reference, filtered to its primary
   * row; a slice of a shared table by its class code), the columns taken (proposals that need a person
   * are left out, except the key), and each code column's crosswalk, with the codes nothing fits.
   */
  async checkFreeze(connectionRef?: string | number) {
    // With no connection named, the one DI proposed a mapping for most recently among the cores Kinective
    // hasn't mapped: "Freeze the proposed mapping" right after "Map the Core C stand-in connection" means
    // Core C, not the Symitar replica the builds read.
    const named = typeof connectionRef === 'number' ? connectionRef : connectionRef ? (await this.connection(connectionRef)).connectionId : undefined;
    const conn = await this.mappingTarget(named ?? (await this.latestProposed()) ?? undefined);
    if (conn.system.mappings?.length) throw new CoreError('INVALID', `Kinective’s standard ${conn.system.short} mapping is in use for the ${conn.name}. Freezing proposals is for a core Kinective hasn’t mapped.`);
    const [run] = await rows<{ run_id: number; summary: string | Record<string, unknown> }>(this.pool, "SELECT run_id, summary FROM map_run WHERE connection_id = ? AND mode = 'propose' ORDER BY run_id DESC LIMIT 1", [conn.connectionId]);
    if (!run) throw new CoreError('NOT_FOUND', `DI hasn’t proposed a mapping for the ${conn.name} yet. Ask me to map it first.`);
    const summary = (typeof run.summary === 'string' ? JSON.parse(run.summary) : run.summary) as { crosswalks?: Crosswalk[]; entities?: Record<string, string> };
    const props = await rows<{ core_table: string; core_column: string; di_table: string; di_column: string; band: string; transform: MapTransform }>(this.pool, 'SELECT core_table, core_column, di_table, di_column, band, transform FROM map_candidate WHERE run_id = ?', [run.run_id]);
    const profiles = await rows<{ core_table: string; core_column: string; row_count: number; top_values: unknown; refers_to: string | null }>(this.pool, 'SELECT core_table, core_column, row_count, top_values, refers_to FROM map_profile WHERE run_id = ?', [run.run_id]);
    const prof = (t: string, c?: string) => profiles.filter((p) => p.core_table === t && (!c || p.core_column === c));
    const tables: TableMap[] = [];
    const left: { di: string; core: string }[] = [];
    // Proposals too close to call: frozen like the rest, and named on the approval card to check.
    const close: { di: string; core: string }[] = [];
    const skipped: string[] = [];
    for (const diTable of SOURCE_TARGETS) {
      const mine = props.filter((p) => p.di_table === diTable);
      const keyProp = mine.find((p) => p.di_column === DI_KEYS[diTable]);
      if (!keyProp) {
        if (mine.length) skipped.push(diTable);
        continue;
      }
      const main = coreSource(keyProp.core_table);
      const alias = new Map<string, string>([[keyProp.core_table, 'a']]);
      let from = `${main.table} a`;
      // Another core table feeding this DI table joins on its reference to the main table's key, kept to
      // the one row per key a short code marks (Symitar's primary NAME), when it has more rows than that.
      const mainRows = Number(prof(keyProp.core_table)[0]?.row_count ?? 0);
      for (const t of [...new Set(mine.map((p) => p.core_table))].filter((t) => t !== keyProp.core_table)) {
        const ref = prof(t).find((p) => p.refers_to === `${keyProp.core_table}.${keyProp.core_column}`);
        if (!ref) {
          for (const p of mine.filter((x) => x.core_table === t)) left.push({ di: `${diTable}.${p.di_column}`, core: `${t}.${p.core_column}` });
          continue;
        }
        const a = String.fromCharCode(97 + alias.size);
        alias.set(t, a);
        const extRows = Number(ref.row_count);
        let primary = '';
        if (extRows > mainRows * 1.02) {
          // Each short code's share of its column's sampled rows, times the table's rows, estimates its rows.
          const options = prof(t).flatMap((p) => {
            const top = ((typeof p.top_values === 'string' ? JSON.parse(p.top_values) : p.top_values) ?? []) as { value: string; count: number }[];
            const seen = top.reduce((s, x) => s + x.count, 0);
            return seen ? top.map((v) => ({ column: p.core_column, value: v.value, est: (v.count / seen) * extRows })) : [];
          });
          const best = options.filter((o2) => Math.abs(o2.est - mainRows) / Math.max(1, mainRows) <= 0.1).sort((x, y) => Math.abs(x.est - mainRows) - Math.abs(y.est - mainRows))[0];
          if (best) primary = ` AND ${a}.${best.column} = ${/^-?\d+$/.test(best.value) ? best.value : `'${best.value.replace(/'/g, "''")}'`}`;
        }
        from += ` JOIN ${coreSource(t).table} ${a} ON ${a}.${ref.core_column} = a.${keyProp.core_column}${primary}`;
      }
      if (main.column) from += ` WHERE a.${main.column} = '${main.value!.replace(/'/g, "''")}'`;
      const columns: ColumnMap[] = [];
      for (const p of mine) {
        const a = alias.get(p.core_table);
        if (!a) continue;
        if (p.band === 'person' && p !== keyProp) close.push({ di: `${diTable}.${p.di_column}`, core: `${p.core_table}.${p.core_column}` });
        let how: Transform;
        if (p.transform === 'code') {
          const cw = (summary.crosswalks ?? []).find((c) => c.diTable === diTable && c.diColumn === p.di_column);
          how = { kind: 'code', codes: Object.fromEntries((cw?.codes ?? []).filter((c) => c.value).map((c) => [codeKey(c.code), c.value!])), ...(cw?.set ? { set: cw.set } : {}) };
        } else how = { kind: p.transform } as Transform;
        columns.push({ di: p.di_column, their: `${a}.${p.core_column}`, how });
      }
      tables.push({ diTable, label: DI_LABELS[diTable] ?? diTable, theirTables: [...alias.keys()].map((t) => coreSource(t).table).filter((t, i, xs) => xs.indexOf(t) === i), from, key: DI_KEYS[diTable]!, columns });
    }
    if (!tables.length) throw new CoreError('INVALID', `Run ${run.run_id} has no key for any of DI’s tables, so there’s nothing to freeze.`);
    const crosswalks = (summary.crosswalks ?? []).filter((c) => tables.some((t) => t.diTable === c.diTable && t.columns.some((x) => x.di === c.diColumn)));
    return { conn, runId: run.run_id, tables, left, close, skipped, crosswalks, unknown: crosswalks.flatMap((c) => c.codes.filter((x) => !x.value).map((x) => ({ di: `${c.diTable}.${c.diColumn}`, code: x.code, count: x.count }))) };
  }

  /** Records the latest proposed mapping as the connection's next mapping version. Once per approval. */
  async freezeFromRun(connectionRef: string | number | undefined, owner: { userId: string; name: string }, meta: { approvalId: string }) {
    const [done] = await rows<{ version_no: number }>(this.pool, 'SELECT version_no FROM map_version WHERE approval_id = ?', [meta.approvalId]);
    const c = await this.checkFreeze(connectionRef);
    if (done) return { ...c, versionNo: done.version_no, replayed: true };
    const [last] = await rows<{ n: number | null }>(this.pool, 'SELECT MAX(version_no) AS n FROM map_version WHERE connection_id = ?', [c.conn.connectionId]);
    const versionNo = Number(last?.n ?? 0) + 1;
    const cols = c.tables.reduce((s, t) => s + t.columns.length, 0);
    const known = c.crosswalks.reduce((s, x) => s + x.codes.filter((y) => y.value).length, 0);
    const summary = `Proposed mapping from run ${c.runId}: ${cols} columns, ${known} codes${c.left.length || c.unknown.length ? `; ${c.left.length} columns and ${c.unknown.length} codes left to decide` : ''}`;
    await this.pool.query("INSERT INTO map_version (connection_id, version_no, source, summary, definition, created_by, created_name, created_at, approval_id) VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, ?)", [c.conn.connectionId, versionNo, summary.slice(0, 300), JSON.stringify({ tables: c.tables, seen: null }), owner.userId, owner.name, nowSql(), meta.approvalId]);
    return { ...c, versionNo, replayed: false };
  }

  /**
   * The connection's raw zone (Core Mapping and Ontology, phase 12): a database beside the tenant's
   * with an empty table for each core table (or the ones named), under the core's own names, its
   * columns as the core declares them and every one allowed to be empty. Made from the core's
   * information_schema, so it works for any core; a table already there is left as it is.
   */
  async createRawZone(core: mysql.Connection, connectionId: number, only?: string[]) {
    const [{ db: theirs }] = (await rows<{ db: string }>(core, 'SELECT DATABASE() AS db')) as [{ db: string }];
    const [{ db: mine }] = (await rows<{ db: string }>(this.pool, 'SELECT DATABASE() AS db')) as [{ db: string }];
    const database = rawDatabase(mine, connectionId);
    const q = (x: string) => `\`${x.replaceAll('`', '')}\``;
    await this.pool.query(`CREATE DATABASE IF NOT EXISTS ${q(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const want = only ? new Set(only.map((t) => t.toUpperCase())) : null;
    const cols = (await rows<{ t: string; c: string; ty: string; k: string }>(core, "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND EXTRA NOT LIKE '%INVISIBLE%' ORDER BY TABLE_NAME, ORDINAL_POSITION", [theirs])).filter((x) => !want || want.has(x.t.toUpperCase()));
    const have = new Set((await rows<{ t: string }>(this.pool, 'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [database])).map((r) => r.t.toUpperCase()));
    const made: string[] = [];
    for (const t of [...new Set(cols.map((x) => x.t))].slice(0, 80)) {
      if (have.has(t.toUpperCase())) continue;
      const mineCols = cols.filter((x) => x.t === t);
      // A plain type is kept (INT, DECIMAL(14,2), VARCHAR(40), DATE); anything else (ENUM, a spatial type) is kept as text.
      const type = (ty: string) => (/^[a-z]+( ?\(\d+(,\d+)?\))?( unsigned)?$/i.test(ty.trim()) ? ty.trim() : 'TEXT');
      const pk = mineCols.filter((x) => x.k === 'PRI').map((x) => q(x.c));
      await this.pool.query(`CREATE TABLE IF NOT EXISTS ${q(database)}.${q(t)} (${[...mineCols.map((x) => `${q(x.c)} ${type(x.ty)} NULL`), ...(pk.length ? [`KEY ix_raw_key (${pk.join(', ')})`] : [])].join(', ')})`);
      made.push(t);
    }
    return { database, made };
  }

  /** Replaces a raw-zone table with the core table's rows, as they are, in one transaction. */
  private async copyRaw(core: mysql.Connection, coreTable: string, database: string) {
    const [found0] = await rows<{ t: string }>(this.pool, 'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND UPPER(TABLE_NAME) = ?', [database, coreTable.toUpperCase()]);
    if (!found0) return 0;
    const target = `${database}\`.\`${found0.t}`;
    // Only the columns both sides have: a column new in the core is drift to decide on, not a reason to fail the pull.
    const mine = new Set((await rows<{ c: string }>(this.pool, 'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [database, found0.t])).map((r) => r.c.toUpperCase()));
    const [{ db }] = (await rows<{ db: string }>(core, 'SELECT DATABASE() AS db')) as [{ db: string }];
    const theirs = (await rows<{ c: string }>(core, 'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND EXTRA NOT LIKE \'%INVISIBLE%\' AND UPPER(TABLE_NAME) = ? ORDER BY ORDINAL_POSITION', [db, coreTable.toUpperCase()])).map((r) => r.c).filter((c) => mine.has(c.toUpperCase()));
    if (!theirs.length) return 0;
    const found = await rows<Record<string, Raw>>(core, `SELECT ${theirs.map((c) => `\`${c.replaceAll('`', '')}\``).join(', ')} FROM \`${coreTable.replaceAll('`', '')}\``);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM \`${target}\``);
      if (found.length) {
        const cols = Object.keys(found[0]!);
        const list = cols.map((c) => `\`${c.replaceAll('`', '')}\``).join(', ');
        for (let i = 0; i < found.length; i += 5000) await conn.query(`INSERT INTO \`${target}\` (${list}) VALUES ?`, [found.slice(i, i + 5000).map((r) => cols.map((c) => r[c] ?? null))]);
      }
      await conn.commit();
      return found.length;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Open loan and share balances as landed, against the 5300's total loans (025B) and total shares (018), within 3%. */
  private async landedTieOuts(maps: TableMap[]) {
    const out: { property: string; table: string; column: string; landed: number; reported: number; code: string; pass: boolean }[] = [];
    const lines = await rows<{ code: string; amount: number }>(this.pool, "SELECT code, amount FROM cr_value WHERE quarter_end = (SELECT MAX(quarter_end) FROM cr_value) AND code IN ('025B', '018')").catch(() => []);
    const line = new Map(lines.map((r) => [r.code, Number(r.amount)]));
    const checks = [
      { diTable: 'cdm_loan', property: 'loan.balance', code: '025B', open: 'close_date IS NULL AND charge_off_date IS NULL' },
      { diTable: 'cdm_deposit_account', property: 'deposit.balance', code: '018', open: 'close_date IS NULL' },
    ];
    for (const c of checks) {
      const map = maps.find((m) => m.diTable === c.diTable);
      const bal = map?.columns.find((x) => x.di === 'balance');
      if (!map || !bal || !line.has(c.code)) continue;
      const [r] = await rows<{ v: number | null }>(this.pool, `SELECT SUM(balance) AS v FROM ${landingTable(c.diTable)} WHERE ${c.open}`).catch(() => []);
      const landed = Number(r?.v ?? 0);
      const reported = line.get(c.code)!;
      const [a, col] = bal.their.split('.') as [string, string];
      out.push({ property: c.property, table: (aliases(map)[a] ?? a).toUpperCase(), column: col, landed, reported, code: c.code, pass: reported > 0 && Math.abs(landed - reported) / reported <= 0.03 });
    }
    return out;
  }

  /** Records what a pull found: new items open, ones seen before reopened with the latest detail. */
  private async recordDrift(connectionId: number, versionId: number, runId: number, findings: DriftFinding[]) {
    const at = nowSql();
    for (const f of findings)
      await this.pool.query(
        `INSERT INTO map_drift (connection_id, version_id, sync_run_id, kind, core_table, core_column, value, detail, state, found_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
         ON DUPLICATE KEY UPDATE version_id = VALUES(version_id), sync_run_id = VALUES(sync_run_id), detail = VALUES(detail), state = 'open', found_at = VALUES(found_at), resolved_at = NULL, resolved_version_id = NULL`,
        [connectionId, versionId, runId, f.kind, f.table, f.column, f.value, JSON.stringify(f.detail), at],
      );
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
    type Detail = { processDate: string | null; tables: TableReconcile[]; differences: Difference[]; version?: number | null; held?: HeldCodes[]; raw?: { table: string; rows: number }[]; rawZone?: string | null; drift?: number };
    const [r] = await rows<{ connection_id: number; at: string; rows_pulled: number; detail: string | Detail }>(this.pool, "SELECT connection_id, DATE_FORMAT(COALESCE(finished_at, started_at), '%Y-%m-%d %H:%i') AS at, rows_pulled, detail FROM src_sync_run WHERE run_id = ?", [runId]);
    const conn = (await this.connections()).find((x) => x.connectionId === r!.connection_id)!;
    const detail: Detail = (typeof r!.detail === 'string' ? JSON.parse(r!.detail) : r!.detail) ?? { processDate: null, tables: [], differences: [] };
    return { runId, connection: conn, at: r!.at, rows: Number(r!.rows_pulled), processDate: detail.processDate ?? null, tables: detail.tables ?? [], differences: detail.differences ?? [], version: detail.version ?? null, held: detail.held ?? [], raw: detail.raw ?? [], rawZone: detail.rawZone ?? undefined, drift: detail.drift ?? 0 };
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
      const cols = await rows<{ t: string; c: string }>(core, 'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND EXTRA NOT LIKE \'%INVISIBLE%\'', [db]);
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

  // ---- proposing mappings (Core Mapping and Ontology, phase 2) ----

  /**
   * Profiles every column the login can see, read-only: how many rows have a value (00000000 counts
   * as none), distinct values, the commonest values of a short code list, whether values look like
   * dates (YYYYMMDD or YYYY-MM-DD), numbers, money, rates or 0/1 and Y/N flags, each table's key, and
   * which columns draw their values from another table's key. A table that holds two or three kinds
   * of row told apart by a short code (shares and loans in one table, by account class) is profiled
   * as one slice per kind, named TABLE[COLUMN=VALUE].
   */
  private async profileCore(core: mysql.Connection): Promise<CoreProfile> {
    const [{ db }] = (await rows<{ db: string }>(core, 'SELECT DATABASE() AS db')) as [{ db: string }];
    const raw = await rows<{ t: string; c: string; dt: string }>(core, 'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS dt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND EXTRA NOT LIKE \'%INVISIBLE%\' ORDER BY TABLE_NAME, ORDINAL_POSITION', [db]);
    // A server that ignores the case of table names (Azure's MySQL keeps them in lower case) reports
    // account for ACCOUNT. Such a server takes either spelling, so the vendor's upper case is used throughout.
    const [lc] = await rows<{ v: number }>(core, 'SELECT @@lower_case_table_names AS v').catch(() => []);
    const allLower = raw.length > 0 && raw.every((x) => x.t === x.t.toLowerCase());
    const cols = Number(lc?.v ?? 0) > 0 && !(allLower && raw.every((x) => x.c === x.c.toLowerCase())) ? raw.map((x) => ({ ...x, t: x.t.toUpperCase() })) : raw;
    const tables: CoreTableProfile[] = [];
    const columns: ColumnProfile[] = [];
    const q = (x: string) => `\`${x.replaceAll('`', '')}\``;
    for (const t of [...new Set(cols.map((x) => x.t))].slice(0, 80)) {
      const mine = cols.filter((x) => x.t === t);
      const [{ n }] = (await rows<{ n: number }>(core, `SELECT COUNT(*) AS n FROM ${q(t)}`)) as [{ n: number }];
      const total = Number(n);
      if (!total) {
        tables.push({ table: t, rows: 0, key: null });
        continue;
      }
      const whole = await this.profileSource(core, t, q(t), '', total, mine);
      // A short code that splits the rows into kinds with different columns filled is a class column.
      const split = await this.classColumn(core, t, whole.columns, mine);
      if (!split) {
        tables.push({ table: t, rows: total, key: whole.key });
        columns.push(...whole.columns);
        continue;
      }
      for (const { value, rows: count } of split.values) {
        const name = `${t}[${split.column}=${value}]`;
        const where = `${q(split.column)} = ${core.escape(value)}`;
        const part = await this.profileSource(core, name, q(t), where, count, mine.filter((x) => x.c !== split.column));
        tables.push({ table: name, rows: count, key: part.key });
        columns.push(...part.columns);
      }
    }
    // Which columns draw their values from another table's key: a sample of up to 5,000 distinct
    // values, compared as text. Short code lists (a branch number) are left out, since small numbers
    // fall inside any key by chance.
    const keys = tables.filter((t) => t.key);
    // Each key's values, read once (a few hundred thousand at most), so the checks run in memory.
    const keyValues = new Map<string, Set<string>>();
    for (const k of keys) {
      const s = coreSource(k.table);
      keyValues.set(k.table, new Set((await rows<{ v: string }>(core, `SELECT CAST(${q(k.key!)} AS CHAR) AS v FROM ${q(s.table)}${s.where ? ` WHERE ${s.where}` : ''}`)).map((r) => String(r.v))));
    }
    for (const c of columns) {
      const own = tables.find((t) => t.table === c.table);
      if (own?.key === c.column || c.distinct < 50 || c.dateShare + (c.isoDateShare ?? 0) + (c.usDateShare ?? 0) >= 0.9 || c.fractionShare > 0.05) continue;
      const s = coreSource(c.table);
      const filter = `${s.where ? `${s.where} AND ` : ''}${q(c.column)} IS NOT NULL`;
      const sample = (await rows<{ v: string }>(core, `SELECT DISTINCT CAST(${q(c.column)} AS CHAR) AS v FROM (SELECT ${q(c.column)} FROM ${q(s.table)} WHERE ${filter} LIMIT ${PROFILE_SAMPLE}) x LIMIT 5000`)).map((r) => String(r.v));
      if (!sample.length) continue;
      let best: ColumnProfile['refersTo'] = null;
      for (const k of keys) {
        if (k.table === c.table && k.key === c.column) continue;
        const set = keyValues.get(k.table)!;
        // A handful of small numbers (rates, codes) fall inside a large key by chance; a reference covers a fair part of it.
        // Distinct values in the sample, scaled up to the whole table, as an estimate.
        const estimate = Math.min(c.rows, c.distinct * (c.rows / Math.max(1, c.sampled ?? c.rows)));
        if (estimate < 0.2 * set.size) continue;
        const share = sample.filter((v) => set.has(v)).length / sample.length;
        if (share >= 0.95 && (!best || share > best.share)) best = { table: k.table, column: k.key!, share };
      }
      c.refersTo = best;
    }
    return { tables, columns };
  }

  /** One table, or one slice of it, profiled from a sample of its rows; and its key, checked over every row. */
  private async profileSource(core: mysql.Connection, name: string, from: string, where: string, total: number, mine: { c: string; dt: string }[]) {
    const q = (x: string) => `\`${x.replaceAll('`', '')}\``;
    // What the values look like comes from a sample, so a core of millions of rows profiles in seconds.
    // A random sample spread over the whole table (seeded, so a run repeats): the first rows of a
    // table kept in key order can all be one kind.
    const frac = total > PROFILE_SAMPLE ? Math.min(1, (PROFILE_SAMPLE * 1.05) / total) : 1;
    const filter = [where, frac < 1 ? `RAND(7) < ${frac.toFixed(6)}` : ''].filter(Boolean).join(' AND ');
    const src = `(SELECT * FROM ${from}${filter ? ` WHERE ${filter}` : ''} LIMIT ${PROFILE_SAMPLE}) s`;
    const [{ n: drawn }] = (await rows<{ n: number }>(core, `SELECT COUNT(*) AS n FROM ${src}`)) as [{ n: number }];
    const sampled = Math.min(total, Number(drawn));
    const parts = mine.map((x, i) => {
      const v = `CAST(${q(x.c)} AS CHAR)`;
      const has = `(${v} IS NOT NULL AND TRIM(${v}) <> '' AND ${v} <> '00000000')`;
      const num = `${v} REGEXP '^-?[0-9]+(\\\\.[0-9]+)?$'`;
      return [
        `SUM(${has}) AS f${i}`,
        `COUNT(DISTINCT ${v}) AS d${i}`,
        `SUM(${has} AND ${v} REGEXP '^(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$') AS dt${i}`,
        `SUM(${has} AND ${v} REGEXP '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])') AS iso${i}`,
        `SUM(${has} AND ${v} REGEXP '^(0[1-9]|1[0-2])/(0[1-9]|[12][0-9]|3[01])/(19|20)[0-9]{2}$') AS us${i}`,
        `SUM(${has} AND ${num}) AS nu${i}`,
        `SUM(${has} AND ${v} REGEXP '^-?[0-9]+\\\\.[0-9]*[1-9]') AS fr${i}`,
        `SUM(${has} AND UPPER(TRIM(${v})) IN ('0', '1', 'Y', 'N', 'T', 'F', 'TRUE', 'FALSE')) AS fl${i}`,
        `MIN(CASE WHEN ${num} THEN ${v} + 0 END) AS mn${i}`,
        `MAX(CASE WHEN ${num} THEN ${v} + 0 END) AS mx${i}`,
        `AVG(CASE WHEN ${num} THEN ${v} + 0 END) AS av${i}`,
        `MIN(CASE WHEN ${has} THEN ${v} END) AS tmn${i}`,
        `MAX(CASE WHEN ${has} THEN ${v} END) AS tmx${i}`,
      ].join(', ');
    });
    const [agg] = await rows<Record<string, string | number | null>>(core, `SELECT ${parts.join(', ')} FROM ${src}`);
    const num = (k: string) => Number(agg?.[k] ?? 0);
    const pick = (k: string) => (agg?.[k] === null || agg?.[k] === undefined ? null : String(agg[k]).slice(0, 80));
    const here: ColumnProfile[] = mine.map((x, i) => {
      const filled = num(`f${i}`);
      const share = (k: string) => (filled ? num(k) / filled : 0);
      const numeric = share(`nu${i}`) >= 0.95;
      return {
        table: name,
        column: x.c,
        dataType: x.dt,
        rows: total,
        sampled,
        filled,
        distinct: num(`d${i}`),
        min: pick(numeric ? `mn${i}` : `tmn${i}`),
        max: pick(numeric ? `mx${i}` : `tmx${i}`),
        dateShare: share(`dt${i}`),
        isoDateShare: share(`iso${i}`),
        usDateShare: share(`us${i}`),
        numericShare: share(`nu${i}`),
        fractionShare: share(`fr${i}`),
        flagShare: share(`fl${i}`),
        avg: agg?.[`av${i}`] === null ? null : Number(agg?.[`av${i}`]),
        top: [],
      };
    });
    for (const c of here) {
      if (c.distinct > 40 || !c.filled) continue;
      c.top = (await rows<{ v: string; n: number }>(core, `SELECT CAST(${q(c.column)} AS CHAR) AS v, COUNT(*) AS n FROM ${src} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12`)).map((r) => ({ value: String(r.v ?? ''), count: Number(r.n) }));
    }
    // The key: unique in the sample, then checked over every row.
    let key: string | null = null;
    for (const c of here.filter((x) => x.distinct === sampled && x.numericShare >= 0.99 && x.filled === sampled)) {
      const [u] = await rows<{ n: number }>(core, `SELECT COUNT(DISTINCT ${q(c.column)}) AS n FROM ${from}${where ? ` WHERE ${where}` : ''}`);
      if (Number(u?.n) === total) {
        key = c.column;
        break;
      }
    }
    return { columns: here, key };
  }

  /**
   * A column that splits a table into two or three kinds of row: a short code (each value at least 5%
   * of rows) under which at least two other columns are filled for one kind and empty for another.
   */
  private async classColumn(core: mysql.Connection, table: string, profiled: ColumnProfile[], mine: { c: string }[]) {
    const q = (x: string) => `\`${x.replaceAll('`', '')}\``;
    for (const c of profiled) {
      if (c.distinct < 2 || c.distinct > 3 || c.top.length !== c.distinct || c.top.some((t) => t.count < 0.05 * (c.sampled ?? c.rows))) continue;
      const others = mine.filter((x) => x.c !== c.column);
      const fill = others.map((x, i) => `SUM(${q(x.c)} IS NOT NULL AND TRIM(CAST(${q(x.c)} AS CHAR)) NOT IN ('', '00000000')) / COUNT(*) AS f${i}`).join(', ');
      const by = await rows<Record<string, number | string>>(core, `SELECT CAST(${q(c.column)} AS CHAR) AS v, COUNT(*) AS n, ${fill} FROM ${q(table)} GROUP BY 1`);
      const differs = others.filter((_, i) => {
        const xs = by.map((r) => Number(r[`f${i}`]));
        return Math.max(...xs) - Math.min(...xs) >= 0.5;
      }).length;
      if (differs >= 2) return { column: c.column, values: by.map((r) => ({ value: String(r.v), rows: Number(r.n) })) };
    }
    return null;
  }

  /** The regulatory return's latest figures a mapping can be checked against: total loans, total shares and members (a credit union's 5300). */
  private async returnFigures() {
    const lines: Record<string, string> = { 'loan.balance': '025B', 'deposit.balance': '018', 'member.id': '083' };
    const found = await rows<{ code: string; amount: number }>(this.pool, "SELECT v.code, v.amount FROM cr_value v WHERE v.quarter_end = (SELECT MAX(quarter_end) FROM cr_value) AND v.code IN ('025B', '018', '083')").catch(() => []);
    const by = new Map(found.map((r) => [r.code, Number(r.amount)]));
    return new Map(Object.entries(lines).filter(([, code]) => by.has(code)).map(([prop, code]) => [prop, { code, amount: by.get(code)! }]));
  }

  /**
   * Proposes how the core's columns map to DI's members, shares and loans. Profiles the core
   * (read-only), scores every pair on five signals, checks loan and share totals and the member
   * count against the 5300, assigns the best one to one, and records the run. With hideStandard,
   * Kinective's mapping for this core is left out of the scoring and the proposals are measured
   * against it instead. Changes no mapping and no pull.
   */
  async discover(opts: { connectionId?: number; hideStandard?: boolean; descriptions?: boolean; runBy: string }) {
    const all = await this.connections();
    const conn = opts.connectionId ? all.find((c) => c.connectionId === opts.connectionId) : all[0];
    if (!conn) throw new CoreError('NOT_FOUND', 'There’s no core connection yet. Connect the core replica first; DI proposes a mapping from its real columns and rows.');
    const [cred] = await rows<{ credential_id: number }>(this.pool, 'SELECT credential_id FROM src_connection WHERE connection_id = ?', [conn.connectionId]);
    const o = ontology();
    const pack = o.vendors.get(conn.system.id) ?? null;
    const useDescriptions = opts.descriptions ?? true;
    // Kinective's mapping for this core, by core column: the precedent, and what a hidden run is measured against.
    const standard = new Map<string, string>();
    const known: { diTable: string; diColumn: string; core: string; transform: string }[] = [];
    for (const t of pack?.tables ?? []) {
      const al = fromAliases(t.from);
      for (const c of t.columns) {
        const [a, col] = c.their.split('.') as [string, string];
        const core = `${al.get(a)}.${col}`;
        standard.set(core, c.denotes);
        known.push({ diTable: t.di_table, diColumn: c.di, core, transform: c.how });
      }
    }
    const started = nowSql();
    const figures = await this.returnFigures();
    const result = await this.withCore(cred!.credential_id, async (core) => {
      const profile = await this.profileCore(core);
      if (useDescriptions && pack) profile.descriptions = new Map(Object.entries(pack.vocabulary).flatMap(([t, v]) => Object.entries(v.columns).map(([c, d]) => [`${t}.${c}`, d.description] as [string, string])));
      const precedent = opts.hideStandard ? null : standard.size ? standard : null;
      const first = scoreAll(o, profile, [...SOURCE_TARGETS], { precedent, descriptions: useDescriptions });
      const firstPass = assign(first.candidates);
      // Tie-outs: the best column for each total, summed over open rows as the first pass reads them.
      const tieOuts = new Map<string, boolean>();
      const ties: { property: string; column: string; core: number; reported: number; code: string; pass: boolean }[] = [];
      for (const [prop, fig] of figures) {
        // Every column in the right DI table that could hold this total is tried, so the tie-out can tell candidates apart.
        const diTable = o.properties.get(prop)!.realized_by.map((x) => x.split('.')[0]!).find((t) => (SOURCE_TARGETS as readonly string[]).includes(t));
        const options = first.candidates.filter((c) => c.property === prop && c.diTable === diTable).sort((a, b) => b.score - a.score).slice(0, 4);
        for (const c of options) {
          const empty = (col: string) => `(\`${col}\` IS NULL OR TRIM(CAST(\`${col}\` AS CHAR)) IN ('', '00000000'))`;
          // Open rows: no close date (and no charge-off date) as the first pass maps them; members also not flagged as non-members.
          const conds = firstPass.filter((p) => p.coreTable === c.coreTable && ['loan.close_date', 'loan.charge_off_date', 'deposit.close_date'].includes(p.property)).map((p) => empty(p.coreColumn));
          if (prop === 'member.id') {
            for (const p of firstPass.filter((x) => x.coreTable === c.coreTable && x.property === 'member.is_member')) conds.push(`UPPER(TRIM(\`${p.coreColumn}\`)) ${p.transform === 'not' ? "IN ('0', 'N', 'F', 'FALSE')" : "IN ('1', 'Y', 'T', 'TRUE')"}`);
            // A membership's close date isn't a DI column, so it's found by name among the table's dates.
            const close = profile.columns.find((x) => x.table === c.coreTable && x.kind === 'date' && /close/i.test(x.column));
            if (close) conds.push(empty(close.column));
          }
          const src = coreSource(c.coreTable);
          if (src.where) conds.push(src.where);
          const sql = prop === 'member.id' ? `SELECT COUNT(DISTINCT \`${c.coreColumn}\`) AS v FROM \`${src.table}\`` : `SELECT SUM(\`${c.coreColumn}\` + 0)${c.transform === 'cents' ? ' / 100' : ''} AS v FROM \`${src.table}\``;
          const [r] = await rows<{ v: number | null }>(core, `${sql}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}`).catch(() => []);
          const v = Number(r?.v ?? 0);
          const pass = fig.amount > 0 && Math.abs(v - fig.amount) / fig.amount <= 0.03;
          tieOuts.set(`${c.coreTable}.${c.coreColumn}|${prop}`, pass);
          if (c === options[0] || pass) ties.push({ property: prop, column: `${c.coreTable}.${c.coreColumn}`, core: v, reported: fig.amount, code: fig.code, pass });
        }
      }
      const second = scoreAll(o, profile, [...SOURCE_TARGETS], { precedent, tieOuts, descriptions: useDescriptions });
      const proposals = assign(second.candidates, { standard: opts.hideStandard ? undefined : standard });
      return { profile, proposals, ties, tableOf: second.tableOf, owner: second.owner };
    });
    const comparison = known.length ? compareWith(result.proposals, known) : null;
    // For each code column, what its codes mean in DI's terms, from the codes themselves.
    const crosswalks: Crosswalk[] = [];
    for (const p of result.proposals.filter((x) => x.transform === 'code')) {
      const prof = result.profile.columns.find((c) => c.table === p.coreTable && c.column === p.coreColumn);
      const prop = o.properties.get(p.property)!;
      const inUse = (await rows<{ v: string }>(this.pool, `SELECT DISTINCT \`${p.diColumn}\` AS v FROM \`${p.diTable}\` WHERE \`${p.diColumn}\` IS NOT NULL LIMIT 60`).catch(() => [])).map((r) => String(r.v));
      const scale = prof && prof.sampled ? prof.rows / prof.sampled : 1;
      const codes = (prof?.top ?? []).map((t) => ({ value: t.value, count: Math.round(t.count * scale) }));
      crosswalks.push({ diTable: p.diTable, diColumn: p.diColumn, core: `${p.coreTable}.${p.coreColumn}`, set: prop.value_set ?? null, codes: proposeCrosswalk(o, prop, codes, inUse) });
    }
    const bands = { standard: 0, auto: 0, review: 0, person: 0 } as Record<Proposal['band'], number>;
    for (const p of result.proposals) bands[p.band]++;
    const summary = {
      tables: Object.fromEntries([...result.tableOf]),
      bands,
      ties: result.ties,
      comparison: comparison ? { total: comparison.total, right: comparison.right, transformsRight: comparison.transformsRight, missed: comparison.rows.filter((r) => !r.right).map((r) => ({ di: r.di, expected: r.expected, proposed: r.proposed })), extra: comparison.extra.map((p) => `${p.coreTable}.${p.coreColumn} → ${p.diTable}.${p.diColumn}`) } : null,
      descriptions: useDescriptions && !!pack,
      sample: PROFILE_SAMPLE,
      crosswalks,
      entities: Object.fromEntries([...result.owner]),
    };
    const [ins] = (await this.pool.query('INSERT INTO map_run (connection_id, system_id, mode, started_at, finished_at, columns_profiled, summary, run_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [conn.connectionId, conn.system.id, opts.hideStandard ? 'measure' : 'propose', started, nowSql(), result.profile.columns.length, JSON.stringify(summary), opts.runBy])) as unknown as [{ insertId: number }];
    const runId = ins.insertId;
    const prof = result.profile.columns.map((c) => [runId, c.table, c.column, c.dataType, c.kind ?? 'text', c.rows, c.filled, c.distinct, c.min, c.max, c.top.length ? JSON.stringify(c.top) : null, c.refersTo ? `${c.refersTo.table}.${c.refersTo.column}` : null]);
    if (prof.length) await this.pool.query('INSERT INTO map_profile (run_id, core_table, core_column, data_type, kind, row_count, filled, distinct_count, min_value, max_value, top_values, refers_to) VALUES ?', [prof]);
    const cand = result.proposals.map((p) => [runId, p.coreTable, p.coreColumn, p.diTable, p.diColumn, p.property, p.score, p.band, p.transform, JSON.stringify({ ...p.signals, why: p.why }), p.runnerUp ? JSON.stringify(p.runnerUp) : null]);
    if (cand.length) await this.pool.query('INSERT INTO map_candidate (run_id, core_table, core_column, di_table, di_column, property_id, score, band, transform, signals, runner_up) VALUES ?', [cand]);
    const used = new Set(result.proposals.map((p) => `${p.coreTable}.${p.coreColumn}`));
    // Columns with values that fit no DI column: candidates for custom fields, such as tracking records.
    const unmatched = result.profile.columns.filter((c) => c.filled > 0 && !used.has(`${c.table}.${c.column}`) && c.kind !== 'key' && c.kind !== 'reference').map((c) => `${c.table}.${c.column}`);
    return { runId, connection: conn, mode: opts.hideStandard ? ('measure' as const) : ('propose' as const), profiled: result.profile.columns.length, tables: result.profile.tables, proposals: result.proposals.map((p) => ({ ...p, label: o.properties.get(p.property)?.label ?? p.property })), ties: result.ties, tableOf: result.tableOf, owner: result.owner, comparison, bands, unmatched, crosswalks };
  }

  /** The latest run's proposals and profiles, for review and explanation. */
  async mapRun(runId?: number) {
    const [run] = runId
      ? await rows<{ run_id: number; system_id: string; mode: string; finished_at: string; summary: unknown; columns_profiled: number }>(this.pool, 'SELECT run_id, system_id, mode, finished_at, summary, columns_profiled FROM map_run WHERE run_id = ?', [runId]).catch(() => [])
      : await rows<{ run_id: number; system_id: string; mode: string; finished_at: string; summary: unknown; columns_profiled: number }>(this.pool, 'SELECT run_id, system_id, mode, finished_at, summary, columns_profiled FROM map_run ORDER BY run_id DESC LIMIT 1').catch(() => []);
    if (!run) return null;
    const proposals = await rows<{ core_table: string; core_column: string; di_table: string; di_column: string; property_id: string; score: number; band: string; transform: string; signals: unknown; runner_up: unknown }>(this.pool, 'SELECT core_table, core_column, di_table, di_column, property_id, score, band, transform, signals, runner_up FROM map_candidate WHERE run_id = ? ORDER BY di_table, score DESC', [run.run_id]);
    const profiles = await rows<{ core_table: string; core_column: string; kind: string; row_count: number; filled: number; distinct_count: number; min_value: string | null; max_value: string | null; top_values: unknown; refers_to: string | null }>(this.pool, 'SELECT core_table, core_column, kind, row_count, filled, distinct_count, min_value, max_value, top_values, refers_to FROM map_profile WHERE run_id = ?', [run.run_id]);
    const json = <T>(v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));
    return {
      runId: run.run_id,
      system: coreSystem(run.system_id)?.short ?? run.system_id,
      mode: run.mode,
      at: String(run.finished_at).slice(0, 16),
      profiled: Number(run.columns_profiled),
      summary: json<{ sample?: number; bands: Record<string, number>; tables: Record<string, string>; ties: { property: string; column: string; core: number; reported: number; code: string; pass: boolean }[]; comparison: { total: number; right: number; transformsRight: number; missed: { di: string; expected: string; proposed: string | null }[]; extra: string[] } | null }>(run.summary),
      proposals: proposals.map((p) => ({ core: `${p.core_table}.${p.core_column}`, di: `${p.di_table}.${p.di_column}`, property: p.property_id, label: ontology().properties.get(p.property_id)?.label ?? p.property_id, score: Number(p.score), band: p.band, transform: p.transform, signals: json<Signals & { why: string[] }>(p.signals), runnerUp: p.runner_up ? json<{ coreColumn: string; diColumn: string; score: number }>(p.runner_up) : null })),
      profiles: profiles.map((p) => ({ core: `${p.core_table}.${p.core_column}`, kind: p.kind, rows: Number(p.row_count), filled: Number(p.filled), distinct: Number(p.distinct_count), min: p.min_value, max: p.max_value, top: p.top_values ? json<{ value: string; count: number }[]>(p.top_values) : [], refersTo: p.refers_to })),
    };
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
  for (const m of map.from.matchAll(/(?:^|\bJOIN\s+)([A-Za-z][A-Za-z0-9_]*)\s+([a-z])\b/g)) out[m[2]!] = m[1]!;
  return out;
}
