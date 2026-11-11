// @vitest-environment node
// Sales Scorecards: the loan score card by channel against minimum and stretch, contests, and regions.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { GoalsService, SalesScorecardService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { SALES_SCORECARD_REQUEST, salesScorecardModule, salesScorecardPlan } from '../src/index.ts';

describe('sales scorecard questions', () => {
  it('route to the right tool, and leave a person’s own scorecard to Goals & Incentives', () => {
    const cases: [string, string][] = [
      ['Show the loan score card', 'sales_loan_scorecard'],
      ['How are we doing against our stretch goals?', 'sales_loan_scorecard'],
      ['How are the sales contests going?', 'sales_contests'],
      ['Who is winning the HELOC fall push?', 'sales_contests'],
      ['Show the scorecards by region', 'sales_regions'],
    ];
    for (const [q, tool] of cases) {
      expect(SALES_SCORECARD_REQUEST.test(q), q).toBe(true);
      expect(salesScorecardPlan(q).tool, q).toBe(tool);
    }
    expect(SALES_SCORECARD_REQUEST.test('How am I doing on my goals this month?')).toBe(false);
  });
});

const up = await warehouseAvailable('dinext_t_test_cu').then((ok) => ok && tenantPool('dinext_t_test_cu').query('SELECT 1 FROM fin_loan_goal LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('the credit union’s sales scorecards', () => {
  it('scores channels against minimum and stretch, ranks contests, and rolls up regions', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    try {
      const svc = new SalesScorecardService(pool);
      const s = await svc.loanScorecard();
      expect(s.month).toBe('2026-09-30');
      for (const r of s.rows) {
        expect(r.stretch).toBeGreaterThan(r.minimum);
        expect(r.minYtd).toBeCloseTo((r.minimum * 9) / 12, 0);
      }
      // Some channels run ahead of the minimum and some behind.
      expect(s.rows.some((r) => r.pctToMin >= 100)).toBe(true);
      expect(s.rows.some((r) => r.pctToMin < 100)).toBe(true);
      const westport = await svc.loanScorecard(undefined, { purviewBranches: ['Westport'] });
      expect(westport.scoped).toBe(true);
      expect(westport.total.ytd).toBeLessThan(s.total.ytd);

      const c = await svc.contests();
      expect(c.contests.map((x) => x.status)).toEqual(['Running', 'Ended']);
      const summer = c.contests.find((x) => x.status === 'Ended')!;
      expect(summer.standings[0]!.count).toBeGreaterThanOrEqual(summer.standings[1]!.count);

      const regions = await svc.regions(new GoalsService(pool), { leads: true, approves: true }, {});
      expect(regions.map((r) => r.region)).toEqual(['Central', 'North', 'South']);

      const spec = salesScorecardModule(svc, new GoalsService(pool));
      const ctx = { user: { id: 'u', name: 'Dana Lee' }, modules: ['salescard'], runId: 'r', threadId: 't' };
      for (const tool of spec.tools) {
        const out = (await tool.run({} as never, ctx)) as { text: string; blocks: unknown[] };
        expect(out.text.length, tool.name).toBeGreaterThan(40);
        for (const b of out.blocks) expect(blockSchema.safeParse(b).success, tool.name).toBe(true);
      }
    } finally {
      await pool.end();
    }
  });
});
