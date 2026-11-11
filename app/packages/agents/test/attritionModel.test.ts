// @vitest-environment node
// The attrition model: gradient-boosted trees DI trains on its own member snapshots. It learns a
// pattern, explains each score, is checked on months it never saw, scores every member with reasons,
// is checked again against who actually left, and a new version goes to work only when someone other
// than the requester approves it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, AttritionModelService, auc, contributions, predict, trainGbm } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, attritionModule, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('gradient-boosted trees', () => {
  // y depends on x0 and x1 together; x2 is noise.
  const rows = Array.from({ length: 4000 }, (_, i) => [((i * 7919) % 1000) / 1000, ((i * 104729) % 1000) / 1000, ((i * 1299709) % 1000) / 1000]);
  const y = rows.map((r, i) => (r[0]! > 0.6 && r[1]! > 0.3 ? (i % 10 < 8 ? 1 : 0) : i % 10 < 1 ? 1 : 0));

  it('learns the pattern and ignores the noise', () => {
    const m = trainGbm(['a', 'b', 'noise'], rows, y, null, { trees: 60, depth: 3, minChild: 5 });
    expect(auc(rows.map((r) => predict(m, r)), y)).toBeGreaterThan(0.85);
    const c = contributions(m, [0.9, 0.9, 0.5]);
    expect(c[0]! + c[1]!).toBeGreaterThan(Math.abs(c[2]!) * 3);
  });

  it('is deterministic', () => {
    const a = trainGbm(['a', 'b', 'noise'], rows, y, null, { trees: 10, depth: 3, minChild: 5 });
    const b = trainGbm(['a', 'b', 'noise'], rows, y, null, { trees: 10, depth: 3, minChild: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM hist_member_snapshot LIMIT 1').then(() => true, () => false));

describe.skipIf(!up)('the attrition model against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let svc: AttritionModelService;
  let gateway: ModuleGateway;
  let spec: ModuleSpec;
  const PRIYA = { id: 'user:4410', name: 'Priya Shah', title: 'BI Manager' };
  const DANA = { id: 'user:9229', name: 'Dana Lee', title: 'President and CEO' };
  const turn = (text: string, user = PRIYA, modules = ['predictive']): ModuleTurn => ({ runId: 'R-model', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user, tenant: { name: 'Harborview Federal Credit Union' }, modules });
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
    // Only the attrition model's rows: other models share these tables.
    await admin.query("DELETE s FROM ml_score s JOIN ml_model m ON m.model_id = s.model_id WHERE m.name = 'attrition'");
    await admin.query("DELETE d FROM ml_drift d JOIN ml_model m ON m.model_id = d.model_id WHERE m.name = 'attrition'");
    await admin.query("DELETE FROM ml_model WHERE name = 'attrition'");
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    svc = new AttritionModelService(pool);
    spec = attritionModule(svc);
    gateway = new ModuleGateway(new ApprovalStore(pool), [spec]);
    await clear();
  });
  afterAll(async () => {
    await clear();
    await Promise.all([pool.end(), admin.end()]);
  }, 60_000);

  it('trains on earlier months, checks on later ones, and finds most leavers in its top 10%', async () => {
    const m = (await svc.bootstrap())!;
    expect(m.trainTo < m.validFrom).toBe(true);
    const active = (await svc.active())!;
    expect(active.metrics.auc).toBeGreaterThan(0.75);
    expect(active.metrics.captured10).toBeGreaterThan(0.5);
    // Calibrated: on average it expects about as many to leave as did.
    expect(Math.abs(active.metrics.predicted / active.metrics.actual - 1)).toBeLessThan(0.35);
    // What drives it is what comes before leaving, not who the member is.
    expect(active.importance.slice(0, 4).map((i) => i.feature)).toContain('balance_change_3m');
  }, 240_000);

  it('scores every member with reasons, and its High band did leave far more often', async () => {
    const m = (await svc.active())!;
    const top = await svc.top(m.modelId, { limit: 5 });
    expect(top.items[0]!.drivers.length).toBeGreaterThan(0);
    const hist = await svc.history(m.modelId);
    const done = hist.filter((h) => h.month !== hist.at(-1)!.month);
    const rate = (band: string) => {
      const r = done.filter((h) => h.band === band);
      return r.reduce((s, h) => s + h.leftNext, 0) / r.reduce((s, h) => s + h.members, 0);
    };
    expect(rate('High')).toBeGreaterThan(rate('Low') * 10);
    expect((await svc.driftReport(m.modelId)).items.length).toBe(15);
    // A branch manager sees their own branch only.
    const westport = await svc.top(m.modelId, { limit: 20, purviewBranches: ['Westport'] });
    expect(westport.items.every((x) => x.branch === 'Westport')).toBe(true);
  }, 60_000);

  it('answers in words, and hides names from someone without member details', async () => {
    const status = await run(turn('How good is the attrition model?'));
    expect(status.text).toMatch(/checked on .* months it never saw/);
    for (const b of status.blocks) expect(validateBlock(b).ok).toBe(true);
    const top = await run(turn('Who does the attrition model say will leave?'));
    expect(top.text).toMatch(/Names are hidden/);
    const named = await run(turn('Who does the attrition model say will leave?', DANA, ['predictive', 'records-members']));
    expect(named.text).not.toMatch(/Names are hidden/);
    expect(gateway.match('Is the attrition model drifting?')?.agent).toBe('Predictive Models');
    // The follow-up DI suggests after the model's status must come back to the model.
    expect(gateway.match('Did the High band actually leave?')?.agent).toBe('Predictive Models');
  }, 60_000);

  it('retrains a candidate, and only someone else can put it to work', async () => {
    const retrain = await run(turn('Retrain the attrition model'));
    expect(retrain.out.approval?.record.riskTier).toBe('low');
    await approve(retrain, PRIYA);
    expect((await svc.models()).find((m) => m.status === 'Candidate')?.version).toBe(2);
    const promote = await run(turn('Put attrition model version 2 to work'));
    expect(promote.out.approval?.record.riskTier).toBe('medium');
    await expect(approve(promote, PRIYA)).rejects.toThrow();
    await approve(promote, DANA);
    const all = await svc.models();
    expect(all.find((m) => m.version === 2)).toMatchObject({ status: 'Active', approvedBy: 'Dana Lee' });
    expect(all.find((m) => m.version === 1)?.status).toBe('Retired');
  }, 300_000);
});
