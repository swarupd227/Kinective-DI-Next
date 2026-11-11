// @vitest-environment node
// Predictive Analytics across the book: products to suggest by deposit balance, the people behind a
// count, and whether earlier suggestions were taken up.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { BALANCE_BANDS, PredictiveService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { PREDICTIVE_REQUEST, bandIn, predictiveModule, predictiveQuestion, productIn } from '../src/index.ts';

describe('predictive questions', () => {
  const spec = predictiveModule({} as PredictiveService);
  const plan = (t: string) => spec.plan(t, {} as never);
  it('route to the right tool', () => {
    const cases: [string, unknown][] = [
      ['Show products to suggest by balance', { tool: 'pred_suggest', args: {} }],
      ['Which suggestions were taken up?', { tool: 'pred_success', args: {} }],
      ['Show successful suggestions', { tool: 'pred_success', args: {} }],
      ['Who with $10,000+ is likely to open a mortgage?', { tool: 'pred_people', args: { product: 'First mortgage', band: '$10,000+' } }],
      ['Which members are likely to open a HELOC?', { tool: 'pred_people', args: { product: 'HELOC' } }],
    ];
    for (const [q, want] of cases) {
      expect(PREDICTIVE_REQUEST.test(q), q).toBe(true);
      expect(plan(q), q).toEqual(want);
    }
    // One person's next best product stays with Relationship Manager.
    expect(PREDICTIVE_REQUEST.test('What’s the next best product for Suzanne Jackson?')).toBe(false);
    expect(productIn('a car loan')).toBe('Auto loan');
    expect(bandIn('over $1,000')).toBe('$1,000 to $9,999');
    expect(predictiveQuestion('How accurate is the next best product model?')).toBe('success');
  });
});

const up = await warehouseAvailable('dinext_t_test_cu').then((ok) => ok && tenantPool('dinext_t_test_cu').query('SELECT 1 FROM cdm_suggestion_history LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('a credit union’s suggestions across the book', () => {
  it('counts suggestions by balance, lists the people, and shows higher scores convert more', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    try {
      const svc = new PredictiveService(pool);
      const s = await svc.suggestions({});
      expect(s.total).toBeGreaterThan(1000);
      for (const p of s.products) expect(BALANCE_BANDS.reduce((t, b) => t + p.byBand[b], 0)).toBe(p.total);
      // A count and the list behind it agree, and purview narrows both.
      const top = s.products[0]!;
      const people = await svc.people(top.product, '$10,000+', {}, 5);
      expect(people.total).toBe(top.byBand['$10,000+']);
      const westport = await svc.suggestions({ purviewBranches: ['Westport'] });
      expect(westport.total).toBeLessThan(s.total);
      // Earlier runs: higher scores are taken up more often.
      const x = await svc.successes({});
      expect(x.runs).toHaveLength(6);
      expect(x.total.opened).toBeGreaterThan(0);
      expect(x.scores[0]!.ratePct).toBeGreaterThan(x.scores.at(-1)!.ratePct);

      const ctx = { user: { id: 'u', name: 'Dana Lee' }, modules: ['predictive'], runId: 'r', threadId: 't' };
      const spec = predictiveModule(svc);
      for (const [name, args] of [['pred_suggest', {}], ['pred_people', { product: 'HELOC' }], ['pred_success', {}]] as const) {
        const out = (await spec.tools.find((t) => t.name === name)!.run(args as never, ctx)) as { text: string; blocks: unknown[] };
        expect(out.text.length, name).toBeGreaterThan(40);
        for (const b of out.blocks) expect(blockSchema.safeParse(b).success, name).toBe(true);
      }
      await expect(spec.tools[0]!.run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/isn’t part of your DI access/);
    } finally {
      await pool.end();
    }
  });
});
