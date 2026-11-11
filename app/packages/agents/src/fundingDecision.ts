// "How do we fund next year's loan growth: deposit pricing, FHLB advances or brokered deposits?" on the
// decision framework. Specialists for rate risk, liquidity, wholesale funding and deposit pricing report
// their limits; the planner sets the three sources side by side for the same growth, FundingModel computes
// each, the chief risk officer challenges them, and the recommendation ends in an ALCO memo behind an
// approval card.
import { z } from 'zod';
import type { Block } from '@dinext/block-schemas';
import { AlcoService, CoreError, FUNDING_POLICY, FUNDING_RATES, FundingChoiceService, FundingRiskService, type FileStore, type FundingCheck, type FundingFigures, type FundingLevers, type FundingModel } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { newBlockId } from './answer.ts';
import { capitalSpecialists } from './capitalDecision.ts';
import { runDecision, type Challenge, type DecisionCase, type DecisionOption, type Evaluated, type Reply, type Specialist } from './decision.ts';
import type { ModuleContext, ModuleSpec } from './moduleAgent.ts';

export const FUNDING_CHOICE_REQUEST = /\bhow (?:do|should|will|would|can) we fund\b|\bfund(?:ing)? (?:for )?(?:next year'?s |our |the |this )?(?:loan |balance sheet )?growth\b|\b(?:fhlb|brokered)\b[^.?!]{0,60}\b(?:or|versus|vs\.?)\b[^.?!]{0,40}\b(?:fhlb|brokered|deposits?)\b|\bdeposit pricing\b[^.?!]{0,40}\b(?:or|versus|vs\.?)\b[^.?!]{0,40}\b(?:fhlb|brokered|borrow)/i;
export const FUNDING_CHOICE_AGENT = 'Funding Decision';
const MODULE = 'capactions';
const NO_ACCESS = 'Funding decisions aren’t part of your DI access. They are for a bank’s finance leaders.';
const BOARD_FOLDER = 'Board Packs';
const SOURCES: ModuleSpec['sources'] = [
  { kind: 'table', label: 'FFIEC 051 Call Report values', ref: 'table:cr_value' },
  { kind: 'table', label: 'Loans and deposits', ref: 'table:cdm_deposit_account' },
  { kind: 'table', label: 'Deposit rate history', ref: 'table:hist_deposit_month' },
];

const mm = (n: number) => `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(1)}M`;
const mm2 = (n: number) => `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(2)}M`;
const p1 = (n: number) => `${n.toFixed(1)}%`;
const p2 = (n: number) => `${n.toFixed(2)}%`;
const neg = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`;
const usd = (n: number | null) => (n === null ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`);
/** "Deposit pricing" mid-sentence, but "FHLB advances" keeps its capitals. */
const lower = (name: string) => name.replace(/\b([A-Z])([a-z])/g, (_, a: string, b: string) => a.toLowerCase() + b);
const years = (m: number) => (m ? `${m / 12}-year` : 'money market');

type Option = DecisionOption<FundingLevers>;
type Result = Evaluated<FundingLevers, FundingFigures>;
const NOUN: Record<string, string> = { eve200: 'EVE at +200 bp', eve400: 'EVE at +400 bp', nii200: 'NII at +200 bp', wholesale: 'the wholesale funding limit', brokered: 'the brokered deposit limit', fhlb_reserve: 'the FHLB reserve', contingent: 'contingent liquidity' };

function describe(c: FundingCheck, f: FundingFigures): string {
  switch (c.id) {
    case 'eve200':
      return c.status === 'breach' ? `EVE at +200 bp falls ${p1(c.value)}, past its −${c.limit}% limit.` : `EVE at +200 bp ends at ${neg(f.eve200)} against −${c.limit}%, at the edge.`;
    case 'eve400':
      return c.worseThanToday ? `EVE at +400 bp is already over its −${c.limit}% limit, and this funding takes it further to ${neg(f.eve400)}.` : `EVE at +400 bp falls ${p1(c.value)}, past its −${c.limit}% limit.`;
    case 'nii200':
      return `NII falls ${p1(c.value)} at +200 bp against a ${c.limit}% limit.`;
    case 'wholesale':
      return `Wholesale funding reaches ${p1(c.value)} of funding against the ${c.limit}% policy limit.`;
    case 'brokered':
      return `Brokered deposits reach ${p1(c.value)} of deposits against the ${c.limit}% policy limit.`;
    case 'fhlb_reserve':
      return `The FHLB line is ${p1(c.value)} in use; policy keeps half of it free for the contingency funding plan.`;
    case 'contingent':
      return `Available funding falls to ${p1(c.value)} of deposits against the ${c.limit}% minimum.`;
  }
}

export function fundingCase(pool: Pool): DecisionCase<FundingLevers, FundingFigures> & { model: () => FundingModel } {
  let m: FundingModel | null = null;
  const model = () => {
    if (!m) throw new Error('The funding model is not loaded');
    return m;
  };
  const shared = capitalSpecialists(pool);
  const specialists: Specialist[] = [
    shared.find((s) => s.id === 'irr')!,
    shared.find((s) => s.id === 'liquidity')!,
    {
      id: 'wholesale',
      agent: 'Funding risk',
      label: 'Funding risk: wholesale and brokered reliance',
      run: async () => {
        const a = (await new FundingRiskService(pool).loanToDeposit())!;
        const brokeredPct = a.deposits ? (a.brokered / a.deposits) * 100 : 0;
        const room = (FUNDING_POLICY.wholesaleMaxPct / 100) * (a.deposits + a.borrowings) - a.wholesale;
        return { specialist: 'wholesale', agent: 'Funding risk', binding: 'Wholesale funding share', current: p1(a.wholesaleSharePct), limit: `${FUNDING_POLICY.wholesaleMaxPct}%`, headroom: `${mm(room)} more wholesale money; brokered is ${p1(brokeredPct)} of deposits against ${FUNDING_POLICY.brokeredMaxPct}%; loans are ${p1(a.pct)} of deposits`, breachIf: 'Funding growth with FHLB or brokered money beyond that room', status: a.wholesaleSharePct / FUNDING_POLICY.wholesaleMaxPct >= 0.85 ? 'watch' : 'pass' };
      },
    },
    {
      id: 'pricing',
      agent: 'ALCO',
      label: 'ALCO: deposit pricing and betas',
      run: async () => {
        const a = await new AlcoService(pool, 'bank').pricing();
        const mmProduct = a?.products.find((p) => /money market/i.test(p.category));
        return { specialist: 'pricing', agent: 'ALCO', binding: 'Deposit cost and beta', current: a ? `${p2(a.total.rateNow)} cost; beta ${a.total.beta?.toFixed(2) ?? '—'}` : '—', limit: 'No policy limit', headroom: mmProduct ? `Money market pays ${p2(mmProduct.rateNow)} on ${mm(mmProduct.balance)}` : 'No money market book', breachIf: 'A special priced above the book reprices existing balances too', status: 'pass' };
      },
    },
  ];

  const options = async (): Promise<Option[]> => {
    m = await new FundingChoiceService(pool).model();
    if (!m) throw new Error('No funding figures');
    const g = m.today.growth;
    return [
      { key: 'deposits', name: 'Deposit pricing', stance: 'Win the money from customers with a money market special.', levers: m.levers({ deposits: g }) },
      { key: 'fhlb', name: 'FHLB advances', stance: 'Borrow it from the FHLB, fixed for two years.', levers: m.levers({ fhlb: g, fhlbTermMonths: 24 }) },
      { key: 'brokered', name: 'Brokered deposits', stance: 'Buy one-year brokered CDs.', levers: m.levers({ brokered: g, brokeredTermMonths: 12 }) },
    ];
  };

  // A limit the bank is over before any funding choice is challenged only when a choice makes it worse.
  const critique = (o: Option, f: FundingFigures): Challenge[] =>
    f.checks
      .filter((c) => (c.status === 'breach' && (!c.today || c.worseThanToday)) || c.status === 'thin')
      .map((c) => ({ option: o.key, check: c.id, severity: c.status === 'breach' ? ('breach' as const) : ('thin' as const), text: describe(c, f) }));

  /** Lengthens the option's own source (a certificate special instead of money market, longer brokered CDs or advances) until the check holds. */
  const lengthen = (l: FundingLevers, id: string) => {
    const mdl = model();
    const holds = (x: FundingLevers) => {
      const c = mdl.evaluate(x).checks.find((y) => y.id === id)!;
      return c.today ? !c.worseThanToday : c.status !== 'breach' && c.status !== 'thin';
    };
    const tries: FundingLevers[] =
      l.deposits > 0
        ? ([24, 36] as const).filter((m) => m > l.depositTermMonths).map((m) => ({ ...l, depositTermMonths: m }))
        : l.brokered > 0
          ? ([36, 60] as const).filter((m) => m > l.brokeredTermMonths).map((m) => ({ ...l, brokeredTermMonths: m }))
          : ([36, 60] as const).filter((m) => m > l.fhlbTermMonths).map((m) => ({ ...l, fhlbTermMonths: m }));
    return tries.find(holds) ?? null;
  };
  const termText = (l: FundingLevers, f: FundingFigures) => (l.deposits > 0 ? `a ${years(l.depositTermMonths)} certificate special at ${p2(f.depositRate * 100)}` : l.brokered > 0 ? `${years(l.brokeredTermMonths)} brokered CDs at ${p2(f.brokeredRate * 100)}` : `${years(l.fhlbTermMonths)} advances at ${p2(f.fhlbRate * 100)}`);

  const revise = (o: Option, ch: Challenge) => {
    const l = o.levers;
    const mdl = model();
    if (['eve200', 'eve400', 'nii200'].includes(ch.check)) {
      const x = lengthen(l, ch.check);
      if (!x) return null;
      const f = mdl.evaluate(x);
      const text = `Use ${termText(x, f)} instead: longer money holds its value when rates rise. EVE at +400 bp ends at ${neg(f.eve400)} and at +200 bp at ${neg(f.eve200)}, at an all-in cost of ${p2(f.allIn * 100)}.`;
      return { levers: x, text };
    }
    // Policy limits on wholesale money: move the excess back to deposits.
    const f0 = mdl.evaluate(l);
    for (let moved = 5e6; moved <= l.fhlb + l.brokered; moved += 5e6) {
      const fromB = Math.min(l.brokered, moved);
      const x = { ...l, brokered: l.brokered - fromB, fhlb: l.fhlb - (moved - fromB), deposits: l.deposits + moved };
      const c = mdl.evaluate(x).checks.find((y) => y.id === ch.check)!;
      if (c.status !== 'breach' && c.status !== 'thin') return { levers: x, text: `Raise ${mm(moved)} of it from deposits instead; the all-in cost goes from ${p2(f0.allIn * 100)} to ${p2(mdl.evaluate(x).allIn * 100)}.` };
    }
    return null;
  };

  const recommend = (results: Result[]) => {
    const issues = (r: Result) => critique(r.option, r.figures);
    const clear = results.filter((r) => !issues(r).some((x) => x.severity === 'breach'));
    const pick = [...(clear.length ? clear : results)].sort((a, b) => issues(a).length - issues(b).length || a.figures.cost - b.figures.cost)[0]!;
    const f = pick.figures;
    const t = model().today;
    const dear = results.reduce((x, y) => (y.figures.cost > x.figures.cost ? y : x));
    const parts = [
      `It funds the ${mm(f.growth)} of loan growth at ${p2(f.allIn * 100)} all in, ${mm2(f.cost)} a year (${usd(f.epsImpact)} a share after tax).`,
      `EVE ends at ${neg(f.eve200)} at +200 bp and ${neg(f.eve400)} at +400 bp; wholesale funding is ${p1(f.wholesalePct)} of funding against ${FUNDING_POLICY.wholesaleMaxPct}%, and available funding ${p1(f.availablePct)} of deposits.`,
      dear.option.key !== pick.option.key ? `${dear.option.name} costs ${mm2(dear.figures.cost - f.cost)} a year more${dear.figures.cannibalized ? `, because the special also reprices about ${mm(dear.figures.cannibalized)} of the bank’s own balances` : ''}.` : '',
      -t.eve[400] > t.eve.limit400 ? `EVE at +400 bp is over its limit before any funding (${neg(t.eve[400])}); funding can only avoid adding to it; reducing it is a separate decision for ALCO.` : '',
    ];
    return { key: pick.option.key, why: parts.filter(Boolean).join(' ') };
  };

  const rowsFor = (results: Result[]) => {
    const t = model().today;
    const row = (item: string, get: (f: FundingFigures) => string, now = '') => ({ item, now, ...Object.fromEntries(results.map((r) => [r.option.key, get(r.figures)])) });
    const mix = (f: FundingFigures) => [f.levers.deposits ? `${mm(f.levers.deposits)} ${f.levers.depositTermMonths ? `${years(f.levers.depositTermMonths)} certificate special` : 'money market special'}` : '', f.levers.fhlb ? `${mm(f.levers.fhlb)} FHLB, ${years(f.levers.fhlbTermMonths)}` : '', f.levers.brokered ? `${mm(f.levers.brokered)} brokered, ${years(f.levers.brokeredTermMonths)}` : ''].filter(Boolean).join('; ');
    return [
      row('Funding', mix, `${mm(t.growth)} of loan growth`),
      row('All-in cost', (f) => p2(f.allIn * 100)),
      row('Cost a year', (f) => mm2(f.cost)),
      row('Existing balances repriced (cost)', (f) => (f.cannibalized ? `${mm(f.cannibalized)} (${mm2(f.cannibalCost)})` : 'None')),
      row('EPS effect, after tax', (f) => usd(f.epsImpact)),
      row(`EVE at +200 bp (limit −${t.eve.limit200}%)`, (f) => neg(f.eve200), neg(t.eve[200])),
      row(`EVE at +400 bp (limit −${t.eve.limit400}%)`, (f) => neg(f.eve400), neg(t.eve[400])),
      row(`NII at +200 bp (limit −${t.nii200Limit}%)`, (f) => neg(f.nii200), neg(t.nii200)),
      row(`Wholesale funding (limit ${FUNDING_POLICY.wholesaleMaxPct}%)`, (f) => p1(f.wholesalePct), p1(t.wholesalePct)),
      row(`Brokered to deposits (limit ${FUNDING_POLICY.brokeredMaxPct}%)`, (f) => p1(f.brokeredPct), p1((t.brokered / t.deposits) * 100)),
      row(`FHLB line in use (keep ${FUNDING_POLICY.fhlbReservePct}% free)`, (f) => p1(f.fhlbUsedPct), p1((t.fhlbUsed / t.fhlbLine) * 100)),
      row(`Available funding to deposits (minimum ${t.availableMin}%)`, (f) => p1(f.availablePct), p1(t.availablePct)),
      row('Limits', (f) => {
        const own = f.checks.filter((c) => (c.status === 'breach' && (!c.today || c.worseThanToday)) || c.status === 'thin');
        const b = own.filter((c) => c.status === 'breach').length;
        return b ? `${b} breach${b === 1 ? '' : 'es'}` : own.length ? `${own.length} thin` : 'Clear';
      }),
    ];
  };

  return {
    agent: FUNDING_CHOICE_AGENT,
    title: 'Funding next year’s loan growth',
    planText: 'Here’s how I’ll work: the rate-risk, liquidity, funding-risk and deposit-pricing specialists report their limits at the same time; I fund the same loan growth three ways (a deposit special, FHLB advances and brokered CDs) and DI computes the cost, the rate risk and the liquidity of each; the chief risk officer challenges them; then I recommend one and draft the ALCO memo for your approval.',
    specialists,
    options,
    evaluate: (l) => model().evaluate(l),
    critique,
    stands: () => null,
    revise,
    nouns: NOUN,
    order: ['wholesale', 'brokered', 'fhlb_reserve', 'contingent', 'eve400', 'eve200', 'nii200'],
    recommend,
    blocks: (results, runId) => {
      const t = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
      const rows = rowsFor(results);
      return [{ id: newBlockId('fnd'), type: 'table', version: '1.0.0', title: 'Three ways to fund next year’s loan growth', subtitle: `The same ${mm(model().today.growth)} of loans in every column, at the capital plan’s ${model().today.growthPct}% pace.`, provenance: { agent: FUNDING_CHOICE_AGENT, runId, operations: ['funding.plans'], sources: SOURCES }, freshness: { kind: 'workflow_event' }, data: { columns: [t('item', ''), t('now', 'Today'), ...results.map((r) => t(r.option.key, r.option.name))], rows, rowCount: rows.length } } as Block];
    },
    memo: (chosen, why, results, replies) => ({
      tool: 'fund_memo',
      args: { recommended: chosen.option.key, plans: results.map((r) => ({ key: r.option.key, name: r.option.name, levers: r.option.levers })), why, settled: settled(results, replies) },
    }),
    corpus: (results) => {
      const out = rowsFor(results).flatMap((r) => Object.values(r));
      for (const r of results) out.push(mm2(r.figures.cost), p2(r.figures.allIn * 100), p2(r.figures.fhlbRate * 100), ...r.figures.checks.map((c) => describe(c, r.figures)));
      for (const r of results) out.push(p2(r.figures.depositRate * 100), p2(r.figures.brokeredRate * 100));
      out.push(p2(FUNDING_RATES.depositSpecial * 100), '+200', '+400', '200 bp', '400 bp');
      return out;
    },
    facts: (results) =>
      rowsFor(results)
        .map((r) => `${r.item}: today ${r.now || 'n/a'}; ${results.map((x) => `${x.option.name} ${(r as Record<string, string>)[x.option.key]}`).join('; ')}`)
        .join('\n'),
    summary: (f) => `${f.binding}: ${f.current} against ${f.limit}; ${f.headroom}`,
    suggestions: ['Should we sell our low-yield securities at a loss?', 'What’s our deposit beta?'],
    model,
  };
}

const settled = (results: { option: { key: string; name: string } }[], replies: Reply[]) => replies.map((r) => `${results.find((x) => x.option.key === r.option)?.option.name ?? r.option}, round ${r.round}: ${r.action === 'revise' ? 'revised' : 'stands'}. ${r.text}`).slice(0, 12);

const Levers = z.object({ deposits: z.number().min(0).max(1e10), depositTermMonths: z.union([z.literal(0), z.literal(24), z.literal(36)]), fhlb: z.number().min(0).max(1e10), fhlbTermMonths: z.union([z.literal(12), z.literal(24), z.literal(36), z.literal(60)]), brokered: z.number().min(0).max(1e10), brokeredTermMonths: z.union([z.literal(12), z.literal(36), z.literal(60)]) });
const MemoInput = z.object({ recommended: z.string().max(40), plans: z.array(z.object({ key: z.string().max(40), name: z.string().max(60), levers: Levers })).min(1).max(4), why: z.string().max(1500), settled: z.array(z.string().max(500)).max(12) });

export function fundingMemo(m: FundingModel, input: z.infer<typeof MemoInput>, from: { name: string; title: string }) {
  const t = m.today;
  const plans = input.plans.map((p) => ({ ...p, f: m.evaluate(m.levers(p.levers)) }));
  const rec = plans.find((p) => p.key === input.recommended) ?? plans[0]!;
  const f = rec.f;
  const line = (label: string, get: (x: FundingFigures) => string) => `- ${label}: ${plans.map((p) => `${p.name} ${get(p.f)}`).join('; ')}`;
  const sources = [f.levers.deposits ? `${mm(f.levers.deposits)} from a ${f.levers.depositTermMonths ? `${years(f.levers.depositTermMonths)} certificate` : 'money market'} special at ${p2(f.depositRate * 100)}` : '', f.levers.fhlb ? `${mm(f.levers.fhlb)} of ${years(f.levers.fhlbTermMonths)} FHLB advances at ${p2(f.fhlbRate * 100)}` : '', f.levers.brokered ? `${mm(f.levers.brokered)} of ${years(f.levers.brokeredTermMonths)} brokered CDs at ${p2(f.brokeredRate * 100)}` : ''].filter(Boolean).join(', ');
  const body = [
    'To: ALCO; Board of Directors',
    `From: ${from.name}, ${from.title}`,
    `Re: Funding ${mm(t.growth)} of loan growth next year`,
    '',
    `Recommendation: ${lower(rec.name)}: ${sources}.`,
    '',
    `Why: ${input.why}`,
    '',
    'By choice:',
    line('All-in cost', (x) => p2(x.allIn * 100)),
    line('Cost a year', (x) => mm2(x.cost)),
    line(`EVE at +200 bp (limit −${t.eve.limit200}%)`, (x) => neg(x.eve200)),
    line(`EVE at +400 bp (limit −${t.eve.limit400}%)`, (x) => neg(x.eve400)),
    line(`Wholesale funding (limit ${FUNDING_POLICY.wholesaleMaxPct}%)`, (x) => p1(x.wholesalePct)),
    line(`Available funding to deposits (minimum ${t.availableMin}%)`, (x) => p1(x.availablePct)),
    '',
    'The chief risk officer’s challenges, and how they were settled:',
    ...(input.settled.length ? input.settled.map((s) => `- ${s}`) : ['- None.']),
    '',
    'Asked of ALCO: approve the funding plan.',
    `Figures are DI’s estimates from the ${t.quarter} Call Report and core data; new-money rates are stated assumptions.`,
  ].join('\n');
  return { rec, memo: { to: ['ALCO', 'Board of Directors'], subject: `Funding next year’s loan growth: ${lower(rec.name)} recommended`, body: body.slice(0, 4000) } };
}

export function fundingChoiceModule(deps: { pool: Pool; files?: FileStore | null; today?: () => string }): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes(MODULE)) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: MODULE,
    prefix: 'funding',
    agent: FUNDING_CHOICE_AGENT,
    request: FUNDING_CHOICE_REQUEST,
    noAccess: NO_ACCESS,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You weigh how ${tenant} funds its growth. You are working with ${user}, ${title}.`,
    plan: () => ({ say: 'Ask me how to fund next year’s loan growth.' }),
    run: (input, d, sink) => runDecision(spec, fundingCase(deps.pool), input, d, sink),
    tools: [
      {
        name: 'fund_memo',
        description: 'Draft the ALCO memo on funding next year’s loan growth. Sending it needs approval.',
        input: MemoInput,
        run: async (args: z.infer<typeof MemoInput>, ctx) => {
          need(ctx);
          const m = await new FundingChoiceService(deps.pool).model();
          if (!m) throw new CoreError('NOT_FOUND', 'There are no funding figures yet.');
          const { rec, memo } = fundingMemo(m, args, { name: ctx.user.name, title: 'Chief Financial Officer' });
          const f = rec.f;
          return {
            change: {
              summary: `Send ALCO the funding memo: ${lower(rec.name)}`,
              changes: [
                { label: 'Deposit special', before: 'None', after: f.levers.deposits ? mm(f.levers.deposits) : 'None' },
                { label: 'FHLB advances', before: mm(m.today.fhlbUsed), after: f.levers.fhlb ? `${mm(m.today.fhlbUsed + f.levers.fhlb)} (${years(f.levers.fhlbTermMonths)} for the new ${mm(f.levers.fhlb)})` : mm(m.today.fhlbUsed) },
                { label: 'Brokered deposits', before: mm(m.today.brokered), after: mm(m.today.brokered + f.levers.brokered) },
                { label: 'Goes to', before: '—', after: `ALCO and the board, in ${BOARD_FOLDER}` },
              ],
              text: `I’ve drafted the ALCO memo for ${lower(rec.name)}.`,
              done: `Sent. The memo is in ${BOARD_FOLDER}. Nothing has been borrowed or priced; ALCO approves the plan first.`,
              risk: 'high',
              apply: { memo, plan: rec.key },
            },
          };
        },
        apply: async (a: { memo: { subject: string; body: string } }, meta, ctx) => {
          need(ctx);
          if (!deps.files) return;
          const on = deps.today?.() ?? new Date().toISOString().slice(0, 10);
          const staged = await deps.files.stage({ name: `${a.memo.subject.replace(/[:/\\’]/g, ' -').slice(0, 80)}.txt`, body: Buffer.from(`${a.memo.subject}\n\n${a.memo.body}\n`, 'utf8'), owner: { userId: ctx.user.id, name: ctx.user.name }, on });
          await deps.files.save({ fileId: staged.fileId, folder: BOARD_FOLDER }, { approvalId: meta.approvalId, on });
        },
      },
    ],
  };
  return spec;
}
