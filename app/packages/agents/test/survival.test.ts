// @vitest-environment node
// The survival model: a Cox fit that recovers what it should, retention curves from what members did,
// hazard ratios and deposits at risk in words, and a new version put to work only by someone else.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, SurvivalModelService, fitCox, outlook } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { MODEL_REQUEST, ModuleGateway, SURVIVAL_REQUEST, runModuleOffline, survivalModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('the Cox fit', () => {
  it('recovers a hazard ratio from data made with one', () => {
    // Monthly rows at each tenure; feature 0 doubles the rate of leaving, feature 1 does nothing.
    let seed = 7;
    const u = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const X: Float64Array[] = [];
    const tenure: number[] = [];
    const event: number[] = [];
    for (let i = 0; i < 60_000; i++) {
      const x = Float64Array.from([u() < 0.5 ? 1 : 0, u()]);
      const t = Math.floor(u() * 60);
      const h = 0.01 * (t < 12 ? 2 : 1) * (x[0] ? 2 : 1);
      X.push(x);
      tenure.push(t);
      event.push(u() < h ? 1 : 0);
    }
    const fit = fitCox(X, Int32Array.from(tenure), Uint8Array.from(event), 2);
    expect(Math.exp(fit.beta[0]!)).toBeGreaterThan(1.7);
    expect(Math.exp(fit.beta[0]!)).toBeLessThan(2.3);
    expect(Math.abs(fit.beta[1]!)).toBeLessThan(0.3);
    // More risk, more chance of leaving and a shorter half-life.
    const H0 = Array.from({ length: 361 }, (_, t) => t * 0.01);
    const low = outlook({ beta: [Math.log(2)], H0 }, [0], 10);
    const high = outlook({ beta: [Math.log(2)], H0 }, [1], 10);
    expect(high.leave).toBeGreaterThan(low.leave);
    expect(high.median!).toBeLessThan(low.median!);
  });
  it('takes lifetime questions, and leaves the attrition model and liquidity runs alone', () => {
    for (const q of ['How long do members stay?', 'What makes customers stay longer?', 'Show the retention curve by age', 'What deposits are at risk over the next year?', 'Retrain the survival model', 'What share of new members are still here after 5 years?']) expect(SURVIVAL_REQUEST.test(q), q).toBe(true);
    for (const q of ['Who does the attrition model say will leave?', 'Which deposits are at risk in a run?', 'Retrain the attrition model']) expect(SURVIVAL_REQUEST.test(q), q).toBe(false);
    expect(MODEL_REQUEST.test('Retrain the survival model')).toBe(true);
  });
});

const SCHEMA = 'dinext_t_test_bank';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM hist_member_snapshot LIMIT 1').then(() => true, () => false));

describe.skipIf(!up)('the survival model against the bank warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let svc: SurvivalModelService;
  let spec: ModuleSpec;
  let gateway: ModuleGateway;
  const PRIYA = { id: 'user:4410', name: 'Priya Shah', title: 'BI Manager' };
  const ELENA = { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' };
  const turn = (text: string, user = PRIYA, modules = ['predictive']): ModuleTurn => ({ runId: 'R-sv', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user, tenant: { name: 'Coastal Community Bank' }, modules });
  const run = async (t: ModuleTurn) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const out = await runModuleOffline(spec, t, { gateway }, sink);
    return { text: texts.join(' '), blocks, out, t };
  };
  const approve = async (o: Awaited<ReturnType<typeof run>>, by: { id: string; name: string; title: string }) => {
    const a = await new ApprovalStore(pool).decide(o.out.approval!.record.approvalId, { decision: 'approved', userId: by.id, payloadHash: o.out.approval!.record.payloadHash });
    return gateway.execute(a, { user: by, modules: o.t.modules, runId: o.t.runId, threadId: o.t.threadId });
  };
  const clear = async () => {
    await admin.query("DELETE s FROM ml_score s JOIN ml_model m ON m.model_id = s.model_id WHERE m.name = 'survival'");
    await admin.query("DELETE FROM ml_model WHERE name = 'survival'");
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    svc = new SurvivalModelService(pool, 'bank');
    spec = survivalModule(svc);
    gateway = new ModuleGateway(new ApprovalStore(pool), [spec]);
    await clear();
  });
  afterAll(async () => {
    await clear();
    await Promise.all([pool.end(), admin.end()]);
  }, 60_000);

  it('fits on earlier months, checks on later ones, and expects about as many to leave as did', async () => {
    const m = (await svc.bootstrap())!;
    expect(m.trainTo < m.validFrom).toBe(true);
    expect(m.metrics.auc).toBeGreaterThan(0.7);
    expect(Math.abs(m.metrics.predicted / m.metrics.actual - 1)).toBeLessThan(0.35);
    // Complaints raise the rate of leaving; more products lower it.
    const hr = (f: string) => m.metrics.ratios.find((r) => r.feature === f)!.hr;
    expect(hr('complaints_3m')).toBeGreaterThan(1);
    expect(hr('products')).toBeLessThan(1);
  }, 300_000);

  it('answers in words, hides names without member details, and curves fall over time', async () => {
    const curves = await svc.curves('age');
    for (const g of curves.groups) expect(g.at[12]!).toBeGreaterThanOrEqual(g.at[60]!);
    const how = await run(turn('How long do customers stay?'));
    expect(how.text).toMatch(/are still here after a year/);
    const drivers = await run(turn('What makes customers stay longer?'));
    expect(drivers.text).toMatch(/hazard ratio/);
    const risk = await run(turn('What deposits are at risk over the next year?'));
    expect(risk.text).toMatch(/Names are hidden/);
    const named = await run(turn('What deposits are at risk over the next year?', ELENA, ['predictive', 'records-customers']));
    expect(named.text).not.toMatch(/Names are hidden/);
    for (const b of [...how.blocks, ...drivers.blocks, ...risk.blocks]) expect(validateBlock(b).ok).toBe(true);
  }, 60_000);

  it('fits a candidate, and only someone else can put it to work', async () => {
    const retrain = await run(turn('Retrain the survival model'));
    expect(retrain.out.approval?.record.riskTier).toBe('low');
    await approve(retrain, PRIYA);
    const promote = await run(turn('Put survival model version 2 to work'));
    expect(promote.out.approval?.record.riskTier).toBe('medium');
    expect(validateBlock(promote.out.approval!.card).ok).toBe(true);
    await expect(approve(promote, PRIYA)).rejects.toThrow();
    await approve(promote, ELENA);
    expect((await svc.active())?.version).toBe(2);
  }, 300_000);
});
