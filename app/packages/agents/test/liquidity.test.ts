// Liquidity: the questions it answers, and figures that hang together on the seeded warehouse.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiquidityService, pctAgainst } from '@dinext/di-core';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { liquidityModule, runoffFrom, uninsuredRunFrom } from '../src/liquidity.ts';
import { bankText } from '../src/index.ts';

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
    // After SVB: the run, selling at a loss, and the LCR and NSFR.
    expect(plan('Can we survive 30 days of withdrawals without selling assets at a loss?')).toEqual({ tool: 'liq_funding', args: {} });
    expect(plan('What if 60% of uninsured deposits leave?')).toEqual({ tool: 'liq_run', args: { uninsured_pct: 60, insured_pct: 5 } });
    expect(plan('What if 50% of uninsured and 10% of insured deposits leave in a month?')).toEqual({ tool: 'liq_run', args: { uninsured_pct: 50, insured_pct: 10 } });
    expect(plan('What’s our LCR and NSFR?')).toEqual({ tool: 'liq_lcr', args: {} });
    expect(plan('What are our unrealized losses?')).toEqual({ tool: 'liq_unrealized', args: {} });
    expect(uninsuredRunFrom('a 30% deposit run')).toBeNull();
    expect(spec.request.test('Could we survive an SVB-style run?')).toBe(true);
  });

  it('speaks deposits to a bank', () => {
    expect(bankText('Available liquidity is $1.12B, 68.2% of shares. A 30% share run within 30 days would be covered 2.3 times.')).toBe('Available liquidity is $1.12B, 68.2% of deposits. A 30% deposit run within 30 days would be covered 2.3 times.');
    expect(bankText('Loans as a share of member shares')).toBe('Loans as a share of deposits');
    expect(bankText('Borrowings to shares and net worth')).toBe('Borrowings to deposits and equity');
    // Sharing a report is not a deposit.
    expect(bankText('DI shares the report with 7 people')).toBe('DI shares the report with 7 people');
    expect(pctAgainst(9.96, 10)).toBe('9.96%');
    expect(pctAgainst(10.14, 10)).toBe('10.1%');
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

// A bank's 30-day funding test, on the seeded bank and its Call Report.
const bankUp = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM cr_value LIMIT 1').then(() => true, () => false));
describe.skipIf(!bankUp)('a bank’s funding risk after SVB', () => {
  it('meets runs from loss-free sources, prices a forced sale, and estimates the LCR and NSFR', async () => {
    const { FundingRiskService } = await import('@dinext/di-core');
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const f = (await new FundingRiskService(pool).analysis())!;
      expect(f.uninsured).toBeGreaterThan(0);
      expect(f.uninsured).toBeLessThan(f.deposits);
      // Fair value under book value: an unrealized loss, as most banks carried after 2022.
      expect(f.unrealized.total).toBeCloseTo(f.securities.book - f.securities.fair, 0);
      expect(f.capital.leverageIfRealizedPct).toBeLessThan(f.capital.leveragePct);
      const [u, sev, even] = f.scenarios;
      expect(u!.runoff).toBeLessThan(sev!.runoff);
      expect(sev!.sale.loss).toBeGreaterThan(u!.sale.loss);
      for (const x of [u!, sev!, even!]) {
        expect(x.used.reduce((a, s) => a + s.used, 0)).toBeCloseTo(Math.min(x.runoff, x.lossFree), 0);
        expect(x.sale.loss).toBeCloseTo(x.sale.amount * f.securities.lossRate, 0);
      }
      expect(f.lcr.pct).toBeGreaterThan(50);
      expect(f.lcr.level2).toBeLessThanOrEqual((40 / 60) * f.lcr.level1 + 1);
      expect(f.nsfr.pct).toBeGreaterThan(50);
      const custom = (await new FundingRiskService(pool).analysis({ uninsuredPct: 90, insuredPct: 30 }))!.scenarios.find((s) => s.key === 'custom')!;
      expect(custom.runoff).toBeCloseTo(f.uninsured * 0.9 + f.insured * 0.3, 0);
      // The model may name only the uninsured share; insured deposits then keep the standard 5%.
      const run = liquidityModule({} as LiquidityService, new FundingRiskService(pool)).tools.find((t) => t.name === 'liq_run')!;
      expect(run.input.safeParse({ uninsured_pct: 60 }).success).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
