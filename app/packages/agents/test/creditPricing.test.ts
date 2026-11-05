// @vitest-environment node
// P2 depth: each loan's credit at origination (score, loan-to-value, term, commercial risk rating) and
// deposit pricing through the rate cycle (cost of deposits, betas, yield on new loans).
import { describe, expect, it } from 'vitest';
import { AlcoService, IrrService } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { irrModule } from '../src/index.ts';

describe('deposit pricing questions', () => {
  const spec = irrModule({} as IrrService, async () => null);
  const plan = (t: string) => spec.plan(t, {} as never);
  it('go to the pricing answer, and model assumptions still go to the assumptions', () => {
    expect(plan('What’s our deposit beta?')).toEqual({ tool: 'irr_pricing', args: {} });
    expect(plan('How much of the rate cuts have we passed on?')).toEqual({ tool: 'irr_pricing', args: {} });
    expect(plan('What betas does the model assume?')).toEqual({ tool: 'irr_assumptions', args: {} });
  });
});

for (const [schema, tenant, type] of [['dinext_t_test_cu', 'test_cu', 'credit_union'], ['dinext_t_test_bank', 'test_bank', 'bank']] as const) {
  const up = await warehouseAvailable(schema);
  describe.skipIf(!up)(`credit and pricing for ${type}`, () => {
    it('delinquency rises as credit scores fall, and pricing follows risk', async () => {
      const pool = tenantPool(schema);
      try {
        const svc = await SemanticService.create(pool, tenant, type);
        const q = await svc.query({ metrics: ['delinquency_ratio_60_plus', 'average_loan_rate'], dimensions: ['credit_score_band'] }, { canViewSql: false });
        const band = (b: string) => q.rows.find((r) => r.credit_score_band === b)!;
        const order = ['Super prime (740+)', 'Near prime (620–679)', 'Subprime (under 620)'];
        const dq = order.map((b) => Number(band(b).delinquency_ratio_60_plus));
        const rate = order.map((b) => Number(band(b).average_loan_rate));
        expect(dq[0]).toBeLessThan(dq[1]!);
        expect(dq[1]).toBeLessThan(dq[2]!);
        expect(rate[0]).toBeLessThan(rate[2]!);
        const k = await svc.query({ metrics: ['average_credit_score', 'average_ltv', 'subprime_share', 'criticized_loan_ratio'] }, { canViewSql: false });
        const row = k.rows[0]!;
        expect(Number(row.average_credit_score)).toBeGreaterThan(700);
        expect(Number(row.average_credit_score)).toBeLessThan(780);
        expect(Number(row.average_ltv)).toBeGreaterThan(60);
        expect(Number(row.subprime_share)).toBeGreaterThan(1);
        expect(Number(row.criticized_loan_ratio)).toBeGreaterThan(0.5);
        expect(Number(row.criticized_loan_ratio)).toBeLessThan(6);
        // No open installment loan is past its own term.
        const [[over]] = (await pool.query("SELECT COUNT(*) AS n FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL AND term_months IS NOT NULL AND DATE_ADD(open_date, INTERVAL term_months MONTH) < '2026-10-25'")) as unknown as [[{ n: number }]];
        expect(Number(over.n)).toBe(0);
      } finally {
        await pool.end();
      }
    });

    it('measures deposit betas through the cutting cycle, and new-loan yield like for like', async () => {
      const pool = tenantPool(schema);
      try {
        const pr = (await new AlcoService(pool, type).pricing())!;
        expect(pr.marketMoveBp).toBe(-69);
        const beta = (re: RegExp) => pr.products.find((p) => re.test(p.category))!.beta!;
        expect(beta(/^Certificates/)).toBeGreaterThan(0.5);
        expect(beta(/^Checking/)).toBeLessThan(0.1);
        expect(pr.total.repricingBeta!).toBeGreaterThan(0.2);
        expect(pr.total.repricingBeta!).toBeLessThan(0.6);
        expect(pr.likeForLikeBp).not.toBeNull();
        const svc = await SemanticService.create(pool, tenant, type);
        const trend = await svc.query({ metrics: ['cost_of_deposits'], time: { grain: 'month', last: 13 } }, { canViewSql: false });
        const first = Number(trend.rows[0]!.cost_of_deposits);
        const last = Number(trend.rows.at(-1)!.cost_of_deposits);
        expect(last).toBeLessThan(first);
        const nl = await svc.query({ metrics: ['new_loan_yield'], time: { grain: 'month', last: 3 } }, { canViewSql: false });
        expect(Number(nl.rows.at(-1)!.new_loan_yield)).toBeGreaterThan(4);
      } finally {
        await pool.end();
      }
    });
  });
}
