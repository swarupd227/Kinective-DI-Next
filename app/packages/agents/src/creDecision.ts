// "Respond to the exam finding on CRE" on the decision framework. DI holds no copy of the examination report,
// so the response addresses CRE concentration risk management under the interagency guidance and says so.
// Concentration, stress, capital and CECL specialists report their limits; the planner sets three responses
// side by side (strengthen oversight with growth held, let office maturities run off, sell office
// participations), CapitalActionsModel computes each, the chief risk officer challenges them as an examiner
// would read them, and the response goes to the board behind an approval card.
import { z } from 'zod';
import type { Block } from '@dinext/block-schemas';
import { CapitalActionsService, ConcentrationService, CoreError, LOAN_KEYS, type CapitalActionsModel, type CapitalLevers, type FileStore, type LoanKey, type PlanFigures } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { newBlockId } from './answer.ts';
import { capitalSpecialists, describe, down1m, mixOf, mm, mm2, p1, p2, signed, up100k, usd, MIX, SOURCES } from './capitalDecision.ts';
import { runDecision, type Challenge, type DecisionCase, type DecisionOption, type Evaluated } from './decision.ts';
import type { ModuleContext, ModuleSpec } from './moduleAgent.ts';

export const CRE_RESPONSE_REQUEST = /\b(?:respond|response|reply|answer|address|remediat\w*|corrective action)\b[^.?!]{0,50}\b(?:exam(?:ination|iner'?s?)?|regulator'?s?|MRA|matters? requiring attention)\b[^.?!]{0,40}\b(?:finding|criticism|MRA|CRE|concentration)|\b(?:exam(?:ination)?|MRA) finding\b[^.?!]{0,30}\b(?:on|about|for) (?:our )?(?:CRE|commercial real estate|concentration)/i;
export const CRE_RESPONSE_AGENT = 'CRE Exam Response';
const MODULE = 'capactions';
const NO_ACCESS = 'Exam responses on capital and concentration aren’t part of your DI access. They are for a bank’s finance leaders.';
const BOARD_FOLDER = 'Board Packs';
/** The office sub-limit the response commits to, below the 50% policy limit: an examiner wants a cushion. */
export const OFFICE_SUBLIMIT = 45;
/** An office stress loss above this share of capital is one an examiner will ask the board to reduce. */
export const OFFICE_STRESS_MAX = 5;

type Option = DecisionOption<CapitalLevers>;
type Result = Evaluated<CapitalLevers, PlanFigures>;

export function creCase(pool: Pool): DecisionCase<CapitalLevers, PlanFigures> & { model: () => CapitalActionsModel } {
  let m: CapitalActionsModel | null = null;
  let office = { loans: 0, balance: 0, shortfall: 0, fall: 35, thinDscr: 0, maturing: 0, maturingLoans: 0, maturingThin: 0 };
  const model = () => {
    if (!m) throw new Error('The capital model is not loaded');
    return m;
  };
  const all = capitalSpecialists(pool);
  const specialists = ['concentration', 'stress', 'capital', 'cecl'].map((id) => all.find((s) => s.id === id)!);
  /** The office stress shortfall moves with the office book; against tier 1 plus the allowance a year ahead. */
  const officeStress = (f: PlanFigures) => {
    const after = office.balance + f.levers.growth.office;
    const shortfall = office.balance ? office.shortfall * (after / office.balance) : 0;
    const capital = (after / f.officePct) * 100;
    return { shortfall, pctOfCapital: capital ? (shortfall / capital) * 100 : 0 };
  };

  const critique = (o: Option, f: PlanFigures): Challenge[] => {
    const out: Challenge[] = f.checks
      .filter((c) => c.id !== 'office' && c.id !== 'eve400' && (c.status === 'breach' || (c.status === 'thin' && c.id !== 'allowance')))
      .map((c) => ({ option: o.key, check: c.id, severity: c.status === 'breach' ? ('breach' as const) : ('thin' as const), text: describe(c, f, model().today) }));
    // An examiner reads office within a few points of its limit as no cushion at all.
    if (f.officePct > 50) out.unshift({ option: o.key, check: 'office', severity: 'breach', text: `Office CRE reaches ${p1(f.officePct)} of capital, over the 50% limit the finding is about.` });
    else if (f.officePct >= OFFICE_SUBLIMIT - 1) out.unshift({ option: o.key, check: 'office', severity: 'thin', text: `Office CRE ends at ${p1(f.officePct)} of capital, within a point of the ${OFFICE_SUBLIMIT}% sub-limit we would commit to: earnings, not the response, do the work, and one weak year undoes it.` });
    const s = officeStress(f);
    if (s.pctOfCapital >= OFFICE_STRESS_MAX) out.push({ option: o.key, check: 'office_stress', severity: 'thin', text: `A ${office.fall}% fall in office values would still leave ${mm(s.shortfall)} short, ${p1(s.pctOfCapital)} of capital. Tighter controls don’t change the exposure the examiner is pointing at.` });
    return out;
  };

  const options = async (): Promise<Option[]> => {
    const [mdl, conc] = await Promise.all([new CapitalActionsService(pool).model(), new ConcentrationService(pool).analysis()]);
    if (!mdl || !conc) throw new Error('No concentration figures');
    m = mdl;
    const p = conc.property.find((x) => x.type === 'Office');
    const y1 = conc.officeMaturities[0];
    office = { loans: p?.loans ?? 0, balance: p?.balance ?? 0, shortfall: p?.stressShortfall ?? 0, fall: p?.stressFallPct ?? 35, thinDscr: p?.thinDscr ?? 0, maturing: y1?.balance ?? 0, maturingLoans: y1?.loans ?? 0, maturingThin: y1?.thinDscr ?? 0 };
    const t = mdl.today;
    const loans = Object.entries(t.loanBalance).filter(([k]) => ['First mortgages', 'Commercial loans', 'Consumer loans', 'Commercial real estate', 'Auto loans'].includes(k)).reduce((s, [, v]) => s + v, 0);
    const total = down1m(loans * (t.cap.settings.rwaGrowth / 100));
    const topUp = up100k(Math.max(0, t.ceclGap));
    // Growth at plan; the CRE share goes to C&I and mortgages where a response holds CRE flat.
    const atPlan = mixOf(total, MIX.balanced);
    const creFlat: Record<LoanKey, number> = { ...atPlan, multifamily: 0, other_cre: 0, ci: atPlan.ci + Math.round((atPlan.multifamily + atPlan.other_cre) / 2 / 1e5) * 1e5, mortgage: atPlan.mortgage + Math.round((atPlan.multifamily + atPlan.other_cre) / 2 / 1e5) * 1e5 };
    const base = (growth: Record<LoanKey, number>) => ({ ...mdl.levers({ allowanceTopUp: topUp }), growth });
    // Sell participations in the loans that cover their debt service less than 1.15 times, up to bringing office to 30% of capital.
    let sale = Math.floor(office.thinDscr / 1e6) * 1e6;
    for (let x = 1e6; x <= office.balance; x += 1e6) {
      if (mdl.evaluate(base({ ...creFlat, office: -(office.maturing + x) })).officePct <= 30) {
        sale = Math.min(sale, x);
        sale = x;
        break;
      }
    }
    return [
      { key: 'oversight', name: 'Strengthen oversight', stance: 'Tighten limits, stress testing and reporting; keep CRE growth at plan and renew office as it matures.', levers: base(atPlan) },
      { key: 'runoff', name: 'Let office run off', stance: `Hold CRE flat and don’t renew the ${mm(office.maturing)} of office maturing in the next year.`, levers: base({ ...creFlat, office: -office.maturing }) },
      { key: 'sell', name: 'Sell office participations', stance: 'Run off the maturities and sell participations in the weakest office loans.', levers: base({ ...creFlat, office: -(office.maturing + sale) }) },
    ];
  };

  const revise = (o: Option, ch: Challenge): { levers: CapitalLevers; text: string } | null => {
    const mdl = model();
    const l = o.levers;
    if (ch.check !== 'office' && ch.check !== 'office_stress') return null;
    // Let office maturities run off, a million at a time, until both the sub-limit and the stress loss hold.
    for (let x = 1e6; x <= office.balance; x += 1e6) {
      const next = { ...l, growth: { ...l.growth, office: l.growth.office - x } };
      const f = mdl.evaluate(next);
      const st = officeStress(f);
      if (f.officePct < OFFICE_SUBLIMIT - 1 && st.pctOfCapital < OFFICE_STRESS_MAX) return { levers: next, text: `Don’t renew ${mm(x)} of the office loans maturing in the next year, starting with the weakest; office CRE ends at ${p1(f.officePct)} of capital and the office stress loss at ${p1(st.pctOfCapital)} of capital, and the oversight commitments stand.` };
    }
    return null;
  };

  const recommend = (results: Result[]) => {
    const issues = (r: Result) => critique(r.option, r.figures);
    const clear = results.filter((r) => !issues(r).some((x) => x.severity === 'breach'));
    // The smallest change that meets the sub-limit: the least income given up for the same answer to the examiner.
    const pick = [...(clear.length ? clear : results)].sort((a, b) => issues(a).length - issues(b).length || b.figures.epsRun - a.figures.epsRun)[0]!;
    const f = pick.figures;
    const s = officeStress(f);
    const most = results.reduce((x, y) => (y.figures.officePct < x.figures.officePct ? y : x));
    const parts = [
      `It brings office CRE from ${p1(model().today.officePct)} to ${p1(f.officePct)} of capital, under the ${OFFICE_SUBLIMIT}% sub-limit we commit to, and non-owner-occupied CRE to ${Math.round(f.crePct)}% against the 300% guidance.`,
      `A ${office.fall}% fall in office values would leave ${mm(s.shortfall)} short, ${p1(s.pctOfCapital)} of capital. Run-rate EPS is ${usd(f.epsRun)} (${signed(f.epsChangePct)}) and leverage ${p2(f.levPct)} against its ${p2(f.levFloor)} floor.`,
      most.option.key !== pick.option.key ? `${most.option.name} cuts office further, to ${p1(most.figures.officePct)}, but gives up ${mm2((f.niRun - most.figures.niRun) / (1 - 0.21))} of interest income a year before tax.` : '',
    ];
    return { key: pick.option.key, why: parts.filter(Boolean).join(' ') };
  };

  const rowsFor = (results: Result[]) => {
    const t = model().today;
    const row = (item: string, get: (f: PlanFigures) => string, now = '') => ({ item, now, ...Object.fromEntries(results.map((r) => [r.option.key, get(r.figures)])) });
    const cre = (f: PlanFigures) => f.levers.growth.multifamily + f.levers.growth.other_cre;
    return [
      row('Office CRE change', (f) => (f.levers.growth.office ? mm(f.levers.growth.office) : 'Held flat'), mm(office.balance)),
      row('Other CRE growth', (f) => (cre(f) ? mm(cre(f)) : 'None')),
      row(`Office CRE to capital (limit 50%, sub-limit ${OFFICE_SUBLIMIT}%)`, (f) => p1(f.officePct), p1(t.officePct)),
      row('Non-owner-occupied CRE to capital (guidance 300%)', (f) => `${Math.round(f.crePct)}%`, `${Math.round(t.crePct)}%`),
      row(`Office shortfall if values fall ${office.fall}%`, (f) => `${mm(officeStress(f).shortfall)} (${p1(officeStress(f).pctOfCapital)} of capital)`, `${mm(office.shortfall)}`),
      row('Leverage ratio a year ahead (floor)', (f) => `${p2(f.levPct)} (${p2(f.levFloor)})`, `${p2(t.cap.now.levPct)} (${p2(t.cap.floors.leverage)})`),
      row('Leverage after severe stress', (f) => p2(f.levStressed), p2(t.cap.stress.levLow)),
      row('EPS run rate', (f) => `${usd(f.epsRun)} (${signed(f.epsChangePct)})`, usd(t.eps)),
      row('Allowance against the CECL estimate', (f) => p1(f.ceclBookedPct), p1(t.ceclBookedPct)),
      row('Limits', (f) => {
        const own = critique({ key: '', name: '', stance: '', levers: f.levers }, f);
        const b = own.filter((c) => c.severity === 'breach').length;
        return b ? `${b} breach${b === 1 ? '' : 'es'}` : own.length ? `${own.length} thin` : 'Clear';
      }),
    ];
  };

  return {
    agent: CRE_RESPONSE_AGENT,
    title: 'Responding to the exam finding on CRE',
    planText: `DI has no copy of the examination report, so I’ll treat the finding as one on commercial real estate concentration risk management under the interagency guidance; add the examiner’s wording before this goes out. The concentration, stress, capital and CECL specialists report their limits at the same time; I set three responses side by side (strengthen oversight, let office run off, sell office participations) with DI computing each a year ahead; the chief risk officer reads them as the examiner would; then I recommend one and draft the board’s response for your approval.`,
    specialists,
    options,
    evaluate: (l) => model().evaluate(l),
    critique,
    stands: () => null,
    revise,
    nouns: { office: 'office concentration', office_stress: 'the office stress loss', leverage: 'the leverage floor', cet1: 'the CET1 floor', eve200: 'EVE at +200 bp', liquidity: 'liquidity', multifamily: 'multifamily concentration', cre: 'CRE concentration' },
    order: ['office', 'office_stress', 'multifamily', 'cre', 'liquidity', 'cet1', 'leverage', 'eve200'],
    recommend,
    blocks: (results, runId) => {
      const t = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
      const rows = rowsFor(results);
      return [{ id: newBlockId('cre'), type: 'table', version: '1.0.0', title: 'Three responses to the CRE finding', subtitle: `${office.loans} office loans, ${mm(office.balance)}; ${mm(office.thinDscr)} of them cover debt service less than 1.15 times; ${mm(office.maturing)} matures in the next year, ${mm(office.maturingThin)} of it under 1.15 times.`, provenance: { agent: CRE_RESPONSE_AGENT, runId, operations: ['cre.plans'], sources: SOURCES }, freshness: { kind: 'workflow_event' }, data: { columns: [t('item', ''), t('now', 'Today'), ...results.map((r) => t(r.option.key, r.option.name))], rows, rowCount: rows.length } } as Block];
    },
    memo: (chosen, why, results, replies) => ({
      tool: 'cre_memo',
      args: { recommended: chosen.option.key, plans: results.map((r) => ({ key: r.option.key, name: r.option.name, levers: r.option.levers })), why, settled: replies.map((r) => `${results.find((x) => x.option.key === r.option)?.option.name ?? r.option}, round ${r.round}: ${r.action === 'revise' ? 'revised' : 'stands'}. ${r.text}`).slice(0, 12) },
    }),
    corpus: (results) => {
      const out = rowsFor(results).flatMap((r) => Object.values(r));
      for (const r of results) out.push(...critique(r.option, r.figures).map((c) => c.text), mm(officeStress(r.figures).shortfall), mm2(r.figures.niRun), mm(-r.figures.levers.growth.office));
      out.push(mm(office.maturing), mm(office.thinDscr), String(office.loans), `${OFFICE_SUBLIMIT}%`, `${OFFICE_STRESS_MAX}%`, `${office.fall}%`, '1.15');
      return out;
    },
    facts: (results) =>
      rowsFor(results)
        .map((r) => `${r.item}: today ${r.now || 'n/a'}; ${results.map((x) => `${x.option.name} ${(r as Record<string, string>)[x.option.key]}`).join('; ')}`)
        .join('\n'),
    summary: (f) => `${f.binding}: ${f.current} against ${f.limit}; ${f.headroom}`,
    suggestions: ['Show our CRE concentration', 'Plan our capital actions for next year'],
    model,
  };
}

const MemoInput = z.object({
  recommended: z.string().max(40),
  plans: z.array(z.object({ key: z.string().max(40), name: z.string().max(60), levers: z.object({ dividendPerShareQ: z.number().min(0).max(5), buyback: z.number().min(0).max(1e9), growth: z.object(Object.fromEntries(LOAN_KEYS.map((k) => [k, z.number().min(-1e9).max(1e9)])) as Record<LoanKey, z.ZodNumber>), allowanceTopUp: z.number().min(0).max(1e9), afsSale: z.number().min(0).max(1e10) }) })).min(1).max(4),
  why: z.string().max(1500),
  settled: z.array(z.string().max(500)).max(12),
});

export async function creMemo(pool: Pool, m: CapitalActionsModel, input: z.infer<typeof MemoInput>, from: { name: string; title: string }) {
  const conc = (await new ConcentrationService(pool).analysis())!;
  const p = conc.property.find((x) => x.type === 'Office');
  const y1 = conc.officeMaturities[0];
  const plans = input.plans.map((x) => ({ ...x, f: m.evaluate(x.levers) }));
  const rec = plans.find((x) => x.key === input.recommended) ?? plans[0]!;
  const f = rec.f;
  const runoff = Math.max(0, -f.levers.growth.office);
  const line = (label: string, get: (x: PlanFigures) => string) => `- ${label}: ${plans.map((x) => `${x.name} ${get(x.f)}`).join('; ')}`;
  const body = [
    'To: Board of Directors',
    `From: ${from.name}, ${from.title}`,
    'Re: Response to the examination finding on commercial real estate concentration',
    '',
    'The finding: [add the examiner’s wording]. DI has no copy of the report; this response addresses CRE concentration risk management under the interagency guidance.',
    '',
    `Recommendation: ${rec.name}.`,
    'Commitments:',
    `1. A board-approved office sub-limit of ${OFFICE_SUBLIMIT}% of tier 1 capital plus the allowance, under the 50% limit; office is ${p1(m.today.officePct)} today and ${p1(f.officePct)} a year from now under this plan.`,
    `2. A quarterly CRE stress test reported to the board: today a ${p?.stressFallPct ?? 35}% fall in office values leaves ${mm(p?.stressShortfall ?? 0)} short across ${p?.stressLoans ?? 0} loans.`,
    `3. An office maturity watch list: ${y1?.loans ?? 0} loans, ${mm(y1?.balance ?? 0)}, mature in the next year, ${mm(y1?.thinDscr ?? 0)} of them covering debt service less than 1.15 times.`,
    runoff ? `4. Office reduced by ${mm(runoff)}${runoff > (y1?.balance ?? 0) ? ', partly by selling participations' : ' by not renewing maturing loans'}; CRE growth ${f.levers.growth.multifamily + f.levers.growth.other_cre ? `held to ${mm(f.levers.growth.multifamily + f.levers.growth.other_cre)}` : 'held flat'}.` : `4. CRE growth held to ${mm(f.levers.growth.multifamily + f.levers.growth.other_cre)}, with no new office lending.`,
    f.levers.allowanceTopUp ? `5. An allowance top-up of ${mm(f.levers.allowanceTopUp)}, to DI’s CECL estimate.` : '',
    '',
    `Why: ${input.why}`,
    '',
    'A year ahead, by response:',
    line('Office CRE to capital', (x) => p1(x.officePct)),
    line('Non-owner-occupied CRE to capital', (x) => `${Math.round(x.crePct)}%`),
    line('Leverage ratio (floor)', (x) => `${p2(x.levPct)} (${p2(x.levFloor)})`),
    line('Run-rate EPS', (x) => `${usd(x.epsRun)} (${signed(x.epsChangePct)})`),
    '',
    'The chief risk officer’s challenges, and how they were settled:',
    ...(input.settled.length ? input.settled.map((s) => `- ${s}`) : ['- None.']),
    '',
    'Asked of the board: approve the response and the sub-limit before it goes to the examiner.',
    `Figures are DI’s estimates from the ${m.today.quarter} Call Report and loan data, not the models of record.`,
  ]
    .filter((x, i, a) => x !== '' || a[i - 1] !== '')
    .join('\n');
  return { rec, memo: { to: ['Board of Directors'], subject: 'Response to the examination finding on CRE concentration', body: body.slice(0, 4000) } };
}

export function creResponseModule(deps: { pool: Pool; files?: FileStore | null; today?: () => string }): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes(MODULE)) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: MODULE,
    prefix: 'creexam',
    agent: CRE_RESPONSE_AGENT,
    request: CRE_RESPONSE_REQUEST,
    noAccess: NO_ACCESS,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You draft ${tenant}'s response to an exam finding. You are working with ${user}, ${title}.`,
    plan: () => ({ say: 'Ask me to respond to the exam finding on CRE.' }),
    run: (input, d, sink) => runDecision(spec, creCase(deps.pool), input, d, sink),
    tools: [
      {
        name: 'cre_memo',
        description: 'Draft the board’s response to the exam finding on CRE concentration. Sending it needs approval.',
        input: MemoInput,
        run: async (args: z.infer<typeof MemoInput>, ctx) => {
          need(ctx);
          const m = await new CapitalActionsService(deps.pool).model();
          if (!m) throw new CoreError('NOT_FOUND', 'There are no concentration figures yet.');
          const { rec, memo } = await creMemo(deps.pool, m, args, { name: ctx.user.name, title: 'Chief Financial Officer' });
          return {
            change: {
              summary: `Send the board the response to the CRE finding: ${rec.name}`,
              changes: [
                { label: 'Office sub-limit', before: '50% limit only', after: `${OFFICE_SUBLIMIT}% sub-limit` },
                { label: 'Office CRE a year ahead', before: p1(m.today.officePct), after: p1(rec.f.officePct) },
                { label: 'Goes to', before: '—', after: `Board of Directors, in ${BOARD_FOLDER}` },
              ],
              text: `I’ve drafted the board’s response on “${rec.name}”. Add the examiner’s wording of the finding before it goes out.`,
              done: `Sent. The response is in ${BOARD_FOLDER} for the board. Nothing goes to the examiner and no limit changes until the board approves it.`,
              risk: 'high',
              apply: { memo, plan: rec.key },
            },
          };
        },
        apply: async (a: { memo: { subject: string; body: string } }, meta, ctx) => {
          need(ctx);
          if (!deps.files) return;
          const on = deps.today?.() ?? new Date().toISOString().slice(0, 10);
          const staged = await deps.files.stage({ name: `${a.memo.subject.slice(0, 80)}.txt`, body: Buffer.from(`${a.memo.subject}\n\n${a.memo.body}\n`, 'utf8'), owner: { userId: ctx.user.id, name: ctx.user.name }, on });
          await deps.files.save({ fileId: staged.fileId, folder: BOARD_FOLDER }, { approvalId: meta.approvalId, on });
        },
      },
    ],
  };
  return spec;
}
