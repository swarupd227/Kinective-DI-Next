// @vitest-environment node
// Referral agent and tool gateway with a scripted model in place of Claude (spec 24.16, 25).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Block } from '@dinext/block-schemas';
import { validateBlock } from '@dinext/block-schemas';
import { ApprovalStore, ReferralService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { effectiveTier, newReferralThread, parseReferral, REFERRAL_TOOLS, runReferral, ToolGateway, type ModelClient, type RunSink, type TurnRequest } from '../src/index.ts';

describe('offline parsing of referral requests', () => {
  it('reads the person, type, contact, time, amount and note', () => {
    expect(parseReferral('Refer Suzanne Jackson for a HELOC, about $60k, she prefers a call after 5 pm')).toEqual({
      typeId: 'heloc',
      name: 'Suzanne Jackson',
      fields: { preferred_contact: 'Phone', best_time: 'Evening', estimated_amount: 60000 },
      notes: 'About $60k, she prefers a call after 5 pm',
    });
    expect(parseReferral('Send Maria Gomez to the mortgage team')).toMatchObject({ typeId: 'mortgage', name: 'Maria Gomez' });
    // Speech recognition may not capitalise names.
    expect(parseReferral('refer suzanne jackson for a heloc she prefers email')).toMatchObject({ typeId: 'heloc', name: 'suzanne jackson', fields: { preferred_contact: 'Email' } });
    expect(parseReferral('By email')).toMatchObject({ fields: { preferred_contact: 'Email' }, name: undefined });
  });
});

describe('risk tiers are set in code (AI-GRD-070, AI-GRD-073)', () => {
  const create = REFERRAL_TOOLS.find((t) => t.name === 'referral_create')!;
  it('lets a tenant raise a tier but never lower it', () => {
    expect(effectiveTier(create)).toBe('medium');
    expect(effectiveTier(create, { 'referral.create': 'high' })).toBe('high');
    expect(effectiveTier(create, { 'referral.create': 'low' })).toBe('medium');
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
    const content = step(req);
    return {
      message: { id: 'm', type: 'message', role: 'assistant', model: 'scripted', content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } } as unknown as Anthropic.Beta.BetaMessage,
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
let referrals: ReferralService;
let gateway: ToolGateway;
beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
  referrals = new ReferralService(pool, 'credit_union');
  gateway = new ToolGateway({ referrals, approvals: new ApprovalStore(pool) });
});
afterAll(async () => {
  if (!available) return;
  await admin.query("DELETE FROM ai_approvals WHERE run_id LIKE 'R-reftest-%'");
  await Promise.all([pool.end(), admin.end()]);
});

const input = (text: string, extra: Record<string, unknown> = {}) => ({
  runId: `R-reftest-${Math.random().toString(36).slice(2, 8)}`,
  threadId: `thr_reftest_${Math.random().toString(36).slice(2, 8)}`,
  text,
  user: { id: 'user:5120', name: 'Marcus Reed', title: 'Branch Manager, Westport' },
  tenant: { name: 'Harborview Federal Credit Union', institutionType: 'credit_union' as const },
  apps: ['referrals'],
  purviewBranches: ['Westport'],
  ...extra,
});

describe.skipIf(!available)('Referral agent with a scripted model', () => {
  it('drafts through the gateway; the card and its text are written by code', async () => {
    const model = new ScriptedModel([
      () => [tool('relationship_party_search', { name: 'Suzanne Jackson' })],
      (req) => {
        const [r] = lastResults(req);
        expect(r!.content).toContain('"member_ref":"MBR_1"');
        expect(r!.content).not.toMatch(/party_?id|10004521/);
        // A reserved key and a field the form does not have are both refused before anything runs.
        return [tool('referral_create', { referral_type: 'heloc', member_ref: 'MBR_1', fields: { preferred_contact: 'Email' }, user_id: 'user:1' })];
      },
      (req) => {
        expect(lastResults(req)[0]).toMatchObject({ error: true, content: expect.stringContaining('RESERVED_KEY') });
        return [tool('referral_create', { referral_type: 'heloc', member_ref: 'MBR_1', fields: { colour: 'blue' } })];
      },
      (req) => {
        const r = lastResults(req)[0]!;
        expect(r.error).toBe(true);
        expect(r.content).toContain('FORM_INCOMPLETE');
        expect(r.content).toContain('no field \\"colour\\"');
        return [tool('referral_create', { referral_type: 'heloc', member_ref: 'MBR_1', fields: { preferred_contact: 'email', best_time: 'evening', estimated_amount: 60000 }, notes: 'Kitchen remodel' })];
      },
      (req) => {
        expect(lastResults(req)[0]!.content).toContain('approval_required');
        return [tool('finish_turn', { outcome: 'drafted', message: 'Sent!' })];
      },
    ]);
    const out = sink();
    const state = newReferralThread();
    const r = await runReferral(input('Refer Suzanne Jackson for a HELOC, about 60k, email in the evening'), { model, gateway, referrals }, state, out.s);

    expect(r.outcome).toBe('drafted');
    expect(model.calls[0]!.role).toBe('specialist_default');
    expect(model.calls[0]!.tools.map((t) => t.name)).toEqual(['relationship_party_search', 'referral_route', 'referral_create', 'finish_turn']);
    // The model's "Sent!" is not shown: nothing has been sent.
    expect(out.texts.join(' ')).not.toContain('Sent!');
    expect(out.texts[0]).toMatch(/^\*\*HELOC\*\* referral for \*\*Suzanne Jackson\*\*, going to the \*\*Westport Lending Queue\*\*/);
    const card = out.blocks.find((b) => b.type === 'approval_card')!;
    expect(validateBlock(card).ok).toBe(true);
    expect(card).toMatchObject({ data: { riskTier: 'medium', operation: 'referral.create', previewHash: r.draft!.approval.payloadHash, idempotencyKey: `idem_${r.draft!.approval.approvalId}` } });
    expect(r.draft!.payload).toEqual({ typeId: 'heloc', partyId: 1, fields: { preferred_contact: 'Email', best_time: 'Evening', estimated_amount: 60000 }, notes: 'Kitchen remodel', priority: undefined, toQueueId: 'q_lending_westport' });
    expect(state).toMatchObject({ status: 'drafted', draft: { approvalId: r.draft!.approval.approvalId, memberRef: 'MBR_1' } });
  });

  it('rejects "drafted" when nothing was drafted, and keeps people outside the purview hidden', async () => {
    const model = new ScriptedModel([
      () => [tool('relationship_party_search', { name: 'Robert Jackson' })],
      (req) => {
        expect(lastResults(req)[0]!.content).toContain('"count":0');
        return [tool('finish_turn', { outcome: 'drafted', message: 'Done' })];
      },
      (req) => {
        expect(lastResults(req)[0]!.error).toBe(true);
        return [tool('finish_turn', { outcome: 'not_found', message: 'He is at Northgate.' })];
      },
    ]);
    const out = sink();
    const r = await runReferral(input('Refer Robert Jackson for a mortgage'), { model, gateway, referrals }, newReferralThread(), out.s);
    expect(r.outcome).toBe('not_found');
    expect(out.texts).toEqual(['I couldn’t find a member named “Robert Jackson” that you can refer. Check the spelling, or search with **Ctrl+K**.']);
  });

  it('asks for one missing thing with options the user can pick', async () => {
    const model = new ScriptedModel([
      () => [tool('relationship_party_search', { name: 'Suzanne Jackson' })],
      () => [tool('referral_create', { referral_type: 'heloc', member_ref: 'MBR_1', fields: {} })],
      () => [tool('finish_turn', { outcome: 'needs_info', message: 'How does Suzanne prefer to be contacted?', options: ['By phone', 'By email', 'By text', 'In branch'] })],
    ]);
    const out = sink();
    const state = newReferralThread();
    const r = await runReferral(input('Refer Suzanne Jackson for a HELOC'), { model, gateway, referrals }, state, out.s);
    expect(r.outcome).toBe('needs_info');
    expect(out.blocks[0]).toMatchObject({ type: 'notice', data: { kind: 'uncertain', message: 'How does Suzanne prefer to be contacted?', options: [{ label: 'By phone' }, { label: 'By email' }, { label: 'By text' }, { label: 'In branch' }] } });
    expect(state.status).toBe('needs_info');
  });
});
