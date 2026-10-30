// @vitest-environment node
// Agent pipeline tests with a scripted model in place of Claude, against the seeded warehouse.
// They exercise routing, the tool gateway, purview, grounding and verification at no API cost.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { Block } from '@dinext/block-schemas';
import { validateBlock } from '@dinext/block-schemas';
import { SemanticService, type SemanticResult } from '@dinext/semantic';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { AuditLog, Concierge, prescreen, resolveRef, verifyNarrative, type ModelClient, type RunSink, type TurnRequest } from '../src/index.ts';

// ---- unit: pre-screen and verification -------------------------------------------------------

describe('pre-screen (spec 26.4)', () => {
  it('replaces SSNs, card numbers and account numbers with tokens', () => {
    const r = prescreen('Member 123-45-6789 card 4111 1111 1111 1111 account 004521998877 asked about Q3 2026');
    expect(r.text).not.toMatch(/123-45-6789|4111|004521998877/);
    expect(r.findings.map((f) => f.kind)).toEqual(['ssn', 'card', 'account']);
    expect(r.text).toContain('Q3 2026');
  });

  it('leaves amounts, years and short numbers alone', () => {
    expect(prescreen('Loans over $250,000 in 2026, top 5 branches').findings).toEqual([]);
  });
});

const fake: SemanticResult = {
  queryId: 'sq_test',
  modelVersion: '1.0.0+t3',
  build: { buildId: 'b1', asOf: '2026-10-25', completedAt: '2026-10-26T04:10:00', latestMonthEnd: '2026-09-30' },
  request: { metrics: ['loan_balance'], dimensions: ['branch'], filters: [], order: [], limit: 100, time: { grain: 'quarter', last: 2 } },
  columns: [
    { key: 'branch', label: 'Branch', kind: 'dimension' },
    { key: 'period', label: 'Period', kind: 'period' },
    { key: 'loan_balance', label: 'Total loan balance', kind: 'metric', format: 'currency' },
  ],
  rows: [
    { branch: 'Westport', period: 'Q2 2026', loan_balance: 182_400_000 },
    { branch: 'Westport', period: 'Q3 2026', loan_balance: 200_600_000 },
    { branch: 'Northgate', period: 'Q2 2026', loan_balance: 141_900_000 },
    { branch: 'Northgate', period: 'Q3 2026', loan_balance: 140_800_000 },
  ],
  rowCount: 4,
  truncated: false,
  periods: [
    { key: '2026-Q2', label: 'Q2 2026', start: '2026-04-30', end: '2026-06-30' },
    { key: '2026-Q3', label: 'Q3 2026', start: '2026-07-31', end: '2026-09-30' },
  ],
  filtersApplied: [],
  lineage: [{ metric: 'loan_balance', measures: ['loan_balance_sum'], tables: ['cdm_loan'] }],
  explanation: '',
  sqlHash: 'sha256:x',
  elapsedMs: 1,
};
const results = new Map([['r1', fake]]);

describe('reference resolution (spec 26.7)', () => {
  it('computes values, sums, changes and shares in code', () => {
    expect(resolveRef({ id: 'a', result: 'r1', metric: 'loan_balance', op: 'value', where: { branch: 'Westport', period: 'Q3 2026' } }, results).text).toBe('$200.6M');
    expect(resolveRef({ id: 'b', result: 'r1', metric: 'loan_balance', op: 'sum', where: { period: 'Q3 2026' } }, results).value).toBe(341_400_000);
    const up = resolveRef({ id: 'c', result: 'r1', metric: 'loan_balance', op: 'pct_change', where: { branch: 'Westport', period: 'Q3 2026' }, compare_to: { branch: 'Westport', period: 'Q2 2026' }, up: 'grew', down: 'fell' }, results);
    expect(up.text).toBe('grew 10.0%');
    const down = resolveRef({ id: 'd', result: 'r1', metric: 'loan_balance', op: 'change', where: { branch: 'Northgate', period: 'Q3 2026' }, compare_to: { branch: 'Northgate', period: 'Q2 2026' }, up: 'rose', down: 'fell' }, results);
    expect(down.text).toBe('fell $1.1M');
    expect(resolveRef({ id: 'e', result: 'r1', metric: 'loan_balance', op: 'share', where: { branch: 'Westport', period: 'Q3 2026' } }, results).text).toBe('58.8%');
  });

  it('refuses ambiguous single-value selectors', () => {
    expect(() => resolveRef({ id: 'a', result: 'r1', metric: 'loan_balance', op: 'value', where: { branch: 'Westport' } }, results)).toThrow(/2 rows match/);
  });
});

describe('narrative verification (AI-GRD-061)', () => {
  const resolved = new Map([['g', { id: 'g', text: 'grew 10.0%', value: 10 }]]);
  it('fills placeholders and keeps period labels and question numbers', () => {
    const v = verifyNarrative('Westport {{g}} in Q3 2026. It led the top 5 branches.', resolved, ['Q3 2026', 'top 5 branches']);
    expect(v.text).toBe('Westport grew 10.0% in Q3 2026. It led the top 5 branches.');
    expect(v.removed).toEqual([]);
  });

  it('removes a sentence with a figure the model typed itself', () => {
    const v = verifyNarrative('Westport {{g}} in Q3 2026. Total loans were $1.21B.', resolved, ['Q3 2026']);
    expect(v.text).toBe('Westport grew 10.0% in Q3 2026.');
    expect(v.removed).toEqual(['Total loans were $1.21B.']);
  });

  it('removes a sentence whose placeholder was never defined', () => {
    expect(verifyNarrative('Loans {{missing}}.', resolved, []).unresolved).toEqual(['missing']);
  });
});

// ---- integration: the Concierge with a scripted model ----------------------------------------

const available = await warehouseAvailable('dinext_t_test_cu');

/** Replays a scripted list of tool calls; each entry may inspect the request. */
class ScriptedModel implements ModelClient {
  calls: TurnRequest[] = [];
  constructor(
    private readonly script: ((req: TurnRequest) => Anthropic.Beta.BetaContentBlock[])[],
    private readonly route: string = 'analytics_qa',
  ) {}
  async turn(req: TurnRequest) {
    this.calls.push(req);
    const step = this.script[this.calls.length - 1];
    if (!step) throw new Error('Script exhausted');
    const content = step(req);
    return {
      message: { id: 'm', type: 'message', role: 'assistant', model: 'scripted', content, stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } } as unknown as Anthropic.Beta.BetaMessage,
      usage: { model: 'claude-opus-5-5', role: req.role, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
  async structured() {
    return { value: { intent: 'data_question', agent: this.route, confidence: 0.9, needs_clarification: false, options: [], requires_data: true, risk_hint: 'read' } as never, usage: { model: 'claude-haiku-5-5', role: 'router_fast' as const, inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}

const tool = (name: string, input: unknown, id = `t_${name}_${Math.random().toString(36).slice(2, 7)}`) => ({ type: 'tool_use', id, name, input }) as unknown as Anthropic.Beta.BetaContentBlock;

function recordingSink() {
  const events: { kind: string; value: unknown }[] = [];
  const blocks: Block[] = [];
  const sink: RunSink = {
    signal: new AbortController().signal,
    routing: (agent) => events.push({ kind: 'routing', value: agent }),
    plan: (title) => (events.push({ kind: 'plan', value: title }), 'blk_plan0000000001'),
    step: (_id, u) => events.push({ kind: 'step', value: u }),
    text: async (md) => void events.push({ kind: 'text', value: md }),
    block: async (b) => void blocks.push(b),
    suggestion: (t) => events.push({ kind: 'suggestion', value: t }),
  };
  return { sink, events, blocks, text: () => events.filter((e) => e.kind === 'text').map((e) => e.value as string).join('\n') };
}

let pool: Pool;
let svc: SemanticService;
let auditDir: string;
beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  svc = await SemanticService.create(pool, 'test_cu', 'credit_union');
  auditDir = mkdtempSync(join(tmpdir(), 'dinext-audit-'));
});
afterAll(async () => {
  await pool?.end();
});

const turn = (text: string, extra: Partial<Parameters<Concierge['handle']>[0]> = {}) => ({
  threadId: `thr_${Math.random().toString(36).slice(2, 10)}`,
  runId: 'R-test-0001',
  text,
  context: [],
  user: { id: 'user:9229', name: 'Dana Lee', title: 'President and CEO' },
  tenant: { key: 'test_cu', name: 'Harborview Federal Credit Union', institutionType: 'credit_union' as const, semantic: svc },
  apps: ['home', 'referrals', 'gi'],
  canViewSql: false,
  ...extra,
});

describe.skipIf(!available)('Concierge and Analytics Q&A with a scripted model', () => {
  it('answers through the semantic layer with every figure computed by code', async () => {
    const model = new ScriptedModel([
      () => [tool('semantic_query', { request: { metrics: ['loan_balance'], dimensions: ['branch'], time: { grain: 'quarter', last: 2 } } })],
      () => [
        tool('submit_answer', {
          outcome: 'answer',
          narrative: 'Westport loans {{wg}} in Q3 2026, the most of any branch. Total loans were $9.99B.',
          refs: [{ id: 'wg', result: 'r1', metric: 'loan_balance', op: 'pct_change', where: { branch: 'Westport', period: 'Q3 2026' }, compare_to: { branch: 'Westport', period: 'Q2 2026' }, up: 'grew', down: 'fell' }],
          blocks: [
            { type: 'chart', result: 'r1', chart: 'bar', x: 'branch', series_by: 'period', title: 'Loan balances by branch' },
            { type: 'table', result: 'r1', title: 'Loan balances by branch and quarter' },
          ],
          suggestion: 'Break this down by loan category?',
        }),
      ],
    ]);
    const c = new Concierge({ model, audit: new AuditLog(auditDir) });
    const s = recordingSink();
    expect(await c.handle(turn('Show loan growth by branch for Q3 vs Q2'), s.sink)).toEqual({ kind: 'handled' });

    // The model never saw purview lists, and it was offered only its allow-listed tools.
    expect(JSON.stringify(model.calls[0]!.messages)).not.toMatch(/purview/i);
    expect(model.calls[0]!.tools.map((t) => t.name).sort()).toEqual(['semantic_metric_get', 'semantic_query', 'semantic_search', 'submit_answer']);

    // The typed figure ($9.99B) was removed; the bound one was computed from the rows.
    const text = s.text();
    expect(text).toMatch(/^Westport loans (grew|fell) \d+\.\d% in Q3 2026, the most of any branch\.$/);
    expect(text).not.toContain('9.99');
    expect(s.blocks.map((b) => b.type)).toEqual(['chart', 'table']);
    for (const b of s.blocks) expect(validateBlock(b).ok, b.type).toBe(true);
    const table = s.blocks[1] as Extract<Block, { type: 'table' }>;
    expect(table.data.rows).toHaveLength(12);
    expect(table.provenance.sources.map((x) => x.label)).toEqual(['Total loan balance (definition)', 'Loan history (month-end)']);

    // Audit record: masked question, tool calls, cost, and the removed sentence.
    const file = readdirSync(join(auditDir, 'audit'))[0]!;
    const rec = JSON.parse(readFileSync(join(auditDir, 'audit', file), 'utf8').trim().split('\n').at(-1)!);
    expect(rec).toMatchObject({ outcome: 'answer', route: { agent: 'analytics_qa', mode: 'live' }, numericRemovals: ['Total loans were $9.99B.'], modelVersion: '1.0.0+t3', buildId: 'bld_20261026' });
    expect(rec.toolCalls.map((t: { name: string }) => t.name)).toEqual(['semantic_query', 'submit_answer']);
    expect(rec.totalCostUsd).toBeGreaterThan(0);
  });

  it('returns query errors to the model so it can correct the request', async () => {
    const model = new ScriptedModel([
      () => [tool('semantic_query', { request: { metrics: ['loan_to_share_ratio'], dimensions: ['branch'] } })],
      (req) => {
        const last = req.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
        expect(last[0]!.is_error).toBe(true);
        expect(String(last[0]!.content)).toContain('DIMENSION_NOT_ALLOWED');
        return [tool('semantic_query', { request: { metrics: ['loan_to_share_ratio'] } })];
      },
      () => [tool('submit_answer', { outcome: 'answer', narrative: 'The loan-to-share ratio is {{r}}, reported at institution level only.', refs: [{ id: 'r', result: 'r1', metric: 'loan_to_share_ratio' }] })],
    ]);
    const s = recordingSink();
    await new Concierge({ model, audit: new AuditLog(auditDir) }).handle(turn('Loan to share ratio by branch'), s.sink);
    expect(s.text()).toMatch(/^The loan-to-share ratio is \d+\.\d%, reported at institution level only\.$/);
  });

  it('keeps answers inside the purview and refuses named branches outside it (AI-AGT-008)', async () => {
    const model = new ScriptedModel([
      () => [tool('semantic_query', { request: { metrics: ['loan_balance'], filters: [{ dimension: 'branch', op: 'in', values: ['Northgate'] }] } })],
      () => [tool('submit_answer', { outcome: 'no_access', narrative: 'Northgate is outside your purview.' })],
    ]);
    const s = recordingSink();
    await new Concierge({ model, audit: new AuditLog(auditDir) }).handle(turn('Show Northgate loan balance', { purviewBranches: ['Westport'] }), s.sink);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ type: 'notice', data: { kind: 'no_access', message: 'That is outside your access in DI.' } });
    expect(JSON.stringify(s.blocks)).not.toMatch(/\$\d/);
  });

  it('refuses unmapped questions without calling the model, and logs them (GQ-NEG-007)', async () => {
    const model = new ScriptedModel([]);
    const s = recordingSink();
    await new Concierge({ model, audit: new AuditLog(auditDir) }).handle(turn("What's our wallet share with gig workers?"), s.sink);
    expect(model.calls).toHaveLength(0);
    expect(s.blocks[0]).toMatchObject({ type: 'notice', data: { kind: 'uncertain', message: 'I couldn’t map that question to a defined metric, so I won’t guess.' } });
    const unmatched = readFileSync(join(auditDir, 'unmatched-questions.jsonl'), 'utf8');
    expect(unmatched).toContain('wallet');
  });

  it('answers core write requests deterministically (FE-EXP-151)', async () => {
    const s = recordingSink();
    await new Concierge({ model: new ScriptedModel([]), audit: new AuditLog(auditDir) }).handle(turn("Update Suzanne Jackson's address in the core"), s.sink);
    expect(s.blocks[0]).toMatchObject({ data: { kind: 'not_supported', message: 'DI reads core data and does not write to it.' } });
  });

  it('briefs from real data with code-written figures', async () => {
    const s = recordingSink();
    await new Concierge({ model: new ScriptedModel([], 'dashboard_briefing'), audit: new AuditLog(auditDir) }).handle(turn('Brief me'), s.sink);
    expect(s.text()).toMatch(/Total loan balance is \*\*\$1\.21B\*\*/);
    expect(s.blocks.map((b) => b.type)).toEqual(['kpi_group', 'chart']);
    for (const b of s.blocks) expect(validateBlock(b).ok).toBe(true);
  });

  it('hands placeholder agents back to the Experience Layer as scripts', async () => {
    const s = recordingSink();
    expect(await new Concierge({ model: new ScriptedModel([], 'referral'), audit: new AuditLog(auditDir) }).handle(turn('Refer Suzanne for a HELOC'), s.sink)).toEqual({ kind: 'scripted', agent: 'referral' });
  });

  it('answers simple questions offline from the semantic layer', async () => {
    const s = recordingSink();
    await new Concierge({ model: null, audit: new AuditLog(auditDir) }).handle(turn('Total loans by branch'), s.sink);
    expect(s.text()).toMatch(/\*\*Total loan balance\*\* by branch: \*\*\w+\*\* is highest at \*\*\$[\d.]+M\*\*\./);
    expect(s.blocks.map((b) => b.type)).toEqual(['chart', 'table', 'notice']);
  });

  it('refuses out-of-purview branches offline with the same fixed wording', async () => {
    const s = recordingSink();
    await new Concierge({ model: null, audit: new AuditLog(auditDir) }).handle(turn('Show Northgate loan balance', { purviewBranches: ['Westport'] }), s.sink);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ type: 'notice', data: { kind: 'no_access', message: 'That is outside your access in DI.' } });
    expect(JSON.stringify(s.blocks[0])).not.toContain('retryable');
  });
});
