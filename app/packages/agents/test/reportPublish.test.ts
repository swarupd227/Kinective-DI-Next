// @vitest-environment node
// Reports on Home and the reports Recycle Bin (today's DI: "Save to Home and share with a class"),
// against the seeded warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '@dinext/block-schemas';
import { ApprovalStore, ReportStore } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { createPool, stockReports, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { newReportThread, parseReportRequest, ReportGateway, runReportOffline, type ReportThread, type RunSink } from '../src/index.ts';

describe('reading Home and Recycle Bin requests', () => {
  it('tells pinning, publishing, unpinning, deleting and restoring apart', () => {
    expect(parseReportRequest('Pin the branch scorecard to my Home', false)).toEqual({ intent: 'pin', audience: 'me' });
    expect(parseReportRequest('Pin this to Home', false)).toEqual({ intent: 'pin', audience: 'me' });
    expect(parseReportRequest('Publish the branch scorecard to Home for managers', false)).toEqual({ intent: 'pin', audience: 'manager' });
    expect(parseReportRequest('Publish it to Home for the Analyst class', false)).toEqual({ intent: 'pin', audience: 'analyst' });
    expect(parseReportRequest('Take the branch scorecard off my Home', false)).toEqual({ intent: 'unpin' });
    expect(parseReportRequest('Unpin it', false)).toEqual({ intent: 'unpin' });
    expect(parseReportRequest('Delete the Westport review report', false)).toEqual({ intent: 'delete' });
    expect(parseReportRequest('What’s in the reports Recycle Bin?', false)).toEqual({ intent: 'bin' });
    expect(parseReportRequest('Restore the Westport review report', false)).toEqual({ intent: 'restore' });
    // On a draft, "delete the deposit chart" still removes a section.
    expect(parseReportRequest('Delete the deposit chart', true)).toMatchObject({ intent: 'edit', edit: 'remove' });
  });
});

const available = await warehouseAvailable('dinext_t_test_cu');
let pool: Pool;
let admin: Pool;
let gateway: ReportGateway;
let approvals: ApprovalStore;
let templateId: string;
const DANA = { id: 'user:pintest1', name: 'Dana Pintest', title: 'CEO' };
const MARCUS = { id: 'user:pintest2', name: 'Marcus Pintest', title: 'Branch Manager' };
const NAME = 'Pintest liquidity review';

beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
  const semantic = await SemanticService.create(pool, 'test_cu', 'credit_union');
  approvals = new ApprovalStore(pool);
  gateway = new ReportGateway({ store: new ReportStore(pool), semantic, approvals, classSize: async (c) => (c === 'Manager' ? 6 : 3) });
  // A saved report of Dana's, made the way an approved save makes one.
  const draft = await gateway.store.saveDraft({ ...stockReports('credit_union')[0]!, templateId: 'new', name: NAME, folder: 'Drafts' }, DANA, 'thr_pintest_setup');
  const saved = await gateway.store.publish({ draftId: draft.templateId, name: NAME, folder: 'Finance / ALCO', definition: draft.definition }, { approvalId: `apr_pintest_${Date.now()}`, userId: DANA.id, userName: DANA.name, agent: 'Report Builder' });
  templateId = saved.templateId;
});
afterAll(async () => {
  if (!available) return;
  await admin.query("DELETE FROM esp_report_pins WHERE user_id LIKE 'user:pintest%'");
  await admin.query("DELETE FROM esp_report_templates WHERE owner_user_id LIKE 'user:pintest%'");
  await admin.query("DELETE FROM ai_approvals WHERE requested_by LIKE 'user:pintest%'");
  await Promise.all([pool.end(), admin.end()]);
});

function sink() {
  const texts: string[] = [];
  const blocks: Block[] = [];
  const s: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan0000000001', step: () => {}, text: async (md) => void texts.push(md), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { s, texts, blocks };
}
const input = (text: string, user = DANA) => ({ runId: `R-pintest-${Math.random().toString(36).slice(2, 7)}`, threadId: `thr_pintest_${Math.random().toString(36).slice(2, 7)}`, text, user, tenant: { name: 'Harborview Federal Credit Union', institutionType: 'credit_union' as const }, apps: ['reports'], canViewSql: false });
const ask = async (text: string, user = DANA, state: ReportThread = newReportThread()) => {
  const out = sink();
  const r = await runReportOffline(input(text, user), { gateway }, state, out.s);
  return { r, out };
};
const approve = async (r: Awaited<ReturnType<typeof ask>>['r'], user = DANA) => gateway.execute(await approvals.decide(r.approval!.record.approvalId, { decision: 'approved', userId: user.id }), { user });

describe.skipIf(!available)('reports on Home', () => {
  it('pins a report to your own Home at low risk, once', async () => {
    const { r } = await ask(`Pin the ${NAME} report to my Home`);
    expect(r.outcome).toBe('approval');
    expect(r.approval!.card.data).toMatchObject({ riskTier: 'low', summary: `Pin “${NAME}” to your Home` });
    // Nothing is on Home until the card is approved.
    expect(await gateway.store.pins(DANA.id, 'Executive')).toEqual([]);
    const approved = await approvals.decide(r.approval!.record.approvalId, { decision: 'approved', userId: DANA.id });
    const x = await gateway.execute(approved, { user: DANA });
    expect(x).toMatchObject({ operation: 'report.pin', audience: 'me', templateName: NAME });
    expect((await gateway.store.pins(DANA.id, 'Executive')).map((p) => p.templateName)).toEqual([NAME]);
    // Someone else's Home doesn't get it.
    expect(await gateway.store.pins(MARCUS.id, 'Manager')).toEqual([]);
  });

  it('publishes to a class at medium risk, says how many people, and refuses classes without Reports', async () => {
    const { r } = await ask(`Publish the ${NAME} report to Home for managers`);
    expect(r.approval!.card.data).toMatchObject({ riskTier: 'medium', summary: `Publish “${NAME}” to Home for the Manager class`, affected: { users: 6 } });
    await approve(r);
    expect((await gateway.store.pins(MARCUS.id, 'Manager')).map((p) => [p.templateName, p.pinnedBy])).toEqual([[NAME, DANA.name]]);
    expect(await gateway.store.pins('user:pintest3', 'Lender')).toEqual([]);

    const lenders = await ask(`Publish the ${NAME} report to Home for lenders`);
    expect(lenders.r.approval).toBeUndefined();
    expect(lenders.out.texts.join(' ')).toMatch(/I can’t publish it to the Lender class: only the Executive, Manager, Analyst, Administrator classes include Reports/);
  });

  it('lets only the person who published it take it off a class Home', async () => {
    const theirs = await ask(`Take the ${NAME} report off my Home`, MARCUS);
    expect(theirs.r.approval).toBeUndefined();
    expect(theirs.out.texts.join(' ')).toContain(`because ${DANA.name} published it to the Manager class. Only they can take it off.`);

    const { r } = await ask(`Take the ${NAME} report off Home`);
    expect(r.approval!.card.data).toMatchObject({ riskTier: 'medium', summary: `Take “${NAME}” off your Home and the Manager class` });
    expect(await approve(r)).toMatchObject({ operation: 'report.unpin', removed: 2 });
    expect(await gateway.store.pins(MARCUS.id, 'Manager')).toEqual([]);
    expect(await gateway.store.pins(DANA.id, 'Executive')).toEqual([]);
  });
});

describe.skipIf(!available)('the reports Recycle Bin', () => {
  it('moves your own report to the Recycle Bin and off every Home, and restores it', async () => {
    await approve((await ask(`Publish the ${NAME} report to Home for managers`)).r);
    const { r } = await ask(`Delete the ${NAME} report`);
    expect(r.approval!.card.data).toMatchObject({ riskTier: 'medium', summary: `Move “${NAME}” to the Recycle Bin` });
    expect(JSON.stringify(r.approval!.card.data.preview)).toContain('Taken off 1 Home pin');
    expect(await approve(r)).toMatchObject({ operation: 'report.delete', templateId });
    await expect(gateway.store.get(templateId, DANA.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await gateway.store.list(DANA.id)).some((t) => t.templateId === templateId)).toBe(false);
    expect(await gateway.store.pins(MARCUS.id, 'Manager')).toEqual([]);

    const bin = await ask('What’s in the reports Recycle Bin?');
    expect(bin.out.texts.join(' ')).toMatch(/1 report is in your Recycle Bin/);
    expect(bin.out.blocks.find((b) => b.type === 'list')).toMatchObject({ title: 'Recycle Bin' });
    // Someone else's Recycle Bin is their own.
    expect((await ask(`Restore the ${NAME} report`, MARCUS)).out.texts.join(' ')).toMatch(/no reports in it/);

    const restore = await ask(`Restore the ${NAME} report`);
    expect(restore.r.approval!.card.data).toMatchObject({ riskTier: 'low', summary: `Restore “${NAME}” to Finance / ALCO` });
    expect(await approve(restore.r)).toMatchObject({ operation: 'report.restore', folder: 'Finance / ALCO' });
    expect((await gateway.store.get(templateId, DANA.id)).status).toBe('published');
    // Restoring doesn't put it back on anyone's Home.
    expect(await gateway.store.pins(MARCUS.id, 'Manager')).toEqual([]);
  });

  it('won’t delete a stock report, or someone else’s', async () => {
    const stock = stockReports('credit_union')[0]!;
    const s = await ask(`Delete the ${stock.name} report`);
    expect(s.r.approval).toBeUndefined();
    expect(s.out.texts.join(' ')).toMatch(/stock report every user starts with/);
    const other = await ask(`Delete the ${NAME} report`, MARCUS);
    expect(other.r.approval).toBeUndefined();
    expect(other.out.texts.join(' ')).toContain(`belongs to ${DANA.name}`);
  });
});
