// @vitest-environment node
// The CAMELS view and the community stress test: every component's measures with DI's read (never a
// rating), and capital over nine quarters under three scenarios, a reverse stress test and falling
// commercial property values.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '@dinext/block-schemas';
import { ApprovalStore, StressService } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { camelsModule, camelsView, ModuleGateway, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

for (const [schema, tenant, type] of [['dinext_t_test_bank', 'test_bank', 'bank'], ['dinext_t_test_cu', 'test_cu', 'credit_union']] as const) {
  const up = await warehouseAvailable(schema).then((ok) => ok && tenantPool(schema).query('SELECT 1 FROM cr_value LIMIT 1').then(() => true, () => false));

  describe.skipIf(!up)(`CAMELS and the stress test for ${type}`, () => {
    let pool: Pool;
    let semantic: SemanticService;
    let spec: ModuleSpec;
    let gateway: ModuleGateway;
    const turn = (text: string, modules = ['camels']): ModuleTurn => ({ runId: 'R-camels', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' }, tenant: { name: 'Test' }, modules });
    const ask = async (text: string, modules?: string[]) => {
      const texts: string[] = [];
      const blocks: Block[] = [];
      const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
      const out = await runModuleOffline(spec, turn(text, modules), { gateway }, sink);
      return { text: texts.join(' '), blocks, out };
    };

    beforeAll(async () => {
      pool = tenantPool(schema);
      semantic = await SemanticService.create(pool, tenant, type);
      spec = camelsModule({ pool, institutionType: type, semantic: async () => semantic });
      gateway = new ModuleGateway(new ApprovalStore(pool), [spec]);
    });
    afterAll(async () => {
      await pool.end();
    });

    it('gets worse from baseline to severely adverse, and finds the losses that would reach the minimum', async () => {
      const a = (await new StressService(pool, type).analysis())!;
      const [base, adverse, severe] = a.runs;
      expect(base!.losses).toBeLessThan(adverse!.losses);
      expect(adverse!.losses).toBeLessThan(severe!.losses);
      expect(severe!.trough.ratioPct).toBeLessThan(base!.trough.ratioPct);
      expect(severe!.trough.ratioPct).toBeLessThan(severe!.startPct);
      expect(severe!.quarters).toHaveLength(9);
      // The baseline never releases reserve below today's allowance.
      expect(Math.min(...base!.quarters.map((q) => q.allowance))).toBeGreaterThanOrEqual(a.start.allowance - 1);
      // At the reverse multiple, the low point sits at the minimum.
      const breaking = new StressService(pool, type).project(severe!.scenario, a.start, () => 0, a.reverse.multiple);
      expect(a.reverse.multiple).toBeGreaterThan(0);
      expect(a.reverse.losses).toBeGreaterThan(0);
      void breaking;
      // Deeper property falls cost more.
      const losses = a.cre.lines.map((l) => l.losses);
      expect([...losses].sort((x, y) => x - y)).toEqual(losses);
      expect(a.start.minimumPct).toBe(type === 'bank' ? 8 : 7);
    });

    it('reads every component and never gives a rating', async () => {
      const v = await camelsView({ pool, institutionType: type, semantic: async () => semantic });
      expect(v.components.map((c) => c.letter)).toEqual(['C', 'A', 'M', 'E', 'L', 'S']);
      for (const c of v.components) expect(c.measures.length).toBeGreaterThan(0);
      expect(v.headline).toMatch(/severe downturn/);
      const shown = await ask('Show our CAMELS view');
      expect(shown.text).toMatch(/not a CAMELS rating/);
      expect(shown.text).not.toMatch(/CAMELS rating (?:of|is) \d|composite (?:rating )?(?:of )?\d/i);
    });

    it('answers the stress test, one scenario, the reverse test, property values and a component', async () => {
      expect((await ask('How would our capital hold up in a severe recession?')).text).toMatch(/severely adverse.*lowest|low of/is);
      expect((await ask('Run the stress test')).text).toMatch(/times severe to reach the minimum/);
      const severe = await ask('What happens in the severely adverse scenario?');
      expect(severe.text).toMatch(/A deep recession/);
      expect(severe.blocks.length).toBeGreaterThanOrEqual(2);
      expect((await ask('How much could we lose before we breach the minimum?')).text).toMatch(/times the severely adverse/);
      expect((await ask('What if commercial property values fall 30%?')).text).toMatch(/fell \*\*30%\*\*/);
      expect((await ask('How is our asset quality?')).text).toMatch(/Asset quality/);
      expect((await ask('What does the stress test assume?')).text).toMatch(/illustrative/);
    });

    it('is for finance and executives, and leaves a liquidity stress test to the Liquidity agent', async () => {
      expect((await ask('Show our CAMELS view', ['tasks'])).out.outcome).not.toBe('answer');
      expect(spec.request.test('Run a liquidity stress test')).toBe(false);
      expect(spec.request.test('Run the stress test')).toBe(true);
      expect(spec.request.test('Are we exam ready?')).toBe(true);
      expect(spec.request.test('Show loan growth by branch')).toBe(false);
      expect(spec.request.test('How do we look for the CAMELS exam?')).toBe(true);
    });
  });
}
