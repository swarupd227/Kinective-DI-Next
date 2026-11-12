// The monthly portfolio stock reports DI's Business Intelligence folder carries: member growth (new,
// closed and net month, quarter and year to date, average age), the certificate maturity forecast (what
// matures when, by term, and the portfolio a year out at a renewal rate), deposit growth by product
// (balances and accounts against month, quarter and year start), and delinquency by product with counts
// and dollars in each bucket and the bucket mix over time. Limited to the user's purview.
import type { Pool } from '@dinext/tenant-db';
import { DQ_BUCKETS } from './delinquency.ts';
import { CoreError, type CoreContext } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const num = (v: unknown) => Number(v ?? 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
const DAY = 86_400_000;
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

/** Certificates that mature and roll into a new certificate [Assumption: 70%, as the liquidity view uses]. */
export const CD_RENEWAL = 0.7;
export const CD_INTERVALS = [
  { label: '0 to 30 days', from: 0, to: 30 },
  { label: '31 to 60 days', from: 31, to: 60 },
  { label: '61 to 90 days', from: 61, to: 90 },
  { label: '3 to 6 months', from: 91, to: 182 },
  { label: '6 to 12 months', from: 183, to: 365 },
  { label: '12 to 18 months', from: 366, to: 547 },
  { label: '18 to 36 months', from: 548, to: 1095 },
  { label: 'Over 36 months', from: 1096, to: 100_000 },
] as const;

export class PortfolioService {
  constructor(private readonly pool: Pool) {}

  /**
   * One node of the org hierarchy (ESP's empsortdata tree) and each unit under it: branches beneath,
   * people, deposits and loans, rolled up from the branches. The institution when no unit is named.
   */
  async orgRollup(unit?: string, ctx: CoreContext = {}) {
    const units = await (this.pool.query('SELECT unit_id, name, level, parent_id, branch_id FROM cdm_org_unit') as Promise<[{ unit_id: number; name: string; level: string; parent_id: number | null; branch_id: number | null }[], unknown]>).then((r) => r[0]).catch(() => null);
    if (units === null || !units.length) return null;
    const node = unit ? units.find((u) => u.name.toLowerCase() === unit.toLowerCase()) ?? units.find((u) => u.name.toLowerCase().includes(unit.toLowerCase())) : units.find((u) => u.parent_id === null);
    if (!node) throw new CoreError('NOT_FOUND', `There’s no unit called “${unit}” in the org hierarchy. Units: ${units.filter((u) => u.level !== 'Branch').map((u) => u.name).join(', ')}.`);
    const under = (id: number): number[] => {
      const kids = units.filter((u) => u.parent_id === id);
      return kids.length ? kids.flatMap((k) => (k.branch_id !== null ? [k.branch_id] : under(k.unit_id))) : [];
    };
    const [rows] = (await this.pool.query(
      `SELECT b.int_id AS id, b.name, (SELECT COUNT(*) FROM cdm_party p WHERE p.primary_branch_id = b.int_id) AS people,
              (SELECT COALESCE(SUM(balance), 0) FROM cdm_deposit_account d WHERE d.branch_id = b.int_id AND d.close_date IS NULL) AS deposits,
              (SELECT COALESCE(SUM(balance), 0) FROM cdm_loan l WHERE l.branch_id = b.int_id AND l.close_date IS NULL AND l.charge_off_date IS NULL) AS loans
         FROM cdm_location b`,
    )) as unknown as [{ id: number; name: string; people: number; deposits: unknown; loans: unknown }[]];
    const seen = ctx.purviewBranches ? rows.filter((r) => ctx.purviewBranches!.includes(r.name)) : rows;
    const sum = (ids: number[]) => {
      const mine = seen.filter((r) => ids.includes(r.id));
      return { branches: mine.length, people: mine.reduce((s, r) => s + Number(r.people), 0), deposits: Math.round(mine.reduce((s, r) => s + Number(r.deposits), 0)), loans: Math.round(mine.reduce((s, r) => s + Number(r.loans), 0)) };
    };
    const children = units.filter((u) => u.parent_id === node.unit_id).map((u) => ({ name: u.name, level: u.level, ...sum(u.branch_id !== null ? [u.branch_id] : under(u.unit_id)) })).filter((c) => c.branches > 0);
    const path: string[] = [];
    for (let p: (typeof units)[number] | undefined = node; p; p = units.find((u) => u.unit_id === p!.parent_id)) path.unshift(p.name);
    return { unit: node.name, level: node.level, path, total: sum(node.branch_id !== null ? [node.branch_id] : under(node.unit_id)), children };
  }

  /**
   * The book by product (ESP's loan and share products): accounts, balances, the balance-weighted rate,
   * and for loans the average term and the share 60+ days past due. Null where products aren't loaded.
   */
  async products(kind: 'loan' | 'deposit', ctx: CoreContext = {}) {
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const params = ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [];
    const sql =
      kind === 'loan'
        ? `SELECT p.product_id, p.name, p.loan_category AS category, p.reg_amount_code AS reg, COUNT(*) AS n, SUM(l.balance) AS bal, SUM(l.balance * l.rate) AS wrate, AVG(l.term_months) AS term, SUM(CASE WHEN l.days_delinquent >= 60 THEN l.balance ELSE 0 END) AS dq
             FROM cdm_account_product ap JOIN cdm_loan_product p ON p.product_id = ap.product_id JOIN cdm_loan l ON l.loan_id = ap.account_id JOIN cdm_location b ON b.int_id = l.branch_id
            WHERE ap.account_kind = 'loan' AND l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0${scope} GROUP BY p.product_id, p.name, p.loan_category, p.reg_amount_code ORDER BY bal DESC`
        : `SELECT p.product_id, p.name, p.deposit_category AS category, NULL AS reg, COUNT(*) AS n, SUM(d.balance) AS bal, SUM(d.balance * d.rate) AS wrate, NULL AS term, 0 AS dq
             FROM cdm_account_product ap JOIN cdm_deposit_product p ON p.product_id = ap.product_id JOIN cdm_deposit_account d ON d.account_id = ap.account_id JOIN cdm_location b ON b.int_id = d.branch_id
            WHERE ap.account_kind = 'deposit' AND d.close_date IS NULL${scope} GROUP BY p.product_id, p.name, p.deposit_category ORDER BY bal DESC`;
    const found = await (this.pool.query(sql, params) as Promise<[Record<string, unknown>[], unknown]>).then((r) => r[0]).catch(() => null);
    if (found === null) return null;
    const total = found.reduce((s, r) => s + Number(r.bal), 0);
    return found.map((r) => {
      const bal = Number(r.bal);
      return { productId: r.product_id as string, name: r.name as string, category: r.category as string, regCode: (r.reg as string | null) ?? null, accounts: Number(r.n), balance: Math.round(bal), sharePct: total ? Math.round((bal / total) * 1000) / 10 : 0, ratePct: bal ? Math.round((Number(r.wrate) / bal) * 100) / 100 : null, termMonths: r.term === null ? null : Math.round(Number(r.term)), dq60Pct: kind === 'loan' && bal ? Math.round((Number(r.dq) / bal) * 1000) / 10 : null };
    });
  }

  private async asOf() {
    const [b] = await rows<{ d: unknown }>(this.pool, "SELECT as_of_date AS d FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
    return day(b!.d);
  }
  private scope(ctx: CoreContext, alias = 'b') {
    return ctx.purviewBranches ? { sql: ` AND ${alias}.name IN (?)`, params: [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] } : { sql: '', params: [] as unknown[] };
  }

  /** Members now, new, closed and net month, quarter and year to date, average age, and the last 13 month-ends. */
  async memberGrowth(ctx: CoreContext) {
    const asOf = await this.asOf();
    const s = this.scope(ctx);
    const y = Number(asOf.slice(0, 4));
    const m = Number(asOf.slice(5, 7));
    const starts = { MTD: `${asOf.slice(0, 7)}-01`, QTD: `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`, YTD: `${y}-01-01` };
    const [now] = await rows<{ n: number; age: unknown }>(this.pool, `SELECT COUNT(*) AS n, AVG(DATEDIFF(?, p.birth_date) / 365.25) AS age FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.is_member = 1${s.sql}`, [asOf, ...s.params]);
    const periods = [];
    for (const [label, from] of Object.entries(starts)) {
      const [joined] = await rows<{ n: number }>(this.pool, `SELECT COUNT(*) AS n FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.is_member = 1 AND p.join_date BETWEEN ? AND ?${s.sql}`, [from, asOf, ...s.params]);
      const [left] = await rows<{ n: number }>(this.pool, `SELECT COUNT(*) AS n FROM cdm_membership_exit x JOIN cdm_location b ON b.int_id = x.branch_id WHERE x.close_date BETWEEN ? AND ?${s.sql}`, [from, asOf, ...s.params]);
      periods.push({ period: label as 'MTD' | 'QTD' | 'YTD', from, joined: num(joined?.n), left: num(left?.n), net: num(joined?.n) - num(left?.n) });
    }
    const hist = await rows<{ me: unknown; n: unknown }>(this.pool, `SELECT h.month_end AS me, SUM(h.member_count) AS n FROM hist_member_month h JOIN cdm_location b ON b.int_id = h.branch_id WHERE 1 = 1${s.sql} GROUP BY h.month_end ORDER BY h.month_end DESC LIMIT 13`, s.params);
    const months = [];
    for (const h of hist.reverse()) {
      const me = day(h.me);
      const first = `${me.slice(0, 7)}-01`;
      const [j] = await rows<{ n: number }>(this.pool, `SELECT COUNT(*) AS n FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.join_date BETWEEN ? AND ?${s.sql}`, [first, me, ...s.params]);
      const [l] = await rows<{ n: number }>(this.pool, `SELECT COUNT(*) AS n FROM cdm_membership_exit x JOIN cdm_location b ON b.int_id = x.branch_id WHERE x.close_date BETWEEN ? AND ?${s.sql}`, [first, me, ...s.params]);
      months.push({ month: me, members: num(h.n), joined: num(j?.n), left: num(l?.n) });
    }
    return { asOf, members: num(now?.n), averageAge: r1(num(now?.age)), periods, months };
  }

  /** Certificates by when they mature and their term, and the portfolio a year out if CD_RENEWAL of them renew. */
  async cdMaturity(ctx: CoreContext) {
    const asOf = await this.asOf();
    const s = this.scope(ctx);
    const cds = await rows<{ balance: unknown; open_date: unknown; maturity_date: unknown }>(this.pool, `SELECT a.balance, a.open_date, a.maturity_date FROM cdm_deposit_account a JOIN cdm_location b ON b.int_id = a.branch_id WHERE a.close_date IS NULL AND a.maturity_date IS NOT NULL AND a.maturity_date >= ?${s.sql}`, [asOf, ...s.params]);
    const termOf = (open: string, mat: string) => {
      const months = Math.round((Date.parse(`${mat}T00:00:00Z`) - Date.parse(`${open}T00:00:00Z`)) / (30.44 * DAY));
      return months <= 7 ? '6 months or less' : months <= 13 ? '12 months' : months <= 19 ? '18 months' : months <= 25 ? '24 months' : months <= 37 ? '36 months' : 'Over 36 months';
    };
    const terms = ['6 months or less', '12 months', '18 months', '24 months', '36 months', 'Over 36 months'];
    const list = cds.map((c) => ({ balance: num(c.balance), days: Math.round((Date.parse(`${day(c.maturity_date)}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY), term: termOf(day(c.open_date), day(c.maturity_date)) }));
    const intervals = CD_INTERVALS.map((iv) => {
      const inIv = list.filter((c) => c.days >= iv.from && c.days <= iv.to);
      return { interval: iv.label, count: inIv.length, balance: Math.round(inIv.reduce((t, c) => t + c.balance, 0)), byTerm: Object.fromEntries(terms.map((tm) => [tm, Math.round(inIv.filter((c) => c.term === tm).reduce((t, c) => t + c.balance, 0))])) };
    });
    const total = list.reduce((t, c) => t + c.balance, 0);
    // A year out: what matures in 12 months renews at CD_RENEWAL; the rest stays.
    const projection = [0, 3, 6, 9, 12].map((months) => {
      const leaving = list.filter((c) => c.days <= months * 30.44).reduce((t, c) => t + c.balance, 0) * (1 - CD_RENEWAL);
      return { month: monthEnd(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) + months), balance: Math.round(total - leaving), count: Math.round(list.length - list.filter((c) => c.days <= months * 30.44).length * (1 - CD_RENEWAL)) };
    });
    return { asOf, count: list.length, balance: Math.round(total), terms, intervals, projection, renewal: CD_RENEWAL };
  }

  /** Deposit balances and accounts by product at the latest month-end, against month, quarter and year start. */
  async depositGrowth(ctx: CoreContext) {
    const s = this.scope(ctx);
    const months = (await rows<{ me: unknown }>(this.pool, 'SELECT DISTINCT month_end AS me FROM hist_deposit_month ORDER BY month_end DESC LIMIT 14')).map((r) => day(r.me));
    const latest = months[0]!;
    const y = Number(latest.slice(0, 4));
    const m = Number(latest.slice(5, 7));
    const marks = { latest, MTD: monthEnd(y, m - 1), QTD: monthEnd(y, Math.floor((m - 1) / 3) * 3), YTD: monthEnd(y, 0) };
    const at = async (me: string) => rows<{ cat: string; bal: unknown; n: unknown }>(this.pool, `SELECT h.deposit_category AS cat, SUM(h.balance) AS bal, SUM(h.account_count) AS n FROM hist_deposit_month h JOIN cdm_location b ON b.int_id = h.branch_id WHERE h.month_end = ?${s.sql} GROUP BY h.deposit_category`, [me, ...s.params]);
    const [now, mtd, qtd, ytd] = await Promise.all([at(marks.latest), at(marks.MTD), at(marks.QTD), at(marks.YTD)]);
    const of = (list: typeof now, cat: string) => list.find((x) => x.cat === cat);
    const rowsOut = now.map((r) => {
      const change = (base: typeof now) => ({ balance: Math.round(num(r.bal) - num(of(base, r.cat)?.bal)), accounts: num(r.n) - num(of(base, r.cat)?.n) });
      return { product: r.cat, balance: Math.round(num(r.bal)), accounts: num(r.n), mtd: change(mtd), qtd: change(qtd), ytd: change(ytd) };
    }).sort((a, b) => b.balance - a.balance);
    const trend = await rows<{ me: unknown; bal: unknown }>(this.pool, `SELECT h.month_end AS me, SUM(h.balance) AS bal FROM hist_deposit_month h JOIN cdm_location b ON b.int_id = h.branch_id WHERE h.month_end IN (?)${s.sql} GROUP BY h.month_end ORDER BY h.month_end`, [months.slice(0, 13), ...s.params]);
    return { marks, rows: rowsOut, trend: trend.map((t) => ({ month: day(t.me), balance: Math.round(num(t.bal)) })) };
  }

  /** Delinquency at the latest month-end by product, count and dollars in each bucket, and the bucket mix over 24 months. */
  async delinquencyByProduct(ctx: CoreContext) {
    const s = this.scope(ctx);
    const [latest] = await rows<{ me: unknown }>(this.pool, 'SELECT MAX(month_end) AS me FROM hist_loan_dq_month');
    const me = day(latest!.me);
    const cells = await rows<{ cat: string; ind: number; bucket: string; bal: unknown; n: unknown }>(this.pool, `SELECT h.loan_category AS cat, h.is_indirect AS ind, h.bucket, SUM(h.balance) AS bal, SUM(h.loan_count) AS n FROM hist_loan_dq_month h JOIN cdm_location b ON b.int_id = h.branch_id WHERE h.month_end = ?${s.sql} GROUP BY h.loan_category, h.is_indirect, h.bucket`, [me, ...s.params]);
    const products = [...new Set(cells.map((c) => `${c.cat}${c.ind ? ' (indirect)' : ''}`))].sort();
    const product = (name: string) => {
      const mine = cells.filter((c) => `${c.cat}${c.ind ? ' (indirect)' : ''}` === name);
      const bucket = (b: string) => ({ count: mine.filter((c) => c.bucket === b).reduce((t, c) => t + num(c.n), 0), balance: Math.round(mine.filter((c) => c.bucket === b).reduce((t, c) => t + num(c.bal), 0)) });
      const total = mine.reduce((t, c) => t + num(c.bal), 0);
      const dq60 = mine.filter((c) => !['Current', '30–59 days'].includes(c.bucket)).reduce((t, c) => t + num(c.bal), 0);
      return { product: name, buckets: Object.fromEntries(DQ_BUCKETS.map((b) => [b, bucket(b)])), balance: Math.round(total), dq60Pct: total ? Math.round((dq60 / total) * 10000) / 100 : 0 };
    };
    const hist = await rows<{ me: unknown; bucket: string; bal: unknown }>(this.pool, `SELECT h.month_end AS me, h.bucket, SUM(h.balance) AS bal FROM hist_loan_dq_month h JOIN cdm_location b ON b.int_id = h.branch_id WHERE h.bucket <> 'Current' AND h.month_end >= DATE_SUB(?, INTERVAL 24 MONTH)${s.sql} GROUP BY h.month_end, h.bucket ORDER BY h.month_end`, [me, ...s.params]);
    const histMonths = [...new Set(hist.map((h) => day(h.me)))];
    return {
      month: me,
      buckets: [...DQ_BUCKETS],
      products: products.map(product).sort((a, b) => b.dq60Pct - a.dq60Pct),
      history: histMonths.map((mm) => ({ month: mm, ...Object.fromEntries(DQ_BUCKETS.slice(1).map((b) => [b, Math.round(hist.filter((h) => day(h.me) === mm && h.bucket === b).reduce((t, h) => t + num(h.bal), 0))])) })),
    };
  }
}

