// @vitest-environment node
// ESP phase 3: lien positions, participations and the FHLB's qualifying collateral, and the liquidity
// model lending against eligible loans rather than an assumed share of them.
import { describe, expect, it } from 'vitest';
import { CollateralService, LiquidityService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { liquidityModule } from '../src/index.ts';

describe('routing', () => {
  it('sends collateral and participations to liq_collateral, without taking the capacity or CRE questions', () => {
    const liq = liquidityModule({} as LiquidityService);
    const plan = (t: string) => (liq.plan(t, {} as never) as { tool?: string }).tool;
    for (const q of ['How much of our collateral is eligible for the FHLB?', 'Which loans can’t be pledged to the FHLB?', 'Show our qualifying collateral report', 'Show our loan participations', 'What are the lien positions on our home equity lines?']) {
      expect(liq.request.test(q), q).toBe(true);
      expect(plan(q), q).toBe('liq_collateral');
    }
    expect(plan('How much could we borrow tomorrow?')).toBe('liq_capacity');
    expect(plan('What’s our FHLB capacity?')).toBe('liq_capacity');
    expect(plan('What assumptions does the liquidity model use?')).toBe('liq_assumptions');
    expect(liq.request.test('Should we sell office participations to cut CRE concentration?')).toBe(false);
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cdm_loan_collateral LIMIT 1').then(() => true, () => false));
  const type = DB.endsWith('bank') ? 'bank' : 'credit_union';
  describe.skipIf(!up)(`${DB}: phase 3`, () => {
    const pool = tenantPool(DB);
    const one = async (sql: string) => Number(((await pool.query(sql)) as unknown as [{ n: unknown }[]])[0][0]!.n ?? 0);

    it('gives every open real-estate loan a lien and a collateral category, and keeps the book’s own balance', async () => {
      expect(await one("SELECT COUNT(*) AS n FROM cdm_loan l LEFT JOIN cdm_loan_collateral c ON c.loan_id = l.loan_id WHERE l.loan_category IN ('Mortgage','HELOC','Commercial Real Estate') AND l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0 AND (c.fhlb_category IS NULL OR c.lien_position_id IS NULL)")).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM cdm_loan_collateral c JOIN cdm_loan l ON l.loan_id = c.loan_id WHERE l.loan_category = 'Mortgage' AND c.lien_position_id <> 1")).toBe(0);
      expect(await one('SELECT COUNT(*) AS n FROM cdm_loan_collateral c JOIN cdm_loan l ON l.loan_id = c.loan_id WHERE ABS(c.retained_balance - l.balance) > 0.01 OR c.gross_balance < c.retained_balance - 0.01')).toBe(0);
    });

    it('ranks every reason a loan can’t be pledged, from the loan’s own record', async () => {
      // Each reason is true of the loan it is on.
      expect(await one('SELECT COUNT(*) AS n FROM cdm_fhlb_ineligibility i JOIN cdm_loan l ON l.loan_id = i.loan_id WHERE i.type_id = 1 AND l.days_delinquent < 60')).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_loan_collateral c ON c.loan_id = l.loan_id LEFT JOIN cdm_fhlb_ineligibility i ON i.loan_id = l.loan_id AND i.type_id = 1 WHERE c.fhlb_category IS NOT NULL AND l.days_delinquent >= 60 AND i.loan_id IS NULL")).toBe(0);
      expect(await one('SELECT COUNT(*) AS n FROM cdm_fhlb_ineligibility i LEFT JOIN cdm_insider_loan il ON il.loan_id = i.loan_id WHERE i.type_id = 3 AND il.loan_id IS NULL')).toBe(0);
      expect(await one('SELECT COUNT(*) AS n FROM cdm_fhlb_ineligibility i LEFT JOIN cdm_fhlb_manual_ineligibility m ON m.manual_id = i.manual_id WHERE i.type_id = 6 AND m.manual_id IS NULL')).toBe(0);
      const r = (await new CollateralService(pool).report())!;
      expect(r.eligiblePct).toBeGreaterThan(80);
      expect(r.eligiblePct).toBeLessThan(99);
      // The first reasons add up to what isn't eligible.
      expect(r.reasons.reduce((s, x) => s + x.balance, 0)).toBeCloseTo(r.balance - r.eligible, 0);
      expect(r.fixable.length).toBeGreaterThan(0);
      if (type === 'bank') {
        expect(r.participations.sold!.sold).toBeGreaterThan(0);
        expect(r.participations.purchased!.loans).toBeGreaterThan(0);
        expect(r.reasons.find((x) => x.code === 'PURCHASED')!.balance).toBeGreaterThan(0);
      } else expect(r.participations.sold).toBeNull();
    });

    it('lends against eligible loans in the liquidity model, and the 20% of assets cap still binds', async () => {
      const a = await new LiquidityService(pool, type).analysis();
      const fhlb = a.capacity.find((c) => c.source === 'FHLB advances')!;
      const q = (await new CollateralService(pool).fhlb())!;
      expect(fhlb.collateralValue).toBeCloseTo(q.eligible, 0);
      expect(fhlb.lendable).toBeCloseTo(a.totalAssets * 0.2, 0);
      expect(q.lendable).toBeGreaterThan(fhlb.lendable);
      expect(a.assumptions.find(([k]) => k === 'FHLB lendable values')![1]).toMatch(/loan by loan/);
    });
  });
}
