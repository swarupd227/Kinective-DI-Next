// Data file loading (spec 8.21 Integrations > Files, "Upload CSV/Excel files"). A person uploads a CSV
// or Excel file; DI profiles it, maps it to a table and says what will load, and an approval writes it.
// Uploaded tables live in the Tables store as their own kind, so they open, share and recycle like a
// snapshot. The curated tables from the core never change here.
import type { Pool } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';
import { SNAPSHOT_ROW_CAP, type ColumnType, type TableRows } from './tables.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const moved = (r: unknown) => (r as { affectedRows: number }).affectedRows;

export type Cell = string | number | null;

/** A file's first sheet: its header row and its data rows, as read. */
export interface Sheet {
  headers: string[];
  rows: Cell[][];
  /** False when the first row looked like data, so the columns were named Column 1, 2, ... */
  hasHeader: boolean;
}

/** Reads an Excel file into sheets. The server passes this in, so DI Core needs no spreadsheet library. */
export type SpreadsheetReader = (body: Buffer) => Promise<{ name: string; headers: string[]; rows: Cell[][] }[]>;

export type ValueKind = 'number' | 'currency' | 'percent' | 'date' | 'yesno' | 'text';

export interface ColumnProfile {
  header: string;
  field: string;
  kind: ValueKind;
  type: ColumnType;
  filled: number;
  blank: number;
  /** Values that don't fit the column's type; they load as blanks. */
  invalid: number;
  invalidExamples: string[];
  example: string;
}

export interface FileProfile {
  rowCount: number;
  columns: ColumnProfile[];
  duplicateRows: number;
  hasHeader: boolean;
  /** Problems that stop a load, in plain words. */
  blockers: string[];
  /** Problems the load works around, in plain words. */
  warnings: string[];
  /** The rows the load would write, typed. */
  typed: Cell[][];
}

// ---- reading ------------------------------------------------------------------------------------

/** CSV, semicolon, tab or pipe separated, with quoted fields (RFC 4180). A byte-order mark is dropped. */
export function parseDelimited(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, '');
  const firstLine = t.slice(0, t.search(/\r?\n|$/));
  const delimiter = [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => r.some((x) => x.trim() !== ''));
}

const looksLikeValue = (s: string) => kindOf(s) !== 'text' && kindOf(s) !== 'yesno';

/** The first row is a header unless it looks like data: mostly numbers or dates. */
function toSheet(grid: Cell[][]): Sheet {
  const first = (grid[0] ?? []).map((c) => (c === null ? '' : String(c).trim()));
  const valueLike = first.filter((h) => h && looksLikeValue(h)).length;
  const hasHeader = first.length > 0 && valueLike < Math.ceil(first.length / 2);
  const width = Math.max(0, ...grid.map((r) => r.length));
  const headers = hasHeader ? Array.from({ length: width }, (_, i) => first[i] ?? '') : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  return { headers, rows: (hasHeader ? grid.slice(1) : grid).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null)), hasHeader };
}

/** A fixed-width file reads as one column whose lines line up in runs of spaces. */
export function looksFixedWidth(grid: string[][]): boolean {
  if (!grid.length || grid.some((r) => r.length > 1)) return false;
  const lines = grid.slice(0, 20).map((r) => r[0] ?? '');
  return lines.length >= 2 && lines.every((l) => / {2,}/.test(l));
}

// ---- profiling ----------------------------------------------------------------------------------

const NUMBER = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
const CURRENCY = /^\(?-?\$\s?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\)?$/;
const PERCENT = /^-?\d+(\.\d+)?\s?%$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
const US_DATE = /^\d{1,2}\/\d{1,2}\/(\d{2}|\d{4})$/;
const YESNO = /^(yes|no|y|n|true|false)$/i;

function kindOf(s: string): ValueKind {
  if (CURRENCY.test(s)) return 'currency';
  if (PERCENT.test(s)) return 'percent';
  if (NUMBER.test(s)) return 'number';
  if (ISO_DATE.test(s) || US_DATE.test(s)) return 'date';
  if (YESNO.test(s)) return 'yesno';
  return 'text';
}

const TYPE_OF: Record<ValueKind, ColumnType> = { number: 'number', currency: 'currency', percent: 'percent', date: 'date', yesno: 'text', text: 'text' };

/** A column's field name: lower case, underscores, unique. */
export const fieldFor = (header: string, taken: Set<string>) => {
  const base = header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'column';
  let f = base;
  for (let i = 2; taken.has(f); i++) f = `${base}_${i}`;
  taken.add(f);
  return f;
};

/** Converts a value to its column's type, or null when it doesn't fit. */
export function convert(raw: Cell, kind: ValueKind): Cell {
  if (raw === null) return null;
  if (typeof raw === 'number') return kind === 'text' || kind === 'yesno' ? String(raw) : raw;
  const s = raw.trim();
  if (!s) return null;
  if (kind === 'text') return s;
  if (kind === 'yesno') return YESNO.test(s) ? (/^(yes|y|true)$/i.test(s) ? 'Yes' : 'No') : null;
  if (kind === 'date') {
    if (ISO_DATE.test(s)) return s.slice(0, 10);
    const m = US_DATE.exec(s);
    if (!m) return null;
    const [mo, d, y] = s.split('/').map(Number) as [number, number, number];
    const year = y < 100 ? 2000 + y : y;
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  }
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  const n = Number(s.replace(/[$,%()\s-]/g, ''));
  if (!Number.isFinite(n) || kindOf(s) === 'text' || kindOf(s) === 'date') return null;
  return negative ? -n : n;
}

/** What's in a file, column by column, and what would stop or change a load. */
export function profile(sheet: Sheet): FileProfile {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!sheet.rows.length) blockers.push('The file has no data rows.');
  if (sheet.rows.length > SNAPSHOT_ROW_CAP) blockers.push(`The file has ${sheet.rows.length.toLocaleString('en-US')} rows; a load can be up to ${SNAPSHOT_ROW_CAP.toLocaleString('en-US')}.`);
  if (!sheet.hasHeader) warnings.push(`The first row looks like data, not headers, so I named the columns Column 1 to Column ${sheet.headers.length}.`);
  const seen = new Map<string, number>();
  sheet.headers.forEach((h) => seen.set(h.trim().toLowerCase(), (seen.get(h.trim().toLowerCase()) ?? 0) + 1));
  const blankHeaders = sheet.headers.filter((h) => !h.trim()).length;
  if (blankHeaders) blockers.push(`${blankHeaders === 1 ? 'A column has' : `${blankHeaders} columns have`} no header. Add a name to each column and upload it again.`);
  const dup = [...seen].filter(([h, n]) => h && n > 1).map(([h]) => h);
  if (dup.length) blockers.push(`Two columns share a header: ${dup.join(', ')}. Give each a different name.`);

  const taken = new Set<string>();
  const columns: ColumnProfile[] = sheet.headers.map((header, i) => {
    const values = sheet.rows.map((r) => r[i] ?? null);
    const strings = values.filter((v) => v !== null && String(v).trim() !== '').map((v) => (typeof v === 'number' ? String(v) : String(v).trim()));
    const counts = new Map<ValueKind, number>();
    for (const s of strings) counts.set(kindOf(s), (counts.get(kindOf(s)) ?? 0) + 1);
    // A column takes the type three in four of its values have, so one "TBD" among amounts is a value
    // that won't load, not a reason to load the whole column as text.
    const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['text', 0];
    const kind: ValueKind = top !== 'text' && n >= strings.length * 0.75 ? top : 'text';
    const bad = kind === 'text' ? [] : strings.filter((s) => convert(s, kind) === null);
    return { header: header.trim() || `Column ${i + 1}`, field: fieldFor(header.trim() || `Column ${i + 1}`, taken), kind, type: TYPE_OF[kind], filled: strings.length, blank: values.length - strings.length, invalid: bad.length, invalidExamples: [...new Set(bad)].slice(0, 3), example: strings[0] ?? '' };
  });
  for (const c of columns.filter((x) => x.invalid)) warnings.push(`${c.invalid} ${c.invalid === 1 ? 'value' : 'values'} in ${c.header} ${c.invalid === 1 ? "isn't a" : "aren't"} ${c.kind === 'yesno' ? 'yes or no' : c.kind}${c.invalid === 1 ? '' : 's'} (${c.invalidExamples.map((x) => `“${x}”`).join(', ')}) and will load blank.`);
  const empty = columns.filter((c) => !c.filled);
  if (empty.length) warnings.push(`${empty.map((c) => c.header).join(', ')} ${empty.length === 1 ? 'is' : 'are'} empty in every row.`);
  const keys = sheet.rows.map((r) => JSON.stringify(r));
  const duplicateRows = keys.length - new Set(keys).size;
  if (duplicateRows) warnings.push(`${duplicateRows} ${duplicateRows === 1 ? 'row repeats' : 'rows repeat'} another row exactly; ${duplicateRows === 1 ? 'it loads' : 'they load'} as is.`);
  const typed = sheet.rows.map((r) => columns.map((c, i) => convert(r[i] ?? null, c.kind)));
  return { rowCount: sheet.rows.length, columns, duplicateRows, hasHeader: sheet.hasHeader, blockers, warnings, typed };
}

// ---- the service --------------------------------------------------------------------------------

export interface UploadedTable {
  objId: number;
  name: string;
  rowCount: number;
  columns: TableRows['columns'];
  ownerUserId: string;
}

const EXCEL = /\.xlsx$/i;
const DELIMITED = /\.(csv|tsv|txt)$/i;
export const LOADABLE = /\.(csv|tsv|txt|xlsx)$/i;

/** A table name from a file name: "branch_targets_2026.csv" becomes "Branch targets 2026". */
export const tableNameFrom = (file: string) => {
  const s = file.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 80) || 'Uploaded data';
};

export class IngestService {
  constructor(
    private readonly pool: Pool,
    private readonly readExcel: SpreadsheetReader | null,
  ) {}

  /** Reads an uploaded file's first sheet. Fixed-width and old .xls files are refused with the reason. */
  async read(name: string, body: Buffer): Promise<Sheet> {
    if (/\.xls$/i.test(name)) throw new CoreError('INVALID', 'Old .xls files can’t be read. Save it as .xlsx or CSV and upload it again.');
    if (EXCEL.test(name)) {
      if (!this.readExcel) throw new CoreError('INVALID', 'Excel files can’t be read in this environment. Save it as CSV and upload it again.');
      const sheets = await this.readExcel(body);
      const first = sheets.find((s) => s.rows.length || s.headers.length);
      if (!first) throw new CoreError('INVALID', 'The workbook has no data in it.');
      return toSheet([first.headers, ...first.rows]);
    }
    if (!DELIMITED.test(name)) throw new CoreError('INVALID', 'I can load CSV, TSV, text or Excel (.xlsx) files.');
    const grid = parseDelimited(body.toString('utf8'));
    if (looksFixedWidth(grid)) throw new CoreError('INVALID', 'This looks like a fixed-width file: each line is one column of values lined up with spaces. I can’t split fixed-width files yet. Save it as CSV with a header row and upload it again.');
    return toSheet(grid);
  }

  /** The uploaded tables this person owns, newest first. */
  async tables(ownerUserId: string): Promise<UploadedTable[]> {
    const found = await rows<{ obj_id: number; name: string; row_count: number; content: string; owner_user_id: string }>(this.pool, "SELECT obj_id, name, row_count, content, owner_user_id FROM tbl_object WHERE kind = 'Upload' AND status = 'Active' AND owner_user_id = ? ORDER BY obj_id DESC", [ownerUserId]);
    return found.map((r) => ({ objId: r.obj_id, name: r.name, rowCount: Number(r.row_count), columns: (JSON.parse(r.content ?? '{"columns":[]}') as { columns: TableRows['columns'] }).columns, ownerUserId: r.owner_user_id }));
  }

  async table(ownerUserId: string, name: string) {
    const want = name.trim().toLowerCase().replace(/\s+table$/, '');
    return (await this.tables(ownerUserId)).find((t) => t.name.toLowerCase() === want) ?? null;
  }

  /**
   * Writes a profiled file. A new table is created once per approval; appending or replacing an
   * existing one records the approval on it, so a second apply changes nothing.
   */
  async load(p: { name: string; objId: number | null; mode: 'new' | 'append' | 'replace'; columns: TableRows['columns']; rows: Cell[][]; owner: { userId: string; name: string } }, meta: { approvalId: string; on: string }) {
    const [done] = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM tbl_object WHERE approval_id = ?', [meta.approvalId]);
    if (Number(done?.n)) return { objId: p.objId, rows: 0 };
    if (p.mode === 'new' || p.objId === null) {
      const content = JSON.stringify({ columns: p.columns, rows: p.rows });
      const [r] = (await this.pool.query("INSERT INTO tbl_object (kind, name, table_id, content, row_count, owner_user_id, owner_name, status, created_on, approval_id) VALUES ('Upload', ?, 'upload', ?, ?, ?, ?, 'Active', ?, ?)", [p.name.slice(0, 120), content, p.rows.length, p.owner.userId, p.owner.name, meta.on, meta.approvalId])) as unknown as [{ insertId: number }];
      return { objId: r.insertId, rows: p.rows.length };
    }
    const [current] = await rows<{ content: string }>(this.pool, "SELECT content FROM tbl_object WHERE obj_id = ? AND kind = 'Upload' AND owner_user_id = ? AND status = 'Active'", [p.objId, p.owner.userId]);
    if (!current) throw new CoreError('NOT_FOUND', `The ${p.name} table isn’t there any more.`);
    const old = JSON.parse(current.content) as { columns: TableRows['columns']; rows: Cell[][] };
    const all = p.mode === 'replace' ? p.rows : [...old.rows, ...p.rows];
    if (all.length > SNAPSHOT_ROW_CAP) throw new CoreError('INVALID', `That would make ${all.length.toLocaleString('en-US')} rows; an uploaded table holds up to ${SNAPSHOT_ROW_CAP.toLocaleString('en-US')}.`);
    const changed = moved(await this.pool.query("UPDATE tbl_object SET content = ?, row_count = ?, approval_id = ? WHERE obj_id = ? AND owner_user_id = ? AND status = 'Active'", [JSON.stringify({ columns: old.columns, rows: all }), all.length, meta.approvalId, p.objId, p.owner.userId]));
    return { objId: p.objId, rows: changed ? p.rows.length : 0 };
  }
}
