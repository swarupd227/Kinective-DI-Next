// Interest rate risk on the shared module agent: NII at risk, economic value and the repricing gap
// under rate shocks, what drives them and the assumptions. A bank hears EVE (economic value of equity)
// against a limit for each shock, what a gradual Fed move does to NII over two years, and what a rise
// does to tangible book value; a credit union hears NEV and the NEV ratio. Read-only, and honest that it
// is DI's estimate from core data, not the ALM model of record.
import { z } from 'zod';
import { CoreError, RAMPS_BP, SHOCKS_BP, type AlcoService, type IrrService, type PerShareService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const NO_ACCESS = 'Interest rate risk isn’t part of your DI access. It is for the finance team and executives.';
const guard = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('irr')) throw new CoreError('NO_ACCESS', NO_ACCESS);
};
const m = (n: number) => `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(1)}M`;
const pc = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`;
const bp = (s: number) => (s === 0 ? 'base' : `${s > 0 ? '+' : ''}${s} bp`);
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`);
type Analysis = Awaited<ReturnType<IrrService['analysis']>>;

/** Net interest income over two years, with rates moving at once or gradually over a year. */
export function rampRows(a: Analysis) {
  return RAMPS_BP.map((shock) => {
    const at = a.ramps.find((r) => r.shockBp === shock && !r.ramp)!;
    const ramp = a.ramps.find((r) => r.shockBp === shock && r.ramp)!;
    return { move: `${shock > 0 ? '+' : ''}${shock} bp`, instant1: pc(at.year1Pct), instant2: pc(at.year2Pct), ramp1: pc(ramp.year1Pct), ramp2: pc(ramp.year2Pct) };
  });
}
export const RAMP_COLUMNS = [
  { field: 'move', headerName: 'Rates move', type: 'text' as const },
  { field: 'instant1', headerName: 'At once: year 1', type: 'text' as const },
  { field: 'instant2', headerName: 'At once: year 2', type: 'text' as const },
  { field: 'ramp1', headerName: 'Over a year: year 1', type: 'text' as const },
  { field: 'ramp2', headerName: 'Over a year: year 2', type: 'text' as const },
];
/** "rise 200 bp", "plus 300 basis points", "down 1%", "-100": the shock in basis points, nearest modelled. */
export function shockFrom(text: string): number | null {
  const t = text.toLowerCase();
  const n = /([+-]?\d+(?:\.\d+)?)\s*(bp|bps|basis points?|%|percent)?/.exec(t.replace(/\bplus\s+/g, '+').replace(/\bminus\s+/g, '-'));
  if (!n) return null;
  let v = Number(n[1]);
  if (n[2] === '%' || n[2] === 'percent' || (!n[2] && Math.abs(v) <= 5)) v *= 100;
  if (/\b(fall|falls|fell|drop|drops|down|decline|declines|lower|lowers|cut|cuts|ease|eases|easing)\b/.test(t) && v > 0) v = -v;
  return SHOCKS_BP.filter((s) => s).reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), 300);
}

/** Fixed or variable loans and what reprices soon, from each loan's terms (ESP phase 1). */
export const RATE_TYPE_REQUEST = /\bfixed (?:vs\.?|versus|or|and) variable\b|\bvariable[- ]rate (?:loans?|share|balances?)\b|\bhow much (?:of our loans )?(?:is|are) (?:variable|floating|adjustable)\b|\bfloating[- ]rate loans?\b|\badjustable[- ]rate loans?\b|\b(?:next|upcoming) rate changes?\b|\breprice (?:by|next|this) (?:the )?quarter\b/i;
const pct1 = (n: number) => `${n.toFixed(1)}%`;

/** Deposit pricing through the rate cycle, from the ALCO service: betas and new-loan yield. */
type Pricing = () => ReturnType<AlcoService['pricing']>;

/** "Gradually", "over a year", "step by step", "next year": the shock as a ramp over 12 months, with NII for two years. */
const RAMP = /\bgradual\w*|\bramps?\b|\bover (?:the next |a |one )?(?:12 months|year)\b|\bstep by step\b|\bslowly\b|\bsecond year\b|\byear two\b|\b24 months\b|\btwo years\b/i;

export function irrModule(irr: IrrService, pricing?: Pricing, perShare?: PerShareService | null): ModuleSpec {
  const rampTable = (a: Analysis, runId: string) => moduleTable(spec, 'Net interest income over two years: rates moving at once or over a year', runId, 'irr.ramps', RAMP_COLUMNS, rampRows(a));
  const spec: ModuleSpec = {
    id: 'irr',
    prefix: 'irr',
    agent: 'Interest Rate Risk',
    request: /^(?![\s\S]*\b(?:leave|leaving|left|outflows?|run ?off|runoff|flight|uninsured|deposit mix|unrealized|aoci|accumulated other comprehensive|underwater|bond portfolio|securities portfolio|fee income|non-?interest income|noninterest income|mortgage banking|diversif\w*)\b)[\s\S]*(?:\bfixed (?:vs\.?|versus|or|and) variable\b|\bvariable[- ]rate (?:loans?|share|balances?)\b|\bfloating[- ]rate loans?\b|\badjustable[- ]rate loans?\b|\b(?:next|upcoming) rate changes?\b|\bdeposit betas?\b|\bbetas? on (deposits|shares)\b|\bdeposit pricing\b|\bpassed on (the|rate)|\byield on new loans\b|\bnew loan yield\b|\binterest rate risk\b|\birr\b|\bnev\b|\beve\b|economic value of equity|net economic value|\bnii at risk\b|net interest income at risk|rate shocks?|\bif rates (rise|fall|go up|go down|drop|increase|decrease)|repricing gap|\brate sensitivity\b|\b(alm|asset.liability)\b|\bthe fed\b[^.?!]*\b(?:hikes?|hiking|raises?|raising|cuts?|cutting|lowers?|eases?|moves?)\b|\bfed (?:hikes?|raises?|cuts?|lowers?|eases?)\b|\brate (?:hikes?|cuts?|ramps?)\b|\brates? (?:go|goes|went|move|moves|moved) (?:up|down)\b|\b(?:nii|eve|nev|earnings) sensitivity\b|\bwhat happens to (?:our|the bank'?s?|the credit union'?s?) value\b|\brate risk\b)/i,
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'Loans, deposits and certificates', ref: 'table:cdm_loan' }],
    prompt: ({ tenant, user, title }) => `You are the Interest Rate Risk agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) reviews interest rate risk for the ALCO. DI estimates it from core data: 12-month net interest income (NII) at risk and economic value under parallel shocks of ${SHOCKS_BP.filter((s) => s).join(', ')} bp, gradual ramps over 12 months with NII for two years, and the repricing gap. A bank's economic value is EVE (economic value of equity), judged against a limit for each shock; a credit union's is NEV (net economic value) with the NEV ratio. The ALM vendor's model remains the one of record; say so when asked about filing or exams.

- "What's our interest rate risk?", "are we within limits?", "IRR / EVE and NII sensitivity": irr_summary.
- "What happens to our value if the Fed hikes 200 bp?", "NII if rates rise 200 bp?", "EVE at minus 100?": irr_scenario with shock_bp; ramp true when the move is gradual ("over a year").
- "What drives our rate risk?", "why does EVE fall?": irr_drivers with shock_bp (default 300).
- "Show the repricing gap": irr_gap.
- "How much of our loans are fixed vs variable?", "which loans reprice next quarter?": irr_rate_types.
- "What assumptions does the model use?": irr_assumptions.
- "What's our deposit beta?", "how much of the rate cuts did we pass on?", "what do new loans yield against the book?": irr_pricing.
- You are read-only and do not give investment or hedging advice; describe the exposure and let the ALCO decide.`,
    plan: (text) => {
      const t = text.toLowerCase();
      if (pricing && !/assum|model/.test(t) && /\bbetas?\b|deposit pricing|passed on|pass[- ]through|cost of (deposits|shares)|new loan yield|yield on new loans|new loans (yield|price)/.test(t)) return { tool: 'irr_pricing', args: {} };
      if (/assumption|how (is|does) (this|it|the model)|prepay|beta|decay/.test(t)) return { tool: 'irr_assumptions', args: {} };
      if (RATE_TYPE_REQUEST.test(t)) return { tool: 'irr_rate_types', args: {} };
      if (/\bgap\b|reprice|repricing|maturit/.test(t)) return { tool: 'irr_gap', args: {} };
      if (/drive|driver|\bwhy\b|which products|what causes/.test(t)) return { tool: 'irr_drivers', args: { shock_bp: shockFrom(t) ?? 300 } };
      const s = shockFrom(t);
      const ramp = RAMP.test(t);
      if (s !== null && /\d/.test(t)) return { tool: 'irr_scenario', args: { shock_bp: s, ...(ramp ? { ramp: true } : {}) } };
      if (ramp) return { tool: 'irr_scenario', args: { shock_bp: /\b(fall|falls|drop|down|cut|cuts|lower|ease)\b/.test(t) ? -200 : 200, ramp: true } };
      return { tool: 'irr_summary', args: {} };
    },
    tools: [
      ...(pricing
        ? [
            {
              name: 'irr_pricing',
              description: 'Deposit pricing through the rate cycle: each product’s rate paid then and now, its beta against the federal funds rate, the effect of the mix, and the yield on new loans against the book.',
              input: z.object({}).strict(),
              run: async (_: unknown, ctx: ModuleContext) => {
                guard(ctx);
                const pr = await pricing();
                if (!pr) return { text: 'No market rate history is loaded, so DI can’t measure deposit betas yet.' };
                const b2 = (n: number | null) => (n === null ? 'n/a' : n.toFixed(2));
                const bps = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} bp`;
                const when = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                const top = [...pr.products].filter((p) => p.beta !== null).slice(0, 2);
                return {
                  text: `Since ${when(pr.start)} the federal funds rate has moved **${bps(pr.marketMoveBp)}**. Rates paid repriced **${bps(pr.total.repricingBp)}**, a deposit beta of **${b2(pr.total.repricingBeta)}**: ${top.map((p) => `${p.category.toLowerCase()} ${b2(p.beta)}`).join(', ')}. The shift toward higher-rate products ${pr.total.mixBp > 0 ? 'took back' : 'added'} ${Math.abs(pr.total.mixBp)} bp, so the all-in cost moved ${bps(pr.total.changeBp)}, to ${pr.total.rateNow.toFixed(2)}%.${pr.newYield !== null && pr.likeForLikeBp !== null ? ` New loans over the last three months yield ${pr.newYield.toFixed(2)}% against ${pr.bookYield.toFixed(2)}% on the book; type for type they price ${bps(pr.likeForLikeBp)} against it, so the gap is mix.` : ''} The market path is illustrative; the betas are DI’s measure from rates paid, not the ALM model’s assumptions.`,
                  blocks: [moduleTable(spec, 'Deposit pricing and beta', ctx.runId, 'alco.pricing', [{ field: 'item', headerName: 'Product', type: 'text' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'then', headerName: `Rate, ${when(pr.start)}`, type: 'text' }, { field: 'now', headerName: `Rate, ${when(pr.end)}`, type: 'text' }, { field: 'beta', headerName: 'Beta', type: 'text' }], pr.products.map((p) => ({ item: p.category, balance: Math.round(p.balance), then: `${p.rateThen.toFixed(2)}%`, now: `${p.rateNow.toFixed(2)}%`, beta: b2(p.beta) })))],
                  suggestions: ['What’s our interest rate risk?', 'What assumptions does the model use?'],
                };
              },
            },
          ]
        : []),
      {
        name: 'irr_summary',
        description: 'NII at risk and economic value (EVE for a bank, NEV for a credit union) under every rate shock, against the board’s limits, with the worst case for each; for a bank, NII over two years with rates moving at once or gradually.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const a = await irr.analysis();
          const ev = a.ev;
          const worstNii = [...a.scenarios].sort((x, y) => x.niiPct - y.niiPct)[0]!;
          const worstNev = [...a.scenarios].sort((x, y) => x.nevPct - y.nevPct)[0]!;
          const breaches = a.scenarios.filter((x) => x.status === 'Breach');
          const watch = a.scenarios.filter((x) => x.status === 'Watch');
          const shocks = (xs: typeof breaches) => { const l = xs.map((b) => bp(b.shockBp)); return l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l.at(-1)}` : (l[0] ?? ''); };
          if (a.bank) {
            const up2 = a.scenarios.find((x) => x.shockBp === 200)!;
            const ramp2 = a.ramps.find((r) => r.shockBp === 200 && r.ramp);
            const limits = `${breaches.length ? `${shocks(breaches)} ${breaches.length === 1 ? 'breaches' : 'breach'} the board’s limits${breaches.map((b) => ` (EVE ${pc(b.nevPct)} against −${b.nevLimitPct}%)`).join('')}.` : 'Every shock is within the board’s limits.'}${watch.length ? ` ${shocks(watch)} ${watch.length === 1 ? 'is' : 'are'} close to ${watch.length === 1 ? 'its limit' : 'their limits'}.` : ''}`;
            return {
              text: `Net interest income over the next 12 months is **${m(a.base.nii)}** at today’s rates, and the bank’s economic value of equity (EVE) is **${m(a.base.nev)}**. Both fall as rates rise: at +200 bp, NII falls **${pc(up2.niiPct)}** (limit −${up2.niiLimitPct}%) and EVE **${pc(up2.nevPct)}** (limit −${up2.nevLimitPct}%); the worst case is ${bp(worstNev.shockBp)}, EVE **${pc(worstNev.nevPct)}**. ${limits}${ramp2 ? ` If the Fed moved 200 bp gradually over a year instead, NII would be ${pc(ramp2.year1Pct)} in the first year and ${pc(ramp2.year2Pct)} in the second.` : ''} This is DI’s estimate from core data; the ALM vendor’s model is the one of record.`,
              blocks: [
                moduleTable(spec, 'Rate shocks against the board’s limits', ctx.runId, 'irr.scenarios', [{ field: 'shock', headerName: 'Rate shock', type: 'text' }, { field: 'nii', headerName: 'NII, next 12 months', type: 'currency' }, { field: 'niiPct', headerName: 'NII change', type: 'text' }, { field: 'niiLimit', headerName: 'NII limit', type: 'text' }, { field: 'nev', headerName: 'EVE', type: 'currency' }, { field: 'nevPct', headerName: 'EVE change', type: 'text' }, { field: 'nevLimit', headerName: 'EVE limit', type: 'text' }, { field: 'limits', headerName: 'Status', type: 'text' }], a.scenarios.map((x) => ({ shock: x.shockBp ? bp(x.shockBp) : 'Base', nii: Math.round(x.nii), niiPct: x.shockBp ? pc(x.niiPct) : '', niiLimit: x.shockBp ? `−${x.niiLimitPct}%` : '', nev: Math.round(x.nev), nevPct: x.shockBp ? pc(x.nevPct) : '', nevLimit: x.shockBp ? `−${x.nevLimitPct}%` : '', limits: x.shockBp ? x.status : '' }))),
                rampTable(a, ctx.runId),
              ],
              suggestions: ['What happens to our value if the Fed hikes 200 bp?', 'What drives our interest rate risk at plus 300 basis points?', 'Show the repricing gap'],
            };
          }
          return {
            text: `Net interest income over the next 12 months is **${m(a.base.nii)}** at today’s rates. The worst case is ${bp(worstNii.shockBp)}, **${pc(worstNii.niiPct)}**. NEV is **${m(a.base.nev)}** (an NEV ratio of ${a.base.nevRatio.toFixed(1)}%); its worst case is ${bp(worstNev.shockBp)}, **${pc(worstNev.nevPct)}**, leaving an NEV ratio of ${worstNev.nevRatio.toFixed(1)}%. ${breaches.length ? `${shocks(breaches)} ${breaches.length === 1 ? 'breaches' : 'breach'} the board’s limits.` : `Every scenario is within the board’s limits (NII down at most ${a.limits.niiDeclinePct}%, NEV down at most ${a.limits.nevDeclinePct}%, NEV ratio at least ${a.limits.nevRatioMinPct}%).`} This is DI’s estimate from core data; the ALM vendor’s model is the one of record.`,
            blocks: [moduleTable(spec, 'Rate shocks', ctx.runId, 'irr.scenarios', [{ field: 'shock', headerName: 'Rate shock', type: 'text' }, { field: 'nii', headerName: 'NII, next 12 months', type: 'currency' }, { field: 'niiPct', headerName: 'NII change', type: 'text' }, { field: 'nev', headerName: ev, type: 'currency' }, { field: 'nevPct', headerName: `${ev} change`, type: 'text' }, { field: 'ratio', headerName: 'NEV ratio', type: 'text' }, { field: 'limits', headerName: 'Board limits', type: 'text' }], a.scenarios.map((x) => ({ shock: x.shockBp ? bp(x.shockBp) : 'Base', nii: Math.round(x.nii), niiPct: x.shockBp ? pc(x.niiPct) : '', nev: Math.round(x.nev), nevPct: x.shockBp ? pc(x.nevPct) : '', ratio: `${x.nevRatio.toFixed(2)}%`, limits: x.withinLimits ? 'Within' : 'Breach' })))],
            suggestions: ['What drives our interest rate risk at plus 300 basis points?', 'Show the repricing gap'],
          };
        },
      },
      {
        name: 'irr_scenario',
        description: 'One rate move: the change in economic value (EVE for a bank, NEV for a credit union) and in NII over 12 months against the board’s limits; for a bank, NII in the second year, the same move made gradually over a year, what drives it, and what it does to tangible book value per share.',
        input: z.object({ shock_bp: z.number().int().min(-400).max(400), ramp: z.boolean().optional() }).strict(),
        run: async (a0: { shock_bp: number; ramp?: boolean }, ctx) => {
          guard(ctx);
          const a = await irr.analysis();
          const s = a.scenarios.find((x) => x.shockBp === a0.shock_bp) ?? a.scenarios.find((x) => x.shockBp === 300)!;
          const dir = s.shockBp > 0 ? 'rise' : 'fall';
          if (!a.bank) {
            return {
              text: `If rates ${dir} ${Math.abs(s.shockBp)} bp at once, net interest income over the next 12 months ${s.niiChange < 0 ? 'falls' : 'rises'} **${m(Math.abs(s.niiChange))}** (${pc(s.niiPct)}) to ${m(s.nii)}, and NEV ${s.nevChange < 0 ? 'falls' : 'rises'} **${m(Math.abs(s.nevChange))}** (${pc(s.nevPct)}) to ${m(s.nev)}, an NEV ratio of ${s.nevRatio.toFixed(1)}%. That is ${s.withinLimits ? 'within' : '**outside**'} the board’s limits.`,
              suggestions: [`What drives our interest rate risk at ${s.shockBp > 0 ? 'plus' : 'minus'} ${Math.abs(s.shockBp)} basis points?`],
            };
          }
          const instant = a.ramps.find((r) => r.shockBp === s.shockBp && !r.ramp);
          const ramp = a.ramps.find((r) => r.shockBp === s.shockBp && r.ramp);
          const status = (x: typeof s) => (x.status === 'Breach' ? '**outside** the limit' : x.status === 'Watch' ? 'within it, but close' : 'within it');
          const evePart = `the bank’s economic value of equity (EVE) ${s.nevChange < 0 ? 'falls' : 'rises'} **${m(Math.abs(s.nevChange))} (${pc(s.nevPct)})** to ${m(s.nev)}, against the board’s limit of −${s.nevLimitPct}% at ±${Math.abs(s.shockBp)} bp: ${status(s)}`;
          const niiPart = `Net interest income over the next 12 months ${s.niiChange < 0 ? 'falls' : 'rises'} **${m(Math.abs(s.niiChange))} (${pc(s.niiPct)})** to ${m(s.nii)} (limit −${s.niiLimitPct}%)${instant ? `, and ${pc(instant.year2Pct)} in the second year as more of the book reprices` : ''}.`;
          const rampNumbers = ramp ? `NII would be ${pc(ramp.year1Pct)} (${m(ramp.year1 - a.niiFlat.year1)}) in the first year and ${pc(ramp.year2Pct)} (${m(ramp.year2 - a.niiFlat.year2)}) in the second, where an immediate move also ends up` : '';
          const rampPart = ramp ? `If the Fed moved the same ${Math.abs(s.shockBp)} bp gradually over a year, as it usually does, ${rampNumbers}.` : '';
          const d = [...(a.driversByShock[s.shockBp] ?? a.drivers)].sort((x, y) => x.nevChange - y.nevChange);
          const hurt = d.filter((x) => x.nevChange < 0).slice(0, 2);
          const help = d.filter((x) => x.nevChange > 0).slice(-2).reverse();
          const driverPart = s.shockBp > 0 && hurt.length ? `EVE falls mostly through ${hurt.map((x) => `${x.name.toLowerCase()} (${m(x.nevChange)})`).join(' and ')}, fixed-rate assets worth less as rates rise${help.length ? `; ${help.map((x) => x.name.toLowerCase()).join(' and ')} offset ${m(help.reduce((t, x) => t + x.nevChange, 0))}, because low-rate deposits are worth more to the bank` : ''}.` : '';
          // On the books: the available-for-sale loss moves AOCI, and tangible book value per share with it.
          const f = perShare && s.shockBp > 0 ? await perShare.figures().catch(() => null) : null;
          const tbv = f && !f.missing ? f.rates.find((r) => r.bp === s.shockBp) : undefined;
          const bookPart = tbv && f ? `On the books, the larger loss on available-for-sale bonds takes ${m(Math.abs(tbv.aociChange))} after tax off AOCI, **${usd(-tbv.change)} a share** off tangible book value (${usd(f.now.tbvps)} to ${usd(tbv.tbvps)}); regulatory capital doesn’t move under the AOCI opt-out.` : '';
          const lead = s.shockBp > 0 ? `If the Fed raised rates ${s.shockBp} bp at once, ` : `If rates fell ${Math.abs(s.shockBp)} bp at once, `;
          const rampFirst = `If the Fed ${s.shockBp > 0 ? 'raised' : 'cut'} rates ${Math.abs(s.shockBp)} bp gradually over a year, ${rampNumbers}.`;
          const order = a0.ramp && ramp ? [rampFirst, `Value moves at once whatever the pace: ${evePart}.`, niiPart.replace(/^Net interest income over the next 12 months/, 'Were the move immediate, net interest income over the next 12 months')] : [`${lead}${evePart}.`, niiPart, rampPart];
          const rows: Record<string, string>[] = [
            { measure: 'Economic value of equity (EVE)', today: m(a.base.nev), after: m(s.nev), change: `${m(s.nevChange)} (${pc(s.nevPct)})`, limit: `−${s.nevLimitPct}%`, status: s.status },
            { measure: 'Net interest income, next 12 months', today: m(a.base.nii), after: m(s.nii), change: `${m(s.niiChange)} (${pc(s.niiPct)})`, limit: `−${s.niiLimitPct}%`, status: s.niiPct < -s.niiLimitPct ? 'Breach' : -s.niiPct >= s.niiLimitPct * 0.85 ? 'Watch' : 'Within' },
            ...(instant ? [{ measure: 'Net interest income, second year', today: m(a.niiFlat.year2), after: m(instant.year2), change: `${m(instant.year2 - a.niiFlat.year2)} (${pc(instant.year2Pct)})`, limit: '', status: '' }] : []),
            ...(ramp ? [
              { measure: 'Net interest income, first year, moving gradually', today: m(a.niiFlat.year1), after: m(ramp.year1), change: `${m(ramp.year1 - a.niiFlat.year1)} (${pc(ramp.year1Pct)})`, limit: '', status: '' },
              { measure: 'Net interest income, second year, moving gradually', today: m(a.niiFlat.year2), after: m(ramp.year2), change: `${m(ramp.year2 - a.niiFlat.year2)} (${pc(ramp.year2Pct)})`, limit: '', status: '' },
            ] : []),
            ...(tbv && f ? [{ measure: 'Tangible book value a share (AOCI)', today: usd(f.now.tbvps), after: usd(tbv.tbvps), change: `${usd(tbv.change)} (${pc(tbv.pct)})`, limit: '', status: '' }] : []),
          ];
          const col = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
          return {
            text: `${order.filter(Boolean).join(' ')} ${[driverPart, bookPart].filter(Boolean).join(' ')} DI’s figures are an estimate from core data; the ALM vendor’s model remains the one of record.`.replace(/\s+/g, ' ').trim(),
            blocks: [
              moduleTable(spec, `If rates ${dir} ${Math.abs(s.shockBp)} bp`, ctx.runId, 'irr.scenario', [col('measure', 'Measure'), col('today', 'Today'), col('after', `At ${bp(s.shockBp)}`), col('change', 'Change'), col('limit', 'Board limit'), col('status', 'Status')], rows),
              moduleTable(spec, `What drives the change in EVE at ${bp(s.shockBp)}`, ctx.runId, 'irr.drivers', [{ field: 'name', headerName: 'Product', type: 'text' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'rate', headerName: 'Rate', type: 'text' }, { field: 'nii', headerName: 'NII change', type: 'currency' }, { field: 'nev', headerName: 'EVE change', type: 'currency' }], [...(a.driversByShock[s.shockBp] ?? a.drivers)].sort((x, y) => Math.abs(y.nevChange) - Math.abs(x.nevChange)).map((x) => ({ name: x.name, balance: Math.round(x.balance), rate: `${x.rate.toFixed(2)}%`, nii: Math.round(x.niiChange), nev: Math.round(x.nevChange) }))),
            ],
            suggestions: [`What drives our interest rate risk at ${s.shockBp > 0 ? 'plus' : 'minus'} ${Math.abs(s.shockBp)} basis points?`, 'Are we within our rate risk limits?', 'What assumptions does the model use?'],
          };
        },
      },
      {
        name: 'irr_drivers',
        description: 'Each product’s contribution to the change in NII and in economic value at a shock: which loans, investments and deposits drive the risk.',
        input: z.object({ shock_bp: z.number().int().min(-400).max(400).default(300) }).strict(),
        run: async (a0: { shock_bp: number }, ctx) => {
          guard(ctx);
          const a = await irr.analysis();
          const ev = a.ev;
          const shock = a.driversByShock[a0.shock_bp] ? a0.shock_bp : 300;
          const drivers = a.driversByShock[shock] ?? a.drivers;
          const d = [...drivers].sort((x, y) => x.nevChange - y.nevChange);
          const up = shock > 0;
          const hurt = (up ? d.filter((x) => x.nevChange < 0) : [...d].reverse().filter((x) => x.nevChange > 0)).slice(0, 2);
          const help = (up ? d.filter((x) => x.nevChange > 0).reverse() : d.filter((x) => x.nevChange < 0)).slice(0, 2);
          const funds = a.bank ? 'deposits' : 'deposits and shares';
          return {
            text: up
              ? `At ${bp(shock)}, ${ev} falls mostly through ${hurt.map((x) => `**${x.name.toLowerCase()}** (${m(x.nevChange)}, ${m(x.balance)} at ${x.rate.toFixed(2)}%)`).join(' and ')}: fixed-rate assets lose value as rates rise. ${help.length ? `${cap(help.map((x) => x.name.toLowerCase()).join(' and '))} offset part of it, because low-rate ${funds} are worth more as rates rise.` : ''} For income, ${a.bank ? 'time deposits' : 'certificates'} and money market repricing up cost more than variable-rate loans and maturing investments earn back.`
              : `At ${bp(shock)}, ${ev} rises mostly through ${hurt.map((x) => `**${x.name.toLowerCase()}** (+${m(x.nevChange)})`).join(' and ')}: fixed-rate assets gain value as rates fall. ${help.length ? `${cap(help.map((x) => x.name.toLowerCase()).join(' and '))} give back part of it, because low-rate ${funds} are worth less when rates fall.` : ''}`,
            blocks: [moduleTable(spec, `What drives the change at ${bp(shock)}`, ctx.runId, 'irr.drivers', [{ field: 'name', headerName: 'Product', type: 'text' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'rate', headerName: 'Rate', type: 'text' }, { field: 'nii', headerName: 'NII change', type: 'currency' }, { field: 'nev', headerName: `${ev} change`, type: 'currency' }], [...drivers].sort((x, y) => Math.abs(y.nevChange) - Math.abs(x.nevChange)).map((x) => ({ name: x.name, balance: Math.round(x.balance), rate: `${x.rate.toFixed(2)}%`, nii: Math.round(x.niiChange), nev: Math.round(x.nevChange) })))],
          };
        },
      },
      {
        name: 'irr_gap',
        description: 'The repricing gap: assets and liabilities that reprice or mature in each band, the gap and the cumulative gap as a share of assets.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const a = await irr.analysis();
          const year = a.gap.find((g) => g.label === '3–12 months')!;
          return {
            text: `Within a year, **${m(a.gap[0]!.assets + year.assets)}** of assets and **${m(a.gap[0]!.liabilities + year.liabilities)}** of liabilities reprice or mature, a cumulative gap of **${m(year.cumulative)}** (${year.cumulativePct.toFixed(1)}% of assets). ${year.cumulative < 0 ? 'More liabilities than assets reprice in the year, so rising rates squeeze income.' : 'More assets than liabilities reprice in the year, so income benefits a little from rising rates, before NEV is considered.'}`,
            blocks: [moduleTable(spec, 'Repricing gap', ctx.runId, 'irr.gap', [{ field: 'band', headerName: 'Reprices or matures in', type: 'text' }, { field: 'assets', headerName: 'Assets', type: 'currency' }, { field: 'liabilities', headerName: 'Liabilities', type: 'currency' }, { field: 'gap', headerName: 'Gap', type: 'currency' }, { field: 'pct', headerName: 'Cumulative, % of assets', type: 'text' }], a.gap.map((g) => ({ band: g.label, assets: Math.round(g.assets), liabilities: Math.round(g.liabilities), gap: Math.round(g.gap), pct: `${g.cumulativePct.toFixed(1)}%` })))],
          };
        },
      },
      {
        name: 'irr_rate_types',
        description: 'Fixed and variable loan balances by category from each loan’s terms, what reprices by the next quarter, and where that differs from what the rate-risk model assumes.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const r = await irr.rateTypes();
          if (!r) return { text: 'Loan terms aren’t loaded for this institution yet, so DI can’t split loans into fixed and variable.', blocks: [] };
          const off = r.byCategory.filter((x) => x.differs);
          const lower = (c: string) => (c === 'HELOC' ? 'home equity lines' : c === 'Credit Card' ? 'credit cards' : c.toLowerCase());
          return {
            text: `**${pct1(r.variableShare)}** of open loans, ${m(r.variable)} of ${m(r.total)}, carry a variable rate; **${m(r.repricesSoon)}** has a rate change due by the next quarter.${off.length ? ` The rate-risk model treats ${off.map((x) => `${lower(x.category)} as ${x.modelAssumes.toLowerCase()} (${pct1(x.variableShare)} are variable)`).join(' and ')}, so its income sensitivity ${off.some((x) => x.modelAssumes === 'Fixed') ? 'understates how fast those loans reprice' : 'overstates how fast those loans reprice'}. Changing the model is the ALCO’s call.` : ' That matches what the rate-risk model assumes for each category.'}`,
            blocks: [moduleTable(spec, 'Fixed and variable loans', ctx.runId, 'irr.ratetypes', [{ field: 'category', headerName: 'Loan category', type: 'text' }, { field: 'fixed', headerName: 'Fixed', type: 'currency' }, { field: 'variable', headerName: 'Variable', type: 'currency' }, { field: 'share', headerName: 'Variable share', type: 'text' }, { field: 'soon', headerName: 'Rate changes by next quarter', type: 'currency' }, { field: 'model', headerName: 'Model assumes', type: 'text' }], r.byCategory.map((x) => ({ category: x.category, fixed: Math.round(x.fixed), variable: Math.round(x.variable), share: pct1(x.variableShare), soon: Math.round(x.repricesSoon), model: x.modelAssumes })))],
            suggestions: ['What’s our interest rate risk?', 'Show the repricing gap'],
          };
        },
      },
      {
        name: 'irr_assumptions',
        description: 'The modelling assumptions: balance sheet, shocks, market rate, prepayments, variable-rate loans, share decay and betas, investments and borrowings.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const a = await irr.analysis();
          return {
            text: `DI models a static balance sheet under instantaneous parallel shocks${a.bank ? ' and gradual ramps over a year, with net interest income for two years' : ''}. The behaviour the data can’t show is assumed, the way an ALM model does: prepayment speeds, how fast non-maturity ${a.bank ? 'deposits' : 'shares'} leave and how much of a rate move each product follows. Your ALM vendor’s assumptions may differ.`,
            blocks: [moduleTable(spec, 'Assumptions', ctx.runId, 'irr.assumptions', [{ field: 'item', headerName: 'Assumption', type: 'text' }, { field: 'detail', headerName: 'What DI uses', type: 'text' }], a.assumptions.map(([item, detail]) => ({ item, detail })))],
          };
        },
      },
    ],
  };
  return spec;
}
