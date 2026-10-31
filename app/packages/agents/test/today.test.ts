// @vitest-environment node
// Agent-led work: the day's ranking across modules, DI's view of a page, and the record on screen as
// context, against the seeded warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, PipelineService, ReferralService, RelationshipService, type InboxItem } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { AuditLog, Concierge, PIPELINE_REQUEST, TODAY_REQUEST, ToolGateway, buildToday, parsePipelineRequest, pipelineTake, referralTake, todayList, todayText, type RunSink, type StepUpdate, type TenantRuntime, type TodayWho } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

function recorder() {
  const blocks: Block[] = [];
  const texts: string[] = [];
  const steps: StepUpdate[] = [];
  const suggestions: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: (_, u) => void steps.push(u), text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: (s) => void suggestions.push(s) };
  return { sink, blocks, texts, steps, suggestions };
}

describe('asking for the day', () => {
  it('recognises the ways people ask, and leaves the rest alone', () => {
    for (const t of ['What should I do today?', 'What should I work on?', 'Plan my day', 'What needs my attention?', 'Where should I start?', 'Get me ready for the week']) expect(TODAY_REQUEST.test(t), t).toBe(true);
    for (const t of ['What’s on my plate today?', 'Get me ready for Thursday’s ALCO meeting', 'Show loan growth by branch']) expect(TODAY_REQUEST.test(t), t).toBe(false);
  });

  it('reads one application, or several, by number', () => {
    expect(PIPELINE_REQUEST.test('Why is application #2689 stuck?')).toBe(true);
    expect(parsePipelineRequest('Why is application #2689 stuck?')).toEqual({ intent: 'detail', id: 2689 });
    expect(parsePipelineRequest('Create follow-up tasks for applications #2689, #2698, #1559')).toMatchObject({ intent: 'tasks', ids: [2689, 2698, 1559] });
    expect(parsePipelineRequest('chase application #2689')).toMatchObject({ intent: 'tasks', ids: [2689] });
  });

  it('puts the overdue referral first, and says how late it is', () => {
    const item = (over: Partial<InboxItem>) => ({ comId: 1, name: 'Nora Chen', typeLabel: 'Retention follow-up', overdue: true, dueAt: new Date(Date.now() - 2.5 * 86_400_000).toISOString(), priority: 'High', assignee: { employeeId: 4, name: 'Sofia Ruiz' }, ...over }) as InboxItem;
    expect(referralTake([item({}), item({ comId: 2, name: 'Grace Okafor', priority: 'Normal', dueAt: new Date().toISOString() })], true)).toEqual({ headline: 'Nora Chen’s retention follow-up comes first: overdue by 3 days. 2 are overdue in all.', action: { label: 'Prepare me', ask: 'Prepare me for my meeting with Nora Chen' } });
    expect(referralTake([item({})], false).headline).toContain('with Sofia Ruiz');
    expect(referralTake([], true).action).toBeUndefined();
  });
});

describe.skipIf(!up)('the day against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let gateway: ToolGateway;
  let pipeline: PipelineService;
  let referrals: ReferralService;
  let tenant: TenantRuntime;
  let concierge: Concierge;
  const westport = ['Westport'];
  const ana: TodayWho = { user: { id: 'user:6101', name: 'Ana Ruiz' }, apps: ['lap', 'referrals'], purviewBranches: westport, employeeId: 1, lap: { details: true } };
  const marcus: TodayWho = { user: { id: 'user:5120', name: 'Marcus Reed' }, apps: ['lap', 'referrals'], purviewBranches: westport, employeeId: 6, lap: { details: true, leads: true } };
  const priya: TodayWho = { user: { id: 'user:4410', name: 'Priya Shah' }, apps: ['lap', 'referrals'], lap: { details: false } };
  const sofia: TodayWho = { user: { id: 'user:6004', name: 'Sofia Ruiz' }, apps: ['referrals'], purviewBranches: westport, employeeId: 4 };
  const titled = (w: TodayWho) => ({ ...w, user: { ...w.user, title: 'Staff' } });
  const turn = (w: TodayWho, threadId: string, text: string, context: { type: 'workflow_item'; ref: string; label: string }[] = []) => ({ threadId, runId: `R-${threadId}`, text, context, user: titled(w).user, tenant, apps: w.apps, purviewBranches: w.purviewBranches, canViewSql: false, employeeId: w.employeeId, lap: w.lap });

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    pipeline = new PipelineService(pool);
    referrals = new ReferralService(pool, 'credit_union');
    gateway = new ToolGateway({ referrals, relationship: new RelationshipService(pool, 'test_cu', 'credit_union'), pipeline, approvals: new ApprovalStore(pool) });
    tenant = { key: 'test_cu', name: 'Harborview', institutionType: 'credit_union', semantic: null, workflow: { referrals, relationship: null, gateway } } as unknown as TenantRuntime;
    concierge = new Concierge({ model: null, audit: new AuditLog() });
  });
  afterAll(async () => {
    await admin.query("DELETE FROM esp_com_lines WHERE com_id IN (SELECT com_id FROM esp_com_items WHERE type_id = 'loan_follow_up')");
    await admin.query("DELETE FROM esp_com_items WHERE type_id = 'loan_follow_up'");
    await admin.query("DELETE FROM ai_approvals WHERE thread_id LIKE 'thr_day%'");
    await Promise.all([pool.end(), admin.end()]);
  });

  it('ranks a lender’s own work across modules, and keeps it to theirs', async () => {
    const p = await buildToday(ana, gateway);
    expect(p.items.length).toBeGreaterThan(0);
    expect(p.items.length).toBeLessThanOrEqual(5);
    expect(new Set(p.items.map((i) => i.kind))).toEqual(new Set(['application', 'referral']));
    expect([...p.items].sort((a, b) => b.weight - a.weight)).toEqual(p.items);
    expect(p.followUps).toEqual([]);
    expect(p.items.find((i) => i.kind === 'application')!.ask).toMatch(/^Why is application #\d+ stuck\?$/);
    expect(todayText(p)).toContain(`Start with **${p.items[0]!.title}**`);
    expect(validateBlock(todayList(p, 'R-1', { startsWork: true })).ok).toBe(true);
    expect(todayList(p, 'R-1', { startsWork: true }).data.items[0]!.link).toMatch(/^\/c\/new\?q=/);
  });

  it('lines up follow-ups for a lead, for other people’s applications', async () => {
    const p = await buildToday(marcus, gateway);
    expect(p.followUps).toHaveLength(3);
    expect(p.items.find((i) => i.kind === 'application')!.why).toMatch(/With /);
  });

  it('shows totals, with no names, to someone without Application Details', async () => {
    const p = await buildToday(priya, gateway);
    const stalled = p.items.find((i) => i.kind === 'totals');
    expect(stalled?.title).toMatch(/^\d+ applications have stalled$/);
    expect(p.items.filter((i) => i.kind === 'application')).toEqual([]);
    expect(p.followUps).toEqual([]);
  });

  it('leaves out the pipeline for someone without the module', async () => {
    const p = await buildToday(sofia, gateway);
    expect(p.items.every((i) => i.kind === 'referral')).toBe(true);
    expect(p.stalled.count).toBe(0);
  });

  it('gives a page DI’s view and a next step that fit the person', async () => {
    const who = { employeeId: 1, details: true };
    const own = pipelineTake(await pipeline.find({ view: 'mine', stalledOnly: true }, who, { purviewBranches: westport }), true);
    expect(own.headline).toMatch(/have stalled\. .+ matters most: \d+ days/);
    expect(own.action?.ask).toMatch(/^Why is application #\d+ stuck\?$/);
    const lead = pipelineTake(await pipeline.find({ view: 'location', stalledOnly: true }, { employeeId: 6, leads: true, details: true }, { purviewBranches: westport }), false);
    expect(lead.action).toMatchObject({ label: 'Create follow-ups for the top 3' });
    expect(parsePipelineRequest(lead.action!.ask)).toMatchObject({ intent: 'tasks' });
    const totals = pipelineTake(await pipeline.find({ view: 'institution', stalledOnly: true }, { details: false }, {}), false);
    expect(totals.headline).toMatch(/applications have stalled, worth/);
  });

  it('runs as a task, and the plan’s last step ends with the follow-up decision', async () => {
    const r = recorder();
    const out = await concierge.handle(turn(marcus, 'thr_day1', 'What should I do today?'), r.sink);
    if (out.kind !== 'handled' || !out.approval) throw new Error('expected an approval');
    expect(r.texts[0]).toContain('Start with');
    expect(r.blocks.map((b) => b.type)).toEqual(['list', 'approval_card']);
    expect(r.blocks[0]).toMatchObject({ output: { label: 'Your day' } });
    expect(r.steps.find((s) => s.id === 'followups' && s.state === 'needs_input')).toBeDefined();

    const after = recorder();
    const finished = new Promise<unknown>((resolve) => (after.sink.done = resolve));
    await concierge.resolveApproval({ approvalId: out.approval.approvalId, decision: 'approve', previewHash: out.approval.card.data.previewHash, threadId: 'thr_day1', runId: 'R-thr_day1', user: marcus.user, tenant, purviewBranches: westport, employeeId: 6, lap: marcus.lap }, after.sink);
    await finished;
    expect(after.steps.find((s) => s.id === 'followups')).toMatchObject({ state: 'done', resultSummary: '3 tasks created' });
  });

  it('offers the next question to someone with nothing to approve', async () => {
    const r = recorder();
    const out = await concierge.handle(turn(ana, 'thr_day2', 'Plan my day'), r.sink);
    expect(out).toMatchObject({ kind: 'handled' });
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.blocks.map((b) => b.type)).toEqual(['list']);
  });

  it('takes “it” to mean the application on screen', async () => {
    const found = await pipeline.find({ view: 'mine', stalledOnly: true }, { employeeId: 1, details: true }, { purviewBranches: westport });
    const a = found.items[0]!;
    const chip = { type: 'workflow_item' as const, ref: `application:${a.applicationId}`, label: `Application #${a.applicationId}` };
    const r = recorder();
    await concierge.handle(turn(ana, 'thr_day3', 'Why is it stuck?', [chip]), r.sink);
    expect(r.texts[0]).toContain(a.name);
    expect(r.texts[0]).toContain(`${a.threshold}-day threshold`);
    expect(r.suggestions[0]).toBe(`Create a follow-up task for application #${a.applicationId}`);
  });

  it('takes “it” to mean the referral on screen, with the usual approval', async () => {
    const [item] = await referrals.inbox('mine', { userId: sofia.user.id, employeeId: 4 }, { purviewBranches: westport });
    const chip = { type: 'workflow_item' as const, ref: `referral:${item!.comId}`, label: `Referral #${item!.comId}` };
    const r = recorder();
    const out = await concierge.handle(turn(sofia, 'thr_day4', 'Mark it as sold', [chip]), r.sink);
    if (out.kind !== 'handled' || !out.approval) throw new Error('expected an approval');
    expect(out.approval.card.data.summary).toContain(`#${item!.comId}`);
  });

  it('keeps access when the record on screen is outside the purview', async () => {
    const all = await pipeline.find({ view: 'institution' }, { details: true }, {});
    const away = all.items.find((a) => a.branch !== 'Westport')!;
    const chip = { type: 'workflow_item' as const, ref: `application:${away.applicationId}`, label: 'x' };
    const r = recorder();
    await concierge.handle(turn(ana, 'thr_day5', 'Why is it stuck?', [chip]), r.sink);
    expect(r.texts[0]).toContain('was not found');
    expect(r.texts[0]).not.toContain(away.lastName);
  });

  it('asks about something else as usual while a record is open', async () => {
    const chip = { type: 'workflow_item' as const, ref: 'application:1', label: 'x' };
    const r = recorder();
    const out = await concierge.handle(turn(ana, 'thr_day6', 'What’s on my plate today?', [chip]), r.sink);
    expect(out).toMatchObject({ kind: 'handled' });
    expect(r.blocks[0]).toMatchObject({ title: 'Your open referrals' });
  });
});
