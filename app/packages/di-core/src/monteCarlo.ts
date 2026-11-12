// Monte Carlo simulation of capital and earnings. The stress test runs three scenarios someone wrote;
// this runs thousands drawn at random, through the same nine-quarter model (StressService.project), so
// the answer is a range and a chance rather than three points: "there's a 3% chance the leverage ratio
// falls below 8% at some point in the next nine quarters, and in the worst 5% of paths it bottoms at
// 8.4%".
//
// Each path draws:
// - whether a recession comes, and how deep (0 is the baseline economy, 1 the severely adverse one,
//   beyond 1 worse than severe), from a mix of calm years and recessions of every depth;
// - the short-rate move over the horizon, falling with the recession's depth (the Fed cuts) and
//   otherwise anywhere from cuts to an inflation-driven rise; net interest income follows it through
//   DI's rate-risk model, as in the stress test;
// - credit losses for each loan type between its baseline and severe loss rates at that depth, with
//   each type's own luck on top, and commercial real estate also tied to a property price draw;
// - fee income and balance sheet growth with the economy.
// The draws are seeded, so the same data gives the same answer. Every assumption is shown; they are
// DI's illustrative ones, not a forecast.
import type { Pool } from '@dinext/tenant-db';
import { IrrService, SHOCKS_BP } from './irr.ts';
import { SCENARIOS, StressService, type Scenario } from './stress.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

/** The stress test's catch-all loss rates for a loan type it has no rate for (baseline, severe). */
const OTHER_LOSS = { baseline: 0.8, severe: 5.0 };
/** The chance of a recession starting within the nine quarters. */
const RECESSION_CHANCE = 0.3;
export const SIM_PATHS = 5000;
const SEED = 20261111;

type Start = NonNullable<Awaited<ReturnType<StressService['start']>>>;

/** xorshift32 uniform in (0, 1), and normal draws from it. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const u = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  return { u, normal };
}

export const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};

export interface SimPath {
  depth: number;
  recession: boolean;
  rateMoveBp: number;
  crePricePct: number;
  /** The lowest capital ratio over nine quarters, today's included (it may never fall below today's), and when. */
  troughPct: number;
  troughQuarter: string;
  endPct: number;
  /** Net interest income over the first four quarters, against today's year. */
  niiYear1Pct: number;
  /** Nine-quarter credit losses, and as a share of loans. */
  losses: number;
  lossPct: number;
  creLosses: number;
  netIncome: number;
  /** Net income over the first four quarters. */
  netIncomeYear1: number;
  /** The capital ratio at each quarter end. */
  ratios: number[];
}

export interface Distribution {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
}
const distribution = (xs: number[]): Distribution => {
  const s = [...xs].sort((a, b) => a - b);
  return { p5: quantile(s, 0.05), p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), p95: quantile(s, 0.95), mean: xs.reduce((a, b) => a + b, 0) / (xs.length || 1) };
};

export class MonteCarloService {
  constructor(
    private readonly pool: Pool,
    private readonly institutionType: 'credit_union' | 'bank' = 'credit_union',
  ) {}

  /** Net interest income's change at a rate move, from DI's rate-risk model, between its shocks. */
  private async niiAt() {
    const irr = await new IrrService(this.pool).analysis();
    const pts = SHOCKS_BP.map((bp) => [bp, irr.scenarios.find((s) => s.shockBp === bp)!.niiPct] as const);
    return (bp: number) => {
      const lo = [...pts].reverse().find(([s]) => s <= bp) ?? pts[0]!;
      const hi = pts.find(([s]) => s >= bp) ?? pts.at(-1)!;
      return lo[0] === hi[0] ? lo[1] : lo[1] + ((hi[1] - lo[1]) * (bp - lo[0])) / (hi[0] - lo[0]);
    };
  }

  /** One random economy as a stress scenario. */
  private draw(r: ReturnType<typeof rng>, start: Start) {
    const base = SCENARIOS.find((s) => s.key === 'baseline')!;
    const severe = SCENARIOS.find((s) => s.key === 'severe')!;
    const recession = r.u() < RECESSION_CHANCE;
    // Calm paths sit around the baseline, a little better or worse; recessions run from mild to worse
    // than severe, most of them milder than severe (lognormal, median about 0.45).
    const depth = recession ? Math.min(2.2, Math.exp(Math.log(0.45) + 0.6 * r.normal())) : Math.max(-0.25, 0.12 * r.normal());
    const d = Math.max(0, depth);
    // Rates: cut with the recession; otherwise anything from cuts to a rise. Floored where rates hit zero.
    const rateMoveBp = Math.round(Math.max(-400, Math.min(400, recession ? -100 - 220 * Math.min(d, 1.2) + 60 * r.normal() : -40 + 110 * r.normal())));
    const crePricePct = Math.max(-60, Math.min(10, severe.crePricePct * d + 6 * r.normal()));
    const creBy = 1 + Math.max(-0.5, (crePricePct - severe.crePricePct * d) / 40);
    const lossPct: Record<string, number> = {};
    for (const l of start.loans) {
      const b = base.lossPct[l.category] ?? OTHER_LOSS.baseline;
      const s = severe.lossPct[l.category] ?? OTHER_LOSS.severe;
      const luck = Math.exp(0.25 * r.normal() - 0.03);
      const cre = /commercial real estate/i.test(l.category) || (!start.bank && /business/i.test(l.category)) ? creBy : 1;
      lossPct[l.category] = Math.max(0, (b + (s - b) * depth) * luck * cre);
    }
    const scenario: Scenario = {
      key: d >= 0.75 ? 'severe' : d >= 0.3 ? 'adverse' : 'baseline',
      name: 'Simulated',
      story: '',
      unemploymentPeakPct: 4.5 + 5.5 * d,
      rateMoveBp,
      crePricePct,
      housePricePct: severe.housePricePct * d,
      feeIncomePct: severe.feeIncomePct * d + 3 * r.normal(),
      assetGrowthPctQ: base.assetGrowthPctQ + (severe.assetGrowthPctQ - base.assetGrowthPctQ) * d + 0.25 * r.normal(),
      lossPct,
    };
    return { scenario, depth, recession };
  }

  /** Every path. Seeded: the same data gives the same paths. */
  async simulate(paths = SIM_PATHS) {
    const stress = new StressService(this.pool, this.institutionType);
    const start = await stress.start();
    if (!start) return null;
    const niiAt = await this.niiAt();
    const r = rng(SEED);
    const startPct = (start.capital / start.assets) * 100;
    const out: SimPath[] = [];
    const creCategory = start.bank ? 'Commercial Real Estate' : 'Business';
    for (let i = 0; i < paths; i++) {
      const { scenario, depth, recession } = this.draw(r, start);
      const p = stress.project(scenario, start, niiAt);
      out.push({
        depth,
        recession,
        rateMoveBp: scenario.rateMoveBp,
        crePricePct: scenario.crePricePct,
        troughPct: Math.min(p.trough.ratioPct, startPct),
        troughQuarter: p.trough.quarter,
        endPct: p.endPct,
        niiYear1Pct: ((p.quarters.slice(0, 4).reduce((s, q) => s + q.nii, 0) - start.nii) / start.nii) * 100,
        losses: p.losses,
        lossPct: p.lossPct,
        creLosses: p.byCategory.find((c) => c.category === creCategory)?.losses ?? 0,
        netIncome: p.netIncome,
        netIncomeYear1: p.quarters.slice(0, 4).reduce((s, q) => s + q.netIncome, 0),
        ratios: p.quarters.map((q) => q.ratioPct),
      });
    }
    // The written scenarios, to place them in the range.
    const written = SCENARIOS.map((s) => {
      const p = stress.project(s, start, niiAt);
      const low = Math.min(p.trough.ratioPct, startPct);
      return { key: s.key, name: s.name, troughPct: low, worseThanPct: (out.filter((x) => x.troughPct > low).length / out.length) * 100 };
    });
    return { start, paths: out, written, quarters: stress.project(SCENARIOS[0]!, start, niiAt).quarters.map((q) => q.quarter) };
  }

  /** The range, the chances that matter, where the written scenarios fall, and what the worst paths have in common. */
  async analysis(paths = SIM_PATHS) {
    const sim = await this.simulate(paths);
    if (!sim) return null;
    const { start, paths: ps, written, quarters } = sim;
    const n = ps.length;
    const share = (f: (p: SimPath) => boolean) => (ps.filter(f).length / n) * 100;
    const trough = distribution(ps.map((p) => p.troughPct));
    const startPct = (start.capital / start.assets) * 100;
    // The NII limit: a bank's at 200 bp, a credit union's single one.
    const niiLimitPct = start.bank ? 10 : 20;
    const worst = [...ps].sort((a, b) => a.troughPct - b.troughPct).slice(0, Math.max(1, Math.round(n * 0.05)));
    const avg = (xs: SimPath[], f: (p: SimPath) => number) => xs.reduce((s, p) => s + f(p), 0) / (xs.length || 1);
    // The chance the ratio falls below each level at some point: from just under today's down to a
    // point below the minimum, in quarter points.
    const levels: { level: number; chance: number }[] = [];
    for (let x = Math.floor(startPct * 4) / 4; x >= start.minimumPct - 1 - 1e-9; x -= 0.25) levels.push({ level: x, chance: share((p) => p.troughPct < x) });
    const fan = quarters.map((q, i) => {
      const at = ps.map((p) => p.ratios[i]!).sort((a, b) => a - b);
      return { quarter: q, p5: quantile(at, 0.05), p50: quantile(at, 0.5), p95: quantile(at, 0.95) };
    });
    return {
      paths: n,
      bank: start.bank,
      asOf: start.end,
      ratioName: start.ratioName,
      minimumPct: start.minimumPct,
      minimumName: start.minimumName,
      startPct,
      trough,
      troughQuarter: worst[0]?.troughQuarter ?? '',
      niiYear1: distribution(ps.map((p) => p.niiYear1Pct)),
      lossPct: distribution(ps.map((p) => p.lossPct)),
      losses: distribution(ps.map((p) => p.losses)),
      netIncome: distribution(ps.map((p) => p.netIncome)),
      chances: {
        belowToday: share((p) => p.troughPct < startPct - 0.005),
        belowMinimum: share((p) => p.troughPct < start.minimumPct),
        withinOnePoint: share((p) => p.troughPct < start.minimumPct + 1),
        lossYear: share((p) => p.netIncomeYear1 < 0),
        niiBeyondLimit: share((p) => p.niiYear1Pct < -niiLimitPct),
        recession: share((p) => p.recession),
      },
      niiLimitPct,
      written,
      worst: {
        paths: worst.length,
        troughPct: avg(worst, (p) => p.troughPct),
        depth: avg(worst, (p) => p.depth),
        rateMoveBp: avg(worst, (p) => p.rateMoveBp),
        crePricePct: avg(worst, (p) => p.crePricePct),
        lossPct: avg(worst, (p) => p.lossPct),
        creShare: avg(worst, (p) => (p.losses ? p.creLosses / p.losses : 0)),
      },
      typical: { depth: avg(ps, (p) => p.depth), rateMoveBp: avg(ps, (p) => p.rateMoveBp), crePricePct: avg(ps, (p) => p.crePricePct), lossPct: avg(ps, (p) => p.lossPct), creShare: avg(ps, (p) => (p.losses ? p.creLosses / p.losses : 0)) },
      creCategory: start.bank ? 'Commercial real estate' : 'Business loans',
      levels,
      fan,
      assumptions: this.assumptions(start, n),
    };
  }

  assumptions(start: Start, paths: number): [string, string][] {
    return [
      ['Paths', `${paths.toLocaleString('en-US')} random economies over nine quarters, each run through the stress test’s model of capital: the same starting point, loss timing, allowance, net interest income, tax and dividends. The draws are seeded, so the same data gives the same answer.`],
      ['Recessions', `A ${(RECESSION_CHANCE * 100).toFixed(0)}% chance a recession comes within the nine quarters. Its depth runs from mild to worse than the severely adverse scenario; the median recession is a little under half as deep as severe, and about one in eleven is deeper than severe. Without one, the economy sits near the baseline.`],
      ['Credit losses', 'Each loan type’s nine-quarter loss rate lies between its baseline and severe rates at the path’s depth, beyond severe in the deepest paths, with each type’s own luck on top (about ±25%).'],
      [start.bank ? 'Commercial real estate' : 'Business loans', 'Also tied to a commercial property price draw: values fall with the depth (35% at severe) give or take 6 points, and losses move with the gap.'],
      ['Rates', 'Short rates fall with a recession (about 100 bp, plus up to 260 bp more with its depth); without one, they move anywhere from cuts to a rise (−40 bp, give or take 110 bp). Net interest income follows through DI’s rate-risk model, as in the stress test.'],
      ['Fee income and growth', 'Fee income falls with the depth (20% at severe), and the balance sheet grows or shrinks with it, each with its own noise.'],
      ['What it is not', 'A forecast. It shows how wide the outcomes are and how likely the bad ones are under DI’s illustrative assumptions; the scenarios a regulator or the board sets remain the ones of record.'],
    ];
  }

  /** Loans and deposits over the last 12 months of month-end history, as growth rates. */
  private async trend() {
    const g = async (table: 'hist_loan_month' | 'hist_deposit_month') => {
      const list = await rows<{ m: unknown; b: number }>(this.pool, `SELECT month_end AS m, SUM(balance) AS b FROM ${table} GROUP BY month_end ORDER BY month_end DESC LIMIT 13`).catch(() => []);
      if (list.length < 13) return null;
      return (Number(list[0]!.b) / Number(list[12]!.b) - 1) * 100;
    };
    return { loans: await g('hist_loan_month'), deposits: await g('hist_deposit_month') };
  }

  /**
   * Monte Carlo on the budget: the next four quarters in each simulated economy, through the same model,
   * read as the budget's measures, against the latest budget's targets. Loan and deposit growth are
   * centred on DI's own 12-month trend, not on the plan, so the plan is a bar to clear: a recession
   * slows lending and brings deposits in.
   */
  async budget(paths = SIM_PATHS) {
    const stress = new StressService(this.pool, this.institutionType);
    const start = await stress.start();
    if (!start) return null;
    const [niiAt, trend, loaded, lines] = await Promise.all([
      this.niiAt(),
      this.trend(),
      new IrrService(this.pool).positions(),
      rows<{ year: number; metric: string; value: number; status: string }>(this.pool, 'SELECT year, metric, value, status FROM fin_budget WHERE year = (SELECT MAX(year) FROM fin_budget)').catch(() => []),
    ]);
    const earningShare = Math.min(1, loaded.positions.filter((p) => p.side === 'asset').reduce((s, p) => s + p.balance, 0) / start.assets) || 0.93;
    const loanTotal = start.loans.reduce((s, l) => s + l.balance, 0);
    const loanTrend = trend.loans ?? 4;
    const depositTrend = trend.deposits ?? 4;
    const r = rng(SEED + 7);
    type Outcome = Record<BudgetMeasure, number> & { depth: number; rateMoveBp: number; lossPct: number; feeIncomePct: number };
    const out: Outcome[] = [];
    for (let i = 0; i < paths; i++) {
      const { scenario, depth } = this.draw(r, start);
      const d = Math.max(0, depth);
      const loanGrowth = loanTrend - 6 * d + 2 * r.normal();
      const depositGrowth = depositTrend + 2 * d + 2 * r.normal();
      const p = stress.project({ ...scenario, assetGrowthPctQ: depositGrowth / 4 }, start, niiAt);
      const year = p.quarters.slice(0, 4);
      const sum = (f: (q: (typeof year)[number]) => number) => year.reduce((s, q) => s + f(q), 0);
      const avgAssets = (start.assets + sum((q) => q.assets)) / 5;
      const nii = sum((q) => q.nii);
      const fee = sum((q) => q.feeIncome);
      out.push({
        return_on_assets: (sum((q) => q.netIncome) / avgAssets) * 100,
        net_interest_margin: (nii / (avgAssets * earningShare)) * 100,
        efficiency_ratio: (sum((q) => q.expense) / Math.max(1, nii + fee)) * 100,
        net_charge_off_ratio: (sum((q) => q.chargeOffs) / (loanTotal * (1 + loanGrowth / 200))) * 100,
        net_worth_ratio: year.at(-1)!.ratioPct,
        loan_growth: loanGrowth,
        deposit_growth: depositGrowth,
        depth,
        rateMoveBp: scenario.rateMoveBp,
        lossPct: p.lossPct,
        feeIncomePct: scenario.feeIncomePct,
      });
    }
    const targets = lines.filter((l) => BUDGET_MEASURES.some((m) => m.key === l.metric));
    const measures = BUDGET_MEASURES.map((m) => {
      const xs = out.map((o) => o[m.key]);
      const t = targets.find((l) => l.metric === m.key);
      const meets = t ? (xs.filter((x) => (m.better === 'up' ? x >= Number(t.value) : x <= Number(t.value))).length / xs.length) * 100 : null;
      return { ...m, label: m.key === 'net_worth_ratio' ? start.ratioName : m.label, target: t ? Number(t.value) : null, ...distribution(xs), chanceMeets: meets };
    }).filter((m) => m.target !== null || m.key === 'return_on_assets');
    // What moves ROA most: each driver's share of ROA's spread across the paths (its correlation, squared).
    const roa = out.map((o) => o.return_on_assets);
    const corr = (xs: number[], ys: number[]) => {
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < xs.length; i++) {
        sxy += (xs[i]! - mx) * (ys[i]! - my);
        sxx += (xs[i]! - mx) ** 2;
        syy += (ys[i]! - my) ** 2;
      }
      return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    };
    const drivers = [
      { key: 'lossPct', label: 'Credit losses' },
      { key: 'rateMoveBp', label: 'The rate move' },
      { key: 'depth', label: 'How deep a downturn' },
      { key: 'feeIncomePct', label: 'Fee income' },
      { key: 'loan_growth', label: 'Loan growth' },
      { key: 'deposit_growth', label: 'Deposit growth' },
    ].map((x) => {
      const c = corr(out.map((o) => o[x.key as keyof Outcome] as number), roa);
      return { ...x, share: c * c, direction: c >= 0 ? 'up' : 'down' };
    }).sort((a, b) => b.share - a.share);
    const year = targets[0]?.year ?? null;
    return {
      paths,
      bank: start.bank,
      asOf: start.end,
      year,
      approved: targets.length > 0 && targets.every((l) => l.status === 'Approved'),
      trend: { loans: trend.loans, deposits: trend.deposits },
      measures,
      chanceAll: targets.length ? (out.filter((o) => measures.every((m) => m.target === null || (m.better === 'up' ? o[m.key] >= m.target : o[m.key] <= m.target))).length / paths) * 100 : null,
      drivers,
      assumptions: [
        ['Horizon', `The next four quarters from the ${start.bank ? 'FFIEC 051' : '5300'} for ${start.end}, in ${paths.toLocaleString('en-US')} random economies through the stress test’s model (the same draws as the capital simulation).`],
        ['Targets', year ? `The ${year} budget’s targets${targets.every((l) => l.status === 'Approved') ? ' (approved)' : ' (draft)'}.` : 'No budget in DI yet.'],
        ['Growth', `Loans centre on the last 12 months’ growth (${(trend.loans ?? 4).toFixed(1)}%) and slow by up to 6 points in a recession; deposits centre on theirs (${(trend.deposits ?? 4).toFixed(1)}%) and rise a little in one as money seeks safety; each give or take about 2 points.`],
        ['Measures', `ROA on average assets; NIM on earning assets (${(earningShare * 100).toFixed(0)}% of assets); efficiency is expenses over net interest and fee income; net charge-offs over average loans; ${start.ratioName.toLowerCase()} at the year’s end.`],
        ['What it is not', 'A forecast. It shows how likely the plan is under DI’s illustrative assumptions.'],
      ] as [string, string][],
    };
  }
}

export type BudgetMeasure = 'return_on_assets' | 'net_interest_margin' | 'efficiency_ratio' | 'net_charge_off_ratio' | 'net_worth_ratio' | 'loan_growth' | 'deposit_growth';
/** The budget's measures the simulation reads, and which way is better. */
export const BUDGET_MEASURES: { key: BudgetMeasure; label: string; better: 'up' | 'down' }[] = [
  { key: 'return_on_assets', label: 'Return on assets', better: 'up' },
  { key: 'net_interest_margin', label: 'Net interest margin', better: 'up' },
  { key: 'efficiency_ratio', label: 'Efficiency ratio', better: 'down' },
  { key: 'net_charge_off_ratio', label: 'Net charge-off ratio', better: 'down' },
  { key: 'net_worth_ratio', label: 'Net worth ratio', better: 'up' },
  { key: 'loan_growth', label: 'Loan growth', better: 'up' },
  { key: 'deposit_growth', label: 'Deposit growth', better: 'up' },
];
