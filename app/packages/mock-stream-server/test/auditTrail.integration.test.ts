// @vitest-environment node
// The Agent Audit Log's reader against the local MySQL: the list with its filters and totals, and one
// run's trace with what happened to it afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { createAuditStore, warehouseAvailable } from '@dinext/tenant-db';
import { mysqlAuditKeeper } from '../src/auditStore.ts';
import { AuditTrail } from '../src/auditTrail.ts';

const available = await warehouseAvailable('dinext_t_test_cu');
const ADMIN = process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307';
// A tenant of its own, so the test sees only what it wrote.
const TENANT = `trail_${Date.now().toString(36)}`;
let trail: AuditTrail;

beforeAll(async () => {
  if (!available) return;
  const admin = await mysql.createConnection({ uri: ADMIN });
  await createAuditStore(admin);
  await admin.end();
  const keeper = (await mysqlAuditKeeper())!;
  const now = Date.now();
  const at = (s: number) => new Date(now - 60_000 + s * 1000).toISOString();
  await keeper.keep({
    at: at(3),
    tenant: TENANT,
    eventType: 'ai.run',
    userId: 'user:9229',
    threadId: 'thr_a',
    runId: 'R-20261117-aaa1',
    body: {
      at: at(3),
      tenant: TENANT,
      userId: 'user:9229',
      threadId: 'thr_a',
      runId: 'R-20261117-aaa1',
      question: 'Refer Suzanne for a HELOC',
      maskedIdentifiers: 1,
      route: { intent: 'referral_request', agent: 'referral', confidence: 0.94, mode: 'live' },
      outcome: 'approval_requested',
      usage: [{ model: 'claude-sonnet-5-5', role: 'route', inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, costUsd: 0.0033 }],
      totalCostUsd: 0.0033,
      toolCalls: [{ name: 'member_search', input: { name: 'Suzanne' }, ok: true, ms: 120 }],
      numericRemovals: [],
      startedAt: at(0),
      durationMs: 3000,
      agentName: 'Referrals',
      trace: [
        { t: 10, kind: 'routing', agent: 'Referrals', reason: 'A referral to send' },
        { t: 400, kind: 'step', label: 'Find the member', state: 'done', operation: 'member.search', result: '1 match' },
        { t: 2900, kind: 'block', agent: 'Referrals', type: 'approval_card', title: 'Refer Suzanne Jackson', operations: ['referral.create'], sources: [] },
      ],
    },
  });
  await keeper.keep({ at: at(3), tenant: TENANT, eventType: 'ai.approval.requested', userId: 'user:9229', threadId: 'thr_a', runId: 'R-20261117-aaa1', approvalId: 'apr_t1', body: { operation: 'referral.create', riskTier: 'medium' } });
  await keeper.keep({ at: at(20), tenant: TENANT, eventType: 'ai.approval.approved', userId: 'user:9229', threadId: 'thr_a', runId: 'R-20261117-aaa1', approvalId: 'apr_t1', body: { channel: 'click' } });
  await keeper.keep({ at: at(21), tenant: TENANT, eventType: 'ai.action.executed', userId: 'user:9229', threadId: 'thr_a', runId: 'R-20261117-aaa1', approvalId: 'apr_t1', body: { operation: 'referral.create', resultRef: 'com:88214' } });
  await keeper.keep({ at: at(30), tenant: TENANT, eventType: 'ai.run', userId: 'user:4410', threadId: 'thr_b', runId: 'R-20261117-bbb2', body: { at: at(30), tenant: TENANT, userId: 'user:4410', runId: 'R-20261117-bbb2', question: 'Total loans by branch', route: { intent: 'data_question', agent: 'analytics_qa', confidence: 1, mode: 'live' }, outcome: 'failed', error: 'Timed out', usage: [], totalCostUsd: 0, toolCalls: [], numericRemovals: [] } });
  await keeper.close();
  trail = new AuditTrail(TENANT, 'dinext_t_test_cu');
});
afterAll(async () => {
  await trail?.close();
});

describe.skipIf(!available)('Agent Audit Log reader', () => {
  it('lists runs newest first, with totals, agents and people to filter by', async () => {
    const page = await trail.runs({ days: 1 }, true);
    expect(page.items.map((r) => r.runId)).toEqual(['R-20261117-bbb2', 'R-20261117-aaa1']);
    expect(page.totals).toMatchObject({ runs: 2, failed: 1, refused: 0, approvals: 1 });
    expect(page.items[1]).toMatchObject({ agent: 'Referrals', outcome: 'approval_requested', durationMs: 3000, tokens: 940, toolCalls: 1, steps: 3, approvals: 1 });
    // A run that recorded only its route still gets the agent's name people know.
    expect(page.items[0]!.agent).toBe('Analytics Q&A');
    expect(page.agents).toEqual(expect.arrayContaining(['Referrals', 'Analytics Q&A']));
    expect(page.people.map((p) => p.id).sort()).toEqual(['user:4410', 'user:9229']);
  });

  it('filters by person, agent, problems and words in the question', async () => {
    expect((await trail.runs({ days: 1, userId: 'user:4410' }, false)).items.map((r) => r.runId)).toEqual(['R-20261117-bbb2']);
    expect((await trail.runs({ days: 1, agent: 'Referrals' }, true)).items.map((r) => r.runId)).toEqual(['R-20261117-aaa1']);
    expect((await trail.runs({ days: 1, agent: 'Analytics Q&A' }, true)).items.map((r) => r.runId)).toEqual(['R-20261117-bbb2']);
    expect((await trail.runs({ days: 1, outcome: 'problems' }, true)).items.map((r) => r.runId)).toEqual(['R-20261117-bbb2']);
    expect((await trail.runs({ days: 1, q: 'suzanne' }, true)).items.map((r) => r.runId)).toEqual(['R-20261117-aaa1']);
    expect((await trail.runs({ days: 1, q: 'R-20261117-bbb2' }, true)).total).toBe(1);
  });

  it('traces one run step by step, then what happened to it afterwards', async () => {
    const t = (await trail.trace('R-20261117-aaa1'))!;
    expect(t).toMatchObject({ ownerId: 'user:9229', agent: 'Referrals', outcome: 'approval_requested', maskedIdentifiers: 1, durationMs: 3000, partial: false });
    expect(t.route).toMatchObject({ intent: 'referral_request', confidence: 0.94 });
    expect(t.toolCalls[0]).toMatchObject({ name: 'member_search', input: { name: 'Suzanne' }, ok: true });
    const titles = t.timeline.map((e) => e.title);
    expect(titles[0]).toMatch(/asked$/);
    expect(titles).toEqual(expect.arrayContaining(['Routed to Referrals', 'Find the member', 'Showed “Refer Suzanne Jackson”', 'Approval requested', 'Change made']));
    expect(titles.findIndex((x) => x === 'Change made')).toBeGreaterThan(titles.findIndex((x) => x === 'Approval requested'));
    expect(t.timeline.find((e) => e.title === 'Find the member')).toMatchObject({ offsetMs: 400, operation: 'member.search', detail: '1 match', status: 'ok' });
    expect(t.timeline.find((e) => e.kind === 'action')).toMatchObject({ operation: 'referral.create', detail: 'Result com:88214' });
  });

  it('says why a run failed, and finds nothing for a run it never saw', async () => {
    const t = (await trail.trace('R-20261117-bbb2'))!;
    expect(t.error).toBe('Timed out');
    expect(t.timeline.at(-1)).toMatchObject({ kind: 'outcome', status: 'failed' });
    expect(t.partial).toBe(true);
    expect(await trail.trace('R-20990101-none')).toBeNull();
  });
});
