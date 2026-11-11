// The general ledger: balance sheet and income statement for a month or a day, one company or
// consolidated, with comparison columns; budget against actual by department, cost center or account;
// and the journal entries behind any balance, reconciled from opening to closing. Read-only: the GL is
// the system of record, and DI never posts to it.
import { CONTRA, GL_OPEN_MONTH, type Pool } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const num = (v: unknown) => Number(v ?? 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

export type GlStatementKind = 'BS' | 'IS';
export type GlCompare = 'prior_month' | 'prior_quarter' | 'prior_year_end' | 'none';
export type GlScope = 'consolidated' | number;
export interface GlAccountRow { gl: string; name: string; group: string; type: string; company: number; values: number[] }
export interface GlGroup { group: string; side: string; values: number[]; accounts: GlAccountRow[] }

const SIDES: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };
const monthName = (m: string) => new Date(`${m}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export class GlService {
  constructor(private readonly pool: Pool) {}

  /** The months on file, the open month and its latest day, the companies and the cost centers. */
  async meta() {
    const months = (await rows<{ m: unknown }>(this.pool, 'SELECT DISTINCT month_end AS m FROM gl_balance_month ORDER BY month_end').catch(() => [])).map((r) => day(r.m));
    if (!months.length) throw new CoreError('NOT_FOUND', 'The general ledger isn’t loaded for this institution yet.');
    const latestDay = day((await rows<{ d: unknown }>(this.pool, 'SELECT MAX(day) AS d FROM gl_balance_day'))[0]?.d);
    const companies = (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM gl_company ORDER BY company_id')).map((c) => ({ id: Number(c.company_id), name: c.name as string, kind: c.kind as string }));
    const costCenters = (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM gl_cost_center ORDER BY cost_center')).map((c) => ({ id: c.cost_center as string, name: c.name as string, department: c.department as string }));
    const closed = months.filter((m) => m !== GL_OPEN_MONTH);
    return { months, openMonth: GL_OPEN_MONTH, latestClosed: closed.at(-1)!, latestDay, companies, costCenters };
  }

  private scope(scope: GlScope) {
    return scope === 'consolidated' ? { sql: '', params: [] as unknown[] } : { sql: ' AND b.company_id = ?', params: [scope] };
  }

  /** Account values at each period: balances for the balance sheet, month or year-to-date activity for income. */
  private async values(kind: GlStatementKind, periods: { month?: string; day?: string; ytd?: boolean }[], scope: GlScope) {
    const s = this.scope(scope);
    const accounts = await rows<Record<string, unknown>>(this.pool, `SELECT company_id, gl_number, name, type, grp, sort_order FROM gl_account WHERE statement = ?${scope === 'consolidated' ? '' : ' AND company_id = ?'} ORDER BY sort_order`, [kind, ...(scope === 'consolidated' ? [] : [scope])]);
    const cols: Map<string, number>[] = [];
    for (const p of periods) {
      let found: { company_id: number; gl_number: string; v: unknown }[];
      if (p.day) found = await rows(this.pool, `SELECT b.company_id, b.gl_number, b.balance AS v FROM gl_balance_day b WHERE b.day = ?${s.sql}`, [p.day, ...s.params]);
      else if (kind === 'IS' && p.ytd) found = await rows(this.pool, `SELECT b.company_id, b.gl_number, SUM(b.amount) AS v FROM gl_balance_month b WHERE b.month_end BETWEEN ? AND ?${s.sql} GROUP BY b.company_id, b.gl_number`, [`${p.month!.slice(0, 4)}-01-01`, p.month, ...s.params]);
      else found = await rows(this.pool, `SELECT b.company_id, b.gl_number, SUM(b.amount) AS v FROM gl_balance_month b WHERE b.month_end = ?${s.sql} GROUP BY b.company_id, b.gl_number`, [p.month, ...s.params]);
      cols.push(new Map(found.map((f) => [`${f.company_id}|${f.gl_number}`, num(f.v)])));
    }
    return accounts.map((a) => {
      const contra = a.type === 'asset' && CONTRA.test(String(a.name));
      return { gl: a.gl_number as string, name: a.name as string, group: a.grp as string, type: a.type as string, company: Number(a.company_id), contra, values: cols.map((c) => c.get(`${a.company_id}|${a.gl_number}`) ?? 0) };
    });
  }

  /**
   * One statement with its comparison column(s). Balance sheet: balances at the month end (or a day of
   * the open month). Income statement: the month's activity and year to date. Groups add their accounts;
   * a contra account such as the allowance subtracts.
   */
  async statement(kind: GlStatementKind, o: { month?: string; day?: string; compare?: GlCompare; scope?: GlScope; zeros?: boolean } = {}) {
    const meta = await this.meta();
    const scope = o.scope ?? 'consolidated';
    if (o.day && (o.day > meta.latestDay || o.day < `${meta.openMonth.slice(0, 7)}-01`)) throw new CoreError('INVALID', `Daily balances are kept for the open month, ${monthName(meta.openMonth)}, through ${dayName(meta.latestDay)}.`);
    const month = o.month ?? (o.day ? meta.openMonth : meta.latestClosed);
    if (!meta.months.includes(month)) throw new CoreError('INVALID', `The GL has months from ${monthName(meta.months[0]!)} to ${monthName(meta.openMonth)} (open).`);
    const i = meta.months.indexOf(month);
    const compare = o.compare ?? 'prior_month';
    const back = compare === 'prior_quarter' ? 3 : compare === 'prior_month' ? 1 : 0;
    const prior = compare === 'prior_year_end' ? meta.months.find((m) => m.endsWith('-12-31') && m < month) : back ? meta.months[i - back] : undefined;
    const open = month === meta.openMonth;
    const periods = kind === 'BS'
      ? [{ ...(o.day ? { day: o.day } : { month }), label: o.day ? dayName(o.day) : open ? `${dayName(meta.latestDay)} (month to date)` : monthName(month) }, ...(prior ? [{ month: prior, label: monthName(prior) }] : [])]
      : [{ month, label: open ? `${monthName(month)} to ${dayName(meta.latestDay)}` : `${monthName(month)}` }, ...(prior && compare !== 'prior_year_end' ? [{ month: prior, label: monthName(prior) }] : []), { month, ytd: true, label: `Year to date, ${monthName(month)}` }];
    const accts = (await this.values(kind, periods, scope)).map((a) => ({ ...a, values: a.values.map((v) => (a.contra ? -v : v)) }));
    const shown = o.zeros ? accts : accts.filter((a) => a.values.some((v) => Math.abs(v) >= 0.5));
    const groups: GlGroup[] = [];
    for (const a of shown) {
      let g = groups.find((x) => x.group === a.group && x.side === SIDES[a.type]);
      if (!g) groups.push((g = { group: a.group, side: SIDES[a.type]!, values: periods.map(() => 0), accounts: [] }));
      g.accounts.push(a);
      a.values.forEach((v, k) => (g!.values[k] = r2(g!.values[k]! + v)));
    }
    const side = (s: string) => periods.map((_, k) => r2(groups.filter((g) => g.side === s).reduce((t, g) => t + g.values[k]!, 0)));
    const totals = kind === 'BS'
      ? { assets: side('Assets'), liabilities: side('Liabilities'), equity: side('Equity') }
      : { income: side('Income'), expenses: side('Expenses'), net: periods.map((_, k) => r2(side('Income')[k]! - side('Expenses')[k]!)) };
    const scopeName = scope === 'consolidated' ? `Consolidated (${meta.companies.filter((c) => c.id !== 9).map((c) => c.name).join(' and ')}, with the investment in the subsidiary eliminated)` : meta.companies.find((c) => c.id === scope)?.name ?? `Company ${scope}`;
    return { kind, month, day: o.day ?? null, open, periods: periods.map((p) => p.label), scope: scopeName, groups, totals, hiddenZeros: accts.length - shown.length };
  }

  /** One statement across several months side by side: balances, or each month's activity. */
  async compare(kind: GlStatementKind, months: string[], scope: GlScope = 'consolidated') {
    const meta = await this.meta();
    const bad = months.find((m) => !meta.months.includes(m));
    if (bad) throw new CoreError('INVALID', `There’s no GL month ${bad}.`);
    const accts = (await this.values(kind, months.map((m) => ({ month: m })), scope)).map((a) => ({ ...a, values: a.values.map((v) => (a.contra ? -v : v)) }));
    const byGroup = new Map<string, { group: string; side: string; values: number[] }>();
    for (const a of accts) {
      const key = `${SIDES[a.type]}|${a.group}`;
      const g = byGroup.get(key) ?? byGroup.set(key, { group: a.group, side: SIDES[a.type]!, values: months.map(() => 0) }).get(key)!;
      a.values.forEach((v, k) => (g.values[k] = r2(g.values[k]! + v)));
    }
    return { kind, months, labels: months.map((m) => (m === meta.openMonth ? `${monthName(m)} (to date)` : monthName(m))), groups: [...byGroup.values()] };
  }

  /**
   * Budget against actual for a month (or the year to date), by department, cost center or account.
   * Over budget is unfavorable for an expense and favorable for income.
   */
  async budget(o: { month?: string; ytd?: boolean; by?: 'department' | 'cost_center' | 'account'; department?: string } = {}) {
    const meta = await this.meta();
    const month = o.month ?? meta.latestClosed;
    const from = o.ytd ? `${month.slice(0, 4)}-01-01` : month;
    const by = o.by ?? 'department';
    const dept = o.department ? meta.costCenters.find((c) => c.department.toLowerCase() === o.department!.toLowerCase())?.department ?? null : null;
    if (o.department && !dept) throw new CoreError('INVALID', `Departments are ${[...new Set(meta.costCenters.map((c) => c.department))].join(', ')}.`);
    const key = by === 'department' ? 'cc.department' : by === 'cost_center' ? "CONCAT(cc.cost_center, ' ', cc.name)" : "CONCAT(a.gl_number, ' ', a.name)";
    const where = `x.month_end BETWEEN ? AND ?${dept ? ' AND cc.department = ?' : ''}`;
    const params = [from, month, ...(dept ? [dept] : [])];
    const actual = await rows<{ k: string; type: string; v: unknown }>(this.pool, `SELECT ${key} AS k, a.type, SUM(x.amount) AS v FROM gl_balance_month x JOIN gl_account a ON a.company_id = x.company_id AND a.gl_number = x.gl_number JOIN gl_cost_center cc ON cc.cost_center = x.cost_center WHERE x.company_id = 1 AND a.statement = 'IS' AND ${where} GROUP BY k, a.type`, params);
    const planned = await rows<{ k: string; type: string; v: unknown }>(this.pool, `SELECT ${key} AS k, a.type, SUM(x.amount) AS v FROM gl_budget x JOIN gl_account a ON a.company_id = 1 AND a.gl_number = x.gl_number JOIN gl_cost_center cc ON cc.cost_center = x.cost_center WHERE ${where} GROUP BY k, a.type`, params);
    const keys = [...new Set([...actual, ...planned].map((r) => `${r.type}|${r.k}`))];
    const lines = keys.map((k) => {
      const [type, name] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
      const a = num(actual.find((r) => r.type === type && r.k === name)?.v);
      const b = num(planned.find((r) => r.type === type && r.k === name)?.v);
      const variance = r2(a - b);
      const favorable = type === 'income' ? variance >= 0 : variance <= 0;
      return { name, type: type as 'income' | 'expense', actual: r2(a), budget: r2(b), variance, pct: b ? r2((variance / Math.abs(b)) * 100) : null, favorable };
    }).sort((x, y) => (x.type === y.type ? Math.abs(y.variance) - Math.abs(x.variance) : x.type === 'income' ? -1 : 1));
    const sum = (t: string, f: 'actual' | 'budget') => r2(lines.filter((l) => l.type === t).reduce((s, l) => s + l[f], 0));
    const net = { actual: r2(sum('income', 'actual') - sum('expense', 'actual')), budget: r2(sum('income', 'budget') - sum('expense', 'budget')) };
    return { month, ytd: Boolean(o.ytd), by, department: dept, label: o.ytd ? `Year to date through ${monthName(month)}` : monthName(month), lines, totals: { income: { actual: sum('income', 'actual'), budget: sum('income', 'budget') }, expense: { actual: sum('expense', 'actual'), budget: sum('expense', 'budget') }, net } };
  }

  /** Find an account by number or a word of its name. */
  async account(q: string, company = 1) {
    const found = await rows<Record<string, unknown>>(this.pool, 'SELECT gl_number, name, type, statement FROM gl_account WHERE company_id = ? AND (gl_number = ? OR name LIKE ?) ORDER BY gl_number', [company, q.trim(), `%${q.trim()}%`]);
    if (!found.length) throw new CoreError('NOT_FOUND', `There’s no GL account matching “${q}”.`);
    return found.map((a) => ({ gl: a.gl_number as string, name: a.name as string, type: a.type as string, statement: a.statement as GlStatementKind }));
  }

  /**
   * The journal entries behind an account for a month (September or October to date), optionally one
   * cost center, with the reconciliation: opening balance plus the entries equals the closing balance.
   */
  async journal(gl: string, o: { month?: string; costCenter?: string; company?: number; from?: string; to?: string } = {}) {
    const meta = await this.meta();
    const company = o.company ?? 1;
    const [acct] = await this.account(gl, company);
    const month = o.month ?? meta.latestClosed;
    const i = meta.months.indexOf(month);
    if (i < 0) throw new CoreError('INVALID', `There’s no GL month ${month}.`);
    const lo = o.from ?? `${month.slice(0, 7)}-01`;
    const hi = o.to ?? month;
    const cc = o.costCenter ? ' AND cost_center = ?' : '';
    const entries = (await rows<Record<string, unknown>>(this.pool, `SELECT * FROM gl_journal WHERE company_id = ? AND gl_number = ? AND posted BETWEEN ? AND ?${cc} ORDER BY posted, line_id`, [company, acct!.gl, lo, hi, ...(o.costCenter ? [o.costCenter] : [])])).map((e) => ({ je: e.je_id as string, posted: day(e.posted), costCenter: e.cost_center as string, debit: num(e.debit), credit: num(e.credit), description: e.description as string, source: e.source as string, ticket: e.ticket as string, offset: (e.offset_gl as string | null) ?? null, by: e.posted_by as string }));
    if (!entries.length && !['2026-09-30', meta.openMonth].includes(month)) throw new CoreError('NOT_FOUND', `Journal detail is kept for September and the open month, October. For ${monthName(month)}, DI has the month-end balances only.`);
    const debitNormal = (acct!.type === 'asset' && !CONTRA.test(acct!.name)) || acct!.type === 'expense';
    const net = r2(entries.reduce((s, e) => s + (debitNormal ? e.debit - e.credit : e.credit - e.debit), 0));
    const balance = async (m: string) => num((await rows<{ v: unknown }>(this.pool, `SELECT SUM(amount) AS v FROM gl_balance_month WHERE company_id = ? AND gl_number = ? AND month_end = ?${cc}`, [company, acct!.gl, m, ...(o.costCenter ? [o.costCenter] : [])]))[0]?.v);
    const bs = acct!.statement === 'BS';
    const opening = bs && i > 0 ? await balance(meta.months[i - 1]!) : 0;
    const closing = await balance(month);
    const whole = !o.from && !o.to;
    return { account: acct!, month, open: month === meta.openMonth, entries, opening: r2(opening), net, closing: r2(closing), ties: whole ? Math.abs(r2(opening + net - closing)) < 0.01 : null, debitNormal };
  }
}
