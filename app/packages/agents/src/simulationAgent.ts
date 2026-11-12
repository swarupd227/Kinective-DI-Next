// Scenario Simulation: Monte Carlo on capital and earnings. The stress test answers "what happens in
// these three scenarios"; this answers "how likely is it to go badly, and how badly": thousands of
// random economies through the same capital model, as a range and a chance. The numbers come from the
// simulation; Claude explains them. It reads only, so it needs no approval.
import { z } from 'zod';
import type { Block, ChartBlock } from '@dinext/block-schemas';
import { CoreError, type MonteCarloService } from '@dinext/di-core';
import { newBlockId } from './answer.ts';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const SIMULATION_REQUEST =
  /\bmonte[- ]?carlo\b|\bsimulat(?:e|ed|es|ion|ions|ing)\b|\b(?:range|distribution|spread) of (?:outcomes|results|capital|earnings|losses|possible)\b|\btail risk\b|\bworst (?:5|five|1|one) ?(?:%|percent)|\bworst (?:simulated )?paths\b|\b(?:what are the odds|how likely|chances?|probability|likelihood|odds)\b[^.?!]*\b(?:budget|targets?|(?:hit|meet|make|miss)(?:ing)? (?:the |our )?plan)\b|\b(?:budget|plan) at risk\b|\b(?:what are the odds|how likely|what(?:'s| is) the (?:chance|probability|likelihood)|chances?|probability|likelihood|odds)\b[^.?!]*\b(?:capital|leverage|net worth|breach|minimum|fall below|drop below|losses?|net income|earnings|nii|net interest income|lose money|loss year)\b/i;

const p = (v: number, d = 1) => `${v.toFixed(d)}%`;
const chance = (v: number) => (v === 0 ? 'none of the paths' : v < 0.1 ? 'under 0.1%' : v < 1 ? `${v.toFixed(1)}%` : `${v.toFixed(0)}%`);
const money = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e9 ? `$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : `$${Math.round(a / 1e3)}K`;
  return v < 0 ? `−${s}` : s;
};
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });

type Analysis = NonNullable<Awaited<ReturnType<MonteCarloService['analysis']>>>;
type Budget = NonNullable<Awaited<ReturnType<MonteCarloService['budget']>>>;

export function simulationModule(svc: MonteCarloService): ModuleSpec {
  const noAccess = 'The stress test and its simulation are for finance and executives.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('camels')) throw new CoreError('NO_ACCESS', noAccess);
  };
  // The budget simulation is for those who see the budget or the stress test.
  const needBudget = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('camels') && !ctx.modules.includes('budget')) throw new CoreError('NO_ACCESS', 'The budget and its simulation are for finance and executives.');
  };
  let cachedBudget: { at: number; b: Promise<Budget | null> } | null = null;
  const budget = async () => {
    if (!cachedBudget || Date.now() - cachedBudget.at > 5 * 60_000) cachedBudget = { at: Date.now(), b: svc.budget() };
    const b = await cachedBudget.b.catch((e: unknown) => {
      cachedBudget = null;
      throw e;
    });
    if (!b) throw new CoreError('NOT_FOUND', 'There’s no Call Report in DI yet, so there’s no starting point to simulate from.');
    return b;
  };
  // Cached for a few minutes: the inputs change with the nightly build, not between questions.
  let cached: { at: number; a: Promise<Analysis | null> } | null = null;
  const analysis = async () => {
    if (!cached || Date.now() - cached.at > 5 * 60_000) cached = { at: Date.now(), a: svc.analysis() };
    const a = await cached.a.catch((e: unknown) => {
      cached = null;
      throw e;
    });
    if (!a) throw new CoreError('NOT_FOUND', 'There’s no Call Report in DI yet, so there’s no starting point to simulate from.');
    return a;
  };

  const spec: ModuleSpec = {
    id: 'camels',
    prefix: 'sim',
    agent: 'Scenario Simulation',
    request: SIMULATION_REQUEST,
    noAccess,
    sources: [
      { kind: 'table', label: 'Call Report values', ref: 'table:cr_value' },
      { kind: 'table', label: 'Loans', ref: 'table:cdm_loan' },
    ],
    prompt: ({ tenant, user, title }) => `You are the Scenario Simulation agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) wants to know how likely the bad outcomes are, not only what three set scenarios do.

- "Run a Monte Carlo on capital", "what's the chance we fall below the minimum?", "how low could capital go?": sim_capital.
- "What's the range for net interest income and earnings?", "what's the chance we lose money next year?": sim_earnings.
- "What do the worst paths have in common?", "what drives the tail?": sim_tail.
- "What's the chance we hit the budget?", "which targets are at risk?", "Monte Carlo on the budget": sim_budget.
- "What does the simulation assume?": sim_assumptions.
- Every answer already says these are chances under DI's illustrative assumptions, not a forecast. Don't say it again.`,
    plan: (t) => {
      if (/\bassum/i.test(t)) return { tool: 'sim_assumptions', args: {} };
      if (/\bbudget\b|\btargets?\b|\b(?:hit|meet|make|miss)(?:ing)? (?:the |our )?plan\b|\bplan at risk\b/i.test(t)) return { tool: 'sim_budget', args: {} };
      if (/\bworst\b|\btail\b|\bin common\b|\bdrives?\b|\bwhat goes wrong\b/i.test(t)) return { tool: 'sim_tail', args: {} };
      if (/\bnii\b|\bnet interest\b|\bearnings\b|\bnet income\b|\bincome\b|\blose money\b|\bloss year\b|\bprofit/i.test(t) && !/\bcapital\b|\bleverage\b|\bnet worth\b/i.test(t)) return { tool: 'sim_earnings', args: {} };
      return { tool: 'sim_capital', args: {} };
    },
    tools: [
      {
        name: 'sim_capital',
        description: 'Monte Carlo on capital: thousands of random economies over nine quarters through the stress test’s model. The range of the lowest capital ratio, the chance of falling below the minimum or within a point of it, and where the written baseline, adverse and severe scenarios fall in the range.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const a = await analysis();
          const severe = a.written.find((w) => w.key === 'severe')!;
          const below = a.chances.belowMinimum;
          const typical = a.trough.p50 >= a.startPct - 0.005 ? `**never falls below today’s level in the typical path**` : `bottoms out at **${p(a.trough.p50, 2)} in the typical path**`;
          const head = `Across **${a.paths.toLocaleString('en-US')} simulated economies** over the next nine quarters, the ${a.ratioName.toLowerCase()} (${p(a.startPct, 2)} today) ${typical} and falls to **${p(a.trough.p5, 2)} or lower in the worst 5%**. The chance it falls below ${a.minimumName} at some point is **${chance(below)}**; the chance it comes within a point of it is ${chance(a.chances.withinOnePoint)}.`;
          const placed = `The severely adverse stress scenario (lowest point ${p(severe.troughPct, 2)}) is worse than ${severe.worseThanPct.toFixed(0)}% of the paths, so it is a fair picture of a bad case: ${chance(100 - severe.worseThanPct)} of paths are worse.`;
          return {
            text: `${head} ${placed} These are chances under DI’s illustrative assumptions, not a forecast.`,
            blocks: [histogram(spec, a, ctx.runId), fan(spec, a, ctx.runId), moduleTable(spec, 'The lowest capital ratio across the paths', ctx.runId, 'sim.capital', [text('measure', 'Measure'), text('value', 'Value')], [
              { measure: 'Today', value: p(a.startPct, 2) },
              { measure: 'Lowest point, typical path', value: p(a.trough.p50, 2) },
              { measure: 'Chance it falls below today’s level at all', value: chance(a.chances.belowToday) },
              { measure: 'Lowest point, worst 5% of paths', value: `${p(a.trough.p5, 2)} or lower` },
              { measure: `Chance of falling below ${p(a.minimumPct, 0)}`, value: chance(below) },
              { measure: `Chance of coming within a point (${p(a.minimumPct + 1, 0)})`, value: chance(a.chances.withinOnePoint) },
              ...a.written.map((w) => ({ measure: `${w.name} scenario's lowest point`, value: w.troughPct >= a.startPct - 0.005 ? 'Never below today’s level' : `${p(w.troughPct, 2)}, worse than ${w.worseThanPct.toFixed(0)}% of paths` })),
            ], a.asOf)],
            suggestions: ['What do the worst paths have in common?', 'What’s the range for net interest income and earnings?', 'What does the simulation assume?'],
          };
        },
      },
      {
        name: 'sim_earnings',
        description: 'Monte Carlo on earnings: the range of net interest income over the next year against today’s, nine-quarter net income and credit losses, and the chance of losing money over the next year.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const a = await analysis();
          const nii = a.niiYear1;
          return {
            text: `Over the next year, net interest income lands between **${signed(nii.p5)} and ${signed(nii.p95)}** of today’s in 90% of the ${a.paths.toLocaleString('en-US')} paths (typical ${signed(nii.p50)}); ${a.chances.niiBeyondLimit ? `${chance(a.chances.niiBeyondLimit)} fall more than the ${a.niiLimitPct}% limit` : `none falls more than the ${a.niiLimitPct}% limit`}. Credit losses over nine quarters run from ${money(a.losses.p5)} to **${money(a.losses.p95)} in the worst 5%** (${p(a.lossPct.p5, 2)} to ${p(a.lossPct.p95, 2)} of loans). The chance of a net loss over the next four quarters is **${chance(a.chances.lossYear)}**, and nine-quarter net income is ${money(a.netIncome.p5)} or less in the worst 5% of paths against ${money(a.netIncome.p50)} in the typical one. These are chances under DI’s illustrative assumptions, not a forecast.`,
            blocks: [moduleTable(spec, 'Earnings across the paths', ctx.runId, 'sim.earnings', [text('measure', 'Measure'), text('p5', 'Worst 5%'), text('p25', 'Lower quarter'), text('p50', 'Typical'), text('p75', 'Upper quarter'), text('p95', 'Best 5%')], [
              { measure: 'Net interest income, next year vs today', p5: signed(nii.p5), p25: signed(nii.p25), p50: signed(nii.p50), p75: signed(nii.p75), p95: signed(nii.p95) },
              { measure: 'Net income, nine quarters', p5: money(a.netIncome.p5), p25: money(a.netIncome.p25), p50: money(a.netIncome.p50), p75: money(a.netIncome.p75), p95: money(a.netIncome.p95) },
              // For losses the worst 5% is the highest.
              { measure: 'Credit losses, nine quarters', p5: money(a.losses.p95), p25: money(a.losses.p75), p50: money(a.losses.p50), p75: money(a.losses.p25), p95: money(a.losses.p5) },
              { measure: 'Credit losses, share of loans', p5: p(a.lossPct.p95, 2), p25: p(a.lossPct.p75, 2), p50: p(a.lossPct.p50, 2), p75: p(a.lossPct.p25, 2), p95: p(a.lossPct.p5, 2) },
            ], a.asOf)],
            suggestions: ['What’s the chance capital falls below the minimum?', 'What do the worst paths have in common?'],
          };
        },
      },
      {
        name: 'sim_tail',
        description: 'What the worst 5% of simulated paths have in common against all paths: how deep the recession, the rate move, the commercial property price fall, credit losses and how much of them come from commercial real estate (business loans for a credit union).',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const a = await analysis();
          const w = a.worst;
          const t = a.typical;
          return {
            text: `The worst ${w.paths} paths (5%) bottom out at ${p(w.troughPct, 2)} on average. They are recessions **about ${w.depth.toFixed(1)} times as deep as the severely adverse scenario**, with rates cut ${Math.abs(w.rateMoveBp).toFixed(0)} bp and commercial property down ${Math.abs(w.crePricePct).toFixed(0)}%. Credit losses reach ${p(w.lossPct, 1)} of loans against ${p(t.lossPct, 1)} across all paths, and **${a.creCategory.toLowerCase()} carry ${(w.creShare * 100).toFixed(0)}% of them** (${(t.creShare * 100).toFixed(0)}% in all paths). ${w.creShare > t.creShare + 0.1 ? `What sinks capital in the tail is ${a.creCategory.toLowerCase()}: limiting that concentration, or holding more against it, does the most for the worst case.` : 'The tail comes from losses across the book rather than one concentration.'} These are DI’s illustrative assumptions, not a forecast.`,
            blocks: [moduleTable(spec, 'The worst 5% of paths against all paths', ctx.runId, 'sim.tail', [text('measure', 'Measure'), text('worst', 'Worst 5%'), text('all', 'All paths')], [
              { measure: 'Lowest capital ratio', worst: p(w.troughPct, 2), all: p(a.trough.mean, 2) },
              { measure: 'Recession depth (1 = severely adverse)', worst: w.depth.toFixed(2), all: t.depth.toFixed(2) },
              { measure: 'Short-rate move', worst: `${w.rateMoveBp.toFixed(0)} bp`, all: `${t.rateMoveBp.toFixed(0)} bp` },
              { measure: 'Commercial property values', worst: p(w.crePricePct, 0), all: p(t.crePricePct, 0) },
              { measure: 'Credit losses, share of loans', worst: p(w.lossPct, 2), all: p(t.lossPct, 2) },
              { measure: `${a.creCategory}' share of losses`, worst: p(w.creShare * 100, 0), all: p(t.creShare * 100, 0) },
            ], a.asOf)],
            suggestions: ['What’s the chance capital falls below the minimum?', 'Run the stress test'],
          };
        },
      },
      {
        name: 'sim_budget',
        description: 'Monte Carlo on the budget: the next four quarters in thousands of random economies, read as the budget’s measures (ROA, NIM, efficiency, net charge-offs, the capital ratio, loan and deposit growth), against the latest budget’s targets. The range of each, the chance of meeting each target and all of them, and what moves ROA most.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          needBudget(ctx);
          const b = await budget();
          if (!b.year) return { text: 'There’s no budget in DI yet, so there are no targets to test. Ask the Budget agent to draft one.' };
          const fmt = (m: Budget['measures'][number], v: number) => (m.key === 'efficiency_ratio' ? p(v, 1) : p(v, 2));
          const withTargets = b.measures.filter((m) => m.target !== null && m.chanceMeets !== null);
          const risky = [...withTargets].sort((x, y) => x.chanceMeets! - y.chanceMeets!);
          const roa = b.measures.find((m) => m.key === 'return_on_assets')!;
          const top = b.drivers.slice(0, 2);
          return {
            text: `Over the next four quarters, in ${b.paths.toLocaleString('en-US')} simulated economies, ${roa.target !== null ? `ROA meets the ${b.year} target of ${p(roa.target, 2)} in **${chance(roa.chanceMeets!)}** of paths` : 'ROA'} (typical ${p(roa.p50, 2)}, worst 5% ${p(roa.p5, 2)} or lower). The targets most at risk: ${risky.slice(0, 3).map((m) => `**${m.label.toLowerCase()}** (${chance(m.chanceMeets!)} chance of meeting ${fmt(m, m.target!)}; typical ${fmt(m, m.p50)})`).join(', ')}. ${b.chanceAll !== null ? `The chance of meeting every target at once is ${chance(b.chanceAll)}.` : ''} ${top.length ? `What moves ROA most across the paths: ${top.map((d) => d.label.toLowerCase()).join(' and ')}.` : ''} Loan and deposit growth are centred on the last 12 months’ trend (${b.trend.loans !== null ? p(b.trend.loans, 1) : '—'} and ${b.trend.deposits !== null ? p(b.trend.deposits, 1) : '—'}), not on the plan. These are chances under DI’s illustrative assumptions, not a forecast.`,
            blocks: [
              moduleTable(spec, `The ${b.year} budget across ${b.paths.toLocaleString('en-US')} simulated paths`, ctx.runId, 'sim.budget', [text('measure', 'Measure'), text('target', 'Target'), text('p5', 'Worst 5%'), text('p50', 'Typical'), text('p95', 'Best 5%'), text('meets', 'Chance of meeting it')], b.measures.map((m) => {
                const worst = m.better === 'up' ? m.p5 : m.p95;
                const best = m.better === 'up' ? m.p95 : m.p5;
                return { measure: m.label, target: m.target === null ? '—' : `${m.better === 'up' ? 'At least' : 'At most'} ${fmt(m, m.target)}`, p5: fmt(m, worst), p50: fmt(m, m.p50), p95: fmt(m, best), meets: m.chanceMeets === null ? '—' : chance(m.chanceMeets) };
              }), b.asOf),
              moduleTable(spec, 'What moves ROA across the paths', ctx.runId, 'sim.budget.drivers', [text('driver', 'Driver'), text('moves', 'Moves with ROA'), text('way', 'When it rises, ROA')], b.drivers.map((d) => ({ driver: d.label, moves: d.share >= 0.5 ? 'Strongly' : d.share >= 0.15 ? 'Somewhat' : 'Little', way: d.direction === 'up' ? 'Rises' : 'Falls' })), b.asOf),
            ],
            suggestions: ['What’s the chance capital falls below the minimum?', 'What does the simulation assume?'],
          };
        },
      },
      {
        name: 'sim_assumptions',
        description: 'What the Monte Carlo simulation assumes: how many paths, the chance and depth of recessions, credit losses, rates, fee income and growth.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const a = await analysis();
          return {
            text: `The simulation draws ${a.paths.toLocaleString('en-US')} random economies and runs each through the stress test’s nine-quarter capital model, starting from the ${a.bank ? 'FFIEC 051' : '5300'} for ${a.asOf}. The assumptions are DI’s illustrative ones and are all shown.`,
            blocks: [moduleTable(spec, 'What the simulation assumes', ctx.runId, 'sim.assumptions', [text('item', 'Assumption'), text('detail', 'Detail')], a.assumptions.map(([item, detail]) => ({ item, detail })), a.asOf)],
          };
        },
      },
    ],
  };
  return spec;
}

const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;

/** The chance the ratio falls below each level at some point in nine quarters. */
function histogram(spec: Pick<ModuleSpec, 'agent' | 'sources'>, a: Analysis, runId: string): Block {
  const at = (x: number) => a.levels.find((l) => Math.abs(l.level - x) < 1e-6)?.chance ?? 0;
  const block: ChartBlock = {
    id: newBlockId('cht'),
    type: 'chart',
    version: '2.0.0',
    title: `Chance the ${a.ratioName.toLowerCase()} falls below each level`,
    subtitle: `At some point in the next nine quarters, across ${a.paths.toLocaleString('en-US')} simulated paths; the minimum is ${p(a.minimumPct, 0)}`,
    provenance: { agent: spec.agent, runId, operations: ['sim.capital'], sources: spec.sources },
    freshness: { kind: 'nightly_build', asOf: `${a.asOf}T00:00:00Z` },
    a11y: { summary: `Bar chart of the chance the ${a.ratioName.toLowerCase()} falls below each level from ${p(a.levels[0]?.level ?? 0, 2)} down to ${p(a.levels.at(-1)?.level ?? 0, 2)}; ${chance(at(a.minimumPct))} below the ${p(a.minimumPct, 0)} minimum.` },
    data: {
      chartType: 'bar',
      dataset: { dimensions: [{ name: 'x', displayName: 'Falls below', type: 'ordinal' }, { name: 'y', displayName: 'Chance' }], source: a.levels.map((l) => [`${l.level.toFixed(2)}%`, Math.round(l.chance * 10) / 10]) },
      series: [{ name: 'Chance', encode: { x: 'x', y: 'y' } }],
      axes: { x: { title: 'Falls below' }, y: [{ title: 'Chance', unit: 'percent' }] },
      legend: false,
    },
  };
  return block;
}

/** The ratio quarter by quarter: the typical path and the band 90% of paths stay within. */
function fan(spec: Pick<ModuleSpec, 'agent' | 'sources'>, a: Analysis, runId: string): Block {
  const block: ChartBlock = {
    id: newBlockId('cht'),
    type: 'chart',
    version: '2.0.0',
    title: `${a.ratioName}, quarter by quarter`,
    subtitle: `The typical path, and the worst and best 5% of paths at each quarter end; the minimum is ${p(a.minimumPct, 0)}`,
    provenance: { agent: spec.agent, runId, operations: ['sim.capital'], sources: spec.sources },
    freshness: { kind: 'nightly_build', asOf: `${a.asOf}T00:00:00Z` },
    a11y: { summary: `Line chart of the ${a.ratioName.toLowerCase()} over nine quarters: the typical path ends at ${p(a.fan.at(-1)?.p50 ?? 0, 2)}, the worst 5% at ${p(a.fan.at(-1)?.p5 ?? 0, 2)} or lower; the minimum is ${p(a.minimumPct, 0)}.` },
    data: {
      chartType: 'line',
      dataset: { dimensions: [{ name: 'x', displayName: 'Quarter', type: 'ordinal' }, { name: 'p5', displayName: 'Worst 5%' }, { name: 'p50', displayName: 'Typical' }, { name: 'p95', displayName: 'Best 5%' }], source: a.fan.map((f) => [f.quarter, round(f.p5), round(f.p50), round(f.p95)]) },
      series: [
        { name: 'Worst 5%', encode: { x: 'x', y: 'p5' } },
        { name: 'Typical', encode: { x: 'x', y: 'p50' } },
        { name: 'Best 5%', encode: { x: 'x', y: 'p95' } },
      ],
      axes: { y: [{ title: a.ratioName, unit: 'percent' }] },
      legend: true,
      markLines: [{ value: a.minimumPct, label: `Minimum ${p(a.minimumPct, 0)}` }],
    },
  };
  return block;
}
const round = (v: number) => Math.round(v * 100) / 100;
