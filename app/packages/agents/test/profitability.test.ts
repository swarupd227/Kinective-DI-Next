// @vitest-environment node
// Profitability by FTP and the allowance by segment: products add up, certificates cost more than their
// funding is worth, and the allowance reconciles to the filed Call Report.
import { describe, expect, it } from 'vitest';
import { ProfitabilityService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { profitabilityModule } from '../src/index.ts';

describe('profitability questions', () => {
  const spec = profitabilityModule({} as ProfitabilityService);
  const plan = (t: string) => spec.plan(t, {} as never);
  it('route to the right answer', () => {
    expect(plan('Which products are most profitable?')).toEqual({ tool: 'profit_products', args: {} });
    expect(plan('Which branches contribute the most?')).toEqual({ tool: 'profit_branches', args: {} });
    expect(plan('Show the allowance by segment')).toEqual({ tool: 'profit_allowance', args: {} });
    expect(plan('How is profitability calculated?')).toEqual({ tool: 'profit_assumptions', args: {} });
    expect(spec.request.test('Which products make the most money?')).toBe(true);
  });
});

for (const [schema, type, code] of [['dinext_t_test_cu', 'credit_union', 'AS0048'], ['dinext_t_test_bank', 'bank', 'RCON3123']] as const) {
  const up = await warehouseAvailable(schema);
  describe.skipIf(!up)(`profitability for ${type}`, () => {
    it('adds up, prices funding, and reconciles the allowance to the filing', async () => {
      const pool = tenantPool(schema);
      try {
        const svc = new ProfitabilityService(pool, type);
        const a = await svc.analysis();
        expect(a.total).toBeCloseTo(a.byProduct.reduce((s, l) => s + l.contribution, 0), 0);
        expect(a.total).toBeCloseTo(a.byBranch.reduce((s, l) => s + l.contribution, 0), 0);
        expect(a.byProduct.find((l) => /^Certificates/.test(l.name))!.contribution).toBeLessThan(0);
        expect(a.byProduct.find((l) => l.name === 'Checking')!.marginPct).toBeGreaterThan(2);
        const al = await svc.allowance();
        const [[filed]] = (await pool.query('SELECT amount FROM cr_value WHERE code = ? ORDER BY quarter_end DESC LIMIT 1', [code])) as unknown as [[{ amount: number }]];
        expect(al.allowance).toBeCloseTo(Number(filed.amount), 0);
        const cov = (c: RegExp) => al.byCategory.find((x) => c.test(x.category))!.coveragePct;
        expect(cov(/^Mortgage$/)).toBeLessThan(1);
        expect(cov(/^(Credit Card|Consumer)$/)).toBeGreaterThan(4);
      } finally {
        await pool.end();
      }
    });
  });
}
