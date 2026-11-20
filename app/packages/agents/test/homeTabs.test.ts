// @vitest-environment node
// Named Home tabs (today's DI: the "+" tab, Add Item, and which user classes see a tab), made by asking
// DI, against the seeded warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '@dinext/block-schemas';
import { ApprovalStore, ReportStore } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { createPool, stockReports, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { newReportThread, ReportGateway, runReportOffline, type ReportThread, type RunSink } from '../src/index.ts';
import { parseTabRequest } from '../src/reportAgent.ts';
import { homeTabId } from '../src/report.ts';

describe('reading Home tab requests', () => {
  it('reads making a tab, adding to it, renaming, removing, publishing and listing', () => {
    expect(parseTabRequest('Add a Branch tab with the branch scorecard')).toEqual({ intent: 'tab_pin', tab: 'Branch', report: 'branch scorecard', audience: 'me' });
    expect(parseTabRequest('Add a tab called Lending to my Home with the loan portfolio report')).toEqual({ intent: 'tab_pin', tab: 'Lending', report: 'loan portfolio report', audience: 'me' });
    expect(parseTabRequest('Add a tab to my Home called Board')).toEqual({ intent: 'tab_pin', tab: 'Board', report: null, audience: 'me' });
    expect(parseTabRequest('Add a tab to my Home')).toEqual({ intent: 'tab_pin', tab: null, report: null, audience: 'me' });
    expect(parseTabRequest('Put the deposit portfolio report on my Branch tab')).toEqual({ intent: 'tab_pin', tab: 'Branch', report: 'deposit portfolio report', audience: 'me' });
    expect(parseTabRequest('Add a report to my Branch tab: member growth')).toEqual({ intent: 'tab_pin', tab: 'Branch', report: 'member growth', audience: 'me' });
    expect(parseTabRequest('Add a Branch tab with the branch scorecard for managers')).toEqual({ intent: 'tab_pin', tab: 'Branch', report: 'branch scorecard', audience: 'managers' });
    expect(parseTabRequest('Rename my Branch tab to Branch ops')).toEqual({ intent: 'tab_rename', tab: 'Branch', newName: 'Branch ops' });
    expect(parseTabRequest('Remove the Branch tab from my Home')).toEqual({ intent: 'tab_remove', tab: 'Branch' });
    expect(parseTabRequest('Show my Branch tab to managers')).toEqual({ intent: 'tab_publish', tab: 'Branch', audience: 'managers' });
    expect(parseTabRequest('What tabs do I have on Home?')).toEqual({ intent: 'tab_list' });
    // Tabs elsewhere, and requests that don't name a Home tab, aren't Home tabs.
    expect(parseTabRequest('Open the Workflows tab for Suzanne Jackson')).toBeNull();
    expect(parseTabRequest('Pin the branch scorecard to my Home')).toBeNull();
    expect(homeTabId('Branch ops')).toBe('tab-branch-ops');
  });
});

const available = await warehouseAvailable('dinext_t_test_cu');
let pool: Pool;
let admin: Pool;
let gateway: ReportGateway;
let approvals: ApprovalStore;
const DANA = { id: 'user:tabtest1', name: 'Dana Tabtest', title: 'CEO' };
const MARCUS = { id: 'user:tabtest2', name: 'Marcus Tabtest', title: 'Branch Manager' };
const NAME = 'Tabtest branch review';
const STOCK = stockReports('credit_union')[0]!.name;

beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
  const semantic = await SemanticService.create(pool, 'test_cu', 'credit_union');
  approvals = new ApprovalStore(pool);
  gateway = new ReportGateway({ store: new ReportStore(pool), semantic, approvals, classSize: async (c) => (c === 'Manager' ? 6 : 3) });
  const stock = stockReports('credit_union')[0]!;
  const draft = await gateway.store.saveDraft({ ...stock, settings: { ...stock.settings, controlClasses: [] }, templateId: 'new', name: NAME, folder: 'Drafts' }, DANA, 'thr_tabtest_setup');
  await gateway.store.publish({ draftId: draft.templateId, name: NAME, folder: 'Branches', definition: draft.definition }, { approvalId: `apr_tabtest_${Date.now()}`, userId: DANA.id, userName: DANA.name, agent: 'Report Builder' });
});
afterAll(async () => {
  if (!available) return;
  await admin.query("DELETE FROM esp_report_pins WHERE user_id LIKE 'user:tabtest%'");
  await admin.query("DELETE FROM esp_report_templates WHERE owner_user_id LIKE 'user:tabtest%'");
  await admin.query("DELETE FROM ai_approvals WHERE requested_by LIKE 'user:tabtest%'");
  await Promise.all([pool.end(), admin.end()]);
});

const input = (text: string, user = DANA) => ({ runId: `R-tabtest-${Math.random().toString(36).slice(2, 7)}`, threadId: `thr_tabtest_${Math.random().toString(36).slice(2, 7)}`, text, user, tenant: { name: 'Harborview Federal Credit Union', institutionType: 'credit_union' as const }, apps: ['reports'], canViewSql: false });
const ask = async (text: string, user = DANA, state: ReportThread = newReportThread()) => {
  const texts: string[] = [];
  const blocks: Block[] = [];
  const s: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan0000000001', step: () => {}, text: async (md) => void texts.push(md), block: async (b) => void blocks.push(b), suggestion: () => {} };
  const r = await runReportOffline(input(text, user), { gateway }, state, s);
  return { r, text: texts.join(' ') };
};
const approve = async (r: Awaited<ReturnType<typeof ask>>['r'], user = DANA) => gateway.execute(await approvals.decide(r.approval!.record.approvalId, { decision: 'approved', userId: user.id }), { user });
const tabsOn = async (userId: string, cls: string) => (await gateway.store.pins(userId, cls)).map((p) => [p.tab, p.templateName]);

describe.skipIf(!available)('named Home tabs', () => {
  it('makes a tab with its first report on approval, and adds another to it', async () => {
    const { r } = await ask(`Add a Branch tab with the ${NAME} report`);
    expect(r.approval!.card.data).toMatchObject({ riskTier: 'low', summary: `Pin “${NAME}” to your Home, on the Branch tab` });
    expect(await tabsOn(DANA.id, 'Executive')).toEqual([]);
    expect(await approve(r)).toMatchObject({ operation: 'report.pin', tab: 'Branch', audience: 'me' });
    await approve((await ask(`Put the ${STOCK} report on my Branch tab`)).r);
    expect((await tabsOn(DANA.id, 'Executive')).sort()).toEqual([['Branch', NAME], ['Branch', STOCK]].sort());
    expect((await ask('What tabs do I have on Home?')).text).toContain('**Branch** (2 reports, seen by you)');
  });

  it('asks what a tab is for when it isn’t said, and which report when none is found', async () => {
    expect((await ask('Add a tab to my Home')).text).toContain('What should the tab be called');
    const none = await ask('Add a Board tab with the flux capacitor report');
    expect(none.r.approval).toBeUndefined();
    expect(none.text).toContain('I couldn’t find a report called “flux capacitor report”');
  });

  it('publishes a whole tab to a class, renames it and takes it off every Home', async () => {
    const pub = await ask('Show my Branch tab to managers');
    expect(pub.r.approval!.card.data).toMatchObject({ riskTier: 'medium', summary: 'Publish the Branch tab to Home for the Manager class', affected: { users: 6 } });
    expect(await approve(pub.r)).toMatchObject({ operation: 'report.tab.publish', tab: 'Branch', audience: 'Manager', reports: 2 });
    expect((await tabsOn(MARCUS.id, 'Manager')).sort()).toEqual([['Branch', NAME], ['Branch', STOCK]].sort());
    // Only the person who made a tab can change it.
    expect((await ask('Rename my Branch tab to Ops', MARCUS)).text).toContain('You have no named tabs on Home yet');

    const ren = await ask('Rename my Branch tab to Branch ops');
    expect(ren.r.approval!.card.data).toMatchObject({ riskTier: 'low', summary: 'Rename the Branch tab to Branch ops' });
    await approve(ren.r);
    expect([...new Set((await tabsOn(MARCUS.id, 'Manager')).map(([t]) => t))]).toEqual(['Branch ops']);

    const rem = await ask('Remove the Branch ops tab from my Home');
    expect(rem.r.approval!.card.data).toMatchObject({ riskTier: 'medium', summary: 'Take the Branch ops tab off Home' });
    expect(await approve(rem.r)).toMatchObject({ operation: 'report.tab.remove', removed: 4 });
    expect(await tabsOn(DANA.id, 'Executive')).toEqual([]);
    expect(await tabsOn(MARCUS.id, 'Manager')).toEqual([]);
  });
});
