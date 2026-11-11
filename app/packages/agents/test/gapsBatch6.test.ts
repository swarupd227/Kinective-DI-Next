// @vitest-environment node
// Home's Sales Override Approvals queue, and the cross-sell, attrition and financial statement stock
// report sections.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { CrossSellService, GlService, PredictiveService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { SALES_OVERRIDE_REQUEST, STOCK_EXTRA_SECTIONS, salesOverridesModule, stockExtraAnalyses } from '../src/index.ts';

describe('routing', () => {
  it('sends override questions to Sales Overrides', () => {
    for (const q of ['Show the sales overrides waiting for review', 'Which adjustments are pending?']) expect(SALES_OVERRIDE_REQUEST.test(q), q).toBe(true);
    expect(SALES_OVERRIDE_REQUEST.test('Show my scorecard')).toBe(false);
  });
});

const DB = 'dinext_t_test_cu';
const up = await warehouseAvailable(DB);
describe.skipIf(!up)('against the warehouse', () => {
  const pool = tenantPool(DB);
  it('lists overrides waiting for someone else to review', async () => {
    const spec = salesOverridesModule(pool);
    const ctx = { user: { id: 'user:6000', name: 'Dana Lee' }, modules: ['overrides'], runId: 'r', threadId: 't' };
    const out = (await spec.tools[0]!.run({} as never, ctx)) as { text: string; blocks?: unknown[] };
    expect(out.text).toMatch(/waiting for your review|No sales overrides/);
    for (const b of out.blocks ?? []) expect(blockSchema.safeParse(b).success).toBe(true);
    const today = await spec.today!(ctx as never);
    if (out.blocks?.length) expect(today?.ask).toBe('Show the sales overrides waiting for review');
  });

  it('computes every new stock report section as a valid block', async () => {
    const a = stockExtraAnalyses({ crossSell: new CrossSellService(pool), predictive: new PredictiveService(pool), gl: new GlService(pool) }, 'member');
    for (const key of STOCK_EXTRA_SECTIONS) {
      const { block } = await a.run(key, 'run_test');
      const ok = blockSchema.safeParse(block);
      expect(ok.success, `${key}: ${ok.success ? '' : JSON.stringify(ok.error.issues[0])}`).toBe(true);
    }
    const s = await new CrossSellService(pool).summary({});
    expect(s.perPerson).toBeGreaterThan(1);
    expect(s.distribution.reduce((x, d) => x + d.people, 0)).toBe(s.people);
  });
});
