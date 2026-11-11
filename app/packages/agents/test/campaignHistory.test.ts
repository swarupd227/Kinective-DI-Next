// @vitest-environment node
// Campaign Success history: return on spend by quarter and channel, what campaigns brought in by product
// and channel, sales by marketing source each day, and each campaign's responses week by week.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { CampaignService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { campaignModule } from '../src/index.ts';

describe('campaign history questions', () => {
  it('route to the right tool', () => {
    const spec = campaignModule({} as CampaignService);
    const plan = (q: string) => spec.plan(q, {} as never);
    expect(plan('How has campaign ROI changed by quarter?')).toEqual({ tool: 'cmp_roi_history', args: {} });
    expect(plan('What did campaigns bring in by product and channel?')).toEqual({ tool: 'cmp_product_channel', args: {} });
    expect(plan('Show sales by marketing source')).toEqual({ tool: 'cmp_sources', args: {} });
    expect(plan('Show the campaign timeline')).toEqual({ tool: 'cmp_timeline', args: {} });
    expect(plan('Which campaigns paid for themselves?')).toEqual({ tool: 'cmp_roi', args: {} });
    expect(spec.request.test('Show sales by marketing source')).toBe(true);
  });
});

const up = await warehouseAvailable('dinext_t_test_cu').then((ok) => ok && tenantPool('dinext_t_test_cu').query('SELECT 1 FROM cmp_attribution LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('the credit union’s campaign history', () => {
  it('spans eight quarters, credits accounts to campaigns, and splits daily sales by source', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    try {
      const svc = new CampaignService(pool);
      const h = await svc.history();
      expect(h.quarters.length).toBeGreaterThanOrEqual(8);
      expect(h.quarters[0]!.quarter).toBe('Q4 2024');
      const pc = await svc.productByChannel();
      expect(pc.reduce((s, r) => s + r.accounts, 0)).toBeGreaterThan(100);
      const s = await svc.sources(30);
      expect(s.days).toHaveLength(30);
      for (const d of s.days) expect(d.none + Object.values(d.byChannel).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(d.total > 0 ? d.total - 0 : 0);
      const t = await svc.timeline();
      expect(t.some((c) => c.accounts > 0)).toBe(true);

      const spec = campaignModule(svc);
      const ctx = { user: { id: 'u', name: 'Dana Lee' }, modules: ['campaigns'], runId: 'r', threadId: 't' };
      for (const name of ['cmp_roi_history', 'cmp_product_channel', 'cmp_sources', 'cmp_timeline']) {
        const out = (await spec.tools.find((x) => x.name === name)!.run({} as never, ctx)) as { text: string; blocks: unknown[] };
        expect(out.text.length, name).toBeGreaterThan(40);
        for (const b of out.blocks) expect(blockSchema.safeParse(b).success, name).toBe(true);
      }
    } finally {
      await pool.end();
    }
  });
});
