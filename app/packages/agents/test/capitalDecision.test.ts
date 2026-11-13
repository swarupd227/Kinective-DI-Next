// @vitest-environment node
// The multi-agent decision framework and its flagship, "Plan our capital actions for next year": specialists
// in parallel, three computed plans, the chief risk officer's challenges, revisions and a board memo that waits
// for approval. Offline (the deterministic planner and critic) and with a scripted model.
import { describe, expect, it } from 'vitest';
import { blockSchema, type Block } from '@dinext/block-schemas';
import { ApprovalStore, CapitalActionsService, IrrService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { CAPITAL_ACTIONS_REQUEST, CAPITAL_PLAN_REQUEST, ModuleGateway, SECURITIES_SALE_REQUEST, capitalActionsModule, capitalMemo, runDecision, securitiesSaleModule, type DecisionCase, type ModelClient, type ModuleTurn, type RunSink, type StepUpdate } from '../src/index.ts';

function recorder() {
  const texts: string[] = [];
  const blocks: Block[] = [];
  const steps: (StepUpdate & { at: number })[] = [];
  let n = 0;
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: (_t, _a, s) => (steps.push(...s.map((x) => ({ ...x, at: n++ }))), 'blk_plan00000000'), step: (_p, u) => void steps.push({ ...u, at: n++ }), text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { sink, texts, blocks, steps, last: (id: string) => [...steps].reverse().find((s) => s.id === id && s.state !== 'waiting')?.state };
}

const turn = (text: string, modules = ['capactions']): ModuleTurn => ({ runId: 'run_cap1', threadId: 'thr_cap1', text, user: { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' }, tenant: { name: 'Coastal Community Bank' }, modules });

describe('capital actions requests', () => {
  it('route to the decision, not to the capital plan', () => {
    for (const q of ['Plan our capital actions for next year', 'Lay out our capital actions for 2027', 'Recommend our capital actions for the coming year']) {
      expect(CAPITAL_ACTIONS_REQUEST.test(q), q).toBe(true);
      expect(CAPITAL_PLAN_REQUEST.test(q), q).toBe(false);
    }
    expect(CAPITAL_ACTIONS_REQUEST.test('How much can we return to shareholders this year?')).toBe(false);
    for (const q of ['Should we sell our low-yield securities at a loss?', 'Would a securities repositioning make sense?', 'What if we sell some underwater bonds?']) expect(SECURITIES_SALE_REQUEST.test(q), q).toBe(true);
    expect(SECURITIES_SALE_REQUEST.test('What are our securities worth if rates rise?')).toBe(false);
  });
});

describe('the decision framework', () => {
  // A toy case: one lever, one limit. Specialists run at once; a breach is always revised.
  type L = { amount: number };
  const toy: DecisionCase<L, { used: number }> = {
    agent: 'Toy',
    title: 'Toy decision',
    planText: 'Plan.',
    specialists: ['a', 'b'].map((id) => ({ id, agent: `Spec ${id}`, label: `Spec ${id}`, run: async () => ({ specialist: id, agent: `Spec ${id}`, binding: 'Limit', current: '5', limit: '10', headroom: '5', breachIf: 'Over 10', status: 'pass' as const }) })),
    options: () => [
      { key: 'low', name: 'Low', stance: '', levers: { amount: 4 } },
      { key: 'high', name: 'High', stance: '', levers: { amount: 12 } },
    ],
    evaluate: (l) => ({ used: l.amount / 10 }),
    critique: (o, f) => (f.used > 1 ? [{ option: o.key, check: 'limit', severity: 'breach' as const, text: `Uses ${f.used * 100}% of the limit.` }] : []),
    stands: () => 'It stands.',
    revise: (o) => ({ levers: { amount: 10 }, text: `Cut ${o.name} to 10.` }),
    order: ['limit'],
    recommend: (rs) => ({ key: rs.reduce((x, y) => (y.figures.used > x.figures.used ? y : x)).option.key, why: 'Most room used.' }),
    blocks: () => [],
    memo: (c) => ({ tool: 'memo', args: { key: c.option.key, amount: c.option.levers.amount } }),
    corpus: () => ['10', '120', '100'],
    facts: () => '',
    summary: (f) => f.binding,
  };
  const spec = { id: 'toy', prefix: 'toy', agent: 'Toy', request: /toy/, noAccess: '', sources: [], prompt: () => '', plan: () => ({ say: '' }), tools: [{ name: 'memo', description: '', input: { safeParse: (x: unknown) => ({ success: true, data: x }) } as never, run: async (a: { key: string; amount: number }) => ({ change: { summary: `Memo for ${a.key}`, changes: [], text: `Drafted for ${a.key} at ${a.amount}.`, done: 'Sent.', risk: 'high' as const, apply: { memo: { to: ['Board'], subject: 'S', body: 'B' } } } }) }] };
  const approvals = { request: async (r: { operation: string; payload: unknown; riskTier: string }) => ({ approvalId: 'apr_test00000001', status: 'pending', operation: r.operation, payload: r.payload, riskTier: r.riskTier, payloadHash: 'sha256:abcdef0123', expiresAt: '2026-11-12T00:00:00Z' }), supersede: async () => [] } as unknown as ApprovalStore;

  it('revises a breach, re-checks it and ends on a memo card', async () => {
    const r = recorder();
    const out = await runDecision(spec as never, toy, turn('toy'), { model: null, gateway: new ModuleGateway(approvals, [spec as never]) }, r.sink);
    expect(out.outcome).toBe('approval');
    expect(r.last('spec_a')).toBe('done');
    expect(r.last('critic_1')).toBe('done');
    expect(r.last('revise_1')).toBe('done');
    // The revision holds, so the second round has nothing new.
    expect(r.steps.find((s) => s.id === 'critic_2' && s.state === 'done')?.resultSummary).toMatch(/No new challenges/);
    expect(r.texts.some((t) => /High.*Uses 120% of the limit/.test(t))).toBe(true);
    expect(r.texts.some((t) => /High\* revised: Cut High to 10/.test(t))).toBe(true);
    expect(out.approval?.card.data.preview).toEqual({ kind: 'message', to: ['Board'], subject: 'S', body: 'B' });
    expect(r.last('memo')).toBe('needs_input');
  });

  it('keeps the model’s figures honest: a breach is revised whatever it says, and unknown numbers are dropped', async () => {
    const model: ModelClient = {
      turn: async () => {
        throw new Error('no turns');
      },
      structured: async (req) => {
        const usage = { model: 'm', role: req.role, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
        const user = req.user;
        if (/Write the plan of work/.test(user)) return { value: { plan: 'I will ask both specialists. It will take 37 minutes.' } as never, usage };
        if (/Challenges to word/.test(user)) return { value: { challenges: [{ option: 'high', check: 'limit', text: 'High uses 120% of its limit. That is 999 times too much.' }] } as never, usage };
        if (/For each challenge/.test(req.system)) return { value: { replies: [{ option: 'high', check: 'limit', action: 'stands', reason: 'It is fine.' }] } as never, usage };
        return { value: { option: 'low', why: 'Low keeps 60 of room.' } as never, usage };
      },
    };
    const r = recorder();
    const out = await runDecision(spec as never, toy, turn('toy'), { model, gateway: new ModuleGateway(approvals, [spec as never]) }, r.sink);
    expect(r.texts[0]).toBe('I will ask both specialists.');
    expect(r.texts.some((t) => /High uses 120% of its limit\./.test(t) && !/999/.test(t))).toBe(true);
    // The model said it stands; a breach is revised anyway.
    expect(r.texts.some((t) => /High\* revised/.test(t))).toBe(true);
    // The model's recommendation is used when the plan has no breach; its unchecked figure is dropped.
    expect(r.texts.some((t) => /Recommendation: Low\.\*\* Most room used\./.test(t))).toBe(true);
    expect(out.usage.length).toBeGreaterThanOrEqual(4);
  });
});

const up = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM fin_capital_plan LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('capital actions for a bank', () => {
  it('computes each plan from the services and the what-if matches the IRR analysis', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const irr = new IrrService(pool);
      const a = await irr.analysis();
      const w = irr.whatIf(await irr.positions());
      for (const bp of [200, 300, 400]) expect(w.shocks.find((s) => s.shockBp === bp)!.evPct).toBeCloseTo(a.scenarios.find((s) => s.shockBp === bp)!.nevPct, 9);
      const m = (await new CapitalActionsService(pool).model())!;
      const t = m.today;
      // The demo bank: leverage binds at its floor, capacity $12.9M, the allowance $0.56M short, EVE −14.9% at +200 bp, office 47% against 50%.
      // (Each loan's own rate type, from its terms: variable commercial lines lower EVE risk and deepen the severe-stress decline.)
      expect(t.cap.capacity.binding).toBe('leverage');
      expect(t.cap.capacity.total / 1e6).toBeCloseTo(12.9, 1);
      expect(t.ceclGap / 1e6).toBeCloseTo(0.56, 2);
      expect(t.eve[200]).toBeCloseTo(-14.9, 1);
      expect(Math.round(t.officePct)).toBe(47);
      // Paying out the capital plan's capacity with nothing else lands leverage on the capital plan's floor.
      const atCap = m.evaluate(m.levers({ buyback: t.cap.capacity.buybackRoom }));
      expect(atCap.levFloor).toBeCloseTo(t.cap.floors.leverage, 9);
      // A buyback above tangible book lifts EPS and dilutes tangible book value; selling securities cuts EVE risk.
      const none = m.evaluate(m.levers());
      const bb = m.evaluate(m.levers({ buyback: 5e6 }));
      expect(bb.epsRun).toBeGreaterThan(none.epsRun);
      expect(bb.tbvps).toBeLessThan(none.tbvps);
      const sold = m.evaluate(m.levers({ afsSale: 50e6 }));
      expect(sold.eve400).toBeGreaterThan(none.eve400);
      expect(sold.afsLoss).toBeCloseTo(50e6 * t.afs.lossRate, 2);
      expect(sold.levPct).toBeLessThan(none.levPct);
      // The optimizer's buyback is the largest within every limit.
      const l = m.levers({ growth: { mortgage: 15e6 } });
      const max = m.maxBuyback(l);
      expect(m.evaluate({ ...l, buyback: max }).breaches.filter((c) => !c.today)).toEqual([]);
      expect(m.evaluate({ ...l, buyback: max + 1e6 }).breaches.length).toBeGreaterThan(m.evaluate({ ...l, buyback: max }).breaches.length);
    } finally {
      await pool.end();
    }
  }, 60_000);

  it('runs the decision offline: specialists, three plans, the critic, revisions and a memo for approval', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const spec = capitalActionsModule({ pool });
      const store = new ApprovalStore(pool);
      const gateway = new ModuleGateway(store, [spec]);
      const r = recorder();
      const out = await spec.run!(turn('Plan our capital actions for next year'), { model: null, gateway }, r.sink);
      expect(out.outcome).toBe('approval');
      for (const b of r.blocks) expect(blockSchema.safeParse(b).success, JSON.stringify(blockSchema.safeParse(b).error?.issues?.slice(0, 2))).toBe(true);
      // Every specialist reported, at the same time.
      for (const id of ['capital', 'cecl', 'irr', 'concentration', 'liquidity', 'stress']) expect(r.last(`spec_${id}`), id).toBe('done');
      const findings = r.blocks.find((b) => b.title === 'What each specialist says binds')!;
      expect(findings.type === 'table' && findings.data.rows?.map((x) => x.agent)).toEqual(['Capital Plan', 'CECL', 'Interest Rate Risk', 'Concentration', 'Liquidity', 'CAMELS and stress test']);
      expect(r.steps.find((s) => s.id === 'spec_capital' && s.state === 'done')?.resultSummary).toMatch(/Leverage ratio floor: 10\.44% against 10\.12%; \$12\.9M capacity; dividends take \$4\.3M, leaving \$8\.6M/);
      // Three plans in a table, the critic's challenges, the planner's answers, and a recommendation.
      const table = r.blocks.find((b) => b.title === 'Three capital plans for the next four quarters')!;
      expect(table.type === 'table' && table.data.columns.map((c) => c.headerName)).toEqual(['', 'Today', 'Conservative', 'Balanced', 'Shareholder return']);
      const critic = r.texts.find((t) => t.startsWith('**Chief Risk Officer:**'))!;
      // EVE is inside its limits now; the shareholder plan is challenged on the leverage floor, office concentration and the allowance.
      expect(critic).toMatch(/Shareholder return:\* Leverage ends at \d+\.\d\d% against a \d+\.\d\d% floor/);
      expect(critic).toMatch(/Shareholder return:\* Office CRE reaches/);
      expect(critic).toMatch(/allowance \$0\.56M short/);
      expect(r.texts.find((t) => t.startsWith('**Planner:**'))).toMatch(/Shareholder return\* (revised|stands)/);
      expect(r.texts.find((t) => t.startsWith('**Recommendation:'))).toMatch(/^\*\*Recommendation: Balanced\.\*\* It returns \$\d+\.\dM to shareholders/);
      // The recommended plan holds every limit.
      const rows = table.type === 'table' ? table.data.rows! : [];
      expect(rows.find((x) => x.item === 'Limits')!.balanced).toBe('Clear');
      // The memo waits on a high-risk card showing the memo itself; nothing is saved.
      expect(out.approval!.record.riskTier).toBe('high');
      const preview = out.approval!.card.data.preview;
      expect(preview.kind).toBe('message');
      if (preview.kind === 'message') {
        expect(preview.to).toEqual(['Board of Directors']);
        expect(preview.body).toMatch(/^To: Board of Directors\nFrom: Elena Ortiz, Chief Financial Officer\nRe: Capital actions for 2027\n\nRecommendation: the balanced plan\./);
        expect(preview.body).toMatch(/The chief risk officer’s challenges, and how they were settled:/);
        expect(preview.body).not.toMatch(/CAMELS rating|composite/i);
      }
      expect(r.last('memo')).toBe('needs_input');
      // The memo recomputes from the levers: the same plan gives the same memo.
      const m = (await new CapitalActionsService(pool).model())!;
      const payload = out.approval!.record.payload as { apply: { memo: { body: string } } };
      expect(capitalMemo(m, (out.toolCalls.find((t) => t.name === 'cap_memo')!.input as never), { name: 'Elena Ortiz', title: 'Chief Financial Officer' }).memo.body).toBe(payload.apply.memo.body);
      // Without the module, no memo.
      const denied = await gateway.call(spec, 'cap_memo', out.toolCalls.find((t) => t.name === 'cap_memo')!.input, { user: { id: 'u', name: 'U' }, modules: [], runId: 'r', threadId: 't' });
      expect(denied.ok).toBe(false);
      await store.supersede('thr_cap1', 'apr_none00000000');
    } finally {
      await pool.end();
    }
  }, 60_000);

  it('weighs a securities sale on the same framework: with every limit holding, it holds and says what a repositioning would cost', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const spec = securitiesSaleModule({ pool });
      const r = recorder();
      const out = await spec.run!(turn('Should we sell our low-yield securities at a loss?'), { model: null, gateway: new ModuleGateway(new ApprovalStore(pool), [spec]) }, r.sink);
      expect(out.outcome).toBe('approval');
      for (const b of r.blocks) expect(blockSchema.safeParse(b).success).toBe(true);
      for (const id of ['irr', 'capital', 'liquidity', 'stress']) expect(r.last(`spec_${id}`), id).toBe('done');
      // EVE at +400 bp is inside its limit, so holding is recommended, against a real repositioning of the lowest-yielding tenth.
      expect(r.texts.find((t) => t.startsWith('**Recommendation:'))).toMatch(/^\*\*Recommendation: Hold\.\*\* Every limit holds without a sale.* A targeted sale of \$\d+\.0M would realize a \$\d+\.\dM loss .* earn it back in \d+\.\d years/);
      const table = r.blocks.find((b) => b.title === 'Hold or sell the low-yield securities')!;
      const rows = table.type === 'table' ? table.data.rows! : [];
      expect(rows.find((x) => x.item === 'Limits')).toMatchObject({ hold: 'Clear', targeted: 'Clear' });
      const sold = rows.find((x) => x.item === 'Low-yield securities sold')!;
      expect(sold.hold).toBe('None');
      expect(sold.targeted).toMatch(/^\$\d+\.0M$/);
      expect(sold.broad).toMatch(/^\$\d+\.0M$/);
      const preview = out.approval!.card.data.preview;
      expect(preview.kind === 'message' && preview.to).toEqual(['Board of Directors', 'ALCO']);
      expect(out.approval!.record.operation).toBe('secsale.sec_memo');
    } finally {
      await pool.end();
    }
  }, 60_000);
});
