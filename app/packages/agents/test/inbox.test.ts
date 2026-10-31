// @vitest-environment node
// The referral inbox: core rules against the seeded warehouse, the offline planner, and the Concierge
// routing and approval around it. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, ReferralService, RelationshipService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { AuditLog, Concierge, INBOX_REQUEST, parseInboxRequest, runInboxOffline, ToolGateway, type InboxInput, type RunSink, type TenantRuntime } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

function recorder() {
  const blocks: Block[] = [];
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { sink, blocks, texts };
}

describe('recognising inbox work', () => {
  it('tells working a referral from making one', () => {
    for (const t of ['What’s on my plate today?', 'Show my overdue referrals', 'What’s in my referral inbox?', 'Mark referral 88213 as sold', 'Mark the Jackson referral sold', 'Reassign the Jackson referral to Tom Walsh']) expect(INBOX_REQUEST.test(t), t).toBe(true);
    for (const t of ['Refer Suzanne Jackson for a HELOC', 'Show delinquency by branch', 'Pull up Suzanne Jackson']) expect(INBOX_REQUEST.test(t), t).toBe(false);
  });

  it('reads requests the way people say them', () => {
    expect(parseInboxRequest('What’s on my plate today?')).toMatchObject({ intent: 'list', box: 'mine', overdue: false });
    expect(parseInboxRequest('Show my team’s overdue referrals')).toMatchObject({ intent: 'list', box: 'team', overdue: true });
    expect(parseInboxRequest('open referrals older than 3 days')).toMatchObject({ olderThan: 3 });
    expect(parseInboxRequest('Mark referral 88213 as sold')).toEqual({ intent: 'stage', ref: '88213', stage: 'Sold' });
    expect(parseInboxRequest('Mark the Jackson referral not interested')).toEqual({ intent: 'stage', ref: 'Jackson', stage: 'Not Interested' });
    expect(parseInboxRequest('Reassign #88213 to Tom Walsh')).toEqual({ intent: 'reassign', ref: '88213', to: 'Tom Walsh' });
    expect(parseInboxRequest('Add a note to 88213: left voicemail')).toEqual({ intent: 'note', ref: '88213', note: 'left voicemail' });
  });
});

describe.skipIf(!up)('the inbox against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let referrals: ReferralService;
  let approvals: ApprovalStore;
  let gateway: ToolGateway;
  const sofia = { id: 'user:inboxtest', name: 'Sofia Test', title: 'MSR' };
  const meta = { userId: sofia.id, userName: sofia.name, employeeId: 4 };
  const westport = { purviewBranches: ['Westport'] };
  const made: number[] = [];

  /** A fresh referral each test, so they do not depend on one another or on the seed's state. */
  const fresh = async (stage = 'New Referral', sender = 'user:someone') => {
    const [p] = await pool.query('SELECT party_id FROM cdm_party WHERE primary_branch_id = 1 AND party_id > 100 LIMIT 1');
    const party = (p as { party_id: number }[])[0]!.party_id;
    const [r] = await admin.query("INSERT INTO esp_com_items (definition, type_id, party_id, fields, stage, priority, sender_user_id, sender_name, to_queue_id, assignee_employee_id, routing, created_at) VALUES ('referral', 'certificate', ?, '{}', ?, 'High', ?, 'Someone', 'q_service_westport', 4, '{}', NOW(3) - INTERVAL 3 DAY)", [party, stage, sender]);
    const id = (r as { insertId: number }).insertId;
    made.push(id);
    return id;
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    referrals = new ReferralService(pool, 'credit_union');
    approvals = new ApprovalStore(pool);
    gateway = new ToolGateway({ referrals, relationship: new RelationshipService(pool, 'test_cu', 'credit_union'), approvals });
  });
  afterAll(async () => {
    if (made.length) {
      await admin.query('DELETE FROM esp_com_lines WHERE com_id IN (?)', [made]);
      await admin.query('DELETE FROM esp_com_items WHERE com_id IN (?)', [made]);
    }
    await admin.query("DELETE FROM ai_approvals WHERE thread_id LIKE 'thr_inbox%'");
    await Promise.all([pool.end(), admin.end()]);
  });

  it('shows mine, team and sent within purview, overdue first', async () => {
    const id = await fresh();
    const mine = await referrals.inbox('mine', { userId: sofia.id, employeeId: 4 }, westport);
    expect(mine.find((i) => i.comId === id)).toMatchObject({ overdue: true, ageDays: 3 });
    expect(mine[0]!.overdue).toBe(true);
    expect((await referrals.inbox('team', { userId: sofia.id }, { purviewBranches: ['Northgate'] })).some((i) => i.comId === id)).toBe(false);
    expect(await referrals.inbox('mine', { userId: sofia.id }, westport)).toEqual([]);
    const sent = await fresh('New Referral', sofia.id);
    expect((await referrals.inbox('sent', { userId: sofia.id }, { purviewBranches: ['Northgate'] })).map((i) => i.comId)).toContain(sent);
  });

  it('lets a sender read a referral outside their purview, but not work it; anyone else reads not found', async () => {
    const id = await fresh('New Referral', sofia.id);
    const elsewhere = { purviewBranches: ['Northgate'] };
    expect((await referrals.item(id, { userId: sofia.id }, elsewhere)).comId).toBe(id);
    await expect(referrals.addNote(id, 'hello', meta, elsewhere)).rejects.toMatchObject({ code: 'NO_ACCESS' });
    await expect(referrals.item(id, { userId: 'user:other' }, elsewhere)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('follows the stage bar: closed stays closed, and repeating a change does nothing', async () => {
    const id = await fresh();
    const a = await referrals.transition(id, 'Active', undefined, meta, westport);
    expect(a).toMatchObject({ changed: true, item: { stage: 'Active' } });
    expect((await referrals.transition(id, 'Active', undefined, meta, westport)).changed).toBe(false);
    await expect(referrals.transition(id, 'New Referral', undefined, meta, westport)).rejects.toMatchObject({ code: 'INVALID' });
    await referrals.transition(id, 'Sold', 'Signed today', meta, westport);
    await expect(referrals.transition(id, 'Not Interested', undefined, meta, westport)).rejects.toMatchObject({ code: 'INVALID' });
    const d = await referrals.item(id, { userId: sofia.id }, westport);
    expect(d.history.map((h) => h.kind)).toEqual(['stage', 'stage']);
    expect(d.overdue).toBe(false);
  });

  it('reassigns only within the queue', async () => {
    const id = await fresh();
    await expect(referrals.reassign(id, 1, meta, westport)).rejects.toMatchObject({ code: 'INVALID' });
    const d = await referrals.reassign(id, 5, meta, westport);
    expect(d.assignee?.employeeId).toBe(5);
  });

  const input = (text: string, threadId: string, over: Partial<InboxInput> = {}): InboxInput => ({ runId: `R-${threadId}`, threadId, text, user: sofia, tenant: { name: 'Harborview', institutionType: 'credit_union' }, apps: ['referrals', 'rm'], purviewBranches: ['Westport'], employeeId: 4, ...over });

  it('lists work as a valid block with the counts in words', async () => {
    await fresh();
    const r = recorder();
    await runInboxOffline(input('What’s on my plate today?', 'thr_inbox1'), { gateway }, r.sink);
    expect(r.texts[0]).toMatch(/You have \*\*\d+\*\* open referrals?, \*\*\d+\*\* overdue/);
    expect(validateBlock(r.blocks[0]!).ok).toBe(true);
    expect(r.blocks[0]).toMatchObject({ type: 'list', title: 'Your open referrals' });
  });

  it('marks Sold through a medium-risk card, and nothing changes until it is approved', async () => {
    const id = await fresh();
    const r = recorder();
    const out = await runInboxOffline(input(`Mark referral ${id} as sold`, 'thr_inbox2'), { gateway }, r.sink);
    expect(out.outcome).toBe('approval');
    const card = out.approval!.card;
    expect(validateBlock(card).ok).toBe(true);
    expect(card.data.riskTier).toBe('medium');
    expect(card.data.summary).toContain('incentive');
    expect((await referrals.item(id, { userId: sofia.id }, westport)).stage).toBe('New Referral');

    const a = await approvals.decide(out.approval!.record.approvalId, { decision: 'approved', userId: sofia.id, payloadHash: out.approval!.record.payloadHash });
    const done = await gateway.execute(a, { user: sofia, purviewBranches: ['Westport'], employeeId: 4 });
    expect(done).toMatchObject({ operation: 'referral.change', kind: 'stage', item: { stage: 'Sold' } });
  });

  it('refuses a referral outside the purview, and says so without a card', async () => {
    const id = await fresh();
    const r = recorder();
    const out = await runInboxOffline(input(`Mark referral ${id} as sold`, 'thr_inbox3', { purviewBranches: ['Northgate'] }), { gateway }, r.sink);
    expect(out.approval).toBeUndefined();
    expect(out.outcome).toBe('not_found');
  });

  it('routes through the Concierge, and tells the sender when a referral closes', async () => {
    const id = await fresh();
    const concierge = new Concierge({ model: null, audit: new AuditLog() });
    const tenant = { key: 'test_cu', name: 'Harborview', institutionType: 'credit_union', semantic: null, workflow: { referrals, relationship: null, gateway } } as unknown as TenantRuntime;
    const turn = { threadId: 'thr_inbox4', runId: 'R-inbox4', text: `Mark referral ${id} as sold`, context: [], user: sofia, tenant, apps: ['referrals'], purviewBranches: ['Westport'], canViewSql: false, employeeId: 4 };
    const r = recorder();
    const out = await concierge.handle(turn, r.sink);
    if (out.kind !== 'handled' || !out.approval) throw new Error('expected an approval');

    const after = recorder();
    const finished = new Promise<unknown>((resolve) => (after.sink.done = resolve));
    await concierge.resolveApproval({ approvalId: out.approval.approvalId, decision: 'approve', previewHash: out.approval.card.data.previewHash, threadId: turn.threadId, runId: turn.runId, user: sofia, tenant, purviewBranches: ['Westport'], employeeId: 4 }, after.sink);
    expect(await finished).toMatchObject({ notify: [{ userId: 'user:someone', title: `Referral #${id} is Sold` }] });
    expect(after.texts[0]).toContain('**Sold**');
  });
});
