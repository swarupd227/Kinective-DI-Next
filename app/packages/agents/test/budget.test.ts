// @vitest-environment node
// P3: the budget is drafted from this year's results, changed in a sentence, and approved by someone
// other than its preparer. Every save goes through an approval.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '@dinext/block-schemas';
import { ApprovalStore, BudgetService } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { budgetModule, ModuleGateway, proposeTarget, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('targets', () => {
  it('close half the gap to peers when behind, and stretch modestly when ahead', () => {
    const row = { key: 'return_on_assets', good: 'up' as const, label: 'Return on assets', actual: 0.99, plan: 1, peer: 1.05, trend: [], vsPlan: 'Behind' as const, vsPeer: 'Worse' as const, places: 2 };
    expect(proposeTarget(row).value).toBe(1.02);
    expect(proposeTarget({ ...row, actual: 1.1 }).value).toBe(1.13);
    expect(proposeTarget({ ...row, key: 'efficiency_ratio', good: 'down', actual: 60.1, peer: 62.5, places: 1 }).value).toBe(59.6);
    expect(proposeTarget({ ...row, key: 'loan_to_share_ratio', good: 'target', plan: 80, places: 1 }).value).toBe(80);
  });
});

const SCHEMA = 'dinext_t_test_bank';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM fin_budget LIMIT 1').then(() => true, () => false));

describe.skipIf(!up)('the budget workflow', () => {
  let pool: Pool;
  let admin: Pool;
  let gateway: ModuleGateway;
  let spec: ModuleSpec;
  const ELENA = { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' };
  const CEO = { id: 'user:7000', name: 'Chief Executive', title: 'President and CEO' };
  const turn = (text: string): ModuleTurn => ({ runId: 'R-budget', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: ELENA, tenant: { name: 'Coastal Community Bank' }, modules: ['budget'] });
  const run = async (t: ModuleTurn) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const out = await runModuleOffline(spec, t, { gateway }, sink);
    return { text: texts.join(' '), blocks, out, t };
  };
  const approve = async (o: Awaited<ReturnType<typeof run>>, by = ELENA) => {
    const a = await new ApprovalStore(pool).decide(o.out.approval!.record.approvalId, { decision: 'approved', userId: by.id, payloadHash: o.out.approval!.record.payloadHash });
    await gateway.execute(a, { user: by, modules: o.t.modules, runId: o.t.runId, threadId: o.t.threadId });
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    await admin.query('DELETE FROM fin_budget WHERE year = 2027');
    const semantic = await SemanticService.create(pool, 'test_bank', 'bank');
    spec = budgetModule(new BudgetService(pool), async () => semantic, pool, 'bank');
    gateway = new ModuleGateway(new ApprovalStore(pool), [spec]);
  });
  afterAll(async () => {
    await admin.query('DELETE FROM fin_budget WHERE year = 2027');
    await admin.query('DELETE FROM fin_budget_event WHERE year = 2027');
    await Promise.all([pool.end(), admin.end()]);
  });

  it('starts empty, drafts on approval, takes a change, and needs a second approver to approve', async () => {
    expect((await run(turn('Show the 2027 budget'))).text).toMatch(/isn’t started/);
    const draft = await run(turn('Draft the 2027 budget'));
    expect(draft.out.approval).toBeTruthy();
    expect(draft.text).toMatch(/Return on assets.*Halfway|stretch/s);
    await approve(draft);
    const lines = await new BudgetService(pool).lines(2027);
    expect(lines.length).toBe(10);
    expect(lines.every((l) => l.status === 'Draft')).toBe(true);

    const set = await run(turn('Set the 2027 loan growth target to 6%'));
    expect(set.out.approval).toBeTruthy();
    await approve(set);
    expect((await new BudgetService(pool).lines(2027)).find((l) => l.metric === 'loan_growth')!.value).toBe(6);

    const submit = await run(turn('Submit the 2027 budget for approval'));
    expect(submit.text).toMatch(/someone other than you/);
    // The preparer can't approve her own budget.
    await expect(approve(submit)).rejects.toThrow();
    await approve(submit, CEO);
    expect((await new BudgetService(pool).lines(2027)).every((l) => l.status === 'Approved')).toBe(true);
    expect((await run(turn('Show the 2027 budget'))).text).toMatch(/\*\*approved\*\*/);
  });
});
