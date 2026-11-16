// Profit per member over the last 12 month-ends (ESP phase 6), from each loan and share's monthly
// profit: who makes money for the institution and who costs more than they bring in, the trend month by
// month, and what transactions cost by channel. Every figure is worked out here; the agents only word it.
import type { Pool } from '@dinext/tenant-db';
import { memberNumber } from './relationship.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

export interface MemberProfitRow {
  partyId: number;
  name: string;
  memberNumber: string;
  branch: string;
  profit: number;
  loans: number;
  deposits: number;
}

export class MemberProfitService {
  constructor(private readonly pool: Pool) {}

  /** The month-ends on file, oldest first; empty where the profit history isn't loaded. */
  async months(): Promise<string[]> {
    const found = await rows<{ m: unknown }>(this.pool, 'SELECT DISTINCT month_end AS m FROM hist_person_profit_month ORDER BY month_end').catch(() => []);
    return found.map((r) => day(r.m));
  }

  /**
   * Each person's profit over the months on file, before overhead: the most and least profitable, how
   * concentrated profit is, and how many cost more than they bring in. Limited to the branches given.
   */
  async members(branches?: string[], top = 15) {
    const months = await this.months();
    if (!months.length) return null;
    const where = branches?.length ? ` AND l.name IN (${branches.map(() => '?').join(', ')})` : '';
    const found = await rows<{ party_id: number; first_name: string | null; last_name: string | null; branch: string; profit: number; lp: number; dp: number }>(
      this.pool,
      `SELECT h.party_id, p.first_name, p.last_name, l.name AS branch, SUM(h.profit) AS profit, SUM(h.loan_profit) AS lp, SUM(h.deposit_profit) AS dp
         FROM hist_person_profit_month h JOIN cdm_party p ON p.party_id = h.party_id JOIN cdm_location l ON l.int_id = p.primary_branch_id
        WHERE 1 = 1${where} GROUP BY h.party_id, p.first_name, p.last_name, l.name`,
      branches ?? [],
    );
    const list: MemberProfitRow[] = found
      .map((r) => ({ partyId: Number(r.party_id), name: r.first_name ? `${r.first_name} ${r.last_name}` : `Member ${memberNumber(Number(r.party_id))}`, memberNumber: memberNumber(Number(r.party_id)), branch: r.branch, profit: Math.round(Number(r.profit)), loans: Math.round(Number(r.lp)), deposits: Math.round(Number(r.dp)) }))
      .sort((a, b) => b.profit - a.profit);
    const total = list.reduce((s, r) => s + r.profit, 0);
    const fifth = list.slice(0, Math.ceil(list.length / 5));
    const losing = list.filter((r) => r.profit < 0);
    // Who loses money, by what they hold: a checking account alone with a small balance, mostly.
    // Institution-wide only: a branch view lists its own people above.
    const lossKinds = branches?.length ? [] : await rows<{ kind: string; n: number; amt: number }>(
      this.pool,
      `SELECT CASE WHEN x.loans = 0 AND x.dep_bal < 1000 THEN 'Deposits under $1,000, no loan' WHEN x.loans = 0 THEN 'Deposits only' ELSE 'With a loan' END AS kind, COUNT(*) AS n, SUM(x.profit) AS amt
         FROM (SELECT h.party_id, SUM(h.profit) AS profit, SUM(h.loan_income) AS loans,
                      (SELECT COALESCE(SUM(d.balance), 0) FROM cdm_deposit_account d WHERE d.party_id = h.party_id AND d.close_date IS NULL) AS dep_bal
                 FROM hist_person_profit_month h GROUP BY h.party_id HAVING SUM(h.profit) < 0) x
        GROUP BY kind ORDER BY COUNT(*) DESC`,
    ).catch(() => []);
    return {
      from: months[0]!,
      to: months.at(-1)!,
      months: months.length,
      people: list.length,
      total,
      loans: list.reduce((s, r) => s + r.loans, 0),
      deposits: list.reduce((s, r) => s + r.deposits, 0),
      topFifthShare: total ? Math.round((fifth.reduce((s, r) => s + r.profit, 0) / total) * 1000) / 10 : 0,
      losing: { people: losing.length, amount: losing.reduce((s, r) => s + r.profit, 0), kinds: lossKinds.map((k) => ({ kind: k.kind, people: Number(k.n), amount: Math.round(Number(k.amt)) })) },
      most: list.slice(0, top),
      least: list.slice(-top).reverse(),
    };
  }

  /** Profit at each month-end, loans and deposits. */
  async trend() {
    const found = await rows<{ m: unknown; lp: number; dp: number; n: number }>(this.pool, 'SELECT month_end AS m, SUM(loan_profit) AS lp, SUM(deposit_profit) AS dp, COUNT(*) AS n FROM hist_person_profit_month GROUP BY month_end ORDER BY month_end').catch(() => []);
    return found.map((r) => ({ monthEnd: day(r.m), loans: Math.round(Number(r.lp)), deposits: Math.round(Number(r.dp)), total: Math.round(Number(r.lp) + Number(r.dp)), people: Number(r.n) }));
  }

  /** One person's profit over the months on file, before overhead; null where it isn't loaded. */
  async person(partyId: number) {
    const [r] = await rows<{ n: number; p: number | null; lp: number | null; dp: number | null }>(this.pool, 'SELECT COUNT(*) AS n, SUM(profit) AS p, SUM(loan_profit) AS lp, SUM(deposit_profit) AS dp FROM hist_person_profit_month WHERE party_id = ?', [partyId]).catch(() => []);
    if (!r || !Number(r.n)) return null;
    return { months: Number(r.n), profit: Math.round(Number(r.p)), loans: Math.round(Number(r.lp)), deposits: Math.round(Number(r.dp)) };
  }

  /**
   * What the transactions over the 30 days on file cost to handle, by channel, at each kind's cost; and
   * what moving a quarter of the teller transactions to mobile and online would save a year.
   */
  async channels() {
    const found = await rows<{ channel: string; n: number; cost: number }>(
      this.pool,
      `SELECT x.channel, SUM(x.n) AS n, SUM(x.n * c.cost_each) AS cost FROM (
          SELECT channel, code, COUNT(*) AS n FROM cdm_share_transaction GROUP BY channel, code
          UNION ALL SELECT channel, code, COUNT(*) AS n FROM cdm_loan_transaction GROUP BY channel, code) x
        JOIN cdm_transaction_cost c ON c.code = x.code AND c.channel = x.channel GROUP BY x.channel ORDER BY SUM(x.n * c.cost_each) DESC`,
    ).catch(() => null);
    if (!found?.length) return null;
    const list = found.map((r) => ({ channel: r.channel, count: Number(r.n), cost: Math.round(Number(r.cost) * 100) / 100, each: Number(r.n) ? Math.round((Number(r.cost) / Number(r.n)) * 100) / 100 : 0 }));
    const total = list.reduce((s, r) => s + r.cost, 0);
    const count = list.reduce((s, r) => s + r.count, 0);
    const teller = list.find((r) => r.channel === 'Teller');
    const digital = list.filter((r) => r.channel === 'Online' || r.channel === 'Mobile');
    const digitalEach = digital.reduce((s, r) => s + r.cost, 0) / Math.max(1, digital.reduce((s, r) => s + r.count, 0));
    const shift = teller ? Math.round(teller.count * 0.25 * (teller.each - digitalEach) * 12) : 0;
    return { total, count, list, teller: teller ? { share: Math.round((teller.count / count) * 1000) / 10, costShare: Math.round((teller.cost / total) * 1000) / 10 } : null, quarterToDigital: shift };
  }
}
