// @vitest-environment node
// The Workflow Builder against the seeded warehouse: drafts, validation, test routes and publishing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalStore, WorkflowDefService, splitFields } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, runModuleOffline, workflowBuilderModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM wf_definition LIMIT 1').then(() => true, () => false));
const NAME = 'Test maintenance request';

const recorder = () => {
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async () => {}, suggestion: () => {} };
  return { sink, texts };
};

describe('fields', () => {
  it('keeps attachments with the form, not the record', () => {
    const f = splitFields(['category', 'location', 'urgency', 'photo']);
    expect(f.persistent.map((x) => x.label)).toEqual(['Category', 'Location', 'Urgency']);
    expect(f.nonPersistent.map((x) => x.type)).toEqual(['file']);
  });
});

describe.skipIf(!up)('workflow builder against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let wf: WorkflowDefService;
  let gateway: ModuleGateway;
  let builder: ModuleSpec;
  const turn = (text: string, modules = ['workflow-builder']): ModuleTurn => ({ runId: 'R-test', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: { id: 'user:1002', name: 'Sam Taylor', title: 'DI Administrator' }, tenant: { name: 'Harborview' }, modules });
  const run = async (t: ModuleTurn) => {
    const r = recorder();
    const out = await runModuleOffline(builder, t, { gateway }, r.sink);
    return { text: r.texts[0]!, out, t };
  };
  const approve = async (o: Awaited<ReturnType<typeof run>>) => {
    const a = await new ApprovalStore(pool).decide(o.out.approval!.record.approvalId, { decision: 'approved', userId: o.t.user.id, payloadHash: o.out.approval!.record.payloadHash });
    await gateway.execute(a, { user: o.t.user, modules: o.t.modules, runId: o.t.runId, threadId: o.t.threadId });
    return a;
  };

  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    wf = new WorkflowDefService(pool);
    builder = workflowBuilderModule(wf, () => '2026-10-25');
    gateway = new ModuleGateway(new ApprovalStore(pool), [builder]);
  });
  afterAll(async () => {
    await admin.query('DELETE FROM wf_definition WHERE def_id > 4');
    await admin.query("DELETE FROM esp_com_queues WHERE queue_id = 'q_test_facilities'");
    await pool.end();
    await admin.end();
  });

  it('lists the live workflows with their open items', async () => {
    const defs = await wf.list();
    expect(defs.filter((d) => d.status === 'Active').map((d) => d.name).sort()).toEqual(['Compliance issue', 'Data log', 'Referral', 'Task']);
    expect(defs.find((d) => d.name === 'Referral')!.openItems).toBeGreaterThan(0);
    expect(gateway.match('Which workflows do we have?')?.id).toBe('workflow-builder');
  });

  it('drafts a new workflow, refuses to publish it without a fallback, then publishes it', async () => {
    const draft = await run(turn(`Create a workflow for ${NAME}s with category, location, urgency and photo, routed to Test Facilities by location`));
    expect(draft.out.approval!.card.data.riskTier).toBe('low');
    expect(draft.text).toContain('no fallback recipient');
    await approve(draft);
    const refused = await run(turn(`Publish the ${NAME} workflow`));
    expect(refused.out.approval).toBeUndefined();
    expect(refused.text).toContain('can’t be published yet');
    await approve(await run(turn('Fallback to Sam Taylor')));
    const publish = await run(turn(`Publish the ${NAME} workflow`));
    expect(publish.out.approval!.card.data.riskTier).toBe('high');
    expect(JSON.stringify(publish.out.approval!.card.data.preview)).toContain('Test route');
    const a = await approve(publish);
    const live = await wf.find(NAME, 'Active');
    expect(live.version).toBe(1);
    expect(live.spec.nonPersistent.map((f) => f.label)).toEqual(['Photo']);
    // Approving the same card again changes nothing (idempotent on the approval).
    await gateway.execute(a, { user: publish.t.user, modules: publish.t.modules, runId: 'R-test', threadId: publish.t.threadId }).catch(() => {});
    expect((await wf.list()).filter((d) => d.name === NAME && d.status === 'Active')).toHaveLength(1);
  });

  it('changes a live workflow only through a draft, and counts the open items it affects', async () => {
    const change = await run(turn('Add a "Waiting on member" stage between Active and Sold for referrals'));
    expect(change.out.approval!.card.data.riskTier).toBe('low');
    await approve(change);
    expect((await wf.find('Referral', 'Active')).spec.stages).not.toContain('Waiting on member');
    const publish = await run(turn('Publish the Referral workflow'));
    const changes = JSON.stringify(publish.out.approval!.card.data.preview);
    expect(changes).toContain('Waiting on member');
    expect(changes).toContain('Open items affected');
    // Leave the seeded Referral definition as it was.
    await admin.query("DELETE FROM wf_definition WHERE name = 'Referral' AND status = 'Draft'");
  });

  it('keeps to its permission, and asks rather than guesses', async () => {
    expect((await run(turn('Which workflows do we have?', []))).text).toContain('COM Center admin');
    expect((await run(turn('Create a workflow'))).text).toContain('which fields');
  });
});
