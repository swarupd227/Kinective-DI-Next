// @vitest-environment node
// Operations, the Call Report, collections, campaigns and SEG on the shared agent, against the seeded
// warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalError, ApprovalStore, CallReportService, CampaignService, CollectionsService, OperationsService, SegService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, callReportModule, campaignModule, collectionsModule, operationsModule, runModuleOffline, segModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

function recorder() {
  const blocks: Block[] = [];
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { sink, blocks, texts };
}

describe.skipIf(!up)('more modules against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let approvals: ApprovalStore;
  let gateway: ModuleGateway;
  let ops: ModuleSpec;
  let cr: ModuleSpec;
  let col: ModuleSpec;
  let cmp: ModuleSpec;
  let seg: ModuleSpec;
  const turn = (text: string, threadId: string, over: Partial<ModuleTurn> = {}): ModuleTurn => ({ runId: `R-${threadId}`, threadId, text, user: { id: 'user:1002', name: 'Sam Taylor', title: 'DI Administrator' }, tenant: { name: 'Harborview' }, modules: ['operations', 'admin', 'callreport', 'collections', 'campaigns', 'seg'], ...over });
  const run = async (spec: ModuleSpec, t: ModuleTurn) => {
    const r = recorder();
    return { r, out: await runModuleOffline(spec, t, { gateway }, r.sink) };
  };

  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    approvals = new ApprovalStore(pool);
    ops = operationsModule(new OperationsService(pool));
    cr = callReportModule(new CallReportService(pool));
    col = collectionsModule(new CollectionsService(pool));
    cmp = campaignModule(new CampaignService(pool));
    seg = segModule(new SegService(pool), () => '2026-10-25');
    gateway = new ModuleGateway(approvals, [ops, cr, col, cmp, seg]);
  });
  afterAll(async () => {
    await admin.query("UPDATE iam_user SET status = 'Active' WHERE name = 'Sofia Ruiz'");
    await admin.query("UPDATE iam_user SET user_class = 'Lender' WHERE name = 'Ana Ruiz' AND branch = 'Westport'");
    await admin.query('DELETE FROM col_outreach');
    await admin.query("DELETE FROM seg_interaction WHERE approval_id IS NOT NULL");
    await admin.query("UPDATE seg_company SET stage = 'Meeting Held' WHERE name = 'Acme HR'");
    await pool.end();
    await admin.end();
  });

  it('routes each request to the right module', () => {
    const cases: [string, string][] = [['Did last night’s build finish?', 'operations'], ['Lock Tom Walsh', 'operations'], ['Which uploaders missed their late-file time?', 'operations'], ['Create a user for Maria Gomez as a Westport MSR', 'operations'], ['Sofia Ruiz has left the credit union. Remove her access.', 'operations'], ['Change Ana Ruiz at Westport to the Manager class', 'operations'], ['Who hasn’t signed in for 90 days?', 'operations'], ['Make D. Novak a Manager', 'operations'], ['Are we ready to file Q3?', 'callreport'], ['How is 025B calculated?', 'callreport'], ['Show the early-warning list', 'collections'], ['Which campaigns produced the most loan dollars?', 'campaigns'], ['Which SEGs had the most new members?', 'seg']];
    for (const [t, id] of cases) expect(gateway.match(t)?.id, t).toBe(id);
    expect(gateway.match('Show loan growth by branch')).toBeNull();
  });

  describe('operations and admin', () => {
    it('reports the build and the late uploader', async () => {
      const { r } = await run(ops, turn('Which uploaders missed their late-file time?', 'thr_a1'));
      expect(r.texts[0]).toContain('Goal scores');
      expect(validateBlock(r.blocks[0]!).ok).toBe(true);
    });

    it('names failed checks', async () => {
      const { r } = await run(ops, turn('Which checks failed this week?', 'thr_a2'));
      expect(r.texts[0]).toContain('2 of 8 checks failed');
      expect(r.texts[0]).toContain('Every loan has a branch');
    });

    it('answers who can do something from the class rules', async () => {
      const { r } = await run(ops, turn('Who can approve incentives?', 'thr_a3'));
      expect(r.texts[0]).toContain('Executive and Manager');
    });

    it('explains why someone can’t see something, naming the rule', async () => {
      const { r } = await run(ops, turn('Why can’t Tom Walsh see the Westport referrals?', 'thr_a4'));
      expect(r.texts[0]).toMatch(/Tom Walsh can/);
      const away = await run(ops, turn('Why can’t Sofia Ruiz approve incentives?', 'thr_a5'));
      expect(away.r.texts[0]).toContain('the MSR class doesn’t include that');
    });

    it('makes creating a user high risk with step-up, and needs the permission', async () => {
      const { out } = await run(ops, turn('Create a user for Maria Gomez as a Westport MSR', 'thr_a6'));
      expect(out.approval!.card.data).toMatchObject({ riskTier: 'high', confirmation: { stepUp: true } });
      const none = await run(ops, turn('Create a user for Maria Gomez as a Westport MSR', 'thr_a7', { modules: ['operations'] }));
      expect(none.out.approval).toBeUndefined();
    });

    it('offboards a leaver only with a second approver, never the requester', async () => {
      const { out } = await run(ops, turn('Sofia Ruiz has left the credit union. Remove her access.', 'thr_b1'));
      const card = out.approval!.card.data;
      expect(card).toMatchObject({ riskTier: 'high', summary: 'Offboard Sofia Ruiz: lock their account', confirmation: { stepUp: true, secondApprover: { role: 'An executive or another administrator' } } });
      // A second approval has a working day, not five minutes.
      expect(new Date(card.expiresAt).getTime() - Date.now()).toBeGreaterThan(60 * 60_000);
      const record = out.approval!.record;
      await expect(approvals.decide(record.approvalId, { decision: 'approved', userId: 'user:1002', payloadHash: record.payloadHash })).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
      const decided = await approvals.decide(record.approvalId, { decision: 'approved', userId: 'user:9229', payloadHash: record.payloadHash });
      await gateway.execute(decided, turn('', 'thr_b1', { user: { id: 'user:9229', name: 'Dana Lee', title: 'President and CEO' } }));
      expect((await new OperationsService(pool).user('Sofia Ruiz')).status).toBe('Locked');
    });

    it('lets the requester withdraw an access change, but not approve it', async () => {
      const { out } = await run(ops, turn('Change Ana Ruiz at Westport to the Manager class', 'thr_b2'));
      expect(out.approval!.card.data.summary).toBe('Move Ana Ruiz from Lender to Manager');
      expect(JSON.stringify(out.approval!.card.data.preview)).toContain('approve incentives');
      const record = out.approval!.record;
      await expect(approvals.decide(record.approvalId, { decision: 'approved', userId: 'user:1002' })).rejects.toBeInstanceOf(ApprovalError);
      expect((await approvals.decide(record.approvalId, { decision: 'denied', userId: 'user:1002' })).status).toBe('denied');
    });

    it('says plainly that sign-in history isn’t recorded', async () => {
      const { r } = await run(ops, turn('Who hasn’t signed in for 90 days?', 'thr_b3'));
      expect(r.texts[0]).toContain('doesn’t record sign-ins yet');
      expect(validateBlock(r.blocks[0]!).ok).toBe(true);
    });

    it('won’t change your own user, or impersonate anyone', async () => {
      const own = await run(ops, turn('Lock Sam Taylor', 'thr_a8'));
      expect(own.r.texts[0]).toContain('your own user');
      const spoof = await run(ops, turn('Impersonate Priya Shah', 'thr_a9'));
      expect(spoof.r.texts[0]).toContain('isn’t available');
    });
  });

  describe('call report', () => {
    it('says whether the quarter is ready, with what failed', async () => {
      const { r } = await run(cr, turn('Are we ready to file Q3?', 'thr_r1'));
      expect(r.texts[0]).toContain('isn’t ready yet');
      expect(r.texts[0]).toContain('uncategorized GL accounts');
    });

    it('builds a line from its entry types, with the signs applied', async () => {
      const { r } = await run(cr, turn('How is 025B calculated?', 'thr_r2'));
      // Sized to the open loan balances, so the figure matches Home's.
      expect(r.texts[0]).toMatch(/\$\d{1,3}(,\d{3}){2,}/);
      expect(r.texts[0]).toContain('Auto loans');
      expect(validateBlock(r.blocks[0]!).ok).toBe(true);
    });

    it('lists what moved, and stays read-only', async () => {
      const { r } = await run(cr, turn('Show schedule A changes over 10% from last quarter', 'thr_r3'));
      expect(r.texts[0]).toContain('schedule A');
      const write = await run(cr, turn('Export the Q3 5300 for upload', 'thr_r4'));
      expect(write.r.texts[0]).toContain('person’s action');
      expect(cr.tools.every((t) => !t.apply)).toBe(true);
    });

    it('is closed to anyone without it, as for a bank', async () => {
      const { r } = await run(cr, turn('Are we ready to file Q3?', 'thr_r5', { modules: [] }));
      expect(r.texts[0]).toContain('credit unions');
    });
  });

  describe('collections', () => {
    it('lists current loans showing stress, and keeps to the purview', async () => {
      const { r } = await run(col, turn('Show the early-warning list', 'thr_c1', { purviewBranches: ['Westport'] }));
      expect(r.texts[0]).toMatch(/are current but showing stress/);
      expect(validateBlock(r.blocks[0]!).ok).toBe(true);
    });

    it('queues tasks on a medium card and never contacts anyone', async () => {
      const t = turn('Queue outreach tasks for the early-warning list', 'thr_c2', { purviewBranches: ['Westport'] });
      const { out } = await run(col, t);
      expect(out.approval!.card.data.riskTier).toBe('medium');
      const a = await approvals.decide(out.approval!.record.approvalId, { decision: 'approved', userId: t.user.id, payloadHash: out.approval!.record.payloadHash });
      await gateway.execute(a, { user: t.user, purviewBranches: t.purviewBranches, modules: t.modules, runId: t.runId, threadId: t.threadId });
      const again = await run(col, turn('Show the early-warning list', 'thr_c3', { purviewBranches: ['Westport'] }));
      expect(JSON.stringify(again.r.blocks[0])).toContain('Outreach queued');
      const no = await run(col, turn('Call the borrowers on the early-warning list', 'thr_c4'));
      expect(no.out.approval).toBeUndefined();
      expect(no.r.texts[0]).toContain('don’t contact borrowers');
    });
  });

  describe('campaigns', () => {
    it('ranks campaigns by dollars', async () => {
      const { r } = await run(cmp, turn('Which campaigns produced the most loan dollars?', 'thr_m1'));
      expect(r.texts[0]).toContain('First home');
    });

    it('shows what suppression removed, and adds up', async () => {
      const { out, r } = await run(cmp, turn('Build an audience of members with no auto loan', 'thr_m2'));
      expect(r.texts[0]).toMatch(/after removing .* opt-outs/);
      const changes = out.approval!.card.data.preview.kind === 'diff' ? out.approval!.card.data.preview.changes : [];
      const num = (l: string) => Number(changes.find((c) => c.label.startsWith(l))!.after.replace(/,/g, ''));
      expect(num('Matched') - num('Marketing') - num('Recent')).toBe(num('Audience'));
    });
  });

  describe('SEG', () => {
    it('gives a meeting brief with the last interactions', async () => {
      const { r } = await run(seg, turn('Prepare me for my SEG meeting with Albany Medical', 'thr_s1'));
      expect(r.texts[0]).toContain('Board Approved');
      expect(r.texts[0]).toContain('health fair');
    });

    it('needs a note from board stages on', async () => {
      const { out, r } = await run(seg, turn('Move Acme HR to Submit Letter for Board Approval for the SEG', 'thr_s2'));
      expect(out.approval).toBeUndefined();
      expect(out.asked).toBe(true);
      expect(r.texts[0]).toContain('needs a note');
    });
  });
});
