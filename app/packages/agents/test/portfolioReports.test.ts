// @vitest-environment node
// Portfolio Reports: member growth, the certificate maturity forecast, deposit growth by product and
// delinquency by product, as answers. The stock reports test builds them as reports.
import { describe, expect, it } from 'vitest';
import { PortfolioService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { PORTFOLIO_REQUEST, portfolioModule, portfolioQuestion } from '../src/index.ts';

describe('portfolio report questions', () => {
  it('route to the right report', () => {
    const cases: [string, string][] = [
      ['Show member growth', 'members'],
      ['Show the CD maturity forecast', 'cds'],
      ['Show deposit growth by product', 'deposits'],
      ['Show delinquency by product', 'delinquency'],
    ];
    for (const [q, question] of cases) {
      expect(PORTFOLIO_REQUEST.test(q), q).toBe(true);
      expect(portfolioQuestion(q), q).toBe(question);
    }
  });
});

const up = await warehouseAvailable('dinext_t_test_cu');
describe.skipIf(!up)('the credit union’s portfolio reports', () => {
  it('adds up, and keeps to purview', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    try {
      const svc = new PortfolioService(pool);
      const g = await svc.memberGrowth({});
      for (const p of g.periods) expect(p.net).toBe(p.joined - p.left);
      expect(g.periods[0]!.joined).toBeLessThanOrEqual(g.periods[2]!.joined);
      expect(g.averageAge).toBeGreaterThan(18);
      const cd = await svc.cdMaturity({});
      expect(cd.intervals.reduce((s, i) => s + i.count, 0)).toBe(cd.count);
      expect(cd.projection.at(-1)!.balance).toBeLessThan(cd.balance);
      const dep = await svc.depositGrowth({});
      expect(dep.rows.length).toBeGreaterThan(2);
      const dq = await svc.delinquencyByProduct({});
      expect(dq.history.length).toBeGreaterThan(12);
      const westport = await svc.memberGrowth({ purviewBranches: ['Westport'] });
      expect(westport.members).toBeLessThan(g.members);

      const spec = portfolioModule(svc);
      const ctx = { user: { id: 'u', name: 'Dana Lee' }, modules: ['portfolio'], runId: 'r', threadId: 't' };
      for (const question of ['members', 'cds', 'deposits', 'delinquency']) {
        const out = (await spec.tools[0]!.run({ question } as never, ctx)) as { text: string; blocks: unknown[] };
        expect(out.text, question).toMatch(/\*\*/);
        expect(out.blocks.length, question).toBe(2);
      }
    } finally {
      await pool.end();
    }
  });
});
