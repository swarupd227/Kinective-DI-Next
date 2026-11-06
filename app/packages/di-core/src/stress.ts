// Community bank (and credit union) stress test. DFAST and CCAR apply to much larger institutions;
// examiners still expect a community institution to know what a severe downturn would do to its
// capital, above all with a commercial real estate concentration. This projects nine quarters under
// three scenarios from the institution's own book:
// - credit losses by loan type, at cumulative nine-quarter loss rates for each scenario,
// - provisions under a forward-looking allowance (the next eight quarters' expected losses),
// - pre-provision earnings, with net interest income moved by the scenario's rate path through DI's
//   rate-risk model, fee income cut and expenses held,
// - capital after tax and dividends, against the leverage ratio's minimum.
// It also finds how much worse than severe losses would have to be to reach the minimum (a reverse
// stress test) and what falls in commercial real estate values would cost.
// Every assumption is DI's illustrative one and is shown; the scenarios are not the Federal Reserve's.
import type { Pool } from '@dinext/tenant-db';
import { IrrService, SHOCKS_BP } from './irr.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

export type ScenarioKey = 'baseline' | 'adverse' | 'severe';
export interface Scenario {
  key: ScenarioKey;
  name: string;
  story: string;
  /** Peak unemployment, for the story. */
  unemploymentPeakPct: number;
  /** The short-rate move over the horizon, in basis points. */
  rateMoveBp: number;
  /** Commercial real estate and house price moves, peak to trough. */
  crePricePct: number;
  housePricePct: number;
  /** Fee income change. */
  feeIncomePct: number;
  /** Total asset growth a quarter. */
  assetGrowthPctQ: number;
  /** Cumulative nine-quarter loss rate by loan type, percent of today's balance. */
  lossPct: Record<string, number>;
}

/** Nine-quarter cumulative loss rates. Baseline is about normal losses; severe is in the range large-bank stress tests have used. */
const LOSS: Record<ScenarioKey, Record<string, number>> = {
  baseline: { Mortgage: 0.15, HELOC: 0.35, Auto: 1.3, Personal: 5.0, 'Credit Card': 7.0, Consumer: 4.5, Business: 1.2, 'Commercial Real Estate': 0.6, 'Commercial & Industrial': 1.4 },
  adverse: { Mortgage: 0.7, HELOC: 1.4, Auto: 2.8, Personal: 7.5, 'Credit Card': 11.0, Consumer: 6.8, Business: 3.2, 'Commercial Real Estate': 3.4, 'Commercial & Industrial': 3.6 },
  severe: { Mortgage: 1.6, HELOC: 3.2, Auto: 5.0, Personal: 10.5, 'Credit Card': 16.5, Consumer: 9.5, Business: 6.2, 'Commercial Real Estate': 7.5, 'Commercial & Industrial': 6.5 },
};
const OTHER_LOSS: Record<ScenarioKey, number> = { baseline: 0.8, adverse: 2.5, severe: 5.0 };

export const SCENARIOS: Scenario[] = [
  { key: 'baseline', name: 'Baseline', story: 'Growth slows but holds; unemployment stays near 4.5% and short rates ease 50 bp.', unemploymentPeakPct: 4.5, rateMoveBp: -50, crePricePct: 0, housePricePct: 2, feeIncomePct: 0, assetGrowthPctQ: 0.75, lossPct: LOSS.baseline },
  { key: 'adverse', name: 'Adverse', story: 'A moderate recession: unemployment rises to 7%, short rates fall 150 bp, commercial property values fall 15%.', unemploymentPeakPct: 7, rateMoveBp: -150, crePricePct: -15, housePricePct: -8, feeIncomePct: -10, assetGrowthPctQ: 0, lossPct: LOSS.adverse },
  { key: 'severe', name: 'Severely adverse', story: 'A deep recession: unemployment rises to 10%, short rates fall 300 bp to near zero, commercial property values fall 35% and house prices 25%.', unemploymentPeakPct: 10, rateMoveBp: -300, crePricePct: -35, housePricePct: -25, feeIncomePct: -20, assetGrowthPctQ: -0.5, lossPct: LOSS.severe },
];

/** How a scenario's losses fall across the nine quarters: building to a peak in the second year. */
const LOSS_SHAPE = [0.06, 0.09, 0.12, 0.14, 0.15, 0.14, 0.12, 0.10, 0.08];
/** How fast the rate path reaches net interest income: a quarter of the way each quarter. */
const RATE_PHASE = [0.25, 0.5, 0.75, 1, 1, 1, 1, 1, 1];
const TAX_RATE = 0.21;
const DIVIDEND_PAYOUT = 0.3;
const QUARTERS = 9;

export interface QuarterLine {
  quarter: string;
  nii: number;
  feeIncome: number;
  expense: number;
  ppnr: number;
  chargeOffs: number;
  provision: number;
  allowance: number;
  pretax: number;
  netIncome: number;
  capital: number;
  assets: number;
  ratioPct: number;
}

const quarterName = (end: string, ahead: number) => {
  const y = Number(end.slice(0, 4));
  const q = Math.floor((Number(end.slice(5, 7)) - 1) / 3) + 1 + ahead;
  return `Q${((q - 1) % 4) + 1} ${y + Math.floor((q - 1) / 4)}`;
};

export class StressService {
  constructor(
    private readonly pool: Pool,
    private readonly institutionType: 'credit_union' | 'bank' = 'credit_union',
  ) {}

  /** Today's starting point: capital, assets, the allowance and a year of earnings, from the latest Call Report. */
  async start() {
    const bank = this.institutionType === 'bank';
    const codes = bank ? { capital: 'RCON8274', assets: 'RCON2170', allowance: 'RCON3123', ii: 'RIAD4107', ie: 'RIAD4073', fee: 'RIAD4079', opex: 'RIAD4093', provision: 'RIADJJ33' } : { capital: '997', assets: '010', allowance: 'AS0048', ii: '115', ie: '350', fee: '117', opex: '671', provision: 'IS0017' };
    const list = await rows<{ quarter_end: unknown; code: string; amount: number }>(this.pool, 'SELECT quarter_end, code, amount FROM cr_value WHERE quarter_end = (SELECT MAX(quarter_end) FROM cr_value) AND code IN (?)', [Object.values(codes)]);
    if (!list.length) return null;
    const end = String(list[0]!.quarter_end).slice(0, 10);
    const v = (k: keyof typeof codes) => Number(list.find((x) => x.code === codes[k])?.amount ?? 0);
    // Income statement items are year to date; annualize them.
    const year = 12 / Number(end.slice(5, 7));
    const loans = await rows<{ c: string; b: number; ltv: number | null }>(this.pool, 'SELECT loan_category AS c, SUM(balance) AS b, SUM(balance * ltv) / NULLIF(SUM(CASE WHEN ltv IS NOT NULL THEN balance END), 0) AS ltv FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL GROUP BY loan_category ORDER BY b DESC');
    return {
      end,
      bank,
      capital: v('capital'),
      assets: v('assets'),
      allowance: v('allowance'),
      nii: (v('ii') - v('ie')) * year,
      feeIncome: v('fee') * year,
      expense: v('opex') * year,
      provision: v('provision') * year,
      loans: loans.map((l) => ({ category: l.c, balance: Number(l.b), ltvPct: l.ltv === null ? null : Number(l.ltv) })),
      ratioName: bank ? 'Tier 1 leverage ratio' : 'Net worth ratio',
      /** Bank: the community bank leverage ratio's requirement (8% from July 1, 2026); credit union: well capitalized at 7%. */
      minimumPct: bank ? 8 : 7,
      minimumName: bank ? 'the community bank leverage ratio’s 8% requirement' : 'the 7% well-capitalized net worth ratio',
    };
  }

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

  /** Nine quarters under one scenario. lossScale multiplies its loss rates (1 for the scenario as written). */
  project(s: Scenario, start: NonNullable<Awaited<ReturnType<StressService['start']>>>, niiPctAt: (bp: number) => number, lossScale = 1) {
    const loanTotal = start.loans.reduce((x, l) => x + l.balance, 0);
    const cumulative = start.loans.map((l) => ({ category: l.category, balance: l.balance, ratePct: (s.lossPct[l.category] ?? OTHER_LOSS[s.key]) * lossScale }));
    const lossesBy = (q: number) => cumulative.reduce((x, l) => x + (l.balance * l.ratePct * (LOSS_SHAPE[q] ?? LOSS_SHAPE.at(-1)!)) / 100, 0);
    const quarterLosses = Array.from({ length: QUARTERS + 8 }, (_, q) => lossesBy(Math.min(q, QUARTERS - 1)) * (q >= QUARTERS ? 0.8 ** (q - QUARTERS + 1) : 1));
    const niiShift = niiPctAt(s.rateMoveBp) / 100;
    let allowance = start.allowance;
    let capital = start.capital;
    let assets = start.assets;
    const out: QuarterLine[] = [];
    for (let q = 0; q < QUARTERS; q++) {
      assets *= 1 + s.assetGrowthPctQ / 100;
      const growth = assets / start.assets;
      // Interest is lost on what has been charged off, at about the book's yield.
      const lostInterest = (quarterLosses.slice(0, q).reduce((x, y) => x + y, 0) * 0.065) / 4;
      const nii = ((start.nii * growth) / 4) * (1 + niiShift * RATE_PHASE[q]!) - lostInterest;
      const feeIncome = (start.feeIncome / 4) * (1 + (s.feeIncomePct / 100) * RATE_PHASE[q]!);
      const expense = (start.expense / 4) * (1 + 0.005 * q);
      const ppnr = nii + feeIncome - expense;
      const chargeOffs = quarterLosses[q]!;
      // The allowance moves halfway each quarter towards the next eight quarters' expected losses, never below today's.
      const target = Math.max(quarterLosses.slice(q + 1, q + 9).reduce((x, y) => x + y, 0), start.allowance);
      const next = allowance + (target - allowance) * 0.5;
      const provision = chargeOffs + (next - allowance);
      allowance = next;
      const pretax = ppnr - provision;
      const tax = start.bank && pretax > 0 ? pretax * TAX_RATE : 0;
      const netIncome = pretax - tax;
      const dividends = start.bank && netIncome > 0 ? netIncome * DIVIDEND_PAYOUT : 0;
      capital += netIncome - dividends;
      out.push({ quarter: quarterName(start.end, q + 1), nii, feeIncome, expense, ppnr, chargeOffs, provision, allowance, pretax, netIncome, capital, assets, ratioPct: (capital / assets) * 100 });
    }
    const trough = out.reduce((m, x) => (x.ratioPct < m.ratioPct ? x : m), out[0]!);
    const losses = out.reduce((x, y) => x + y.chargeOffs, 0);
    return {
      scenario: s,
      quarters: out,
      startPct: (start.capital / start.assets) * 100,
      endPct: out.at(-1)!.ratioPct,
      trough,
      losses,
      lossPct: loanTotal ? (losses / loanTotal) * 100 : 0,
      ppnr: out.reduce((x, y) => x + y.ppnr, 0),
      provisions: out.reduce((x, y) => x + y.provision, 0),
      netIncome: out.reduce((x, y) => x + y.netIncome, 0),
      cushionPct: trough.ratioPct - start.minimumPct,
      byCategory: cumulative.map((l) => ({ category: l.category, balance: l.balance, lossPct: l.ratePct * LOSS_SHAPE.reduce((x, y) => x + y, 0), losses: (l.balance * l.ratePct * LOSS_SHAPE.reduce((x, y) => x + y, 0)) / 100 })).sort((a, b) => b.losses - a.losses),
    };
  }

  /** All three scenarios, the reverse stress test and the commercial real estate sensitivity. */
  async analysis() {
    const start = await this.start();
    if (!start) return null;
    const niiAt = await this.niiAt();
    const runs = SCENARIOS.map((s) => this.project(s, start, niiAt));
    const severe = SCENARIOS.find((s) => s.key === 'severe')!;
    // Reverse stress: how many times severe losses take the lowest point to the minimum.
    let lo = 0;
    let hi = 40;
    if (this.project(severe, start, niiAt, hi).trough.ratioPct > start.minimumPct) lo = hi;
    else
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (this.project(severe, start, niiAt, mid).trough.ratioPct > start.minimumPct) lo = mid;
        else hi = mid;
      }
    const breaking = this.project(severe, start, niiAt, lo);
    return { start, runs, reverse: { multiple: lo, losses: breaking.losses, lossPct: breaking.lossPct, quarter: breaking.trough.quarter }, cre: await this.creSensitivity(start), assumptions: this.assumptions(start) };
  }

  /**
   * What falls in commercial property values would cost: each commercial real estate loan's collateral
   * falls by the decline; a loan left owing more than 90% of its new value (after selling costs) is
   * likelier to default, and the shortfall is the loss.
   */
  async creSensitivity(start: NonNullable<Awaited<ReturnType<StressService['start']>>>) {
    const category = start.bank ? 'Commercial Real Estate' : 'Business';
    const loans = await rows<{ b: number; ltv: number | null }>(this.pool, 'SELECT balance AS b, ltv FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL AND loan_category = ?', [category]);
    const balance = loans.reduce((x, l) => x + Number(l.b), 0);
    const declines = [10, 20, 30, 40];
    return {
      category,
      balance,
      loans: loans.length,
      averageLtvPct: balance ? loans.reduce((x, l) => x + Number(l.b) * Number(l.ltv ?? 70), 0) / balance : 0,
      lines: declines.map((d) => {
        let losses = 0;
        let under = 0;
        for (const l of loans) {
          const b = Number(l.b);
          const value = b / (Number(l.ltv ?? 70) / 100);
          const net = value * (1 - d / 100) * 0.9;
          if (net < b) {
            under += b;
            const ltvAfter = (b / (value * (1 - d / 100))) * 100;
            const pd = ltvAfter > 120 ? 0.5 : ltvAfter > 100 ? 0.3 : 0.15;
            losses += (b - net) * pd;
          }
        }
        const after = start.capital - losses * (start.bank ? 1 - TAX_RATE : 1);
        return { declinePct: d, underwater: under, underwaterPct: balance ? (under / balance) * 100 : 0, losses, ratioPct: (after / start.assets) * 100 };
      }),
    };
  }

  assumptions(start: NonNullable<Awaited<ReturnType<StressService['start']>>>) {
    return [
      ['Scenarios', 'DI’s illustrative baseline, adverse and severely adverse scenarios over nine quarters. They are not the Federal Reserve’s; load the Fed’s published scenarios, or your own, to replace them.'],
      ['Starting point', `The ${start.bank ? 'FFIEC 051' : '5300'} for the quarter ended ${start.end}: capital, total assets, the allowance and a year of earnings at the year-to-date pace.`],
      ['Credit losses', 'Cumulative nine-quarter loss rates by loan type for each scenario, building to a peak in the second year. Severely adverse rates are in the range large-bank stress tests have used.'],
      ['Allowance', 'Moves halfway each quarter towards the next eight quarters’ expected losses, and never falls below today’s; the provision is charge-offs plus the change in the allowance.'],
      ['Net interest income', 'Moved by the scenario’s rate path through DI’s rate-risk model, phased in over a year, less interest lost on charged-off loans.'],
      ['Fee income and expenses', 'Fee income falls with the scenario; operating expenses rise 0.5% a quarter.'],
      ['Balance sheet', 'Total assets grow 0.75% a quarter in the baseline, are flat in adverse and shrink 0.5% a quarter in severely adverse.'],
      ['Tax and dividends', start.bank ? 'Tax at 21% on profits; 30% of profits paid out as dividends; no capital raised.' : 'Credit unions pay no income tax and no dividends from net worth; no capital raised.'],
      ['Minimum', `${start.ratioName} against ${start.minimumName}.`],
    ] as [string, string][];
  }
}
