// @vitest-environment node
// Form Layout, the Referral Builder Worksheet and referral stages that follow the published Referral
// workflow, against the seeded warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '@dinext/block-schemas';
import { validateBlock } from '@dinext/block-schemas';
import { ApprovalStore, applyLayout, layoutOf, ReferralService, WorkflowDefService, WorksheetService } from '@dinext/di-core';
import { createPool, SEED_DEFINITIONS, tenantPool, warehouseAvailable, type Pool, type WfSpec } from '@dinext/tenant-db';
import { formLayoutModule, ModuleGateway, parseLayoutRequest, parseWorksheetRequest, runModuleOffline, workflowBuilderModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const task = structuredClone(SEED_DEFINITIONS.find((d) => d.name === 'Task')!.spec);

describe('reading form layout and worksheet requests', () => {
  it('reads each kind of layout change', () => {
    expect(parseLayoutRequest('Move Best time to contact above Preferred contact method on the referral form')).toEqual({ tool: 'fl_change', args: { workflow: 'referral', ops: [{ op: 'move', field: 'Best time to contact', before: 'Preferred contact method' }] } });
    expect(parseLayoutRequest('Put Estimated amount and Referral type in a section called Opportunity on the referral form')).toMatchObject({ args: { ops: [{ op: 'group', fields: ['Estimated amount', 'Referral type'], section: 'Opportunity' }] } });
    expect(parseLayoutRequest('Move the Opportunity section to a new tab called Lending on the referral form')).toMatchObject({ args: { ops: [{ op: 'tab', section: 'Opportunity', tab: 'Lending' }] } });
    expect(parseLayoutRequest('Add help text to Due date on the task form: the day it must be done')).toMatchObject({ args: { workflow: 'task', ops: [{ op: 'help', field: 'Due date', text: 'the day it must be done' }] } });
    expect(parseLayoutRequest('Make the Details section one column on the task form')).toMatchObject({ args: { ops: [{ op: 'columns', section: 'Details', columns: 1 }] } });
    expect(parseLayoutRequest('Rename the Details section to Request on the task form')).toMatchObject({ args: { ops: [{ op: 'rename', section: 'Details', to: 'Request' }] } });
    expect(parseLayoutRequest('Add a "Preferred branch" field to the referral form')).toEqual({ tool: 'fl_add_field', args: { workflow: 'referral', field: 'Preferred branch' } });
    expect(parseLayoutRequest('Show the task form')).toEqual({ tool: 'fl_show', args: { workflow: 'task' } });
  });

  it('reads worksheet requests', () => {
    expect(parseWorksheetRequest('Show the worksheet for HELOC')).toEqual({ tool: 'wfb_worksheet', args: { type: 'HELOC' } });
    expect(parseWorksheetRequest('Let tellers and call center create HELOC referrals')).toEqual({ tool: 'wfb_worksheet_update', args: { type: 'HELOC', add_creators: ['tellers', 'call center'] } });
    expect(parseWorksheetRequest('Turn on credit for certificate referrals')).toEqual({ tool: 'wfb_worksheet_update', args: { type: 'certificate', credit: 'Yes' } });
    expect(parseWorksheetRequest('Set up a referral type for Business credit cards: referring Credit card, created by Branch Managers and Loan Officers, fields Business name and Estimated amount, routed to Business banking, success when the card is booked, credit yes')).toEqual({
      tool: 'wfb_referral_type_new',
      args: { name: 'Business credit cards', products: ['Credit card'], creators: ['Branch Managers', 'Loan Officers'], fields: ['Business name', 'Estimated amount'], route_queue: 'Business banking', success: 'the card is booked', credit: 'Yes' },
    });
  });
});

describe('form layout', () => {
  it('starts from one Details tab and reconciles fields that came or went', () => {
    const l = layoutOf(task);
    expect(l.tabs.map((t) => t.sections.map((s) => [s.title, s.fields]))).toEqual([[['Details', ['summary', 'description', 'due_date', 'owner']], ['Notes and attachments', ['notes', 'public_notes']]]]);
    const fewer: WfSpec = { ...task, persistent: task.persistent.filter((f) => f.id !== 'owner'), layout: l };
    expect(layoutOf(fewer).tabs[0]!.sections[0]!.fields).toEqual(['summary', 'description', 'due_date']);
  });

  it('moves, groups into a tab, adds help, and refuses what isn’t there', () => {
    const { layout, marks, lines } = applyLayout(task, [{ op: 'move', field: 'Due date', before: 'summary' }, { op: 'group', fields: ['Owner', 'Notes'], section: 'Who', tab: 'People' }, { op: 'help', field: 'Due date', text: 'The day it must be done' }], 'Task');
    expect(layout.tabs.map((t) => t.title)).toEqual(['Details', 'People']);
    expect(layout.tabs[0]!.sections[0]!.fields).toEqual(['due_date', 'summary', 'description']);
    expect(layout.tabs[1]!.sections[0]).toEqual({ title: 'Who', columns: 2, fields: ['owner', 'notes'] });
    expect(layout.help).toEqual({ due_date: 'The day it must be done' });
    expect([...marks.keys()].sort()).toEqual(['due_date', 'notes', 'owner']);
    expect(lines[0]).toEqual({ label: 'Due date', before: 'Details', after: 'Above Summary' });
    expect(() => applyLayout(task, [{ op: 'move', field: 'Shoe size', before: 'Summary' }], 'Task')).toThrow(/can’t find a field called Shoe size/);
    expect(() => applyLayout(task, [{ op: 'columns', section: 'Nowhere', columns: 1 }], 'Task')).toThrow(/can’t find a section called Nowhere/);
  });
});

const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM mod_ref_worksheet LIMIT 1').then(() => true, () => false));

describe.skipIf(!up)('against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let wf: WorkflowDefService;
  let gateway: ModuleGateway;
  let forms: ModuleSpec;
  let builder: ModuleSpec;
  const SAM = { id: 'user:1002', name: 'Sam Taylor', title: 'DI Administrator' };
  const turn = (text: string, modules = ['form-layout', 'workflow-builder']): ModuleTurn => ({ runId: 'R-fltest', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: SAM, tenant: { name: 'Harborview' }, modules });
  const run = async (spec: ModuleSpec, t: ModuleTurn) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const out = await runModuleOffline(spec, t, { gateway }, sink);
    return { text: texts.join(' '), blocks, out, t };
  };
  const approve = async (o: Awaited<ReturnType<typeof run>>) => {
    const a = await new ApprovalStore(pool).decide(o.out.approval!.record.approvalId, { decision: 'approved', userId: SAM.id, payloadHash: o.out.approval!.record.payloadHash });
    await gateway.execute(a, { user: SAM, modules: o.t.modules, runId: o.t.runId, threadId: o.t.threadId });
    return a;
  };
  const original: Record<string, { spec: unknown; version: number }> = {};

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    wf = new WorkflowDefService(pool);
    forms = formLayoutModule(wf, () => '2026-10-25');
    builder = workflowBuilderModule(wf, () => '2026-10-25', new WorksheetService(pool));
    gateway = new ModuleGateway(new ApprovalStore(pool), [forms, builder]);
    const [rows] = (await admin.query("SELECT name, spec, version FROM wf_definition WHERE status = 'Active' AND name IN ('Task', 'Referral')")) as unknown as [{ name: string; spec: unknown; version: number }[]];
    for (const r of rows) original[r.name] = { spec: r.spec, version: r.version };
  });
  afterAll(async () => {
    // Leave the seeded definitions, worksheets and referral types as they were.
    for (const [name, o] of Object.entries(original)) await admin.query("UPDATE wf_definition SET spec = ?, version = ?, approval_id = NULL WHERE name = ? AND status = 'Active'", [typeof o.spec === 'string' ? o.spec : JSON.stringify(o.spec), o.version, name]);
    await admin.query("DELETE FROM wf_definition WHERE status = 'Draft' AND name IN ('Task', 'Referral')");
    await admin.query("DELETE FROM mod_ref_types WHERE type_id = 'fltest_business_cards'");
    await admin.query("DELETE FROM mod_ref_worksheet WHERE type_id = 'fltest_business_cards'");
    await admin.query("UPDATE mod_ref_worksheet SET credit = 'Not sure yet', approval_id = NULL WHERE type_id = 'certificate'");
    await admin.query("DELETE FROM ai_approvals WHERE run_id = 'R-fltest'");
    await pool.end();
    await admin.end();
  });

  it('routes form changes to Form Layout, ahead of the Workflow Builder', () => {
    expect(gateway.match('Add a "Preferred branch" field to the referral form')?.id).toBe('form-layout');
    expect(gateway.match('Move Due date above Summary on the task form')?.id).toBe('form-layout');
    expect(gateway.match('Add a "Best time to call" field to the task workflow')?.id).toBe('workflow-builder');
    expect(gateway.match('Show the worksheet for HELOC')?.id).toBe('workflow-builder');
  });

  it('shows a layout change on the live form in a preview, at medium risk, once', async () => {
    const o = await run(forms, turn('Move Due date above Summary on the task form'));
    expect(o.out.approval!.card.data.riskTier).toBe('medium');
    const preview = o.blocks.find((b) => b.type === 'form')!;
    expect(validateBlock(preview).ok).toBe(true);
    expect(JSON.stringify(preview)).toContain('"mark":"moved"');
    const before = await wf.find('Task', 'Active');
    expect(layoutOf(before.spec).tabs[0]!.sections[0]!.fields[0]).toBe('summary');
    const a = await approve(o);
    const after = await wf.find('Task', 'Active');
    expect(after.spec.layout!.tabs[0]!.sections[0]!.fields.slice(0, 2)).toEqual(['due_date', 'summary']);
    expect(after.version).toBe(before.version + 1);
    // The same approval again doesn't bump the version.
    await gateway.execute(a, { user: SAM, modules: o.t.modules, runId: 'R-fltest', threadId: o.t.threadId }).catch(() => {});
    expect((await wf.find('Task', 'Active')).version).toBe(after.version);
  });

  it('adds a field to a live form at high risk, and refuses one it already has', async () => {
    const o = await run(forms, turn('Add a "Location" field to the task form'));
    expect(o.out.approval!.card.data.riskTier).toBe('high');
    expect(JSON.stringify(o.blocks)).toContain('"mark":"added"');
    await approve(o);
    expect((await wf.find('Task', 'Active')).spec.persistent.map((f) => f.label)).toContain('Location');
    expect((await run(forms, turn('Add a "Location" field to the task form'))).text).toContain('already has a Location field');
  });

  it('keeps to its permission', async () => {
    expect((await run(forms, turn('Show the task form', ['workflow-builder']))).text).toContain('COM Center admin');
  });

  it('shows and changes a referral worksheet', async () => {
    const show = await run(builder, turn('Show the worksheet for HELOC'));
    expect(show.text).toContain('HELOC referral worksheet');
    expect(show.text).toContain('Routed by the member’s branch to its lending queue');
    const credit = await run(builder, turn('Turn on credit for certificate referrals'));
    expect(credit.out.approval!.card.data.riskTier).toBe('medium');
    await approve(credit);
    expect((await new WorksheetService(pool).find('certificate')).worksheet.credit).toBe('Yes');
  });

  it('sets up a new referral type from a worksheet at high risk, and the referral form sees it at once', async () => {
    const referrals = new ReferralService(pool, 'credit_union');
    expect((await referrals.types()).some((t) => t.label === 'Fltest business cards')).toBe(false);
    const o = await run(builder, turn('Set up a referral type for Fltest business cards: referring Credit card, created by Branch Managers, fields Business name, Estimated amount and Preferred contact method, routed to Business, success when the card is booked, credit yes'));
    expect(o.out.approval!.card.data.riskTier).toBe('high');
    await approve(o);
    const added = (await referrals.types()).find((t) => t.label === 'Fltest business cards')!;
    expect(added.fields.map((f) => [f.label, f.type])).toEqual([['Business name', 'text'], ['Estimated amount', 'money'], ['Preferred contact method', 'enum']]);
    expect(added.route).toEqual({ kind: 'queue', queueId: 'q_business' });
    expect((await run(builder, turn('Set up a referral type for Fltest cards: referring Credit card, created by Tellers, fields Name, routed to Dana Lee'))).text).toContain('Routing to one person isn’t built');
  });

  it('gives referrals the stages of the published Referral workflow', async () => {
    const referrals = new ReferralService(pool, 'credit_union');
    expect(await referrals.stages()).toEqual(['New Referral', 'Not Contacted', 'Left Message', 'Follow Up', 'Active', 'Loan App Taken', 'Product Opened', 'Sold', 'Denied', 'Not Interested', 'Done']);
    const live = await wf.find('Referral', 'Active');
    await admin.query("UPDATE wf_definition SET spec = ? WHERE def_id = ?", [JSON.stringify({ ...live.spec, stages: ['New Referral', 'Active', 'Waiting on member', 'Sold', 'Not Interested', 'Done'] }), live.defId]);
    expect(await referrals.stages()).toContain('Waiting on member');
    expect(await referrals.stageNamed('waiting on member')).toBe('Waiting on member');
    expect(await referrals.stageNamed('Parked')).toBeUndefined();
  });
});
