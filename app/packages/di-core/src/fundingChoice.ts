// How to fund next year's loan growth: price deposits up, borrow from the FHLB, or buy brokered deposits,
// or a mix. Every figure comes from DI's own services: the growth from the capital plan, the balance sheet
// and its rate risk from the IRR model (revalued with each funding choice), the contingent capacity from
// the liquidity analysis and the wholesale funding from the Call Report. What new money costs is stated
// as assumptions, as an ALCO's funding memo does.
import type { Pool } from '@dinext/tenant-db';
import { CapitalPlanService } from './capitalPlan.ts';
import { FundingRiskService } from './fundingRisk.ts';
import { IrrService, scalePosition, type Position } from './irr.ts';
import { LIQUIDITY_POLICY, LiquidityService } from './liquidity.ts';
import { PerShareService } from './perShare.ts';

const TAX = 0.21;
/** What new money costs, a spread over the market rate the IRR model uses (4.25%). */
export const FUNDING_RATES = {
  market: 0.0425,
  /** A money market special priced to win new balances. */
  depositSpecial: 0.04,
  /** Each new dollar the special wins moves this much of the existing money market book to the special rate. */
  cannibalization: 0.75,
  /** Fixed-rate FHLB advances by term in months. */
  fhlb: { 12: 0.0435, 24: 0.0445, 36: 0.0455, 60: 0.047 } as Record<number, number>,
  /** A certificate special by term, priced above the market to win money that stays. */
  cdSpecial: { 24: 0.0435, 36: 0.044 } as Record<number, number>,
  /** Each new dollar a certificate special wins moves this much of maturing certificates to it. */
  cdCannibalization: 0.5,
  /** Brokered CDs by term in months, with the placement fee. */
  brokered: { 12: 0.0445, 36: 0.0455, 60: 0.047 } as Record<number, number>,
};
/** The demo bank's funding policy. A board sets its own; these sit beside the liquidity policy's minimums. */
export const FUNDING_POLICY = {
  /** Wholesale funding (FHLB and other borrowings plus brokered deposits) at most this share of total funding. */
  wholesaleMaxPct: 15,
  /** Brokered deposits at most this share of deposits. */
  brokeredMaxPct: 10,
  /** Keep at least this share of the FHLB line unused, for the contingency funding plan. */
  fhlbReservePct: 50,
};
const THIN = 0.95;

export interface FundingLevers {
  /** New money from a deposit special. */
  deposits: number;
  /** 0 for a money market special; otherwise a certificate special's term in months. */
  depositTermMonths: 0 | 24 | 36;
  fhlb: number;
  fhlbTermMonths: 12 | 24 | 36 | 60;
  brokered: number;
  brokeredTermMonths: 12 | 36 | 60;
}
export type FundingCheckId = 'eve200' | 'eve400' | 'nii200' | 'wholesale' | 'brokered' | 'fhlb_reserve' | 'contingent';
export interface FundingCheck {
  id: FundingCheckId;
  label: string;
  value: number;
  limit: number;
  kind: 'floor' | 'cap';
  used: number;
  status: 'pass' | 'watch' | 'thin' | 'breach';
  /** Already over its limit before any funding choice. */
  today: boolean;
  /** Over its limit today, and this choice makes it worse still. */
  worseThanToday: boolean;
}
export type FundingFigures = ReturnType<FundingModel['evaluate']>;

/** A fixed-rate liability repaid in one payment at maturity. */
function bullet(name: string, balance: number, rate: number, months: number): Position {
  const flows = new Array<number>(360).fill(0);
  flows[Math.min(360, months) - 1] = balance;
  return { name, side: 'liability', balance, rate, flows: () => flows, repriced: (m) => (m >= months ? 1 : 0), beta: 1, discount: rate, floating: false };
}

export class FundingChoiceService {
  constructor(private readonly pool: Pool) {}

  async model() {
    const irr = new IrrService(this.pool);
    const funding = new FundingRiskService(this.pool);
    const [cap, ps, liq, ltd, loaded, base] = await Promise.all([
      new CapitalPlanService(this.pool).analysis(),
      new PerShareService(this.pool).figures().catch(() => null),
      new LiquidityService(this.pool, 'bank').analysis().catch(() => null),
      funding.loanToDeposit().catch(() => null),
      irr.positions(),
      irr.analysis(),
    ]);
    if (!cap || !liq || !ltd) return null;
    return new FundingModel({ cap, ps, liq, ltd, loaded, irr, base });
  }
}

type Inputs = {
  cap: NonNullable<Awaited<ReturnType<CapitalPlanService['analysis']>>>;
  ps: Awaited<ReturnType<PerShareService['figures']>>;
  liq: Awaited<ReturnType<LiquidityService['analysis']>>;
  ltd: NonNullable<Awaited<ReturnType<FundingRiskService['loanToDeposit']>>>;
  loaded: Awaited<ReturnType<IrrService['positions']>>;
  irr: IrrService;
  base: Awaited<ReturnType<IrrService['analysis']>>;
};

export class FundingModel {
  readonly today;
  constructor(private readonly x: Inputs) {
    const { cap, liq, ltd, loaded, base } = x;
    const at = (bp: number) => base.scenarios.find((s) => s.shockBp === bp)!;
    const loans = loaded.positions.filter((p) => p.side === 'asset' && !['Cash and overnight funds', 'Investments'].includes(p.name));
    const loanTotal = loans.reduce((s, p) => s + p.balance, 0);
    const mm = loaded.positions.find((p) => p.name === 'Money market');
    const cds = loaded.positions.find((p) => p.name === 'Certificates');
    const fhlbRow = liq.capacity.find((c) => /FHLB/.test(c.source))!;
    this.today = {
      quarter: cap.quarter,
      /** Loan growth at the capital plan's pace, the same in every choice. */
      growth: Math.floor((loanTotal * (cap.settings.rwaGrowth / 100)) / 1e6) * 1e6,
      growthPct: cap.settings.rwaGrowth,
      loanTotal,
      loans,
      mmBalance: mm?.balance ?? 0,
      mmRate: mm?.rate ?? 0,
      cdBalance: cds?.balance ?? 0,
      cdRate: cds?.rate ?? 0,
      deposits: ltd.deposits,
      borrowings: ltd.borrowings,
      brokered: ltd.brokered,
      loansCallReport: ltd.loans,
      ltdPct: ltd.pct,
      wholesalePct: ltd.wholesaleSharePct,
      fhlbLine: fhlbRow.lendable,
      fhlbUsed: fhlbRow.used,
      available: liq.available,
      availablePct: liq.availableToShares,
      availableMin: LIQUIDITY_POLICY.availableToSharesMinPct,
      eve: { 200: at(200).nevPct, 400: at(400).nevPct, limit200: at(200).nevLimitPct, limit400: at(400).nevLimitPct },
      nii200: at(200).niiPct,
      nii200Limit: at(200).niiLimitPct,
      niiBase: base.base.nii,
      weighted: x.ps?.now.weighted ?? x.ps?.now.shares ?? null,
      earningAssets: loaded.positions.filter((p) => p.side === 'asset').reduce((s, p) => s + p.balance, 0),
    };
  }

  levers(over: Partial<FundingLevers> = {}): FundingLevers {
    return { deposits: Math.max(0, over.deposits ?? 0), depositTermMonths: over.depositTermMonths ?? 0, fhlb: Math.max(0, over.fhlb ?? 0), fhlbTermMonths: over.fhlbTermMonths ?? 24, brokered: Math.max(0, over.brokered ?? 0), brokeredTermMonths: over.brokeredTermMonths ?? 12 };
  }

  /** The growth funded one way: its cost, its rate risk, its liquidity and its wholesale reliance. */
  evaluate(l: FundingLevers) {
    const t = this.today;
    const g = t.growth;
    const funded = l.deposits + l.fhlb + l.brokered;
    // Whatever the sources leave unfunded comes out of cash.
    const fromCash = Math.max(0, g - funded);
    const fhlbRate = FUNDING_RATES.fhlb[l.fhlbTermMonths] ?? FUNDING_RATES.fhlb[24]!;
    const cd = l.depositTermMonths > 0;
    const depositRate = cd ? (FUNDING_RATES.cdSpecial[l.depositTermMonths] ?? FUNDING_RATES.cdSpecial[24]!) : FUNDING_RATES.depositSpecial;
    const brokeredRate = FUNDING_RATES.brokered[l.brokeredTermMonths] ?? FUNDING_RATES.brokered[12]!;
    // A special also reprices some of the bank's own balances: money market for a money market special, maturing certificates for a certificate one.
    const migrated = cd ? Math.min(t.cdBalance, l.deposits * FUNDING_RATES.cdCannibalization) : Math.min(t.mmBalance, l.deposits * FUNDING_RATES.cannibalization);
    const cannibalCost = migrated * Math.max(0, depositRate - (cd ? t.cdRate : t.mmRate));
    const costs = {
      deposits: l.deposits * depositRate + cannibalCost,
      fhlb: l.fhlb * fhlbRate,
      brokered: l.brokered * brokeredRate,
      cash: fromCash * FUNDING_RATES.market,
    };
    const cost = costs.deposits + costs.fhlb + costs.brokered + costs.cash;
    const allIn = g ? cost / g : 0;
    const epsImpact = t.weighted ? (-cost * (1 - TAX)) / t.weighted : null;
    const nimBp = t.earningAssets ? (-cost / (t.earningAssets + g)) * 10_000 : 0;

    // Rate risk: the loans grown in proportion, and each source as the liability it is.
    const k = 1 + g / t.loanTotal;
    const loanNames = new Set(t.loans.map((p) => p.name));
    const ev = this.x.irr.whatIf(this.x.loaded, (ps) => {
      const out = ps.map((p) => {
        if (loanNames.has(p.name)) return scalePosition(p, k);
        if (p.name === 'Money market' && l.deposits > 0 && !cd) {
          const grown = scalePosition(p, 1 + l.deposits / p.balance);
          // The special's rate on the new money and on the balances it moves.
          const rate = (p.balance * p.rate + l.deposits * FUNDING_RATES.depositSpecial + cannibalCost) / grown.balance;
          return { ...grown, rate };
        }
        if (p.name === 'Cash and overnight funds' && fromCash > 0) return scalePosition(p, Math.max(0, 1 - fromCash / p.balance));
        return p;
      });
      if (l.fhlb > 0) out.push(bullet('New FHLB advances', l.fhlb, fhlbRate, l.fhlbTermMonths));
      if (l.brokered > 0) out.push(bullet('Brokered CDs', l.brokered, brokeredRate, l.brokeredTermMonths));
      if (l.deposits > 0 && cd) out.push(bullet('Certificate special', l.deposits, depositRate + cannibalCost / l.deposits, l.depositTermMonths));
      return out;
    }, [200, 400]);
    const s = (bp: number) => ev.shocks.find((x) => x.shockBp === bp)!;

    // Funding and liquidity a year ahead.
    const deposits = t.deposits + l.deposits + l.brokered;
    const brokered = t.brokered + l.brokered;
    const borrowings = t.borrowings + l.fhlb;
    const wholesalePct = ((borrowings + brokered) / (deposits + borrowings)) * 100;
    const brokeredPct = (brokered / deposits) * 100;
    const fhlbUsedPct = t.fhlbLine ? ((t.fhlbUsed + l.fhlb) / t.fhlbLine) * 100 : 100;
    // Drawing the line uses contingent capacity; cash spent on loans leaves liquid assets.
    const available = t.available - l.fhlb - fromCash;
    const availablePct = (available / deposits) * 100;
    const ltdPct = ((t.loansCallReport + g) / deposits) * 100;

    const status = (used: number, watch = 0.85): FundingCheck['status'] => (used > 1 + 1e-9 ? 'breach' : used >= THIN ? 'thin' : used >= watch ? 'watch' : 'pass');
    const check = (c: Omit<FundingCheck, 'used' | 'status' | 'today' | 'worseThanToday'>, today: number | null): FundingCheck => {
      const used = c.kind === 'cap' ? c.value / c.limit : c.limit / c.value;
      const over = today !== null && (c.kind === 'cap' ? today > c.limit : today < c.limit);
      return { ...c, used, status: status(used), today: over, worseThanToday: over && today !== null && (c.kind === 'cap' ? c.value > today + 0.05 : c.value < today - 0.05) };
    };
    const checks: FundingCheck[] = [
      check({ id: 'eve200', label: 'EVE decline at +200 bp', value: -s(200).evPct, limit: s(200).evLimitPct, kind: 'cap' }, -t.eve[200]),
      check({ id: 'eve400', label: 'EVE decline at +400 bp', value: -s(400).evPct, limit: s(400).evLimitPct, kind: 'cap' }, -t.eve[400]),
      check({ id: 'nii200', label: 'NII decline at +200 bp', value: Math.max(0.01, -s(200).niiPct), limit: s(200).niiLimitPct, kind: 'cap' }, -t.nii200),
      check({ id: 'wholesale', label: 'Wholesale funding share', value: wholesalePct, limit: FUNDING_POLICY.wholesaleMaxPct, kind: 'cap' }, t.wholesalePct),
      check({ id: 'brokered', label: 'Brokered deposits to deposits', value: Math.max(0.01, brokeredPct), limit: FUNDING_POLICY.brokeredMaxPct, kind: 'cap' }, (t.brokered / t.deposits) * 100),
      check({ id: 'fhlb_reserve', label: 'FHLB line in use', value: fhlbUsedPct, limit: 100 - FUNDING_POLICY.fhlbReservePct, kind: 'cap' }, (t.fhlbUsed / (t.fhlbLine || 1)) * 100),
      check({ id: 'contingent', label: 'Available funding to deposits', value: availablePct, limit: t.availableMin, kind: 'floor' }, t.availablePct),
    ];
    return {
      levers: l,
      growth: g,
      funded,
      fromCash,
      cost,
      costs,
      allIn,
      cannibalized: migrated,
      cannibalCost,
      fhlbRate,
      depositRate,
      brokeredRate,
      epsImpact,
      nimBp,
      eve200: s(200).evPct,
      eve400: s(400).evPct,
      nii200: s(200).niiPct,
      wholesalePct,
      brokeredPct,
      fhlbUsedPct,
      available,
      availablePct,
      ltdPct,
      checks,
    };
  }

  assumptions(): [string, string][] {
    const r = FUNDING_RATES;
    const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
    return [
      ['Growth', `Loans grow ${this.today.growthPct}% at the capital plan’s pace in every choice; only the funding differs.`],
      ['Deposit pricing', `A money market special at ${pct(r.depositSpecial)}: each new dollar moves ${r.cannibalization * 100} cents of existing money market balances to the special, at the difference over their ${pct(this.today.mmRate)}. Or a certificate special at ${Object.entries(r.cdSpecial).map(([m, v]) => `${pct(v)} for ${Number(m) / 12} years`).join(' or ')}: each new dollar moves ${r.cdCannibalization * 100} cents of maturing certificates to it, at the difference over their ${pct(this.today.cdRate)}.`],
      ['FHLB advances', `Fixed-rate advances at ${Object.entries(r.fhlb).map(([m, v]) => `${pct(v)} for ${Number(m) / 12} year${Number(m) === 12 ? '' : 's'}`).join(', ')}; each draws on the FHLB line, which is contingent liquidity.`],
      ['Brokered deposits', `Brokered CDs at ${Object.entries(r.brokered).map(([m, v]) => `${pct(v)} for ${Number(m) / 12} year${Number(m) === 12 ? '' : 's'}`).join(', ')}, including the placement fee.`],
      ['Funding policy', `Wholesale funding at most ${FUNDING_POLICY.wholesaleMaxPct}% of funding, brokered deposits at most ${FUNDING_POLICY.brokeredMaxPct}% of deposits, and at least ${FUNDING_POLICY.fhlbReservePct}% of the FHLB line kept unused for the contingency funding plan: the demo bank’s policy.`],
      ['Rate risk', 'EVE and NII from DI’s rate-risk model on the balance sheet with the growth and its funding; each change is against that balance sheet’s own unshocked value.'],
    ];
  }
}
