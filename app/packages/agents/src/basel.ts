// Basel III capital (Board / regulatory pack): the risk-based ratios a bank CFO tracks even under the
// community bank leverage ratio. DI builds risk-weighted assets and the four ratios from the Call
// Report it holds, compares the full rules with the CBLR, runs the ratios through the stress test and
// answers "what if we add $20M of CRE?". Every figure is DI's estimate, with its assumptions shown;
// the bank files RC-R Part II itself only if it leaves the CBLR. Basel III does not apply to credit
// unions, so a credit union hears about its net worth ratio instead.
import { z } from 'zod';
import type { Block, DiTake, TableBlock } from '@dinext/block-schemas';
import { BASEL_THRESHOLDS, BaselService, CBLR_PCT, CONSERVATION_BUFFER, CoreError, StressService, type RatioKey } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { moduleTable, type ModuleContext, type ModuleSpec, type ModuleView } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

export interface BaselDeps {
  pool: Pool;
  institutionType: 'credit_union' | 'bank';
}

const p2 = (n: number) => `${n.toFixed(2)}%`;
const m = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n) >= 1e9 ? `${(Math.abs(n) / 1e9).toFixed(2)}B` : `${(Math.abs(n) / 1e6).toFixed(1)}M`}`;
const pts = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)} pts`;
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const NOTE = 'DI’s estimate from the Call Report and the assumptions shown, not a filed RC-R Part II.';
const AGENT = 'Basel III capital';

export const BASEL_SECTIONS = ['basel.ratios', 'basel.capital', 'basel.rwa', 'basel.trend', 'basel.cblr', 'basel.stress', 'basel.assumptions'] as const;

/** What can be added for a what-if, with its risk weight. */
const WHAT_IF: [RegExp, string, number][] = [
  [/\bhvcre\b|\bhigh[- ]volatility\b/i, 'high-volatility commercial real estate', 150],
  [/\bconstruction\b|\bland\b/i, 'construction loans', 100],
  [/\bmultifamily\b|\bapartment/i, 'multifamily loans', 100],
  [/\bcre\b|\bcommercial real estate\b|\binvestor real estate\b/i, 'commercial real estate loans', 100],
  [/\bc&i\b|\bcommercial (?:and|&) industrial\b|\bbusiness loans?\b|\bcommercial loans?\b/i, 'commercial and industrial loans', 100],
  [/\bheloc|\bhome equity\b/i, 'home equity lines', 100],
  [/\bmortgage|\bresidential\b|\bhome loans?\b/i, 'first-lien residential mortgages', 50],
  [/\bauto\b|\bcar loans?\b|\bvehicle/i, 'auto loans', 100],
  [/\bconsumer\b|\bpersonal loans?\b|\bcredit cards?\b/i, 'consumer loans', 100],
  [/\btreasur/i, 'US Treasuries', 0],
  [/\bginnie\b/i, 'Ginnie Mae securities', 0],
  [/\bagency\b|\bmbs\b|\bmortgage[- ]backed\b|\bfannie\b|\bfreddie\b/i, 'agency mortgage-backed securities', 20],
  [/\bmuni/i, 'municipal general obligation bonds', 20],
];
const amountIn = (t: string) => {
  const x = /\$?\s?(\d+(?:\.\d+)?)\s?(mm\b|m\b|million\b|k\b|thousand\b|b\b|billion\b)?/i.exec(t);
  if (!x) return null;
  const n = Number(x[1]) * ({ k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 } as Record<string, number>)[(x[2] ?? 'm').toLowerCase()]!;
  return /[-−]\s?\$?\d|\bsell(?:ing)?\b|\brun(?:s|ning)? ?off\b|\breduc|\bshrink|\bless\b/i.test(t) ? -n : n;
};

type View = NonNullable<Awaited<ReturnType<BaselService['analysis']>>>;

const ratioStatus = (pct: number, key: RatioKey) => {
  const t = BASEL_THRESHOLDS[key];
  return pct >= t.well ? (t.buffered === null || pct >= t.buffered ? 'Well capitalized' : 'Well capitalized, inside the buffer') : pct >= t.minimum ? 'Adequately capitalized' : 'Below the minimum';
};

/** The CFO's one-paragraph read: the ratios, the buffer, the tightest constraint and the CBLR beside it. */
export function baselHeadline(v: View) {
  const n = v.now;
  const [cet1, tier1, total] = n.ratios;
  const allWell = n.ratios.every((r) => r.pct >= r.well);
  const cblrTighter = n.cblr.above < n.binding.aboveWell;
  return `On DI’s estimate, CET1 is **${p2(cet1!.pct)}**, tier 1 **${p2(tier1!.pct)}** and total capital **${p2(total!.pct)}** of ${m(n.rwa)} in risk-weighted assets (${n.density.toFixed(0)}% of total assets)${allWell ? ', all above well capitalized' : ''}. The conservation buffer is ${n.bufferPct.toFixed(2)} points against the ${CONSERVATION_BUFFER} points required, so ${n.distributionsLimited ? 'dividends and bonuses would be limited' : 'dividends and bonuses aren’t limited'}. The tightest is ${n.binding.short === 'Leverage' ? 'the leverage ratio' : n.binding.short.toLowerCase() === 'total capital' ? 'total capital' : n.binding.short}, ${m(n.binding.aboveWell)} above well capitalized.${n.cblr.elected ? ` Under the community bank leverage ratio the bank has elected, ${p2(n.cblr.leveragePct)} is ${m(n.cblr.above)} above the ${CBLR_PCT}% requirement${cblrTighter ? ', so the CBLR is the tighter of the two' : ''}.` : ''}`;
}

type Who = Pick<ModuleSpec, 'agent' | 'sources'>;
const blocksFor = (who: Who, runId: string, v: View) => {
  const n = v.now;
  const t = (title: string, op: string, cols: TableBlock['data']['columns'], rs: Record<string, string | number>[], subtitle?: string) => ({ ...moduleTable(who, title, runId, op, cols, rs, n.end), ...(subtitle ? { subtitle } : {}) }) as Block;
  const c = n.capital;
  const severe = v.stress?.find((s) => s.key === 'severe');
  return {
    ratios: t(`Basel III ratios, ${n.quarter}`, 'basel.ratios', [text('ratio', 'Ratio'), text('now', 'Now'), text('minimum', 'Minimum'), text('buffered', 'With the buffer'), text('well', 'Well capitalized'), { field: 'above', headerName: 'Above well capitalized', type: 'currency' }, text('status', 'Where it stands')], n.ratios.map((r) => ({ ratio: r.name, now: p2(r.pct), minimum: `${r.minimum}%`, buffered: r.buffered === null ? '—' : `${r.buffered}%`, well: `${r.well}%`, above: Math.round(r.aboveWell), status: ratioStatus(r.pct, r.key) })), NOTE),
    capital: t('Regulatory capital', 'basel.capital', [text('item', 'Item'), { field: 'amount', headerName: 'Amount', type: 'currency' }, text('note', 'How it counts')], [
      { item: 'Total bank equity capital', amount: Math.round(c.equity), note: 'RCON3210.' },
      { item: c.aoci < 0 ? 'Add back: accumulated other comprehensive loss' : 'Less: accumulated other comprehensive income', amount: Math.round(Math.abs(c.aoci)), note: 'Removed under the AOCI opt-out election, so unrealized securities gains and losses don’t move regulatory capital.' },
      { item: 'Less: goodwill and other intangibles', amount: Math.round(c.deductions), note: c.deductions ? 'RCONP841 and RCONP842: a core deposit intangible and goodwill from a branch purchase. No deferred tax assets to deduct.' : 'None on the balance sheet DI holds.' },
      { item: 'Common equity tier 1 capital', amount: Math.round(c.cet1), note: 'RCONP742.' },
      { item: 'Additional tier 1 capital', amount: Math.round(c.additionalTier1), note: 'No noncumulative perpetual preferred stock.' },
      { item: 'Tier 1 capital', amount: Math.round(c.tier1), note: 'RCON8274.' },
      { item: 'Allowance for credit losses, counted in tier 2', amount: Math.round(c.allowanceInTier2), note: `Up to 1.25% of risk-weighted assets (${m(n.rwa * 0.0125)}); ${c.allowanceExcluded > 0 ? `${m(c.allowanceExcluded)} is over the limit and excluded` : 'all of it counts'}.` },
      { item: 'Subordinated debt', amount: 0, note: 'None.' },
      { item: 'Tier 2 capital', amount: Math.round(c.tier2), note: '' },
      { item: 'Total capital', amount: Math.round(c.totalCapital), note: 'Tier 1 plus tier 2.' },
    ]),
    rwa: t('Risk-weighted assets', 'basel.rwa', [text('group', 'Group'), text('name', 'Item'), { field: 'exposure', headerName: 'Exposure', type: 'currency' }, text('weight', 'Risk weight'), { field: 'rwa', headerName: 'Risk-weighted', type: 'currency' }, text('basis', 'Basis')], [...n.lines.filter((l) => l.exposure > 0).map((l) => ({ group: l.group, name: l.name, exposure: Math.round(l.exposure), weight: `${l.weightPct}%`, rwa: Math.round(l.rwa), basis: l.basis })), { group: 'Total', name: 'Risk-weighted assets', exposure: Math.round(n.totalAssets), weight: `${n.density.toFixed(0)}%`, rwa: Math.round(n.rwa), basis: 'Exposure total is the balance sheet; off-balance-sheet lines are after conversion.' }], `Loans carry an average weight of ${n.loanWeightPct.toFixed(0)}%. Off-balance-sheet exposures are shown after their credit conversion factors.`),
    trend: t('Basel III ratios by quarter', 'basel.trend', [text('quarter', 'Quarter'), { field: 'rwa', headerName: 'Risk-weighted assets', type: 'currency' }, text('cet1', 'CET1'), text('tier1', 'Tier 1'), text('total', 'Total capital'), text('leverage', 'Leverage')], v.quarters.map((q) => ({ quarter: q.quarter, rwa: Math.round(q.rwa), cet1: p2(q.ratios[0]!.pct), tier1: p2(q.ratios[1]!.pct), total: p2(q.ratios[2]!.pct), leverage: p2(q.ratios[3]!.pct) }))),
    cblr: t('Community bank leverage ratio or the full rules', 'basel.cblr', [text('item', ''), text('cblr', 'CBLR'), text('full', 'Full Basel III rules')], [
      { item: 'What applies', cblr: `Tier 1 leverage ratio over ${CBLR_PCT}%`, full: 'CET1 6.5%, tier 1 8%, total 10% and leverage 5% to be well capitalized, plus the 2.5% buffer' },
      { item: 'Where the bank stands', cblr: p2(n.cblr.leveragePct), full: `CET1 ${p2(n.ratios[0]!.pct)}, tier 1 ${p2(n.ratios[1]!.pct)}, total ${p2(n.ratios[2]!.pct)}, leverage ${p2(n.ratios[3]!.pct)}` },
      { item: 'Room, in capital', cblr: `${m(n.cblr.above)} above ${CBLR_PCT}%`, full: `${m(n.binding.aboveWell)} above well capitalized (${n.binding.short === 'Leverage' ? 'leverage' : n.binding.short.toLowerCase()} is tightest)` },
      { item: 'Room, in asset growth at today’s mix', cblr: m(n.cblr.above / (CBLR_PCT / 100)), full: m(Math.min(...n.ratios.map((r) => r.aboveWell / ((r.well / 100) * (r.key === 'leverage' ? 1 : n.density / 100))))) },
      { item: 'In the severely adverse stress test', cblr: severe ? `Low of ${p2(severe.lowLeverage.leveragePct)}, ${pts(severe.lowLeverage.leveragePct - CBLR_PCT)} above ${CBLR_PCT}%` : '—', full: severe ? `CET1 low ${p2(severe.lowCet1.cet1Pct)}, total capital low ${p2(severe.lowTotal.totalPct)}` : '—' },
      { item: 'Eligibility', cblr: `${n.cblr.eligible ? 'Eligible' : 'Not eligible'}: assets ${m(n.totalAssets)} (under $10B), off-balance-sheet exposures ${n.cblr.obsPct.toFixed(1)}% of assets (25% at most)`, full: 'Every bank' },
      { item: 'Reporting', cblr: 'RC-R Part I only', full: 'RC-R Part II as well: risk-weighting every exposure each quarter' },
    ], n.cblr.elected ? 'The bank has elected the CBLR. If its leverage ratio falls below 8%, a grace period applies before it must report under the full rules.' : 'The bank has not elected the CBLR.'),
    stress: t('Stress test: Basel III ratios at their lowest', 'basel.stress', [text('scenario', 'Scenario'), text('cet1', 'CET1 low'), text('total', 'Total capital low'), text('leverage', 'Leverage low'), text('read', 'Against well capitalized and the CBLR')], (v.stress ?? []).map((s) => ({ scenario: s.name, cet1: `${p2(s.lowCet1.cet1Pct)}, ${s.lowCet1.quarter}`, total: `${p2(s.lowTotal.totalPct)}, ${s.lowTotal.quarter}`, leverage: `${p2(s.lowLeverage.leveragePct)}, ${s.lowLeverage.quarter}`, read: `${s.lowCet1.cet1Pct >= 6.5 && s.lowTotal.totalPct >= 10 && s.lowLeverage.leveragePct >= 5 ? 'Stays well capitalized' : 'Falls below well capitalized'}; ${s.lowLeverage.leveragePct >= CBLR_PCT ? `stays over the CBLR’s ${CBLR_PCT}%` : `falls below the CBLR’s ${CBLR_PCT}%`}` })), 'DI’s illustrative scenarios from the stress test. Risk-weighted assets move with total assets, less loans charged off.'),
    assumptions: t('Basel III assumptions', 'basel.assumptions', [text('item', 'Assumption'), text('detail', 'Detail')], v.assumptions.map(([item, detail]) => ({ item, detail }))),
  };
};

/** A credit union's answer: Basel III is for banks; its capital is the net worth ratio. */
async function creditUnionView(pool: Pool): Promise<ModuleView> {
  const s = await new StressService(pool, 'credit_union').start();
  const nw = s ? (s.capital / s.assets) * 100 : null;
  return {
    text: `Basel III’s capital rules apply to banks, not credit unions. A credit union’s capital is its **net worth ratio** under NCUA’s prompt corrective action rules, well capitalized at 7%${nw !== null ? `; ours is **${p2(nw)}**` : ''}. A complex credit union (over $500 million in assets) also meets NCUA’s risk-based capital ratio, or opts into the complex credit union leverage ratio (CCULR) instead.`,
    suggestions: ['Run the stress test', 'Show our CAMELS view'],
  };
}

export function baselModule(deps: BaselDeps): ModuleSpec {
  const noAccess = 'Basel III capital is for finance and executives.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('basel')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const svc = new BaselService(deps.pool, deps.institutionType);
  const load = async () => {
    const v = await svc.analysis();
    if (!v) throw new CoreError('NOT_FOUND', 'There’s no FFIEC Call Report on file yet, so DI can’t build the Basel III ratios.');
    return v;
  };
  const bank = deps.institutionType === 'bank';
  const spec: ModuleSpec = {
    id: 'basel',
    prefix: 'bas',
    agent: AGENT,
    // A chart of a ratio ("chart CET1 by quarter") goes to Analytics, which draws it from the catalog.
    request: /^(?![\s\S]*\b(?:chart|graph|plot)\b)[\s\S]*?(?:\bbasel\b|\brisk[- ]weighted\b|\brwa\b|\brisk[- ]weights?\b|\brisk[- ]based (?:capital|ratios?)\b|\bcet ?1\b|\bcommon equity tier 1\b|\btier 2\b|\btotal capital ratio\b|\btier 1 (?:risk[- ]based )?capital ratio\b|\bconservation buffer\b|\bwell[- ]capitali[sz]ed\b|\bprompt corrective\b|\b(?:stay|remain|leave|exit|drop|opt out of|get out of)\b[^.?!]*\b(?:cblr|community bank leverage)\b|\b(?:cblr|community bank leverage ratio)\b[^.?!]*\b(?:or|vs\.?|versus|compared?|instead|full rules|risk[- ]based)\b|\bcapital ratios?\b[^.?!]*\$\s?\d|\$\s?\d[^.?!]*\bcapital ratios?\b)/i,
    noAccess,
    sources: [{ kind: 'table', label: 'FFIEC 051 Call Report values', ref: 'table:cr_value' }],
    prompt: ({ tenant, user, title }) => `You are the Basel III capital agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) reports capital to the board and examiners.

- "Show our Basel III capital", "what are our risk-based ratios?", "are we well capitalized?": bas_overview.
- "What counts as our capital?", "show tier 2": bas_capital. "What drives our risk-weighted assets?": bas_rwa.
- "How have our ratios moved?": bas_trend. "Should we stay in the CBLR?", "CBLR or the full rules?": bas_cblr.
- "What happens to our risk-based ratios in a severe recession?": bas_stress.
- "What would $20M more CRE loans do to our capital ratios?", "what if we add $20M of CRE?": bas_whatif with category and amount in dollars (negative to run off).
- "What does it assume?": bas_assumptions.
- Every figure is DI's estimate from the Call Report, not a filed RC-R Part II. Basel III applies to banks; for a credit union, explain the net worth ratio instead.`,
    plan: (t) => {
      if (/\bassum/i.test(t)) return { tool: 'bas_assumptions', args: {} };
      const kind = WHAT_IF.find(([re]) => re.test(t));
      if ((/\bwhat if\b|\bif we\b/i.test(t) || /\$\s?\d/.test(t)) && kind) {
        const amount = amountIn(t);
        if (amount) return { tool: 'bas_whatif', args: { category: kind[1], amount } };
      }
      if (/\bstress|\bsevere|\badverse\b|\brecession\b|\bdownturn\b|\bbaseline\b/i.test(t)) return { tool: 'bas_stress', args: {} };
      if (/\bcblr\b|\bcommunity bank leverage\b|\bopt (?:in|out)\b|\bfull rules\b/i.test(t)) return { tool: 'bas_cblr', args: {} };
      if (/\brisk[- ]weighted\b|\brwa\b|\brisk[- ]weights?\b|\bdensity\b/i.test(t)) return { tool: 'bas_rwa', args: {} };
      if (/\btrend\b|\bover time\b|\bby quarter\b|\bquarter by quarter\b|\bmoved?\b|\blast (?:year|five quarters)\b/i.test(t)) return { tool: 'bas_trend', args: {} };
      if (/\btier 2\b|\bcomponents?\b|\bwhat counts\b|\bdeduct|\bcapital stack\b|\bmake up\b|\bmade up\b/i.test(t)) return { tool: 'bas_capital', args: {} };
      return { tool: 'bas_overview', args: {} };
    },
    tools: [
      {
        name: 'bas_overview',
        description: 'The four Basel III ratios (CET1, tier 1, total capital, leverage) against their minimums, the conservation buffer and well capitalized, with the tightest constraint and the CBLR beside them.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          need(ctx);
          if (!bank) return creditUnionView(deps.pool);
          const v = await load();
          const b = blocksFor(spec, ctx.runId, v);
          return { text: `${baselHeadline(v)} ${NOTE}`, blocks: [b.ratios], suggestions: ['What drives our risk-weighted assets?', 'Should we stay in the CBLR?', 'What happens to our risk-based ratios in a severe recession?'] };
        },
      },
      {
        name: 'bas_capital',
        description: 'Regulatory capital from equity to total capital: AOCI, deductions, CET1, additional tier 1, tier 1, the allowance in tier 2 and total capital.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          need(ctx);
          if (!bank) return creditUnionView(deps.pool);
          const v = await load();
          const c = v.now.capital;
          return {
            text: `Equity of ${m(c.equity)}, ${c.aoci < 0 ? `with ${m(-c.aoci)} of unrealized securities losses in accumulated other comprehensive income added back` : `less ${m(c.aoci)} of accumulated other comprehensive income`} (the AOCI opt-out election), gives **CET1 of ${m(c.cet1)}**. With no preferred stock that is also tier 1. Tier 2 is the allowance, ${m(c.allowanceInTier2)}${c.allowanceExcluded > 0 ? ` (${m(c.allowanceExcluded)} over the 1.25% limit is excluded)` : ', all of it within the 1.25% limit'}, so **total capital is ${m(c.totalCapital)}**.`,
            blocks: [blocksFor(spec, ctx.runId, v).capital],
            suggestions: ['What are our risk-based ratios?', 'What drives our risk-weighted assets?'],
          };
        },
      },
      {
        name: 'bas_rwa',
        description: 'Risk-weighted assets by exposure: cash, securities, each loan type, other assets and off-balance-sheet commitments, with the weight and its basis.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          need(ctx);
          if (!bank) return creditUnionView(deps.pool);
          const v = await load();
          const n = v.now;
          const top = [...n.lines].sort((a, b) => b.rwa - a.rwa).slice(0, 3);
          const loans = n.lines.filter((l) => l.group === 'Loans').reduce((s, l) => s + l.rwa, 0);
          const obs = n.lines.filter((l) => l.group === 'Off-balance-sheet').reduce((s, l) => s + l.rwa, 0);
          return {
            text: `Risk-weighted assets are **${m(n.rwa)}**, ${n.density.toFixed(0)}% of ${m(n.totalAssets)} in total assets. Loans are ${m(loans)} of it (${((loans / n.rwa) * 100).toFixed(0)}%), at an average weight of ${n.loanWeightPct.toFixed(0)}%; unused commitments add ${m(obs)}. The largest are ${top.map((l) => `${l.name.toLowerCase()} (${m(l.rwa)} at ${l.weightPct}%)`).join(', ')}. Securities and cash weigh little: Treasuries and Ginnie Mae at 0%, agency securities at 20%.`,
            blocks: [blocksFor(spec, ctx.runId, v).rwa],
            suggestions: ['What would $20M more CRE loans do to our capital ratios?', 'What does the Basel III estimate assume?'],
          };
        },
      },
      {
        name: 'bas_trend',
        description: 'The Basel III ratios and risk-weighted assets for each quarter on file.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          need(ctx);
          if (!bank) return creditUnionView(deps.pool);
          const v = await load();
          const first = v.quarters[0]!;
          const last = v.now;
          return {
            text: `From ${first.quarter} to ${last.quarter}, CET1 went from ${p2(first.ratios[0]!.pct)} to **${p2(last.ratios[0]!.pct)}** and total capital from ${p2(first.ratios[2]!.pct)} to **${p2(last.ratios[2]!.pct)}**, as risk-weighted assets moved from ${m(first.rwa)} to ${m(last.rwa)} and CET1 from ${m(first.capital.cet1)} to ${m(last.capital.cet1)}. The leverage ratio went from ${p2(first.ratios[3]!.pct)} to ${p2(last.ratios[3]!.pct)}.`,
            blocks: [blocksFor(spec, ctx.runId, v).trend],
            suggestions: ['Should we stay in the CBLR?'],
          };
        },
      },
      {
        name: 'bas_cblr',
        description: 'The community bank leverage ratio against the full Basel III rules: where the bank stands, room in capital and in asset growth, the stress test, eligibility and reporting.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          need(ctx);
          if (!bank) return creditUnionView(deps.pool);
          const v = await load();
          const n = v.now;
          const severe = v.stress?.find((s) => s.key === 'severe');
          const cblrTighter = n.cblr.above < n.binding.aboveWell;
          return {
            text: `Under the CBLR the bank needs a leverage ratio over ${CBLR_PCT}%; at ${p2(n.cblr.leveragePct)} it has **${m(n.cblr.above)}** of room. Under the full rules its tightest constraint is ${n.binding.short === 'Leverage' ? 'the leverage ratio' : n.binding.short.toLowerCase()}, with **${m(n.binding.aboveWell)}** above well capitalized. ${cblrTighter ? `So the full rules would leave ${m(n.binding.aboveWell - n.cblr.above)} more room, because a ${n.density.toFixed(0)}% risk density gives the bank credit for its lower-risk assets; the CBLR’s price for simpler reporting is a higher bar.` : 'So the CBLR leaves more room as well as simpler reporting.'}${severe ? ` In the severely adverse stress test the leverage ratio falls to ${p2(severe.lowLeverage.leveragePct)}, ${severe.lowLeverage.leveragePct >= CBLR_PCT ? `${pts(severe.lowLeverage.leveragePct - CBLR_PCT)} above` : `${pts(CBLR_PCT - severe.lowLeverage.leveragePct)} below`} ${CBLR_PCT}%, while CET1 stays at ${p2(severe.lowCet1.cet1Pct)} or better.` : ''} The bank ${n.cblr.eligible ? 'remains eligible' : 'is not eligible'}: off-balance-sheet exposures are ${n.cblr.obsPct.toFixed(1)}% of assets (25% at most). Which to use is the board’s decision; this is what each leaves.`,
            blocks: [blocksFor(spec, ctx.runId, v).cblr],
            suggestions: ['What happens to our risk-based ratios in a severe recession?', 'What would $50M more CRE loans do to our capital ratios?'],
          };
        },
      },
      {
        name: 'bas_stress',
        description: 'The Basel III ratios through the stress test: the lowest CET1, total capital and leverage ratio under baseline, adverse and severely adverse scenarios.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          need(ctx);
          if (!bank) return creditUnionView(deps.pool);
          const v = await load();
          if (!v.stress) throw new CoreError('NOT_FOUND', 'The stress test needs the Call Report and loans, and one of them is missing.');
          const s = v.stress.find((x) => x.key === 'severe')!;
          const well = s.lowCet1.cet1Pct >= 6.5 && s.lowTotal.totalPct >= 10 && s.lowLeverage.leveragePct >= 5;
          return {
            text: `In the **severely adverse** scenario CET1 falls to **${p2(s.lowCet1.cet1Pct)}** in ${s.lowCet1.quarter} and total capital to **${p2(s.lowTotal.totalPct)}** in ${s.lowTotal.quarter}, ${well ? 'both well above well capitalized (6.5% and 10%)' : 'below well capitalized'}. The leverage ratio falls to ${p2(s.lowLeverage.leveragePct)} in ${s.lowLeverage.quarter}, ${s.lowLeverage.leveragePct >= CBLR_PCT ? `${pts(s.lowLeverage.leveragePct - CBLR_PCT)} above` : `${pts(CBLR_PCT - s.lowLeverage.leveragePct)} below`} the CBLR’s ${CBLR_PCT}%${s.lowLeverage.leveragePct - CBLR_PCT < Math.min(s.lowCet1.cet1Pct - 6.5, s.lowTotal.totalPct - 10) ? ': in a deep recession the leverage ratio, not the risk-based ratios, is what binds' : ''}. ${v.stress.filter((x) => x.key !== 'severe').map((x) => `${x.name}: CET1 low ${p2(x.lowCet1.cet1Pct)}`).join('; ')}. These are DI’s illustrative scenarios.`,
            blocks: [blocksFor(spec, ctx.runId, v).stress],
            suggestions: ['Should we stay in the CBLR?', 'Run the stress test'],
          };
        },
      },
      {
        name: 'bas_whatif',
        description: 'What adding (or running off, with a negative amount) loans or securities of one kind would do to the Basel III ratios and the CBLR, with capital unchanged. category such as "commercial real estate loans", "first-lien residential mortgages", "US Treasuries"; amount in dollars.',
        input: z.object({ category: z.string().min(3).max(60), amount: z.number().min(-5e9).max(5e9) }).strict(),
        run: async (a: { category: string; amount: number }, ctx): Promise<ModuleView> => {
          need(ctx);
          if (!bank) return creditUnionView(deps.pool);
          const kind = WHAT_IF.find(([re, name]) => re.test(a.category) || name === a.category.toLowerCase());
          if (!kind) throw new CoreError('INVALID', 'Which kind: commercial real estate, construction, multifamily, C&I, residential mortgages, home equity, auto, consumer, Treasuries, agency securities or municipal bonds?');
          const v = await load();
          const n = v.now;
          const w = svc.whatIf(n, kind[2], a.amount);
          const lev = w.ratios[3]!.pct;
          const verb = a.amount >= 0 ? 'Adding' : 'Running off';
          return {
            text: `${verb} **${m(Math.abs(a.amount))} of ${kind[1]}** (risk weight ${kind[2]}%) ${a.amount >= 0 ? 'adds' : 'removes'} ${m(Math.abs((a.amount * kind[2]) / 100))} of risk-weighted assets. With capital unchanged, CET1 goes from ${p2(n.ratios[0]!.pct)} to **${p2(w.ratios[0]!.pct)}**, total capital from ${p2(n.ratios[2]!.pct)} to **${p2(w.ratios[2]!.pct)}**, and the leverage ratio from ${p2(n.ratios[3]!.pct)} to **${p2(lev)}**, ${lev >= CBLR_PCT ? `${pts(lev - CBLR_PCT)} above` : `${pts(CBLR_PCT - lev)} below`} the CBLR’s ${CBLR_PCT}%. It’s funded from new deposits, so total assets grow by the same amount.`,
            blocks: [moduleTable(spec, `${verb} ${m(Math.abs(a.amount))} of ${kind[1]}`, ctx.runId, 'basel.whatif', [text('ratio', 'Ratio'), text('now', 'Now'), text('after', 'After'), text('well', 'Well capitalized')], n.ratios.map((r, i) => ({ ratio: r.name, now: p2(r.pct), after: p2(w.ratios[i]!.pct), well: r.key === 'leverage' ? `${r.well}% (CBLR ${CBLR_PCT}%)` : `${r.well}%` })), n.end)],
            suggestions: ['Should we stay in the CBLR?', 'What drives our risk-weighted assets?'],
          };
        },
      },
      {
        name: 'bas_assumptions',
        description: 'What the Basel III estimate assumes where the Call Report doesn’t give the risk weight: capital, cash, the securities mix, construction loans, multifamily, past due, commitments, thresholds and the stress test.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          need(ctx);
          if (!bank) return creditUnionView(deps.pool);
          const v = await load();
          return { text: `The Call Report gives balances but not every risk weight, so DI assumes the securities mix, which construction loans are high-volatility commercial real estate, and unused commitments (there’s no RC-L). Each assumption is below; replace any with the bank’s own capital worksheet and the ratios update. ${NOTE}`, blocks: [blocksFor(spec, ctx.runId, v).assumptions] };
        },
      },
    ],
  };
  return spec;
}

/** Basel III capital as report sections, for the Basel III report and the ALCO pack. */
export function baselAnalyses(deps: BaselDeps): ReportAnalyses {
  const svc = new BaselService(deps.pool, deps.institutionType);
  const runs = new Map<string, ReturnType<BaselService['analysis']>>();
  const once = (runId: string) => {
    if (!runs.has(runId)) {
      runs.set(runId, svc.analysis());
      if (runs.size > 8) runs.delete(runs.keys().next().value!);
    }
    return runs.get(runId)!;
  };
  return {
    keys: [...BASEL_SECTIONS],
    async run(key, runId): Promise<{ block: Block; take?: DiTake }> {
      const v = await once(runId);
      if (!v) throw new CoreError('NOT_FOUND', deps.institutionType === 'bank' ? 'There’s no FFIEC Call Report on file yet.' : 'Basel III applies to banks; a credit union reports its net worth ratio.');
      const who = { agent: AGENT, sources: [{ kind: 'table' as const, label: 'FFIEC 051 Call Report values', ref: 'table:cr_value' }] };
      const b = blocksFor(who, runId, v);
      const n = v.now;
      const severe = v.stress?.find((s) => s.key === 'severe');
      switch (key) {
        case 'basel.ratios':
          return { block: b.ratios, take: { headline: `CET1 ${p2(n.ratios[0]!.pct)}, tier 1 ${p2(n.ratios[1]!.pct)} and total capital ${p2(n.ratios[2]!.pct)} of ${m(n.rwa)} in risk-weighted assets${n.ratios.every((r) => r.pct >= r.well) ? ', all well capitalized' : ''}. The full rules leave ${m(n.binding.aboveWell)} of room${n.cblr.elected ? `; the CBLR’s ${CBLR_PCT}% leaves ${m(n.cblr.above)}` : ''}.`, action: { label: 'CBLR or full rules?', ask: 'Should we stay in the CBLR?' } } };
        case 'basel.capital':
          return { block: b.capital };
        case 'basel.rwa':
          return { block: b.rwa, take: { headline: `Risk-weighted assets are ${m(n.rwa)}, ${n.density.toFixed(0)}% of total assets; loans carry an average weight of ${n.loanWeightPct.toFixed(0)}%.`, action: { label: 'Add $20M of CRE?', ask: 'What would $20M more CRE loans do to our capital ratios?' } } };
        case 'basel.trend':
          return { block: b.trend };
        case 'basel.cblr':
          return { block: b.cblr };
        case 'basel.stress':
          return { block: b.stress, ...(severe ? { take: { headline: `In a severe downturn CET1 falls to ${p2(severe.lowCet1.cet1Pct)} and total capital to ${p2(severe.lowTotal.totalPct)}${severe.lowCet1.cet1Pct >= 6.5 && severe.lowTotal.totalPct >= 10 ? ', both well capitalized' : ''}; the leverage ratio falls to ${p2(severe.lowLeverage.leveragePct)} against the CBLR’s ${CBLR_PCT}%${severe.lowLeverage.leveragePct - CBLR_PCT < Math.min(severe.lowCet1.cet1Pct - 6.5, severe.lowTotal.totalPct - 10) ? ', so it binds first' : ''}.` } } : {}) };
        default:
          return { block: b.assumptions };
      }
    },
  };
}
