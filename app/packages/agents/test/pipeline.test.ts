// @vitest-environment node
// The Loan Pipeline: views, funnel, stall rules and access against the seeded warehouse, the offline
// planner, and the Concierge routing and approval around it. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, CoreError, PipelineService, ReferralService, RelationshipService } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { createPool, markDuplicates, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { AuditLog, CONTACT_APPLICANT, Concierge, INBOX_REQUEST, PIPELINE_REQUEST, foundText, parsePipelineRequest, rateText, runPipelineOffline, summaryBlocks, ToolGateway, type PipelineInput, type RunSink, type TenantRuntime } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

function recorder() {
  const blocks: Block[] = [];
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { sink, blocks, texts };
}

describe('recognising pipeline work', () => {
  it('tells loan applications from loans, referrals and the data pipeline', () => {
    for (const t of ['Which of my apps have sat in underwriting more than five days?', 'Show the pipeline by product for my branch', 'What’s our approval rate on auto this month compared with last month?', 'Create follow-up tasks for pending apps older than ten days', 'Show counter offers over $50,000', 'Show my stalled applications', 'Create a follow-up task for application #482']) expect(PIPELINE_REQUEST.test(t), t).toBe(true);
    for (const t of ['Show loan growth by branch', 'Show my overdue referrals', '/pipeline map a new source', 'Check the data pipeline']) expect(PIPELINE_REQUEST.test(t), t).toBe(false);
    expect(INBOX_REQUEST.test('Show my stalled applications')).toBe(false);
  });

  it('reads requests the way people say them', () => {
    expect(parsePipelineRequest('Which of my apps have sat in underwriting more than five days?')).toMatchObject({ intent: 'list', view: 'mine', status: 'underwriting' });
    expect(parsePipelineRequest('Which of my apps have sat in underwriting more than 5 days?')).toMatchObject({ minDays: 5 });
    expect(parsePipelineRequest('Show the pipeline by product for my branch')).toMatchObject({ intent: 'summary', view: 'location' });
    expect(parsePipelineRequest('What’s our approval rate on auto this month?')).toEqual({ intent: 'rate', product: 'auto' });
    expect(parsePipelineRequest('Show counter offers over $50,000')).toMatchObject({ intent: 'list', status: 'counter offer', minAmount: 50_000 });
    expect(parsePipelineRequest('Create follow-up tasks for pending apps older than 10 days')).toMatchObject({ intent: 'tasks', minDays: 10, stalled: false });
    expect(parsePipelineRequest('Set the underwriting stall threshold for auto to 3 days')).toEqual({ intent: 'threshold', status: 'underwriting', product: 'auto', days: 3 });
  });

  it('never takes a request to contact an applicant', () => {
    expect(CONTACT_APPLICANT.test('Email the applicants in underwriting')).toBe(true);
    expect(CONTACT_APPLICANT.test('Call the borrower on application 482')).toBe(true);
    expect(CONTACT_APPLICANT.test('Show the pipeline')).toBe(false);
  });

  it('applies the stock duplicate rule: same applicant and category, within 7 days', () => {
    const app = (id: number, applied: string, party = 1, category = 'Auto') => ({ id, party, category, applied, duplicate: false });
    const out = markDuplicates([app(1, '2026-10-01'), app(2, '2026-10-05'), app(3, '2026-10-20'), app(4, '2026-10-05', 2), app(5, '2026-10-05', 1, 'HELOC')]);
    expect(out.map((a) => a.duplicate)).toEqual([false, true, false, false, false]);
  });
});

describe.skipIf(!up)('the pipeline against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let pipeline: PipelineService;
  let gateway: ToolGateway;
  let referrals: ReferralService;
  let approvals: ApprovalStore;
  const made: number[] = [];
  const westport = { purviewBranches: ['Westport'] };
  const ana = { employeeId: 1, details: true };
  const marcus = { employeeId: 6, leads: true, details: true };
  const dana = { details: true };
  const priya = { details: false };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    pipeline = new PipelineService(pool);
    referrals = new ReferralService(pool, 'credit_union');
    approvals = new ApprovalStore(pool);
    gateway = new ToolGateway({ referrals, relationship: new RelationshipService(pool, 'test_cu', 'credit_union'), pipeline, semantic: await SemanticService.create(pool, 'test_cu', 'credit_union'), approvals });
  });
  afterAll(async () => {
    if (made.length) {
      await admin.query('DELETE FROM esp_com_lines WHERE com_id IN (?)', [made]);
      await admin.query('DELETE FROM esp_com_items WHERE com_id IN (?)', [made]);
    }
    await admin.query("DELETE FROM esp_com_lines WHERE com_id IN (SELECT com_id FROM esp_com_items WHERE type_id = 'loan_follow_up')");
    await admin.query("DELETE FROM esp_com_items WHERE type_id = 'loan_follow_up'");
    await admin.query('DELETE FROM mod_lap_stall_threshold');
    await admin.query("DELETE FROM ai_approvals WHERE thread_id LIKE 'thr_lap%'");
    await Promise.all([pool.end(), admin.end()]);
  });

  it('offers only the views a role and purview support, and refuses the rest in the core', async () => {
    expect(await pipeline.views(ana, westport)).toEqual(['mine', 'location']);
    expect(await pipeline.views(marcus, westport)).toEqual(['location', 'team']);
    expect(await pipeline.views(dana, {})).toEqual(['institution']);
    await expect(pipeline.summary('institution', ana, westport)).rejects.toMatchObject({ code: 'NO_ACCESS' });
    await expect(pipeline.find({ view: 'mine' }, dana, {})).rejects.toBeInstanceOf(CoreError);
  });

  it('scopes My Applications to the owner and My Location to the purview', async () => {
    const mine = await pipeline.find({ view: 'mine' }, ana, westport);
    expect(mine.count).toBeGreaterThan(0);
    expect(mine.items.every((a) => a.owner?.employeeId === 1)).toBe(true);
    const location = await pipeline.find({ view: 'location' }, ana, westport);
    expect(location.count).toBeGreaterThan(mine.count);
    expect(location.items.every((a) => a.branch === 'Westport')).toBe(true);
    const all = await pipeline.find({ view: 'institution' }, dana, {});
    expect(new Set(all.items.map((a) => a.branch)).size).toBeGreaterThan(1);
  });

  it('returns counts, percent, dollars and average days, and the parts add up', async () => {
    const s = await pipeline.summary('institution', dana, {});
    expect(s.groups).toEqual(['Pending', 'Counter Offer', 'Denied by DM', 'Auto Approved', 'Approved']);
    const total = s.funnel.reduce((n, f) => n + f.count, 0);
    expect(s.products.reduce((n, p) => n + p.total.count, 0)).toBe(total);
    expect(s.funnel.reduce((n, f) => n + f.pct, 0)).toBeCloseTo(100, 0);
    expect(s.funnel.find((f) => f.group === 'Pending')!.dollars).toBeGreaterThan(0);
    expect(s.funnel.find((f) => f.group === 'Pending')!.avgDays).toBeGreaterThan(0);
    for (const b of summaryBlocks(s, 'R-lap')) expect(validateBlock(b).ok, b.type).toBe(true);
  });

  it('leaves out hidden statuses and duplicates', async () => {
    const [[row]] = (await pool.query("SELECT COUNT(*) AS n FROM cdm_loan_application WHERE status_code = 'WITHDRAWN'")) as unknown as [{ n: number }[]];
    expect(row!.n).toBeGreaterThan(0);
    const s = await pipeline.summary('institution', dana, {});
    expect(s.groups).not.toContain('Withdrawn');
    const [[dup]] = (await pool.query('SELECT application_id FROM cdm_loan_application WHERE is_duplicate = 1 LIMIT 1')) as unknown as [{ application_id: number }[]];
    const all = await pipeline.find({ view: 'institution', includeFinished: true }, dana, {});
    expect(all.items.some((a) => a.applicationId === dup!.application_id)).toBe(false);
  });

  it('shows the tenant’s names, from configuration and not from code', async () => {
    await admin.query("UPDATE mod_lap_status_map SET reporting_group = 'Declined' WHERE status_code = 'DENIED_DM'");
    try {
      expect((await pipeline.summary('institution', dana, {})).groups).toContain('Declined');
    } finally {
      await admin.query("UPDATE mod_lap_status_map SET reporting_group = 'Denied by DM' WHERE status_code = 'DENIED_DM'");
    }
  });

  it('flags a stall past the threshold for the status, and a product’s own threshold wins', async () => {
    const before = await pipeline.find({ view: 'institution', status: 'underwriting' }, dana, {});
    expect(before.items.filter((a) => a.daysInStatus > 5).every((a) => a.stalled)).toBe(true);
    expect(before.items.filter((a) => a.daysInStatus <= 5).every((a) => !a.stalled)).toBe(true);
    const auto = before.items.find((a) => a.product === 'Auto loan' && a.daysInStatus >= 2 && a.daysInStatus <= 5);
    expect(auto).toBeDefined();
    await pipeline.setThreshold({ code: 'UNDERWRITING', product: 'Auto loan', days: auto!.daysInStatus - 1 }, { userId: 'user:test' });
    try {
      const after = await pipeline.find({ view: 'institution', status: 'underwriting' }, dana, {});
      expect(after.items.find((a) => a.applicationId === auto!.applicationId)).toMatchObject({ stalled: true, threshold: auto!.daysInStatus - 1 });
      expect(after.items.find((a) => a.product !== 'Auto loan' && a.daysInStatus <= 5)?.stalled).toBe(false);
    } finally {
      await admin.query('DELETE FROM mod_lap_stall_threshold');
    }
  });

  it('gives counts and dollars only without Application Details', async () => {
    const f = await pipeline.find({ view: 'institution', stalledOnly: true }, priya, {});
    expect(f).toMatchObject({ detailsHidden: true, items: [] });
    expect(f.count).toBeGreaterThan(0);
    expect(f.byProduct.reduce((n, p) => n + p.count, 0)).toBe(f.count);
    const [[row]] = (await pool.query('SELECT application_id FROM cdm_loan_application LIMIT 1')) as unknown as [{ application_id: number }[]];
    await expect(pipeline.application(row!.application_id, priya, {})).rejects.toMatchObject({ code: 'NO_ACCESS' });
    expect(foundText(f, 'have stalled')).toContain('totals');
  });

  it('reads an application outside the purview as not found', async () => {
    const [[row]] = (await pool.query("SELECT a.application_id FROM cdm_loan_application a JOIN cdm_location b ON b.int_id = a.branch_id WHERE b.name <> 'Westport' AND a.status_code <> 'WITHDRAWN' LIMIT 1")) as unknown as [{ application_id: number }[]];
    await expect(pipeline.application(row!.application_id, ana, westport)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await pipeline.application(row!.application_id, dana, {})).history.length).toBeGreaterThan(0);
  });

  it('says so when the LOS feed missed the last build', async () => {
    await admin.query("DELETE FROM meta_lap_load WHERE load_date = '2026-10-25'");
    await admin.query("INSERT INTO meta_lap_load VALUES ('2026-10-20', 'completed')");
    try {
      const f = await pipeline.find({ view: 'institution', stalledOnly: true }, dana, {});
      expect(f).toMatchObject({ stale: true, asOf: '2026-10-20' });
      expect(foundText(f, 'have stalled')).toContain('wasn’t loaded');
    } finally {
      await admin.query("DELETE FROM meta_lap_load WHERE load_date = '2026-10-20'");
      await admin.query("INSERT INTO meta_lap_load VALUES ('2026-10-25', 'completed')");
    }
  });

  const input = (text: string, threadId: string, over: Partial<PipelineInput> = {}): PipelineInput => ({ runId: `R-${threadId}`, threadId, text, user: { id: 'user:6101', name: 'Ana Ruiz', title: 'Loan Officer' }, tenant: { name: 'Harborview', institutionType: 'credit_union' }, apps: ['lap', 'referrals', 'rm'], purviewBranches: ['Westport'], employeeId: 1, lap: { details: true }, ...over });

  it('answers an ageing question with count, dollars, the oldest and the load date', async () => {
    const r = recorder();
    await runPipelineOffline(input('Which of my apps have sat in underwriting more than 2 days?', 'thr_lap1'), { gateway }, r.sink);
    expect(r.texts[0]).toMatch(/\*\*\d+ applications?\*\* worth \*\*\$[\d.]+[KM]?\*\* are in underwriting more than 2 days\. As of the Oct 25 LOS load\. The oldest has waited \*\*\d+ days\*\* \(/);
    expect(validateBlock(r.blocks[0]!).ok).toBe(true);
  });

  it('declines to contact an applicant and offers a staff task', async () => {
    const r = recorder();
    const out = await runPipelineOffline(input('Email the applicants in underwriting', 'thr_lap2'), { gateway }, r.sink);
    expect(out.toolCalls).toEqual([]);
    expect(r.texts[0]).toContain('don’t contact applicants');
  });

  it('takes the approval rate from the semantic layer, for complete months', async () => {
    const r = recorder();
    await runPipelineOffline(input('What’s our approval rate on auto this month compared with last month?', 'thr_lap3', { purviewBranches: undefined, employeeId: undefined }), { gateway }, r.sink);
    expect(r.texts[0]).toMatch(/approval rate on auto was \*\*[\d.]+%\*\* in \w+ 2026, compared with \*\*[\d.]+%\*\* in \w+ 2026/);
    expect(r.texts[0]).toContain('Complete months only');
    expect(rateText({ definition: 'x', periods: [] })).toContain('no approval rate');
  });

  it('prepares tasks for owners at medium risk, and creates nothing until approved', async () => {
    const r = recorder();
    const concierge = new Concierge({ model: null, audit: new AuditLog() });
    const tenant = { key: 'test_cu', name: 'Harborview', institutionType: 'credit_union', semantic: null, workflow: { referrals, relationship: null, gateway } } as unknown as TenantRuntime;
    const user = { id: 'user:5120', name: 'Marcus Reed', title: 'Branch Manager' };
    const lap = { details: true, leads: true };
    const turn = { threadId: 'thr_lap4', runId: 'R-lap4', text: 'Create follow-up tasks for my stalled applications', context: [], user, tenant, apps: ['lap', 'referrals'], purviewBranches: ['Westport'], canViewSql: false, employeeId: 6, lap };
    const tasks = async () => ((await pool.query("SELECT COUNT(*) AS n FROM esp_com_items WHERE type_id = 'loan_follow_up'")) as unknown as [{ n: number }[]])[0][0]!.n;
    const before = await tasks();
    const out = await concierge.handle(turn, r.sink);
    if (out.kind !== 'handled' || !out.approval) throw new Error('expected an approval');
    const card = out.approval.card;
    expect(validateBlock(card).ok).toBe(true);
    expect(card.data).toMatchObject({ riskTier: 'medium', affected: { external: 0 } });
    expect(card.data.summary).toContain('Nobody outside the institution');
    expect(await tasks()).toBe(before);

    const after = recorder();
    const finished = new Promise<unknown>((resolve) => (after.sink.done = resolve));
    await concierge.resolveApproval({ approvalId: out.approval.approvalId, decision: 'approve', previewHash: card.data.previewHash, threadId: turn.threadId, runId: turn.runId, user, tenant, purviewBranches: ['Westport'], employeeId: 6, lap }, after.sink);
    const done = (await finished) as { notify: { employeeId: number; title: string }[] };
    expect(done.notify.length).toBeGreaterThan(0);
    expect(after.texts[0]).toMatch(/^Created \d+ follow-up tasks?/);

    // Each owner sees it in their own list, and it closes as Done, not Sold.
    const mine = await referrals.inbox('mine', { userId: 'user:6101', employeeId: 1 }, westport);
    const task = mine.find((i) => i.typeLabel === 'Application follow-up');
    expect(task).toBeDefined();
    made.push(task!.comId);
    const meta = { userId: 'user:6101', userName: 'Ana Ruiz', employeeId: 1 };
    await expect(referrals.transition(task!.comId, 'Sold', undefined, meta, westport)).rejects.toMatchObject({ code: 'INVALID' });
    expect((await referrals.transition(task!.comId, 'Done', undefined, meta, westport)).item.stage).toBe('Done');
  });

  it('lets only a lending administrator change a threshold, on a card', async () => {
    const refused = recorder();
    const out = await runPipelineOffline(input('Set the underwriting stall threshold for auto to 3 days', 'thr_lap5'), { gateway }, refused.sink);
    expect(out.approval).toBeUndefined();
    expect(refused.texts[0]).toContain('lending administrator');

    const r = recorder();
    const yes = await runPipelineOffline(input('Set the underwriting stall threshold for auto to 3 days', 'thr_lap6', { lap: { details: true, admin: true } }), { gateway }, r.sink);
    expect(yes.outcome).toBe('approval');
    const card = yes.approval!.card;
    expect(validateBlock(card).ok).toBe(true);
    expect(card.data.riskTier).toBe('medium');
    const a = await approvals.decide(yes.approval!.record.approvalId, { decision: 'approved', userId: 'user:6101', payloadHash: yes.approval!.record.payloadHash });
    await expect(gateway.execute(a, { user: { id: 'user:6101', name: 'Ana Ruiz' }, lap: { details: true } })).rejects.toMatchObject({ code: 'NO_ACCESS' });
  });
});
