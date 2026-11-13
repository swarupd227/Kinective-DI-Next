// @vitest-environment node
// What ESP phase 1's tables are used for beyond Member 360: nothing is sold to someone who has died;
// campaigns leave out the deceased and those who opted out of marketing; liquidity shows what borrowers
// could still draw on their lines; rate risk shows fixed and variable loans against the model.
import { describe, expect, it } from 'vitest';
import { CampaignService, IrrService, LiquidityService, LoanGrowthService, PredictiveService, RelationshipService } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { irrModule, liquidityModule } from '../src/index.ts';

describe('routing', () => {
  it('sends unused lines to Liquidity and fixed or variable to Interest Rate Risk, without taking their old questions', () => {
    const liq = liquidityModule({} as LiquidityService);
    const plan = (t: string) => liq.plan(t, {} as never) as { tool?: string };
    expect(liq.request.test('What are our unused commitments?')).toBe(true);
    expect(plan('What are our unused commitments?').tool).toBe('liq_commitments');
    expect(plan('How much could borrowers still draw on their lines?').tool).toBe('liq_commitments');
    expect(plan('How much could we borrow tomorrow?').tool).toBe('liq_capacity');
    expect(plan('What does our corporate credit union line give us?').tool).toBe('liq_capacity');
    const irr = irrModule({} as IrrService);
    expect(irr.request.test('How much of our loans are fixed vs variable?')).toBe(true);
    expect((irr.plan('How much of our loans are fixed vs variable?', {} as never) as { tool?: string }).tool).toBe('irr_rate_types');
    expect((irr.plan('Show the repricing gap', {} as never) as { tool?: string }).tool).toBe('irr_gap');
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cdm_loan_terms LIMIT 1').then(() => true, () => false));
  const type = DB.endsWith('bank') ? 'bank' : 'credit_union';
  describe.skipIf(!up)(`${DB}: phase 1 in use`, () => {
    const pool = tenantPool(DB);
    const ids = async (sql: string) => ((await pool.query(sql)) as unknown as [{ id: number }[]])[0].map((r) => Number(r.id));

    it('sells nothing to someone who has died, and leaves them off retention lists', async () => {
      const dead = new Set(await ids('SELECT party_id AS id FROM cdm_party_detail WHERE deceased_date IS NOT NULL'));
      if (!dead.size) return; // The bank's demo customers are all under 63.
      const rel = new RelationshipService(pool, DB.replace('dinext_t_', ''), type);
      const [withSuggestion] = await ids(`SELECT s.party_id AS id FROM cdm_suggestion s JOIN cdm_party_detail d ON d.party_id = s.party_id WHERE d.deceased_date IS NOT NULL AND s.likelihood >= 6 ORDER BY s.party_id LIMIT 1`);
      const p = await rel.profile(withSuggestion!, {});
      expect(p.opportunities).toEqual([]);
      expect(rel.nextBestConversation(p).map((t) => t.kind).filter((k) => k === 'product_opportunity' || k === 'retention_risk' || k === 'digital_gap')).toEqual([]);
      const risk = await rel.atRisk({}, 5000);
      expect(risk.items.filter((x) => dead.has(x.partyId))).toEqual([]);
      const pred = new PredictiveService(pool);
      const s = await pred.suggestions({});
      const people = await pred.people(s.products[0]!.product, null, {}, 100_000);
      expect(people.items.filter((x) => dead.has(x.partyId))).toEqual([]);
    });

    it('leaves the deceased and those who opted out out of campaigns, counted', async () => {
      const cmp = new CampaignService(pool);
      const category = type === 'bank' ? 'Auto' : 'HELOC';
      const a = await cmp.audience(category, {});
      expect(a.size).toBe(a.found - a.deceased - a.optOut - a.recent);
      expect(a.optOut).toBeGreaterThan(0);
      if (type === 'credit_union') expect(a.deceased).toBeGreaterThan(0);
      const m = await cmp.audienceMembers(category, {});
      const blocked = new Set(await ids('SELECT party_id AS id FROM cdm_party_detail WHERE deceased_date IS NOT NULL OR marketing_opt_out = 1'));
      expect(m.members.filter((x) => blocked.has(x.partyId))).toEqual([]);
      if (type === 'credit_union') {
        const lg = await new LoanGrowthService(pool).prospects({});
        expect(lg.excluded.optOut).toBeGreaterThan(0);
        expect(lg.prospects.filter((x) => blocked.has(x.partyId))).toEqual([]);
      }
    });

    it('shows what borrowers could still draw, matching the semantic figure, beside the stress test', async () => {
      const a = await new LiquidityService(pool, type).analysis();
      expect(a.commitments).not.toBeNull();
      const svc = await SemanticService.create(pool, DB.replace('dinext_t_', ''), type);
      const unused = Number((await svc.query({ metrics: ['unused_commitments'] }, { canViewSql: false })).rows[0]!.unused_commitments);
      expect(a.commitments!.unused).toBeCloseTo(unused, 0);
      expect(a.commitments!.draw30).toBeCloseTo(unused * 0.1, 0);
    });

    it('splits loans into fixed and variable, totals to the book, and flags where the model assumes otherwise', async () => {
      const r = (await new IrrService(pool).rateTypes())!;
      const svc = await SemanticService.create(pool, DB.replace('dinext_t_', ''), type);
      const loans = Number((await svc.query({ metrics: ['loan_balance'] }, { canViewSql: false })).rows[0]!.loan_balance);
      expect(r.total).toBeCloseTo(loans, 0);
      // Commercial loans are partly variable, which the model treats as fixed.
      expect(r.byCategory.some((x) => x.differs && x.modelAssumes === 'Fixed')).toBe(true);
      // Cards and home equity lines are variable, as the model assumes.
      expect(r.byCategory.filter((x) => /Credit Card|HELOC/.test(x.category)).every((x) => !x.differs)).toBe(true);
    });
  });
}
