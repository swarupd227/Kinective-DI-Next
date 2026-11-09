// @vitest-environment node
// Profitability by FTP and the allowance by segment: products add up, certificates cost more than their
// funding is worth, and the allowance reconciles to the filed Call Report.
import { describe, expect, it } from 'vitest';
import { FeeIncomeService, IrrService, NiiService, ProfitabilityService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { irrModule, lineageModule, profitabilityModule } from '../src/index.ts';

describe('profitability questions', () => {
  const spec = profitabilityModule({} as ProfitabilityService);
  const plan = (t: string) => spec.plan(t, {} as never);
  it('route to the right answer', () => {
    expect(plan('Which products are most profitable?')).toEqual({ tool: 'profit_products', args: {} });
    expect(plan('Which branches contribute the most?')).toEqual({ tool: 'profit_branches', args: {} });
    expect(plan('Show the allowance by segment')).toEqual({ tool: 'profit_allowance', args: {} });
    expect(plan('How is profitability calculated?')).toEqual({ tool: 'profit_assumptions', args: {} });
    expect(spec.request.test('Which products make the most money?')).toBe(true);
    // A credit union's NII questions stay with Analytics Q&A.
    expect(spec.request.test('How much did our net interest income grow?')).toBe(false);
  });

  it('send a bank’s NII-in-dollars questions to profit_nii, and rate shocks to Interest Rate Risk', () => {
    const bank = profitabilityModule({} as ProfitabilityService, {} as NiiService);
    const bankPlan = (t: string) => bank.plan(t, {} as never);
    const irr = irrModule({} as IrrService, async () => ({}) as never);
    const cases: [string, string][] = [
      ['How much did our net interest income grow in dollars, and why?', 'why'],
      ['How much did our NII grow this year?', 'growth'],
      ['What’s our net interest income?', 'growth'],
      ['Not just NIM %, but actual dollars: how is our net interest income doing?', 'growth'],
      ['Are we short of plan on net interest income?', 'plan'],
      ['How did NII do this quarter?', 'quarter'],
      ['Will net interest income keep growing?', 'forward'],
      ['How is NII growth calculated?', 'method'],
      ['Why did interest income grow?', 'why'],
    ];
    for (const [q, question] of cases) {
      expect(bank.request.test(q), q).toBe(true);
      expect(irr.request.test(q), q).toBe(false);
      expect(bankPlan(q), q).toEqual({ tool: 'profit_nii', args: { question } });
    }
    expect(irr.request.test('What happens to NII if rates rise 200 bp?')).toBe(true);
    expect(irr.request.test('What is our net interest income at risk?')).toBe(true);
    expect(bankPlan('Which products are most profitable?')).toEqual({ tool: 'profit_products', args: {} });
  });

  it('send a bank’s fee and noninterest income questions to profit_fees, not to rate risk or lineage', () => {
    const bank = profitabilityModule({} as ProfitabilityService, {} as NiiService, {} as FeeIncomeService);
    const bankPlan = (t: string) => bank.plan(t, {} as never);
    const irr = irrModule({} as IrrService, async () => ({}) as never);
    const cases: [string, string][] = [
      ['What’s our non-interest income?', 'overview'],
      ['What\'s our non-interest income, where does it come from, and how much does it diversify us away from rates?', 'rates'],
      ['How much fee income do we earn, and what share of revenue is it?', 'share'],
      ['Where does our fee income come from?', 'mix'],
      ['How is our mortgage banking doing?', 'mix'],
      ['How much of our revenue doesn’t depend on rates?', 'rates'],
      ['What happens to our fee income if rates rise?', 'rates'],
      ['How has noninterest income grown?', 'growth'],
      ['How is noninterest income calculated?', 'method'],
    ];
    for (const [q, question] of cases) {
      expect(bank.request.test(q), q).toBe(true);
      expect(irr.request.test(q), q).toBe(false);
      expect(bankPlan(q), q).toEqual({ tool: 'profit_fees', args: { question } });
    }
    // NII questions still get the NII answer, even though "non-interest income" contains "interest income".
    expect(bankPlan('How much did our net interest income grow?')).toEqual({ tool: 'profit_nii', args: { question: 'growth' } });
    // Lineage keeps data questions and gives way when the question is about the business.
    const lineage = lineageModule({} as never).request;
    expect(lineage.test('Where does 60+ delinquency come from?')).toBe(true);
    expect(lineage.test('So where does total loan balance come from?')).toBe(true);
    expect(lineage.test('Where does our fee income come from?')).toBe(false);
    expect(lineage.test('Trace non-interest income to its sources')).toBe(true);
    expect(lineage.test('What\'s our non-interest income, where does it come from, and how much does it diversify us away from rates?')).toBe(false);
  });
});

const feeUp = await warehouseAvailable('dinext_t_test_bank');
describe.skipIf(!feeUp)('a bank’s noninterest income', () => {
  it('ties to the Call Report, splits by business and shows what rates move', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const f = (await new FeeIncomeService(pool).income())!;
      const [[filed]] = (await pool.query("SELECT amount FROM cr_value WHERE code = 'RIAD4079' ORDER BY quarter_end DESC LIMIT 1")) as unknown as [[{ amount: number }]];
      expect(f.total).toBeCloseTo(Number(filed.amount), 0);
      expect(f.lines.reduce((t, l) => t + l.ytd, 0)).toBeCloseTo(f.total, 0);
      expect(f.groups.reduce((t, g) => t + g.ytd, 0)).toBeCloseTo(f.total, 0);
      expect(f.groups.find((g) => g.group === 'Trading')!.ytd).toBe(0);
      expect(f.sharePct).toBeCloseTo((f.annualized / f.revenue) * 100, 6);
      expect(f.steadyPct).toBeLessThan(f.sharePct);
      expect(f.trend).toHaveLength(5);
      // Mortgage banking gains when rates fall; the rest of fee income doesn't move.
      const down = f.rates.find((r) => r.bp === -100)!;
      expect(down.mortgageChange).toBeGreaterThan(0);
      expect(down.revenueChange).toBeCloseTo(down.niiChange + down.mortgageChange, 0);
      expect(f.plan!.sharePct).toBe(15);
    } finally {
      await pool.end();
    }
  });
});

const bankUp = await warehouseAvailable('dinext_t_test_bank');
describe.skipIf(!bankUp)('a bank’s net interest income growth', () => {
  it('ties to the Call Report and splits into balance sheet and margin', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const g = (await new NiiService(pool).growth())!;
      const y = g.ytd!;
      const [[filed]] = (await pool.query("SELECT amount FROM cr_value WHERE code = 'RIAD4074' ORDER BY quarter_end DESC LIMIT 1")) as unknown as [[{ amount: number }]];
      expect(y.now).toBeCloseTo(Number(filed.amount), 0);
      // Volume plus rate is the whole change, and rate is yield plus funding cost.
      expect(y.volume + y.rate).toBeCloseTo(y.change, 0);
      expect(y.yieldEffect + y.costEffect).toBeCloseTo(y.rate, 0);
      // Lines add up to income less expense.
      expect(y.lines.reduce((t, l) => t + (l.side === 'income' ? l.change : -l.change), 0)).toBeCloseTo(y.change, -3);
      expect(g.trend).toHaveLength(5);
      // A quarter's own figure is this year to date less the last.
      const t = g.trend;
      expect(g.quarter!.now).toBeCloseTo(t.at(-1)!.ytd - t.at(-2)!.ytd, 0);
      expect(t[0]!.quarterly).toBeNull();
      expect(g.plan!.nii).toBeCloseTo((g.plan!.nim / 100) * g.earning, 0);
      expect(g.forward!.next12).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
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
