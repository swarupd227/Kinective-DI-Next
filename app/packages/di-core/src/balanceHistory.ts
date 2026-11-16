// Balances month by month, account by account (ESP phase 4): who moved money out over the last month or
// quarter, a person's balances over the year, and voided and reversed transactions. Every figure is worked
// out here from the month-end snapshots; the agents only word it.
import type { Pool } from '@dinext/tenant-db';
import { memberNumber } from './relationship.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

export interface Outflow {
  partyId: number;
  name: string;
  memberNumber: string;
  branch: string;
  before: number;
  after: number;
  change: number;
  /** Every share closed by the later month-end. */
  closedAll: boolean;
}

export interface FeeReversalRep {
  employeeId: number;
  name: string;
  branch: string;
  reversals: number;
  amount: number;
  /** The rep's reversals against the average of the other reps at the branch. */
  againstPeers: number | null;
  /** The most refunds for one member, and to whom. */
  topMember: { name: string; reversals: number; amount: number } | null;
}

export class BalanceHistoryService {
  constructor(private readonly pool: Pool) {}

  /** The month-ends on file, oldest first; empty where the snapshots aren't loaded. */
  async months(): Promise<string[]> {
    const found = await rows<{ m: unknown }>(this.pool, 'SELECT DISTINCT month_end AS m FROM hist_person_month ORDER BY month_end').catch(() => []);
    return found.map((r) => day(r.m));
  }

  /** Deposits that left between two month-ends, member by member: the net change, who moved the most out, and who closed everything. */
  async outflows(over: 1 | 3 = 1, top = 20) {
    const months = await this.months();
    if (months.length <= over) return null;
    const to = months[months.length - 1]!;
    const from = months[months.length - 1 - over]!;
    const found = await rows<{ party_id: number; b: number; a: number; n: number | null; first_name: string | null; last_name: string | null; branch: string | null }>(
      this.pool,
      `SELECT x.party_id, COALESCE(b.deposit_balance, 0) AS b, COALESCE(a.deposit_balance, 0) AS a, a.deposit_count AS n, p.first_name, p.last_name, l.name AS branch
         FROM (SELECT DISTINCT party_id FROM hist_person_month WHERE month_end IN (?, ?)) x
         LEFT JOIN hist_person_month b ON b.party_id = x.party_id AND b.month_end = ?
         LEFT JOIN hist_person_month a ON a.party_id = x.party_id AND a.month_end = ?
         LEFT JOIN cdm_party p ON p.party_id = x.party_id
         LEFT JOIN cdm_location l ON l.int_id = p.primary_branch_id`,
      [from, to, from, to],
    );
    const before = found.reduce((s, r) => s + Number(r.b), 0);
    const after = found.reduce((s, r) => s + Number(r.a), 0);
    const down = found
      .map((r) => ({ r, change: Number(r.a) - Number(r.b) }))
      .filter((x) => x.change < -0.005)
      .sort((x, y) => x.change - y.change);
    const out = down.reduce((s, x) => s - x.change, 0);
    const inflow = found.reduce((s, r) => s + Math.max(0, Number(r.a) - Number(r.b)), 0);
    const list: Outflow[] = down.slice(0, top).map(({ r, change }) => ({
      partyId: Number(r.party_id),
      name: r.first_name ? `${r.first_name} ${r.last_name}` : `Member ${memberNumber(Number(r.party_id))}`,
      memberNumber: memberNumber(Number(r.party_id)),
      branch: r.branch ?? '—',
      before: Number(r.b),
      after: Number(r.a),
      change,
      closedAll: Number(r.b) > 0 && !(Number(r.n) > 0),
    }));
    const closed = down.filter(({ r }) => Number(r.b) > 0 && !(Number(r.n) > 0));
    // Most balances move a little every month; a fall of $10,000 or more is money that left.
    const large = down.filter((x) => x.change <= -10_000);
    return {
      from,
      to,
      before,
      after,
      net: after - before,
      inflow,
      outflow: out,
      members: down.length,
      large: { members: large.length, amount: large.reduce((s, x) => s - x.change, 0) },
      topShare: out ? (list.reduce((s, x) => s - x.change, 0) / out) * 100 : 0,
      closed: { members: closed.length, balance: closed.reduce((s, x) => s - x.change, 0) },
      list,
    };
  }

  /** One person's deposits and loans at each month-end, oldest first. */
  async person(partyId: number) {
    const found = await rows<{ m: unknown; d: number; l: number }>(this.pool, 'SELECT month_end AS m, deposit_balance AS d, loan_balance AS l FROM hist_person_month WHERE party_id = ? ORDER BY month_end', [partyId]).catch(() => []);
    return found.map((r) => ({ monthEnd: day(r.m), deposits: Number(r.d), loans: Number(r.l) }));
  }

  /** Voided and reversed transactions in the window on file, by kind and reason, and fee refunds by rep. */
  async exceptions() {
    const has = await rows<{ n: number; lo: unknown; hi: unknown }>(this.pool, 'SELECT COUNT(*) AS n, MIN(entered) AS lo, MAX(entered) AS hi FROM cdm_transaction_exception').catch(() => null);
    if (!has?.[0] || !Number(has[0].n)) return null;
    const byKind = (
      await rows<{ kind: string; account_kind: string; reason: string; n: number; amt: number }>(
        this.pool,
        'SELECT kind, account_kind, reason, COUNT(*) AS n, SUM(amount) AS amt FROM cdm_transaction_exception GROUP BY kind, account_kind, reason ORDER BY COUNT(*) DESC',
      )
    ).map((r) => ({ kind: r.kind, account: r.account_kind === 'loan' ? 'Loan' : 'Share', reason: r.reason, count: Number(r.n), amount: Number(r.amt) }));
    const fees = await rows<{ employee_id: number; name: string; branch: string; branch_id: number; n: number; amt: number }>(
      this.pool,
      `SELECT x.employee_id, e.display_name AS name, l.name AS branch, e.branch_id, COUNT(*) AS n, SUM(x.amount) AS amt
         FROM cdm_transaction_exception x JOIN cdm_employee e ON e.employee_id = x.employee_id JOIN cdm_location l ON l.int_id = e.branch_id
        WHERE x.kind = 'Reversal' AND x.code LIKE 'FEE%' GROUP BY x.employee_id, e.display_name, l.name, e.branch_id ORDER BY COUNT(*) DESC`,
    );
    const topMembers = await rows<{ employee_id: number; first_name: string; last_name: string; n: number; amt: number }>(
      this.pool,
      `SELECT x.employee_id, p.first_name, p.last_name, COUNT(*) AS n, SUM(x.amount) AS amt
         FROM cdm_transaction_exception x JOIN cdm_party p ON p.party_id = x.party_id
        WHERE x.kind = 'Reversal' AND x.code LIKE 'FEE%' AND x.employee_id IS NOT NULL
        GROUP BY x.employee_id, x.party_id, p.first_name, p.last_name ORDER BY COUNT(*) DESC`,
    );
    const reps: FeeReversalRep[] = fees.map((f) => {
      const peers = fees.filter((p) => p.branch_id === f.branch_id && p.employee_id !== f.employee_id);
      const peerAvg = peers.length ? peers.reduce((s, p) => s + Number(p.n), 0) / peers.length : null;
      const tm = topMembers.find((t) => t.employee_id === f.employee_id);
      return {
        employeeId: Number(f.employee_id),
        name: f.name,
        branch: f.branch,
        reversals: Number(f.n),
        amount: Number(f.amt),
        againstPeers: peerAvg ? Number(f.n) / peerAvg : null,
        topMember: tm ? { name: `${tm.first_name} ${tm.last_name}`, reversals: Number(tm.n), amount: Number(tm.amt) } : null,
      };
    });
    const allAvg = reps.length ? reps.reduce((s, r) => s + r.reversals, 0) / reps.length : 0;
    return {
      from: day(has[0].lo),
      to: day(has[0].hi),
      total: Number(has[0].n),
      byKind,
      voids: byKind.filter((k) => k.kind === 'Void').reduce((s, k) => s + k.count, 0),
      feeRefunds: { count: reps.reduce((s, r) => s + r.reversals, 0), amount: reps.reduce((s, r) => s + r.amount, 0), average: allAvg },
      returnedPayments: byKind.filter((k) => k.account === 'Loan').reduce((s, k) => ({ count: s.count + k.count, amount: s.amount + k.amount }), { count: 0, amount: 0 }),
      reps,
      // A rep refunding fees at well over twice the rate of the others at the same branch.
      standsOut: reps.filter((r) => r.againstPeers !== null && r.againstPeers >= 2.5 && r.reversals >= 10),
    };
  }
}
