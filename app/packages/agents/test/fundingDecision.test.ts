// @vitest-environment node
// "How do we fund next year's loan growth?" on the decision framework: the same growth funded by a deposit
// special, FHLB advances or brokered CDs, each priced and revalued for rate risk by code, challenged by the
// chief risk officer, and revised within its own source.
import { describe, expect, it } from 'vitest';
import { blockSchema, type Block } from '@dinext/block-schemas';
import { ApprovalStore, FundingChoiceService, IrrService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { CRE_RESPONSE_REQUEST, FUNDING_CHOICE_REQUEST, ModuleGateway, creResponseModule, fundingChoiceModule, type ModelClient, type RunSink } from '../src/index.ts';

describe('funding requests', () => {
  it('are recognized', () => {
    for (const q of ['How do we fund next year’s loan growth: deposit pricing, FHLB advances or brokered deposits?', 'How should we fund our loan growth?', 'FHLB advances or brokered deposits?']) expect(FUNDING_CHOICE_REQUEST.test(q), q).toBe(true);
    for (const q of ['How much could we borrow tomorrow?', 'What’s our deposit beta?', 'Show loan growth by branch for Q3 vs Q2']) expect(FUNDING_CHOICE_REQUEST.test(q), q).toBe(false);
  });
});

const up = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM cr_value LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('funding a bank’s loan growth', () => {
  it('prices each source, revalues rate risk, and recommends the cheapest one that holds every limit', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const m = (await new FundingChoiceService(pool).model())!;
      const g = m.today.growth;
      // Today's balance sheet, before any funding, matches the IRR analysis.
      const a = await new IrrService(pool).analysis();
      expect(m.today.eve[400]).toBeCloseTo(a.scenarios.find((s) => s.shockBp === 400)!.nevPct, 9);
      // A money market special reprices existing balances, so it costs more than its rate.
      const special = m.evaluate(m.levers({ deposits: g }));
      expect(special.cannibalized).toBeGreaterThan(0);
      expect(special.allIn).toBeGreaterThan(0.04);
      // Longer FHLB money protects EVE when rates rise; it costs more.
      const two = m.evaluate(m.levers({ fhlb: g, fhlbTermMonths: 24 }));
      const five = m.evaluate(m.levers({ fhlb: g, fhlbTermMonths: 60 }));
      expect(five.eve400).toBeGreaterThan(two.eve400);
      expect(five.cost).toBeGreaterThan(two.cost);
      // Borrowing draws on the FHLB line and adds wholesale funding; a deposit special does neither.
      expect(two.fhlbUsedPct).toBeGreaterThan(special.fhlbUsedPct);
      expect(two.wholesalePct).toBeGreaterThan(special.wholesalePct);

      const spec = fundingChoiceModule({ pool });
      const texts: string[] = [];
      const blocks: Block[] = [];
      const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (t) => void texts.push(t), block: async (b) => void blocks.push(b), suggestion: () => {} };
      const out = await spec.run!({ runId: 'run_f1', threadId: 'thr_f1', text: 'How do we fund next year’s loan growth?', user: { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' }, tenant: { name: 'Coastal Community Bank' }, modules: ['capactions'] }, { model: null, gateway: new ModuleGateway(new ApprovalStore(pool), [spec]) }, sink);
      expect(out.outcome).toBe('approval');
      for (const b of blocks) expect(blockSchema.safeParse(b).success).toBe(true);
      // EVE is inside its limits, so no source needs revising and the three stay as first drawn.
      const table = blocks.find((b) => b.title === 'Three ways to fund next year’s loan growth')!;
      const rows = table.type === 'table' ? table.data.rows! : [];
      expect(rows.find((r) => r.item === 'Funding')).toMatchObject({ deposits: expect.stringMatching(/special/), fhlb: expect.stringMatching(/FHLB/), brokered: expect.stringMatching(/brokered/) });
      expect(rows.find((r) => r.item === 'Limits')).toMatchObject({ deposits: 'Clear', fhlb: 'Clear', brokered: 'Clear' });
      expect(texts.find((t) => t.startsWith('**Recommendation:'))).toMatch(/^\*\*Recommendation: FHLB advances\.\*\* It funds the \$\d+\.\dM of loan growth at \d\.\d\d% all in/);
      const preview = out.approval!.card.data.preview;
      expect(preview.kind === 'message' && preview.body).toMatch(/Recommendation: FHLB advances: \$\d+\.\dM of \d-year FHLB advances/);
      expect(out.approval!.record.operation).toBe('funding.fund_memo');
    } finally {
      await pool.end();
    }
  }, 60_000);

  it('answers the CRE exam finding: says it has no report, and revises the oversight-only response to cut office', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const spec = creResponseModule({ pool });
      const texts: string[] = [];
      const blocks: Block[] = [];
      const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (t) => void texts.push(t), block: async (b) => void blocks.push(b), suggestion: () => {} };
      const out = await spec.run!({ runId: 'run_c1', threadId: 'thr_c1', text: 'Respond to the exam finding on CRE', user: { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' }, tenant: { name: 'Coastal Community Bank' }, modules: ['capactions'] }, { model: null, gateway: new ModuleGateway(new ApprovalStore(pool), [spec]) }, sink);
      expect(out.outcome).toBe('approval');
      for (const b of blocks) expect(blockSchema.safeParse(b).success).toBe(true);
      expect(texts[0]).toMatch(/^DI has no copy of the examination report/);
      expect(texts.find((t) => t.startsWith('**Chief Risk Officer:**'))).toMatch(/A 35% fall in office values would still leave \$\d+\.\dM short/);
      expect(texts.find((t) => t.startsWith('**Planner:**'))).toMatch(/Strengthen oversight\* revised: Don’t renew \$\d+\.\dM of the office loans/);
      const rows = blocks.find((b) => b.title === 'Three responses to the CRE finding')!;
      const office = rows.type === 'table' ? rows.data.rows!.find((r) => String(r.item).startsWith('Office CRE to capital'))! : {};
      for (const k of ['oversight', 'runoff', 'sell']) expect(parseFloat(String((office as Record<string, string>)[k]))).toBeLessThan(44);
      const preview = out.approval!.card.data.preview;
      expect(preview.kind === 'message' && preview.body).toMatch(/The finding: \[add the examiner’s wording\]\./);
      expect(preview.kind === 'message' && preview.body).toMatch(/A board-approved office sub-limit of 45%/);
    } finally {
      await pool.end();
    }
  }, 60_000);
});

describe('CRE exam requests', () => {
  it('are recognized', () => {
    for (const q of ['Respond to the exam finding on CRE', 'Draft our response to the examiners on CRE concentration', 'How do we address the MRA on CRE?']) expect(CRE_RESPONSE_REQUEST.test(q), q).toBe(true);
    expect(CRE_RESPONSE_REQUEST.test('Show our CRE concentration')).toBe(false);
  });
});

describe('acquisition requests', () => {
  it('read the target size from the question', async () => {
    const { ACQUISITION_REQUEST, targetSizeFrom } = await import('../src/index.ts');
    for (const q of ['Could we afford to acquire a bank that size?', 'Could we afford to acquire a $500M bank?', 'Can we buy a bank half our size?']) expect(ACQUISITION_REQUEST.test(q), q).toBe(true);
    expect(ACQUISITION_REQUEST.test('What are our Basel III ratios?')).toBe(false);
    expect(targetSizeFrom('a $500M bank', 1.25e9)).toEqual({ assets: 500e6, said: true });
    expect(targetSizeFrom('a $1.2 billion bank', 1.25e9)).toEqual({ assets: 1.2e9, said: true });
    expect(targetSizeFrom('a bank half our size', 1.25e9)).toEqual({ assets: 625e6, said: true });
    expect(targetSizeFrom('a bank that size', 1.25e9)).toEqual({ assets: 500e6, said: false });
  });
});

describe.skipIf(!up)('an acquisition the bank could afford', () => {
  it('rules out cash, shrinks the stock deal until every limit holds, and says the target is assumed', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const { AcquisitionService } = await import('@dinext/di-core');
      const { acquisitionModule } = await import('../src/index.ts');
      const m = (await new AcquisitionService(pool).model())!;
      // Paying cash adds the target's assets without its capital; stock brings capital in.
      const cash = m.evaluate(m.levers({ targetAssets: 250e6, cashPct: 100 }));
      const stock = m.evaluate(m.levers({ targetAssets: 250e6, cashPct: 0 }));
      expect(stock.levPct).toBeGreaterThan(cash.levPct);
      expect(cash.liquidPct).toBeLessThan(stock.liquidPct);
      expect(stock.newShares).toBeGreaterThan(0);
      expect(cash.intangibles).toBeCloseTo(stock.intangibles, 6);

      const spec = acquisitionModule({ pool });
      const texts: string[] = [];
      const blocks: Block[] = [];
      const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (t) => void texts.push(t), block: async (b) => void blocks.push(b), suggestion: () => {} };
      const out = await spec.run!({ runId: 'run_a1', threadId: 'thr_a1', text: 'Could we afford to acquire a $500M bank?', user: { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' }, tenant: { name: 'Coastal Community Bank' }, modules: ['capactions'] }, { model: null, gateway: new ModuleGateway(new ApprovalStore(pool), [spec]) }, sink);
      expect(out.outcome).toBe('approval');
      for (const b of blocks) expect(blockSchema.safeParse(b).success).toBe(true);
      expect(texts[0]).toMatch(/^DI holds no data on a target bank/);
      expect(texts.find((t) => t.startsWith('**Planner:**'))).toMatch(/All cash\*: Even a \$50\.0M bank/);
      // A structure ruled out is not challenged again in the second round.
      expect(texts.find((t) => t.startsWith('**Chief Risk Officer, second round:**')) ?? '').not.toMatch(/All cash|Half cash/);
      const rec = texts.find((t) => t.startsWith('**Recommendation:'))!;
      // With leverage this close to its stress-based floor, no structure fits even a small bank: not now, and why.
      expect(rec).toMatch(/^\*\*Recommendation: Not now\.\*\* No structure considered holds every limit, even for a \$50\.0M bank.* Build capital first; all stock comes closest/);
      const table = blocks.find((b) => b.title === 'Three ways to pay for the acquisition')!;
      const limits = table.type === 'table' ? table.data.rows!.find((r) => r.item === 'Limits')! : {};
      for (const k of ['cash', 'mixed', 'stock']) expect((limits as Record<string, string>)[k]).toMatch(/breach/);
      const preview = out.approval!.card.data.preview;
      expect(preview.kind === 'message' && preview.body).toMatch(/DI holds no data on a specific target/);

      // A model that asks to revise every challenge: a revision that leaves a thin limit where it was is no answer,
      // so the plan stands on the earn-back instead of shrinking the target for nothing, and lands where offline does.
      const offline = blocks.find((b) => b.title === 'Three ways to pay for the acquisition')!;
      const reviser: ModelClient = {
        turn: async () => {
          throw new Error('no turns');
        },
        structured: async (req) => {
          if (!/For each challenge/.test(req.system)) throw new Error('not scripted');
          const replies = [...req.user.matchAll(/^- (\w+) \/ (\w+) \(/gm)].map((x) => ({ option: x[1]!, check: x[2]!, action: 'revise', reason: 'Change it.' }));
          return { value: { replies } as never, usage: { model: 'm', role: req.role, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        },
      };
      const liveBlocks: Block[] = [];
      await spec.run!({ runId: 'run_a2', threadId: 'thr_a2', text: 'Could we afford to acquire a $500M bank?', user: { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' }, tenant: { name: 'Coastal Community Bank' }, modules: ['capactions'] }, { model: reviser, gateway: new ModuleGateway(new ApprovalStore(pool), [spec]) }, { ...sink, text: async () => {}, block: async (b) => void liveBlocks.push(b) });
      const target = (b: Block | undefined) => (b && b.type === 'table' ? b.data.rows!.find((r) => r.item === 'Target’s assets')! : {}) as Record<string, string>;
      expect(target(liveBlocks.find((b) => b.title === 'Three ways to pay for the acquisition')).stock).toBe(target(offline).stock);
    } finally {
      await pool.end();
    }
  }, 60_000);
});

describe.skipIf(!up)('next year’s budget under stress', () => {
  it('fails the plan on the stress trough, revises it, and keeps the dividend with a commitment to cut it', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const { BudgetStressService } = await import('@dinext/di-core');
      const { budgetStressModule, BUDGET_STRESS_REQUEST } = await import('../src/index.ts');
      expect(BUDGET_STRESS_REQUEST.test('Build the 2027 budget and test it against stress')).toBe(true);
      expect(BUDGET_STRESS_REQUEST.test('Draft the 2027 budget')).toBe(false);
      const m = (await new BudgetStressService(pool).model())!;
      // More loans mean a bigger severe hit and a lower trough; lower expenses mean more earnings.
      const slow = m.evaluate(m.levers({ loanGrowthPct: 2 }));
      const fast = m.evaluate(m.levers({ loanGrowthPct: 9 }));
      expect(fast.hit).toBeGreaterThan(slow.hit);
      expect(fast.troughPct).toBeLessThan(slow.troughPct);
      expect(m.evaluate(m.levers({ expenseGrowthPct: 1 })).ni).toBeGreaterThan(m.evaluate(m.levers({ expenseGrowthPct: 5 })).ni);

      const spec = budgetStressModule({ pool });
      const texts: string[] = [];
      const blocks: Block[] = [];
      const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (t) => void texts.push(t), block: async (b) => void blocks.push(b), suggestion: () => {} };
      const out = await spec.run!({ runId: 'run_b1', threadId: 'thr_b1', text: 'Build the 2027 budget and test it against stress', user: { id: 'user:7001', name: 'Elena Ortiz', title: 'Chief Financial Officer' }, tenant: { name: 'Coastal Community Bank' }, modules: ['capactions'] }, { model: null, gateway: new ModuleGateway(new ApprovalStore(pool), [spec]) }, sink);
      expect(out.outcome).toBe('approval');
      for (const b of blocks) expect(blockSchema.safeParse(b).success).toBe(true);
      expect(texts.find((t) => t.startsWith('**Chief Risk Officer:**'))).toMatch(/The plan:\* In the severely adverse scenario leverage bottoms at \d\.\d\d% in Q3 2027, below the CBLR’s 8%/);
      expect(texts.find((t) => t.startsWith('**Planner:**'))).toMatch(/The plan\* revised: Hold expense growth/);
      expect(texts.find((t) => t.startsWith('**Planner:**'))).toMatch(/stands on the dividend in a severe year: Keep the dividend in the budget; the board commits now to cut it/);
      const table = blocks.find((b) => b.title === 'Three budgets for 2027, and each under severe stress')!;
      const limits = table.type === 'table' ? table.data.rows!.find((r) => r.item === 'Limits')! : {};
      // The plan and the defensive budget clear the trough once revised; the growth budget can't within its levers, so it isn't recommended.
      for (const k of ['plan', 'defensive']) expect((limits as Record<string, string>)[k]).not.toMatch(/breach/);
      expect(texts.find((t) => t.startsWith('**Recommendation:'))).not.toMatch(/^\*\*Recommendation: Growth budget/);
      expect(out.approval!.record.operation).toBe('budstress.budget_memo');
    } finally {
      await pool.end();
    }
  }, 60_000);
});
