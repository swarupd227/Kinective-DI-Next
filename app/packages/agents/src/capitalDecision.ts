// "Plan our capital actions for next year": the decision framework's flagship for a bank CFO. Six
// specialists report their binding limits (capital floors, the CECL allowance, rate risk, concentration,
// liquidity and the severe stress test), the planner drafts a conservative, a balanced and a
// shareholder-return plan, the chief risk officer challenges them, and the recommendation ends in a board
// memo behind a high-risk approval card. Every figure is CapitalActionsModel's.
import { z } from 'zod';
import type { Block } from '@dinext/block-schemas';
import { CapitalActionsService, CapitalPlanService, CeclService, ConcentrationService, CoreError, IrrService, LiquidityService, LOAN_KEYS, LOAN_TYPES, StressService, type CapitalActionsModel, type CapitalLevers, type FileStore, type LoanKey, type PlanCheck, type PlanFigures } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { newBlockId } from './answer.ts';
import { runDecision, type Challenge, type DecisionCase, type DecisionOption, type Evaluated, type Finding, type Reply, type Specialist } from './decision.ts';
import type { ModuleContext, ModuleSpec } from './moduleAgent.ts';

export const CAPITAL_ACTIONS_REQUEST = /\b(?:plan|lay out|map out|work out|recommend|decide|set)\b[^.?!]{0,30}\bcapital (?:actions?|deployment)\b|\bcapital actions? (?:plan|for (?:next|the coming) year|for 20\d\d)\b|\bnext year'?s capital actions\b|\bboard memo on (?:our )?capital\b/i;
export const CAPITAL_ACTIONS_AGENT = 'Capital Actions';
const NO_ACCESS = 'Capital action planning isn’t part of your DI access. It is for a bank’s finance leaders.';
const MODULE = 'capactions';
const BOARD_FOLDER = 'Board Packs';

export const mm = (n: number) => `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(1)}M`;
export const mm2 = (n: number) => `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(2)}M`;
export const p2 = (n: number) => `${n.toFixed(2)}%`;
export const p1 = (n: number) => `${n.toFixed(1)}%`;
export const neg = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`;
export const usd = (n: number) => `$${n.toFixed(2)}`;
export const signed = (n: number) => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(1)}%`;
const count = (n: number) => Math.round(n).toLocaleString('en-US');
export const up100k = (n: number) => Math.ceil(n / 1e5) * 1e5;
export const down1m = (n: number) => Math.floor(n / 1e6) * 1e6;
export const up5m = (n: number) => Math.min(Math.ceil(n / 5e6) * 5e6, n + 5e6);

type Option = DecisionOption<CapitalLevers>;
type Result = Evaluated<CapitalLevers, PlanFigures>;
export const SOURCES: ModuleSpec['sources'] = [
  { kind: 'table', label: 'FFIEC 051 Call Report values', ref: 'table:cr_value' },
  { kind: 'table', label: 'Capital plan, as the CFO set it', ref: 'table:fin_capital_plan' },
  { kind: 'table', label: 'Loans and deposits', ref: 'table:cdm_loan' },
];

/** The loan growth mix each plan draws on, share of its total. */
export const MIX: Record<'conservative' | 'balanced', Partial<Record<LoanKey, number>>> = {
  conservative: { mortgage: 0.4, ci: 0.4, multifamily: 0.1, consumer: 0.1 },
  balanced: { mortgage: 0.35, ci: 0.35, multifamily: 0.15, other_cre: 0.1, consumer: 0.05 },
};
/** Loan types as they read mid-sentence. */
export const NOUN: Record<LoanKey, string> = { office: 'office CRE', multifamily: 'multifamily', other_cre: 'other CRE', ci: 'C&I', mortgage: 'residential mortgage', consumer: 'consumer and auto' };
/** Limits as they read mid-sentence. */
export const LIMIT_NOUN: Record<string, string> = { leverage: 'the leverage floor', cet1: 'the CET1 floor', eve200: 'EVE at +200 bp', eve400: 'EVE at +400 bp', liquidity: 'liquidity', office: 'office concentration', multifamily: 'multifamily concentration', cre: 'CRE concentration', allowance: 'the allowance' };
export const mixOf = (total: number, mix: Partial<Record<LoanKey, number>>) => Object.fromEntries(LOAN_KEYS.map((k) => [k, Math.round((total * (mix[k] ?? 0)) / 1e5) * 1e5])) as Record<LoanKey, number>;

/** How a check reads, for challenges and tables. */
export function describe(c: PlanCheck, f: PlanFigures, today: CapitalActionsModel['today']): string {
  const over = c.status === 'breach';
  switch (c.id) {
    case 'leverage':
      return over ? `Leverage a year ahead is ${p2(c.value)}, below its ${p2(c.limit)} floor (the CBLR’s 8% plus this plan’s severe stress decline).` : `Leverage ends at ${p2(c.value)} against a ${p2(c.limit)} floor; one bad quarter of earnings takes it through.`;
    case 'cet1':
      return over ? `CET1 a year ahead is ${p2(c.value)}, below its ${p2(c.limit)} floor.` : `CET1 ends at ${p2(c.value)}, close to its ${p2(c.limit)} floor.`;
    case 'eve200': {
      const room = f.eveBreachBp !== null ? Math.max(0, Math.round(f.eveBreachBp - 200)) : null;
      return over ? `EVE at +200 bp falls ${p1(c.value)}, past its −${c.limit}% limit.` : `Passes every floor but leaves EVE at ${neg(f.eve200)} at +200 bp against −${c.limit}%${room !== null ? `; about ${room} bp more of rates breaches it` : ''}.`;
    }
    case 'eve400':
      return c.today ? `EVE at +400 bp is over its −${c.limit}% limit today (${neg(today.eve[400])}), and this plan ${-f.eve400 > -today.eve[400] ? 'makes it worse' : 'leaves it'} at ${neg(f.eve400)}${over ? '' : ', just inside'}.` : over ? `EVE at +400 bp falls ${p1(c.value)}, past its −${c.limit}% limit.` : `EVE at +400 bp is ${neg(f.eve400)} against −${c.limit}%, at the edge.`;
    case 'liquidity':
      return over ? `Liquid assets fall to ${p2(c.value)} of assets, below the ${c.limit}% policy minimum.` : `Liquid assets end at ${p2(c.value)} of assets against the ${c.limit}% minimum.`;
    case 'office':
      return over ? `Office CRE reaches ${p1(c.value)} of capital, over its ${c.limit}% limit.` : `Office CRE reaches ${p1(c.value)} of capital against ${c.limit}%: ${f.officeRoom >= 5e4 ? `${mm(f.officeRoom)} of room left` : 'no room left'}.`;
    case 'multifamily':
      return `Multifamily reaches ${p1(c.value)} of capital against its ${c.limit}% limit.`;
    case 'cre':
      return `Non-owner-occupied CRE reaches ${Math.round(c.value)}% of capital against the ${c.limit}% guidance.`;
    case 'allowance':
      return over ? `The allowance is ${p1(c.value)} of DI’s CECL estimate: short.` : `Leaves the allowance ${mm2(f.ceclGap)} short of DI’s CECL estimate (${p1(c.value)} of it); capital goes out before reserves are topped up.`;
  }
}

/** The specialists every capital decision can call on, each through its own service. */
export function capitalSpecialists(pool: Pool): Specialist[] {
  const status = (s: string) => (s === 'Breach' || s === 'Over' ? 'breach' : s === 'Watch' ? 'watch' : 'pass') as Finding['status'];
  return [
    {
      id: 'capital',
      agent: 'Capital Plan',
      label: 'Capital Plan: floors and capacity',
      run: async () => {
        const a = (await new CapitalPlanService(pool).analysis())!;
        const lev = a.capacity.binding === 'leverage';
        return { specialist: 'capital', agent: 'Capital Plan', binding: `${lev ? 'Leverage ratio' : 'CET1'} floor`, current: p2(lev ? a.now.levPct : a.now.cet1Pct), limit: p2(lev ? a.floors.leverage : a.floors.cet1), headroom: `${mm(a.capacity.total)} capacity; dividends take ${mm(a.capacity.dividends)}, leaving ${mm(a.capacity.buybackRoom)}`, breachIf: `Paying out more than ${mm(a.capacity.total)} over the next four quarters`, status: 'pass' };
      },
    },
    {
      id: 'cecl',
      agent: 'CECL',
      label: 'CECL: the allowance against the estimate',
      run: async () => {
        const a = (await new CeclService(pool).analysis())!;
        return { specialist: 'cecl', agent: 'CECL', binding: 'Allowance against DI’s CECL estimate', current: `${mm2(a.now.allowance)} (${p1(a.bookedPct ?? 100)})`, limit: `${mm2(a.estimate.total)} estimate`, headroom: a.gap > 0 ? `${mm2(a.gap)} short` : `${mm2(-a.gap)} over`, breachIf: 'Under 90% of the estimate reads short; new loans need reserves at coverage', status: a.gap > 0 ? 'thin' : 'pass' };
      },
    },
    {
      id: 'irr',
      agent: 'Interest Rate Risk',
      label: 'Interest Rate Risk: EVE and NII limits',
      run: async () => {
        const a = await new IrrService(pool).analysis();
        const at = (bp: number) => a.scenarios.find((s) => s.shockBp === bp)!;
        const s2 = at(200);
        const s3 = at(300);
        const s4 = at(400);
        const room = -s3.nevPct > -s2.nevPct ? Math.round((100 * (s2.nevLimitPct + s2.nevPct)) / (s2.nevPct - s3.nevPct)) : null;
        return { specialist: 'irr', agent: 'Interest Rate Risk', binding: 'EVE at +200 bp', current: neg(s2.nevPct), limit: `−${s2.nevLimitPct}%`, headroom: `${(s2.nevLimitPct + s2.nevPct).toFixed(1)} points${room !== null ? `, about ${room} bp of rates` : ''}`, breachIf: `Fixed-rate loans funded by certificates, or cash paid out. EVE at +400 bp is ${neg(s4.nevPct)} against −${s4.nevLimitPct}%${s4.status === 'Breach' ? ', over its limit today' : ''}`, status: s4.status === 'Breach' || s2.status === 'Breach' ? 'breach' : status(s2.status) };
      },
    },
    {
      id: 'concentration',
      agent: 'Concentration',
      label: 'Concentration: CRE and office limits',
      run: async () => {
        const a = (await new ConcentrationService(pool).analysis())!;
        const office = a.property.find((p) => p.type === 'Office');
        const pct = office?.pctOfCapital ?? 0;
        const room = ((office?.limit ?? 50) / 100) * a.regulatory.capital - (office?.balance ?? 0);
        return { specialist: 'concentration', agent: 'Concentration', binding: 'Office CRE to capital', current: p1(pct), limit: `${office?.limit ?? 50}%`, headroom: `${mm(room)} of office loans at today’s capital; CRE is ${Math.round(a.regulatory.crePct)}% against ${a.limits.creGuidancePct}%`, breachIf: 'Office growth beyond that, or capital paid out, which shrinks the base', status: pct / (office?.limit ?? 50) >= 0.95 ? 'thin' : pct / (office?.limit ?? 50) >= 0.85 ? 'watch' : 'pass' };
      },
    },
    {
      id: 'liquidity',
      agent: 'Liquidity',
      label: 'Liquidity: the policy minimums',
      run: async () => {
        const a = await new LiquidityService(pool, 'bank').analysis();
        const r = a.ratios.find((x) => /liquid assets to total assets/i.test(x.name))!;
        const room = a.liquid - ((r.limit ?? 10) / 100) * a.totalAssets;
        return { specialist: 'liquidity', agent: 'Liquidity', binding: 'Liquid assets to total assets', current: p2(r.value), limit: `${r.limit ?? 10}%`, headroom: `${mm(room)} of cash`, breachIf: `Paying out more than ${mm(room)} in cash without new funding`, status: r.value / (r.limit ?? 10) < 1.05 ? 'watch' : 'pass' };
      },
    },
    {
      id: 'stress',
      agent: 'CAMELS and stress test',
      label: 'Stress test: the severely adverse trough',
      run: async () => {
        const a = (await new StressService(pool, 'bank').analysis())!;
        const severe = a.runs.find((r) => r.scenario.key === 'severe')!;
        const cushion = (severe.cushionPct / 100) * severe.trough.assets;
        return { specialist: 'stress', agent: 'CAMELS and stress test', binding: 'Leverage at the severe trough', current: `${p2(severe.trough.ratioPct)} in ${severe.trough.quarter}`, limit: `${a.start.minimumPct}%`, headroom: `${severe.cushionPct.toFixed(2)} points, about ${mm(cushion)} of capital`, breachIf: 'Riskier loans or payouts that use more of that cushion', status: severe.cushionPct < 0 ? 'breach' : severe.cushionPct < 0.75 ? 'watch' : 'pass' };
      },
    },
  ];
}

export function capitalCase(pool: Pool): DecisionCase<CapitalLevers, PlanFigures> & { model: () => CapitalActionsModel } {
  let m: CapitalActionsModel | null = null;
  const model = () => {
    if (!m) throw new Error('The capital model is not loaded');
    return m;
  };
  const specialists = capitalSpecialists(pool);

  const options = async (): Promise<Option[]> => {
    m = await new CapitalActionsService(pool).model();
    if (!m) throw new Error('No capital figures');
    const t = m.today;
    const loans = Object.entries(t.loanBalance).filter(([k]) => ['First mortgages', 'Commercial loans', 'Consumer loans', 'Commercial real estate', 'Auto loans'].includes(k)).reduce((s, [, v]) => s + v, 0);
    const growthPlan = t.cap.settings.rwaGrowth / 100;
    const topUp = up100k(Math.max(0, t.ceclGap));

    // Conservative: the dividend held, no buyback, slower growth away from office, reserves topped up. It
    // realizes no securities losses; the critic decides whether that can stand.
    const c = m.levers({ growth: mixOf(down1m(loans * growthPlan * 0.6), MIX.conservative), allowanceTopUp: topUp });

    // Balanced: growth at plan without office, reserves topped up, a buyback of half the room the capital plan
    // leaves, and the securities sale that keeps EVE at +400 bp inside its limit with room to spare. Then the
    // buyback is trimmed to whatever keeps every limit out of the thin zone.
    const half = Math.floor(t.cap.capacity.buybackRoom / 2 / 5e5) * 5e5;
    // The sale and the buyback pull on each other (the sale's loss uses capital, the buyback's cash uses EVE), so
    // settle them together: size the sale for the buyback, trim the buyback to what fits, and repeat.
    let b = m.levers({ growth: mixOf(down1m(loans * growthPlan), MIX.balanced), allowanceTopUp: topUp, buyback: half });
    for (let i = 0; i < 6; i++) {
      const sale = up5m(m.afsToClear({ ...b, afsSale: 0 }, 'eve400', { cushion: true }) ?? 0);
      const fits = Math.floor(m.maxBuyback({ ...b, afsSale: sale, buyback: 0 }, { cushion: true }) / 5e5) * 5e5;
      const buyback = Math.min(b.buyback, fits >= 1e6 ? fits : 0);
      const settled = sale === b.afsSale && buyback === b.buyback;
      b = { ...b, afsSale: sale, buyback };
      if (settled) break;
    }

    // Shareholder return: a higher dividend, growth at plan with office up to its room, and the largest
    // buyback the limits allow.
    let s = m.levers({ growth: mixOf(down1m(loans * growthPlan), MIX.balanced), dividendPerShareQ: Math.round((t.dividendPerShareQ + 0.03) * 100) / 100 });
    s = { ...s, growth: { ...s.growth, office: down1m(m.officeRoom(s, 0.97)) } };
    s = { ...s, buyback: m.maxBuyback(s) };

    return [
      { key: 'conservative', name: 'Conservative', stance: 'Protect capital, reserves and rate risk first; return only the dividend.', levers: c },
      { key: 'balanced', name: 'Balanced', stance: 'Grow at plan and return what the limits leave with room to spare.', levers: b },
      { key: 'shareholder', name: 'Shareholder return', stance: 'Return as much as the limits allow, now.', levers: s },
    ];
  };

  const critique = (o: Option, f: PlanFigures): Challenge[] =>
    f.checks
      .filter((c) => c.status === 'breach' || c.status === 'thin')
      .map((c) => ({ option: o.key, check: c.id, severity: c.status === 'breach' ? ('breach' as const) : ('thin' as const), text: describe(c, f, model().today) }));

  const revise = (o: Option, ch: Challenge): { levers: CapitalLevers; text: string } | null => {
    const mdl = model();
    const l = o.levers;
    const cushion = o.key !== 'shareholder';
    const before = mdl.evaluate(l);
    switch (ch.check) {
      case 'allowance': {
        const topUp = up100k(Math.max(0, mdl.today.ceclGap));
        return { levers: { ...l, allowanceTopUp: topUp }, text: `Top up the allowance by ${mm(topUp)} to DI’s CECL estimate; it costs ${mm2(topUp * 0.79)} after tax and pre-funds the same amount of severe stress losses.` };
      }
      case 'eve200':
      case 'eve400': {
        const exact = mdl.afsToClear(l, ch.check, { cushion });
        if (exact === null || exact <= l.afsSale) return null;
        const sale = Math.min(mdl.today.afs.book, up5m(exact));
        const f = mdl.evaluate({ ...l, afsSale: sale });
        return { levers: { ...l, afsSale: sale }, text: `Sell ${mm(sale)} of low-yield securities, realizing a ${mm(f.afsLoss)} loss (${mm(f.afsLossAfterTax)} after tax); EVE at +400 bp goes to ${neg(f.eve400)} and at +200 bp to ${neg(f.eve200)}${f.afsEarnbackYears ? `, and the reinvested proceeds earn the loss back in ${f.afsEarnbackYears.toFixed(1)} years` : ''}.` };
      }
      case 'office':
      case 'multifamily':
      case 'cre': {
        const key: LoanKey = ch.check === 'office' ? 'office' : ch.check === 'multifamily' ? 'multifamily' : 'other_cre';
        let amount = l.growth[key];
        for (let i = 0; i < 60 && amount > 0; i++) {
          const f = mdl.evaluate({ ...l, growth: { ...l.growth, [key]: amount } });
          const c = f.checks.find((x) => x.id === ch.check)!;
          if (c.status !== 'breach' && (!cushion || c.status !== 'thin')) break;
          amount = Math.max(0, amount - 1e6);
        }
        if (amount === l.growth[key]) return null;
        const f = mdl.evaluate({ ...l, growth: { ...l.growth, [key]: amount } });
        return { levers: { ...l, growth: { ...l.growth, [key]: amount } }, text: `Cut ${NOUN[key]} growth from ${mm(l.growth[key])} to ${mm(amount)}${key === 'office' ? `; office CRE ends at ${p1(f.officePct)} of capital` : ''}.` };
      }
      default: {
        // Capital or liquidity: the buyback gives way first, then growth.
        if (l.buyback > 0) {
          const buyback = mdl.maxBuyback({ ...l, buyback: 0 }, { cushion });
          if (buyback < l.buyback) {
            const f = mdl.evaluate({ ...l, buyback });
            return { levers: { ...l, buyback }, text: `Cut the buyback from ${mm(l.buyback)} to ${mm(buyback)}; leverage ends at ${p2(f.levPct)} against its ${p2(f.levFloor)} floor.` };
          }
        }
        let k = 1;
        for (let i = 0; i < 20; i++) {
          k -= 0.05;
          const f = mdl.evaluate({ ...l, growth: Object.fromEntries(LOAN_KEYS.map((x) => [x, l.growth[x] * k])) as Record<LoanKey, number> });
          const c = f.checks.find((x) => x.id === ch.check)!;
          if (c.status !== 'breach' && (!cushion || c.status !== 'thin')) break;
        }
        if (k >= 1 || k <= 0) return null;
        const growth = Object.fromEntries(LOAN_KEYS.map((x) => [x, Math.round((l.growth[x] * k) / 1e5) * 1e5])) as Record<LoanKey, number>;
        return { levers: { ...l, growth }, text: `Slow loan growth from ${mm(before.growth)} to ${mm(Object.values(growth).reduce((s, x) => s + x, 0))}.` };
      }
    }
  };

  const stands = (o: Option, ch: Challenge) => (o.key === 'shareholder' && ch.severity === 'thin' && ch.check !== 'allowance' ? 'This plan is built to use the room the limits leave; the board should see where the edge is, and it stays on the table as the upper bound.' : null);

  const recommend = (results: Result[], replies: Reply[]) => {
    const issues = (r: Result) => critique(r.option, r.figures);
    const eligible = results.filter((r) => !issues(r).some((x) => x.severity === 'breach'));
    const pick = [...(eligible.length ? eligible : results)].sort((a, b) => issues(a).length - issues(b).length || b.figures.epsRun - a.figures.epsRun)[0]!;
    const f = pick.figures;
    const t = model().today;
    const most = results.reduce((x, y) => (y.figures.payout > x.figures.payout ? y : x));
    const stood = replies.filter((r) => r.option === most.option.key && r.action === 'stands').length;
    const parts = [
      `It returns ${mm(f.payout)} to shareholders (${mm(f.dividends)} in dividends${f.buyback ? ` and a ${mm(f.buyback)} buyback` : ''}), grows loans ${mm(f.growth)} and lifts run-rate EPS ${signed(f.epsChangePct)} to ${usd(f.epsRun)}.`,
      `It keeps every limit out of the thin zone: leverage ${p2(f.levPct)} against its ${p2(f.levFloor)} floor, EVE at +200 bp ${neg(f.eve200)} against −${t.eve.limit200}%${f.levers.afsSale ? `, and EVE at +400 bp back inside its limit at ${neg(f.eve400)}` : ''}.`,
      f.levers.afsSale ? `The trade-off: the ${mm(f.afsLoss)} loss on the securities sale cuts next year’s EPS to ${usd(f.eps)}; the reinvested proceeds earn it back in ${f.afsEarnbackYears?.toFixed(1)} years.` : '',
      most.option.key !== pick.option.key ? `The ${most.option.name.toLowerCase()} plan returns ${mm(most.figures.payout - f.payout)} more but ${stood ? `stands on ${stood} thin limit${stood === 1 ? '' : 's'}` : 'leaves less room'}.` : '',
    ];
    return { key: pick.option.key, why: parts.filter(Boolean).join(' ') };
  };

  const rowsFor = (results: Result[]) => {
    const t = model().today;
    const row = (item: string, get: (f: PlanFigures) => string, now = '') => ({ item, now, ...Object.fromEntries(results.map((r) => [r.option.key, get(r.figures)])) });
    const growthText = (f: PlanFigures) => (f.growth ? `${mm(f.growth)}${f.levers.growth.office ? `, ${mm(f.levers.growth.office)} office` : ', no office'}` : 'None');
    const statusText = (f: PlanFigures) => {
      const b = f.breaches.length;
      const th = f.thin.length;
      return b ? `${b} breach${b === 1 ? '' : 'es'}` : th ? `${th} thin` : 'Clear';
    };
    return [
      row('Dividend a share, quarterly', (f) => usd(f.levers.dividendPerShareQ), usd(t.dividendPerShareQ)),
      row('Dividends over the year', (f) => mm(f.dividends)),
      row('Buyback', (f) => (f.buyback ? `${mm(f.buyback)} (${p1(f.retiredPct)} of shares)` : 'None')),
      row('Loan growth', growthText),
      row('Allowance top-up', (f) => (f.levers.allowanceTopUp ? mm(f.levers.allowanceTopUp) : 'None')),
      row('Low-yield securities sold (loss)', (f) => (f.levers.afsSale ? `${mm(f.levers.afsSale)} (${mm(f.afsLoss)})` : 'None')),
      row('Leverage ratio a year ahead (floor)', (f) => `${p2(f.levPct)} (${p2(f.levFloor)})`, `${p2(t.cap.now.levPct)} (${p2(t.cap.floors.leverage)})`),
      row('CET1 a year ahead', (f) => p2(f.cet1Pct), p2(t.cap.now.cet1Pct)),
      row('Leverage after severe stress', (f) => p2(f.levStressed), p2(t.cap.stress.levLow)),
      row('EPS next year', (f) => usd(f.eps), usd(t.eps)),
      row('EPS run rate', (f) => `${usd(f.epsRun)} (${signed(f.epsChangePct)})`),
      row('Tangible book value a share', (f) => usd(f.tbvps), usd(t.tbvps)),
      row(`EVE at +200 bp (limit −${t.eve.limit200}%)`, (f) => neg(f.eve200), neg(t.eve[200])),
      row(`EVE at +400 bp (limit −${t.eve.limit400}%)`, (f) => neg(f.eve400), neg(t.eve[400])),
      row(`Liquid assets to assets (minimum ${t.liquidMin}%)`, (f) => p2(f.liquidPct), p2(t.liquidPct)),
      row(`Office CRE to capital (limit ${t.limits.office}%)`, (f) => p1(f.officePct), p1(t.officePct)),
      row('Allowance against the CECL estimate', (f) => p1(f.ceclBookedPct), p1(t.ceclBookedPct)),
      row('Limits', statusText),
    ];
  };

  const blocks = (results: Result[], runId: string): Block[] => {
    const t = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
    const rows = rowsFor(results);
    return [
      {
        id: newBlockId('cap'),
        type: 'table',
        version: '1.0.0',
        title: 'Three capital plans for the next four quarters',
        subtitle: `Every figure computed by DI from the ${model().today.quarter} Call Report, the CECL estimate, the rate-risk model, the concentration limits, the liquidity policy and the severe stress test.`,
        provenance: { agent: CAPITAL_ACTIONS_AGENT, runId, operations: ['capactions.plans'], sources: SOURCES },
        freshness: { kind: 'workflow_event' },
        data: { columns: [t('item', ''), t('now', 'Today'), ...results.map((r) => t(r.option.key, r.option.name))], rows, rowCount: rows.length },
      } as Block,
    ];
  };

  const corpus = (results: Result[]) => {
    const t = model().today;
    const out = rowsFor(results).flatMap((r) => Object.values(r));
    for (const r of results) {
      const f = r.figures;
      out.push(mm(f.payout), mm(f.growth), usd(f.eps), usd(f.epsRun), signed(f.epsChangePct), mm(f.afsLoss), mm(f.afsLossAfterTax), f.afsEarnbackYears?.toFixed(1) ?? '', mm(Math.max(0, f.officeRoom)), neg(f.eve300), mm2(f.ceclGap), ...f.checks.map((c) => describe(c, f, t)));
    }
    out.push(mm(t.cap.capacity.total), mm(t.cap.capacity.dividends), mm(t.cap.capacity.buybackRoom), p2(t.cap.floors.leverage), mm2(t.ceclGap), '200 bp', '400 bp', '+200', '+400');
    return out;
  };

  const facts = (results: Result[]) =>
    rowsFor(results)
      .map((r) => `${r.item}: today ${r.now || 'n/a'}; ${results.map((x) => `${x.option.name} ${(r as Record<string, string>)[x.option.key]}`).join('; ')}`)
      .join('\n');

  const memo = (chosen: Result, why: string, results: Result[], replies: Reply[]) => ({
    tool: 'cap_memo',
    args: {
      recommended: chosen.option.key,
      plans: results.map((r) => ({ key: r.option.key, name: r.option.name, levers: r.option.levers })),
      why,
      settled: replies.map((r) => `${results.find((x) => x.option.key === r.option)?.option.name ?? r.option}, round ${r.round}: ${r.action === 'revise' ? 'revised' : 'stands'}. ${r.text}`).slice(0, 12),
    },
  });

  return {
    agent: CAPITAL_ACTIONS_AGENT,
    title: 'Capital actions for next year',
    planText: 'Here’s how I’ll work: I’ll ask the capital, CECL, rate-risk, concentration, liquidity and stress specialists for their binding limits at the same time, then draft three plans (conservative, balanced and shareholder return) and have DI compute each one a year ahead. The chief risk officer challenges every plan against the limits; I revise or defend each for up to two rounds, then recommend one and draft the board memo for your approval.',
    specialists,
    options,
    evaluate: (l) => model().evaluate(l),
    critique,
    stands,
    revise,
    nouns: LIMIT_NOUN,
    order: ['allowance', 'office', 'multifamily', 'cre', 'eve400', 'eve200', 'liquidity', 'cet1', 'leverage'],
    recommend,
    blocks,
    memo,
    corpus,
    facts,
    summary: (f) => `${f.binding}: ${f.current} against ${f.limit}; ${f.headroom}`,
    suggestions: ['What would a $5M buyback do?', 'Should we sell our low-yield securities at a loss?', 'What’s our interest rate risk?'],
    model,
  };
}

const LeverInput = z.object({
  dividendPerShareQ: z.number().min(0).max(5),
  buyback: z.number().min(0).max(1e9),
  growth: z.object(Object.fromEntries(LOAN_KEYS.map((k) => [k, z.number().min(0).max(1e9)])) as Record<LoanKey, z.ZodNumber>),
  allowanceTopUp: z.number().min(0).max(1e9),
  afsSale: z.number().min(0).max(1e10),
});
const MemoInput = z.object({
  recommended: z.string().max(40),
  plans: z.array(z.object({ key: z.string().max(40), name: z.string().max(60), levers: LeverInput })).min(1).max(4),
  why: z.string().max(1200),
  settled: z.array(z.string().max(500)).max(12),
});

/** The memo, written by code from the recomputed plans. */
export function capitalMemo(m: CapitalActionsModel, input: z.infer<typeof MemoInput>, from: { name: string; title: string }) {
  const t = m.today;
  const plans = input.plans.map((p) => ({ ...p, f: m.evaluate(m.levers(p.levers)) }));
  const rec = plans.find((p) => p.key === input.recommended) ?? plans[0]!;
  const f = rec.f;
  const l = f.levers;
  const growth = LOAN_TYPES.filter((x) => l.growth[x.key] > 0).map((x) => `${NOUN[x.key]} ${mm(l.growth[x.key])}`).join(', ');
  const year = Number(t.quarter.slice(-4)) + 1;
  const line = (label: string, get: (x: PlanFigures) => string) => `- ${label}: ${plans.map((p) => `${p.name} ${get(p.f)}`).join('; ')}`;
  const body = [
    `To: Board of Directors`,
    `From: ${from.name}, ${from.title}`,
    `Re: Capital actions for ${year}`,
    '',
    `Recommendation: the ${rec.name.toLowerCase()} plan.`,
    `- Quarterly dividend of ${usd(l.dividendPerShareQ)} a share (${mm(f.dividends)} over the year).`,
    f.buyback ? `- A buyback of up to ${mm(f.buyback)}: about ${count(f.retired)} shares (${p1(f.retiredPct)}) at today’s ${usd(t.price)}.` : '- No buyback.',
    `- Loan growth of ${mm(f.growth)}${growth ? `: ${growth}` : ''}${l.growth.office ? '' : '; no new office CRE'}.`,
    l.allowanceTopUp ? `- An allowance top-up of ${mm(l.allowanceTopUp)}, to DI’s CECL estimate.` : '- No allowance top-up.',
    l.afsSale ? `- Sell ${mm(l.afsSale)} of low-yield available-for-sale securities, realizing a ${mm(f.afsLoss)} loss (${mm(f.afsLossAfterTax)} after tax), reinvested at market rates; earn-back ${f.afsEarnbackYears?.toFixed(1)} years.` : '- No securities sale.',
    '',
    `Why: ${input.why}`,
    '',
    'A year ahead, by plan:',
    line(`Leverage ratio (floor)`, (x) => `${p2(x.levPct)} (${p2(x.levFloor)})`),
    line('CET1', (x) => p2(x.cet1Pct)),
    line('Leverage after severe stress', (x) => p2(x.levStressed)),
    line('Run-rate EPS', (x) => `${usd(x.epsRun)} (${signed(x.epsChangePct)})`),
    line('Tangible book value a share', (x) => usd(x.tbvps)),
    line(`EVE at +200 bp (limit −${t.eve.limit200}%)`, (x) => neg(x.eve200)),
    line(`EVE at +400 bp (limit −${t.eve.limit400}%)`, (x) => neg(x.eve400)),
    line(`Liquid assets to assets (minimum ${t.liquidMin}%)`, (x) => p2(x.liquidPct)),
    line(`Office CRE to capital (limit ${t.limits.office}%)`, (x) => p1(x.officePct)),
    '',
    'The chief risk officer’s challenges, and how they were settled:',
    ...input.settled.map((s) => `- ${s}`),
    '',
    `Asked of the board: declare the quarterly dividend${f.buyback ? `, authorize a buyback of up to ${mm(f.buyback)}` : ''}${l.afsSale ? ', and approve the securities sale' : ''}.`,
    `Figures are DI’s estimates from the ${t.quarter} Call Report and core data, not the models of record and not a supervisory rating.`,
  ].join('\n');
  return { rec, plans, memo: { to: ['Board of Directors'], subject: `Capital actions for ${year}: ${rec.name.toLowerCase()} plan recommended`, body: body.slice(0, 4000) } };
}

export interface CapitalActionsDeps {
  pool: Pool;
  files?: FileStore | null;
  today?: () => string;
}

export function capitalActionsModule(deps: CapitalActionsDeps): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes(MODULE)) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: MODULE,
    prefix: 'capactions',
    agent: CAPITAL_ACTIONS_AGENT,
    request: CAPITAL_ACTIONS_REQUEST,
    noAccess: NO_ACCESS,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You plan capital actions for ${tenant}. You are working with ${user}, ${title}.`,
    plan: () => ({ say: 'Ask me to plan your capital actions for next year.' }),
    run: (input, d, sink) => runDecision(spec, capitalCase(deps.pool), input, d, sink),
    tools: [
      {
        name: 'cap_memo',
        description: 'Draft the board memo for the recommended capital plan. Sending it needs approval.',
        input: MemoInput,
        run: async (args: z.infer<typeof MemoInput>, ctx) => {
          need(ctx);
          const m = await new CapitalActionsService(deps.pool).model();
          if (!m) throw new CoreError('NOT_FOUND', 'There are no capital figures to plan from yet.');
          const { rec, memo } = capitalMemo(m, args, { name: ctx.user.name, title: 'Chief Financial Officer' });
          const f = rec.f;
          const t = m.today;
          return {
            change: {
              summary: `Send the board the capital actions memo: the ${rec.name.toLowerCase()} plan`,
              changes: [
                { label: 'Dividend a share, quarterly', before: usd(t.dividendPerShareQ), after: usd(f.levers.dividendPerShareQ) },
                { label: 'Buyback', before: t.cap.settings.buybackPlanned ? mm(t.cap.settings.buybackPlanned) : 'None authorized', after: f.buyback ? `Up to ${mm(f.buyback)}` : 'None' },
                { label: 'Loan growth', before: '—', after: mm(f.growth) },
                { label: 'Allowance top-up', before: '—', after: f.levers.allowanceTopUp ? mm(f.levers.allowanceTopUp) : 'None' },
                { label: 'Securities sale', before: '—', after: f.levers.afsSale ? `${mm(f.levers.afsSale)}, ${mm(f.afsLoss)} loss` : 'None' },
                { label: 'Goes to', before: '—', after: `Board of Directors, in ${BOARD_FOLDER}` },
              ],
              text: `I’ve drafted the board memo for the ${rec.name.toLowerCase()} plan.`,
              done: `Sent. The memo is in ${BOARD_FOLDER} for the board. The dividend${f.buyback ? ', the buyback' : ''}${f.levers.afsSale ? ' and the securities sale' : ''} still need the board’s vote; nothing in the capital plan has changed.`,
              risk: 'high',
              apply: { memo, plan: rec.key },
            },
          };
        },
        apply: async (a: { memo: { subject: string; body: string } }, meta, ctx) => {
          need(ctx);
          await saveMemo(deps, a.memo, meta.approvalId, ctx);
        },
      },
    ],
  };
  return spec;
}

// ---- "Should we sell our low-yield securities at a loss?" ------------------------------------------------
// The same framework and the same plan arithmetic, on one lever: how much of the low-yield book to sell.
// Hold, a targeted sale that brings EVE at +400 bp inside its limit, or a broad one; growth and the dividend
// stay at plan, so the sale is all that differs.

export const SECURITIES_SALE_REQUEST = /\b(?:sell|selling|sale of|reposition\w*|restructur\w*)\b[^.?!]{0,40}\b(?:securities|bonds|afs|investment portfolio)\b[^.?!]{0,40}\b(?:at a loss|losses?|underwater)\b|\bsecurities (?:repositioning|restructuring|loss trade)\b|\bloss trade\b|\bsell\w*\b[^.?!]{0,20}\bunderwater (?:securities|bonds)\b/i;
export const SECURITIES_SALE_AGENT = 'Securities Sale';

export function securitiesCase(pool: Pool): DecisionCase<CapitalLevers, PlanFigures> & { model: () => CapitalActionsModel } {
  let m: CapitalActionsModel | null = null;
  const model = () => {
    if (!m) throw new Error('The capital model is not loaded');
    return m;
  };
  const all = capitalSpecialists(pool);
  const specialists = ['irr', 'capital', 'liquidity', 'stress'].map((id) => all.find((s) => s.id === id)!);
  // The allowance is not this decision's; everything else is checked.
  const critique = (o: Option, f: PlanFigures): Challenge[] =>
    f.checks
      .filter((c) => c.id !== 'allowance' && (c.status === 'breach' || c.status === 'thin'))
      .map((c) => ({ option: o.key, check: c.id, severity: c.status === 'breach' ? ('breach' as const) : ('thin' as const), text: c.id === 'eve400' && o.levers.afsSale === 0 && c.today ? `Holding leaves EVE at +400 bp at ${neg(f.eve400)} against its −${c.limit}% limit: over it today (${neg(model().today.eve[400])}) and still over it a year from now.` : describe(c, f, model().today) }));

  const options = async (): Promise<Option[]> => {
    m = await new CapitalActionsService(pool).model();
    if (!m) throw new Error('No capital figures');
    const t = m.today;
    const loans = Object.entries(t.loanBalance).filter(([k]) => ['First mortgages', 'Commercial loans', 'Consumer loans', 'Commercial real estate', 'Auto loans'].includes(k)).reduce((s, [, v]) => s + v, 0);
    const base = m.levers({ growth: mixOf(down1m(loans * (t.cap.settings.rwaGrowth / 100)), MIX.balanced) });
    // With EVE over its limit, the targeted sale is the one that brings it inside; with no limit to fix, it is a
    // classic repositioning of the lowest-yielding tenth of the portfolio, so holding is weighed against a real sale.
    const need = m.afsToClear(base, 'eve400', { cushion: true }) ?? t.afs.book;
    const repositioning = need <= 0;
    const targeted = Math.min(t.afs.book, up5m(repositioning ? t.afs.book * 0.1 : need));
    const broad = Math.min(t.afs.book, Math.ceil((targeted * 2) / 5e6) * 5e6);
    return [
      { key: 'hold', name: 'Hold', stance: 'Keep the securities and their losses unrealized.', levers: base },
      { key: 'targeted', name: 'Targeted sale', stance: repositioning ? 'Sell the lowest-yielding tenth of the portfolio and reinvest at today’s rates.' : 'Sell enough to bring EVE at +400 bp inside its limit with room.', levers: { ...base, afsSale: targeted } },
      { key: 'broad', name: 'Broad sale', stance: 'Sell twice that, for more yield pickup and rate protection.', levers: { ...base, afsSale: broad } },
    ];
  };

  const revise = (o: Option, ch: Challenge): { levers: CapitalLevers; text: string } | null => {
    const mdl = model();
    const l = o.levers;
    if (o.key === 'hold') return null;
    if (ch.check === 'eve400' || ch.check === 'eve200') {
      const exact = mdl.afsToClear(l, ch.check, { cushion: true });
      if (exact === null || exact <= l.afsSale) return null;
      const sale = Math.min(mdl.today.afs.book, up5m(exact));
      const f = mdl.evaluate({ ...l, afsSale: sale });
      return { levers: { ...l, afsSale: sale }, text: `Sell ${mm(sale)} instead; EVE at +400 bp goes to ${neg(f.eve400)}.` };
    }
    // Capital, liquidity or concentration: the sale's loss is too big, so sell less.
    let sale = l.afsSale;
    for (let i = 0; i < 80 && sale > 0; i++) {
      sale = Math.max(0, sale - 5e6);
      const c = mdl.evaluate({ ...l, afsSale: sale }).checks.find((x) => x.id === ch.check)!;
      if (c.status !== 'breach' && c.status !== 'thin') break;
    }
    if (sale === l.afsSale) return null;
    const f = mdl.evaluate({ ...l, afsSale: sale });
    return { levers: { ...l, afsSale: sale }, text: `Sell ${mm(sale)} instead of ${mm(l.afsSale)}; the loss falls to ${mm(f.afsLoss)} and leverage ends at ${p2(f.levPct)} against its ${p2(f.levFloor)} floor.` };
  };

  const recommend = (results: Result[]) => {
    const issues = (r: Result) => critique(r.option, r.figures);
    const clear = results.filter((r) => !issues(r).some((x) => x.severity === 'breach'));
    // The smallest sale that holds every limit: the least loss for the same protection.
    const pick = [...(clear.length ? clear : results)].sort((a, b) => issues(a).length - issues(b).length || a.figures.afsLoss - b.figures.afsLoss)[0]!;
    const f = pick.figures;
    const hold = results.find((r) => r.option.key === 'hold')!.figures;
    if (!f.levers.afsSale) {
      // Say what a sale would have cost and earned, so holding is a choice, not a default.
      const sale = results.find((r) => r.option.key === 'targeted')?.figures;
      const alt = sale && sale.levers.afsSale ? ` A targeted sale of ${mm(sale.levers.afsSale)} would realize a ${mm(sale.afsLoss)} loss (${mm(sale.afsLossAfterTax)} after tax) and earn it back in ${sale.afsEarnbackYears?.toFixed(1)} years, lifting the run-rate EPS to ${usd(sale.epsRun)} against ${usd(hold.epsRun)}; with no limit to fix, holding keeps that capital.` : '';
      return { key: pick.option.key, why: `Every limit holds without a sale, so there is no reason to realize the loss.${alt}` };
    }
    return {
      key: pick.option.key,
      why: [
        `Selling ${mm(f.levers.afsSale)} realizes a ${mm(f.afsLoss)} loss (${mm(f.afsLossAfterTax)} after tax) and brings EVE at +400 bp from ${neg(hold.eve400)} to ${neg(f.eve400)}, inside its −${model().today.eve.limit400}% limit.`,
        `Next year’s EPS falls to ${usd(f.eps)}, but the run rate rises to ${usd(f.epsRun)} (${signed(f.epsChangePct)}) and the reinvested proceeds earn the loss back in ${f.afsEarnbackYears?.toFixed(1)} years.`,
        `Tangible book value takes no hit, since AOCI already carries the loss: ${usd(f.tbvps)} a share a year ahead against ${usd(hold.tbvps)} if we hold, with the higher yield. Leverage ends at ${p2(f.levPct)} against its ${p2(f.levFloor)} floor.`,
      ].join(' '),
    };
  };

  const rowsFor = (results: Result[]) => {
    const t = model().today;
    const row = (item: string, get: (f: PlanFigures) => string, now = '') => ({ item, now, ...Object.fromEntries(results.map((r) => [r.option.key, get(r.figures)])) });
    return [
      row('Low-yield securities sold', (f) => (f.levers.afsSale ? mm(f.levers.afsSale) : 'None'), `${mm(t.afs.book)} AFS at cost`),
      row('Loss realized (after tax)', (f) => (f.afsLoss ? `${mm(f.afsLoss)} (${mm(f.afsLossAfterTax)})` : 'None')),
      row('Earn-back', (f) => (f.afsEarnbackYears ? `${f.afsEarnbackYears.toFixed(1)} years` : '—')),
      row('Leverage ratio a year ahead (floor)', (f) => `${p2(f.levPct)} (${p2(f.levFloor)})`, `${p2(t.cap.now.levPct)} (${p2(t.cap.floors.leverage)})`),
      row(`EVE at +200 bp (limit −${t.eve.limit200}%)`, (f) => neg(f.eve200), neg(t.eve[200])),
      row(`EVE at +400 bp (limit −${t.eve.limit400}%)`, (f) => neg(f.eve400), neg(t.eve[400])),
      row('EPS next year', (f) => usd(f.eps), usd(t.eps)),
      row('EPS run rate', (f) => `${usd(f.epsRun)} (${signed(f.epsChangePct)})`),
      row('Tangible book value a share', (f) => usd(f.tbvps), usd(t.tbvps)),
      row(`Liquid assets to assets (minimum ${t.liquidMin}%)`, (f) => p2(f.liquidPct), p2(t.liquidPct)),
      row('Limits', (f) => {
        const own = f.checks.filter((c) => c.id !== 'allowance');
        const b = own.filter((c) => c.status === 'breach').length;
        const th = own.filter((c) => c.status === 'thin').length;
        return b ? `${b} breach${b === 1 ? '' : 'es'}` : th ? `${th} thin` : 'Clear';
      }),
    ];
  };

  return {
    agent: SECURITIES_SALE_AGENT,
    title: 'Selling low-yield securities at a loss',
    planText: 'Here’s how I’ll work: the rate-risk, capital, liquidity and stress specialists report their limits at the same time; I set three choices side by side (hold, a targeted sale and a broad one) with DI computing each a year ahead; the chief risk officer challenges them; then I recommend one and draft the memo for your approval.',
    specialists,
    options,
    evaluate: (l) => model().evaluate(l),
    critique,
    stands: (o, ch) => (o.key === 'broad' && ch.severity === 'thin' ? 'The broad sale is the upper bound; it stays on the table so the board sees what more protection costs.' : null),
    revise,
    nouns: LIMIT_NOUN,
    order: ['eve400', 'eve200', 'office', 'multifamily', 'cre', 'liquidity', 'cet1', 'leverage'],
    recommend,
    blocks: (results, runId) => {
      const t = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
      const rows = rowsFor(results);
      return [{ id: newBlockId('sec'), type: 'table', version: '1.0.0', title: 'Hold or sell the low-yield securities', subtitle: `Loan growth and the dividend at plan in every column; the portfolio’s average loss is ${p1(model().today.afs.lossRate * 100)} of cost.`, provenance: { agent: SECURITIES_SALE_AGENT, runId, operations: ['secsale.plans'], sources: SOURCES }, freshness: { kind: 'workflow_event' }, data: { columns: [t('item', ''), t('now', 'Today'), ...results.map((r) => t(r.option.key, r.option.name))], rows, rowCount: rows.length } } as Block];
    },
    memo: (chosen, why, results, replies) => ({
      tool: 'sec_memo',
      args: { recommended: chosen.option.key, plans: results.map((r) => ({ key: r.option.key, name: r.option.name, levers: r.option.levers })), why, settled: replies.map((r) => `${results.find((x) => x.option.key === r.option)?.option.name ?? r.option}, round ${r.round}: ${r.action === 'revise' ? 'revised' : 'stands'}. ${r.text}`).slice(0, 12) },
    }),
    corpus: (results) => {
      const out = rowsFor(results).flatMap((r) => Object.values(r));
      for (const r of results) out.push(mm(r.figures.afsLoss), mm(r.figures.afsLossAfterTax), usd(r.figures.eps), usd(r.figures.epsRun), ...r.figures.checks.map((c) => describe(c, r.figures, model().today)));
      return out;
    },
    facts: (results) =>
      rowsFor(results)
        .map((r) => `${r.item}: today ${r.now || 'n/a'}; ${results.map((x) => `${x.option.name} ${(r as Record<string, string>)[x.option.key]}`).join('; ')}`)
        .join('\n'),
    summary: (f) => `${f.binding}: ${f.current} against ${f.limit}; ${f.headroom}`,
    suggestions: ['Plan our capital actions for next year', 'What’s our interest rate risk?'],
    model,
  };
}

/** The ALCO and board memo for a securities sale, written by code from the recomputed choices. */
export function securitiesMemo(m: CapitalActionsModel, input: z.infer<typeof MemoInput>, from: { name: string; title: string }) {
  const t = m.today;
  const plans = input.plans.map((p) => ({ ...p, f: m.evaluate(m.levers(p.levers)) }));
  const rec = plans.find((p) => p.key === input.recommended) ?? plans[0]!;
  const f = rec.f;
  const line = (label: string, get: (x: PlanFigures) => string) => `- ${label}: ${plans.map((p) => `${p.name} ${get(p.f)}`).join('; ')}`;
  const body = [
    'To: Board of Directors; ALCO',
    `From: ${from.name}, ${from.title}`,
    'Re: Selling low-yield available-for-sale securities',
    '',
    f.levers.afsSale ? `Recommendation: sell ${mm(f.levers.afsSale)} of low-yield available-for-sale securities (the ${rec.name.toLowerCase()}), realizing a ${mm(f.afsLoss)} loss (${mm(f.afsLossAfterTax)} after tax) and reinvesting at market rates.` : 'Recommendation: hold the securities.',
    '',
    `Why: ${input.why}`,
    '',
    'A year ahead, by choice:',
    line('Loss realized (after tax)', (x) => (x.afsLoss ? `${mm(x.afsLoss)} (${mm(x.afsLossAfterTax)})` : 'none')),
    line(`EVE at +400 bp (limit −${t.eve.limit400}%)`, (x) => neg(x.eve400)),
    line(`EVE at +200 bp (limit −${t.eve.limit200}%)`, (x) => neg(x.eve200)),
    line('Leverage ratio (floor)', (x) => `${p2(x.levPct)} (${p2(x.levFloor)})`),
    line('EPS next year', (x) => usd(x.eps)),
    line('Run-rate EPS', (x) => `${usd(x.epsRun)} (${signed(x.epsChangePct)})`),
    line('Tangible book value a share', (x) => usd(x.tbvps)),
    '',
    'The chief risk officer’s challenges, and how they were settled:',
    ...(input.settled.length ? input.settled.map((s) => `- ${s}`) : ['- None.']),
    '',
    f.levers.afsSale ? 'Asked of the board: approve the sale under the investment policy.' : 'Nothing is asked of the board.',
    `Figures are DI’s estimates from the ${t.quarter} Call Report and core data, not the models of record.`,
  ].join('\n');
  return { rec, memo: { to: ['Board of Directors', 'ALCO'], subject: f.levers.afsSale ? `Sell ${mm(f.levers.afsSale)} of low-yield securities: recommendation` : 'Low-yield securities: hold', body: body.slice(0, 4000) } };
}

export function securitiesSaleModule(deps: CapitalActionsDeps): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes(MODULE)) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: MODULE,
    prefix: 'secsale',
    agent: SECURITIES_SALE_AGENT,
    request: SECURITIES_SALE_REQUEST,
    noAccess: NO_ACCESS,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You weigh a securities sale for ${tenant}. You are working with ${user}, ${title}.`,
    plan: () => ({ say: 'Ask me whether to sell your low-yield securities at a loss.' }),
    run: (input, d, sink) => runDecision(spec, securitiesCase(deps.pool), input, d, sink),
    tools: [
      {
        name: 'sec_memo',
        description: 'Draft the memo on selling low-yield securities. Sending it needs approval.',
        input: MemoInput,
        run: async (args: z.infer<typeof MemoInput>, ctx) => {
          need(ctx);
          const m = await new CapitalActionsService(deps.pool).model();
          if (!m) throw new CoreError('NOT_FOUND', 'There are no capital figures to plan from yet.');
          const { rec, memo } = securitiesMemo(m, args, { name: ctx.user.name, title: 'Chief Financial Officer' });
          const f = rec.f;
          return {
            change: {
              summary: f.levers.afsSale ? `Send the board and ALCO the memo: sell ${mm(f.levers.afsSale)} of low-yield securities` : 'Send the board and ALCO the memo: hold the securities',
              changes: [
                { label: 'Securities sale', before: 'None', after: f.levers.afsSale ? mm(f.levers.afsSale) : 'None' },
                { label: 'Loss realized', before: '—', after: f.afsLoss ? `${mm(f.afsLoss)} (${mm(f.afsLossAfterTax)} after tax)` : 'None' },
                { label: 'Goes to', before: '—', after: `Board of Directors and ALCO, in ${BOARD_FOLDER}` },
              ],
              text: `I’ve drafted the memo for the ${rec.name.toLowerCase()}.`,
              done: `Sent. The memo is in ${BOARD_FOLDER}. No securities have been sold; the sale needs the board’s approval under the investment policy.`,
              risk: 'high',
              apply: { memo, plan: rec.key },
            },
          };
        },
        apply: async (a: { memo: { subject: string; body: string } }, meta, ctx) => {
          need(ctx);
          await saveMemo(deps, a.memo, meta.approvalId, ctx);
        },
      },
    ],
  };
  return spec;
}

/** Files an approved memo in Board Packs. */
async function saveMemo(deps: CapitalActionsDeps, memo: { subject: string; body: string }, approvalId: string, ctx: ModuleContext) {
  if (!deps.files) return;
  const on = deps.today?.() ?? new Date().toISOString().slice(0, 10);
  const name = `${memo.subject.replace(/[:/\\]/g, ' -').slice(0, 80)}.txt`;
  const staged = await deps.files.stage({ name, body: Buffer.from(`${memo.subject}\n\n${memo.body}\n`, 'utf8'), owner: { userId: ctx.user.id, name: ctx.user.name }, on });
  await deps.files.save({ fileId: staged.fileId, folder: BOARD_FOLDER }, { approvalId, on });
}
