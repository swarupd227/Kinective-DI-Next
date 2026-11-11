// Capital actions for next year: what a mix of dividend, buyback, loan growth by type, an allowance top-up
// and a sale of low-yield securities does to the bank, a year ahead. Every figure comes from DI's own
// services: the capital plan's floors and stress buffers, the CECL estimate, the rate-risk model (EVE
// revalued on the changed balance sheet), the concentration limits, the liquidity policy and the severely
// adverse stress test's loss rates. Nothing here is the model's; an agent chooses the levers and code
// works out what they do.
import type { Pool } from '@dinext/tenant-db';
import { CapitalPlanService } from './capitalPlan.ts';
import { CeclService } from './cecl.ts';
import { CONCENTRATION_LIMITS, ConcentrationService } from './concentration.ts';
import { FundingRiskService } from './fundingRisk.ts';
import { IrrService, scalePosition, type Position } from './irr.ts';
import { LIQUIDITY_POLICY, LiquidityService } from './liquidity.ts';
import { PerShareService } from './perShare.ts';
import { StressService } from './stress.ts';

const TAX = 0.21;
/** What cash earns, and what proceeds from a securities sale are reinvested at: the capital plan's rate. */
const CASH_YIELD = 0.0425;
/** The rate-risk model's yield on the investment portfolio. */
const BOOK_YIELD = 0.0305;
/** Risk weight of the securities sold (agency and municipal bonds); cash carries none. */
const SECURITIES_RW = 0.2;
/** A check is thin when it has used this much of its limit: little room for anything to go wrong. */
export const THIN_SHARE = 0.95;

export type LoanKey = 'office' | 'multifamily' | 'other_cre' | 'ci' | 'mortgage' | 'consumer';
/** Loan types a plan can grow, with where each sits in the rate-risk model, the stress test and the CECL pools. */
export const LOAN_TYPES: { key: LoanKey; label: string; irr: string; book: string; rw: number; cre: boolean; property?: string }[] = [
  { key: 'office', label: 'Office CRE', irr: 'Commercial real estate', book: 'Commercial Real Estate', rw: 1, cre: true, property: 'Office' },
  { key: 'multifamily', label: 'Multifamily', irr: 'Commercial real estate', book: 'Commercial Real Estate', rw: 1, cre: true, property: 'Multifamily' },
  { key: 'other_cre', label: 'Other CRE', irr: 'Commercial real estate', book: 'Commercial Real Estate', rw: 1, cre: true },
  { key: 'ci', label: 'C&I', irr: 'Commercial loans', book: 'Commercial & Industrial', rw: 1, cre: false },
  { key: 'mortgage', label: 'Residential mortgage', irr: 'First mortgages', book: 'Mortgage', rw: 0.5, cre: false },
  { key: 'consumer', label: 'Consumer and auto', irr: 'Consumer loans', book: 'Consumer', rw: 1, cre: false },
];
export const LOAN_KEYS = LOAN_TYPES.map((t) => t.key);

/** One plan's choices. Amounts in dollars; growth is new loans net of runoff over the year. */
export interface CapitalLevers {
  dividendPerShareQ: number;
  buyback: number;
  growth: Record<LoanKey, number>;
  allowanceTopUp: number;
  /** Low-yield available-for-sale securities sold, at amortized cost; the loss is realized. */
  afsSale: number;
}

export type CheckId = 'leverage' | 'cet1' | 'eve200' | 'eve400' | 'liquidity' | 'office' | 'multifamily' | 'cre' | 'allowance';
export type CheckStatus = 'pass' | 'watch' | 'thin' | 'breach';
export interface PlanCheck {
  id: CheckId;
  /** The specialist whose limit it is. */
  owner: 'capital' | 'cecl' | 'irr' | 'concentration' | 'liquidity' | 'stress';
  label: string;
  value: number;
  limit: number;
  /** Higher is better (a floor) or lower is better (a cap). Declines are shown as positive numbers against a positive limit. */
  kind: 'floor' | 'cap';
  unit: '%' | '$';
  /** Share of the limit used: 1 is at the limit. */
  used: number;
  status: CheckStatus;
  /** Already over its limit today, before any plan: the IRR analysis shows it too. */
  today: boolean;
}

export type PlanFigures = ReturnType<CapitalActionsModel['evaluate']>;

const statusOf = (used: number, thin = THIN_SHARE, watch = 0.85): CheckStatus => (used > 1 + 1e-9 ? 'breach' : used >= thin ? 'thin' : used >= watch ? 'watch' : 'pass');
/** Capital ratios are thin within about a quarter point of their floor. */
const CAPITAL_THIN = 0.98;

export class CapitalActionsService {
  constructor(private readonly pool: Pool) {}

  /** Everything a plan is measured against, read once. Null when the bank has no Call Report or share data. */
  async model() {
    const irrSvc = new IrrService(this.pool);
    const [cap, ps, cecl, conc, liq, stress, sec, loaded] = await Promise.all([
      new CapitalPlanService(this.pool).analysis(),
      new PerShareService(this.pool).figures().catch(() => null),
      new CeclService(this.pool).analysis().catch(() => null),
      new ConcentrationService(this.pool).analysis().catch(() => null),
      new LiquidityService(this.pool, 'bank').analysis().catch(() => null),
      new StressService(this.pool, 'bank').analysis().catch(() => null),
      new FundingRiskService(this.pool).securities().catch(() => null),
      irrSvc.positions(),
    ]);
    if (!cap || !ps || !cap.perShare?.price || !cecl || !conc || !liq || !stress) return null;
    return new CapitalActionsModel({ cap, ps, cecl, conc, liq, stress, sec, loaded, irr: irrSvc });
  }
}

type Inputs = {
  cap: NonNullable<Awaited<ReturnType<CapitalPlanService['analysis']>>>;
  ps: NonNullable<Awaited<ReturnType<PerShareService['figures']>>>;
  cecl: NonNullable<Awaited<ReturnType<CeclService['analysis']>>>;
  conc: NonNullable<Awaited<ReturnType<ConcentrationService['analysis']>>>;
  liq: Awaited<ReturnType<LiquidityService['analysis']>>;
  stress: NonNullable<Awaited<ReturnType<StressService['analysis']>>>;
  sec: Awaited<ReturnType<FundingRiskService['securities']>>;
  loaded: Awaited<ReturnType<IrrService['positions']>>;
  irr: IrrService;
};

/** The bank today and the arithmetic of a plan. Synchronous once loaded, so an optimizer can call it freely. */
export class CapitalActionsModel {
  readonly today;
  /** Limits already breached today, so a capital action cannot be blamed for them, only judged on whether it helps. */
  private readonly overToday = new Set<CheckId>();
  constructor(private readonly x: Inputs) {
    const { cap, cecl, conc, liq, stress, sec, ps } = x;
    const severe = stress.runs.find((r) => r.scenario.key === 'severe')!;
    const now = x.irr.whatIf(x.loaded);
    const at = (bp: number) => now.shocks.find((s) => s.shockBp === bp)!;
    const property = (t: string) => conc.property.find((p) => p.type === t);
    const liquidity = liq.ratios.find((r) => /liquid assets to total assets/i.test(r.name))!;
    this.today = {
      quarter: cap.quarter,
      cap,
      niYear: cap.year.ni,
      shares: ps.now.shares!,
      weighted: ps.now.weighted ?? ps.now.shares!,
      price: ps.now.price!,
      tce: ps.now.tce,
      tbvps: ps.now.tbvps!,
      eps: cap.year.ni / (ps.now.weighted ?? ps.now.shares!),
      dividendPerShareQ: cap.settings.dividendPerShareQ,
      allowance: cecl.now.allowance,
      ceclEstimate: cecl.estimate.total,
      ceclGap: cecl.gap,
      ceclBookedPct: cecl.bookedPct ?? 100,
      coverage: Object.fromEntries(cecl.estimate.pools.map((p) => [p.category, p.coveragePct / 100])) as Record<string, number>,
      coverageAll: cecl.estimate.coveragePct / 100,
      severeLoss: Object.fromEntries(severe.byCategory.map((c) => [c.category, c.lossPct / 100])) as Record<string, number>,
      severeTrough: severe.trough,
      severeCushion: severe.cushionPct,
      stressMinimum: stress.start.minimumPct,
      eve: { 200: at(200).evPct, 300: at(300).evPct, 400: at(400).evPct, limit200: at(200).evLimitPct, limit400: at(400).evLimitPct, value: now.ev },
      liquid: liq.liquid,
      totalAssets: liq.totalAssets,
      liquidPct: liquidity.value,
      liquidMin: LIQUIDITY_POLICY.liquidToAssetsMinPct,
      available: liq.available,
      deposits: liq.shares,
      concCapital: conc.regulatory.capital,
      office: property('Office')?.balance ?? 0,
      officePct: property('Office')?.pctOfCapital ?? 0,
      multifamily: property('Multifamily')?.balance ?? 0,
      multifamilyPct: property('Multifamily')?.pctOfCapital ?? 0,
      nonOwnerCre: conc.regulatory.nonOwnerCre,
      crePct: conc.regulatory.crePct,
      limits: { office: CONCENTRATION_LIMITS.property.Office!, multifamily: CONCENTRATION_LIMITS.property.Multifamily!, cre: CONCENTRATION_LIMITS.creGuidancePct },
      afs: sec ? { book: sec.trend.at(-1)!.afsBook, fair: sec.trend.at(-1)!.afsFair, lossRate: sec.trend.at(-1)!.afsBook ? Math.max(0, sec.trend.at(-1)!.afsLoss) / sec.trend.at(-1)!.afsBook : 0 } : { book: 0, fair: 0, lossRate: 0 },
      yields: Object.fromEntries(x.loaded.positions.map((p) => [p.name, p.rate])) as Record<string, number>,
      loanBalance: Object.fromEntries(x.loaded.positions.map((p) => [p.name, p.balance])) as Record<string, number>,
      fundingRate: x.loaded.positions.find((p) => p.name === 'Certificates')?.rate ?? CASH_YIELD,
      dividendRule: cap.dividendRule,
    };
    if (-this.today.eve[200] > this.today.eve.limit200) this.overToday.add('eve200');
    if (-this.today.eve[400] > this.today.eve.limit400) this.overToday.add('eve400');
    if (this.today.officePct > this.today.limits.office) this.overToday.add('office');
    if (this.today.liquidPct < this.today.liquidMin) this.overToday.add('liquidity');
  }

  /** Today's levers: the declared dividend and nothing else. */
  levers(over: Partial<Omit<CapitalLevers, 'growth'>> & { growth?: Partial<Record<LoanKey, number>> } = {}): CapitalLevers {
    const growth = Object.fromEntries(LOAN_KEYS.map((k) => [k, Math.max(0, over.growth?.[k] ?? 0)])) as Record<LoanKey, number>;
    return { dividendPerShareQ: over.dividendPerShareQ ?? this.today.dividendPerShareQ, buyback: Math.max(0, over.buyback ?? 0), growth, allowanceTopUp: Math.max(0, over.allowanceTopUp ?? 0), afsSale: Math.min(Math.max(0, over.afsSale ?? 0), this.today.afs.book) };
  }

  /** What one plan does, a year ahead. */
  evaluate(l: CapitalLevers) {
    const t = this.today;
    const cap = t.cap;
    const n = cap.now;
    const types = LOAN_TYPES.map((lt) => ({ ...lt, amount: l.growth[lt.key] ?? 0 }));
    const growth = types.reduce((s, g) => s + g.amount, 0);

    // Earnings. New loans earn their book's yield over certificate funding, on half a year's balance, and
    // are reserved at their pool's coverage when booked. The top-up and a sale's loss are one-time.
    const cov = (book: string) => t.coverage[book] ?? t.coverageAll;
    const yieldOf = (irr: string) => t.yields[irr] ?? t.fundingRate;
    const spreadYear = types.reduce((s, g) => s + g.amount * (yieldOf(g.irr) - t.fundingRate), 0);
    const reserve = types.reduce((s, g) => s + g.amount * cov(g.book), 0);
    const afsLoss = l.afsSale * t.afs.lossRate;
    const afsPickup = (l.afsSale - afsLoss) * CASH_YIELD - l.afsSale * BOOK_YIELD;
    const forgone = l.buyback * CASH_YIELD;
    const pretaxOneTime = -l.allowanceTopUp - afsLoss - reserve;
    const pretaxRecurring = spreadYear / 2 + afsPickup - forgone;
    const ni = t.niYear + (pretaxOneTime + pretaxRecurring) * (1 - TAX);
    // Run rate: a full year of the new loans' spread and the reinvested proceeds, without one-time charges.
    const niRun = t.niYear + (spreadYear + afsPickup - forgone) * (1 - TAX);

    // Shares and capital.
    const retired = l.buyback / t.price;
    const dividends = l.dividendPerShareQ * 4 * (t.shares - retired / 2);
    const payout = dividends + l.buyback;
    const cet1 = n.cet1 + ni - payout;
    const tier1 = n.tier1 + ni - payout;
    const rwa = n.rwa + types.reduce((s, g) => s + g.amount * g.rw, 0) - l.afsSale * SECURITIES_RW;
    // Average assets: today's, plus loans funded by new deposits, plus earnings kept, less cash paid out.
    const assets = n.leverageAssets + growth + ni - payout;
    const cet1Pct = (cet1 / rwa) * 100;
    const levPct = (tier1 / assets) * 100;

    // Severe stress: today's decline plus the new loans' severe losses, less what the top-up already reserved.
    const extraLoss = Math.max(0, types.reduce((s, g) => s + g.amount * (t.severeLoss[g.book] ?? 0), 0) - l.allowanceTopUp) * (1 - TAX);
    const levStress = cap.stress.levStress + (extraLoss / assets) * 100;
    const cet1Stress = cap.stress.cet1Stress + (extraLoss / rwa) * 100;
    const levFloor = Math.max(cap.settings.leverageTarget, (cap.cblr ? 8 : 4) + levStress);
    const cet1Floor = Math.max(cap.settings.cet1Target, 4.5 + Math.max(2.5, cet1Stress));
    const levStressed = levPct - levStress;

    // Per share.
    const eps = ni / (t.weighted - retired);
    const epsRun = niRun / (t.weighted - retired);
    // A sale moves its loss from AOCI to retained earnings: tangible book value already carried it.
    const tbvps = (t.tce + ni + afsLoss * (1 - TAX) - payout) / (t.shares - retired);

    // Rate risk: the balance sheet with the plan's loans (funded by certificates), the securities sold
    // into cash, and cash moved by earnings kept and paid out.
    const byIrr = new Map<string, number>();
    for (const g of types) byIrr.set(g.irr, (byIrr.get(g.irr) ?? 0) + g.amount);
    // Cash: earnings before their non-cash charges (provisions, the realized loss), less payouts, plus the sale's proceeds.
    const cashMove = ni + l.allowanceTopUp + reserve + afsLoss - payout + (l.afsSale - afsLoss);
    const ev = this.x.irr.whatIf(this.x.loaded, (ps: Position[]) =>
      ps.map((p) => {
        if (byIrr.has(p.name)) return scalePosition(p, 1 + byIrr.get(p.name)! / p.balance);
        if (p.name === 'Certificates') return scalePosition(p, 1 + growth / p.balance);
        if (p.name === 'Investments') return scalePosition(p, 1 - l.afsSale / p.balance);
        if (p.name === 'Cash and overnight funds') return scalePosition(p, Math.max(0, 1 + cashMove / p.balance));
        return p;
      }),
      [200, 300, 400],
    );
    const evAt = (bp: number) => ev.shocks.find((s) => s.shockBp === bp)!;

    // Liquidity: loans are funded by new deposits; earnings kept add cash, payouts take it, a sale turns bonds into cash.
    const liquid = t.liquid + cashMove;
    const totalAssets = t.totalAssets + growth + ni - payout;
    const liquidPct = (liquid / totalAssets) * 100;

    // Concentration: tier 1 plus the allowance, a year ahead.
    const allowance = t.allowance + l.allowanceTopUp + reserve;
    const concCapital = tier1 + allowance;
    const officePct = ((t.office + l.growth.office) / concCapital) * 100;
    const multifamilyPct = ((t.multifamily + l.growth.multifamily) / concCapital) * 100;
    const crePct = ((t.nonOwnerCre + l.growth.office + l.growth.multifamily + l.growth.other_cre) / concCapital) * 100;

    // CECL: the new loans are reserved at coverage, so the gap moves only with the top-up.
    const ceclGap = t.ceclGap - l.allowanceTopUp;
    const ceclBookedPct = (allowance / (t.ceclEstimate + reserve)) * 100;

    const check = (c: Omit<PlanCheck, 'used' | 'status' | 'today'>, thin = THIN_SHARE, watch = 0.85): PlanCheck => {
      const used = c.kind === 'cap' ? c.value / c.limit : c.limit / c.value;
      return { ...c, used, status: statusOf(used, thin, watch), today: this.overToday.has(c.id) };
    };
    const checks: PlanCheck[] = [
      // The floor is the CBLR's 8% plus the plan's severe stress decline (or the board's target), so holding it holds the stressed ratio too.
      check({ id: 'leverage', owner: 'capital', label: 'Leverage ratio against its floor', value: levPct, limit: levFloor, kind: 'floor', unit: '%' }, CAPITAL_THIN, 0.93),
      check({ id: 'cet1', owner: 'capital', label: 'CET1 against its floor', value: cet1Pct, limit: cet1Floor, kind: 'floor', unit: '%' }, CAPITAL_THIN, 0.9),
      check({ id: 'eve200', owner: 'irr', label: 'EVE decline at +200 bp', value: -evAt(200).evPct, limit: evAt(200).evLimitPct, kind: 'cap', unit: '%' }),
      check({ id: 'eve400', owner: 'irr', label: 'EVE decline at +400 bp', value: -evAt(400).evPct, limit: evAt(400).evLimitPct, kind: 'cap', unit: '%' }),
      check({ id: 'liquidity', owner: 'liquidity', label: 'Liquid assets to total assets', value: liquidPct, limit: t.liquidMin, kind: 'floor', unit: '%' }, THIN_SHARE, 0.9),
      check({ id: 'office', owner: 'concentration', label: 'Office CRE to capital', value: officePct, limit: t.limits.office, kind: 'cap', unit: '%' }),
      check({ id: 'multifamily', owner: 'concentration', label: 'Multifamily to capital', value: multifamilyPct, limit: t.limits.multifamily, kind: 'cap', unit: '%' }),
      check({ id: 'cre', owner: 'concentration', label: 'Non-owner-occupied CRE to capital', value: crePct, limit: t.limits.cre, kind: 'cap', unit: '%' }),
      // The allowance: thin when it is below DI's estimate at all, a breach when it reads short (under 90%).
      { id: 'allowance', owner: 'cecl', label: 'Allowance against DI’s CECL estimate', value: ceclBookedPct, limit: 90, kind: 'floor', unit: '%', used: 90 / ceclBookedPct, status: ceclBookedPct < 90 ? 'breach' : ceclGap > 1000 ? 'thin' : 'pass', today: false },
    ];

    // How far rates could go past +200 bp before the EVE limit there is reached, from the +200 and +300 bp points.
    const d200 = -evAt(200).evPct;
    const d300 = -evAt(300).evPct;
    const eveBreachBp = d300 > d200 ? 200 + (100 * (evAt(200).evLimitPct - d200)) / (d300 - d200) : null;

    return {
      levers: l,
      growth,
      dividends,
      buyback: l.buyback,
      payout,
      retired,
      retiredPct: (retired / t.shares) * 100,
      ni,
      niRun,
      afsLoss,
      afsLossAfterTax: afsLoss * (1 - TAX),
      afsPickup,
      afsEarnbackYears: afsPickup > 0 && afsLoss > 0 ? afsLoss / afsPickup : null,
      reserve,
      cet1Pct,
      levPct,
      cet1Floor,
      levFloor,
      levStress,
      levStressed,
      cet1Stressed: cet1Pct - cet1Stress,
      eps,
      epsRun,
      epsChangePct: ((epsRun - t.eps) / t.eps) * 100,
      tbvps,
      tbvChangePct: ((tbvps - t.tbvps) / t.tbvps) * 100,
      eve200: evAt(200).evPct,
      eve300: evAt(300).evPct,
      eve400: evAt(400).evPct,
      eveBreachBp,
      liquidPct,
      officePct,
      officeRoom: (t.limits.office / 100) * concCapital - t.office - l.growth.office,
      multifamilyPct,
      crePct,
      allowance,
      ceclGap,
      ceclBookedPct,
      checks,
      breaches: checks.filter((c) => c.status === 'breach'),
      thin: checks.filter((c) => c.status === 'thin'),
    };
  }

  /** The largest buyback that keeps every check within its limit (or out of the thin zone, with cushion), to the nearest $100,000. */
  maxBuyback(l: CapitalLevers, opts: { cushion?: boolean } = {}) {
    // A limit the plan breaches with no buyback at all is not the buyback's to fix, so it doesn't stop one.
    // One already thin without a buyback must still not be breached.
    const start = this.evaluate({ ...l, buyback: 0 }).checks;
    const failing = new Set(start.filter((c) => c.status === 'breach').map((c) => c.id));
    const thin = new Set(start.filter((c) => c.status === 'thin').map((c) => c.id));
    const ok = (b: number) => {
      const f = this.evaluate({ ...l, buyback: b });
      return f.checks.every((c) => failing.has(c.id) || c.status !== 'breach') && (!opts.cushion || f.checks.every((c) => thin.has(c.id) || failing.has(c.id) || c.status !== 'thin'));
    };
    if (!ok(0)) return 0;
    let lo = 0;
    let hi = Math.max(1e6, this.today.cap.capacity.total * 2);
    if (ok(hi)) return hi;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    return Math.floor(lo / 1e5) * 1e5;
  }

  /**
   * The smallest securities sale that brings one rate-risk check within its limit (or out of the thin zone,
   * with cushion), rounded up to $1M. Null when even selling the whole low-yield book would not.
   */
  afsToClear(l: CapitalLevers, id: CheckId, opts: { cushion?: boolean } = {}) {
    const ok = (sale: number) => {
      const c = this.evaluate({ ...l, afsSale: sale }).checks.find((x) => x.id === id)!;
      return opts.cushion ? c.status !== 'breach' && c.status !== 'thin' : c.status !== 'breach';
    };
    if (ok(l.afsSale)) return l.afsSale;
    const most = this.today.afs.book;
    if (!ok(most)) return null;
    let lo = l.afsSale;
    let hi = most;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) hi = mid;
      else lo = mid;
    }
    return Math.min(most, Math.ceil(hi / 1e6) * 1e6);
  }

  /** Office growth that keeps office CRE under its limit with the plan's capital, to the nearest $100,000. */
  officeRoom(l: CapitalLevers, share = 1) {
    const f = this.evaluate({ ...l, growth: { ...l.growth, office: 0 } });
    const capital = (this.today.office / f.officePct) * 100;
    return Math.max(0, Math.floor(((this.today.limits.office / 100) * share * capital - this.today.office) / 1e5) * 1e5);
  }

  assumptions(): [string, string][] {
    const t = this.today;
    return [
      ['A year ahead', `Earnings at the last twelve months’ pace (${(t.niYear / 1e6).toFixed(1)}M), plus what the plan changes. Ratios are measured against the capital plan’s floors: the higher of the board’s target and the minimum plus the severe stress decline, recomputed with each plan’s new loans.`],
      ['Loan growth', 'New loans earn their book’s current yield over certificate funding, on half a year’s balance in the first year; each is reserved at its CECL pool’s coverage when booked. Risk weights: 50% for residential mortgages, 100% for the rest. Severe stress losses at the stress test’s cumulative rate for the loan type.'],
      ['Allowance top-up', 'A provision expense in the year, after tax; it pre-funds the severe stress test’s losses, so the stress decline is smaller by the same amount.'],
      ['Buybacks', `At today’s price ($${t.price.toFixed(2)}). The cash would have earned ${(CASH_YIELD * 100).toFixed(2)}% before tax; shares retired lower the dividend and the share count.`],
      ['Securities sale', `Low-yield available-for-sale securities sold at amortized cost realize the portfolio’s average loss (${(t.afs.lossRate * 100).toFixed(1)}%) through earnings and regulatory capital. Tangible book value already carried it in AOCI. Proceeds are reinvested at ${(CASH_YIELD * 100).toFixed(2)}% against a ${(BOOK_YIELD * 100).toFixed(2)}% book yield.`],
      ['Rate risk', 'EVE is revalued with DI’s rate-risk model on the plan’s balance sheet: new loans like the existing book, funded by certificates; sale proceeds and retained earnings in cash, payouts out of it. Each decline is against that balance sheet’s own unshocked value.'],
      ['Liquidity and concentration', `Liquid assets to total assets against the ${t.liquidMin}% policy minimum. Concentrations are against tier 1 capital plus the allowance a year ahead.`],
    ];
  }
}
