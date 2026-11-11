// Could we afford to acquire a bank of a given size? A pro forma of the combined bank a year after closing,
// for a deal of a given price and mix of cash and stock: regulatory capital after goodwill, tangible book
// value dilution and its earn-back, EPS accretion with cost savings, the combined CRE and office
// concentration, and liquidity after the cash paid. DI holds only its own bank's data, so the target is a
// typical community bank of the size asked about, and every assumption about it is stated.
import type { Pool } from '@dinext/tenant-db';
import { CapitalPlanService } from './capitalPlan.ts';
import { ConcentrationService } from './concentration.ts';
import { LIQUIDITY_POLICY, LiquidityService } from './liquidity.ts';
import { PerShareService } from './perShare.ts';

const TAX = 0.21;
const CASH_YIELD = 0.0425;
/** A typical community bank target, as a share of its total assets. */
export const TARGET_PROFILE = {
  equityPct: 10,
  roaPct: 0.95,
  expensePct: 2.6,
  loansPct: 72,
  securitiesPct: 20,
  liquidPct: 11,
  /** Risk-weighted assets to total assets. */
  rwaPct: 70,
  allowancePct: 1.2,
  /** Fair value marks at closing: the securities' unrealized loss and a credit mark on loans. */
  securitiesMarkPct: 6,
  loanMarkPct: 1.5,
  /** A core deposit intangible, as a share of deposits (85% of assets). */
  cdiPct: 1.5,
};
/** Cost savings as a share of the target's expenses, three quarters of them in the first year. */
export const COST_SAVES = { pct: 25, year1: 0.75 };
/** A buyer's tangible book value dilution is expected to earn back within this many years. */
export const EARNBACK_MAX_YEARS = 3;

export interface DealLevers {
  /** The target's total assets. */
  targetAssets: number;
  /** Price over the target's reported tangible book value. */
  priceToTbv: number;
  /** Share of the price paid in cash; the rest in our stock at today's price. */
  cashPct: number;
}
export type DealCheckId = 'leverage' | 'cet1' | 'liquidity' | 'office' | 'cre' | 'earnback';
export interface DealCheck {
  id: DealCheckId;
  label: string;
  value: number;
  limit: number;
  kind: 'floor' | 'cap';
  used: number;
  status: 'pass' | 'watch' | 'thin' | 'breach';
}
export type DealFigures = ReturnType<AcquisitionModel['evaluate']>;

export class AcquisitionService {
  constructor(private readonly pool: Pool) {}
  async model() {
    const [cap, ps, conc, liq] = await Promise.all([new CapitalPlanService(this.pool).analysis(), new PerShareService(this.pool).figures().catch(() => null), new ConcentrationService(this.pool).analysis().catch(() => null), new LiquidityService(this.pool, 'bank').analysis().catch(() => null)]);
    if (!cap || !ps?.now.shares || !ps.now.price || !conc || !liq) return null;
    return new AcquisitionModel({ cap, ps, conc, liq });
  }
}

export class AcquisitionModel {
  readonly today;
  constructor(x: {
    cap: NonNullable<Awaited<ReturnType<CapitalPlanService['analysis']>>>;
    ps: NonNullable<Awaited<ReturnType<PerShareService['figures']>>>;
    conc: NonNullable<Awaited<ReturnType<ConcentrationService['analysis']>>>;
    liq: Awaited<ReturnType<LiquidityService['analysis']>>;
  }) {
    const office = x.conc.property.find((p) => p.type === 'Office');
    this.today = {
      quarter: x.cap.quarter,
      cap: x.cap,
      totalAssets: x.liq.totalAssets,
      tier1: x.cap.now.tier1,
      cet1: x.cap.now.cet1,
      rwa: x.cap.now.rwa,
      leverageAssets: x.cap.now.leverageAssets,
      levPct: x.cap.now.levPct,
      cet1Pct: x.cap.now.cet1Pct,
      levFloor: x.cap.floors.leverage,
      cet1Floor: x.cap.floors.cet1,
      niYear: x.cap.year.ni,
      shares: x.ps.now.shares!,
      weighted: x.ps.now.weighted ?? x.ps.now.shares!,
      price: x.ps.now.price!,
      tce: x.ps.now.tce,
      tbvps: x.ps.now.tbvps!,
      eps: x.cap.year.ni / (x.ps.now.weighted ?? x.ps.now.shares!),
      liquid: x.liq.liquid,
      liquidMin: LIQUIDITY_POLICY.liquidToAssetsMinPct,
      concCapital: x.conc.regulatory.capital,
      office: office?.balance ?? 0,
      officePct: office?.pctOfCapital ?? 0,
      nonOwnerCre: x.conc.regulatory.nonOwnerCre,
      crePct: x.conc.regulatory.crePct,
      loans: x.conc.totalLoans,
    };
  }

  levers(over: Partial<DealLevers> = {}): DealLevers {
    return { targetAssets: over.targetAssets ?? 500e6, priceToTbv: over.priceToTbv ?? 1.3, cashPct: Math.min(100, Math.max(0, over.cashPct ?? 50)) };
  }

  /** The combined bank a year after closing. */
  evaluate(l: DealLevers) {
    const t = this.today;
    const P = TARGET_PROFILE;
    const A = l.targetAssets;
    const equity = A * (P.equityPct / 100);
    const loans = A * (P.loansPct / 100);
    // Marks at closing, after tax: they lower what is acquired and so raise goodwill.
    const marks = (A * (P.securitiesPct / 100) * (P.securitiesMarkPct / 100) + loans * (P.loanMarkPct / 100)) * (1 - TAX);
    const cdi = A * 0.85 * (P.cdiPct / 100);
    const fairEquity = equity - marks;
    const price = equity * l.priceToTbv;
    const cash = price * (l.cashPct / 100);
    const stock = price - cash;
    const newShares = stock / t.price;
    // Goodwill and the core deposit intangible: what is paid above the fair value of what is bought.
    const intangibles = Math.max(0, price - fairEquity + cdi);

    // A year on: both banks' earnings, cost savings, less what the cash would have earned and the intangible's amortization.
    const niTarget = A * (P.roaPct / 100);
    const saves = A * (P.expensePct / 100) * (COST_SAVES.pct / 100);
    const cdiAmort = cdi / 7;
    const ni = t.niYear + niTarget + (saves * COST_SAVES.year1 - cash * CASH_YIELD - cdiAmort) * (1 - TAX);
    const niRun = t.niYear + niTarget + (saves - cash * CASH_YIELD - cdiAmort) * (1 - TAX);
    const shares = t.shares + newShares;
    const weighted = t.weighted + newShares;
    const eps = ni / weighted;
    const epsRun = niRun / weighted;

    // Capital: our stock issued adds to tier 1, goodwill and the intangible come off it; cash paid leaves assets.
    const tier1AtClose = t.tier1 + stock - intangibles;
    const leverageAssets = t.leverageAssets + A - marks / (1 - TAX) - cash;
    const rwa = t.rwa + A * (P.rwaPct / 100) - cash * 0.2;
    const levPct = (tier1AtClose / leverageAssets) * 100;
    const cet1Pct = ((t.cet1 + stock - intangibles) / rwa) * 100;

    // Tangible book value a share at closing, and how long the EPS accretion takes to earn back the dilution.
    const tbvps = (t.tce + stock - intangibles) / shares;
    const dilution = t.tbvps - tbvps;
    const accretion = epsRun - t.eps;
    const earnbackYears = dilution <= 0 ? 0 : accretion > 0 ? dilution / accretion : null;

    // Concentration: the target's CRE in the same mix as ours, against combined tier 1 plus allowances.
    const scale = loans / t.loans;
    const allowance = t.concCapital - t.tier1 + loans * (P.allowancePct / 100);
    const concCapital = tier1AtClose + allowance;
    const officePct = ((t.office * (1 + scale)) / concCapital) * 100;
    const crePct = ((t.nonOwnerCre * (1 + scale)) / concCapital) * 100;

    // Liquidity: the cash paid comes out of liquid assets.
    const liquid = t.liquid + A * (P.liquidPct / 100) - cash;
    const totalAssets = t.totalAssets + A - marks / (1 - TAX) - cash + intangibles;
    const liquidPct = (liquid / totalAssets) * 100;

    const status = (used: number, thin: number): DealCheck['status'] => (used > 1 + 1e-9 ? 'breach' : used >= thin ? 'thin' : used >= 0.85 ? 'watch' : 'pass');
    const check = (c: Omit<DealCheck, 'used' | 'status'>, thin = 0.95): DealCheck => {
      const used = c.kind === 'cap' ? c.value / c.limit : c.limit / c.value;
      return { ...c, used, status: status(used, thin) };
    };
    const checks: DealCheck[] = [
      check({ id: 'leverage', label: 'Leverage ratio at closing, against its floor', value: levPct, limit: t.levFloor, kind: 'floor' }, 0.98),
      check({ id: 'cet1', label: 'CET1 at closing, against its floor', value: cet1Pct, limit: t.cet1Floor, kind: 'floor' }, 0.98),
      check({ id: 'liquidity', label: 'Liquid assets to total assets', value: liquidPct, limit: t.liquidMin, kind: 'floor' }),
      check({ id: 'office', label: 'Office CRE to capital', value: officePct, limit: 50, kind: 'cap' }),
      check({ id: 'cre', label: 'Non-owner-occupied CRE to capital', value: crePct, limit: 300, kind: 'cap' }),
      { id: 'earnback', label: 'Tangible book value earn-back', value: earnbackYears ?? 99, limit: EARNBACK_MAX_YEARS, kind: 'cap', used: (earnbackYears ?? 99) / EARNBACK_MAX_YEARS, // A market expectation, not a limit: past it the deal is thin, never in breach.
        status: earnbackYears === null || earnbackYears > EARNBACK_MAX_YEARS ? 'thin' : 'pass' },
    ];
    return {
      levers: l,
      price,
      cash,
      stock,
      newShares,
      ownershipPct: (newShares / shares) * 100,
      equity,
      marks,
      intangibles,
      cdi,
      niTarget,
      saves,
      ni,
      niRun,
      eps,
      epsRun,
      epsChangePct: ((epsRun - t.eps) / t.eps) * 100,
      tbvps,
      dilutionPct: (dilution / t.tbvps) * 100,
      earnbackYears,
      levPct,
      cet1Pct,
      liquidPct,
      officePct,
      crePct,
      checks,
      breaches: checks.filter((c) => c.status === 'breach'),
      thin: checks.filter((c) => c.status === 'thin'),
    };
  }

  assumptions(): [string, string][] {
    const P = TARGET_PROFILE;
    return [
      ['The target', `DI holds only this bank’s data, so the target is a typical community bank of the size asked about: equity ${P.equityPct}% of assets, earnings ${P.roaPct}% of assets, expenses ${P.expensePct}%, loans ${P.loansPct}% with this bank’s CRE mix, securities ${P.securitiesPct}%, liquid assets ${P.liquidPct}%, risk-weighted assets ${P.rwaPct}%.`],
      ['Purchase accounting', `At closing the target’s securities are marked down ${P.securitiesMarkPct}% and its loans ${P.loanMarkPct}%, after tax; a core deposit intangible of ${P.cdiPct}% of deposits is amortized over seven years. Goodwill and the intangible come off tier 1 capital and tangible book value.`],
      ['Price and payment', 'The price is a multiple of the target’s reported tangible book value; the stock part is issued at today’s share price, and the cash part comes out of liquid assets and stops earning 4.25%.'],
      ['Earnings', `Both banks’ earnings at their current pace, with cost savings of ${COST_SAVES.pct}% of the target’s expenses, ${COST_SAVES.year1 * 100}% of them in the first year. Earn-back is the tangible book value dilution over the yearly EPS accretion; buyers aim for ${EARNBACK_MAX_YEARS} years.`],
      ['Capital', 'Ratios at closing, against the capital plan’s floors; the stress buffer is this bank’s, not a combined stress test.'],
    ];
  }
}
