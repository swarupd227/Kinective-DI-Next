// Next year's budget, tested against stress. A budget is this year's run rate (net interest income, fee
// income, expenses and the provision, annualized from the latest Call Report as the stress test starts from)
// moved by the plan's choices: loan growth, what deposits will cost, expense and fee growth, and the
// dividend. Each budget then takes the severely adverse scenario's own hit, from DI's stress test: its
// first-year earnings and its lowest leverage ratio, scaled for the budget's loan growth. Nothing is the
// model's; the levers are chosen and code works out what they do.
import type { Pool } from '@dinext/tenant-db';
import { CapitalPlanService } from './capitalPlan.ts';
import { CeclService } from './cecl.ts';
import { IrrService } from './irr.ts';
import { PerShareService } from './perShare.ts';
import { StressService } from './stress.ts';

const TAX = 0.21;
/** The severe stress trough is thin within this much of the CBLR's 8%. */
const TROUGH_THIN_POINTS = 0.25;

export interface BudgetLevers {
  loanGrowthPct: number;
  /** How much more deposits cost on average next year, basis points. */
  depositCostBp: number;
  expenseGrowthPct: number;
  feeGrowthPct: number;
  dividendPerShareQ: number;
}
export type BudgetCheckId = 'stress_trough' | 'leverage' | 'dividend_stress';
export interface BudgetCheck {
  id: BudgetCheckId;
  label: string;
  value: number;
  limit: number;
  status: 'pass' | 'watch' | 'thin' | 'breach';
}
export type BudgetFigures = ReturnType<BudgetStressModel['evaluate']>;

export class BudgetStressService {
  constructor(private readonly pool: Pool) {}
  async model() {
    const [stress, cap, ps, cecl, irr] = await Promise.all([new StressService(this.pool, 'bank').analysis(), new CapitalPlanService(this.pool).analysis(), new PerShareService(this.pool).figures().catch(() => null), new CeclService(this.pool).analysis().catch(() => null), new IrrService(this.pool).positions()]);
    if (!stress || !cap || !ps?.now.shares) return null;
    return new BudgetStressModel({ stress, cap, ps, coverage: cecl ? cecl.estimate.coveragePct / 100 : 0.012, irr });
  }
}

export class BudgetStressModel {
  readonly today;
  constructor(x: {
    stress: NonNullable<Awaited<ReturnType<StressService['analysis']>>>;
    cap: NonNullable<Awaited<ReturnType<CapitalPlanService['analysis']>>>;
    ps: NonNullable<Awaited<ReturnType<PerShareService['figures']>>>;
    coverage: number;
    irr: Awaited<ReturnType<IrrService['positions']>>;
  }) {
    const s = x.stress.start;
    const run = (key: string) => x.stress.runs.find((r) => r.scenario.key === key)!;
    const year1 = (key: string) => run(key).quarters.slice(0, 4).reduce((t, q) => t + q.netIncome, 0);
    const severe = run('severe');
    const loanPositions = x.irr.positions.filter((p) => p.side === 'asset' && !['Cash and overnight funds', 'Investments'].includes(p.name));
    const loanBook = loanPositions.reduce((t, p) => t + p.balance, 0);
    const deposits = x.irr.positions.filter((p) => p.side === 'liability' && p.name !== 'Borrowings').reduce((t, p) => t + p.balance, 0);
    const runRate = (s.nii + s.feeIncome - s.expense - s.provision) * (1 - TAX);
    this.today = {
      quarter: x.cap.quarter,
      year: Number(x.stress.start.end.slice(0, 4)) + 1,
      nii: s.nii,
      fee: s.feeIncome,
      expense: s.expense,
      provision: s.provision,
      ni: runRate,
      assets: s.assets,
      loans: s.loans.reduce((t, l) => t + l.balance, 0),
      loanYield: loanBook ? loanPositions.reduce((t, p) => t + p.balance * p.rate, 0) / loanBook : 0,
      fundingRate: x.irr.positions.find((p) => p.name === 'Certificates')?.rate ?? 0.0425,
      deposits,
      coverage: x.coverage,
      tier1: x.cap.now.tier1,
      leverageAssets: x.cap.now.leverageAssets,
      levPct: x.cap.now.levPct,
      levFloor: x.cap.floors.leverage,
      shares: x.ps.now.shares!,
      weighted: x.ps.now.weighted ?? x.ps.now.shares!,
      dividendPerShareQ: x.cap.settings.dividendPerShareQ,
      growthPlanPct: x.cap.settings.rwaGrowth,
      /** What the severely adverse scenario takes from the first year's earnings, against the baseline scenario. */
      severeHit: year1('baseline') - year1('severe'),
      severeYear1: year1('severe'),
      trough: { pct: severe.trough.ratioPct, quarter: severe.trough.quarter, capital: severe.trough.capital, assets: severe.trough.assets },
      minimumPct: x.stress.start.minimumPct,
    };
  }

  levers(over: Partial<BudgetLevers> = {}): BudgetLevers {
    return { loanGrowthPct: over.loanGrowthPct ?? this.today.growthPlanPct, depositCostBp: over.depositCostBp ?? 5, expenseGrowthPct: over.expenseGrowthPct ?? 3.5, feeGrowthPct: over.feeGrowthPct ?? 3, dividendPerShareQ: over.dividendPerShareQ ?? this.today.dividendPerShareQ };
  }

  evaluate(l: BudgetLevers) {
    const t = this.today;
    const g = l.loanGrowthPct / 100;
    const newLoans = t.loans * g;
    // New loans earn the book's yield over certificate funding for half the year; all deposits cost the change more.
    const nii = t.nii + newLoans * (t.loanYield - t.fundingRate) * 0.5 - t.deposits * (l.depositCostBp / 10_000);
    const fee = t.fee * (1 + l.feeGrowthPct / 100);
    const expense = t.expense * (1 + l.expenseGrowthPct / 100);
    const provision = t.provision + newLoans * t.coverage;
    const pretax = nii + fee - expense - provision;
    const ni = pretax * (1 - TAX);
    const dividends = l.dividendPerShareQ * 4 * t.shares;
    const avgAssets = t.assets + newLoans / 2;
    const roaPct = (ni / avgAssets) * 100;
    const efficiencyPct = (expense / (nii + fee)) * 100;
    const eps = ni / t.weighted;
    const levPct = ((t.tier1 + ni - dividends) / (t.leverageAssets + newLoans + ni - dividends)) * 100;

    // Stress: the severe scenario's first-year hit, larger with a larger loan book, and its trough with this budget's capital and loans.
    const hit = t.severeHit * (1 + g);
    const niStress = ni - hit;
    const troughCapital = t.trough.capital + (ni - t.ni) - (dividends - t.dividendPerShareQ * 4 * t.shares) - t.severeHit * g;
    const troughPct = (troughCapital / (t.trough.assets + newLoans)) * 100;

    const checks: BudgetCheck[] = [
      { id: 'stress_trough', label: 'Leverage at the severe stress trough', value: troughPct, limit: t.minimumPct, status: troughPct < t.minimumPct ? 'breach' : troughPct < t.minimumPct + TROUGH_THIN_POINTS ? 'thin' : troughPct < t.minimumPct + 0.75 ? 'watch' : 'pass' },
      { id: 'leverage', label: 'Leverage at year end, against its floor', value: levPct, limit: t.levFloor, status: levPct < t.levFloor ? 'breach' : levPct < t.levFloor + 0.2 ? 'thin' : 'pass' },
      // Not a limit: a dividend earnings don't cover in a severe year is the board's call, so it can only be thin.
      { id: 'dividend_stress', label: 'Dividend covered by earnings in a severe year', value: niStress, limit: dividends, status: niStress < dividends ? 'thin' : niStress < dividends * 1.25 ? 'watch' : 'pass' },
    ];
    return { levers: l, newLoans, nii, fee, expense, provision, pretax, ni, niChangePct: ((ni - t.ni) / t.ni) * 100, dividends, payoutPct: ni ? (dividends / ni) * 100 : 0, roaPct, efficiencyPct, eps, levPct, hit, niStress, troughPct, checks };
  }

  assumptions(): [string, string][] {
    const t = this.today;
    return [
      ['This year', `The run rate: net interest income, fee income, expenses and the provision from the ${t.quarter} Call Report, annualized, as DI’s stress test starts from.`],
      ['Loan growth', `New loans earn the book’s ${(t.loanYield * 100).toFixed(2)}% over ${(t.fundingRate * 100).toFixed(2)}% certificate funding for half the year, and are reserved at the allowance’s ${(t.coverage * 100).toFixed(2)}% coverage.`],
      ['Deposit cost', 'A change in what deposits cost applies to every deposit dollar for the year.'],
      ['Stress', `The severely adverse scenario takes the difference between its first-year earnings and the baseline’s, more with a larger loan book; its lowest leverage ratio (${t.trough.quarter}) moves with the budget’s earnings, dividends and loans.`],
    ];
  }
}
