// Off-core loans (spec 8.21 Integrations > Files): loans the institution holds that its core doesn't
// carry, from a servicer's monthly spreadsheet. DI matches the file's columns to its loan fields,
// maps each loan type to one of the institution's categories, checks every row, and says what will
// load and what won't. On approval the load replaces that spreadsheet's previous month in cdm_loan,
// tagged with its source, so every loan figure includes it and can be split by source.
// - The core's own rows (no source) are never touched; the publish step runs on an account that can
//   only add and remove loan rows, and it only removes rows with this feed's source.
// - Borrower names stay out: off-core loans have no member record in DI.
// - Month-end history isn't rewritten. Comparisons against last month-end are made on core loans.
import type { Pool } from '@dinext/tenant-db';
import { convert, type Cell, type Sheet } from './ingest.ts';
import { CoreError } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const normal = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** Off-core loans are numbered from here, well clear of the core's loan numbers. */
export const OFFCORE_LOAN_BASE = 900_000_000;
export const OFFCORE_PREFIX = 'Off-core: ';

export type OffcoreField = 'ref' | 'balance' | 'type' | 'rate' | 'dpd' | 'original' | 'open' | 'maturity' | 'score' | 'ltv' | 'rating' | 'branch' | 'asOf' | 'servicer' | 'borrower';

/** DI's loan fields, the headers servicers use for them, and which a load can't do without. */
export const OFFCORE_FIELDS: { field: OffcoreField; label: string; required: boolean; headers: string[] }[] = [
  { field: 'ref', label: 'Loan number', required: true, headers: ['loan number', 'loan id', 'loan no', 'loan', 'account number', 'account', 'note number', 'loan account'] },
  { field: 'balance', label: 'Balance', required: true, headers: ['current balance', 'principal balance', 'outstanding balance', 'balance', 'upb', 'unpaid principal balance', 'participation balance', 'current principal'] },
  { field: 'type', label: 'Loan type', required: true, headers: ['loan type', 'type', 'product', 'product type', 'collateral type', 'loan product'] },
  { field: 'rate', label: 'Rate', required: true, headers: ['interest rate', 'rate', 'note rate', 'coupon', 'current rate'] },
  { field: 'dpd', label: 'Days past due', required: false, headers: ['days past due', 'days delinquent', 'dpd', 'days late', 'past due days'] },
  { field: 'original', label: 'Original amount', required: false, headers: ['original balance', 'original amount', 'orig balance', 'original principal', 'commitment', 'note amount'] },
  { field: 'open', label: 'Opened', required: false, headers: ['origination date', 'open date', 'note date', 'funded date', 'opened', 'booking date'] },
  { field: 'maturity', label: 'Matures', required: false, headers: ['maturity date', 'maturity', 'matures'] },
  { field: 'score', label: 'Credit score', required: false, headers: ['fico', 'credit score', 'fico score', 'score'] },
  { field: 'ltv', label: 'Loan-to-value', required: false, headers: ['ltv', 'loan to value', 'ltv ratio'] },
  { field: 'rating', label: 'Risk rating', required: false, headers: ['risk grade', 'risk rating', 'grade', 'rating'] },
  { field: 'branch', label: 'Branch', required: false, headers: ['branch', 'booking branch', 'office', 'location'] },
  { field: 'asOf', label: 'As of', required: false, headers: ['as of date', 'as of', 'report date', 'statement date'] },
  { field: 'servicer', label: 'Servicer', required: false, headers: ['servicer', 'lead lender', 'seller', 'servicing institution'] },
  { field: 'borrower', label: 'Borrower', required: false, headers: ['borrower', 'borrower name', 'customer', 'member', 'name', 'obligor'] },
];

/** Loan types to the institution's categories, most specific first. Indirect pools stay marked indirect. */
const TYPE_RULES: { test: RegExp; credit_union: string; bank: string; indirect?: boolean }[] = [
  { test: /\bcre\b|commercial real estate|\binvestor real estate|\bmulti ?family\b/i, credit_union: 'Business', bank: 'Commercial Real Estate' },
  { test: /commercial|business|\bc ?& ?i\b|agricultur|\bag\b|\bsba\b|equipment/i, credit_union: 'Business', bank: 'Commercial & Industrial' },
  { test: /\bauto\b|vehicle|\brv\b|boat|motorcycle|powersport/i, credit_union: 'Auto', bank: 'Auto', indirect: true },
  { test: /heloc|home equity/i, credit_union: 'HELOC', bank: 'Mortgage' },
  { test: /mortgage|residential|1 ?- ?4 family|first lien/i, credit_union: 'Mortgage', bank: 'Mortgage' },
  { test: /credit card|\bcard\b/i, credit_union: 'Credit Card', bank: 'Consumer' },
  { test: /solar|student|personal|consumer|unsecured|point of sale|\bpos\b|home improvement|medical/i, credit_union: 'Personal', bank: 'Consumer' },
];

export interface ColumnMatch {
  field: OffcoreField;
  label: string;
  header: string | null;
  index: number;
  how: 'exact' | 'close' | 'missing';
}

export interface OffcoreRow {
  ref: string;
  servicerType: string;
  category: string;
  indirect: boolean;
  branchId: number;
  balance: number;
  original: number;
  rate: number;
  dpd: number;
  open: string;
  term: number | null;
  score: number | null;
  ltv: number | null;
  rating: number | null;
}

export interface OffcorePlan {
  file: string;
  feed: string;
  source: string;
  servicer: string | null;
  asOf: string;
  columns: ColumnMatch[];
  ignored: { header: string; why: string }[];
  types: { type: string; category: string; indirect: boolean; loans: number; balance: number; how: 'rule' | 'said' }[];
  unknownTypes: string[];
  rows: OffcoreRow[];
  skipped: { ref: string; line: number; why: string }[];
  warnings: string[];
  blockers: string[];
  balance: number;
  delinquent60: number;
  byCategory: { category: string; loans: number; balance: number }[];
  previous: { asOf: string; loans: number; balance: number; added: number; gone: number } | null;
  categories: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const monthsBetween = (a: string, b: string) => {
  const [ay, am] = a.split('-').map(Number) as [number, number];
  const [by, bm] = b.split('-').map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

/** "Atlantic Community Bank, SunPath Lending and Campus Partners", or a count when the names don't fit. */
function servicerList(names: string[]) {
  if (!names.length) return null;
  const listed = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return listed.length <= 80 ? listed : `${names.length} servicers`;
}

/** The spreadsheet's name without its month: "Participations and purchased loans". */
export function feedNameFrom(file: string) {
  const base = file.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ');
  const cleaned = base
    .replace(new RegExp(`\\b(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\b\\.?`, 'gi'), ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b\d{4}[-_]\d{2}([-_]\d{2})?\b/g, ' ')
    .replace(/\s*[-–]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return (cleaned || base).slice(0, 60);
}

/** The month a file name speaks of, as its month-end: "October 2026" → 2026-10-31. */
export function monthFromName(file: string): string | null {
  const m = new RegExp(`\\b(${MONTHS.join('|')})\\b[\\s_-]*((?:19|20)\\d{2})`, 'i').exec(file);
  if (m) return monthEnd(Number(m[2]), MONTHS.indexOf(m[1]!.toLowerCase()) + 1);
  const d = /(?<!\d)((?:19|20)\d{2})[-_](\d{2})(?!\d)/.exec(file);
  return d ? monthEnd(Number(d[1]), Number(d[2])) : null;
}

/** Which column holds each of DI's fields, by its header. */
export function matchColumns(headers: string[]): { columns: ColumnMatch[]; ignored: { header: string; why: string }[] } {
  const taken = new Set<number>();
  const normals = headers.map(normal);
  const columns = OFFCORE_FIELDS.map((f) => {
    let index = normals.findIndex((h, i) => !taken.has(i) && f.headers.includes(h));
    let how: ColumnMatch['how'] = 'exact';
    if (index < 0) {
      index = normals.findIndex((h, i) => !taken.has(i) && f.headers.some((x) => x.length > 3 && (h.includes(x) || (h.length > 3 && x.includes(h)))));
      how = 'close';
    }
    if (index < 0) return { field: f.field, label: f.label, header: null, index: -1, how: 'missing' as const };
    taken.add(index);
    return { field: f.field, label: f.label, header: headers[index]!, index, how };
  });
  const ignored = headers.map((h, i) => ({ h, i })).filter(({ i }) => !taken.has(i)).map(({ h }) => ({ header: h, why: 'No DI loan field matches it' }));
  const borrower = columns.find((c) => c.field === 'borrower' && c.header);
  if (borrower) ignored.unshift({ header: borrower.header!, why: 'Not loaded: off-core loans have no member record in DI, so names stay out' });
  return { columns: columns.filter((c) => c.field !== 'borrower'), ignored };
}

/** A servicer's loan type as one of the institution's categories, or null when DI can't tell. */
export function categoryFor(type: string, institution: 'credit_union' | 'bank', categories: string[], said: Record<string, string> = {}): { category: string; indirect: boolean; how: 'rule' | 'said' } | null {
  const told = Object.entries(said).find(([k]) => normal(k) === normal(type));
  if (told) {
    const cat = categories.find((c) => normal(c) === normal(told[1]));
    if (cat) return { category: cat, indirect: /indirect|pool|dealer/i.test(type) && cat === 'Auto', how: 'said' };
  }
  const exact = categories.find((c) => normal(c) === normal(type));
  if (exact) return { category: exact, indirect: false, how: 'rule' };
  const rule = TYPE_RULES.find((r) => r.test.test(type));
  if (!rule) return null;
  const category = rule[institution];
  if (!categories.includes(category)) return null;
  return { category, indirect: Boolean(rule.indirect) && /indirect|pool|dealer/i.test(type), how: 'rule' };
}

export class OffcoreService {
  constructor(
    private readonly pool: Pool,
    private readonly institution: 'credit_union' | 'bank',
    /** The publish step's connection, on the account that can only add and remove loan rows. */
    private readonly buildPool: () => Pool,
    private readonly fallbackAsOf: string,
  ) {}

  private async branches() {
    return rows<{ int_id: number; name: string }>(this.pool, 'SELECT int_id, name FROM cdm_location ORDER BY int_id');
  }

  async categories() {
    return (await rows<{ c: string }>(this.pool, 'SELECT DISTINCT loan_category AS c FROM cdm_loan WHERE source IS NULL ORDER BY 1')).map((r) => r.c);
  }

  async feed(source: string) {
    const [f] = await rows<{ feed_id: number; name: string; source: string }>(this.pool, 'SELECT feed_id, name, source FROM ofc_feed WHERE source = ?', [source]);
    return f ?? null;
  }

  /** What a file would load as off-core loans, and what wouldn't load and why. Changes nothing. */
  async prepare(file: string, sheet: Sheet, said: { types?: Record<string, string>; feed?: string } = {}): Promise<OffcorePlan> {
    const { columns, ignored } = matchColumns(sheet.headers);
    const col = (f: OffcoreField) => columns.find((c) => c.field === f)!;
    const blockers: string[] = [];
    const warnings: string[] = [];
    const missing = columns.filter((c) => OFFCORE_FIELDS.find((f) => f.field === c.field)!.required && c.how === 'missing');
    if (missing.length) blockers.push(`I can’t find ${missing.map((c) => `a ${c.label.toLowerCase()}`).join(', ')} column. The headers are: ${sheet.headers.join(', ')}. Say which column holds it, or ask the servicer for a file that has it.`);
    if (!sheet.rows.length) blockers.push('The file has no data rows.');
    const categories = await this.categories();
    const branches = await this.branches();
    const main = branches[0]!;
    const feed = (said.feed ?? feedNameFrom(file)).trim();
    const source = `${OFFCORE_PREFIX}${feed}`.slice(0, 80);
    const cell = (r: Cell[], f: OffcoreField) => (col(f).index < 0 ? null : (r[col(f).index] ?? null));
    const text = (r: Cell[], f: OffcoreField) => {
      const v = cell(r, f);
      return v === null ? '' : String(v).trim();
    };
    const num = (r: Cell[], f: OffcoreField) => convert(cell(r, f), 'number') as number | null;
    const date = (r: Cell[], f: OffcoreField) => convert(cell(r, f), 'date') as string | null;

    const asOfs = sheet.rows.map((r) => date(r, 'asOf')).filter((d): d is string => Boolean(d)).sort();
    const asOf = asOfs.at(-1) ?? monthFromName(file) ?? this.fallbackAsOf;
    const servicers = [...new Set(sheet.rows.map((r) => text(r, 'servicer')).filter(Boolean))];

    // Loan types first: one DI can't place stops the load, so nothing lands in the wrong category.
    const typeNames = [...new Set(sheet.rows.map((r) => text(r, 'type')).filter(Boolean))];
    const typeMap = new Map(typeNames.map((t) => [t, categoryFor(t, this.institution, categories, said.types)]));
    const unknownTypes = typeNames.filter((t) => !typeMap.get(t));
    if (unknownTypes.length && !missing.length) blockers.push(`I can’t tell which of your loan categories ${unknownTypes.map((t) => `“${t}”`).join(', ')} ${unknownTypes.length === 1 ? 'is' : 'are'}. Your categories are ${categories.join(', ')}. Say, for example, “treat ${unknownTypes[0]} as ${categories[0]}”.`);

    const out: OffcoreRow[] = [];
    const skipped: OffcorePlan['skipped'] = [];
    const seen = new Map<string, string>();
    let noDpd = 0;
    let noOpen = 0;
    let lateBeyondAge = 0;
    let fractionRates = 0;
    const branchMisses = new Set<string>();
    if (!missing.length)
      sheet.rows.forEach((r, i) => {
        const line = i + 2;
        const ref = text(r, 'ref');
        if (!ref) return void skipped.push({ ref: '—', line, why: 'No loan number' });
        const key = JSON.stringify(r);
        if (seen.has(ref)) return void skipped.push({ ref, line, why: seen.get(ref) === key ? 'The same row appears twice; loaded once' : 'The loan number appears twice with different values; kept the first' });
        seen.set(ref, key);
        const balance = num(r, 'balance');
        if (balance === null) return void skipped.push({ ref, line, why: 'No balance' });
        if (balance <= 0) return void skipped.push({ ref, line, why: 'Balance is zero or less: paid off or sold' });
        let rate = num(r, 'rate');
        if (rate === null) return void skipped.push({ ref, line, why: 'No interest rate' });
        if (rate > 0 && rate < 1) {
          rate *= 100;
          fractionRates++;
        }
        if (rate < 0 || rate > 30) return void skipped.push({ ref, line, why: `Rate ${rate}% is outside 0 to 30%` });
        const type = text(r, 'type');
        const mapped = type ? typeMap.get(type) : null;
        if (!mapped) return void skipped.push({ ref, line, why: type ? `Loan type “${type}” isn’t placed yet` : 'No loan type' });
        let dpd = num(r, 'dpd');
        if (dpd === null) {
          noDpd++;
          dpd = 0;
        }
        let open = date(r, 'open');
        if (!open) {
          noOpen++;
          open = asOf;
        }
        if (dpd > Math.max(0, daysBetween(open, asOf))) lateBeyondAge++;
        const maturity = date(r, 'maturity');
        const term = maturity ? Math.max(1, monthsBetween(open, maturity)) : null;
        const bName = text(r, 'branch');
        const b = bName ? branches.find((x) => normal(x.name) === normal(bName) || normal(bName).includes(normal(x.name))) : null;
        if (bName && !b) branchMisses.add(bName);
        const score = num(r, 'score');
        const ltv = num(r, 'ltv');
        const rating = num(r, 'rating');
        out.push({
          ref: ref.slice(0, 40),
          servicerType: type.slice(0, 60),
          category: mapped.category,
          indirect: mapped.indirect,
          branchId: (b ?? main).int_id,
          balance: round2(balance),
          original: round2(Math.max(balance, num(r, 'original') ?? balance)),
          rate: Math.round(rate * 1000) / 1000,
          dpd: Math.max(0, Math.round(dpd)),
          open,
          term,
          score: score !== null && score >= 300 && score <= 850 ? Math.round(score) : null,
          ltv: ltv !== null && ltv > 0 && ltv <= 200 ? round2(ltv) : null,
          rating: rating !== null && rating >= 1 && rating <= 9 ? Math.round(rating) : null,
        });
      });
    if (noDpd) warnings.push(`${noDpd} ${noDpd === 1 ? 'loan has' : 'loans have'} no days past due; DI counts ${noDpd === 1 ? 'it' : 'them'} as current.`);
    if (noOpen) warnings.push(`${noOpen} ${noOpen === 1 ? 'loan has' : 'loans have'} no origination date; DI dates ${noOpen === 1 ? 'it' : 'them'} to the file’s as-of date.`);
    if (lateBeyondAge) warnings.push(`${lateBeyondAge} ${lateBeyondAge === 1 ? 'loan is' : 'loans are'} more days past due than ${lateBeyondAge === 1 ? 'it is' : 'they are'} old. Ask the servicer to check ${lateBeyondAge === 1 ? 'it' : 'them'}.`);
    if (fractionRates) warnings.push(`${fractionRates} ${fractionRates === 1 ? 'rate was' : 'rates were'} written as a fraction (0.065) and ${fractionRates === 1 ? 'was' : 'were'} read as a percent (6.5%).`);
    if (branchMisses.size) warnings.push(`${[...branchMisses].map((x) => `“${x}”`).join(', ')} ${branchMisses.size === 1 ? 'isn’t one of your branches' : 'aren’t your branches'}; those loans are booked at ${main.name}.`);
    if (!col('branch').header && out.length) warnings.push(`The file has no branch column; every loan is booked at ${main.name}.`);
    if (!out.length && !blockers.length) blockers.push('No row in the file can load: every one has a problem.');

    const byCat = new Map<string, { loans: number; balance: number }>();
    for (const r of out) {
      const x = byCat.get(r.category) ?? { loans: 0, balance: 0 };
      x.loans++;
      x.balance += r.balance;
      byCat.set(r.category, x);
    }
    const types = typeNames.map((t) => {
      const m = typeMap.get(t);
      const these = out.filter((r) => r.servicerType === t);
      return { type: t, category: m?.category ?? '—', indirect: m?.indirect ?? false, loans: these.length, balance: round2(these.reduce((s, r) => s + r.balance, 0)), how: m?.how ?? ('rule' as const) };
    });

    // Against last month's load of the same spreadsheet: what's new and what's gone.
    const f = await this.feed(source);
    let previous: OffcorePlan['previous'] = null;
    if (f) {
      const [last] = await rows<{ load_id: number; as_of: string; row_count: number; balance: number }>(this.pool, 'SELECT load_id, as_of, row_count, balance FROM ofc_load WHERE feed_id = ? ORDER BY load_id DESC LIMIT 1', [f.feed_id]);
      if (last) {
        const refs = new Set((await rows<{ external_ref: string }>(this.pool, 'SELECT external_ref FROM ofc_loan WHERE load_id = ?', [last.load_id])).map((x) => x.external_ref));
        const now = new Set(out.map((r) => r.ref));
        previous = { asOf: String(last.as_of).slice(0, 10), loans: last.row_count, balance: Number(last.balance), added: [...now].filter((r) => !refs.has(r)).length, gone: [...refs].filter((r) => !now.has(r)).length };
      }
    }
    return {
      file,
      feed,
      source,
      servicer: servicerList(servicers),
      asOf,
      columns,
      ignored,
      types,
      unknownTypes,
      rows: out,
      skipped,
      warnings,
      blockers,
      balance: round2(out.reduce((s, r) => s + r.balance, 0)),
      delinquent60: round2(out.filter((r) => r.dpd >= 60).reduce((s, r) => s + r.balance, 0)),
      byCategory: [...byCat.entries()].map(([category, x]) => ({ category, loans: x.loans, balance: round2(x.balance) })).sort((a, b) => b.balance - a.balance),
      previous,
      categories,
    };
  }

  /**
   * Publishes an approved plan: records the load, then replaces this spreadsheet's rows in cdm_loan.
   * Each loan keeps its DI number from month to month. The core's rows are never touched.
   */
  async publish(p: Pick<OffcorePlan, 'file' | 'feed' | 'source' | 'servicer' | 'asOf' | 'rows' | 'skipped' | 'balance' | 'delinquent60' | 'columns'>, owner: { userId: string; name: string }, meta: { approvalId: string }) {
    if (!p.source.startsWith(OFFCORE_PREFIX)) throw new CoreError('INVALID', 'Off-core loans need an off-core source.');
    let f = await this.feed(p.source);
    const mapping = JSON.stringify(p.columns.filter((c) => c.header).map((c) => ({ field: c.field, header: c.header })));
    if (!f) {
      await this.pool.query('INSERT INTO ofc_feed (name, source, servicer, mapping, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [p.feed.slice(0, 80), p.source, p.servicer, mapping, owner.userId, owner.name, nowSql()]);
      f = (await this.feed(p.source))!;
    } else await this.pool.query('UPDATE ofc_feed SET mapping = ?, servicer = ? WHERE feed_id = ?', [mapping, p.servicer, f.feed_id]);
    // Loan numbers stay the same month to month; a new loan takes the next free one in this feed's range.
    const known = new Map((await rows<{ external_ref: string; loan_id: number }>(this.pool, 'SELECT o.external_ref, MAX(o.loan_id) AS loan_id FROM ofc_loan o JOIN ofc_load l ON l.load_id = o.load_id WHERE l.feed_id = ? GROUP BY o.external_ref', [f.feed_id])).map((x) => [x.external_ref, Number(x.loan_id)]));
    const base = OFFCORE_LOAN_BASE + f.feed_id * 100_000;
    let next = Math.max(base, ...known.values()) + 1;
    const ids = p.rows.map((r) => known.get(r.ref) ?? next++);
    if (next - base >= 100_000) throw new CoreError('INVALID', 'This spreadsheet has more loans than DI numbers a single source for.');
    const [l] = (await this.pool.query('INSERT INTO ofc_load (feed_id, file_name, as_of, row_count, skipped, balance, delinquent_60_balance, approval_id, loaded_by, loaded_by_name, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [f.feed_id, p.file.slice(0, 160), p.asOf, p.rows.length, p.skipped.length, p.balance, p.delinquent60, meta.approvalId, owner.userId, owner.name, nowSql()])) as unknown as [{ insertId: number }];
    if (p.rows.length) await this.pool.query('INSERT INTO ofc_loan (load_id, external_ref, loan_id, servicer_type, loan_category, is_indirect, branch_id, balance, original_amount, rate, days_delinquent, open_date, term_months, credit_score, ltv, risk_rating) VALUES ?', [p.rows.map((r, i) => [l.insertId, r.ref, ids[i], r.servicerType, r.category, r.indirect ? 1 : 0, r.branchId, r.balance, r.original, r.rate, r.dpd, r.open, r.term, r.score, r.ltv, r.rating])]);
    // The publish step: this source's rows replace last month's, in one transaction.
    const conn = await this.buildPool().getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM cdm_loan WHERE source = ?', [p.source]);
      if (p.rows.length)
        await conn.query('INSERT INTO cdm_loan (loan_id, party_id, branch_id, officer_id, loan_category, is_indirect, open_date, close_date, charge_off_date, original_amount, balance, rate, days_delinquent, credit_score, ltv, term_months, risk_rating, source) VALUES ?', [
          p.rows.map((r, i) => [ids[i], 0, r.branchId, 0, r.category, r.indirect ? 1 : 0, r.open, null, null, r.original, r.balance, r.rate, r.dpd, r.score, r.ltv, r.term, r.rating, p.source]),
        ]);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    return { loadId: l.insertId, feedId: f.feed_id, loans: p.rows.length, balance: p.balance, source: p.source };
  }

  /** Each off-core spreadsheet, its latest load, and what's in DI's loans from it now. */
  async feeds() {
    const list = await rows<Record<string, unknown>>(
      this.pool,
      `SELECT f.feed_id, f.name, f.source, f.servicer, l.file_name, l.as_of, l.row_count, l.skipped, l.balance, l.delinquent_60_balance, l.loaded_by_name, l.loaded_at,
              (SELECT COUNT(*) FROM cdm_loan c WHERE c.source = f.source) AS in_di, (SELECT COALESCE(SUM(balance), 0) FROM cdm_loan c WHERE c.source = f.source) AS in_di_balance
         FROM ofc_feed f LEFT JOIN ofc_load l ON l.load_id = (SELECT MAX(load_id) FROM ofc_load WHERE feed_id = f.feed_id) ORDER BY f.feed_id`,
    );
    return list.map((f) => ({ feedId: Number(f.feed_id), name: String(f.name), source: String(f.source), servicer: (f.servicer as string | null) ?? null, file: (f.file_name as string | null) ?? null, asOf: f.as_of ? String(f.as_of).slice(0, 10) : null, loans: Number(f.in_di), balance: Number(f.in_di_balance), skipped: Number(f.skipped ?? 0), delinquent60: Number(f.delinquent_60_balance ?? 0), loadedBy: (f.loaded_by_name as string | null) ?? null, loadedAt: f.loaded_at ? String(f.loaded_at).replace(' ', 'T').slice(0, 19) : null }));
  }

  /** Loans by source, core first, with their share of the total and their 60+ delinquency. */
  async bySource() {
    return (
      await rows<{ source: string; loans: number; balance: number; dq: number }>(
        this.pool,
        `SELECT src AS source, COUNT(*) AS loans, SUM(balance) AS balance, SUM(CASE WHEN days_delinquent >= 60 THEN balance ELSE 0 END) AS dq
           FROM (SELECT COALESCE(source, 'Core') AS src, balance, days_delinquent FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL) x
          GROUP BY src ORDER BY src = 'Core' DESC, src`,
      )
    ).map((r) => ({ source: r.source, loans: Number(r.loans), balance: Number(r.balance), delinquent60: Number(r.dq) }));
  }
}
