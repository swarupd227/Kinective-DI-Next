// Liquidity: the questions it answers, and figures that hang together on the seeded warehouse.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiquidityService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { liquidityModule, runoffFrom } from '../src/liquidity.ts';

describe('liquidity questions', () => {
  const spec = liquidityModule({} as LiquidityService);
  const plan = (t: string) => spec.plan!(t, {} as never);
  it('routes each question to the right tool', () => {
    expect(plan('How much could we borrow tomorrow?')).toEqual({ tool: 'liq_capacity', args: {} });
    expect(plan('What is our FHLB capacity?')).toEqual({ tool: 'liq_capacity', args: {} });
    expect(plan('Can we survive a 30% deposit run?')).toEqual({ tool: 'liq_stress', args: { runoff_pct: 30 } });
    expect(plan('Show the cash-flow ladder')).toEqual({ tool: 'liq_ladder', args: {} });
    expect(plan('What assumptions does the liquidity view use?')).toEqual({ tool: 'liq_assumptions', args: {} });
    expect(plan('How is our liquidity?')).toEqual({ tool: 'liq_summary', args: {} });
    expect(runoffFrom('if 25 percent of shares leave')).toBe(20);
  });

  it('leaves loan-to-share to Analytics', () => {
    expect(spec.request.test('How much could we borrow tomorrow?')).toBe(true);
    expect(spec.request.test('Show the loan-to-share ratio trend')).toBe(false);
  });
});

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

describe.skipIf(!up)('liquidity on the warehouse', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = tenantPool(SCHEMA);
  });
  afterAll(async () => pool.end());

  it('adds up, stresses in order and agrees with the balances', async () => {
    const a = await new LiquidityService(pool, 'credit_union').analysis();
    expect(a.available).toBeCloseTo(a.liquid + a.contingent, 0);
    expect(a.contingent).toBeCloseTo(a.capacity.reduce((s, c) => s + c.available, 0), 0);
    // Coverage falls as runoff grows, and every run is covered at this institution.
    expect(a.stress.map((s) => s.pct)).toEqual([10, 20, 30]);
    expect(a.stress[0]!.coverage).toBeGreaterThan(a.stress[2]!.coverage);
    expect(a.stress.every((s) => s.covered)).toBe(true);
    // Loan-to-share sits in the normal range for a credit union.
    const lts = a.ratios.find((r) => r.name === 'Loan-to-share ratio')!.value;
    expect(lts).toBeGreaterThan(65);
    expect(lts).toBeLessThan(90);
    expect(a.clf).toMatch(/corporate credit union/);
  });

  it('gives a bank a correspondent line and no CLF', async () => {
    const a = await new LiquidityService(pool, 'bank').analysis();
    expect(a.capacity.map((c) => c.source)).toContain('Correspondent bank line');
    expect(a.clf).toBeNull();
  });
});
