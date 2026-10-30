// @vitest-environment node
// Report engine, report gateway and the Report Builder's offline planner (spec 8.5–8.9, 18, 24.5),
// against the seeded warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, ReportStore } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { createPool, stockReports, tenantPool, warehouseAvailable, type Pool, type ReportDefinition } from '@dinext/tenant-db';
import { applyEdits, newReportThread, parsePeriod, parseReportRequest, periodOptions, ReportGateway, resolveEdit, resolveRecipients, runReport, runReportOffline, timeFor, type RunSink } from '../src/index.ts';

describe('periods and controls (spec 18.3)', () => {
  it('lists complete periods newest first and maps them to semantic time ranges', () => {
    expect(periodOptions('month', '2026-09-30').slice(0, 2)).toEqual([
      { value: '2026-09', label: 'Sep 2026' },
      { value: '2026-08', label: 'Aug 2026' },
    ]);
    expect(periodOptions('month', '2026-09-30')).toHaveLength(13);
    expect(periodOptions('quarter', '2026-09-30')[0]).toEqual({ value: '2026-Q3', label: 'Q3 2026' });
    expect(periodOptions('quarter', '2026-02-28')[0]).toEqual({ value: '2025-Q4', label: 'Q4 2025' });
    expect(timeFor('month', '2026-09', 13)).toEqual({ grain: 'month', from: '2025-09', to: '2026-09' });
    expect(timeFor('quarter', '2026-Q3', 2)).toEqual({ grain: 'quarter', from: '2026-04', to: '2026-09' });
  });

  it('reads periods the way people say them', () => {
    expect(parsePeriod('Open the September monthly report', 'month', '2026-09-30')).toBe('2026-09');
    expect(parsePeriod('the scorecard for Aug 2026', 'month', '2026-09-30')).toBe('2026-08');
    expect(parsePeriod('last month', 'month', '2026-09-30')).toBe('2026-09');
    expect(parsePeriod('Q2 please', 'quarter', '2026-09-30')).toBe('2026-Q2');
    // A month that has not been built is not guessed.
    expect(parsePeriod('October', 'month', '2026-09-30')).toBe('2025-10');
  });
});

describe('draft edits (FE-BLD-003)', () => {
  const base: ReportDefinition = { ...stockReports('credit_union')[1]!, templateId: 'draft_test', pendingEdits: [] };
  it('records each change for review, and revert restores exactly what was there', () => {
    const changed = applyEdits(base, [{ op: 'change', widget_id: 'c2', set: { chart: 'bar' } }, { op: 'remove', widget_id: 'k1' }, { op: 'add', widget: { title: 'New loans', kind: 'kpi', metrics: ['new_loan_amount'], compare: true, size: 'third' }, position: 0 }]);
    expect(changed.pendingEdits.map((e) => e.summary)).toEqual(['Made “Deposit mix” a bar chart', 'Removed “Loan-to-share”', 'Added “New loans”']);
    expect(changed.widgets[0]!.title).toBe('New loans');
    let d = changed;
    for (const e of [...changed.pendingEdits].reverse()) d = resolveEdit(d, e.id, 'revert');
    expect(d.widgets).toEqual(base.widgets);
    expect(d.pendingEdits).toEqual([]);
    const kept = resolveEdit(changed, changed.pendingEdits[0]!.id, 'accept');
    expect(kept.widgets.find((w) => w.id === 'c2')!.chart).toBe('bar');
    expect(() => resolveEdit(kept, changed.pendingEdits[0]!.id, 'accept')).toThrow(/already/);
  });
});

describe('offline reading of report requests', () => {
  it('reads opening, building, editing, saving, scheduling, exporting and stopping', () => {
    expect(parseReportRequest('Open the September branch scorecard for Westport', false)).toEqual({ intent: 'run', words: 'open the september branch scorecard for westport' });
    expect(parseReportRequest('Build me a monthly ALCO pack with loan balance trend, deposit mix and delinquency ratio', false)).toEqual({ intent: 'build', name: 'ALCO pack', periodType: 'month', items: ['loan balance trend', 'deposit mix', 'delinquency ratio'] });
    expect(parseReportRequest('Make the deposit mix a donut', true)).toMatchObject({ intent: 'edit', edit: 'chart', target: 'deposit mix', chart: 'donut' });
    expect(parseReportRequest('Make the deposit mix a donut', false)).toMatchObject({ intent: 'run' });
    expect(parseReportRequest('Save it in Finance / ALCO', true)).toEqual({ intent: 'save', folder: 'Finance / ALCO' });
    expect(parseReportRequest('Send this report to the ALCO group monthly on the third business day', false)).toMatchObject({ intent: 'schedule', frequency: 'monthly', day: 'BD3', recipients: ['ALCO group'], format: 'xlsx' });
    expect(parseReportRequest('Send me the branch scorecard every Monday, even if it is empty', false)).toMatchObject({ intent: 'schedule', frequency: 'weekly', day: 'MON', recipients: ['me'] });
    expect(parseReportRequest('Export it to CSV', true)).toEqual({ intent: 'export', format: 'csv' });
    expect(parseReportRequest('Stop the weekly scorecard email', false)).toMatchObject({ intent: 'cancel' });
    expect(parseReportRequest('Which reports are scheduled for me?', false)).toEqual({ intent: 'schedule_list' });
  });

  it('counts recipients and flags outside addresses (spec 8.8)', () => {
    expect(resolveRecipients(['me', 'ALCO group', 'all lending staff'], { name: 'Dana Lee' }).map((r) => [r.kind, r.count])).toEqual([
      ['user', 1],
      ['group', 7],
      ['group', 31],
    ]);
    expect(resolveRecipients(['auditor@example.com'], { name: 'Dana Lee' })[0]).toMatchObject({ kind: 'external' });
    expect(() => resolveRecipients(['The board'], { name: 'Dana Lee' })).toThrow(/No user or group/);
  });
});

const available = await warehouseAvailable('dinext_t_test_cu');
let pool: Pool;
let admin: Pool;
let gateway: ReportGateway;
let semantic: SemanticService;
const DANA = { id: 'user:rpttest1', name: 'Dana Test', title: 'CEO' };
const MARCUS = { id: 'user:rpttest2', name: 'Marcus Test', title: 'Branch Manager' };

beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
  semantic = await SemanticService.create(pool, 'test_cu', 'credit_union');
  gateway = new ReportGateway({ store: new ReportStore(pool), semantic, approvals: new ApprovalStore(pool) });
});
afterAll(async () => {
  if (!available) return;
  await admin.query("DELETE FROM esp_report_exports WHERE user_id LIKE 'user:rpttest%'");
  await admin.query("DELETE FROM esp_report_schedules WHERE owner_user_id LIKE 'user:rpttest%'");
  await admin.query("DELETE FROM esp_report_templates WHERE owner_user_id LIKE 'user:rpttest%'");
  await admin.query("DELETE FROM ai_approvals WHERE requested_by LIKE 'user:rpttest%' OR thread_id = 'thr_rpttest_schedule'");
  await Promise.all([pool.end(), admin.end()]);
});

function sink() {
  const texts: string[] = [];
  const blocks: Block[] = [];
  const s: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan0000000001', step: () => {}, text: async (md) => void texts.push(md), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { s, texts, blocks };
}
const input = (text: string, user = DANA, purviewBranches?: string[]) => ({ runId: `R-rpttest-${Math.random().toString(36).slice(2, 7)}`, threadId: `thr_rpttest_${Math.random().toString(36).slice(2, 7)}`, text, user, tenant: { name: 'Harborview Federal Credit Union', institutionType: 'credit_union' as const }, apps: ['reports'], purviewBranches, canViewSql: false });

describe.skipIf(!available)('report engine (spec 8.5, 18)', () => {
  it('runs a stock report into a valid canvas whose figures come from the semantic layer', async () => {
    const def = stockReports('credit_union')[0]!;
    const { canvas } = await runReport(def, { period: '2026-08', node: 'Westport' }, semantic, { canViewSql: false }, { runId: 'R-rpttest-1', mode: 'read', status: 'stock', version: 1 });
    expect(validateBlock(canvas).ok).toBe(true);
    expect(canvas.data.controls.map((c) => c.value)).toEqual(['2026-08', 'Westport']);
    const kpi = canvas.data.widgets[0]!.view;
    const direct = await semantic.query({ metrics: ['loan_balance'], filters: [{ dimension: 'branch', op: 'in', values: ['Westport'] }], time: { grain: 'month', from: '2026-08', to: '2026-08' } }, { canViewSql: false });
    expect(kpi.type === 'kpi' && kpi.data.value).toBeCloseTo(direct.rows[0]!.loan_balance as number, 2);
    expect(canvas.data.widgets.map((w) => w.gridPos)).toEqual([
      { x: 0, y: 0, w: 3, h: 2 },
      { x: 3, y: 0, w: 3, h: 2 },
      { x: 6, y: 0, w: 3, h: 2 },
      { x: 9, y: 0, w: 3, h: 2 },
      { x: 0, y: 2, w: 12, h: 4 },
      { x: 0, y: 6, w: 12, h: 4 },
    ]);
  });

  it('keeps a branch user inside their purview, and says so when asked for another branch (spec 20.7)', async () => {
    const def = stockReports('credit_union')[0]!;
    const { canvas, notice } = await runReport(def, { node: 'Northgate' }, semantic, { purviewBranches: ['Westport'], canViewSql: false }, { runId: 'R-rpttest-2', mode: 'read', status: 'stock', version: 1 });
    expect(notice).toBe('Northgate is outside your access. Showing Westport.');
    expect(canvas.data.controls[1]!.options.map((o) => o.value)).toEqual(['Westport']);
    expect(JSON.stringify(canvas)).not.toMatch(/Northgate/);
  });

  it('says when a period has not been built (FE-RPTP-003)', async () => {
    const { notice, canvas } = await runReport(stockReports('credit_union')[0]!, { period: '2026-10' }, semantic, { canViewSql: false }, { runId: 'R-rpttest-3', mode: 'read', status: 'stock', version: 1 });
    expect(notice).toMatch(/^2026-10 has not been built yet\. Showing Sep 2026/);
    expect(canvas.data.periodLabel).toBe('Sep 2026');
  });
});

describe.skipIf(!available)('Report Builder, offline planner', () => {
  it('builds a private draft with live data and marks an undefined measure, never inventing it (spec 24.5)', async () => {
    const state = newReportThread();
    const out = sink();
    const r = await runReportOffline(input('Build me a monthly ALCO pack with loan balance trend, deposit mix, certificate share and delinquency ratio'), { gateway }, state, out.s);
    expect(r.outcome).toBe('report');
    const canvas = out.blocks.find((b) => b.type === 'report_canvas')!;
    expect(validateBlock(canvas).ok).toBe(true);
    expect(canvas).toMatchObject({ data: { status: 'draft', mode: 'edit', name: 'ALCO pack' } });
    const views = (canvas as Extract<Block, { type: 'report_canvas' }>).data.widgets.map((w) => `${w.title}:${w.view.type}`);
    expect(views).toEqual(['Loan balance trend:chart', 'Deposit mix:chart', 'Certificate share:notice', 'Delinquency ratio:kpi']);
    expect(out.texts[0]).toMatch(/Certificate share isn’t defined in the catalog yet/);
    expect(state.current!.templateId).toMatch(/^draft_[0-9a-f]{12}$/);
    // Another user cannot see the draft.
    await expect(gateway.store.get(state.current!.templateId, MARCUS.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Edit, then save through a medium card; the approved save is created once, with its origin.
    const edit = await runReportOffline(input('Make the deposit mix a bar chart'), { gateway }, state, sink().s);
    expect(edit.outcome).toBe('report');
    const save = await runReportOffline(input('Save it in Finance / ALCO'), { gateway }, state, sink().s);
    expect(save.approval?.card).toMatchObject({ data: { riskTier: 'medium', operation: 'report.template.create', summary: 'Save “ALCO pack” in Finance / ALCO' } });
    const approvals = new ApprovalStore(pool);
    const approved = await approvals.decide(save.approval!.record.approvalId, { decision: 'approved', userId: DANA.id });
    const first = await gateway.execute(approved, { user: DANA });
    expect(first).toMatchObject({ operation: 'report.template.create', template: { name: 'ALCO pack', folder: 'Finance / ALCO', status: 'published', origin: { agent: 'Report Builder', approvedBy: 'Dana Test' } } });
    // Saving keeps what was on screen: the bar chart change is part of the saved report.
    expect(first.operation === 'report.template.create' && first.template.definition.widgets.find((w) => w.title === 'Deposit mix')!.chart).toBe('bar');
    const replay = await gateway.store.publish(save.approval!.record.payload as never, { approvalId: save.approval!.record.approvalId, userId: DANA.id, userName: DANA.name, agent: 'Report Builder' });
    expect(replay.replayed).toBe(true);
  });

  it('schedules after the build, high risk above 25 recipients with the count typed (spec 8.8)', async () => {
    const state = newReportThread();
    const turn = (text: string) => ({ ...input(text), threadId: 'thr_rpttest_schedule' });
    await runReportOffline(turn('Open the branch scorecard'), { gateway }, state, sink().s);
    const small = await runReportOffline(turn('Send this report to me every Monday'), { gateway }, state, sink().s);
    expect(small.approval?.card.data).toMatchObject({ riskTier: 'medium', confirmation: { typedValue: null } });
    const big = await runReportOffline(turn('Send this report to the ALCO group and All lending staff monthly on the third business day'), { gateway }, state, sink().s);
    expect(big.approval?.card.data).toMatchObject({ riskTier: 'high', confirmation: { typedValue: { expected: '38' } }, summary: 'Send “Branch scorecard” monthly, business day 3, after the nightly build, to 38 recipients' });
    // The newer card replaced the older one in the same thread.
    expect(big.superseded).toContain(small.approval!.record.approvalId);
  });

  it('exports what was on screen, once, for the user who approved it (spec 18.6)', async () => {
    const state = newReportThread();
    await runReportOffline(input('Open the August branch scorecard for Riverside'), { gateway }, state, sink().s);
    const r = await runReportOffline(input('Export it to Excel'), { gateway }, state, sink().s);
    expect(r.approval?.card.data.preview).toMatchObject({ fields: expect.arrayContaining([{ label: 'Period', value: 'Aug 2026' }, { label: 'Branch', value: 'Riverside' }]) });
    const approved = await new ApprovalStore(pool).decide(r.approval!.record.approvalId, { decision: 'approved', userId: DANA.id });
    const x = await gateway.execute(approved, { user: DANA });
    expect(x.operation).toBe('report.export');
    const exportId = x.operation === 'report.export' ? x.exportId : '';
    expect(await gateway.store.export(exportId, DANA.id)).toMatchObject({ format: 'xlsx', controls: { period: '2026-08', node: 'Riverside' } });
    await expect(gateway.store.export(exportId, MARCUS.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
