// Interest rate risk on the shared module agent: NII at risk, NEV and the repricing gap under rate
// shocks, what drives them and the assumptions. Read-only, and honest that it is DI's estimate from
// core data, not the ALM model of record.
import { z } from 'zod';
import { CoreError, SHOCKS_BP, type AlcoService, type IrrService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const NO_ACCESS = 'Interest rate risk isn’t part of your DI access. It is for the finance team and executives.';
const guard = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('irr')) throw new CoreError('NO_ACCESS', NO_ACCESS);
};
const m = (n: number) => `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(1)}M`;
const pc = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`;
const bp = (s: number) => (s === 0 ? 'base' : `${s > 0 ? '+' : ''}${s} bp`);
/** "rise 200 bp", "plus 300 basis points", "down 1%", "-100": the shock in basis points, nearest modelled. */
export function shockFrom(text: string): number | null {
  const t = text.toLowerCase();
  const n = /([+-]?\d+(?:\.\d+)?)\s*(bp|bps|basis points?|%|percent)?/.exec(t.replace(/\bplus\s+/g, '+').replace(/\bminus\s+/g, '-'));
  if (!n) return null;
  let v = Number(n[1]);
  if (n[2] === '%' || n[2] === 'percent' || (!n[2] && Math.abs(v) <= 5)) v *= 100;
  if (/\b(fall|falls|drop|drops|down|decline|lower|cut)\b/.test(t) && v > 0) v = -v;
  return SHOCKS_BP.filter((s) => s).reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), 300);
}

/** Deposit pricing through the rate cycle, from the ALCO service: betas and new-loan yield. */
type Pricing = () => ReturnType<AlcoService['pricing']>;

export function irrModule(irr: IrrService, pricing?: Pricing): ModuleSpec {
  const spec: ModuleSpec = {
    id: 'irr',
    prefix: 'irr',
    agent: 'Interest Rate Risk',
    request: /^(?![\s\S]*\b(?:leave|leaving|left|outflows?|run ?off|runoff|flight|uninsured|deposit mix|unrealized|aoci|accumulated other comprehensive|underwater|bond portfolio|securities portfolio|fee income|non-?interest income|noninterest income|mortgage banking|diversif\w*)\b)[\s\S]*(?:\bdeposit betas?\b|\bbetas? on (deposits|shares)\b|\bdeposit pricing\b|\bpassed on (the|rate)|\byield on new loans\b|\bnew loan yield\b|\binterest rate risk\b|\birr\b|\bnev\b|\beve\b|economic value of equity|net economic value|\bnii at risk\b|net interest income at risk|rate shocks?|\bif rates (rise|fall|go up|go down|drop|increase|decrease)|repricing gap|\brate sensitivity\b|\b(alm|asset.liability)\b)/i,
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'Loans, deposits and certificates', ref: 'table:cdm_loan' }],
    prompt: ({ tenant, user, title }) => `You are the Interest Rate Risk agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) reviews interest rate risk for the ALCO. DI estimates it from core data: 12-month net interest income (NII) at risk, net economic value (NEV) and the NEV ratio under parallel shocks of ${SHOCKS_BP.filter((s) => s).join(', ')} bp, and the repricing gap. The ALM vendor's model remains the one of record; say so when asked about filing or exams.

- "What's our interest rate risk?", "are we within limits?": irr_summary.
- "What happens to NII if rates rise 200 bp?", "NEV at minus 100?": irr_scenario with shock_bp.
- "What drives our rate risk?", "why does NEV fall?": irr_drivers with shock_bp (default 300).
- "Show the repricing gap": irr_gap.
- "What assumptions does the model use?": irr_assumptions.
- "What's our deposit beta?", "how much of the rate cuts did we pass on?", "what do new loans yield against the book?": irr_pricing.
- You are read-only and do not give investment or hedging advice; describe the exposure and let the ALCO decide.`,
    plan: (text) => {
      const t = text.toLowerCase();
      if (pricing && !/assum|model/.test(t) && /\bbetas?\b|deposit pricing|passed on|pass[- ]through|cost of (deposits|shares)|new loan yield|yield on new loans|new loans (yield|price)/.test(t)) return { tool: 'irr_pricing', args: {} };
      if (/assumption|how (is|does) (this|it|the model)|prepay|beta|decay/.test(t)) return { tool: 'irr_assumptions', args: {} };
      if (/\bgap\b|reprice|repricing|maturit/.test(t)) return { tool: 'irr_gap', args: {} };
      if (/drive|driver|why|which products|what causes/.test(t)) return { tool: 'irr_drivers', args: { shock_bp: shockFrom(t) ?? 300 } };
      const s = shockFrom(t);
      if (s !== null && /\d/.test(t)) return { tool: 'irr_scenario', args: { shock_bp: s } };
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
        description: 'NII at risk and NEV under every rate shock, against the board’s limits, with the worst case for each.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const a = await irr.analysis();
          const worstNii = [...a.scenarios].sort((x, y) => x.niiPct - y.niiPct)[0]!;
          const worstNev = [...a.scenarios].sort((x, y) => x.nevPct - y.nevPct)[0]!;
          const breaches = a.scenarios.filter((x) => !x.withinLimits);
          return {
            text: `Net interest income over the next 12 months is **${m(a.base.nii)}** at today’s rates. The worst case is ${bp(worstNii.shockBp)}, **${pc(worstNii.niiPct)}**. NEV is **${m(a.base.nev)}** (an NEV ratio of ${a.base.nevRatio.toFixed(1)}%); its worst case is ${bp(worstNev.shockBp)}, **${pc(worstNev.nevPct)}**, leaving an NEV ratio of ${worstNev.nevRatio.toFixed(1)}%. ${breaches.length ? `${breaches.map((b) => bp(b.shockBp)).join(' and ')} ${breaches.length === 1 ? 'breaches' : 'breach'} the board’s limits.` : `Every scenario is within the board’s limits (NII down at most ${a.limits.niiDeclinePct}%, NEV down at most ${a.limits.nevDeclinePct}%, NEV ratio at least ${a.limits.nevRatioMinPct}%).`} This is DI’s estimate from core data; the ALM vendor’s model is the one of record.`,
            blocks: [moduleTable(spec, 'Rate shocks', ctx.runId, 'irr.scenarios', [{ field: 'shock', headerName: 'Rate shock', type: 'text' }, { field: 'nii', headerName: 'NII, next 12 months', type: 'currency' }, { field: 'niiPct', headerName: 'NII change', type: 'text' }, { field: 'nev', headerName: 'NEV', type: 'currency' }, { field: 'nevPct', headerName: 'NEV change', type: 'text' }, { field: 'ratio', headerName: 'NEV ratio', type: 'text' }, { field: 'limits', headerName: 'Board limits', type: 'text' }], a.scenarios.map((x) => ({ shock: x.shockBp ? bp(x.shockBp) : 'Base', nii: Math.round(x.nii), niiPct: x.shockBp ? pc(x.niiPct) : '', nev: Math.round(x.nev), nevPct: x.shockBp ? pc(x.nevPct) : '', ratio: `${x.nevRatio.toFixed(2)}%`, limits: x.withinLimits ? 'Within' : 'Breach' })))],
            suggestions: ['What drives our interest rate risk at plus 300 basis points?', 'Show the repricing gap'],
          };
        },
      },
      {
        name: 'irr_scenario',
        description: 'One rate shock: the change in 12-month NII and in NEV, the NEV ratio after it, and whether it is within limits.',
        input: z.object({ shock_bp: z.number().int().min(-400).max(400) }).strict(),
        run: async (a0: { shock_bp: number }, ctx) => {
          guard(ctx);
          const a = await irr.analysis();
          const s = a.scenarios.find((x) => x.shockBp === a0.shock_bp) ?? a.scenarios.find((x) => x.shockBp === 300)!;
          return {
            text: `If rates ${s.shockBp > 0 ? 'rise' : 'fall'} ${Math.abs(s.shockBp)} bp at once, net interest income over the next 12 months ${s.niiChange < 0 ? 'falls' : 'rises'} **${m(Math.abs(s.niiChange))}** (${pc(s.niiPct)}) to ${m(s.nii)}, and NEV ${s.nevChange < 0 ? 'falls' : 'rises'} **${m(Math.abs(s.nevChange))}** (${pc(s.nevPct)}) to ${m(s.nev)}, an NEV ratio of ${s.nevRatio.toFixed(1)}%. That is ${s.withinLimits ? 'within' : '**outside**'} the board’s limits.`,
            suggestions: [`What drives our interest rate risk at ${s.shockBp > 0 ? 'plus' : 'minus'} ${Math.abs(s.shockBp)} basis points?`],
          };
        },
      },
      {
        name: 'irr_drivers',
        description: 'Each product’s contribution to the change in NII and in NEV at a shock: which loans, investments and shares drive the risk.',
        input: z.object({ shock_bp: z.number().int().min(-400).max(400).default(300) }).strict(),
        run: async (a0: { shock_bp: number }, ctx) => {
          guard(ctx);
          const a = await irr.analysis();
          const d = [...a.drivers].sort((x, y) => x.nevChange - y.nevChange);
          const hurt = d.filter((x) => x.nevChange < 0).slice(0, 2);
          const help = d.filter((x) => x.nevChange > 0).slice(-2).reverse();
          return {
            text: `At +300 bp, NEV falls mostly through ${hurt.map((x) => `**${x.name.toLowerCase()}** (${m(x.nevChange)}, ${m(x.balance)} at ${x.rate.toFixed(2)}%)`).join(' and ')}: fixed-rate assets lose value as rates rise. ${help.length ? `${help.map((x) => x.name.toLowerCase()).join(' and ')} offset part of it, because low-rate deposits and shares are worth more as rates rise.` : ''} For income, certificates and money market repricing up cost more than variable-rate loans and maturing investments earn back.${a0.shock_bp !== 300 ? ' (DI breaks drivers down at +300 bp, the shock examiners look at most.)' : ''}`,
            blocks: [moduleTable(spec, 'What drives the change at +300 bp', ctx.runId, 'irr.drivers', [{ field: 'name', headerName: 'Product', type: 'text' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'rate', headerName: 'Rate', type: 'text' }, { field: 'nii', headerName: 'NII change', type: 'currency' }, { field: 'nev', headerName: 'NEV change', type: 'currency' }], [...a.drivers].sort((x, y) => Math.abs(y.nevChange) - Math.abs(x.nevChange)).map((x) => ({ name: x.name, balance: Math.round(x.balance), rate: `${x.rate.toFixed(2)}%`, nii: Math.round(x.niiChange), nev: Math.round(x.nevChange) })))],
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
        name: 'irr_assumptions',
        description: 'The modelling assumptions: balance sheet, shocks, market rate, prepayments, variable-rate loans, share decay and betas, investments and borrowings.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const a = await irr.analysis();
          return {
            text: `DI models a static balance sheet under instantaneous parallel shocks. The behaviour the data can’t show is assumed, the way an ALM model does: prepayment speeds, how fast non-maturity shares leave and how much of a rate move each product follows. Your ALM vendor’s assumptions may differ.`,
            blocks: [moduleTable(spec, 'Assumptions', ctx.runId, 'irr.assumptions', [{ field: 'item', headerName: 'Assumption', type: 'text' }, { field: 'detail', headerName: 'What DI uses', type: 'text' }], a.assumptions.map(([item, detail]) => ({ item, detail })))],
          };
        },
      },
    ],
  };
  return spec;
}
