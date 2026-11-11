// "Build the 2027 budget and test it against stress" on the decision framework. The capital, stress, CECL
// and rate-risk specialists report their limits; the planner drafts three budgets (the plan, a growth budget
// and a defensive one), BudgetStressModel computes each and puts it through the severely adverse scenario,
// the chief risk officer challenges them, and the recommended budget goes to the board behind a card.
import { z } from 'zod';
import type { Block } from '@dinext/block-schemas';
import { BudgetStressService, CoreError, type BudgetCheck, type BudgetFigures, type BudgetLevers, type BudgetStressModel, type FileStore } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { newBlockId } from './answer.ts';
import { capitalSpecialists, mm, p2, signed, usd, SOURCES } from './capitalDecision.ts';
import { runDecision, type Challenge, type DecisionCase, type DecisionOption, type Evaluated } from './decision.ts';
import type { ModuleContext, ModuleSpec } from './moduleAgent.ts';

export const BUDGET_STRESS_REQUEST = /\b(?:build|draft|prepare|put together|make)\b[^.?!]{0,30}\bbudget\b[^.?!]{0,60}\b(?:stress|severe|recession|downturn)\b|\bbudget\b[^.?!]{0,30}\b(?:under|against|through) (?:a )?(?:stress|severe|recession|downturn)|\bstress[- ]test (?:the|our) budget\b/i;
export const BUDGET_STRESS_AGENT = 'Budget and Stress';
const MODULE = 'capactions';
const NO_ACCESS = 'Budgeting against stress isn’t part of your DI access. It is for a bank’s finance leaders.';
const BOARD_FOLDER = 'Board Packs';

type Option = DecisionOption<BudgetLevers>;
type Result = Evaluated<BudgetLevers, BudgetFigures>;
const NOUN: Record<string, string> = { stress_trough: 'the stress trough', leverage: 'the leverage floor', dividend_stress: 'the dividend in a severe year' };
const pct1 = (n: number) => `${n.toFixed(1)}%`;

export function budgetCase(pool: Pool): DecisionCase<BudgetLevers, BudgetFigures> & { model: () => BudgetStressModel } {
  let m: BudgetStressModel | null = null;
  const model = () => {
    if (!m) throw new Error('The budget model is not loaded');
    return m;
  };
  const all = capitalSpecialists(pool);
  const specialists = ['stress', 'capital', 'cecl', 'irr'].map((id) => all.find((s) => s.id === id)!);
  const describe = (c: BudgetCheck, f: BudgetFigures): string => {
    const t = model().today;
    switch (c.id) {
      case 'stress_trough':
        return c.status === 'breach' ? `In the severely adverse scenario leverage bottoms at ${p2(f.troughPct)} in ${t.trough.quarter}, below the CBLR’s ${t.minimumPct}%: this budget fails its own stress test.` : `In the severely adverse scenario leverage bottoms at ${p2(f.troughPct)} in ${t.trough.quarter}, a whisker above the CBLR’s ${t.minimumPct}%.`;
      case 'leverage':
        return `Leverage ends the year at ${p2(f.levPct)} against its ${p2(c.limit)} floor.`;
      case 'dividend_stress':
        return `A severe year turns earnings to ${mm(f.niStress)} against ${mm(f.dividends)} of dividends: the budget pays a dividend it wouldn’t earn.`;
    }
  };
  const critique = (o: Option, f: BudgetFigures): Challenge[] => f.checks.filter((c) => c.status === 'breach' || c.status === 'thin').map((c) => ({ option: o.key, check: c.id, severity: c.status === 'breach' ? ('breach' as const) : ('thin' as const), text: describe(c, f) }));

  const options = async (): Promise<Option[]> => {
    m = await new BudgetStressService(pool).model();
    if (!m) throw new Error('No budget figures');
    const plan = m.today.growthPlanPct;
    return [
      { key: 'plan', name: 'The plan', stance: `Loans up ${plan}% at the capital plan’s pace, expenses up 3.5%, fees up 3%.`, levers: m.levers() },
      { key: 'growth', name: 'Growth budget', stance: 'Loans up 9% with the lenders to do it: expenses up 6%, fees up 5%.', levers: m.levers({ loanGrowthPct: 9, expenseGrowthPct: 6, feeGrowthPct: 5 }) },
      { key: 'defensive', name: 'Defensive budget', stance: 'Loans up 2%, expenses held to 1.5%, fees up 2%.', levers: m.levers({ loanGrowthPct: 2, expenseGrowthPct: 1.5, feeGrowthPct: 2 }) },
    ];
  };

  const revise = (o: Option, ch: Challenge): { levers: BudgetLevers; text: string } | null => {
    if (ch.check === 'dividend_stress') return null;
    const mdl = model();
    const l = o.levers;
    const holds = (x: BudgetLevers) => {
      const c = mdl.evaluate(x).checks.find((y) => y.id === ch.check)!;
      return c.status !== 'breach' && c.status !== 'thin';
    };
    // A growth budget keeps its growth by keeping capital: the dividend gives way first, as far as half.
    if (o.key === 'growth') {
      const floor = Math.round((mdl.today.dividendPerShareQ / 2) * 100) / 100;
      for (let d = Math.round((l.dividendPerShareQ - 0.01) * 100) / 100; d >= floor - 1e-9; d = Math.round((d - 0.01) * 100) / 100) {
        for (let g = l.loanGrowthPct; g >= Math.max(0, l.loanGrowthPct - 3); g -= 1) {
          const x = { ...l, dividendPerShareQ: d, loanGrowthPct: g };
          if (!holds(x)) continue;
          const f = mdl.evaluate(x);
          return { levers: x, text: `Cut the dividend to ${usd(d)} a quarter from ${usd(l.dividendPerShareQ)}${g !== l.loanGrowthPct ? ` and grow loans ${g}% instead of ${l.loanGrowthPct}%` : ', keeping the growth'}; the capital kept takes the severe trough to ${p2(f.troughPct)}, and net income is ${mm(f.ni)}.` };
        }
      }
    }
    // Expenses give way first, down to 2%; then loan growth, a point at a time.
    const exp = Math.min(l.expenseGrowthPct, Math.max(2, l.expenseGrowthPct - 2));
    for (let g = l.loanGrowthPct; g >= 0; g -= 1) {
      const x = { ...l, expenseGrowthPct: exp, loanGrowthPct: g };
      if (!holds(x)) continue;
      const f = mdl.evaluate(x);
      const parts = [exp !== l.expenseGrowthPct ? `hold expense growth to ${pct1(exp)} from ${pct1(l.expenseGrowthPct)}` : '', g !== l.loanGrowthPct ? `grow loans ${g}% instead of ${l.loanGrowthPct}%` : ''].filter(Boolean);
      return { levers: x, text: `${parts.join(' and ').replace(/^./, (c) => c.toUpperCase())}; the severe trough comes to ${p2(f.troughPct)} and net income to ${mm(f.ni)}.` };
    }
    return null;
  };

  const recommend = (results: Result[]) => {
    const issues = (r: Result) => critique(r.option, r.figures).filter((x) => x.check !== 'dividend_stress');
    const clear = results.filter((r) => !issues(r).some((x) => x.severity === 'breach'));
    const pick = [...(clear.length ? clear : results)].sort((a, b) => issues(a).length - issues(b).length || b.figures.ni - a.figures.ni)[0]!;
    const f = pick.figures;
    const t = model().today;
    const l = f.levers;
    const parts = [
      `It grows loans ${l.loanGrowthPct}% (${mm(f.newLoans)}) with expenses up ${pct1(l.expenseGrowthPct)} and fees up ${pct1(l.feeGrowthPct)}, for net income of ${mm(f.ni)} (${signed(f.niChangePct)} on this year’s run rate), ROA ${p2(f.roaPct)} and an efficiency ratio of ${pct1(f.efficiencyPct)}.`,
      `In the severely adverse scenario leverage bottoms at ${p2(f.troughPct)} in ${t.trough.quarter} against the CBLR’s ${t.minimumPct}%, and the year’s earnings would be ${mm(f.niStress)}.`,
      results.every((r) => r.figures.levers.loanGrowthPct === l.loanGrowthPct) ? `The severe stress test, not the plan, sets the growth: every budget comes back to ${l.loanGrowthPct}%, because leverage bottoms at ${p2(t.trough.pct)} today, only ${(t.trough.pct - t.minimumPct).toFixed(2)} points above the CBLR, and even halving the dividend doesn’t keep enough capital for more.` : '',
      f.niStress < f.dividends ? `No budget’s earnings cover the ${mm(f.dividends)} dividend in a severe year, so the budget carries a board commitment to cut it if one comes.` : '',
      f.ni < t.ni ? `Earnings fall from this year’s ${mm(t.ni)} run rate: new loans are reserved when they’re made and earn for half the year, and deposits cost ${l.depositCostBp} bp more.` : '',
    ];
    return { key: pick.option.key, why: parts.filter(Boolean).join(' ') };
  };

  const rowsFor = (results: Result[]) => {
    const t = model().today;
    const row = (item: string, get: (f: BudgetFigures) => string, now = '') => ({ item, now, ...Object.fromEntries(results.map((r) => [r.option.key, get(r.figures)])) });
    return [
      row('Loan growth', (f) => `${f.levers.loanGrowthPct}% (${mm(f.newLoans)})`),
      row('Expense growth', (f) => pct1(f.levers.expenseGrowthPct)),
      row('Net interest income', (f) => mm(f.nii), mm(t.nii)),
      row('Fee income', (f) => mm(f.fee), mm(t.fee)),
      row('Expenses', (f) => mm(f.expense), mm(t.expense)),
      row('Provision', (f) => mm(f.provision), mm(t.provision)),
      row('Net income', (f) => `${mm(f.ni)} (${signed(f.niChangePct)})`, `${mm(t.ni)} run rate`),
      row('EPS', (f) => usd(f.eps), usd(t.ni / t.weighted)),
      row('ROA', (f) => p2(f.roaPct)),
      row('Efficiency ratio', (f) => pct1(f.efficiencyPct)),
      row('Leverage at year end (floor)', (f) => `${p2(f.levPct)} (${p2(t.levFloor)})`, `${p2(t.levPct)} (${p2(t.levFloor)})`),
      row('Severe year: net income', (f) => mm(f.niStress), mm(t.severeYear1)),
      row(`Severe stress: lowest leverage (CBLR ${t.minimumPct}%)`, (f) => p2(f.troughPct), `${p2(t.trough.pct)} in ${t.trough.quarter}`),
      row('Limits', (f) => {
        const own = critique({ key: '', name: '', stance: '', levers: f.levers }, f);
        const b = own.filter((c) => c.severity === 'breach').length;
        return b ? `${b} breach${b === 1 ? '' : 'es'}` : own.length ? `${own.length} thin` : 'Clear';
      }),
    ];
  };

  return {
    agent: BUDGET_STRESS_AGENT,
    get title() {
      return m ? `The ${m.today.year} budget, tested against stress` : 'Next year’s budget, tested against stress';
    },
    planText: 'Here’s how I’ll work: the stress, capital, CECL and rate-risk specialists report their limits at the same time; I draft three budgets (the plan, a growth budget and a defensive one) from this year’s run rate, and DI computes each and puts it through the severely adverse scenario; the chief risk officer challenges them; then I recommend one and draft the board memo for your approval.',
    specialists,
    options,
    evaluate: (l) => model().evaluate(l),
    critique,
    stands: (_o, ch) => (ch.check === 'dividend_stress' ? 'Keep the dividend in the budget; the board commits now to cut it if a severe year comes, as the stress test assumes, rather than budget for a recession.' : null),
    revise,
    nouns: NOUN,
    order: ['stress_trough', 'leverage', 'dividend_stress'],
    recommend,
    blocks: (results, runId) => {
      const t = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
      const rows = rowsFor(results);
      return [{ id: newBlockId('bud'), type: 'table', version: '1.0.0', title: `Three budgets for ${model().today.year}, and each under severe stress`, subtitle: `From this year’s run rate in the ${model().today.quarter} Call Report; deposits cost ${results[0]?.figures.levers.depositCostBp ?? 5} bp more in every budget.`, provenance: { agent: BUDGET_STRESS_AGENT, runId, operations: ['budget.plans'], sources: SOURCES }, freshness: { kind: 'workflow_event' }, data: { columns: [t('item', ''), t('now', 'This year'), ...results.map((r) => t(r.option.key, r.option.name))], rows, rowCount: rows.length } } as Block];
    },
    memo: (chosen, why, results, replies) => ({
      tool: 'budget_memo',
      args: { recommended: chosen.option.key, plans: results.map((r) => ({ key: r.option.key, name: r.option.name, levers: r.option.levers })), why, settled: replies.map((r) => `${results.find((x) => x.option.key === r.option)?.option.name ?? r.option}, round ${r.round}: ${r.action === 'revise' ? 'revised' : 'stands'}. ${r.text}`).slice(0, 12) },
    }),
    corpus: (results) => {
      const out = rowsFor(results).flatMap((r) => Object.values(r));
      for (const r of results) out.push(...critique(r.option, r.figures).map((c) => c.text), mm(r.figures.ni), mm(r.figures.dividends), p2(r.figures.troughPct), String(r.figures.levers.depositCostBp));
      return out;
    },
    facts: (results) =>
      rowsFor(results)
        .map((r) => `${r.item}: this year ${r.now || 'n/a'}; ${results.map((x) => `${x.option.name} ${(r as Record<string, string>)[x.option.key]}`).join('; ')}`)
        .join('\n'),
    summary: (f) => `${f.binding}: ${f.current} against ${f.limit}; ${f.headroom}`,
    suggestions: ['Draft the 2027 budget', 'How would our capital hold up in a severe recession?'],
    model,
  };
}

const MemoInput = z.object({
  recommended: z.string().max(40),
  plans: z.array(z.object({ key: z.string().max(40), name: z.string().max(60), levers: z.object({ loanGrowthPct: z.number().min(-20).max(50), depositCostBp: z.number().min(-200).max(300), expenseGrowthPct: z.number().min(-20).max(50), feeGrowthPct: z.number().min(-50).max(100), dividendPerShareQ: z.number().min(0).max(5) }) })).min(1).max(4),
  why: z.string().max(1500),
  settled: z.array(z.string().max(500)).max(12),
});

export function budgetMemo(m: BudgetStressModel, input: z.infer<typeof MemoInput>, from: { name: string; title: string }) {
  const t = m.today;
  const plans = input.plans.map((x) => ({ ...x, f: m.evaluate(x.levers) }));
  const rec = plans.find((x) => x.key === input.recommended) ?? plans[0]!;
  const f = rec.f;
  const line = (label: string, get: (x: BudgetFigures) => string) => `- ${label}: ${plans.map((x) => `${x.name} ${get(x.f)}`).join('; ')}`;
  const body = [
    'To: Board of Directors',
    `From: ${from.name}, ${from.title}`,
    `Re: The ${t.year} budget, tested against stress`,
    '',
    `Recommendation: ${rec.name.toLowerCase()}: loans up ${f.levers.loanGrowthPct}%, expenses up ${pct1(f.levers.expenseGrowthPct)}, fees up ${pct1(f.levers.feeGrowthPct)}, the dividend at ${usd(f.levers.dividendPerShareQ)} a quarter; net income ${mm(f.ni)}.`,
    '',
    `Why: ${input.why}`,
    '',
    'By budget:',
    line('Net income', (x) => mm(x.ni)),
    line('ROA', (x) => p2(x.roaPct)),
    line('Efficiency ratio', (x) => pct1(x.efficiencyPct)),
    line('Severe year: net income', (x) => mm(x.niStress)),
    line(`Severe stress: lowest leverage (CBLR ${t.minimumPct}%)`, (x) => p2(x.troughPct)),
    '',
    'The chief risk officer’s challenges, and how they were settled:',
    ...(input.settled.length ? input.settled.map((s) => `- ${s}`) : ['- None.']),
    '',
    `Asked of the board: approve the ${t.year} budget, and the commitment to cut the dividend if a severe year comes.`,
    `Figures are DI’s estimates from the ${t.quarter} Call Report and its stress test; the ${f.levers.depositCostBp} bp rise in deposit cost is the ALCO’s assumption.`,
  ].join('\n');
  return { rec, memo: { to: ['Board of Directors'], subject: `The ${t.year} budget, tested against stress`, body: body.slice(0, 4000) } };
}

export function budgetStressModule(deps: { pool: Pool; files?: FileStore | null; today?: () => string }): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes(MODULE)) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: MODULE,
    prefix: 'budstress',
    agent: BUDGET_STRESS_AGENT,
    request: BUDGET_STRESS_REQUEST,
    noAccess: NO_ACCESS,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You build ${tenant}'s budget and test it against stress. You are working with ${user}, ${title}.`,
    plan: () => ({ say: 'Ask me to build next year’s budget and test it against stress.' }),
    run: (input, d, sink) => runDecision(spec, budgetCase(deps.pool), input, d, sink),
    tools: [
      {
        name: 'budget_memo',
        description: 'Draft the board memo on next year’s budget, tested against stress. Sending it needs approval.',
        input: MemoInput,
        run: async (args: z.infer<typeof MemoInput>, ctx) => {
          need(ctx);
          const m = await new BudgetStressService(deps.pool).model();
          if (!m) throw new CoreError('NOT_FOUND', 'There are no figures to budget from yet.');
          const { rec, memo } = budgetMemo(m, args, { name: ctx.user.name, title: 'Chief Financial Officer' });
          return {
            change: {
              summary: `Send the board the ${m.today.year} budget memo: ${rec.name.toLowerCase()}`,
              changes: [
                { label: 'Loan growth', before: `${m.today.growthPlanPct}% in the capital plan`, after: `${rec.f.levers.loanGrowthPct}%` },
                { label: 'Net income', before: `${mm(m.today.ni)} run rate`, after: mm(rec.f.ni) },
                { label: 'Goes to', before: '—', after: `Board of Directors, in ${BOARD_FOLDER}` },
              ],
              text: `I’ve drafted the board memo for the ${rec.name.toLowerCase()}.`,
              done: `Sent. The memo is in ${BOARD_FOLDER}. The budget’s targets aren’t saved until the board approves them; ask me to draft them into Budgets then.`,
              risk: 'high',
              apply: { memo, plan: rec.key },
            },
          };
        },
        apply: async (a: { memo: { subject: string; body: string } }, meta, ctx) => {
          need(ctx);
          if (!deps.files) return;
          const on = deps.today?.() ?? new Date().toISOString().slice(0, 10);
          const staged = await deps.files.stage({ name: `${a.memo.subject.replace(/,/g, '').slice(0, 80)}.txt`, body: Buffer.from(`${a.memo.subject}\n\n${a.memo.body}\n`, 'utf8'), owner: { userId: ctx.user.id, name: ctx.user.name }, on });
          await deps.files.save({ fileId: staged.fileId, folder: BOARD_FOLDER }, { approvalId: meta.approvalId, on });
        },
      },
    ],
  };
  return spec;
}
