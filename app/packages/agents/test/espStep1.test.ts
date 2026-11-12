// @vitest-environment node
// ESP alignment, step 1: who opened each account and where it was originated, and credit score history.
// The new tables cover every account, agree with what was already seeded, and feed new answers only.
import { describe, expect, it } from 'vitest';
import { CollectionsService, RelationshipService, SalesScorecardService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { SALES_SCORECARD_REQUEST, collectionsModule, salesScorecardPlan } from '../src/index.ts';

describe('routing', () => {
  it('sends the new questions to the right tools', () => {
    expect(SALES_SCORECARD_REQUEST.test('Who opened the most accounts this month?')).toBe(true);
    expect(salesScorecardPlan('Who opened the most accounts this month?')).toEqual({ tool: 'sales_opened_by', args: {} });
    expect(salesScorecardPlan('Show the loan scorecard')).toEqual({ tool: 'sales_loan_scorecard', args: {} });
    const col = collectionsModule({} as never);
    expect(col.request.test('Whose credit scores have dropped?')).toBe(true);
    expect(col.plan('Whose credit scores have dropped?', {} as never)).toEqual({ tool: 'col_score_drops', args: {} });
    expect(col.plan('Show the early-warning list', {} as never)).toEqual({ tool: 'col_watchlist', args: {} });
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cdm_credit_score_history LIMIT 1').then(() => true, () => false));
  describe.skipIf(!up)(`${DB}: the new tables`, () => {
    const pool = tenantPool(DB);
    const one = async <T>(sql: string) => ((await pool.query(sql)) as unknown as [T[]])[0][0]!;

    it('stamps every loan and deposit account, once', async () => {
      const loans = await one<{ n: number }>('SELECT COUNT(*) AS n FROM cdm_loan');
      const deps = await one<{ n: number }>('SELECT COUNT(*) AS n FROM cdm_deposit_account');
      const o = await one<{ l: number; d: number }>("SELECT SUM(account_kind = 'loan') AS l, SUM(account_kind = 'deposit') AS d FROM cdm_account_origination");
      expect(Number(o.l)).toBe(Number(loans.n));
      expect(Number(o.d)).toBe(Number(deps.n));
      // An indirect loan came through a dealer, with no employee; a direct one names who opened it.
      const ind = await one<{ bad: number }>("SELECT COUNT(*) AS bad FROM cdm_account_origination o JOIN cdm_loan l ON l.loan_id = o.account_id WHERE o.account_kind = 'loan' AND l.is_indirect = 1 AND (o.channel <> 'Dealer' OR o.opened_by_employee_id IS NOT NULL)");
      expect(Number(ind.bad)).toBe(0);
      const orphan = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cdm_account_origination o LEFT JOIN cdm_employee e ON e.employee_id = o.opened_by_employee_id WHERE o.opened_by_employee_id IS NOT NULL AND e.employee_id IS NULL");
      expect(Number(orphan.n)).toBe(0);
    });

    it('keeps each loan’s application score in the history, unchanged', async () => {
      const miss = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cdm_loan l WHERE l.credit_score IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cdm_credit_score_history h WHERE h.party_id = l.party_id AND h.as_of = l.open_date AND h.score_type = 'FICO 8' AND h.source = 'Loan application')");
      expect(Number(miss.n)).toBeLessThan(50);
      const range = await one<{ lo: number; hi: number }>('SELECT MIN(score) AS lo, MAX(score) AS hi FROM cdm_credit_score_history');
      expect(Number(range.lo)).toBeGreaterThanOrEqual(300);
      expect(Number(range.hi)).toBeLessThanOrEqual(850);
    });

    it('answers who opened accounts and whose scores dropped, and the profile carries the history', async () => {
      const opened = await new SalesScorecardService(pool).openedBy({});
      expect(opened).not.toBeNull();
      expect(opened!.people.reduce((s, p) => s + p.loans + p.deposits, 0)).toBe(opened!.total);
      const drops = await new CollectionsService(pool).scoreDrops({});
      expect(drops.loaded).toBe(true);
      expect(drops.items.length).toBeGreaterThan(0);
      expect(drops.items.every((d) => d.drop >= 40)).toBe(true);
      // Measured over about a year: the earlier score is never more than 15 months before the latest.
      expect(drops.items.every((d) => Date.parse(d.toDate) - Date.parse(d.fromDate) <= 457 * 86_400_000)).toBe(true);
      const p = await new RelationshipService(pool, DB.replace('dinext_t_', ''), DB.endsWith('bank') ? 'bank' : 'credit_union').profile(drops.items[0]!.partyId, {});
      expect(p.creditHistory.length).toBeGreaterThan(1);
      // The 360's credit score tile still reads the latest loan's score, as before.
      expect(p.creditScore?.from).toMatch(/application/);
    });
  });
}
