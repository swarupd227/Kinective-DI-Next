// @vitest-environment node
// Concentration: CRE against the interagency guidance from the Call Report, and property type, office,
// geography, industry and relationships from the commercial loan detail, against the board's limits.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { CONCENTRATION_LIMITS, ConcentrationService, type CallReportService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { CONCENTRATION_REQUEST, concentrationAnalyses, concentrationModule, concentrationQuestion, ffiecModule } from '../src/index.ts';

describe('concentration questions', () => {
  it('route here, and leave the Call Report’s CRE ratio with the Call Report agent', () => {
    const cases: [string, string][] = [
      ['Concentration Report: over-exposed to CRE, office, one geography, one industry?', 'office'],
      ['Show me our concentrations', 'overview'],
      ['How exposed are we to office loans?', 'office'],
      ['Which industries are we most concentrated in?', 'industry'],
      ['What’s our geographic concentration?', 'geography'],
      ['Show our largest relationships against the legal lending limit', 'relationships'],
      ['Break down CRE by property type', 'property'],
    ];
    for (const [q, question] of cases) {
      expect(CONCENTRATION_REQUEST.test(q), q).toBe(true);
      expect(concentrationQuestion(q), q).toBe(question);
    }
    expect(CONCENTRATION_REQUEST.test('What is our CRE concentration?')).toBe(false);
    expect(ffiecModule({} as CallReportService).request.test('What is our CRE concentration?')).toBe(true);
    expect(CONCENTRATION_REQUEST.test('What would $20M more CRE loans do to our capital ratios?')).toBe(false);
  });
});

const up = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM cdm_loan_detail LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('a bank’s concentrations', () => {
  it('ties to the Call Report, measures office, county, industry and relationships, and builds the report', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const svc = new ConcentrationService(pool);
      const a = (await svc.analysis())!;
      const r = a.regulatory;
      expect(r.crePct).toBeCloseTo(((r.construction + r.multifamily + r.otherNonres) / r.capital) * 100, 6);
      expect(r.crePct).toBeLessThan(CONCENTRATION_LIMITS.creGuidancePct);
      // The loan detail's property types add up to the CRE book, and investor office is close to its limit.
      const [cre] = (await pool.query("SELECT SUM(balance) AS b FROM cdm_loan WHERE loan_category = 'Commercial Real Estate' AND close_date IS NULL AND charge_off_date IS NULL AND balance > 0")) as unknown as [{ b: number }[]];
      expect(a.creTotal).toBeCloseTo(Number(cre[0]!.b), 0);
      const office = a.property.find((p) => p.type === 'Office')!;
      expect(office.status).toBe('Watch');
      expect(office.stressShortfall).toBeGreaterThan(0);
      expect(a.officeMaturities.reduce((s, m) => s + m.balance, 0)).toBeGreaterThan(0);
      // Counties add up to the whole book; out-of-state lending is small.
      expect(a.geography.reduce((s, g) => s + g.balance, 0)).toBeCloseTo(a.totalLoans, 0);
      expect((a.outOfMarket / a.totalLoans) * 100).toBeLessThan(CONCENTRATION_LIMITS.outOfMarketPctOfLoans);
      expect(a.industry[0]!.balance).toBeGreaterThanOrEqual(a.industry[1]!.balance);
      expect(a.relationships[0]!.balance).toBeLessThan(a.legal);
      expect(a.lines[0]!.status).not.toBe('Within');

      const spec = concentrationModule(svc);
      const ctx = { user: { id: 'u', name: 'Elena Ortiz' }, modules: ['concentration'], runId: 'r', threadId: 't' };
      const o = (await spec.tools[0]!.run({ question: 'office' } as never, ctx)) as { text: string; blocks: unknown[] };
      expect(o.text).toMatch(/^Investor office is \*\*\$\d+\.\dM\*\* across \d+ loans, \*\*\d+\.\d%\*\* of tier 1 capital plus the allowance against the board’s 50% limit: close to it/);
      expect(o.blocks).toHaveLength(3);
      const all = (await spec.tools[0]!.run({} as never, ctx)) as { text: string };
      expect(all.text).toMatch(/Non-owner-occupied CRE is \*\*\d+%\*\* of tier 1 capital plus the allowance against the guidance’s 300%/);
      await expect(spec.tools[0]!.run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/isn’t part of your DI access/);
      const an = concentrationAnalyses(svc);
      for (const key of an.keys) {
        const { block, take } = await an.run(key, 'R-conc');
        expect(blockSchema.safeParse(block).success, key).toBe(true);
        if (take) expect(take.headline.length, key).toBeLessThanOrEqual(300);
      }
    } finally {
      await pool.end();
    }
  });
});
