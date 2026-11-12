// A credit union's funding model, for the funding optimizer: what next year's loan growth costs and does
// to rate risk, liquidity and wholesale reliance, funded by a share special (money market or a share
// certificate), FHLB advances, nonmember certificates (brokered or listing-service shares) or cash on
// hand. It mirrors the bank's funding model with a credit union's measures and limits:
// - NEV and NII at +300 bp from DI's rate-risk model, against the board's IRR limits;
// - nonmember deposits at most 20% of shares (NCUA §701.32 for a federal credit union);
// - wholesale funding (borrowings and nonmember shares) against the funding policy, the FHLB line's
//   reserve for the contingency funding plan, and available funding against shares.
// The rates on new money are the bank model's stated ones; a share certificate special is priced as a
// certificate special. Every figure is DI's estimate, shown with its assumptions.
import type { Pool } from '@dinext/tenant-db';
import { FUNDING_POLICY, FUNDING_RATES, type FundingLevers } from './fundingChoice.ts';
import { IRR_LIMITS, IrrService, scalePosition, type Position } from './irr.ts';
import { LIQUIDITY_POLICY, LiquidityService } from './liquidity.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const THIN = 0.95;
/** Nonmember shares at most this share of total shares (NCUA §701.32, federal credit unions). */
export const NONMEMBER_MAX_PCT = 20;
/** The shock a credit union's NEV and NII limits are read at. */
const SHOCK = 300;
/** Loan growth when no budget sets one. */
const DEFAULT_GROWTH_PCT = 5;

export interface CuFundingCheck {
  id: 'nev300' | 'nii300' | 'nonmember' | 'wholesale' | 'fhlb_reserve' | 'contingent' | 'liquid';
  label: string;
  value: number;
  limit: number;
  kind: 'floor' | 'cap';
  used: number;
  status: 'pass' | 'watch' | 'thin' | 'breach';
  today: boolean;
  worseThanToday: boolean;
}

function bullet(name: string, balance: number, rate: number, months: number): Position {
  const flows = new Array<number>(360).fill(0);
  flows[Math.min(360, months) - 1] = balance;
  return { name, side: 'liability', balance, rate, flows: () => flows, repriced: (m) => (m >= months ? 1 : 0), beta: 1, discount: rate, floating: false };
}

type Inputs = {
  loaded: Awaited<ReturnType<IrrService['positions']>>;
  irr: IrrService;
  liq: NonNullable<Awaited<ReturnType<LiquidityService['analysis']>>>;
  growthPct: number;
  growthFrom: string;
};

export class CuFundingService {
  constructor(private readonly pool: Pool) {}

  async model() {
    const irr = new IrrService(this.pool);
    const [loaded, liq, budget] = await Promise.all([
      irr.positions(),
      new LiquidityService(this.pool, 'credit_union').analysis().catch(() => null),
      rows<{ year: number; value: number }>(this.pool, "SELECT year, value FROM fin_budget WHERE metric = 'loan_growth' ORDER BY year DESC LIMIT 1").catch(() => []),
    ]);
    if (!liq) return null;
    const b = budget[0];
    return new CuFundingModel({ loaded, irr, liq, growthPct: b ? Number(b.value) : DEFAULT_GROWTH_PCT, growthFrom: b ? `the ${b.year} budget’s loan growth` : 'DI’s default loan growth' });
  }
}

export class CuFundingModel {
  readonly holdsExtra = true;
  readonly today;
  constructor(private readonly x: Inputs) {
    const { loaded, liq } = x;
    const loans = loaded.positions.filter((p) => p.side === 'asset' && !['Cash and overnight funds', 'Investments'].includes(p.name));
    const loanTotal = loans.reduce((s, p) => s + p.balance, 0);
    const shares = loaded.positions.filter((p) => p.side === 'liability' && p.name !== 'Borrowings').reduce((s, p) => s + p.balance, 0);
    const borrowings = loaded.positions.filter((p) => p.name === 'Borrowings').reduce((s, p) => s + p.balance, 0);
    const mm = loaded.positions.find((p) => p.name === 'Money market');
    const certs = loaded.positions.find((p) => p.name === 'Certificates');
    const fhlbRow = liq.capacity.find((c) => /FHLB/.test(c.source))!;
    const base = x.irr.whatIf(loaded, (ps) => ps, [SHOCK]);
    this.today = {
      quarter: loaded.asOf,
      growth: Math.floor((loanTotal * (x.growthPct / 100)) / 1e6) * 1e6,
      growthPct: x.growthPct,
      growthFrom: x.growthFrom,
      loanTotal,
      loans,
      shares,
      borrowings,
      mmBalance: mm?.balance ?? 0,
      mmRate: mm?.rate ?? 0,
      cdBalance: certs?.balance ?? 0,
      cdRate: certs?.rate ?? 0,
      fhlbLine: fhlbRow.lendable,
      fhlbUsed: fhlbRow.used,
      available: liq.available,
      liquid: liq.liquid,
      totalAssets: liq.totalAssets,
      availablePct: liq.availableToShares,
      nev: base.shocks[0]!.evPct,
      nii: base.shocks[0]!.niiPct,
      earningAssets: loaded.positions.filter((p) => p.side === 'asset').reduce((s, p) => s + p.balance, 0),
    };
  }

  levers(over: Partial<FundingLevers> = {}): FundingLevers {
    return { deposits: Math.max(0, over.deposits ?? 0), depositTermMonths: over.depositTermMonths ?? 0, fhlb: Math.max(0, over.fhlb ?? 0), fhlbTermMonths: over.fhlbTermMonths ?? 24, brokered: Math.max(0, over.brokered ?? 0), brokeredTermMonths: over.brokeredTermMonths ?? 12 };
  }

  evaluate(l: FundingLevers) {
    const t = this.today;
    const g = t.growth;
    const funded = l.deposits + l.fhlb + l.brokered;
    const fromCash = Math.max(0, g - funded);
    // Money raised beyond the growth is held as liquid assets and earns the market rate.
    const held = Math.max(0, funded - g);
    const fhlbRate = FUNDING_RATES.fhlb[l.fhlbTermMonths] ?? FUNDING_RATES.fhlb[24]!;
    const cd = l.depositTermMonths > 0;
    const depositRate = cd ? (FUNDING_RATES.cdSpecial[l.depositTermMonths] ?? FUNDING_RATES.cdSpecial[24]!) : FUNDING_RATES.depositSpecial;
    const brokeredRate = FUNDING_RATES.brokered[l.brokeredTermMonths] ?? FUNDING_RATES.brokered[12]!;
    // A special also reprices some of the members' own shares: money market for a money market special, maturing certificates for a certificate one.
    const migrated = cd ? Math.min(t.cdBalance, l.deposits * FUNDING_RATES.cdCannibalization) : Math.min(t.mmBalance, l.deposits * FUNDING_RATES.cannibalization);
    const cannibalCost = migrated * Math.max(0, depositRate - (cd ? t.cdRate : t.mmRate));
    const costs = { deposits: l.deposits * depositRate + cannibalCost, fhlb: l.fhlb * fhlbRate, brokered: l.brokered * brokeredRate, cash: (fromCash - held) * FUNDING_RATES.market };
    const cost = costs.deposits + costs.fhlb + costs.brokered + costs.cash;
    const k = 1 + g / t.loanTotal;
    const loanNames = new Set(t.loans.map((p) => p.name));
    const ev = this.x.irr.whatIf(this.x.loaded, (ps) => {
      const out = ps.map((p) => {
        if (loanNames.has(p.name)) return scalePosition(p, k);
        if (p.name === 'Money market' && l.deposits > 0 && !cd) {
          const grown = scalePosition(p, 1 + l.deposits / p.balance);
          return { ...grown, rate: (p.balance * p.rate + l.deposits * FUNDING_RATES.depositSpecial + cannibalCost) / grown.balance };
        }
        if (p.name === 'Cash and overnight funds' && fromCash > 0) return scalePosition(p, Math.max(0, 1 - fromCash / p.balance));
        if (p.name === 'Cash and overnight funds' && held > 0) return scalePosition(p, 1 + held / p.balance);
        return p;
      });
      if (l.fhlb > 0) out.push(bullet('New FHLB advances', l.fhlb, fhlbRate, l.fhlbTermMonths));
      if (l.brokered > 0) out.push(bullet('Nonmember certificates', l.brokered, brokeredRate, l.brokeredTermMonths));
      if (l.deposits > 0 && cd) out.push(bullet('Share certificate special', l.deposits, depositRate + cannibalCost / l.deposits, l.depositTermMonths));
      return out;
    }, [SHOCK]);
    const s = ev.shocks[0]!;
    const shares = t.shares + l.deposits + l.brokered;
    const borrowings = t.borrowings + l.fhlb;
    const nonmemberPct = (l.brokered / shares) * 100;
    const wholesalePct = ((borrowings + l.brokered) / (shares + borrowings)) * 100;
    const fhlbUsedPct = t.fhlbLine ? ((t.fhlbUsed + l.fhlb) / t.fhlbLine) * 100 : 100;
    const available = t.available - l.fhlb - fromCash + held;
    const availablePct = (available / shares) * 100;
    // Cash spent on loans leaves liquid assets; the balance sheet grows by what new funding brings in.
    const liquidPct = ((t.liquid - fromCash + held) / (t.totalAssets + funded)) * 100;
    const status = (used: number): CuFundingCheck['status'] => (used > 1 + 1e-9 ? 'breach' : used >= THIN ? 'thin' : used >= 0.85 ? 'watch' : 'pass');
    const check = (c: Omit<CuFundingCheck, 'used' | 'status' | 'today' | 'worseThanToday'>, today: number | null): CuFundingCheck => {
      const used = c.kind === 'cap' ? c.value / c.limit : c.limit / c.value;
      const over = today !== null && (c.kind === 'cap' ? today > c.limit : today < c.limit);
      return { ...c, used, status: status(used), today: over, worseThanToday: over && today !== null && (c.kind === 'cap' ? c.value > today + 0.05 : c.value < today - 0.05) };
    };
    const checks: CuFundingCheck[] = [
      check({ id: 'nev300', label: `NEV decline at +${SHOCK} bp`, value: Math.max(0.01, -s.evPct), limit: IRR_LIMITS.nevDeclinePct, kind: 'cap' }, -t.nev),
      check({ id: 'nii300', label: `NII decline at +${SHOCK} bp`, value: Math.max(0.01, -s.niiPct), limit: IRR_LIMITS.niiDeclinePct, kind: 'cap' }, -t.nii),
      check({ id: 'nonmember', label: 'Nonmember shares to shares', value: Math.max(0.01, nonmemberPct), limit: NONMEMBER_MAX_PCT, kind: 'cap' }, 0.01),
      check({ id: 'wholesale', label: 'Wholesale funding share', value: Math.max(0.01, wholesalePct), limit: FUNDING_POLICY.wholesaleMaxPct, kind: 'cap' }, (t.borrowings / (t.shares + t.borrowings)) * 100),
      check({ id: 'fhlb_reserve', label: 'FHLB line in use', value: Math.max(0.01, fhlbUsedPct), limit: 100 - FUNDING_POLICY.fhlbReservePct, kind: 'cap' }, (t.fhlbUsed / (t.fhlbLine || 1)) * 100),
      check({ id: 'contingent', label: 'Available funding to shares', value: availablePct, limit: LIQUIDITY_POLICY.availableToSharesMinPct, kind: 'floor' }, t.availablePct),
      check({ id: 'liquid', label: 'Liquid assets to total assets', value: Math.max(0.01, liquidPct), limit: LIQUIDITY_POLICY.liquidToAssetsMinPct, kind: 'floor' }, (t.liquid / t.totalAssets) * 100),
    ];
    return { levers: l, growth: g, funded, fromCash, held, cost, costs, allIn: g ? cost / g : 0, cannibalized: migrated, cannibalCost, fhlbRate, depositRate, brokeredRate, checks };
  }

  assumptions(): [string, string][] {
    const r = FUNDING_RATES;
    const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
    return [
      ['Growth', `Loans grow ${this.today.growthPct}%, from ${this.today.growthFrom}; only the funding differs.`],
      ['Share specials', `A money market special at ${pct(r.depositSpecial)}: each new dollar moves ${r.cannibalization * 100} cents of members’ money market shares to the special. Or a share certificate special at ${Object.entries(r.cdSpecial).map(([m, v]) => `${pct(v)} for ${Number(m) / 12} years`).join(' or ')}: each new dollar moves ${r.cdCannibalization * 100} cents of maturing certificates to it.`],
      ['FHLB advances', `Fixed-rate advances at ${Object.entries(r.fhlb).map(([m, v]) => `${pct(v)} for ${Number(m) / 12} year${Number(m) === 12 ? '' : 's'}`).join(', ')}; each draws on the FHLB line, which is contingent liquidity.`],
      ['Nonmember certificates', `Brokered or listing-service certificates at ${Object.entries(r.brokered).map(([m, v]) => `${pct(v)} for ${Number(m) / 12} year${Number(m) === 12 ? '' : 's'}`).join(', ')}, including fees; at most ${NONMEMBER_MAX_PCT}% of shares (NCUA §701.32 for a federal credit union).`],
      ['Funding policy', `Wholesale funding (borrowings and nonmember shares) at most ${FUNDING_POLICY.wholesaleMaxPct}% of funding, at least ${FUNDING_POLICY.fhlbReservePct}% of the FHLB line kept unused, and available funding at least ${LIQUIDITY_POLICY.availableToSharesMinPct}% of shares. Cash on hand spent on loans comes out of liquid assets, which stay at least ${LIQUIDITY_POLICY.liquidToAssetsMinPct}% of total assets.`],
      ['Rate risk', `NEV and NII at +${SHOCK} bp from DI’s rate-risk model with the growth and its funding, against the board’s limits: NEV no worse than −${IRR_LIMITS.nevDeclinePct}%, NII no worse than −${IRR_LIMITS.niiDeclinePct}%.`],
    ];
  }
}
