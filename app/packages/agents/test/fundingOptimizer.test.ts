// @vitest-environment node
// The funding optimizer: the cheapest mix that keeps every limit, from a search through the funding
// model. Nothing acceptable is cheaper than its answer; it respects a source the asker rules out and
// an amount asked for; and "the cheapest way to fund" reaches it while "how do we fund next year's
// growth?" stays with the funding decision.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, FundingOptimizerService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { FUNDING_CHOICE_REQUEST, FUNDING_OPTIMIZER_REQUEST, ModuleGateway, fundingOptimizerModule, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('which questions the optimizer takes', () => {
  it('takes the cheapest mix, and leaves laying out plans to the funding decision', () => {
    for (const q of ['What’s the cheapest way to fund next year’s loan growth?', 'Optimize our funding', 'What is the optimal funding mix?', 'Fund $60 million of loans at the lowest cost', 'Find the best funding mix without brokered CDs']) expect(FUNDING_OPTIMIZER_REQUEST.test(q), q).toBe(true);
    for (const q of ['How do we fund next year’s loan growth?', 'FHLB or brokered deposits?', 'What is our cost of funds?']) expect(FUNDING_OPTIMIZER_REQUEST.test(q), q).toBe(false);
    // The funding decision would also take some of these; the optimizer is placed ahead of it.
    expect(FUNDING_CHOICE_REQUEST.test('How do we fund next year’s loan growth?')).toBe(true);
  });
});

const SCHEMA = 'dinext_t_test_bank';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM cr_value LIMIT 1').then(() => true, () => false));

describe.skipIf(!up)('the optimizer against the bank warehouse', () => {
  let pool: Pool;
  let svc: FundingOptimizerService;
  let spec: ModuleSpec;
  let gateway: ModuleGateway;
  const CFO = { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' };
  const run = async (text: string, modules = ['capactions']) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const turn: ModuleTurn = { runId: 'R-fop', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: CFO, tenant: { name: 'Coastal Community Bank' }, modules };
    await runModuleOffline(spec, turn, { gateway }, sink);
    return { text: texts.join(' '), blocks };
  };

  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    svc = new FundingOptimizerService(pool);
    spec = fundingOptimizerModule(svc);
    gateway = new ModuleGateway(new ApprovalStore(pool), [spec]);
  });
  afterAll(() => pool.end());

  it('finds a mix no acceptable single source beats, funds the whole amount, and is the same each time', async () => {
    const r = (await svc.optimize())!;
    const c = r.chosen!;
    expect(c).toBeTruthy();
    const l = c.levers;
    expect(l.deposits + l.fhlb + l.brokered + c.fromCash).toBeCloseTo(r.growth, -2);
    // It breaches nothing new, and makes no existing breach worse.
    for (const x of c.figures.checks) if (x.status === 'breach') expect(x.today && !x.worseThanToday).toBe(true);
    for (const s of r.single) if (s.acceptable && s.mix) expect(c.figures.cost).toBeLessThanOrEqual(s.mix.figures.cost + 1);
    // Ignoring the limits can only be as cheap or cheaper.
    expect(r.cheapest!.figures.cost).toBeLessThanOrEqual(c.figures.cost + 1);
    const again = (await svc.optimize())!;
    expect(again.chosen!.levers).toEqual(l);
  }, 60_000);

  it('respects a source ruled out and an amount asked for', async () => {
    const r = (await svc.optimize({ noBrokered: true, amount: 20_000_000 }))!;
    expect(r.growth).toBe(20_000_000);
    if (r.chosen) expect(r.chosen.levers.brokered).toBe(0);
    expect(r.ruledOut).toEqual(['brokered']);
  }, 60_000);

  it('answers in words with valid blocks, reads amounts and exclusions, and refuses without access', async () => {
    const out = await run('What’s the cheapest way to fund $30 million of loans without brokered CDs?');
    expect(out.text).toMatch(/\$30\.0M of loan growth without brokered CDs/);
    expect(out.text).toMatch(/a year, [\d.]+% all-in/);
    expect(out.blocks.length).toBe(3);
    for (const b of out.blocks) expect(validateBlock(b).ok).toBe(true);
    const refused = await run('Optimize our funding', ['camels']);
    expect(refused.text).not.toMatch(/all-in/);
  }, 60_000);
});
