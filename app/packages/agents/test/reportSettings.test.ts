// @vitest-environment node
// Report settings (today's DI Build Reports form): the offline phrases, changes to a draft and to a
// saved report, and who may open or change it, against the seeded warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '@dinext/block-schemas';
import { ApprovalStore, ReportStore } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { createPool, stockReports, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { newReportThread, parseReportRequest, ReportGateway, runReportOffline, type ReportThread, type RunSink } from '../src/index.ts';
import { classesNamed, settingsDiff } from '../src/reportSettings.ts';

describe('reading settings requests', () => {
  it('reads each example phrase, before any draft edit', () => {
    expect(parseReportRequest('Make it quarterly', true)).toEqual({ intent: 'settings', target: '', set: { period_type: 'quarter' } });
    expect(parseReportRequest('Make the branch scorecard monthly', false)).toEqual({ intent: 'settings', target: 'branch scorecard', set: { period_type: 'month' } });
    expect(parseReportRequest('Use the previous period by default', false)).toEqual({ intent: 'settings', target: '', set: { use_period: 'previous' } });
    expect(parseReportRequest('Turn off the branch control', true)).toEqual({ intent: 'settings', target: '', set: { branch_control: false } });
    expect(parseReportRequest('Only Managers and Executives can run it', false)).toEqual({ intent: 'settings', target: '', set: { who_can_open: ['managers', 'executives'] } });
    expect(parseReportRequest('Disable this report', false)).toEqual({ intent: 'settings', target: '', set: { enabled: false } });
    expect(parseReportRequest('Enable the Westport review', false)).toEqual({ intent: 'settings', target: 'westport review', set: { enabled: true } });
    expect(parseReportRequest('Rename it to “Westport monthly review”', false)).toEqual({ intent: 'settings', target: '', set: { name: 'Westport monthly review' } });
    expect(parseReportRequest('Show the queries', false)).toEqual({ intent: 'settings', target: '', set: { show_queries: true } });
    expect(parseReportRequest('What are the settings for the branch scorecard?', false)).toEqual({ intent: 'settings_show', target: 'branch scorecard' });
    expect(parseReportRequest('Make a copy of the branch scorecard', false)).toEqual({ intent: 'copy', target: 'branch scorecard' });
    // Draft edits still read as edits.
    expect(parseReportRequest('Make the deposit mix a bar chart', true)).toMatchObject({ intent: 'edit', edit: 'chart' });
    expect(parseReportRequest('Remove the deposit chart', true)).toMatchObject({ intent: 'edit', edit: 'remove' });
  });

  it('matches class words and shows each change before and after', () => {
    expect(classesNamed(['managers', 'the Executive class'], ['Executive', 'Manager'])).toEqual({ classes: ['Manager', 'Executive'], unknown: [] });
    expect(classesNamed(['everyone'], ['Executive'])).toEqual({ classes: [], unknown: [] });
    expect(classesNamed(['lenders'], ['Executive'])).toEqual({ classes: [], unknown: ['lenders'] });
    const def = stockReports('credit_union')[0]!;
    const d = settingsDiff(def, { periodType: 'quarter', usePeriod: 'current', enabled: false });
    // "Default period" is already current, so it drops out.
    expect(d.changes).toEqual([
      { label: 'Period type', before: 'Monthly', after: 'Quarterly' },
      { label: 'Enabled', before: 'Yes', after: 'No, turned off' },
    ]);
  });
});

const available = await warehouseAvailable('dinext_t_test_cu');
let pool: Pool;
let admin: Pool;
let gateway: ReportGateway;
let approvals: ApprovalStore;
let templateId: string;
const DANA = { id: 'user:settest1', name: 'Dana Settest', title: 'CEO' };
const MARCUS = { id: 'user:settest2', name: 'Marcus Settest', title: 'Branch Manager' };
const PRIYA = { id: 'user:settest3', name: 'Priya Settest', title: 'BI Manager' };
const NAME = 'Settest Westport review';

beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
  const semantic = await SemanticService.create(pool, 'test_cu', 'credit_union');
  approvals = new ApprovalStore(pool);
  gateway = new ReportGateway({ store: new ReportStore(pool), semantic, approvals });
  const stock = stockReports('credit_union')[0]!;
  const draft = await gateway.store.saveDraft({ ...stock, settings: { ...stock.settings, controlClasses: [] }, templateId: 'new', name: NAME, folder: 'Drafts' }, DANA, 'thr_settest_setup');
  templateId = (await gateway.store.publish({ draftId: draft.templateId, name: NAME, folder: 'Retail / Westport', definition: draft.definition }, { approvalId: `apr_settest_${Date.now()}`, userId: DANA.id, userName: DANA.name, agent: 'Report Builder' })).templateId;
});
afterAll(async () => {
  if (!available) return;
  await admin.query('DELETE FROM esp_report_setting_changes WHERE user_id LIKE ?', ['user:settest%']);
  await admin.query("DELETE FROM esp_report_templates WHERE owner_user_id LIKE 'user:settest%'");
  await admin.query("DELETE FROM ai_approvals WHERE requested_by LIKE 'user:settest%'");
  await Promise.all([pool.end(), admin.end()]);
});

function sink() {
  const texts: string[] = [];
  const blocks: Block[] = [];
  const s: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan0000000001', step: () => {}, text: async (md) => void texts.push(md), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { s, texts, blocks };
}
const who = { [DANA.id]: 'Executive', [MARCUS.id]: 'Manager', [PRIYA.id]: 'Analyst' };
const input = (text: string, user = DANA, canViewSql = false) => ({ runId: `R-settest-${Math.random().toString(36).slice(2, 7)}`, threadId: `thr_settest_${Math.random().toString(36).slice(2, 7)}`, text, user, tenant: { name: 'Harborview Federal Credit Union', institutionType: 'credit_union' as const }, apps: ['reports'], canViewSql, userClass: who[user.id] });
const ask = async (text: string, user = DANA, state: ReportThread = newReportThread(), canViewSql = false) => {
  const out = sink();
  const r = await runReportOffline(input(text, user, canViewSql), { gateway }, state, out.s);
  return { r, out, said: out.texts.join(' ') };
};
const approve = async (r: Awaited<ReturnType<typeof ask>>['r'], user = DANA) => gateway.execute(await approvals.decide(r.approval!.record.approvalId, { decision: 'approved', userId: user.id }), { user });

describe.skipIf(!available)('settings of a draft', () => {
  it('changes a draft at once, like any draft edit, with no card', async () => {
    const state = newReportThread();
    const copy = await ask('Make a copy of the branch scorecard', DANA, state);
    expect(copy.r.outcome).toBe('report');
    expect(state.current!.templateId).toMatch(/^draft_/);
    const draft = await gateway.store.get(state.current!.templateId, DANA.id);
    // A copy is yours, open to everyone once saved, and turned on.
    expect(draft.definition.settings).toMatchObject({ controlClasses: [], enabled: true });
    expect(draft.name).toBe('Branch scorecard (copy)');
    const q = await ask('Make it quarterly', DANA, state);
    expect(q.r.outcome).toBe('report');
    expect(q.r.approval).toBeUndefined();
    expect(q.said).toContain('period type quarterly');
    expect((await gateway.store.get(state.current!.templateId, DANA.id)).definition.settings.periodType).toBe('quarter');
    const off = await ask('Turn off the branch control', DANA, state);
    expect(off.out.blocks.find((b) => b.type === 'report_canvas')!.data).toMatchObject({ controls: [{ id: 'period' }] });
    // Saying it again changes nothing.
    expect((await ask('Turn off the branch control', DANA, state)).said).toContain('already set that way');
    await admin.query('DELETE FROM esp_report_templates WHERE template_id = ?', [state.current!.templateId]);
  });
});

describe.skipIf(!available)('settings of a saved report', () => {
  it('shows each change before and after on a medium card, and applies it once', async () => {
    const { r } = await ask(`Make the ${NAME} quarterly`);
    expect(r.outcome).toBe('approval');
    expect(r.approval!.card.data).toMatchObject({ riskTier: 'medium', operation: 'report.settings.update', summary: `Change “${NAME}”: period type`, preview: { kind: 'diff', changes: [{ label: 'Period type', before: 'Monthly', after: 'Quarterly' }] } });
    // Nothing changes until it's approved.
    expect((await gateway.store.get(templateId, DANA.id)).definition.settings.periodType).toBe('month');
    const approved = await approvals.decide(r.approval!.record.approvalId, { decision: 'approved', userId: DANA.id });
    const x = await gateway.execute(approved, { user: DANA });
    expect(x).toMatchObject({ operation: 'report.settings.update', templateName: NAME, replayed: false, changes: [{ label: 'Period type', after: 'Quarterly' }] });
    const t = await gateway.store.get(templateId, DANA.id);
    expect(t.definition.settings.periodType).toBe('quarter');
    // A retried apply changes nothing more.
    const again = await gateway.store.updateSettings(approved.payload as never, { approvalId: approved.approvalId, userId: DANA.id, userName: DANA.name });
    expect(again.replayed).toBe(true);
    expect(again.version).toBe(t.version);
    const [rows] = await admin.query('SELECT COUNT(*) AS n FROM esp_report_setting_changes WHERE approval_id = ?', [approved.approvalId]);
    expect((rows as { n: number }[])[0]!.n).toBe(1);
    expect((await gateway.settings(templateId, { user: DANA, canViewSql: false })).lastChange).toMatch(/^Last changed by Dana Settest/);
  });

  it('limits who can open it, and says what that affects', async () => {
    const { r } = await ask('Only Managers and Executives can run it', DANA, { history: [], current: { templateId, controls: {} } });
    expect(JSON.stringify(r.approval!.card.data.preview)).toContain('Manager, Executive classes');
    expect(JSON.stringify(r.approval!.card.data.preview)).toContain('0 Home pins, 0 active schedules');
    await approve(r);
    // Marcus is a Manager; Priya is an Analyst, so for her it reads as not found.
    expect((await gateway.store.list(MARCUS.id, { userClass: 'Manager' })).some((t) => t.templateId === templateId)).toBe(true);
    expect((await gateway.store.list(PRIYA.id, { userClass: 'Analyst' })).some((t) => t.templateId === templateId)).toBe(false);
    await expect(gateway.store.get(templateId, PRIYA.id, { userClass: 'Analyst' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(gateway.store.get(templateId, PRIYA.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await approve((await ask(`Let everyone run the ${NAME}`)).r);
    expect((await gateway.store.list(PRIYA.id, { userClass: 'Analyst' })).some((t) => t.templateId === templateId)).toBe(true);
  });

  it('turns a report off: it doesn’t run, and others can’t see it', async () => {
    const { r } = await ask(`Disable the ${NAME}`);
    expect(r.approval!.card.data.preview).toMatchObject({ changes: [{ label: 'Enabled', before: 'Yes', after: 'No, turned off' }, { label: 'What it affects' }] });
    await approve(r);
    await expect(gateway.store.get(templateId, MARCUS.id, { userClass: 'Manager' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(gateway.run(templateId, {}, { user: DANA, runId: 'R-settest-run', canViewSql: false })).rejects.toThrow(/turned off/);
    // Its owner still sees its settings, and can turn it back on.
    expect((await gateway.settings(templateId, { user: DANA, canViewSql: false })).tiles.find((x) => x.label === 'Status')!.value).toBe('Turned off');
    await approve((await ask(`Enable the ${NAME}`)).r);
    expect((await gateway.store.get(templateId, MARCUS.id, { userClass: 'Manager' })).name).toBe(NAME);
  });

  it('renames it, and shows queries only to Query Browser users', async () => {
    const state: ReportThread = { history: [], current: { templateId, controls: {} } };
    const denied = await ask('Show the queries', DANA, state);
    expect(denied.r.approval).toBeUndefined();
    expect(denied.said).toMatch(/Query Browser permission/);
    const q = await ask('Show the queries', DANA, state, true);
    await approve(q.r);
    const { canvas } = await gateway.run(templateId, {}, { user: DANA, runId: 'R-settest-sql', canViewSql: true });
    expect(canvas.data.queries?.length).toBeGreaterThan(0);
    const hidden = await gateway.run(templateId, {}, { user: DANA, runId: 'R-settest-sql2', canViewSql: false });
    expect(hidden.canvas.data.queries).toBeUndefined();
    const rename = await ask('Rename it to “Settest Westport quarterly”', DANA, state);
    expect(rename.r.approval!.card.data.preview).toMatchObject({ changes: [{ label: 'Name', before: NAME, after: 'Settest Westport quarterly' }] });
  });

  it('won’t change a stock report, or someone else’s', async () => {
    const stock = await ask('Make the branch scorecard quarterly');
    expect(stock.r.approval).toBeUndefined();
    expect(stock.said).toMatch(/stock report every user starts with, so its settings can’t be changed. Say “make a copy of the Branch scorecard”/);
    const other = await ask(`Make the ${NAME} monthly`, MARCUS);
    expect(other.r.approval).toBeUndefined();
    expect(other.said).toContain(`belongs to ${DANA.name}`);
    const view = await gateway.settings('branch_scorecard_monthly', { user: MARCUS, canViewSql: false });
    expect(view).toMatchObject({ status: 'stock', canChange: false, prompts: ['Make a copy of the Branch scorecard'] });
    expect(view.groups.map((g) => g.title)).toEqual(['Basics', 'Configuration', 'Report controls', 'Period and hierarchy info', 'Test and preview settings']);
    expect(view.groups.flatMap((g) => g.fields).find((f) => f.label === 'Test data cache?')).toMatchObject({ used: false, value: 'Not used: DI runs every report on the nightly build.' });
  });

  it('shows the settings in the conversation', async () => {
    const { r, out, said } = await ask('What are the settings for the branch scorecard?');
    expect(r.outcome).toBe('answer');
    expect(said).toContain('[Open its settings](/reports/branch_scorecard_monthly?view=settings)');
    expect(out.blocks.find((b) => b.type === 'table')).toMatchObject({ title: 'Branch scorecard: settings' });
  });
});
