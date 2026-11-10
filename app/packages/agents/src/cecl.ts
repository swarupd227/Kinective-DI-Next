// CECL: a bank CFO's provision for credit losses and the allowance it builds. What was booked and what
// drove it come from the Call Report; DI's own CECL estimate from the loan book is set against the booked
// allowance, with what a change in the economic forecast would cost. The scenario weights and Q-factors
// are the CFO's, and each change is approved.
import { z } from 'zod';
import { CoreError, type CeclService, type CeclWeights } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const CORE = /\bcecl\b|(?<!pre-)(?<!pre )\bprovision(?:s|ing)?\b(?! for income tax)|\bcredit loss (?:expense|provision|model|estimate)s?\b|\b(?:allowance|reserves?|acl|alll)\b[^.?!]*\b(?:enough|adequa\w*|sufficient|light|short|heavy|right|model|estimate|forecast|scenarios?|weights?|drove|driv\w*|moved?|why|rise|rose|grow\w*|build|release|cover (?:lifetime|expected))\b|\b(?:recession|downturn|adverse|severe\w*|forecast|scenarios?)\b[^.?!]*\b(?:allowance|reserves?|acl|alll)\b|\bq[- ]?factors?\b|\bqualitative (?:factors?|adjustments?)\b|\bscenario weights?\b|\breasonable and supportable\b|\bwarm method\b/.source;
/** CECL questions, leaving the allowance by segment to Profitability, charts to Analytics and the stress test to its agent. */
export const CECL_REQUEST = new RegExp(`^(?![\\s\\S]*\\b(?:chart|plot|graph)\\b)(?![\\s\\S]*\\b(?:allowance|reserves?) by (?:segment|pool|loan type|product)\\b)(?![\\s\\S]*\\bwhere is the allowance\\b)(?![\\s\\S]*\\bcecl pools?\\b)(?![\\s\\S]*\\bstress test)[\\s\\S]*?(?:${CORE})`, 'i');

export type CeclQuestion = 'overview' | 'provision' | 'estimate' | 'forecast' | 'assumptions' | 'method';

export function ceclQuestion(text: string): CeclQuestion {
  const t = text.toLowerCase();
  if (/calculat|\bmethod|methodology|worked out|how do(?:es)? (?:you|di) (?:estimate|work|measure)|\bwarm\b/.test(t)) return 'method';
  if (/\bprovision/.test(t) && /\bcecl\b|allowance|reserve|estimate/.test(t)) return 'overview';
  if (/q[- ]?factors?|qualitative|\bweights?\b|assumptions?|who set/.test(t)) return 'assumptions';
  if (/forecast|scenario|recession|downturn|adverse|severe|what if|economy|unemployment/.test(t)) return 'forecast';
  if (/enough|adequa|sufficient|light|short|heavy|right|estimate|\bdi'?s\b|challenge|by loan type|which loans/.test(t)) return 'estimate';
  if (/\bprovision|drove|driv|\bwhy\b|\bmoved?\b|\brose\b|\brise\b|went up/.test(t) && !/\bcecl\b/.test(t)) return 'provision';
  return 'overview';
}

const LOAN_TYPES: [RegExp, string][] = [
  [/\bcre\b|commercial real estate/i, 'Commercial Real Estate'],
  [/\bc&i\b|\bc and i\b|commercial (?:and|&) industrial|commercial loans?\b/i, 'Commercial & Industrial'],
  [/mortgages?|residential/i, 'Mortgage'],
  [/\bauto\b|vehicle/i, 'Auto'],
  [/consumer|personal|unsecured/i, 'Consumer'],
];

/** Scenario weights or a loan type's Q-factor from what the CFO says. */
export function parseCecl(text: string): { baseline?: number; adverse?: number; severe?: number; loanType?: string; bp?: number } | null {
  if (!/\b(?:set|change|move|make|update|put|raise|lower|cut|increase|decrease|use)\b/i.test(text)) return null;
  const out: { baseline?: number; adverse?: number; severe?: number; loanType?: string; bp?: number } = {};
  const w = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const baseline = w(/(\d{1,3})\s*%?\s*(?:to |on |for )?(?:the )?baseline/i) ?? w(/baseline\D{0,12}(\d{1,3})\s*%/i);
  const adverse = w(/(\d{1,3})\s*%?\s*(?:to |on |for )?(?:the )?adverse/i) ?? w(/(?<!severely )adverse\D{0,12}(\d{1,3})\s*%/i);
  const severe = w(/(\d{1,3})\s*%?\s*(?:to |on |for )?(?:the )?(?:severe|severely)/i) ?? w(/severe(?:ly adverse)?\D{0,12}(\d{1,3})\s*%/i);
  if (baseline !== undefined || adverse !== undefined || severe !== undefined) Object.assign(out, baseline !== undefined ? { baseline } : {}, adverse !== undefined ? { adverse } : {}, severe !== undefined ? { severe } : {});
  if (/q[- ]?factor|qualitative/i.test(text)) {
    const type = LOAN_TYPES.find(([re]) => re.test(text));
    const bp = /(-?\d+(?:\.\d+)?)\s*(?:bp|bps|basis points?)\b/i.exec(text);
    if (type) out.loanType = type[1];
    if (bp) out.bp = Number(bp[1]);
  }
  return Object.keys(out).length ? out : null;
}

const NO_ACCESS = 'CECL isn’t part of your DI access. It is for a bank’s finance leaders.';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const mm = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(2)}M`);
const smm = (n: number) => `${n >= 0 ? '+' : '−'}$${(Math.abs(n) / 1e6).toFixed(2)}M`;
const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`);
const p2 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(2)}%`);
const p1 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(1)}%`);
const qLabel = (end: string) => `Q${Math.ceil(Number(end.slice(5, 7)) / 3)} ${end.slice(0, 4)}`;
const short = (c: string) => (c === 'Commercial Real Estate' ? 'CRE' : c === 'Commercial & Industrial' ? 'C&I' : c.toLowerCase());
const weightsText = (w: CeclWeights) => `${w.baseline}% baseline, ${w.adverse}% adverse, ${w.severe}% severely adverse`;

export function ceclModule(svc: CeclService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('cecl')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const sources: ModuleSpec['sources'] = [
    { kind: 'table', label: 'FFIEC 051 Call Report values', ref: 'table:cr_value' },
    { kind: 'table', label: 'Loans, from the core', ref: 'table:cdm_loan' },
    { kind: 'table', label: 'CECL assumptions, as the CFO set them', ref: 'table:fin_cecl' },
  ];
  const spec: ModuleSpec = {
    id: 'cecl',
    prefix: 'cecl',
    agent: 'CECL',
    request: CECL_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the CECL agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) owns the bank's CECL model: the provision for credit losses and the allowance, the forward-looking estimate of lifetime loan losses. The booked provision and allowance come from the Call Report. DI's own CECL estimate, from the loan book by the remaining-life (WARM) method with the CFO's scenario weights and Q-factors, is a second figure to challenge the booked allowance with; it never replaces the bank's model.

- cecl_view, with question overview (general CECL questions and anything about both the provision and the allowance), provision ("what drove the provision?"), estimate ("is our allowance enough?", "DI's CECL estimate"), forecast ("what if the forecast turns to a recession?"), assumptions ("our Q-factors and scenario weights") or method ("how does DI estimate CECL?").
- cecl_set: change the scenario weights (baseline, adverse, severe, in percent, adding to 100) or one loan type's Q-factor in basis points. It needs approval.`,
    plan: (t) => {
      const set = parseCecl(t);
      if (set) return { tool: 'cecl_set', args: set };
      return { tool: 'cecl_view', args: { question: ceclQuestion(t) } };
    },
    tools: [
      {
        name: 'cecl_view',
        description: 'A bank’s provision for credit losses and allowance under CECL: the booked figures by quarter, what drove the provision, DI’s own CECL estimate by loan type against the booked allowance, what a change in the economic forecast would cost (EPS, tangible book value per share, leverage ratio), and the CFO’s scenario weights and Q-factors.',
        input: z.object({ question: z.enum(['overview', 'provision', 'estimate', 'forecast', 'assumptions', 'method']).optional() }).strict(),
        run: async (a: { question?: CeclQuestion }, ctx) => {
          need(ctx);
          if (a.question === 'method') return { text: `How DI estimates CECL:\n\n${svc.assumptions().map(([k, v]) => `- **${k}:** ${v}`).join('\n')}` };
          const f = await svc.analysis();
          if (!f) throw new CoreError('INVALID', 'CECL is built from a bank’s FFIEC Call Report and loan book, and no Call Report is loaded yet.');
          const n = f.now;
          const q = qLabel(f.asOf);
          const e = f.estimate;
          const question = a.question ?? 'overview';
          const parts: Record<string, string> = {};
          const vs = (v: number | null, ref: number | null, who: string) => (v === null || ref === null ? '' : `${v > ref + 0.005 ? 'above' : v < ref - 0.005 ? 'below' : 'on'} ${who} ${p2(ref)}`);
          const provRefs = [vs(f.provisionRatio, f.plan.provisionRatio, 'plan’s'), vs(f.provisionRatio, f.peer.provisionRatio, 'peers’')].filter(Boolean);
          parts.provision = `The provision for credit losses was **${mm(n.provision)}** in ${q} and **${mm(n.provisionYtd)}** so far this year, an annualized **${p2(f.provisionRatio)}** of average loans${provRefs.length ? `, ${provRefs.join(' and ')}` : ''}.${f.provisionEpsQuarter !== null ? ` After tax it took ${usd(f.provisionEpsQuarter)} a share off EPS in the quarter and ${usd(f.provisionEpsYtd)} this year.` : ''}`;
          const w = f.quarterWalk;
          if (w && f.prior) {
            const bits = [`${mm(w.netChargeOffs)} replaced net charge-offs`, `${mm(w.growth)} ${w.growth >= 0 ? 'reserved for' : 'came back from'} ${w.growth >= 0 ? 'loan growth' : 'a smaller book'} (${mm(Math.abs(n.loans - f.prior.loans))} ${n.loans >= f.prior.loans ? 'more' : 'fewer'} loans at last quarter’s ${p2(f.prior.coveragePct)} coverage)`];
            const nonaccrual = n.nonaccrual - f.prior.nonaccrual;
            bits.push(`${mm(Math.abs(w.coverage))} ${w.coverage >= 0 ? 'raised' : 'lowered'} coverage on the whole book from ${p2(f.prior.coveragePct)} to ${p2(n.coveragePct)}${Math.abs(nonaccrual) >= 100_000 ? `, as nonaccrual loans ${nonaccrual >= 0 ? 'rose' : 'fell'} ${mm(Math.abs(nonaccrual))} to ${mm(n.nonaccrual)}` : ''}`);
            parts.walk = `Of ${q}’s provision, ${bits.slice(0, -1).join(', ')} and ${bits.at(-1)}.`;
          }
          parts.allowance = `The allowance is **${mm(n.allowance)}**, ${p2(n.coveragePct)} of ${mm(n.loans)} in loans${f.peer.coverage !== null ? ` (peers ${p2(f.peer.coverage)})` : ''}.`;
          const top = e.pools[0];
          const verdict = f.read === 'short' ? `short by **${mm(f.gap)}**` : f.read === 'light' ? `light by **${mm(f.gap)}**` : f.read === 'heavy' ? `heavy by **${mm(-f.gap)}**, which holds back earnings` : `within ${p1(Math.abs(100 - (f.bookedPct ?? 100)))} of it, about right`;
          parts.estimate = `DI’s CECL estimate is **${mm(e.total)}** (${p2(e.coveragePct)} of loans) under your weights (${weightsText(f.settings.weights)}) and Q-factors, so the booked allowance is ${p1(f.bookedPct)} of it: ${verdict}.${top ? ` ${top.category} carries ${mm(top.estimate)} of the estimate, ${p2(top.coveragePct)} of ${mm(top.balance)}${top.weak ? `, with ${mm(top.weak)} rated substandard` : ''}.` : ''} Your CECL model sets the booked figure; DI’s is a second view to test it against.`;
          const sc = (k: string) => f.scenarios.find((s) => s.key === k)!;
          const adverse = sc('adverse');
          const severe = sc('severe');
          const baseline = sc('baseline');
          const hit = (s: typeof adverse) => `a provision of ${mm(s.provision)} above today’s allowance, ${mm(s.afterTax)} after tax${s.eps !== null ? (usd(s.eps) === usd(s.tbvps) ? `, ${usd(s.eps)} a share off both EPS and tangible book value` : `, ${usd(s.eps)} a share off EPS and ${usd(s.tbvps)} off tangible book value per share`) : ''}${s.leveragePct !== null && f.leveragePct !== null ? `, and the leverage ratio from ${p2(f.leveragePct)} to ${p2(s.leveragePct)}` : ''}`;
          parts.forecastShort = `If the forecast moved all the way to the adverse scenario, DI’s estimate would be ${mm(adverse.estimate)}: ${hit(adverse)}.`;
          parts.forecast = `If the forecast moved all the way to the adverse scenario (unemployment to 7%, commercial property values down 15%), DI’s estimate would be **${mm(adverse.estimate)}** (${p2(adverse.coveragePct)} of loans): ${hit(adverse)}. All severely adverse, it would be **${mm(severe.estimate)}**: ${hit(severe)}. All baseline, it would be ${mm(baseline.estimate)}, ${baseline.provision < 0 ? `${mm(-baseline.provision)} below today’s allowance` : `${mm(baseline.provision)} above it`}. Over the first ${2} years loss rates follow the forecast, then revert to long-run rates.`;
          const qs = Object.entries(f.settings.qFactors).filter(([, v]) => v);
          parts.assumptions = `Your CECL assumptions${f.settings.by ? `, as ${f.settings.by} set them` : ''}: scenario weights of ${weightsText(f.settings.weights)}; Q-factors of ${qs.length ? qs.map(([k, v]) => `${v > 0 ? '+' : ''}${v} bp on ${short(k)}${f.settings.notes[`q:${k}`] ? ` (${f.settings.notes[`q:${k}`]!.charAt(0).toLowerCase()}${f.settings.notes[`q:${k}`]!.slice(1)})` : ''}`).join(' and ') : 'none'}, adding ${mm(e.qualitative)} to the estimate. Change them by telling me, for example “Set scenario weights to 70% baseline, 25% adverse, 5% severe” or “Set the CRE Q-factor to 10 bp”.`;
          parts.src = 'The booked figures are the Call Report’s; DI’s estimate is from the loan book, at DI’s long-run loss rates until the bank’s own loss history is loaded.';
          const order: Record<CeclQuestion, string[]> = {
            overview: ['provision', 'walk', 'allowance', 'estimate', 'forecastShort', 'src'],
            provision: ['provision', 'walk', 'allowance'],
            estimate: ['allowance', 'estimate', 'src'],
            forecast: ['forecast', 'estimate'],
            assumptions: ['assumptions', 'estimate'],
            method: [],
          };
          const reply = order[question].map((k) => parts[k]).filter(Boolean).join(' ');
          const t = (title: string, op: string, cols: ReturnType<typeof text>[], rows: Record<string, string>[]) => moduleTable(spec, title, ctx.runId, op, cols, rows);
          const roll = t('Allowance by quarter', 'cecl.quarters', [text('quarter', 'Quarter'), text('start', 'Allowance at start'), text('nco', 'Net charge-offs'), text('provision', 'Provision'), text('end', 'Allowance at end'), text('loans', 'Loans'), text('coverage', 'Allowance to loans'), text('nonaccrual', 'Nonaccrual loans')], f.quarters.map((r) => ({ quarter: qLabel(r.end), start: mm(r.start), nco: r.chargeOffs !== null && r.recoveries !== null ? mm(-(r.chargeOffs - r.recoveries)) : '—', provision: mm(r.provision), end: mm(r.allowance), loans: mm(r.loans), coverage: p2(r.coveragePct), nonaccrual: mm(r.nonaccrual) })));
          const y = f.ytdWalk;
          const walkTable = t(`What drove the provision, ${q} and this year`, 'cecl.walk', [text('item', ''), text('quarter', q), text('ytd', 'Year to date')], [
            { item: 'Allowance at start', quarter: mm(w?.start), ytd: mm(y.start) },
            { item: 'Net charge-offs', quarter: w ? smm(-w.netChargeOffs) : '—', ytd: smm(-y.netChargeOffs) },
            { item: 'Provision: replacing net charge-offs', quarter: w ? smm(w.netChargeOffs) : '—', ytd: smm(y.netChargeOffs) },
            { item: 'Provision: loan growth at the old coverage', quarter: w ? smm(w.growth) : '—', ytd: smm(y.growth) },
            { item: 'Provision: change in coverage (credit quality, forecast)', quarter: w ? smm(w.coverage) : '—', ytd: smm(y.coverage) },
            { item: 'Provision', quarter: mm(w?.provision), ytd: mm(y.provision) },
            { item: 'Allowance at end', quarter: mm(n.allowance), ytd: mm(n.allowance) },
          ]);
          const est = t('DI’s CECL estimate by loan type', 'cecl.estimate', [text('type', 'Loan type'), text('balance', 'Balance'), text('hist', 'Long-run loss rate a year'), text('fc', 'Forecast-period rate a year'), text('life', 'Remaining life'), text('q', 'Q-factor'), text('estimate', 'Estimate'), text('coverage', 'Of balance')], [
            ...e.pools.map((p) => ({ type: p.category, balance: mm(p.balance), hist: p2(p.histPct), fc: p2(p.forecastPct), life: `${p.life} years`, q: p.qBp ? `${p.qBp > 0 ? '+' : ''}${p.qBp} bp` : '—', estimate: mm(p.estimate), coverage: p2(p.coveragePct) })),
            { type: 'DI’s estimate', balance: mm(e.balance), hist: '', fc: '', life: '', q: mm(e.qualitative), estimate: mm(e.total), coverage: p2(e.coveragePct) },
            { type: 'Booked allowance (Call Report)', balance: mm(n.loans), hist: '', fc: '', life: '', q: '', estimate: mm(n.allowance), coverage: p2(n.coveragePct) },
            { type: f.gap >= 0 ? 'Booked below DI’s estimate by' : 'Booked above DI’s estimate by', balance: '', hist: '', fc: '', life: '', q: '', estimate: mm(Math.abs(f.gap)), coverage: `${p1(f.bookedPct)} of estimate` },
          ]);
          const scen = t('If the economic forecast changes', 'cecl.forecast', [text('mix', 'Forecast'), text('estimate', 'DI’s estimate'), text('coverage', 'Of loans'), text('provision', 'Provision against today’s allowance'), text('afterTax', 'After tax'), text('eps', 'A share'), text('lev', 'Leverage ratio')], f.scenarios.map((s) => ({ mix: s.label, estimate: mm(s.estimate), coverage: p2(s.coveragePct), provision: smm(s.provision), afterTax: smm(-s.afterTax), eps: s.eps === null ? '—' : `${s.eps > 0 ? '−' : '+'}${usd(Math.abs(s.eps))}`, lev: p2(s.leveragePct) })));
          const assume = t('Your CECL assumptions', 'cecl.assumptions', [text('setting', 'Assumption'), text('value', 'Value'), text('why', 'Why')], [
            ...(['baseline', 'adverse', 'severe'] as const).map((k) => ({ setting: `Weight on the ${k === 'severe' ? 'severely adverse' : k} scenario`, value: `${f.settings.weights[k]}%`, why: f.settings.notes[`weight:${k}`] ?? '' })),
            ...e.pools.map((p) => ({ setting: `Q-factor, ${p.category}`, value: p.qBp ? `${p.qBp > 0 ? '+' : ''}${p.qBp} bp (${mm(p.qualitative)})` : 'None', why: f.settings.notes[`q:${p.category}`] ?? '' })),
          ]);
          const blocksFor: Record<CeclQuestion, ReturnType<typeof t>[]> = {
            overview: [walkTable, est, scen, roll],
            provision: [walkTable, roll],
            estimate: [est, roll],
            forecast: [scen, est],
            assumptions: [assume, est],
            method: [],
          };
          const suggest = ['What drove our provision this quarter?', 'Is our allowance enough?', 'What would a recession do to our CECL allowance?', 'What are our CECL Q-factors and scenario weights?', 'How does DI estimate CECL?'];
          return { text: reply, blocks: blocksFor[question], sources, suggestions: suggest.filter((s) => ceclQuestion(s) !== question).slice(0, 3) };
        },
      },
      {
        name: 'cecl_set',
        description: 'Change the CFO’s CECL assumptions: the economic scenario weights (baseline, adverse, severe, percent, adding to 100) or one loan type’s Q-factor in basis points of its balance. Saving it needs approval.',
        input: z.object({ baseline: z.number().int().min(0).max(100).optional(), adverse: z.number().int().min(0).max(100).optional(), severe: z.number().int().min(0).max(100).optional(), loanType: z.enum(['Commercial Real Estate', 'Commercial & Industrial', 'Mortgage', 'Auto', 'Consumer']).optional(), bp: z.number().min(-50).max(200).optional(), note: z.string().max(200).optional() }).strict(),
        run: async (a: { baseline?: number; adverse?: number; severe?: number; loanType?: string; bp?: number; note?: string }, ctx) => {
          need(ctx);
          const s = await svc.settings();
          const before = await svc.estimate(undefined, s);
          const changingWeights = a.baseline !== undefined || a.adverse !== undefined || a.severe !== undefined;
          let weights: CeclWeights | undefined;
          if (changingWeights) {
            const given = { baseline: a.baseline, adverse: a.adverse, severe: a.severe };
            const missing = (Object.keys(given) as (keyof CeclWeights)[]).filter((k) => given[k] === undefined);
            const known = (Object.keys(given) as (keyof CeclWeights)[]).filter((k) => given[k] !== undefined).reduce((x, k) => x + given[k]!, 0);
            // One weight left out takes what the others leave; with two left out, they keep their shares of the rest.
            const rest = 100 - known;
            const restOld = missing.reduce((x, k) => x + s.weights[k], 0);
            weights = { ...s.weights };
            for (const k of Object.keys(given) as (keyof CeclWeights)[]) if (given[k] !== undefined) weights[k] = given[k]!;
            for (const k of missing) weights[k] = missing.length === 1 ? rest : Math.round(restOld ? (rest * s.weights[k]) / restOld : rest / missing.length);
            if (weights.baseline + weights.adverse + weights.severe !== 100 || Object.values(weights).some((v) => v < 0)) return { text: `Scenario weights need to add to 100%. ${weightsText(weights)} adds to ${weights.baseline + weights.adverse + weights.severe}%. Tell me all three, for example “Set scenario weights to 70% baseline, 25% adverse, 5% severe”.` };
          }
          if (a.loanType && a.bp === undefined) return { text: `What should the ${short(a.loanType)} Q-factor be? For example “Set the ${short(a.loanType)} Q-factor to 10 bp”.` };
          if (!weights && !a.loanType) return { text: 'Tell me the scenario weights, for example “Set scenario weights to 70% baseline, 25% adverse, 5% severe”, or a Q-factor, for example “Set the CRE Q-factor to 10 bp”.' };
          const qFactors = { ...s.qFactors, ...(a.loanType ? { [a.loanType]: a.bp! } : {}) };
          const after = await svc.estimate(weights ?? s.weights, { ...s, qFactors });
          const f = await svc.analysis();
          const booked = f?.now.allowance ?? null;
          const changes = [
            ...(weights ? (['baseline', 'adverse', 'severe'] as const).map((k) => ({ label: `Weight on ${k === 'severe' ? 'severely adverse' : k}`, before: `${s.weights[k]}%`, after: `${weights![k]}%` })) : []),
            ...(a.loanType ? [{ label: `Q-factor, ${a.loanType}`, before: `${s.qFactors[a.loanType] ?? 0} bp`, after: `${a.bp} bp` }] : []),
            { label: 'DI’s CECL estimate', before: mm(before.total), after: mm(after.total) },
          ];
          return {
            change: {
              summary: weights && a.loanType ? 'Change the CECL scenario weights and a Q-factor' : weights ? 'Change the CECL scenario weights' : `Set the ${short(a.loanType!)} CECL Q-factor`,
              changes,
              text: `DI’s CECL estimate would move from ${mm(before.total)} to **${mm(after.total)}** (${p2(after.coveragePct)} of loans)${booked !== null ? `, against a booked allowance of ${mm(booked)}: ${after.total > booked ? `${mm(after.total - booked)} more than booked` : `${mm(booked - after.total)} less than booked`}` : ''}. This changes DI’s estimate, not the books: the provision follows your CECL model.`,
              done: `Saved. DI’s CECL estimate uses ${weights ? `${weightsText(weights)}` : `the new ${short(a.loanType!)} Q-factor`} from now on.`,
              risk: 'low',
              apply: { ...(weights ? { weights } : {}), ...(a.loanType ? { qFactor: { category: a.loanType, bp: a.bp!, ...(a.note ? { note: a.note } : {}) } } : {}) },
            },
          };
        },
        apply: async (p: { weights?: CeclWeights; qFactor?: { category: string; bp: number; note?: string } }, meta, ctx) => svc.record(p, { approvalId: meta.approvalId, by: ctx.user.name }),
      },
    ],
  };
  return spec;
}
