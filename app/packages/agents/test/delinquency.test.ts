// Delinquency in depth: the questions it answers, and the history behaving like a real loan book.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DelinquencyService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { delinquencyModule } from '../src/delinquency.ts';

describe('delinquency questions', () => {
  const spec = delinquencyModule({} as DelinquencyService);
  const plan = (t: string) => spec.plan!(t, {} as never);
  it('routes collections and credit-risk questions to the right tool', () => {
    expect(plan('What are our roll rates?')).toEqual({ tool: 'dq_rolls', args: {} });
    expect(plan('What is the 30-day cure rate?')).toEqual({ tool: 'dq_rolls', args: {} });
    expect(plan('How are recent vintages performing?')).toEqual({ tool: 'dq_vintages', args: {} });
    expect(plan('Which branches and products are worst?')).toEqual({ tool: 'dq_segments', args: {} });
    expect(plan('Show the largest delinquent auto loans 90+ days')).toEqual({ tool: 'dq_loans', args: { min_days: 90, category: 'Auto' } });
    expect(plan('What is our net charge-off ratio?')).toEqual({ tool: 'dq_losses', args: {} });
    expect(plan('What is our NPL ratio?')).toEqual({ tool: 'dq_losses', args: {} });
    expect(plan('Show delinquency by aging bucket for HELOC')).toEqual({ tool: 'dq_aging', args: { category: 'HELOC' } });
  });

  it('leaves the ratio and its lineage to Analytics', () => {
    expect(spec.request.test('Where does delinquency come from?')).toBe(false);
    expect(spec.request.test('Show delinquency 60+ by branch')).toBe(false);
    expect(spec.request.test('What are our roll rates?')).toBe(true);
  });
});

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

describe.skipIf(!up)('delinquency on the warehouse', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = tenantPool(SCHEMA);
  });
  afterAll(async () => pool.end());
  const one = async (sql: string) => Number(((await pool.query(sql))[0] as Record<string, unknown>[])[0]!.n);

  it('ties 60+ to the loan history, and the buckets add up to the book', async () => {
    const svc = new DelinquencyService(pool);
    const g = await svc.aging();
    const hist = await one(`SELECT SUM(delinquent_60_balance) AS n FROM hist_loan_month WHERE month_end = '${g.month}'`);
    expect(g.delinquent60).toBeCloseTo(hist, -1);
    expect(g.buckets.map((b) => b.bucket)).toEqual(['Current', '30–59 days', '60–89 days', '90–179 days', '180–359 days', '360+ days']);
    expect(g.buckets.reduce((s, b) => s + b.balance, 0)).toBeCloseTo(g.total, 0);
    // A seasoned book: 30-59 is about 1%, 60+ under 1%, and more of 60+ is 60-179 than 180+.
    expect(g.ratio60).toBeGreaterThan(0.5);
    expect(g.ratio60).toBeLessThan(1.2);
    const early = g.buckets[2]!.balance + g.buckets[3]!.balance;
    expect(early).toBeGreaterThan(g.buckets[4]!.balance + g.buckets[5]!.balance);
  });

  it('has roll rates like a real loan book', async () => {
    const r = await new DelinquencyService(pool).rolls();
    const row = (from: string) => r.matrix.find((x) => x.from === from)!.to;
    // Most current loans stay current; a share of 30-day loans cure; most 60-day loans roll on.
    expect(row('Current')['Current']).toBeGreaterThan(98);
    expect(row('30–59 days')['Current']).toBeGreaterThan(20);
    expect(row('60–89 days')['90–179 days']).toBeGreaterThan(35);
    for (const x of r.matrix) expect(Object.values(x.to).reduce((s, v) => s + v, 0)).toBeCloseTo(100, 0);
  });

  it('keeps a branch to its own loans', async () => {
    const svc = new DelinquencyService(pool);
    const loans = await svc.loans({ purviewBranches: ['Westport'], minDays: 30, limit: 50 });
    expect(loans.length).toBeGreaterThan(0);
    expect(new Set(loans.map((l) => l.branch))).toEqual(new Set(['Westport']));
    expect(loans.every((l) => l.days >= 30)).toBe(true);
    const seg = await svc.segments({ purviewBranches: ['Westport'] });
    expect(seg.every((s) => s.branch === 'Westport')).toBe(true);
  });
});

// A bank's charge-offs and nonperforming loans come from its FFIEC Call Report, not a 5300.
const bankUp = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM cr_value LIMIT 1').then(() => true, () => false));
describe.skipIf(!bankUp)('a bank’s losses and nonperforming loans', () => {
  it('reads RI-B and RC-N, and gives the NPL ratio', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const l = (await new DelinquencyService(pool).losses())!;
      expect(l.bank).toBe(true);
      expect(l.netChargeOffs).toBeGreaterThan(0);
      expect(l.ncoRatio).toBeGreaterThan(0);
      expect(l.ncoRatio).toBeLessThan(3);
      expect(l.nonperforming).toBeGreaterThan(0);
      expect(l.nplRatio!).toBeGreaterThan(0);
      expect(l.nplRatio!).toBeLessThan(5);
      expect(l.coverage!).toBeGreaterThan(1);
    } finally {
      await pool.end();
    }
  });
});
