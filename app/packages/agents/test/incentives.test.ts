// @vitest-environment node
// Goals & Incentives: payout rules, who sees what, and a batch through its high-risk card, against the
// seeded warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, CoreError, GoalsService, payFor, PipelineService, ReferralService, ruleText, type IncentiveRule } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { GI_REQUEST, ToolGateway, parseIncentivesRequest, runIncentivesOffline, type IncentivesInput, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

const tiered: IncentiveRule = { name: 'Checking', kind: 'tiered', perUnit: null, cap: null, tiers: [{ tier: 1, lowerPct: 100, amount: 75 }, { tier: 2, lowerPct: 120, amount: 150 }] };
const perUnit: IncentiveRule = { name: 'Referrals', kind: 'per_unit', perUnit: 10, cap: 150, tiers: [] };

function recorder() {
  const blocks: Block[] = [];
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { sink, blocks, texts };
}

describe('payout rules', () => {
  it('pays the highest tier reached, and says what the next one takes', () => {
    expect(payFor(tiered, 9, 10)).toMatchObject({ earned: 0, tier: null, next: { need: 1, amount: 75 } });
    expect(payFor(tiered, 11, 10)).toMatchObject({ earned: 75, tier: 1, next: { need: 1, amount: 150 } });
    expect(payFor(tiered, 13, 10)).toMatchObject({ earned: 150, tier: 2, next: null });
  });

  it('pays per unit up to the cap', () => {
    expect(payFor(perUnit, 4, 6)).toMatchObject({ earned: 40, capped: false });
    expect(payFor(perUnit, 18, 6)).toMatchObject({ earned: 150, capped: true, next: null });
    expect(ruleText(perUnit, 'sold referrals')).toBe('$10 per sold referral, capped at $150');
  });
});

describe('recognising incentive work', () => {
  it('tells incentives from goals handed to DI and from the Branch scorecard report', () => {
    for (const t of ['How am I doing on my goals this month?', 'Why is my referral incentive only $40?', 'Who on my team is behind on goals?', 'Approve October incentive payouts for Westport', 'What do I need to reach tier 2?']) expect(GI_REQUEST.test(t), t).toBe(true);
    for (const t of ['Open the September branch scorecard for Westport', 'Get me ready for Thursday’s ALCO meeting']) expect(GI_REQUEST.test(t), t).toBe(false);
  });

  it('reads requests the way people say them', () => {
    expect(parseIncentivesRequest('Approve the October incentives for Westport except Sam’s')).toEqual({ intent: 'prepare', branch: 'Westport', exclude: ['Sam'] });
    expect(parseIncentivesRequest('Show the October payouts for Westport for approval')).toEqual({ intent: 'prepare', branch: 'Westport', exclude: [] });
    expect(parseIncentivesRequest('Show the October payouts')).toEqual({ intent: 'payouts', branch: undefined });
    expect(parseIncentivesRequest('Why is my referral incentive only $40?')).toEqual({ intent: 'explain', goal: 'referral' });
    expect(parseIncentivesRequest('Who on my team is behind on goals?')).toMatchObject({ intent: 'team' });
    expect(parseIncentivesRequest('How am I doing?')).toMatchObject({ intent: 'scorecard' });
  });
});

describe.skipIf(!up)('incentives against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let goals: GoalsService;
  let gateway: ToolGateway;
  let approvals: ApprovalStore;
  const westport = { purviewBranches: ['Westport'] };
  const marcus = { employeeId: 6, leads: true, approves: true };
  const sofia = { employeeId: 4 };
  const input = (text: string, threadId: string, over: Partial<IncentivesInput> = {}): IncentivesInput => ({ runId: `R-${threadId}`, threadId, text, user: { id: 'user:5120', name: 'Marcus Reed', title: 'Branch Manager' }, tenant: { name: 'Harborview', institutionType: 'credit_union' }, apps: ['gi'], purviewBranches: ['Westport'], employeeId: 6, gi: { leads: true, approves: true }, ...over });

  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    goals = new GoalsService(pool);
    approvals = new ApprovalStore(pool);
    gateway = new ToolGateway({ referrals: new ReferralService(pool, 'credit_union'), pipeline: new PipelineService(pool), goals, approvals });
  });
  afterAll(async () => {
    await admin.query('DELETE FROM mod_gi_payout');
    await pool.end();
    await admin.end();
  });

  it('shows someone only their own goals, and explains a payout from its records', async () => {
    const c = await goals.scorecard(undefined, sofia, westport);
    expect(c.goals.map((g) => g.name).sort()).toEqual(['Member survey score', 'New checking accounts', 'Referrals sold']);
    expect(c.total).toBe(115);
    const e = await goals.explain('referral', undefined, sofia, westport);
    expect(e.score.earned).toBe(40);
    expect(e.records.filter((r) => r.counted)).toHaveLength(4);
    expect(e.records.filter((r) => !r.counted)).toHaveLength(2);
    await expect(goals.scorecard('Ana Ruiz', sofia, westport)).rejects.toBeInstanceOf(CoreError);
  });

  it('uses an employee’s own target ahead of the role’s, and says so', async () => {
    const c = await goals.scorecard('Westport', { approves: true }, {}).catch(() => null);
    expect(c).toBeNull();
    const team = await goals.team('Westport', marcus, westport);
    const checking = team.find((x) => x.employeeId === 5)!.goals.find((g) => g.goalId === 'CHECKING')!;
    expect(checking.target).toBe(12);
    expect(checking.targetFrom).toContain('Set for this person');
  });

  it('takes a missed qualifier to zero and flags what deserves a look', async () => {
    const b = await goals.batch('Westport', marcus, westport);
    const failed = b.lines.find((l) => l.employeeId === 3)!;
    expect(failed.amount).toBe(0);
    expect(failed.flags[0]).toContain('under 80');
    const jump = b.lines.find((l) => l.employeeId === 5)!;
    expect(jump.flags.join(' ')).toMatch(/Up from .*Capped.*|waiting for review/);
    expect(b.lines.find((l) => l.employeeId === 2)!.amount).toBe(50);
    expect(b.lines.find((l) => l.own)!.employeeId).toBe(6);
  });

  it('gives the same amounts on every run', async () => {
    expect(await goals.batch('Westport', marcus, westport)).toEqual(await goals.batch('Westport', marcus, westport));
  });

  it('keeps anyone without the access out of payouts', async () => {
    await expect(goals.batch('Westport', sofia, westport)).rejects.toMatchObject({ code: 'NO_ACCESS' });
    await expect(goals.batch('Northgate', marcus, westport)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('prepares one high-risk card that needs the total typed and can’t be approved by voice', async () => {
    const r = recorder();
    const out = await runIncentivesOffline(input('Show the October payouts for Westport for approval', 'thr_gi1'), { gateway }, r.sink);
    expect(out.outcome).toBe('approval');
    const card = out.approval!.card;
    expect(validateBlock(card).ok).toBe(true);
    expect(card.data.riskTier).toBe('high');
    expect(card.data.confirmation.methods).not.toContain('voice');
    expect(card.data.confirmation.typedValue?.expected).toMatch(/^\$\d/);
    expect(r.texts[0]).toContain('your own payout');
    const sample = card.data.preview.kind === 'bulk' ? card.data.preview.sample : [];
    expect(sample.map((s) => s.name)).not.toContain('Marcus Reed');
  });

  it('leaves out anyone named, and refuses a name it can’t find', async () => {
    const r = recorder();
    const staff = (await goals.team('Westport', marcus, westport)).find((c) => c.employeeId === 5)!;
    const last = staff.name.split(' ').at(-1)!;
    const out = await runIncentivesOffline(input(`Approve the October payouts for Westport except ${last}`, 'thr_gi2'), { gateway }, r.sink);
    const sample = out.approval!.card.data.preview.kind === 'bulk' ? out.approval!.card.data.preview.sample : [];
    expect(sample.map((s) => s.name)).not.toContain(staff.name);
    const none = recorder();
    const missing = await runIncentivesOffline(input('Approve the October payouts for Westport except Zebedee', 'thr_gi3'), { gateway }, none.sink);
    expect(missing.approval).toBeUndefined();
    expect(none.texts[0]).toContain('Zebedee');
  });

  it('records an approved batch once, and stops if an amount changed since the card', async () => {
    const r = recorder();
    const out = await runIncentivesOffline(input('Show the October payouts for Westport for approval', 'thr_gi4'), { gateway }, r.sink);
    const record = out.approval!.record;
    const a = await approvals.decide(record.approvalId, { decision: 'approved', userId: 'user:5120', payloadHash: record.payloadHash });
    const ctx = { user: { id: 'user:5120', name: 'Marcus Reed' }, purviewBranches: ['Westport'], employeeId: 6, gi: { leads: true, approves: true } };
    const done = await gateway.execute(a, ctx);
    expect(done).toMatchObject({ operation: 'gi.incentive.approve', replayed: false });
    const after = await goals.batch('Westport', marcus, westport);
    expect(after.waiting).toBe(0);
    expect(after.lines.filter((l) => l.status === 'Approved').length).toBeGreaterThan(0);
    expect(await gateway.execute(a, ctx).catch(() => 'blocked')).not.toMatchObject({ replayed: false });
    await admin.query('DELETE FROM mod_gi_payout');

    const stale = { branch: 'Westport', periodEnd: after.periodEnd, lines: [{ employeeId: 1, name: 'Ana Ruiz', amount: 1 }] };
    await expect(goals.approve(stale, { approvalId: 'apr_stale', userId: 'user:5120' }, marcus, westport)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(goals.approve({ ...stale, lines: [{ employeeId: 6, name: 'Marcus Reed', amount: 300 }] }, { approvalId: 'apr_own', userId: 'user:5120' }, marcus, westport)).rejects.toMatchObject({ code: 'NO_ACCESS' });
  });
});
