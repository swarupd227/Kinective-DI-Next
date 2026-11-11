// @vitest-environment node
// Monte Carlo on capital and earnings: thousands of random economies through the stress test's model,
// as a range and a chance. Seeded, so the same data gives the same answer; the written severe scenario
// sits in the bad tail; and questions about chances go to it, while "run the stress test" stays with
// the stress test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, AttritionModelService, MonteCarloService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, SIMULATION_REQUEST, attritionModule, camelsModule, runModuleOffline, simulationModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('which questions the simulation takes', () => {
  it('takes chances and ranges, and leaves the rest', () => {
    for (const q of ['Run a Monte Carlo on capital', 'What’s the chance capital falls below the minimum?', 'What is the probability we breach the leverage ratio?', 'How likely are we to lose money next year?', 'Simulate our capital over the next two years', 'What do the worst 5% of paths have in common?']) expect(SIMULATION_REQUEST.test(q), q).toBe(true);
    for (const q of ['Run the stress test', 'What is our capital ratio?', 'What is the chance of leaving for Michael Adams?', 'Who does the attrition model say will leave?']) expect(SIMULATION_REQUEST.test(q), q).toBe(false);
  });
});

for (const [schema, type] of [['dinext_t_test_bank', 'bank'], ['dinext_t_test_cu', 'credit_union']] as const) {
  const up = await warehouseAvailable(schema).then((ok) => ok && tenantPool(schema).query('SELECT 1 FROM cr_value LIMIT 1').then(() => true, () => false));

  describe.skipIf(!up)(`the simulation against the ${type} warehouse`, () => {
    let pool: Pool;
    let svc: MonteCarloService;
    let spec: ModuleSpec;
    let gateway: ModuleGateway;
    const CFO = { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' };
    const run = async (text: string, modules = ['camels']) => {
      const texts: string[] = [];
      const blocks: Block[] = [];
      const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
      const turn: ModuleTurn = { runId: 'R-sim', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: CFO, tenant: { name: 'Test' }, modules };
      const out = await runModuleOffline(spec, turn, { gateway }, sink);
      return { text: texts.join(' '), blocks, out };
    };

    beforeAll(() => {
      pool = tenantPool(schema);
      svc = new MonteCarloService(pool, type);
      spec = simulationModule(svc);
      gateway = new ModuleGateway(new ApprovalStore(pool), [attritionModule(new AttritionModelService(pool)), spec, camelsModule({ pool, institutionType: type, semantic: async () => { throw new Error('not used'); } })]);
    });
    afterAll(() => pool.end());

    it('gives a range and chances, the same each time, with severe in the bad tail', async () => {
      const a = (await svc.analysis(1500))!;
      const b = (await svc.analysis(1500))!;
      expect(a.trough).toEqual(b.trough);
      expect(a.trough.p5).toBeLessThan(a.trough.p50);
      expect(a.trough.p50).toBeLessThanOrEqual(a.trough.p95);
      expect(a.trough.p95).toBeLessThanOrEqual(a.startPct + 1e-9);
      expect(a.chances.recession).toBeGreaterThan(20);
      expect(a.chances.recession).toBeLessThan(40);
      expect(a.chances.belowMinimum).toBeLessThanOrEqual(a.chances.withinOnePoint);
      // The written severely adverse scenario is a bad outcome, but not the worst one there is.
      const severe = a.written.find((w) => w.key === 'severe')!;
      expect(severe.worseThanPct).toBeGreaterThan(85);
      expect(severe.worseThanPct).toBeLessThan(100);
      // The worst paths are deep recessions with heavy losses.
      expect(a.worst.depth).toBeGreaterThan(a.typical.depth * 3);
      expect(a.worst.lossPct).toBeGreaterThan(a.typical.lossPct * 2);
      // Lower levels are less likely to be reached.
      for (let i = 1; i < a.levels.length; i++) expect(a.levels[i]!.chance).toBeLessThanOrEqual(a.levels[i - 1]!.chance);
    });

    it('answers in words with valid blocks, and refuses people without the stress test', async () => {
      const capital = await run('What’s the chance capital falls below the minimum?');
      expect(capital.text).toMatch(/simulated economies/);
      expect(capital.blocks.length).toBe(3);
      for (const b of [...capital.blocks, ...(await run('What do the worst paths have in common?')).blocks, ...(await run('What’s the range of earnings in a Monte Carlo?')).blocks]) expect(validateBlock(b).ok).toBe(true);
      const refused = await run('Run a Monte Carlo on capital', ['predictive']);
      expect(refused.text).not.toMatch(/simulated economies/);
      // Routing among the agents a CFO has.
      expect(gateway.match('What is the probability we breach the minimum?')?.agent).toBe('Scenario Simulation');
      expect(gateway.match('Run the stress test')?.agent).toBe('CAMELS and stress test');
    });
  });
}
