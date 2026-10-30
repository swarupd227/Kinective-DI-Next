// @vitest-environment node
// Referral operations and the approval service against the seeded warehouse (spec 17.3, 19, 25.3).
// Each test cleans up the workflow rows it creates through an admin connection.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ApprovalError, ApprovalStore, payloadHash, ReferralService } from '../src/index.ts';

const available = await warehouseAvailable('dinext_t_test_cu');
let pool: Pool;
let admin: Pool;
let svc: ReferralService;

beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
  svc = new ReferralService(pool, 'credit_union');
});
afterAll(async () => {
  if (!available) return;
  await admin.query("DELETE FROM esp_com_lines WHERE com_id IN (SELECT com_id FROM esp_com_items WHERE run_id LIKE 'R-test-%')");
  await admin.query("DELETE FROM esp_com_items WHERE run_id LIKE 'R-test-%'");
  await admin.query("DELETE FROM ai_approvals WHERE run_id LIKE 'R-test-%'");
  await admin.query('UPDATE esp_com_queues SET rr_pointer = 0');
  await Promise.all([pool.end(), admin.end()]);
});

describe.skipIf(!available)('relationship.party.search with purview', () => {
  it('finds the demo member by name', async () => {
    const hits = await svc.searchParties('Suzanne Jackson', {});
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ partyId: 1, name: 'Suzanne Jackson', branch: 'Westport', last4: '4521' });
    expect(hits[0]!.products.length).toBeGreaterThan(0);
  });

  it('never returns members outside the purview', async () => {
    expect(await svc.searchParties('Robert Jackson', {})).toHaveLength(1);
    expect(await svc.searchParties('Robert Jackson', { purviewBranches: ['Westport'] })).toEqual([]);
    await expect(svc.party(19, { purviewBranches: ['Westport'] })).rejects.toMatchObject({ code: 'NO_ACCESS' });
  });
});

describe.skipIf(!available)('referral form and routing', () => {
  it('rejects fields the form does not have and normalises values (AI-AGT-160)', async () => {
    const c = await svc.check({ typeId: 'heloc', fields: { preferred_contact: 'email', estimated_amount: '$60,000', favourite_colour: 'blue' } });
    expect(c.ok).toBe(false);
    expect(c.errors[0]).toMatch(/no field "favourite_colour"/);
    expect(c.fields).toEqual({ preferred_contact: 'Email', estimated_amount: 60000 });
  });

  it('lists missing required fields', async () => {
    const c = await svc.check({ typeId: 'heloc', fields: {} });
    expect(c.missing.map((f) => f.id)).toEqual(['preferred_contact']);
  });

  it('routes by the member’s branch and shows who is next (AI-AGT-161)', async () => {
    const r = await svc.route('heloc', 1);
    expect(r).toMatchObject({ queueId: 'q_lending_westport', queueName: 'Westport Lending Queue', assignee: { name: 'Ana Ruiz' }, rule: 'by_location' });
    expect(r.reason).toMatch(/round-robin among 2 people/);
    expect((await svc.route('mortgage', 1)).assignee).toBeNull();
  });
});

describe.skipIf(!available)('approvals and idempotent create (AI-GRD-071, AI-TRG-003)', () => {
  const draft = { typeId: 'heloc', partyId: 1, fields: { preferred_contact: 'Email', best_time: 'Evening', estimated_amount: 60000 }, notes: 'Asked about a kitchen remodel', toQueueId: 'q_lending_westport' };
  const user = { userId: 'user:5120', userName: 'Marcus Reed' };

  it('binds the approval to its payload, user and expiry', async () => {
    const store = new ApprovalStore(pool);
    const a = await store.request({ operation: 'referral.create', payload: draft, riskTier: 'medium', requestedBy: user.userId, runId: 'R-test-0001', threadId: 'thr_test1' });
    expect(a.payloadHash).toBe(payloadHash({ ...draft }));
    expect(new Date(a.expiresAt).getTime() - new Date(a.createdAt).getTime()).toBe(15 * 60_000);
    await expect(store.decide(a.approvalId, { decision: 'approved', userId: 'user:9229' })).rejects.toMatchObject({ code: 'WRONG_USER' });
    await expect(store.decide(a.approvalId, { decision: 'approved', userId: user.userId, payloadHash: 'sha256:00' })).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    expect((await store.decide(a.approvalId, { decision: 'approved', userId: user.userId, channel: 'click' })).status).toBe('approved');
    await expect(store.decide(a.approvalId, { decision: 'approved', userId: user.userId })).rejects.toBeInstanceOf(ApprovalError);
  });

  it('refuses an expired approval', async () => {
    let now = new Date();
    const store = new ApprovalStore(pool, () => now);
    const a = await store.request({ operation: 'referral.create', payload: draft, riskTier: 'medium', requestedBy: user.userId, runId: 'R-test-0002', threadId: 'thr_test2' });
    now = new Date(now.getTime() + 16 * 60_000);
    await expect(store.decide(a.approvalId, { decision: 'approved', userId: user.userId })).rejects.toMatchObject({ code: 'EXPIRED' });
    expect((await store.get(a.approvalId))!.status).toBe('expired');
  });

  it('supersedes older drafts in the same thread', async () => {
    const store = new ApprovalStore(pool);
    const a = await store.request({ operation: 'referral.create', payload: draft, riskTier: 'medium', requestedBy: user.userId, runId: 'R-test-0003', threadId: 'thr_test3' });
    const b = await store.request({ operation: 'referral.create', payload: { ...draft, notes: 'x' }, riskTier: 'medium', requestedBy: user.userId, runId: 'R-test-0003', threadId: 'thr_test3' });
    expect(await store.supersede('thr_test3', b.approvalId)).toEqual([a.approvalId]);
    expect((await store.pendingInThread('thr_test3'))!.approvalId).toBe(b.approvalId);
  });

  it('creates one referral per approval, rotates assignees, and records the run', async () => {
    const first = await svc.create(draft, { approvalId: 'apr_testIdem00001', runId: 'R-test-0004', ...user }, { purviewBranches: ['Westport'] });
    const retry = await svc.create(draft, { approvalId: 'apr_testIdem00001', runId: 'R-test-0004', ...user }, { purviewBranches: ['Westport'] });
    expect(retry.comId).toBe(first.comId);
    expect(retry.replayed).toBe(true);
    expect(first).toMatchObject({ stage: 'New Referral', queueName: 'Westport Lending Queue', runId: 'R-test-0004', approvalId: 'apr_testIdem00001', fields: { preferred_contact: 'Email', estimated_amount: 60000 } });
    const second = await svc.create(draft, { approvalId: 'apr_testIdem00002', runId: 'R-test-0004', ...user }, {});
    expect(second.assignee!.name).not.toBe(first.assignee!.name);
    await expect(svc.create(draft, { approvalId: 'apr_testIdem00003', runId: 'R-test-0004', ...user }, { purviewBranches: ['Northgate'] })).rejects.toMatchObject({ code: 'NO_ACCESS' });
  });
});
