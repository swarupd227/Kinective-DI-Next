// @vitest-environment node
// Certificate retention: what's maturing, what an offer costs and branch tasks, against the seeded
// warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, OFFER_RULES, offerRate, ReferralService, RelationshipService, RetentionService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { RETENTION_REQUEST, ToolGateway, parseRetentionRequest, runRetentionOffline, type RetentionInput, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

function recorder() {
  const blocks: Block[] = [];
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { sink, blocks, texts };
}

describe('recognising retention work', () => {
  it('tells certificates from members at risk in general', () => {
    for (const t of ['Find certificates at risk of leaving', 'Which certificates mature in the next 90 days and are at risk?', 'What are the offer rules?']) expect(RETENTION_REQUEST.test(t), t).toBe(true);
    for (const t of ['Find members at risk of leaving and draft follow-ups', 'Show my overdue referrals']) expect(RETENTION_REQUEST.test(t), t).toBe(false);
  });

  it('reads requests the way people say them', () => {
    expect(parseRetentionRequest('Which certificates over $50K mature in the next 90 days and look likely to leave?')).toEqual({ intent: 'maturing', days: 90, minAmount: 50_000, atRiskOnly: true });
    expect(parseRetentionRequest('What would it cost to match a 4.5% renewal for the at-risk group?')).toMatchObject({ intent: 'cost', rate: 4.5, atRiskOnly: true });
    expect(parseRetentionRequest('Create call tasks for the at-risk certificates')).toMatchObject({ intent: 'tasks' });
    expect(parseRetentionRequest('What are the offer rules?')).toEqual({ intent: 'rules' });
  });

  it('holds a renewal to the rule for its balance', () => {
    expect(offerRate(150_000)).toBe(4.75);
    expect(offerRate(50_000)).toBe(4.5);
    expect(offerRate(9_999)).toBe(4);
    expect(OFFER_RULES.at(-1)!.minBalance).toBe(0);
  });
});

describe.skipIf(!up)('retention against the warehouse', () => {
  let pool: Pool;
  let service: RetentionService;
  let gateway: ToolGateway;
  const input = (text: string, threadId: string, over: Partial<RetentionInput> = {}): RetentionInput => ({ runId: `R-${threadId}`, threadId, text, user: { id: 'user:9229', name: 'Dana Lee', title: 'CEO' }, tenant: { name: 'Harborview', institutionType: 'credit_union' }, apps: ['rm', 'referrals'], retention: true, ...over });

  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    service = new RetentionService(pool);
    gateway = new ToolGateway({ referrals: new ReferralService(pool, 'credit_union'), relationship: new RelationshipService(pool, 'test_cu', 'credit_union'), retention: service, approvals: new ApprovalStore(pool) });
  });
  afterAll(() => pool.end());

  it('finds what’s maturing, at risk first, within the purview', async () => {
    const all = await service.maturing({}, {});
    expect(all.count).toBeGreaterThan(all.atRisk.count);
    expect(all.items[0]!.atRisk).toBe(true);
    const mine = await service.maturing({}, { purviewBranches: ['Westport'] });
    expect(mine.items.every((c) => c.branch === 'Westport')).toBe(true);
    expect(mine.count).toBeLessThan(all.count);
    expect((await service.maturing({ minAmount: 50_000 }, {})).items.every((c) => c.amount >= 50_000)).toBe(true);
  });

  it('prices an offer from its inputs, held to each rule, and gives the same answer every time', async () => {
    const f = { atRiskOnly: true };
    const found = await service.maturing(f, {});
    const cost = await service.offerCost(4.5, f, {});
    const expected = found.items.reduce((n, c) => n + (c.amount * Math.max(0, Math.min(4.5, offerRate(c.amount)) - c.rate)) / 100, 0);
    expect(cost.cost).toBeCloseTo(expected, 1);
    expect(cost.count).toBe(found.count);
    expect(await service.offerCost(4.5, f, {})).toEqual(cost);
  });

  it('refuses a rate above the rules, so DI can’t propose one', async () => {
    const r = recorder();
    const out = await runRetentionOffline(input('What would it cost to offer 6% on the at-risk group?', 'thr_ret1'), { gateway }, r.sink);
    expect(out.outcome).toBe('not_found');
    expect(r.texts[0]).toContain('The offer rules stop at 4.75%');
  });

  it('answers in code, with a valid table', async () => {
    const r = recorder();
    await runRetentionOffline(input('Which certificates mature in the next 90 days and are at risk?', 'thr_ret2'), { gateway }, r.sink);
    expect(r.texts[0]).toMatch(/certificates\*\* worth .* look likely to leave/);
    expect(validateBlock(r.blocks[0]!).ok).toBe(true);
    expect(JSON.stringify(r.blocks[0])).not.toContain('partyId');
  });

  it('prepares call tasks about the certificate, for approval', async () => {
    const r = recorder();
    const out = await runRetentionOffline(input('Create call tasks for the at-risk certificates', 'thr_ret3'), { gateway }, r.sink);
    expect(out.outcome).toBe('approval');
    expect(validateBlock(out.approval!.card).ok).toBe(true);
    const items = (out.approval!.record.payload as { items: { notes: string }[] }).items;
    expect(items.length).toBeLessThanOrEqual(5);
    expect(items[0]!.notes).toMatch(/certificate at .* matures/);
  });

  it('keeps it from anyone without the access', async () => {
    const r = recorder();
    const out = await runRetentionOffline(input('Which certificates are maturing?', 'thr_ret4', { retention: false }), { gateway }, r.sink);
    expect(out.outcome).toBe('not_found');
    expect(r.texts[0]).toContain('retail leadership');
  });
});
