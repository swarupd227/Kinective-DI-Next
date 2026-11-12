// Funding Optimizer: the cheapest way to fund loan growth that keeps every limit, found by searching
// every mix of a deposit special, FHLB advances, brokered CDs (a credit union's nonmember certificates)
// and cash through the institution's funding model. The bank's funding decision lays out a few plans for
// a committee; this answers "what's the cheapest mix?" and what each limit costs to keep. Read-only: it
// changes nothing. A credit union's search may raise more than the growth and keep the extra liquid,
// when that's what keeps liquid assets above their floor.
import { z } from 'zod';
import { CoreError, type FundingOptimizerService, type OptimizedMix } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const FUNDING_OPTIMIZER_REQUEST =
  /\b(?:cheapest|lowest[- ]cost|least[- ]expensive|optimal|optimi[sz]ed?|best) (?:way to fund|funding|mix of funding|source of funding|funding mix|mix)\b|\boptimi[sz]e (?:our |the )?funding\b|\bfunding optimi[sz]er\b|\bfund\b[^.?!]{0,60}\b(?:at the )?(?:lowest|least) cost\b|\bminimi[sz]e (?:our |the )?(?:funding|cost of funds)\b/i;

/** How each institution names its sources, who may use the optimizer, and whether it has a funding decision. */
const WORDS = {
  bank: { module: 'capactions', noAccess: 'Funding decisions aren’t part of your DI access. They are for a bank’s finance leaders.', special: 'deposit special', cert: 'certificate special', broker: 'brokered CDs', brokerAll: 'All brokered', decision: true },
  credit_union: { module: 'liquidity', noAccess: 'Funding decisions aren’t part of your DI access. They are for finance and executives.', special: 'share special', cert: 'share certificate special', broker: 'nonmember certificates', brokerAll: 'All nonmember certificates', decision: false },
};
type Words = (typeof WORDS)['bank'];
const money = (v: number) => {
  const a = Math.abs(v);
  // Round half up, as the tables do: (32.55).toFixed(1) is 32.5 where the table shows $32.6M.
  const r = (x: number, d: number) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
  const s = a >= 1e9 ? `$${r(a / 1e9, 2)}B` : a >= 1e6 ? `$${r(a / 1e6, a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)}M` : `$${Math.round(a / 1e3)}K`;
  return v < 0 ? `−${s}` : s;
};
const pct = (v: number, d = 2) => `${(v * 100).toFixed(d)}%`;
const years = (m: number) => (m % 12 ? `${m}-month` : `${m / 12}-year`);
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });

/** The mix's parts in words: "$7.35M from a 3-year certificate special, …". */
function parts(m: OptimizedMix, w: Words = WORDS.bank) {
  const l = m.levers;
  const out: { source: string; amount: number; term: string; rate: number; cost: number }[] = [];
  const f = m.figures;
  const held = (f as { held?: number }).held ?? 0;
  if (l.deposits > 0) out.push({ source: l.depositTermMonths ? `${years(l.depositTermMonths)} ${w.cert}` : 'money market special', amount: l.deposits, term: l.depositTermMonths ? years(l.depositTermMonths) : 'No maturity', rate: f.depositRate, cost: f.costs.deposits });
  if (l.fhlb > 0) out.push({ source: `${years(l.fhlbTermMonths)} FHLB advances`, amount: l.fhlb, term: years(l.fhlbTermMonths), rate: f.fhlbRate, cost: f.costs.fhlb });
  if (l.brokered > 0) out.push({ source: `${years(l.brokeredTermMonths)} ${w.broker}`, amount: l.brokered, term: years(l.brokeredTermMonths), rate: f.brokeredRate, cost: f.costs.brokered });
  if (m.fromCash > 0) out.push({ source: 'cash on hand', amount: m.fromCash, term: '—', rate: 0.0425, cost: f.costs.cash });
  // Raised beyond the growth and kept liquid: it earns the market rate, so its cost is negative.
  if (held > 0) out.push({ source: 'kept as liquid assets', amount: held, term: '—', rate: 0.0425, cost: f.costs.cash });
  return out;
}
const words = (m: OptimizedMix, w: Words = WORDS.bank) => {
  const p = parts(m, w);
  const each = p.map((x) => (x.source === 'kept as liquid assets' ? `${money(x.amount)} of it kept as liquid assets` : `${money(x.amount)} ${x.source === 'cash on hand' ? 'from cash on hand' : `from ${/^[aeiou]/i.test(x.source) ? 'an' : 'a'} ${x.source}`.replace(/from a (\S+ (?:FHLB advances|brokered CDs|nonmember certificates))/, 'in $1')}`));
  return each.length > 1 ? `${each.slice(0, -1).join(', ')} and ${each.at(-1)}` : (each[0] ?? 'nothing');
};
const breaches = (m: OptimizedMix) => m.figures.checks.filter((c) => c.status === 'breach');
/** A limit's label mid-sentence: lower case, but EVE, NII and FHLB stay capitals. */
const lower = (label: string) => (/^[A-Z]{2,}\b/.test(label) ? label : label[0]!.toLowerCase() + label.slice(1));
/** What a mix breaches, saying when it makes a breach worse than today's. */
const breachList = (m: OptimizedMix) => breaches(m).map((x) => `${x.label}${x.worseThanToday ? ' (worse than today)' : x.today ? ' (over today, not worse)' : ''}`).join(', ');

export function fundingOptimizerModule(svc: FundingOptimizerService): ModuleSpec {
  const W = WORDS[svc.institutionType];
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes(W.module)) throw new CoreError('NO_ACCESS', W.noAccess);
  };
  const partsOf = (m: OptimizedMix) => parts(m, W);
  const wordsOf = (m: OptimizedMix) => words(m, W);
  const spec: ModuleSpec = {
    id: W.module,
    prefix: 'fop',
    agent: 'Funding Optimizer',
    request: FUNDING_OPTIMIZER_REQUEST,
    noAccess: W.noAccess,
    sources: [
      { kind: 'table', label: 'Call Report values', ref: 'table:cr_value' },
      { kind: 'table', label: 'Loans', ref: 'table:cdm_loan' },
      { kind: 'table', label: 'Deposits', ref: 'table:cdm_deposit' },
    ],
    prompt: ({ tenant, user, title }) => `You are the Funding Optimizer inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) wants the cheapest way to fund loan growth that keeps every limit.

- "What's the cheapest way to fund next year's loan growth?", "optimize our funding": fop_optimize. An amount ("fund $60 million"): amount in dollars. "Without brokered", "no FHLB", "don't use cash": no_brokered, no_fhlb, no_cash, no_deposits.
- "What does the optimizer assume?": fop_assumptions.
- It searches every mix through DI's funding model and stated rates. It recommends; ALCO decides.${W.decision ? ' To lay plans out for the board, the Funding Decision agent does that.' : ''}`,
    plan: (t) => {
      if (/\bassum/i.test(t)) return { tool: 'fop_assumptions', args: {} };
      const amount = /\$\s?(\d+(?:\.\d+)?)\s*(m|mm|million|b|billion|k|thousand)?\b/i.exec(t) ?? /\b(\d+(?:\.\d+)?)\s*(million|billion)\b/i.exec(t);
      const scale = (u?: string) => (!u ? 1 : /^b/i.test(u) ? 1e9 : /^k|^t/i.test(u) ? 1e3 : 1e6);
      const no = (w: string) => new RegExp(`\\b(?:without|no|not|excluding|except|avoid(?:ing)?|don'?t use|never use)\\b[^.?!]{0,30}\\b${w}`, 'i').test(t);
      return {
        tool: 'fop_optimize',
        args: {
          ...(amount ? { amount: Number(amount[1]) * scale(amount[2]) } : {}),
          ...(no('brokered|nonmember') ? { no_brokered: true } : {}),
          ...(no('fhlb|advances|borrow') ? { no_fhlb: true } : {}),
          ...(no('cash') ? { no_cash: true } : {}),
          ...(no('deposit|special') ? { no_deposits: true } : {}),
        },
      };
    },
    tools: [
      {
        name: 'fop_optimize',
        description: 'The cheapest mix of a deposit special, FHLB advances, brokered CDs and cash on hand to fund loan growth (the capital plan’s growth, or an amount in dollars) that breaches no limit (except one already over today that it doesn’t worsen): its parts, terms and cost, its tightest limit, the cheapest mix that also clears an existing breach if any can, and each single source and the cheapest ignoring limits for comparison.',
        input: z.object({ amount: z.number().positive().max(5e10).optional(), no_brokered: z.boolean().optional(), no_fhlb: z.boolean().optional(), no_cash: z.boolean().optional(), no_deposits: z.boolean().optional() }).strict(),
        run: async (a: { amount?: number; no_brokered?: boolean; no_fhlb?: boolean; no_cash?: boolean; no_deposits?: boolean }, ctx) => {
          need(ctx);
          const r = await svc.optimize({ amount: a.amount, noBrokered: a.no_brokered, noFhlb: a.no_fhlb, noCash: a.no_cash, noDeposits: a.no_deposits });
          if (!r) throw new CoreError('NOT_FOUND', 'The funding model needs the Call Report, the capital plan and the liquidity analysis, and one of them isn’t in DI yet.');
          const growth = `${money(r.growth)} of loan growth${r.fromPlan ? ` (${r.growthFrom})` : ''}`;
          const ruled = r.ruledOut.length ? ` without ${r.ruledOut.map((x) => (x === 'fhlb' ? 'FHLB advances' : x === 'brokered' ? W.broker : x === 'deposits' ? `a ${W.special}` : 'cash on hand')).join(' or ')}` : '';
          const c = r.chosen;
          if (!c) {
            return {
              text: `No mix${ruled} funds ${growth} without breaching a limit or worsening one already breached. ${r.cheapest ? `The cheapest regardless, ${wordsOf(r.cheapest)}, costs ${money(r.cheapest.figures.cost)} a year and breaches ${breachList(r.cheapest)}.` : ''} Growing more slowly, or easing a limit, is the choice left.`,
              suggestions: ['What’s the cheapest way to fund $20 million of loans?', ...(W.decision ? ['How do we fund next year’s loan growth?'] : [])],
            };
          }
          const f = c.figures;
          const tight = c.tightest ? ` Its tightest limit is ${lower(c.tightest.label)}, at ${(c.tightest.used * 100).toFixed(0)}% of the limit.` : '';
          // An existing breach: does the answer clear it, and can any mix?
          const existing = r.breachedToday;
          const still = breaches(c).filter((x) => x.today).map((x) => x.label);
          const breachNote = !existing.length
            ? ''
            : !still.length
              ? ` It also brings ${existing.map(lower).join(' and ')} back inside its limit.`
              : r.clean
                ? ` ${still.join(' and ')} is already over its limit today; this mix doesn’t make it worse, and clearing it costs ${money(r.clean.figures.cost - f.cost)} a year more: ${wordsOf(r.clean)}.`
                : ` ${still.join(' and ')} is already over its limit today. This mix doesn’t make it worse, but no mix of these sources brings it back inside: it needs a hedge, shorter assets or less fixed-rate lending.`;
          // The cheaper choices it passed over, and why.
          const passed = r.single.filter((s) => s.mix && s.mix.figures.cost < f.cost - 1 && !s.acceptable).sort((x, y) => x.mix!.figures.cost - y.mix!.figures.cost)[0];
          const passedNote = passed?.mix ? ` Funding it all ${passed.source === 'deposits' ? `with a ${partsOf(passed.mix)[0]!.source}` : passed.source === 'fhlb' ? 'from the FHLB' : `with ${W.broker}`} would cost less, ${money(passed.mix.figures.cost)}, but ${breaches(passed.mix).some((x) => x.today) ? `makes ${breaches(passed.mix).filter((x) => x.today).map((x) => lower(x.label)).join(' and ')} worse` : `breaches ${breaches(passed.mix).map((x) => lower(x.label)).join(' and ')}`}.` : '';
          const rows = [
            { plan: 'Recommended', mix: wordsOf(c), cost: money(f.cost), allIn: pct(f.allIn), limits: breaches(c).length ? `Keeps every limit it can; ${breaches(c).map((x) => x.label).join(', ')} over today, not worse` : 'Keeps every limit' },
            ...(r.clean && r.clean.figures.cost !== f.cost ? [{ plan: 'Clears every limit', mix: wordsOf(r.clean), cost: money(r.clean.figures.cost), allIn: pct(r.clean.figures.allIn), limits: 'Keeps every limit' }] : []),
            ...r.single.filter((s) => s.mix).map((s) => ({ plan: s.source === 'deposits' ? `All from a ${W.special}` : s.source === 'fhlb' ? 'All from the FHLB' : W.brokerAll, mix: wordsOf(s.mix!), cost: money(s.mix!.figures.cost), allIn: pct(s.mix!.figures.allIn), limits: s.acceptable ? 'Acceptable' : `Breaches ${breachList(s.mix!)}` })),
            ...(r.cheapest && r.cheapest.figures.cost < f.cost - 1 ? [{ plan: 'Cheapest ignoring limits', mix: wordsOf(r.cheapest), cost: money(r.cheapest.figures.cost), allIn: pct(r.cheapest.figures.allIn), limits: breaches(r.cheapest).length ? `Breaches ${breachList(r.cheapest)}` : 'Acceptable' }] : []),
          ];
          const extraNote = r.extra > 0 ? ` It raises ${money(r.extra)} more than the growth and keeps it liquid: without it, liquid assets would fall below their floor.` : '';
          return {
            text: `The cheapest way to fund ${growth}${ruled} that keeps every limit costs **${money(f.cost)} a year, ${pct(f.allIn)} all-in**: ${wordsOf(c)}.${extraNote}${tight}${breachNote}${passedNote} DI searched ${r.evaluated.toLocaleString('en-US')} mixes through its funding model; ALCO decides.`,
            blocks: [
              moduleTable(spec, 'The recommended mix', ctx.runId, 'fop.mix', [text('source', 'Source'), { field: 'amount', headerName: 'Amount', type: 'currency' }, text('term', 'Term'), text('rate', 'Rate'), { field: 'cost', headerName: 'Cost a year', type: 'currency' }], partsOf(c).map((p) => ({ source: p.source[0]!.toUpperCase() + p.source.slice(1), amount: Math.round(p.amount), term: p.term, rate: pct(p.rate), cost: Math.round(p.cost) }))),
              moduleTable(spec, 'Against every limit', ctx.runId, 'fop.limits', [text('limit', 'Limit'), text('value', 'With this mix'), text('max', 'Limit'), text('used', 'Share used'), text('status', 'Status')], f.checks.map((x) => ({ limit: x.label, value: `${x.value.toFixed(1)}%`, max: `${x.kind === 'cap' ? 'At most' : 'At least'} ${x.limit.toFixed(0)}%`, used: `${(x.used * 100).toFixed(0)}%`, status: x.status === 'breach' ? (x.today ? 'Over today, not worse' : 'Breach') : x.status === 'thin' ? 'Close to the limit' : x.status === 'watch' ? 'Watch' : 'Within' }))),
              moduleTable(spec, 'The choices it weighed', ctx.runId, 'fop.compare', [text('plan', 'Plan'), text('mix', 'Mix'), text('cost', 'Cost a year'), text('allIn', 'All-in rate'), text('limits', 'Limits')], rows),
            ],
            suggestions: [`What’s the cheapest way to fund it without ${W.broker}?`, ...(W.decision ? ['How do we fund next year’s loan growth?'] : []), 'What does the optimizer assume?'],
          };
        },
      },
      {
        name: 'fop_assumptions',
        description: 'What the funding optimizer assumes: how it searches, what counts as acceptable, the rates on new money and the funding policy.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const m = await svc.model();
          if (!m) throw new CoreError('NOT_FOUND', 'The funding model isn’t available for this institution.');
          const list = svc.assumptions(m);
          return { text: 'The optimizer searches every mix through the funding model the funding decision uses, with these rates and limits.', blocks: [moduleTable(spec, 'What the optimizer assumes', ctx.runId, 'fop.assumptions', [text('item', 'Assumption'), text('detail', 'Detail')], list.map(([item, detail]) => ({ item, detail })))] };
        },
      },
    ],
  };
  return spec;
}
