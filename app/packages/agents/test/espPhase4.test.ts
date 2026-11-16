// @vitest-environment node
// ESP phase 4: each loan and share at each month-end, added up by account, person and household; the
// collateral report by quarter; voided and reversed transactions. The month-end rows are the paths the
// month-end totals were built from, so they add up to them.
import { describe, expect, it } from 'vitest';
import { BalanceHistoryService, CollateralService, type IssueService, LiquidityService, RelationshipService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { complianceModule, liquidityModule } from '../src/index.ts';
import { member360 } from '../src/member.ts';

describe('routing', () => {
  it('sends who moved money out to liq_outflows, a month or a quarter, without taking the runoff tests', () => {
    for (const liq of [liquidityModule({} as LiquidityService), liquidityModule({} as LiquidityService, {} as never)]) {
      const plan = (t: string) => liq.plan(t, {} as never) as { tool?: string; args?: { months?: number } };
      for (const q of ['Who moved the most money out last month?', 'Which members pulled their deposits last quarter?', 'Show the largest deposit outflows', 'Where did our deposits go last month?']) {
        expect(liq.request.test(q), q).toBe(true);
        expect(plan(q).tool, q).toBe('liq_outflows');
      }
      expect(plan('Which members pulled their deposits last quarter?').args?.months).toBe(3);
      expect(plan('Who moved the most money out last month?').args?.months).toBe(1);
      expect(plan('Can we survive a 20% deposit run?').tool).toBe('liq_stress');
    }
  });

  it('sends voided and reversed transactions to cpm_reversals, and still logs a complaint about one', () => {
    const cpm = complianceModule({} as IssueService, {} as never);
    const plan = (t: string) => (cpm.plan(t, {} as never) as { tool?: string }).tool;
    for (const q of ['Show voided and reversed transactions', 'Who refunds the most fees?', 'Any returned loan payments this month?', 'Which tellers reversed fees?']) {
      expect(cpm.request.test(q), q).toBe(true);
      expect(plan(q), q).toBe('cpm_reversals');
    }
    expect(plan('Log a complaint from James Lee about a reversed fee')).toBe('cpm_issue_create');
    expect(plan('Show our insider loans')).toBe('cpm_insider_loans');
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM hist_person_month LIMIT 1').then(() => true, () => false));
  const type = DB.endsWith('bank') ? 'bank' : 'credit_union';
  describe.skipIf(!up)(`${DB}: phase 4`, () => {
    const pool = tenantPool(DB);
    const one = async (sql: string) => Number(((await pool.query(sql)) as unknown as [{ n: unknown }[]])[0][0]!.n ?? 0);
    const ctx = { user: { id: 'user:1', name: 'Test' }, modules: ['liquidity', 'compliance'], runId: 'r', threadId: 't' };

    it('adds each loan and share at each month-end up to the month-end totals by branch and category', async () => {
      expect(await one('SELECT MAX(ABS(h.balance - COALESCE(s.b, 0))) AS n FROM hist_loan_month h LEFT JOIN (SELECT a.month_end, l.branch_id, l.loan_category, l.is_indirect, SUM(a.balance) AS b FROM hist_loan_account_month a JOIN cdm_loan l ON l.loan_id = a.loan_id GROUP BY 1, 2, 3, 4) s ON s.month_end = h.month_end AND s.branch_id = h.branch_id AND s.loan_category = h.loan_category AND s.is_indirect = h.is_indirect')).toBeLessThan(2);
      expect(await one('SELECT (SELECT SUM(loan_count) FROM hist_loan_month) - (SELECT COUNT(*) FROM hist_loan_account_month) AS n')).toBe(0);
      expect(await one('SELECT MAX(ABS(h.balance - COALESCE(s.b, 0))) AS n FROM hist_deposit_month h LEFT JOIN (SELECT a.month_end, d.branch_id, d.deposit_category, SUM(a.balance) AS b FROM hist_deposit_account_month a JOIN cdm_deposit_account d ON d.account_id = a.account_id GROUP BY 1, 2, 3) s ON s.month_end = h.month_end AND s.branch_id = h.branch_id AND s.deposit_category = h.deposit_category')).toBeLessThan(2);
      // The 60+ days late balance comes from the same statuses.
      expect(await one("SELECT MAX(ABS(h.d - COALESCE(s.b, 0))) AS n FROM (SELECT month_end, SUM(delinquent_60_balance) AS d FROM hist_loan_month GROUP BY month_end) h LEFT JOIN (SELECT month_end, SUM(balance) AS b FROM hist_loan_account_month WHERE delinquency_status IN ('60–89 days','90–179 days','180–359 days','360+ days') GROUP BY month_end) s ON s.month_end = h.month_end")).toBeLessThan(20);
    });

    it('rolls the month-ends up by account, person and household without losing a dollar', async () => {
      for (const [table, col] of [['hist_account_month', 'deposit_balance'], ['hist_person_month', 'deposit_balance'], ['hist_household_month', 'deposit_balance']]) {
        expect(await one(`SELECT ABS((SELECT SUM(${col}) FROM ${table}) - (SELECT SUM(balance) FROM hist_deposit_account_month)) AS n`), table).toBeLessThan(1);
      }
      for (const table of ['hist_account_month', 'hist_person_month', 'hist_household_month']) {
        expect(await one(`SELECT ABS((SELECT SUM(loan_balance) FROM ${table}) - (SELECT SUM(balance) FROM hist_loan_account_month)) AS n`), table).toBeLessThan(1);
      }
      // A person's latest month-end is close to today's balances: the build is a few weeks later.
      const people = await one('SELECT COUNT(DISTINCT party_id) AS n FROM hist_person_month WHERE month_end = (SELECT MAX(month_end) FROM hist_person_month)');
      expect(people).toBeGreaterThan(1000);
    });

    it('keeps the collateral report by quarter, ending near today’s', async () => {
      const svc = new CollateralService(pool);
      const q = await svc.history();
      expect(q.length).toBe(6);
      const now = (await svc.report())!;
      const last = q[q.length - 1]!;
      expect(Math.abs(last.eligiblePct - now.eligiblePct)).toBeLessThan(1.5);
      expect(last.balance / now.balance).toBeGreaterThan(0.95);
      expect(last.balance / now.balance).toBeLessThan(1.05);
      const out = (await liquidityModule({ analysis: () => new LiquidityService(pool, type).analysis() } as LiquidityService, null, svc).tools.find((t) => t.name === 'liq_collateral')!.run({} as never, ctx as never)) as { text: string; blocks: { title?: string }[] };
      expect(out.text).toMatch(/At Q3 2025’s end, \$[\d.]+M \([\d.]+%\) was eligible/);
    });

    it('shows a person’s deposits and loans a year apart on Member 360', async () => {
      // Someone with deposits and a loan at every month-end on file.
      const who = await one('SELECT party_id AS n FROM hist_person_month WHERE deposit_balance > 0 AND loan_balance > 0 GROUP BY party_id HAVING COUNT(*) = 18 ORDER BY party_id LIMIT 1');
      const p = await new RelationshipService(pool, DB.replace('dinext_t_', ''), type).profile(who, {});
      expect(p.balanceHistory.length).toBeGreaterThanOrEqual(13);
      const facts = (member360(p, 'r').data.sections.find((s) => s.kind === 'engagement') as { facts: { label: string; value: string }[] }).facts;
      const deposits = facts.find((f) => f.label === 'Deposits, month-ends')!;
      expect(deposits.value).toMatch(/^\$[\d,]+ to \$[\d,]+ \([+−]\d+%\), Sep 2025 to Sep 2026$/);
    });

    it('names who moved money out, and their share of what left', async () => {
      const o = (await new BalanceHistoryService(pool).outflows(1))!;
      expect(o.list.length).toBe(20);
      expect(o.list[0]!.change).toBeLessThanOrEqual(o.list[19]!.change);
      expect(o.after - o.before).toBeCloseTo(o.inflow - o.outflow, 0);
      expect(o.topShare).toBeGreaterThan(0);
      expect(o.topShare).toBeLessThan(100);
      const q = (await new BalanceHistoryService(pool).outflows(3))!;
      expect(q.from < o.from).toBe(true);
      const tool = liquidityModule({} as LiquidityService, type === 'bank' ? ({} as never) : null, null, new BalanceHistoryService(pool)).tools.find((t) => t.name === 'liq_outflows')!;
      const out = (await tool.run({ months: 1 } as never, ctx as never)) as { text: string };
      expect(out.text).toMatch(type === 'bank' ? /customers’ accounts/ : /members’ accounts/);
      expect(out.text).toMatch(/The 20 largest declines add up to/);
    });

    it('finds voids, fee refunds and returned payments, and the one rep whose refunds stand out', async () => {
      const r = (await new BalanceHistoryService(pool).exceptions())!;
      expect(r.voids).toBeGreaterThan(100);
      expect(r.returnedPayments.count).toBeGreaterThan(10);
      expect(r.standsOut.length).toBe(1);
      expect(r.standsOut[0]!.topMember!.reversals).toBeGreaterThanOrEqual(4);
      // A void was keyed again: the re-entry is a posted transaction on the same account.
      expect(await one("SELECT COUNT(*) AS n FROM cdm_transaction_exception x LEFT JOIN cdm_share_transaction t ON t.txn_id = x.reposted_txn_id AND t.account_id = x.account_id WHERE x.kind = 'Void' AND t.txn_id IS NULL")).toBe(0);
      const tool = complianceModule({} as IssueService, pool, undefined, new BalanceHistoryService(pool)).tools.find((t) => t.name === 'cpm_reversals')!;
      const out = (await tool.run({} as never, ctx as never)) as { text: string };
      expect(out.text).toMatch(/times the average of the other reps there/);
      expect(out.text).toMatch(/Whether a refund was wrong is the branch manager’s or compliance officer’s call/);
    });
  });
}
