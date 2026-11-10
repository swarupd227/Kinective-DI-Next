// @vitest-environment node
// Basel III capital: risk-weighted assets and the four ratios from the Call Report, the community bank
// leverage ratio beside the full rules, the ratios through the stress test and a what-if. A credit
// union hears about its net worth ratio instead.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockSchema, type Block } from '@dinext/block-schemas';
import { ApprovalStore, BaselService } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { baselAnalyses, baselModule, ModuleGateway, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

for (const [schema, type] of [['dinext_t_test_bank', 'bank'], ['dinext_t_test_cu', 'credit_union']] as const) {
  const up = await warehouseAvailable(schema).then((ok) => ok && tenantPool(schema).query('SELECT 1 FROM cr_value LIMIT 1').then(() => true, () => false));

  describe.skipIf(!up)(`Basel III capital for ${type}`, () => {
    let pool: Pool;
    let spec: ModuleSpec;
    let gateway: ModuleGateway;
    const turn = (text: string, modules = ['basel']): ModuleTurn => ({ runId: 'R-basel', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' }, tenant: { name: 'Test' }, modules });
    const ask = async (text: string, modules?: string[]) => {
      const texts: string[] = [];
      const blocks: Block[] = [];
      const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
      const out = await runModuleOffline(spec, turn(text, modules), { gateway }, sink);
      return { text: texts.join(' '), blocks, out };
    };

    beforeAll(() => {
      pool = tenantPool(schema);
      spec = baselModule({ pool, institutionType: type });
      gateway = new ModuleGateway(new ApprovalStore(pool), [spec]);
    });
    afterAll(async () => {
      await pool.end();
    });

    if (type === 'credit_union') {
      it('explains that Basel III is for banks, with the net worth ratio', async () => {
        expect(await new BaselService(pool, type).analysis()).toBeNull();
        const r = await ask('What are our Basel III ratios?');
        expect(r.out.outcome).toBe('answer');
        expect(r.text).toMatch(/apply to banks/);
        expect(r.text).toMatch(/net worth ratio\*\* under NCUA/);
      });
      return;
    }

    it('weights every exposure and builds capital and the four ratios', async () => {
      const a = (await new BaselService(pool, type).analysis())!;
      const n = a.now;
      // Risk-weighted assets add up, sit below total assets and above the loans' half-weighted floor.
      expect(n.rwa).toBeCloseTo(n.lines.reduce((s, l) => s + l.rwa, 0), 0);
      expect(n.rwa).toBeLessThan(n.totalAssets);
      expect(n.density).toBeGreaterThan(40);
      // CET1 is equity less AOCI, goodwill and other intangibles; tier 2 is the allowance within 1.25% of risk-weighted assets.
      expect(n.capital.cet1).toBeCloseTo(n.capital.equity - n.capital.aoci - n.capital.deductions, 0);
      if (type === 'bank') expect(n.capital.deductions).toBeGreaterThan(0);
      expect(n.capital.allowanceInTier2).toBeLessThanOrEqual(n.rwa * 0.0125 + 1);
      expect(n.capital.totalCapital).toBeCloseTo(n.capital.tier1 + n.capital.tier2, 0);
      const [cet1, tier1, total, leverage] = n.ratios;
      expect(cet1!.pct).toBeLessThanOrEqual(tier1!.pct);
      expect(tier1!.pct).toBeLessThan(total!.pct);
      expect(leverage!.pct).toBeCloseTo((n.capital.tier1 / n.leverageAssets) * 100, 6);
      expect(n.bufferPct).toBeCloseTo(Math.min(cet1!.pct - 4.5, tier1!.pct - 6, total!.pct - 8), 6);
      expect(n.cblr.elected).toBe(true);
      expect(a.quarters.length).toBeGreaterThan(1);
      // The severe stress test takes every ratio lower than baseline.
      const [base, , severe] = a.stress!;
      expect(severe!.lowCet1.cet1Pct).toBeLessThan(base!.lowCet1.cet1Pct);
      expect(severe!.lowLeverage.leveragePct).toBeLessThan(n.ratios[3]!.pct);
    });

    it('answers the ratios, capital, risk-weighted assets, the trend, the CBLR and the stress test', async () => {
      const o = await ask('What are our Basel III ratios?');
      expect(o.text).toMatch(/CET1 is \*\*\d+\.\d\d%\*\*/);
      expect(o.text).toMatch(/not a filed RC-R Part II/);
      expect(o.blocks[0]!.type).toBe('table');
      expect((await ask('What counts as our tier 2 capital?')).text).toMatch(/total capital is \$/);
      expect((await ask('What drives our risk-weighted assets?')).text).toMatch(/Risk-weighted assets are \*\*\$/);
      expect((await ask('How have our risk-based ratios moved by quarter?')).text).toMatch(/^From Q\d \d{4} to Q\d \d{4}, CET1/);
      expect((await ask('Should we stay in the CBLR or use the full Basel rules?')).text).toMatch(/Under the CBLR the bank needs a leverage ratio over 8%.*board’s decision/);
      expect((await ask('What happens to our risk-based ratios in a severe recession?')).text).toMatch(/severely adverse\*\* scenario CET1 falls to/);
      expect((await ask('What does the Basel III estimate assume?')).blocks[0]!.type).toBe('table');
    });

    it('works out a what-if: more CRE lowers every ratio, Treasuries leave the risk-based ratios alone', async () => {
      const a = (await new BaselService(pool, type).analysis())!;
      const cre = new BaselService(pool, type).whatIf(a.now, 100, 20e6);
      for (let i = 0; i < 4; i++) expect(cre.ratios[i]!.pct).toBeLessThan(a.now.ratios[i]!.pct);
      const ust = new BaselService(pool, type).whatIf(a.now, 0, 20e6);
      expect(ust.ratios[0]!.pct).toBeCloseTo(a.now.ratios[0]!.pct, 6);
      expect(ust.ratios[3]!.pct).toBeLessThan(a.now.ratios[3]!.pct);
      expect(spec.request.test('What would $20M more CRE loans do to our capital ratios?')).toBe(true);
      const r = await ask('What would $20M more CRE loans do to our capital ratios?');
      expect(r.out.toolCalls[0]!.name).toBe('bas_whatif');
      expect(r.text).toMatch(/Adding \*\*\$20\.0M of commercial real estate loans\*\* \(risk weight 100%\)/);
      expect((await ask('What if we run off $10M of auto loans?')).text).toMatch(/Running off \*\*\$10\.0M of auto loans/);
    });

    it('gives the same CET1 ratio and risk-weighted assets from the catalog, every quarter', async () => {
      const a = (await new BaselService(pool, type).analysis())!;
      const svc = await SemanticService.create(pool, 'test_bank', type);
      const now = await svc.query({ metrics: ['cet1_ratio', 'risk_weighted_assets'] }, { canViewSql: false });
      expect(Number(now.rows[0]!.cet1_ratio)).toBeCloseTo(a.now.ratios[0]!.pct, 4);
      expect(Number(now.rows[0]!.risk_weighted_assets)).toBeCloseTo(a.now.rwa, -1);
      const trend = await svc.query({ metrics: ['cet1_ratio'], time: { grain: 'quarter', last: 5 } }, { canViewSql: false });
      expect(trend.rows.map((r) => Number(r.cet1_ratio).toFixed(4))).toEqual(a.quarters.slice(-5).map((q) => q.ratios[0]!.pct.toFixed(4)));
      // Branch purview sees no institution-wide capital.
      const branch = await svc.query({ metrics: ['cet1_ratio'] }, { canViewSql: false, purviewBranches: ['Westport'] }).catch(() => null);
      expect(branch?.rows[0]?.cet1_ratio ?? null).toBeNull();
    });

    it('builds every report section as a valid block, with takes short enough for the report', async () => {
      const a = baselAnalyses({ pool, institutionType: type });
      for (const key of a.keys) {
        const { block, take } = await a.run(key, 'R-basel-report');
        expect(blockSchema.safeParse(block).success, key).toBe(true);
        if (take) expect(take.headline.length, key).toBeLessThanOrEqual(300);
      }
    });

    it('is for finance and executives, and leaves the plain leverage ratio to the Call Report agent', async () => {
      expect((await ask('What are our Basel III ratios?', ['tasks'])).out.outcome).not.toBe('answer');
      expect(spec.request.test('What’s our leverage ratio?')).toBe(false);
      expect(spec.request.test('Are we on the CBLR?')).toBe(false);
      expect(spec.request.test('Should we leave the CBLR?')).toBe(true);
      expect(spec.request.test('Are we well capitalized?')).toBe(true);
      expect(spec.request.test('Show our risk-weighted assets')).toBe(true);
      expect(spec.request.test('Run the stress test')).toBe(false);
      expect(spec.request.test('What is our CET1 ratio?')).toBe(true);
      // A chart goes to Analytics, which draws the catalog's CET1 ratio.
      expect(spec.request.test('Chart our CET1 ratio over the last five quarters')).toBe(false);
    });
  });
}
