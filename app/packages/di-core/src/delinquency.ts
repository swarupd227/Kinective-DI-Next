// Delinquency in depth: aging buckets, the 30+ and 60+ ratios over time, roll rates (how balances move
// from current to 30, 60, 90 days and charge-off each month), vintage performance, the worst branch and
// product segments, and the largest delinquent loans to work. From the month-end delinquency history
// and the open loans, under the viewer's purview; 60+ ties to the delinquency figures everywhere else.
import type { Pool } from '@dinext/tenant-db';
import { memberNumber } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);

export const DQ_BUCKETS = ['Current', '30–59 days', '60–89 days', '90–179 days', '180–359 days', '360+ days'] as const;
const OPEN = [...DQ_BUCKETS];
const DELINQUENT_30 = DQ_BUCKETS.slice(1);
const DELINQUENT_60 = DQ_BUCKETS.slice(2);
export const CHARGED_OFF = 'Charged off';
const label = (end: string) => new Date(`${end}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export interface DqScope {
  purviewBranches?: string[];
}

export class DelinquencyService {
  constructor(private readonly pool: Pool) {}

  /** Branch ids the viewer may see, or null for the whole institution. */
  private async branchIds(scope: DqScope) {
    if (!scope.purviewBranches) return null;
    const found = await rows<{ int_id: number }>(this.pool, 'SELECT int_id FROM cdm_location WHERE name IN (?)', [scope.purviewBranches.length ? scope.purviewBranches : ['']]);
    return found.map((r) => r.int_id);
  }

  private async where(scope: DqScope, alias: string) {
    const ids = await this.branchIds(scope);
    return ids ? { sql: ` AND ${alias}.branch_id IN (${ids.length ? ids.join(',') : '0'})`, ids } : { sql: '', ids };
  }

  async months(n = 13) {
    return (await rows<{ m: unknown }>(this.pool, 'SELECT DISTINCT month_end AS m FROM hist_loan_dq_month ORDER BY month_end DESC LIMIT ?', [n])).map((r) => day(r.m)).reverse();
  }

  /** The latest month-end by bucket, and by loan category within each bucket. */
  async aging(scope: DqScope = {}) {
    const w = await this.where(scope, 'q');
    const [latest] = (await this.months(1)) as [string];
    const data = await rows<{ c: string; b: string; bal: number; n: number }>(this.pool, `SELECT q.loan_category AS c, q.bucket AS b, SUM(q.balance) AS bal, SUM(q.loan_count) AS n FROM hist_loan_dq_month q WHERE q.month_end = ? AND q.bucket <> ?${w.sql} GROUP BY q.loan_category, q.bucket`, [latest, CHARGED_OFF]);
    const total = data.reduce((s, r) => s + Number(r.bal), 0);
    const buckets = OPEN.map((b) => {
      const rs = data.filter((r) => r.b === b);
      const balance = rs.reduce((s, r) => s + Number(r.bal), 0);
      return { bucket: b, balance, count: rs.reduce((s, r) => s + Number(r.n), 0), pct: total ? (balance / total) * 100 : 0 };
    });
    const categories = [...new Set(data.map((r) => r.c))].sort().map((c) => {
      const rs = data.filter((r) => r.c === c);
      const all = rs.reduce((s, r) => s + Number(r.bal), 0);
      const by = Object.fromEntries(OPEN.map((b) => [b, rs.filter((r) => r.b === b).reduce((s, r) => s + Number(r.bal), 0)]));
      const d30 = DELINQUENT_30.reduce((s, b) => s + by[b]!, 0);
      const d60 = DELINQUENT_60.reduce((s, b) => s + by[b]!, 0);
      return { category: c, balance: all, by, ratio30: all ? (d30 / all) * 100 : 0, ratio60: all ? (d60 / all) * 100 : 0 };
    });
    const d30 = buckets.slice(1).reduce((s, b) => s + b.balance, 0);
    const d60 = buckets.slice(2).reduce((s, b) => s + b.balance, 0);
    return { month: latest, label: label(latest), total, buckets, categories, ratio30: total ? (d30 / total) * 100 : 0, ratio60: total ? (d60 / total) * 100 : 0, delinquent30: d30, delinquent60: d60 };
  }

  /** The 30+ and 60+ ratios by month, and each bucket's balance. */
  async trend(scope: DqScope = {}, n = 13) {
    const w = await this.where(scope, 'q');
    const months = await this.months(n);
    const data = await rows<{ m: unknown; b: string; bal: number }>(this.pool, `SELECT q.month_end AS m, q.bucket AS b, SUM(q.balance) AS bal FROM hist_loan_dq_month q WHERE q.month_end >= ? AND q.bucket <> ?${w.sql} GROUP BY q.month_end, q.bucket`, [months[0], CHARGED_OFF]);
    return months.map((m) => {
      const rs = data.filter((r) => day(r.m) === m);
      const by = Object.fromEntries(OPEN.map((b) => [b, rs.filter((r) => r.b === b).reduce((s, r) => s + Number(r.bal), 0)]));
      const total = OPEN.reduce((s, b) => s + by[b]!, 0);
      return { month: m, label: label(m), total, by, ratio30: total ? (DELINQUENT_30.reduce((s, b) => s + by[b]!, 0) / total) * 100 : 0, ratio60: total ? (DELINQUENT_60.reduce((s, b) => s + by[b]!, 0) / total) * 100 : 0 };
    });
  }

  /**
   * Roll rates: of last month's balance in each status, the share in each status this month. Rolls
   * forward (current to 30, 30 to 60, 60 to 90 and on to charge-off) lead the delinquency ratio.
   */
  async rolls(scope: DqScope = {}, n = 6) {
    const w = await this.where(scope, 'r');
    const months = await this.months(n);
    const data = await rows<{ m: unknown; f: string; t: string; bal: number }>(this.pool, `SELECT r.month_end AS m, r.from_bucket AS f, r.to_bucket AS t, SUM(r.balance) AS bal FROM hist_loan_roll_month r WHERE r.month_end >= ?${w.sql} GROUP BY r.month_end, r.from_bucket, r.to_bucket`, [months[0]]);
    const rate = (m: string, from: string, to: string[]) => {
      const rs = data.filter((r) => day(r.m) === m && r.f === from);
      const all = rs.reduce((s, r) => s + Number(r.bal), 0);
      return all ? (rs.filter((r) => to.includes(r.t)).reduce((s, r) => s + Number(r.bal), 0) / all) * 100 : 0;
    };
    const latest = months[months.length - 1]!;
    const matrix = OPEN.slice(0, 5).map((from) => ({ from, to: Object.fromEntries([...OPEN, CHARGED_OFF].map((to) => [to, rate(latest, from, [to])])) }));
    // The forward rolls a collections team manages to, month by month.
    const KEY: [string, string, string[]][] = [
      ['Current to 30', 'Current', ['30–59 days']],
      ['30 to 60', '30–59 days', ['60–89 days']],
      ['60 to 90', '60–89 days', ['90–179 days']],
      ['90 to 180', '90–179 days', ['180–359 days']],
      ['90+ to charge-off', '180–359 days', [CHARGED_OFF]],
    ];
    const series = KEY.map(([name, from, to]) => ({ name, from, rates: months.map((m) => ({ month: m, label: label(m), rate: rate(m, from, to) })) }));
    const cure = months.map((m) => ({ month: m, rate: rate(m, '30–59 days', ['Current']) }));
    return { month: latest, label: label(latest), matrix, series, cure };
  }

  /** Delinquency by the year loans were made: whether newer lending performs worse. */
  async vintages(scope: DqScope = {}) {
    const w = await this.where(scope, 'q');
    const [latest] = (await this.months(1)) as [string];
    const data = await rows<{ v: number; b: string; bal: number; n: number }>(this.pool, `SELECT q.vintage_year AS v, q.bucket AS b, SUM(q.balance) AS bal, SUM(q.loan_count) AS n FROM hist_loan_dq_month q WHERE q.month_end = ? AND q.bucket <> ?${w.sql} GROUP BY q.vintage_year, q.bucket`, [latest, CHARGED_OFF]);
    return [...new Set(data.map((r) => Number(r.v)))].sort().map((v) => {
      const rs = data.filter((r) => Number(r.v) === v);
      const total = rs.reduce((s, r) => s + Number(r.bal), 0);
      const sum = (bs: readonly string[]) => rs.filter((r) => bs.includes(r.b)).reduce((s, r) => s + Number(r.bal), 0);
      return { vintage: v, balance: total, loans: rs.reduce((s, r) => s + Number(r.n), 0), ratio30: total ? (sum(DELINQUENT_30) / total) * 100 : 0, ratio60: total ? (sum(DELINQUENT_60) / total) * 100 : 0 };
    });
  }

  /** Branch and product pairs with the highest 60+ ratio, with the change over three months. */
  async segments(scope: DqScope = {}, limit = 8) {
    const w = await this.where(scope, 'q');
    const months = await this.months(4);
    const [first, last] = [months[0]!, months[months.length - 1]!];
    const data = await rows<{ m: unknown; br: string; c: string; b: string; bal: number }>(this.pool, `SELECT q.month_end AS m, loc.name AS br, q.loan_category AS c, q.bucket AS b, SUM(q.balance) AS bal FROM hist_loan_dq_month q JOIN cdm_location loc ON loc.int_id = q.branch_id WHERE q.month_end IN (?, ?) AND q.bucket <> ?${w.sql} GROUP BY q.month_end, loc.name, q.loan_category, q.bucket`, [first, last, CHARGED_OFF]);
    const ratio = (m: string, br: string, c: string) => {
      const rs = data.filter((r) => day(r.m) === m && r.br === br && r.c === c);
      const all = rs.reduce((s, r) => s + Number(r.bal), 0);
      return { all, r: all ? (rs.filter((r) => DELINQUENT_60.includes(r.b as (typeof DELINQUENT_60)[number])).reduce((s, r) => s + Number(r.bal), 0) / all) * 100 : 0 };
    };
    const pairs = [...new Set(data.map((r) => `${r.br}|${r.c}`))].map((k) => {
      const [br, c] = k.split('|') as [string, string];
      const now = ratio(last, br, c);
      const was = ratio(first, br, c);
      return { branch: br, category: c, balance: now.all, ratio60: now.r, changeBp: Math.round((now.r - was.r) * 100) };
    });
    // Material segments only: at least $1M outstanding.
    return pairs.filter((p) => p.balance >= 1_000_000).sort((a, b) => b.ratio60 - a.ratio60).slice(0, limit);
  }

  /** The largest delinquent loans today, to work: borrower, product, branch, days and balance. */
  async loans(scope: DqScope & { minDays?: number; category?: string; branch?: string; limit?: number } = {}) {
    const w = await this.where(scope, 'l');
    const params: unknown[] = [scope.minDays ?? 60];
    let extra = '';
    if (scope.category) {
      extra += ' AND l.loan_category = ?';
      params.push(scope.category);
    }
    if (scope.branch) {
      extra += ' AND loc.name = ?';
      params.push(scope.branch);
    }
    params.push(Math.min(100, scope.limit ?? 25));
    const found = await rows<Record<string, unknown>>(this.pool, `SELECT l.loan_id, l.party_id, p.first_name, p.last_name, l.loan_category, loc.name AS branch, l.balance, l.days_delinquent, l.is_indirect, l.open_date FROM cdm_loan l JOIN cdm_party p ON p.party_id = l.party_id JOIN cdm_location loc ON loc.int_id = l.branch_id WHERE l.close_date IS NULL AND l.charge_off_date IS NULL AND l.days_delinquent >= ?${w.sql}${extra} ORDER BY l.balance DESC LIMIT ?`, params);
    return found.map((r) => {
      const days = Number(r.days_delinquent);
      return {
        loanId: Number(r.loan_id),
        partyId: Number(r.party_id),
        name: `${r.first_name as string} ${r.last_name as string}`,
        last4: memberNumber(Number(r.party_id)).slice(-4),
        category: r.loan_category as string,
        branch: r.branch as string,
        balance: Number(r.balance),
        days,
        bucket: days >= 360 ? '360+ days' : days >= 180 ? '180–359 days' : days >= 90 ? '90–179 days' : days >= 60 ? '60–89 days' : days >= 30 ? '30–59 days' : 'Current',
        channel: Number(r.is_indirect) ? 'Indirect' : 'Direct',
        opened: day(r.open_date),
      };
    });
  }

  /** Net charge-offs and the allowance, from the latest 5300 when there is one. */
  async losses() {
    const cr = await rows<{ code: string; amount: number; q: unknown }>(this.pool, `SELECT code, amount, quarter_end AS q FROM cr_value WHERE quarter_end = (SELECT MAX(quarter_end) FROM cr_value) AND code IN ('550','551','025B','AS0048','041B','RIAD4635','RIAD4605','RCON2122','RCON3123','RCON1403','RCON1407')`).catch(() => []);
    if (!cr.length) return null;
    const v = (c: string) => Number(cr.find((x) => x.code === c)?.amount ?? 0);
    const quarterEnd = day(cr[0]!.q);
    const months = Number(quarterEnd.slice(5, 7));
    // A bank files the FFIEC Call Report: RI-B charge-offs and recoveries, RC-C loans, RC-N noncurrent loans.
    if (cr.some((x) => x.code === 'RIAD4635')) {
      const [ye] = await rows<{ n: unknown }>(this.pool, "SELECT amount AS n FROM cr_value WHERE code = 'RCON2122' AND quarter_end = ?", [`${Number(quarterEnd.slice(0, 4)) - 1}-12-31`]).catch(() => []);
      const loans = v('RCON2122');
      const averageLoans = (loans + (Number(ye?.n ?? 0) || loans)) / 2;
      const net = v('RIAD4635') - v('RIAD4605');
      const nonperforming = v('RCON1403') + v('RCON1407');
      return { bank: true, netChargeOffs: net, averageLoans, ncoRatio: ((net * (12 / months)) / averageLoans) * 100, allowance: v('RCON3123'), allowanceToLoans: (v('RCON3123') / loans) * 100, coverage: nonperforming ? v('RCON3123') / nonperforming : null, nonperforming, nplRatio: loans ? (nonperforming / loans) * 100 : null };
    }
    // NCUA's average loans: this quarter's 025B and last year-end's loans, averaged.
    const [ye] = await rows<{ n: unknown }>(this.pool, 'SELECT SUM(balance) AS n FROM hist_loan_month WHERE month_end = (SELECT MAX(month_end) FROM hist_loan_month WHERE month_end < ?)', [`${quarterEnd.slice(0, 4)}-01-01`]);
    const yearEnd = Number(ye?.n ?? 0) || v('025B');
    const averageLoans = (v('025B') + yearEnd) / 2;
    return { bank: false, netChargeOffs: v('550') - v('551'), averageLoans, ncoRatio: (((v('550') - v('551')) * (12 / months)) / averageLoans) * 100, allowance: v('AS0048'), allowanceToLoans: (v('AS0048') / v('025B')) * 100, coverage: v('041B') ? v('AS0048') / v('041B') : null, nonperforming: null, nplRatio: null };
  }

}
