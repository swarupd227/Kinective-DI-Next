// @vitest-environment node
// Relationship agent (spec 24.15) with the offline planner and a scripted model in place of Claude,
// against the seeded warehouse. Every member figure on screen must come from code, not the model.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, ReferralService, RelationshipService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { newRelationshipThread, parseMemberRequest, runRelationship, runRelationshipOffline, ToolGateway, type ModelClient, type RunSink, type TurnRequest } from '../src/index.ts';

describe('offline reading of member requests', () => {
  it('reads who and what', () => {
    expect(parseMemberRequest('Pull up Suzanne Jackson at Westport')).toEqual({ intent: 'profile', who: 'Suzanne Jackson at Westport', product: undefined });
    expect(parseMemberRequest('/member Suzanne Jackson')).toMatchObject({ intent: 'profile', who: 'Suzanne Jackson' });
    expect(parseMemberRequest('What should I talk to her about?')).toMatchObject({ intent: 'talking_points', who: undefined });
    expect(parseMemberRequest('Why is her attrition risk medium?')).toMatchObject({ intent: 'explain_attrition', who: undefined });
    expect(parseMemberRequest('Show her household')).toMatchObject({ intent: 'household', who: undefined });
    expect(parseMemberRequest('Suzanne Jackson declined the Credit card offer')).toEqual({ intent: 'decline', who: 'Suzanne Jackson', product: 'Credit card' });
    expect(parseMemberRequest('She declined the HELOC')).toMatchObject({ intent: 'decline', who: undefined, product: 'HELOC' });
    expect(parseMemberRequest('Pull up member …4521')).toMatchObject({ intent: 'profile', who: '…4521' });
  });
});

const available = await warehouseAvailable('dinext_t_test_cu');

class ScriptedModel implements ModelClient {
  calls: TurnRequest[] = [];
  constructor(private readonly script: ((req: TurnRequest) => Anthropic.Beta.BetaContentBlock[])[]) {}
  async turn(req: TurnRequest) {
    this.calls.push(req);
    const step = this.script[this.calls.length - 1];
    if (!step) throw new Error('Script exhausted');
    return {
      message: { id: 'm', type: 'message', role: 'assistant', model: 'scripted', content: step(req), stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } } as unknown as Anthropic.Beta.BetaMessage,
      usage: { model: 'claude-sonnet-5-5', role: req.role, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
  async structured(): Promise<never> {
    throw new Error('not used');
  }
}
const tool = (name: string, input: unknown) => ({ type: 'tool_use', id: `t_${name}_${Math.random().toString(36).slice(2, 7)}`, name, input }) as unknown as Anthropic.Beta.BetaContentBlock;
const lastResults = (req: TurnRequest) => (req.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[]).map((r) => ({ error: r.is_error ?? false, content: String(r.content) }));

function sink() {
  const texts: string[] = [];
  const blocks: Block[] = [];
  const s: RunSink = {
    signal: new AbortController().signal,
    routing: () => {},
    plan: () => 'blk_plan0000000001',
    step: () => {},
    text: async (md) => void texts.push(md),
    block: async (b) => void blocks.push(b),
    suggestion: () => {},
  };
  return { s, texts, blocks };
}

let pool: Pool;
let admin: Pool;
let relationship: RelationshipService;
let gateway: ToolGateway;
const views: number[] = [];
beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
  relationship = new RelationshipService(pool, 'test_cu', 'credit_union');
  gateway = new ToolGateway({ referrals: new ReferralService(pool, 'credit_union'), relationship, approvals: new ApprovalStore(pool), onProfileView: (id) => views.push(id) });
});
afterAll(async () => {
  if (!available) return;
  await admin.query("DELETE FROM ai_approvals WHERE run_id LIKE 'R-rmtest-%'");
  await Promise.all([pool.end(), admin.end()]);
});

const input = (text: string) => ({
  runId: `R-rmtest-${Math.random().toString(36).slice(2, 8)}`,
  threadId: `thr_rmtest_${Math.random().toString(36).slice(2, 8)}`,
  text,
  user: { id: 'user:5120', name: 'Marcus Reed', title: 'Branch Manager, Westport' },
  tenant: { name: 'Harborview Federal Credit Union', institutionType: 'credit_union' as const },
  apps: ['rm', 'referrals'],
  purviewBranches: ['Westport'],
});

describe.skipIf(!available)('Relationship agent, offline planner', () => {
  it('shows one member as a card with talking points, and puts them in focus (spec 8.24)', async () => {
    const out = sink();
    const state = newRelationshipThread();
    const r = await runRelationshipOffline(input('Pull up Suzanne Jackson at Westport'), { gateway, relationship }, state, out.s);
    expect(r.outcome).toBe('member');
    expect(r.focus).toEqual({ token: relationship.token(1), name: 'Suzanne Jackson' });
    expect(state.focus).toMatchObject({ partyId: 1, name: 'Suzanne Jackson' });
    expect(out.blocks.map((b) => b.type)).toEqual(['member_card', 'list']);
    for (const b of out.blocks) expect(validateBlock(b).ok).toBe(true);
    const card = out.blocks[0] as Extract<Block, { type: 'member_card' }>;
    expect(card.data).toMatchObject({ displayName: 'Suzanne Jackson', maskedNumber: '…4521', selected: true, nextBest: ['Checking', 'Credit card'] });
    expect(JSON.stringify(card)).not.toMatch(/10004521|2004-02-20/);
    // "Refer" exists only for products with a referral type (FE-RM-004).
    expect(card.actions?.map((a) => a.label)).toEqual(['Open 360', 'Refer: Credit card']);
    expect(views).toContain(1);
  });

  it('asks the user to choose between several matches and never guesses (AI-AGT-150)', async () => {
    const out = sink();
    const r = await runRelationshipOffline(input('Pull up Jackson'), { gateway, relationship }, newRelationshipThread(), out.s);
    expect(r.outcome).toBe('choose');
    expect(out.blocks[0]).toMatchObject({ type: 'notice', data: { kind: 'uncertain', message: expect.stringMatching(/^More than 4 members match/) } });
    const cards = out.blocks.filter((b) => b.type === 'member_card') as Extract<Block, { type: 'member_card' }>[];
    expect(cards).toHaveLength(4);
    expect(cards.every((c) => !c.data.selected && /^…\d{4}$/.test(c.data.maskedNumber) && c.data.scores.length === 0)).toBe(true);
  });

  it('explains the attrition score of the member in focus, and records a decline only through a card', async () => {
    const state = newRelationshipThread();
    await runRelationshipOffline(input('Pull up Suzanne Jackson'), { gateway, relationship }, state, sink().s);
    const why = sink();
    const r = await runRelationshipOffline(input('Why is her attrition risk medium?'), { gateway, relationship }, state, why.s);
    expect(r.outcome).toBe('explained');
    expect(why.texts[0]).toBe('Suzanne’s attrition risk is 6 of 10 (Medium), mainly because of deposit balances down 18% in 30 days and holds only one product.');
    expect(why.blocks[0]).toMatchObject({ type: 'list', subtitle: 'Model attrition_v4, last run Oct 25, 2026' });

    // The name matches the member in focus, so no second search (names are not unique).
    const declined = sink();
    const d = await runRelationshipOffline(input('Suzanne Jackson declined the Credit card offer'), { gateway, relationship }, state, declined.s);
    expect(d.outcome).toBe('decline_drafted');
    expect(d.toolCalls.map((t) => t.name)).toEqual(['relationship_suggestion_decline']);
    expect(d.card).toMatchObject({ data: { riskTier: 'low', operation: 'relationship.suggestion.decline', summary: 'Record that Suzanne Jackson declined the Credit card offer' } });
    expect(validateBlock(d.card).ok).toBe(true);
    // Nothing is saved until the approval runs.
    expect((await relationship.profile(1, { purviewBranches: ['Westport'] })).opportunities.map((o) => o.product)).toContain('Credit card');
  });

  it('keeps people outside the purview hidden, in the same words as for nobody', async () => {
    const out = sink();
    const r = await runRelationshipOffline(input('Pull up Robert Jackson at Northgate'), { gateway, relationship }, newRelationshipThread(), out.s);
    expect(r.outcome).toBe('not_found');
    expect(out.texts[0]).toBe('I couldn’t find a member matching “Robert Jackson at Northgate” that you can open. Check the spelling, or search with **Ctrl+K**.');
  });
});

describe.skipIf(!available)('Relationship agent with a scripted model', () => {
  it('sees only its own tools, gets masked data, and talking points keep their code-written reasons', async () => {
    const model = new ScriptedModel([
      () => [tool('relationship_party_search', { name: 'Suzanne Jackson' })],
      () => [tool('relationship_profile_get', { member_ref: 'MBR_1' }), tool('relationship_next_best_conversation', { member_ref: 'MBR_1' })],
      (req) => {
        const [profile] = lastResults(req);
        expect(profile!.content).not.toMatch(/10004521|party_?id|2004-02-20|@example\.com/);
        // An unknown topic is refused before anything is shown.
        return [tool('finish_turn', { outcome: 'member', member_ref: 'MBR_1', message: 'Here she is.', talking_points: [{ topic_id: 'T9', text: 'Offer a 2% rate cut.' }] })];
      },
      (req) => {
        expect(lastResults(req)[0]).toMatchObject({ error: true, content: expect.stringContaining('Unknown topic_id T9') });
        return [
          tool('finish_turn', {
            outcome: 'member',
            member_ref: 'MBR_1',
            message: 'Suzanne has $5,400 in savings. She has been with us 12 years.',
            talking_points: [
              { topic_id: 'T1', text: 'Ask whether the pay stub is ready so the $18,500 auto loan can move ahead.' },
              { topic_id: 'T2', text: 'She could get 47 dollars back if she stays.' },
            ],
          }),
        ];
      },
    ]);
    const out = sink();
    const r = await runRelationship(input('Pull up Suzanne Jackson'), { model, gateway, relationship }, newRelationshipThread(), out.s);
    expect(r.outcome).toBe('member');
    expect(model.calls[0]!.tools.map((t) => t.name)).toEqual(['relationship_party_search', 'relationship_profile_get', 'relationship_next_best_conversation', 'predictive_scores_explain', 'relationship_suggestion_decline', 'finish_turn']);
    // Figures not in the data are removed: "12 years" from the message, "3 months" from a talking point.
    expect(out.texts[0]).toBe('Suzanne has $5,400 in savings.');
    const points = out.blocks.find((b) => b.type === 'list') as Extract<Block, { type: 'list' }>;
    expect(points.data.items.map((i) => i.title)).toEqual(['Ask whether the pay stub is ready so the $18,500 auto loan can move ahead.', 'Medium attrition risk']);
    expect(points.data.items[1]!.subtitle).toMatch(/^Attrition score 6 on a 0–10 scale/);
    expect(r.numericRemovals).toHaveLength(2);
  });
});
