// @vitest-environment node
// The next-best-product model: one model per product, trained on who opened what, checked on months it
// never saw. A product whose model can't tell is kept on record and not used; members get their likeliest
// products with reasons; names stay hidden without member details; and a new version goes to work only
// when someone other than the requester approves it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, AttritionModelService, NEXT_PRODUCT_MIN_AUC, NextProductModelService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { MODEL_REQUEST, ModuleGateway, NEXT_PRODUCT_REQUEST, attritionModule, nextProductModule, modelProductIn, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('which questions the next-best-product model takes', () => {
  it('takes questions about the model, and leaves the seeded suggestions and attrition alone', () => {
    for (const q of ['How good is the next-best-product model?', 'Who will open a certificate next?', 'Retrain the next-best-product model', 'Put next-best-product model version 2 to work', 'What will members open next?']) expect(NEXT_PRODUCT_REQUEST.test(q), q).toBe(true);
    for (const q of ['Show products to suggest by balance', 'Who with $10,000+ is likely to open a mortgage?', 'Retrain the attrition model', 'How good is the attrition model?']) expect(NEXT_PRODUCT_REQUEST.test(q), q).toBe(false);
    // The attrition agent would take "retrain"; the product model is placed ahead of it.
    expect(MODEL_REQUEST.test('Retrain the next-best-product model')).toBe(true);
  });
  it('finds the product a question names', () => {
    const products = ['Certificates of Deposit', 'Checking', 'Money Market', 'Savings', 'Auto', 'Consumer'];
    expect(modelProductIn('Who will open a CD next?', products)).toBe('Certificates of Deposit');
    expect(modelProductIn('who might open money market', products)).toBe('Money Market');
    expect(modelProductIn('who will open a car loan', products)).toBe('Auto');
    expect(modelProductIn('what about a boat', products)).toBeNull();
  });
});

const SCHEMA = 'dinext_t_test_bank';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT held FROM hist_member_snapshot LIMIT 1').then(() => true, () => false));

describe.skipIf(!up)('the next-best-product model against the bank warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let svc: NextProductModelService;
  let spec: ModuleSpec;
  let gateway: ModuleGateway;
  const PRIYA = { id: 'user:4410', name: 'Priya Shah', title: 'BI Manager' };
  const ELENA = { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' };
  const turn = (text: string, user = PRIYA, modules = ['predictive']): ModuleTurn => ({ runId: 'R-nbp', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user, tenant: { name: 'Coastal Community Bank' }, modules });
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
    await admin.query("DELETE s FROM ml_score s JOIN ml_model m ON m.model_id = s.model_id WHERE m.name LIKE 'next_product:%'");
    await admin.query("DELETE FROM ml_model WHERE name LIKE 'next_product:%'");
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    svc = new NextProductModelService(pool);
    spec = nextProductModule(svc);
    gateway = new ModuleGateway(new ApprovalStore(pool), [spec, attritionModule(new AttritionModelService(pool))]);
    await clear();
  });
  afterAll(async () => {
    await clear();
    await Promise.all([pool.end(), admin.end()]);
  });

  it('trains a model per product, uses the ones that can tell, and keeps the rest on record', async () => {
    const t = (await svc.bootstrap())!;
    expect(t.products.length).toBeGreaterThanOrEqual(3);
    const a = (await svc.active())!;
    for (const m of a.models) expect(m.metrics.auc).toBeGreaterThanOrEqual(NEXT_PRODUCT_MIN_AUC);
    for (const m of a.notUsed) expect(m.metrics.auc).toBeLessThan(NEXT_PRODUCT_MIN_AUC);
    // Savings products learn from a large deposit landing; it is among what they read most.
    const cds = a.models.find((m) => /certificate/i.test(m.product))!;
    expect(cds.metrics.auc).toBeGreaterThan(0.8);
    expect(cds.importance.slice(0, 4).map((i) => i.feature)).toContain('large_deposit_90d');
    const top = (await svc.top(cds.product, { limit: 5 }))!;
    expect(top.items.length).toBe(5);
    expect(top.items[0]!.drivers.length).toBeGreaterThan(0);
    expect(top.items[0]!.lift).toBeGreaterThan(2);
  }, 400_000);

  it('answers in words, hides names without member details, and routes ahead of the attrition agent', async () => {
    const status = await run(turn('How good is the next-best-product model?'));
    expect(status.text).toMatch(/months they never saw/);
    for (const b of status.blocks) expect(validateBlock(b).ok).toBe(true);
    const masked = await run(turn('Who will open a CD next?'));
    expect(masked.text).toMatch(/Names are hidden/);
    for (const b of masked.blocks) expect(validateBlock(b).ok).toBe(true);
    const named = await run(turn('Who will open a CD next?', ELENA, ['predictive', 'records-customers']));
    expect(named.text).not.toMatch(/Names are hidden/);
    expect(gateway.match('Retrain the next-best-product model')?.agent).toBe('Next-Best-Product Model');
    expect(gateway.match('Retrain the attrition model')?.agent).toBe('Predictive Models');
  });

  it('retrains a candidate, and only someone else can put it to work', async () => {
    const retrain = await run(turn('Retrain the next-best-product model'));
    expect(retrain.out.approval?.record.riskTier).toBe('low');
    await approve(retrain, PRIYA);
    expect((await svc.candidate())?.version).toBe(2);
    const promote = await run(turn('Put next-best-product model version 2 to work'));
    expect(promote.out.approval?.record.riskTier).toBe('medium');
    await expect(approve(promote, PRIYA)).rejects.toThrow();
    await approve(promote, ELENA);
    expect((await svc.active())?.version).toBe(2);
    expect((await svc.models()).filter((m) => m.version === 1).every((m) => m.status === 'Retired' || m.status === 'Not used')).toBe(true);
  }, 400_000);
});
