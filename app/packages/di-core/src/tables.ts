// DI Core for the Tables app (spec 8.11): column stats, how the curated tables link, and the saved
// views and snapshots people make from them. Only the curated tables are here, with personal columns
// left out of every figure. Rows are always read under the person's purview, in SQL. A saved view is a
// definition that runs again for whoever opens it; a snapshot is a frozen copy, and anyone it's shared
// with sees only its rows in their own purview. Nothing is ever hard deleted: a delete moves an item
// to the Recycle Bin, where it can be restored. Warehouse rows can't be edited here at all.
import type { Pool } from '@dinext/tenant-db';
import { CoreError, type CoreContext } from './referrals.ts';
import { USER_CLASSES } from './modules2.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const moved = (r: unknown) => (r as { affectedRows: number }).affectedRows;

export type ColumnType = 'text' | 'number' | 'currency' | 'percent' | 'count' | 'date' | 'days';

export interface CatalogColumn {
  field: string;
  headerName: string;
  type: ColumnType;
  sql: string;
  /** An identifier: counted, but no top values or average. */
  id?: boolean;
}

export interface CatalogTable {
  id: string;
  label: string;
  from: string;
  where: string;
  /** The branch each row belongs to, for the purview. */
  branch: string;
  columns: CatalogColumn[];
  /** Columns that join to other tables, and whether each is unique here. */
  keys: Record<string, { unique: boolean }>;
  /** Personal columns, never profiled, shown or merged. */
  personal: string[];
  /** Largest first, so a capped copy keeps what matters most. */
  order: string;
}

/** Snapshots keep at most this many rows. */
export const SNAPSHOT_ROW_CAP = 5000;
/** A table or saved view on screen shows at most this many rows. */
export const VIEW_ROW_CAP = 500;

const day = (sql: string) => `DATE_FORMAT(${sql}, '%Y-%m-%d')`;

/** The curated tables, for a credit union's members or a bank's customers. */
export function tableCatalog(person: 'member' | 'customer' = 'member'): CatalogTable[] {
  const Person = person === 'member' ? 'Member' : 'Customer';
  const memberId: CatalogColumn = { field: 'member_id', headerName: `${Person} ID`, type: 'text', sql: '', id: true };
  const branch: CatalogColumn = { field: 'branch', headerName: 'Branch', type: 'text', sql: 'b.name' };
  return [
    {
      id: 'loan_accounts',
      label: 'Loan Accounts',
      from: 'cdm_loan l JOIN cdm_location b ON b.int_id = l.branch_id',
      where: 'l.close_date IS NULL AND l.charge_off_date IS NULL',
      branch: 'b.name',
      order: 'l.balance DESC, l.loan_id',
      columns: [{ field: 'account', headerName: 'Account', type: 'text', sql: 'l.loan_id', id: true }, { ...memberId, sql: 'l.party_id' }, branch, { field: 'product', headerName: 'Product', type: 'text', sql: 'l.loan_category' }, { field: 'channel', headerName: 'Channel', type: 'text', sql: "IF(l.is_indirect = 1, 'Indirect', 'Direct')" }, { field: 'balance', headerName: 'Balance', type: 'currency', sql: 'l.balance' }, { field: 'original_amount', headerName: 'Original amount', type: 'currency', sql: 'l.original_amount' }, { field: 'rate', headerName: 'Rate', type: 'percent', sql: 'l.rate' }, { field: 'opened', headerName: 'Opened', type: 'date', sql: day('l.open_date') }, { field: 'days_past_due', headerName: 'Days past due', type: 'days', sql: 'l.days_delinquent' }],
      keys: { member_id: { unique: false }, branch: { unique: false } },
      personal: [],
    },
    {
      id: 'deposit_accounts',
      label: 'Deposit Accounts',
      from: 'cdm_deposit_account d JOIN cdm_location b ON b.int_id = d.branch_id',
      where: 'd.close_date IS NULL',
      branch: 'b.name',
      order: 'd.balance DESC, d.account_id',
      columns: [{ field: 'account', headerName: 'Account', type: 'text', sql: 'd.account_id', id: true }, { ...memberId, sql: 'd.party_id' }, branch, { field: 'product', headerName: 'Product', type: 'text', sql: 'd.deposit_category' }, { field: 'balance', headerName: 'Balance', type: 'currency', sql: 'd.balance' }, { field: 'rate', headerName: 'Rate', type: 'percent', sql: 'd.rate' }, { field: 'opened', headerName: 'Opened', type: 'date', sql: day('d.open_date') }, { field: 'matures', headerName: 'Matures', type: 'date', sql: day('d.maturity_date') }],
      keys: { member_id: { unique: false }, branch: { unique: false } },
      personal: [],
    },
    {
      id: 'certificates',
      label: 'Certificates',
      from: 'cdm_deposit_account d JOIN cdm_location b ON b.int_id = d.branch_id',
      where: 'd.close_date IS NULL AND d.maturity_date IS NOT NULL',
      branch: 'b.name',
      order: 'd.maturity_date, d.account_id',
      columns: [{ field: 'account', headerName: 'Account', type: 'text', sql: 'd.account_id', id: true }, { ...memberId, sql: 'd.party_id' }, branch, { field: 'product', headerName: 'Product', type: 'text', sql: 'd.deposit_category' }, { field: 'balance', headerName: 'Balance', type: 'currency', sql: 'd.balance' }, { field: 'rate', headerName: 'Rate', type: 'percent', sql: 'd.rate' }, { field: 'matures', headerName: 'Matures', type: 'date', sql: day('d.maturity_date') }],
      keys: { member_id: { unique: false }, branch: { unique: false } },
      personal: [],
    },
    {
      id: 'members',
      label: `${Person}s`,
      from: 'cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id',
      where: '1 = 1',
      branch: 'b.name',
      order: 'p.join_date DESC, p.party_id',
      columns: [{ ...memberId, sql: 'p.party_id' }, branch, { field: 'joined', headerName: 'Joined', type: 'date', sql: day('p.join_date') }, { field: 'segment', headerName: 'Segment', type: 'text', sql: 'p.segment_code' }, { field: 'kind', headerName: 'Type', type: 'text', sql: `IF(p.is_member = 1, '${Person}', 'Non-${person}')` }],
      keys: { member_id: { unique: true }, branch: { unique: false } },
      personal: ['name', 'birth date', 'household'],
    },
    {
      id: 'branches',
      label: 'Branches',
      from: 'cdm_location b',
      where: '1 = 1',
      branch: 'b.name',
      order: 'b.name',
      columns: [{ field: 'branch_id', headerName: 'Branch ID', type: 'text', sql: 'b.int_id', id: true }, branch, { field: 'region', headerName: 'Region', type: 'text', sql: 'b.region' }, { field: 'opened', headerName: 'Opened', type: 'date', sql: day('b.opened_date') }],
      keys: { branch: { unique: true } },
      personal: [],
    },
  ];
}

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !['the', 'table', 'tables', 'my', 'our', 'a', 'an', 'of', 'for', 'and', 'with', 'view', 'saved', 'snapshot'].includes(w))
    .map((w) => w.replace(/s$/, ''));

/** A curated table by the words someone used for it: "loan accounts", "the members table", "loans". */
export function tableNamed(text: string, catalog = tableCatalog()) {
  const t = text.toLowerCase();
  const exact = catalog.find((c) => t.includes(c.id.replace('_', ' ')) || t.includes(c.label.toLowerCase()) || t.trim() === c.id);
  if (exact) return exact;
  const want = words(text);
  if (/\bloans?\b/.test(t)) return catalog.find((c) => c.id === 'loan_accounts');
  if (/\bcertificates?\b|\bcds?\b/.test(t)) return catalog.find((c) => c.id === 'certificates');
  if (/\b(deposits?|shares?|savings|checking)\b/.test(t)) return catalog.find((c) => c.id === 'deposit_accounts');
  if (/\b(members?|customers?|parties|people)\b/.test(t)) return catalog.find((c) => c.id === 'members');
  if (/\b(branch|branches|locations?)\b/.test(t)) return catalog.find((c) => c.id === 'branches');
  return want.length ? catalog.find((c) => want.every((w) => words(c.label).includes(w))) : undefined;
}

/** A key column by the words someone used for it: "member ID", "customer id", "branch". */
export function keyNamed(text: string) {
  const t = text.toLowerCase();
  if (/\b(member|customer|party)( (id|number|#))?\b/.test(t)) return 'member_id';
  if (/\bbranch\b/.test(t)) return 'branch';
  return undefined;
}

export interface ColumnStat {
  column: string;
  field: string;
  type: ColumnType;
  nonNullPct: number;
  distinct: number;
  min: string | number | null;
  max: string | number | null;
  mean: number | null;
  top: { value: string; count: number }[];
}

export interface TableRelationship {
  table: string;
  tableId: string;
  key: string;
  shape: string;
}

export interface MergeDefinition {
  left: string;
  right: string;
  key: string;
}

export interface TableObject {
  objId: number;
  kind: 'View' | 'Snapshot';
  name: string;
  tableId: string;
  rowCount: number;
  ownerUserId: string;
  ownerName: string;
  sharedClass: string | null;
  status: 'Active' | 'Recycle Bin';
  createdOn: string;
  recycledOn: string | null;
  definition: MergeDefinition | null;
}

export interface TableRows {
  label: string;
  columns: { field: string; headerName: string; type: ColumnType }[];
  rows: Record<string, string | number | null>[];
  rowCount: number;
}

const isNumber = (t: ColumnType) => ['number', 'currency', 'percent', 'count', 'days'].includes(t);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const value = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : String(v));
const toObject = (r: Record<string, unknown>): TableObject => ({ objId: r.obj_id as number, kind: r.kind as TableObject['kind'], name: r.name as string, tableId: r.table_id as string, rowCount: Number(r.row_count), ownerUserId: r.owner_user_id as string, ownerName: r.owner_name as string, sharedClass: (r.shared_class as string | null) ?? null, status: r.status as TableObject['status'], createdOn: r.created_on as string, recycledOn: (r.recycled_on as string | null) ?? null, definition: r.definition ? ((typeof r.definition === 'string' ? JSON.parse(r.definition) : r.definition) as MergeDefinition) : null });
const OBJECT_COLUMNS = "obj_id, kind, name, table_id, row_count, owner_user_id, owner_name, shared_class, status, DATE_FORMAT(created_on, '%Y-%m-%d') AS created_on, DATE_FORMAT(recycled_on, '%Y-%m-%d') AS recycled_on, definition";

/** Who can share with whom: a class, or everyone at the institution. */
export const SHARE_TARGETS = [...USER_CLASSES, 'Everyone'];

/** "the analyst class", "managers", "everyone", as a share target. */
export function shareTargetNamed(text: string) {
  const t = text.toLowerCase();
  if (/\b(everyone|everybody|all (users|staff)|the whole institution)\b/.test(t)) return 'Everyone';
  return USER_CLASSES.find((c) => new RegExp(`\\b${c.toLowerCase()}s?\\b`).test(t) || (c === 'MSR' && /\bmember services?\b/.test(t)) || (c === 'Administrator' && /\badmins?\b/.test(t)) || (c === 'Executive' && /\bexecs?\b/.test(t)));
}

export class TableService {
  readonly catalog: CatalogTable[];

  constructor(
    private readonly pool: Pool,
    person: 'member' | 'customer' = 'member',
  ) {
    this.catalog = tableCatalog(person);
  }

  /** A curated table, or not found. Nothing outside the catalog can be read here. */
  table(idOrWords: string) {
    const t = this.catalog.find((c) => c.id === idOrWords) ?? tableNamed(idOrWords, this.catalog);
    if (!t) throw new CoreError('NOT_FOUND', `There’s no curated table called “${idOrWords}”. The tables are ${this.catalog.map((c) => c.label).join(', ')}.`);
    return t;
  }

  private scope(t: CatalogTable, ctx: CoreContext) {
    return ctx.purviewBranches ? { sql: `${t.where} AND ${t.branch} IN (?)`, params: [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] } : { sql: t.where, params: [] as unknown[] };
  }

  private select(t: CatalogTable, ctx: CoreContext, prefix = '') {
    const s = this.scope(t, ctx);
    return { sql: `SELECT ${t.columns.map((c) => `${c.sql} AS \`${prefix}${c.field}\``).join(', ')} FROM ${t.from} WHERE ${s.sql}`, params: s.params };
  }

  /** Rows the person can see, largest first, capped. */
  async count(tableId: string, ctx: CoreContext) {
    const t = this.table(tableId);
    const s = this.scope(t, ctx);
    const [r] = await rows<{ n: number }>(this.pool, `SELECT COUNT(*) AS n FROM ${t.from} WHERE ${s.sql}`, s.params);
    return Number(r?.n ?? 0);
  }

  async rows(tableId: string, ctx: CoreContext, cap = VIEW_ROW_CAP): Promise<TableRows> {
    const t = this.table(tableId);
    const q = this.select(t, ctx);
    const found = await rows<Record<string, unknown>>(this.pool, `${q.sql} ORDER BY ${t.order} LIMIT ${Math.min(cap, SNAPSHOT_ROW_CAP)}`, q.params);
    return { label: t.label, columns: t.columns.map(({ field, headerName, type }) => ({ field, headerName, type })), rows: found.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, value(v)]))), rowCount: await this.count(t.id, ctx) };
  }

  /** Each column's type, how full it is, distinct values, range or top values. Personal columns are never in it. */
  async stats(tableId: string, ctx: CoreContext, column?: string): Promise<{ table: CatalogTable; rows: number; columns: ColumnStat[] }> {
    const t = this.table(tableId);
    const cols = column ? t.columns.filter((c) => words(`${c.headerName} ${c.field}`).some((w) => words(column).includes(w))) : t.columns;
    if (!cols.length) {
      const personal = t.personal.find((p) => column && column.toLowerCase().includes(p));
      throw new CoreError(personal ? 'INVALID' : 'NOT_FOUND', personal ? `${t.label} ${personal} is personal data, so it isn’t profiled.` : `${t.label} has no column called “${column}”. Its columns are ${t.columns.map((c) => c.headerName).join(', ')}.`);
    }
    const s = this.scope(t, ctx);
    const agg = cols.flatMap((c, i) => [`COUNT(${c.sql}) AS nn${i}`, `COUNT(DISTINCT ${c.sql}) AS d${i}`, ...(isNumber(c.type) || c.type === 'date' ? [`MIN(${c.sql}) AS lo${i}`, `MAX(${c.sql}) AS hi${i}`] : []), ...(isNumber(c.type) && !c.id ? [`AVG(${c.sql}) AS av${i}`] : [])]);
    const [r] = await rows<Record<string, unknown>>(this.pool, `SELECT COUNT(*) AS n, ${agg.join(', ')} FROM ${t.from} WHERE ${s.sql}`, s.params);
    const n = Number(r?.n ?? 0);
    const out: ColumnStat[] = [];
    for (const [i, c] of cols.entries()) {
      const top = c.type === 'text' && !c.id ? (await rows<{ v: unknown; n: number }>(this.pool, `SELECT ${c.sql} AS v, COUNT(*) AS n FROM ${t.from} WHERE ${s.sql} GROUP BY v ORDER BY n DESC, v LIMIT 3`, s.params)).map((x) => ({ value: String(x.v), count: Number(x.n) })) : [];
      const mean = num(r?.[`av${i}`]);
      out.push({ column: c.headerName, field: c.field, type: c.type, nonNullPct: n ? Math.round((Number(r?.[`nn${i}`]) / n) * 1000) / 10 : 0, distinct: Number(r?.[`d${i}`] ?? 0), min: value(r?.[`lo${i}`]) as string | number | null, max: value(r?.[`hi${i}`]) as string | number | null, mean: mean === null ? null : Math.round(mean * 100) / 100, top });
    }
    return { table: t, rows: n, columns: out };
  }

  /** The other curated tables that share a key with this one. */
  relationships(tableId: string): TableRelationship[] {
    const t = this.table(tableId);
    const label = (k: string) => t.columns.find((c) => c.field === k)?.headerName ?? k;
    return this.catalog
      .filter((o) => o.id !== t.id)
      .flatMap((o) => Object.keys(t.keys).filter((k) => o.keys[k] && (t.keys[k]!.unique || o.keys[k]!.unique)).map((k) => ({ table: o.label, tableId: o.id, key: label(k), shape: `${t.keys[k]!.unique ? 'One' : 'Many'} to ${o.keys[k]!.unique ? 'one' : 'many'}` })));
  }

  /** The columns of a merge: all of the left table's, then the right's that aren't the key, named after it. */
  private mergeColumns(left: CatalogTable, right: CatalogTable, key: string) {
    const rightCols = right.columns.filter((c) => c.field !== key);
    return [...left.columns.map(({ field, headerName, type }) => ({ field, headerName, type })), ...rightCols.map((c) => ({ field: `${right.id}__${c.field}`, headerName: left.columns.some((l) => l.field === c.field) ? `${right.label}: ${c.headerName}` : c.headerName, type: c.type }))];
  }

  /** Checks a merge: two curated tables that both have the key. */
  checkMerge(d: MergeDefinition) {
    const left = this.table(d.left);
    const right = this.table(d.right);
    if (left.id === right.id) throw new CoreError('INVALID', `Choose two different tables to merge; both are ${left.label}.`);
    const key = keyNamed(d.key) ?? d.key;
    const missing = [left, right].filter((t) => !t.keys[key]);
    if (missing.length) {
      const shared = Object.keys(left.keys).filter((k) => right.keys[k]).map((k) => left.columns.find((c) => c.field === k)?.headerName ?? k);
      const named = [...left.columns, ...right.columns].find((c) => c.field === key)?.headerName ?? d.key;
      throw new CoreError('INVALID', `I can’t merge on ${named}: ${missing.map((t) => t.label).join(' and ')} ${missing.length === 1 ? 'has' : 'have'} no such column.${shared.length ? ` ${left.label} and ${right.label} share ${shared.join(' and ')}.` : ` ${left.label} and ${right.label} share no key.`}`);
    }
    return { left, right, key, columns: this.mergeColumns(left, right, key) };
  }

  private mergeSql(d: MergeDefinition, ctx: CoreContext) {
    const { left, right, key } = this.checkMerge(d);
    const a = this.select(left, ctx);
    const b = this.select(right, ctx, `${right.id}__`);
    return { sql: `FROM (${a.sql}) a JOIN (${b.sql}) b ON b.\`${right.id}__${key}\` = a.\`${key}\``, params: [...a.params, ...b.params], left, right, key };
  }

  /** How many rows a merge gives this person, and its columns. */
  async previewMerge(d: MergeDefinition, ctx: CoreContext) {
    const m = this.mergeSql(d, ctx);
    const [r] = await rows<{ n: number }>(this.pool, `SELECT COUNT(*) AS n ${m.sql}`, m.params);
    return { ...this.checkMerge(d), rowCount: Number(r?.n ?? 0) };
  }

  async mergeRows(d: MergeDefinition, ctx: CoreContext, cap = VIEW_ROW_CAP): Promise<TableRows> {
    const m = this.mergeSql(d, ctx);
    const columns = this.mergeColumns(m.left, m.right, m.key);
    const found = await rows<Record<string, unknown>>(this.pool, `SELECT a.*, ${m.right.columns.filter((c) => c.field !== m.key).map((c) => `b.\`${m.right.id}__${c.field}\``).join(', ')} ${m.sql} ORDER BY a.\`${m.left.columns[0]!.field}\` LIMIT ${Math.min(cap, SNAPSHOT_ROW_CAP)}`, m.params);
    const [r] = await rows<{ n: number }>(this.pool, `SELECT COUNT(*) AS n ${m.sql}`, m.params);
    return { label: `${m.left.label} with ${m.right.label}`, columns, rows: found.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, value(v)]))), rowCount: Number(r?.n ?? found.length) };
  }

  // ---- saved views and snapshots ----------------------------------------------------------------

  /** What a person can see: their own, and what's shared with their class or everyone. The Recycle Bin is only ever their own. */
  async objects(userId: string, opts: { status?: TableObject['status']; tableId?: string } = {}) {
    const status = opts.status ?? 'Active';
    const shared = status === 'Active' ? " OR shared_class = 'Everyone' OR shared_class = (SELECT user_class FROM iam_user WHERE user_id = ? LIMIT 1)" : '';
    const found = await rows<Record<string, unknown>>(this.pool, `SELECT ${OBJECT_COLUMNS} FROM tbl_object WHERE status = ? AND (owner_user_id = ?${shared})${opts.tableId ? ' AND (table_id = ? OR JSON_UNQUOTE(JSON_EXTRACT(definition, \'$.right\')) = ?)' : ''} ORDER BY created_on DESC, obj_id DESC`, [status, userId, ...(shared ? [userId] : []), ...(opts.tableId ? [opts.tableId, opts.tableId] : [])]);
    return found.map(toObject);
  }

  /** One the person can see, by the words of its name. Someone else's or another class's reads as not found. */
  async object(userId: string, name: string, status: TableObject['status'] = 'Active', kind?: TableObject['kind']) {
    const want = words(name);
    const all = (await this.objects(userId, { status })).filter((o) => !kind || o.kind === kind);
    const exact = all.filter((o) => o.name.toLowerCase() === name.trim().toLowerCase());
    const hits = exact.length ? exact : all.filter((o) => want.length > 0 && want.every((w) => words(o.name).some((x) => x.startsWith(w))));
    if (!hits.length) throw new CoreError('NOT_FOUND', status === 'Recycle Bin' ? `There’s nothing called “${name}” in your Tables Recycle Bin.` : `You have no saved view or snapshot called “${name}”. Ones you can’t see don’t show.`);
    if (hits.length > 1) throw new CoreError('INVALID', `${hits.length} match: ${hits.slice(0, 4).map((o) => `${o.name} (${o.kind.toLowerCase()})`).join('; ')}. Which one?`);
    return hits[0]!;
  }

  /** One the person owns. Shared with them isn't enough to change it. */
  async own(userId: string, name: string, status: TableObject['status'] = 'Active', kind?: TableObject['kind']) {
    const o = await this.object(userId, name, status, kind);
    if (o.ownerUserId !== userId) throw new CoreError('INVALID', `${o.name} is ${o.ownerName}’s, so I can’t change it. Ask ${o.ownerName.split(' ')[0]} to.`);
    return o;
  }

  /** The rows of a saved view or snapshot, for this person: a view runs under their purview; a snapshot shows only its rows in it. */
  async objectRows(userId: string, objId: number, ctx: CoreContext): Promise<(TableRows & { object: TableObject }) | null> {
    const o = (await this.objects(userId)).find((x) => x.objId === objId);
    if (!o) return null;
    if (o.kind === 'View' && o.definition) return { ...(await this.mergeRows(o.definition, ctx)), label: o.name, object: o };
    const [r] = await rows<{ content: string }>(this.pool, 'SELECT content FROM tbl_object WHERE obj_id = ?', [objId]);
    const content = JSON.parse(r?.content ?? '{"columns":[],"rows":[]}') as { columns: TableRows['columns']; rows: (string | number | null)[][] };
    const bi = content.columns.findIndex((c) => c.field === 'branch');
    const kept = content.rows.filter((x) => !ctx.purviewBranches || (bi >= 0 && ctx.purviewBranches.includes(String(x[bi]))));
    return { label: o.name, columns: content.columns, rows: kept.slice(0, VIEW_ROW_CAP).map((x) => Object.fromEntries(content.columns.map((c, i) => [c.field, x[i] ?? null]))), rowCount: kept.length, object: o };
  }

  async saveView(p: { name: string; definition: MergeDefinition; rowCount: number; owner: { userId: string; name: string } }, meta: { approvalId: string; on: string }) {
    await this.pool.query("INSERT IGNORE INTO tbl_object (kind, name, table_id, definition, row_count, owner_user_id, owner_name, status, created_on, approval_id) VALUES ('View', ?, ?, ?, ?, ?, ?, 'Active', ?, ?)", [p.name.slice(0, 120), p.definition.left, JSON.stringify(p.definition), p.rowCount, p.owner.userId, p.owner.name, meta.on, meta.approvalId]);
  }

  /** Freezes the rows the person could see when it was approved, up to the cap. Once per approval. */
  async saveSnapshot(p: { name: string; tableId: string; purview: string[] | null; owner: { userId: string; name: string } }, meta: { approvalId: string; on: string }) {
    const [done] = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM tbl_object WHERE approval_id = ?', [meta.approvalId]);
    if (Number(done?.n)) return;
    const data = await this.rows(p.tableId, { purviewBranches: p.purview ?? undefined }, SNAPSHOT_ROW_CAP);
    const content = JSON.stringify({ columns: data.columns, rows: data.rows.map((r) => data.columns.map((c) => r[c.field] ?? null)) });
    await this.pool.query("INSERT IGNORE INTO tbl_object (kind, name, table_id, content, row_count, owner_user_id, owner_name, status, created_on, approval_id) VALUES ('Snapshot', ?, ?, ?, ?, ?, ?, 'Active', ?, ?)", [p.name.slice(0, 120), p.tableId, content, data.rows.length, p.owner.userId, p.owner.name, meta.on, meta.approvalId]);
  }

  /** Shares with a class, or everyone. Only from what the card showed, so a second apply changes nothing. */
  async share(p: { objId: number; ownerUserId: string; from: string | null; to: string }) {
    return moved(await this.pool.query("UPDATE tbl_object SET shared_class = ? WHERE obj_id = ? AND owner_user_id = ? AND status = 'Active' AND shared_class <=> ?", [p.to, p.objId, p.ownerUserId, p.from]));
  }

  /** To the Recycle Bin. Nothing is hard deleted. */
  async recycle(p: { objId: number; ownerUserId: string }, meta: { on: string }) {
    return moved(await this.pool.query("UPDATE tbl_object SET status = 'Recycle Bin', recycled_on = ? WHERE obj_id = ? AND owner_user_id = ? AND status = 'Active'", [meta.on, p.objId, p.ownerUserId]));
  }

  async restore(p: { objId: number; ownerUserId: string }) {
    return moved(await this.pool.query("UPDATE tbl_object SET status = 'Active', recycled_on = NULL WHERE obj_id = ? AND owner_user_id = ? AND status = 'Recycle Bin'", [p.objId, p.ownerUserId]));
  }
}
