// DI Core for the workspace apps: the calendar (spec 8.14), the file library (8.15) and read-only
// queries (8.10). The calendar is built from work that already has a date. A query runs only as a
// single SELECT over curated tables, on the read-only account, and every limit is enforced here.
import type { Pool } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

// ---- calendar -----------------------------------------------------------------------------------

export interface CalendarEvent {
  date: string;
  kind: 'Touch point' | 'Issue due' | 'Certificates' | 'Payouts';
  title: string;
  detail: string;
  late: boolean;
  ask: string;
}

interface TouchSource {
  list(f: { employeeId?: number; withinDays?: number }, ctx: never): Promise<{ asOf: string; items: { member: string; touch: string; due: string; state: string; assignee: string | null; branch: string; daysLate: number }[] }>;
}
interface IssueSource {
  list(f: Record<string, never>, ctx: never): Promise<{ items: { issueId: number; member: string; category: string; resolveBy: string; overdue: boolean; branch: string }[] }>;
}
interface CertificateSource {
  maturing(f: { days: number }, ctx: never): Promise<{ items: { matures: string; amount: number }[] }>;
}

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

export class CalendarService {
  constructor(private readonly sources: { onboarding: TouchSource; issues: IssueSource; retention: CertificateSource }) {}

  /** Dated work inside the purview. A source this person can't use is left out, not an error. */
  async events(input: { employeeId?: number; canUse: (source: 'onboarding' | 'compliance' | 'retention') => boolean; ctx: unknown }) {
    const ctx = input.ctx as never;
    const empty = { asOf: '', items: [] };
    const [touch, issues, certificates] = await Promise.all([input.canUse('onboarding') ? this.sources.onboarding.list({ employeeId: input.employeeId, withinDays: 45 }, ctx) : empty, input.canUse('compliance') ? this.sources.issues.list({}, ctx) : { items: [] }, input.canUse('retention') ? this.sources.retention.maturing({ days: 45 }, ctx) : { items: [] }]);
    const events: CalendarEvent[] = [
      ...touch.items.map((t): CalendarEvent => ({ date: t.due, kind: 'Touch point', title: `${t.member}: ${t.touch.toLowerCase()}`, detail: `${t.branch}, ${t.assignee ?? 'branch queue'}`, late: t.daysLate > 0, ask: 'Show my overdue onboarding touch points' })),
      ...issues.items.map((i): CalendarEvent => ({ date: i.resolveBy, kind: 'Issue due', title: `Issue #${i.issueId}: ${i.category}`, detail: `${i.member}, ${i.branch}`, late: i.overdue, ask: `Show issue #${i.issueId}` })),
    ];
    const byDay = new Map<string, { count: number; total: number }>();
    for (const c of certificates.items) {
      const d = byDay.get(c.matures) ?? { count: 0, total: 0 };
      byDay.set(c.matures, { count: d.count + 1, total: d.total + c.amount });
    }
    for (const [date, d] of byDay) events.push({ date, kind: 'Certificates', title: `${d.count} ${d.count === 1 ? 'certificate matures' : 'certificates mature'}`, detail: money(d.total), late: false, ask: 'Find certificates at risk of leaving' });
    return events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }
}

// ---- files --------------------------------------------------------------------------------------

export interface LibraryFile {
  name: string;
  folder: string;
  type: string;
  sizeKb: number;
  owner: string;
  modified: string;
}

export const FILE_FOLDERS: Record<string, string> = { 'Board Packs': 'Executives and the DI administrator', 'Compliance/Policies': 'Everyone at the institution', 'Lending/Dealer Docs': 'Lending staff', 'Finance/ALCO': 'Finance and executives', Marketing: 'Everyone at the institution' };

/** Demo documents. Their names and sizes are listed; the contents don't exist. */
export const FILE_LIBRARY: LibraryFile[] = [
  { name: 'October board pack.pdf', folder: 'Board Packs', type: 'PDF', sizeKb: 4180, owner: 'Dana Lee', modified: '2026-10-22' },
  { name: 'September board pack.pdf', folder: 'Board Packs', type: 'PDF', sizeKb: 3925, owner: 'Dana Lee', modified: '2026-09-24' },
  { name: 'Board minutes Q3.docx', folder: 'Board Packs', type: 'Word', sizeKb: 212, owner: 'Dana Lee', modified: '2026-10-02' },
  { name: 'BSA and AML policy 2026.pdf', folder: 'Compliance/Policies', type: 'PDF', sizeKb: 860, owner: 'Priya Shah', modified: '2026-03-11' },
  { name: 'Complaint handling procedure.pdf', folder: 'Compliance/Policies', type: 'PDF', sizeKb: 340, owner: 'Priya Shah', modified: '2026-06-19' },
  { name: 'Reg E dispute checklist.docx', folder: 'Compliance/Policies', type: 'Word', sizeKb: 96, owner: 'Priya Shah', modified: '2026-08-05' },
  { name: 'Smith Ford dealer agreement.pdf', folder: 'Lending/Dealer Docs', type: 'PDF', sizeKb: 1240, owner: 'Marcus Reed', modified: '2026-05-14' },
  { name: 'Lakeside Honda dealer agreement.pdf', folder: 'Lending/Dealer Docs', type: 'PDF', sizeKb: 1190, owner: 'Marcus Reed', modified: '2026-07-01' },
  { name: 'Indirect rate sheet October.xlsx', folder: 'Lending/Dealer Docs', type: 'Excel', sizeKb: 58, owner: 'Marcus Reed', modified: '2026-10-01' },
  { name: 'ALCO pack Q3.pdf', folder: 'Finance/ALCO', type: 'PDF', sizeKb: 2310, owner: 'Dana Lee', modified: '2026-10-09' },
  { name: 'Liquidity stress test Q3.xlsx', folder: 'Finance/ALCO', type: 'Excel', sizeKb: 410, owner: 'Priya Shah', modified: '2026-10-07' },
  { name: 'HELOC fall campaign brief.pdf', folder: 'Marketing', type: 'PDF', sizeKb: 720, owner: 'Priya Shah', modified: '2026-08-28' },
];

export function findFiles(query: string) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !['the', 'for', 'file', 'files', 'find', 'our', 'and', 'folder', 'document', 'documents'].includes(w));
  return FILE_LIBRARY.filter((f) => words.some((w) => `${f.name} ${f.folder} ${f.owner}`.toLowerCase().includes(w)));
}

// ---- queries ------------------------------------------------------------------------------------

export interface SavedQuery {
  name: string;
  folder: string;
  description: string;
  sql: string;
}

export const SAVED_QUERIES: SavedQuery[] = [
  { name: 'Loans by branch', folder: 'Lending', description: 'Open loans and balance at each branch.', sql: 'SELECT b.name AS branch, COUNT(*) AS loans, SUM(l.balance) AS balance\nFROM cdm_loan l\nJOIN cdm_location b ON b.int_id = l.branch_id\nWHERE l.close_date IS NULL\nGROUP BY b.name\nORDER BY balance DESC' },
  { name: 'Delinquent by category', folder: 'Lending', description: 'Balance 60 or more days past due, by loan category.', sql: 'SELECT loan_category, COUNT(*) AS loans, SUM(balance) AS balance\nFROM cdm_loan\nWHERE close_date IS NULL AND days_delinquent >= 60\nGROUP BY loan_category\nORDER BY balance DESC' },
  { name: 'Certificates by month', folder: 'Deposits', description: 'Certificate balance by maturity month.', sql: "SELECT DATE_FORMAT(maturity_date, '%Y-%m') AS month, COUNT(*) AS accounts, SUM(balance) AS balance\nFROM cdm_deposit_account\nWHERE maturity_date IS NOT NULL AND close_date IS NULL\nGROUP BY month\nORDER BY month\nLIMIT 12" },
  { name: 'New members by branch', folder: 'Membership', description: 'Members who joined in the last 90 days of data.', sql: "SELECT b.name AS branch, COUNT(*) AS new_members\nFROM cdm_party p\nJOIN cdm_location b ON b.int_id = p.primary_branch_id\nWHERE p.join_date >= DATE_SUB('2026-10-25', INTERVAL 90 DAY)\nGROUP BY b.name\nORDER BY new_members DESC" },
];

/** Curated tables only. Contact details, interactions and everything operational stay out. */
const CURATED = /^(cdm_(location|employee|party|loan|deposit_account)|hist_\w+_month)$/;
const SENSITIVE = /\b(birth_date|household_id|email|phone|ssn|tax_id)\b/i;
const FORBIDDEN = /\b(into|outfile|dumpfile|for\s+update|lock\s+in|sleep|benchmark|load_file|get_lock|information_schema|performance_schema|mysql|sys)\b/i;
const MAX_ROWS = 500;

export interface QueryResult {
  statementType: 'SELECT';
  tables: string[];
  columns: string[];
  rows: Record<string, string | number | null>[];
  truncated: boolean;
}

export class QueryService {
  constructor(private readonly pool: Pool) {}

  /** Refuses anything but one SELECT over curated tables, naming what's wrong. */
  private async check(input: string) {
    const sql = input.trim().replace(/;\s*$/, '');
    const refuse = (message: string) => new CoreError('INVALID', message);
    if (!sql) throw refuse('Write a query first.');
    if (sql.length > 4000) throw refuse('That query is too long.');
    if (!/^(select|with)\b/i.test(sql)) throw refuse('Only SELECT queries can run here. Anything else needs an approval and isn’t available.');
    if (sql.includes(';')) throw refuse('Run one statement at a time.');
    if (/--|\/\*|#/.test(sql)) throw refuse('Remove the comments and run it again.');
    if (FORBIDDEN.test(sql)) throw refuse('That query uses something that isn’t allowed here.');
    if (SENSITIVE.test(sql)) throw refuse('That column holds personal data, so it can’t be queried here.');
    if (/\bselect\s+(distinct\s+)?\*|\.\*/i.test(sql)) throw refuse('Name the columns you need instead of using *.');
    // Names are checked across the whole statement, strings included: stripping strings here would let
    // an escaped quote hide a table. A false refusal is the cheaper mistake.
    const words = new Set(sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
    const schemas = await rows<{ s: string }>(this.pool, 'SELECT schema_name AS s FROM information_schema.schemata');
    if (schemas.some((x) => words.has(x.s.toLowerCase()))) throw refuse('Queries read this institution’s curated tables. Remove the database name.');
    const known = await rows<{ t: string }>(this.pool, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
    const used = known.map((k) => k.t.toLowerCase()).filter((t) => words.has(t));
    const blocked = used.filter((t) => !CURATED.test(t));
    if (blocked.length) throw refuse(`You can’t query ${blocked.join(', ')} here. Queries read curated tables.`);
    return { sql, tables: used };
  }

  async run(input: string): Promise<QueryResult> {
    const { sql, tables } = await this.check(input);
    let found: Record<string, unknown>[];
    try {
      found = await rows<Record<string, unknown>>(this.pool, `SELECT /*+ MAX_EXECUTION_TIME(8000) */ * FROM (${sql}) AS q LIMIT ${MAX_ROWS + 1}`);
    } catch (e) {
      throw new CoreError('INVALID', `MySQL refused that query: ${(e as Error).message.slice(0, 200)}`);
    }
    const value = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : String(v));
    const shown = found.slice(0, MAX_ROWS).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, value(v)])));
    return { statementType: 'SELECT', tables, columns: Object.keys(found[0] ?? {}), rows: shown, truncated: found.length > MAX_ROWS };
  }
}
