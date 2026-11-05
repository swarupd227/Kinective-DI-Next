// The ALCO package: what an asset-liability committee reviews each month, built on the same IRR and
// liquidity engines as their pages. Policy compliance first (every board limit with the actual figure
// and whether it is met), then earnings (yields, cost of funds, spread, NIM), capital, funding (the
// deposit mix, rates paid and the certificate maturity ladder) and the loan book (mix, yields, growth
// and concentration). Figures the core data can't give exactly (a bank's regulatory capital, risk
// weights) are DI's estimates and say so.
import type { Pool } from '@dinext/tenant-db';
import { IRR_LIMITS, IrrService } from './irr.ts';
import { LIQUIDITY_POLICY, LiquidityService } from './liquidity.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);

/** Board policy beyond rate risk and liquidity, for the demo institutions; an ALCO sets its own. */
export const ALCO_POLICY = {
  loanToShareMaxPct: 90,
  borrowingsMaxPct: 15,
  /** Credit union: well capitalized at 7% net worth; the board's floor is higher. */
  netWorthMinPct: 7,
  /** Bank: well capitalized at 5% leverage and 10% total risk-based capital. */
  leverageMinPct: 5,
  totalCapitalMinPct: 10,
  /** Bank: commercial real estate over 300% of capital draws supervisory attention. Credit union: business loans over 1.75 times net worth. */
  creToCapitalMaxPct: 300,
  businessLoansToNetWorthMax: 1.75,
};
/** Standard risk weights by position, for an estimate of risk-based capital. */
const RISK_WEIGHT: [RegExp, number][] = [
  [/cash/i, 0],
  [/investment/i, 0.2],
  [/first mortgage/i, 0.5],
  [/./, 1],
];

export type PolicyStatus = 'Within' | 'Watch' | 'Breach';
export interface PolicyLine {
  area: string;
  measure: string;
  policy: string;
  actual: string;
  status: PolicyStatus;
  /** The limit in a phrase, for the pack's summary: "NEV at +400 bp is −38.2% (limit −30%)". */
  brief: string;
  /** How close to the limit, 0 (far) to 1 (at it), for ordering the closest first. */
  closeness: number;
}

/** At or past the limit is a breach; within a tenth of it (relative) is worth watching. */
const judge = (actual: number, limit: number, kind: 'min' | 'max'): { status: PolicyStatus; closeness: number } => {
  const ok = kind === 'min' ? actual >= limit : actual <= limit;
  const closeness = kind === 'min' ? (limit > 0 ? limit / Math.max(actual, 1e-9) : 0) : actual / limit;
  return { status: !ok ? 'Breach' : closeness >= 0.9 ? 'Watch' : 'Within', closeness: Math.min(closeness, 2) };
};
const p1 = (n: number) => `${n.toFixed(1)}%`;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;

export class AlcoService {
  constructor(
    private readonly pool: Pool,
    private readonly institutionType: 'credit_union' | 'bank' = 'credit_union',
  ) {}

  async analysis() {
    const bank = this.institutionType === 'bank';
    const irrSvc = new IrrService(this.pool);
    const [irr, liq, pos] = await Promise.all([irrSvc.analysis(), new LiquidityService(this.pool, this.institutionType).analysis(), irrSvc.positions()]);
    const assets = pos.positions.filter((p) => p.side === 'asset');
    const liabilities = pos.positions.filter((p) => p.side === 'liability');
    const sum = (ps: typeof assets) => ps.reduce((s, p) => s + p.balance, 0);
    const income = (ps: typeof assets) => ps.reduce((s, p) => s + p.balance * p.rate, 0);
    const earning = sum(assets);
    const funding = sum(liabilities);
    const totalAssets = irr.totalAssets;

    // ---- earnings, annualized on today's balances and rates ----
    const yieldPct = (income(assets) / earning) * 100;
    const costPct = (income(liabilities) / funding) * 100;
    const nimPct = ((income(assets) - income(liabilities)) / earning) * 100;
    const earnings = {
      yieldPct,
      costPct,
      spreadPct: yieldPct - costPct,
      nimPct,
      nii: irr.base.nii,
      lines: [...assets, ...liabilities].map((p) => ({ name: p.name, side: p.side, balance: p.balance, ratePct: p.rate * 100, annual: p.balance * p.rate })),
    };

    // ---- capital ----
    const equity = pos.netWorth ?? totalAssets - funding;
    const rwa = assets.reduce((s, p) => s + p.balance * (RISK_WEIGHT.find(([re]) => re.test(p.name))![1]), 0) + Math.max(0, totalAssets - earning);
    const capital = bank
      ? {
          basis: 'Estimated from the balance sheet DI holds: equity is assets less deposits and borrowings, with standard risk weights. The FFIEC Call Report (RC-R) gives the reported ratios.',
          equity,
          lines: [
            { name: 'Tier 1 leverage ratio (estimate)', value: (equity / totalAssets) * 100, limit: ALCO_POLICY.leverageMinPct },
            { name: 'Total risk-based capital ratio (estimate)', value: ((equity * 1.08) / rwa) * 100, limit: ALCO_POLICY.totalCapitalMinPct },
          ],
        }
      : {
          basis: 'Net worth from the 5300 (account 997) over total assets (010); the risk-based ratio is DI’s estimate at standard risk weights.',
          equity,
          lines: [
            { name: 'Net worth ratio', value: (equity / totalAssets) * 100, limit: ALCO_POLICY.netWorthMinPct },
            { name: 'Risk-based net worth (estimate)', value: (equity / rwa) * 100, limit: 10 },
          ],
        };

    // ---- funding: the deposit mix, rates paid, and certificates by when they mature ----
    const [build] = await rows<{ d: unknown }>(this.pool, 'SELECT MAX(as_of_date) AS d FROM meta_build');
    const asOf = day(build?.d ?? pos.asOf);
    const mix = await rows<{ c: string; b: number; r: number; n: number }>(this.pool, 'SELECT deposit_category AS c, SUM(balance) AS b, SUM(balance * rate) / NULLIF(SUM(balance), 0) AS r, COUNT(*) AS n FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY deposit_category ORDER BY b DESC');
    const deposits = mix.reduce((s, m) => s + Number(m.b), 0);
    const ladder = await rows<{ band: string; b: number; r: number; n: number }>(
      this.pool,
      `SELECT CASE WHEN maturity_date < DATE_ADD(?, INTERVAL 90 DAY) THEN '0–89 days' WHEN maturity_date < DATE_ADD(?, INTERVAL 180 DAY) THEN '90–179 days' WHEN maturity_date < DATE_ADD(?, INTERVAL 365 DAY) THEN '180–364 days' ELSE 'Over a year' END AS band,
         SUM(balance) AS b, SUM(balance * rate) / NULLIF(SUM(balance), 0) AS r, COUNT(*) AS n
       FROM cdm_deposit_account WHERE close_date IS NULL AND deposit_category LIKE 'Certificate%' AND maturity_date >= ? GROUP BY band`,
      [asOf, asOf, asOf, asOf],
    );
    const BANDS = ['0–89 days', '90–179 days', '180–364 days', 'Over a year'];
    const certs = ladder.reduce((s, l) => s + Number(l.b), 0);
    const fundingView = {
      deposits,
      costOfDepositsPct: mix.reduce((s, m) => s + Number(m.b) * Number(m.r), 0) / deposits,
      mix: mix.map((m) => ({ category: m.c, balance: Number(m.b), sharePct: (Number(m.b) / deposits) * 100, ratePct: Number(m.r), accounts: Number(m.n) })),
      ladder: BANDS.map((band) => ladder.find((l) => l.band === band)).filter((l): l is NonNullable<typeof l> => !!l).map((l) => ({ band: l.band, balance: Number(l.b), sharePct: certs ? (Number(l.b) / certs) * 100 : 0, ratePct: Number(l.r), count: Number(l.n) })),
      rateSensitivePct: (mix.filter((m) => /certif|money market/i.test(m.c)).reduce((s, m) => s + Number(m.b), 0) / deposits) * 100,
    };

    // ---- loans: mix, yields, growth over 12 months and 60+ delinquency ----
    const book = await rows<{ c: string; b: number; r: number; n: number; d60: number }>(this.pool, 'SELECT loan_category AS c, SUM(balance) AS b, SUM(balance * rate) / NULLIF(SUM(balance), 0) AS r, COUNT(*) AS n, SUM(CASE WHEN days_delinquent >= 60 THEN balance ELSE 0 END) AS d60 FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL GROUP BY loan_category ORDER BY b DESC');
    const growth = await rows<{ c: string; now_b: number; then_b: number | null }>(
      this.pool,
      `SELECT loan_category AS c, SUM(CASE WHEN month_end = (SELECT MAX(month_end) FROM hist_loan_month) THEN balance ELSE 0 END) AS now_b,
         SUM(CASE WHEN month_end = LAST_DAY(DATE_SUB((SELECT MAX(month_end) FROM hist_loan_month), INTERVAL 12 MONTH)) THEN balance ELSE 0 END) AS then_b
       FROM hist_loan_month GROUP BY loan_category`,
    );
    const loanTotal = book.reduce((s, l) => s + Number(l.b), 0);
    const cre = book.filter((l) => /commercial real estate/i.test(l.c)).reduce((s, l) => s + Number(l.b), 0);
    const business = book.filter((l) => /commercial|business/i.test(l.c)).reduce((s, l) => s + Number(l.b), 0);
    const loans = {
      total: loanTotal,
      yieldPct: book.reduce((s, l) => s + Number(l.b) * Number(l.r), 0) / loanTotal,
      lines: book.map((l) => {
        const g = growth.find((x) => x.c === l.c);
        return { category: l.c, balance: Number(l.b), sharePct: (Number(l.b) / loanTotal) * 100, ratePct: Number(l.r), growthPct: g && Number(g.then_b) ? ((Number(g.now_b) - Number(g.then_b)) / Number(g.then_b)) * 100 : null, dq60Pct: Number(l.b) ? (Number(l.d60) / Number(l.b)) * 100 : 0 };
      }),
      concentration: bank
        ? { name: 'Commercial real estate to capital', value: (cre / (equity * 1.08)) * 100, limit: ALCO_POLICY.creToCapitalMaxPct, unit: '%' as const }
        : { name: 'Business loans to net worth', value: business / equity, limit: ALCO_POLICY.businessLoansToNetWorthMax, unit: '×' as const },
    };

    // ---- policy compliance: every limit, actual and status ----
    const worst = <K extends 'niiPct' | 'nevPct' | 'nevRatio'>(k: K) => [...irr.scenarios].filter((s) => s.shockBp !== 0).sort((a, b) => a[k] - b[k])[0]!;
    const niiWorst = worst('niiPct');
    const nevWorst = worst('nevPct');
    const ratioWorst = worst('nevRatio');
    const shock = (bp: number) => `${bp > 0 ? '+' : ''}${bp} bp`;
    const la = liq.ratios[0]!.value;
    const lts = liq.ratios[2]!.value;
    const borrow = liq.ratios[3]!.value;
    const s20 = liq.stress.find((s) => s.pct === 20)!;
    const word = bank ? 'deposits' : 'shares';
    const line = (area: string, measure: string, policy: string, actual: string, j: { status: PolicyStatus; closeness: number }, brief: string): PolicyLine => ({ area, measure, policy, actual, brief, ...j });
    const policy: PolicyLine[] = [
      line('Interest rate risk', `Net interest income, worst shock (${shock(niiWorst.shockBp)})`, `No worse than −${IRR_LIMITS.niiDeclinePct}%`, signed(niiWorst.niiPct), judge(-niiWorst.niiPct, IRR_LIMITS.niiDeclinePct, 'max'), `net interest income at ${shock(niiWorst.shockBp)} is ${signed(niiWorst.niiPct)} (limit −${IRR_LIMITS.niiDeclinePct}%)`),
      line('Interest rate risk', `NEV, worst shock (${shock(nevWorst.shockBp)})`, `No worse than −${IRR_LIMITS.nevDeclinePct}%`, signed(nevWorst.nevPct), judge(-nevWorst.nevPct, IRR_LIMITS.nevDeclinePct, 'max'), `NEV at ${shock(nevWorst.shockBp)} is ${signed(nevWorst.nevPct)} (limit −${IRR_LIMITS.nevDeclinePct}%)`),
      line('Interest rate risk', `NEV ratio, lowest (${shock(ratioWorst.shockBp)})`, `At least ${IRR_LIMITS.nevRatioMinPct}%`, p1(ratioWorst.nevRatio), judge(ratioWorst.nevRatio, IRR_LIMITS.nevRatioMinPct, 'min'), `the NEV ratio at ${shock(ratioWorst.shockBp)} is ${p1(ratioWorst.nevRatio)} (minimum ${IRR_LIMITS.nevRatioMinPct}%)`),
      line('Liquidity', 'Liquid assets to total assets', `At least ${LIQUIDITY_POLICY.liquidToAssetsMinPct}%`, la.toFixed(1) === LIQUIDITY_POLICY.liquidToAssetsMinPct.toFixed(1) ? `${la.toFixed(2)}%` : p1(la), judge(la, LIQUIDITY_POLICY.liquidToAssetsMinPct, 'min'), `liquid assets are ${la.toFixed(1) === LIQUIDITY_POLICY.liquidToAssetsMinPct.toFixed(1) ? la.toFixed(2) : la.toFixed(1)}% of total assets (minimum ${LIQUIDITY_POLICY.liquidToAssetsMinPct}%)`),
      line('Liquidity', `Available liquidity to ${word}`, `At least ${LIQUIDITY_POLICY.availableToSharesMinPct}%`, p1(liq.availableToShares), judge(liq.availableToShares, LIQUIDITY_POLICY.availableToSharesMinPct, 'min'), `available liquidity is ${p1(liq.availableToShares)} of ${word} (minimum ${LIQUIDITY_POLICY.availableToSharesMinPct}%)`),
      line('Liquidity', `Days covered if 20% of ${word} leave in 30 days`, `At least ${LIQUIDITY_POLICY.survivalMinDays} days`, `${s20.days} days`, judge(s20.days, LIQUIDITY_POLICY.survivalMinDays, 'min'), `a 20% run is covered for ${s20.days} days (minimum ${LIQUIDITY_POLICY.survivalMinDays})`),
      line('Liquidity', bank ? 'Loan-to-deposit ratio' : 'Loan-to-share ratio', `No more than ${ALCO_POLICY.loanToShareMaxPct}%`, p1(lts), judge(lts, ALCO_POLICY.loanToShareMaxPct, 'max'), `${bank ? 'loan-to-deposit' : 'loan-to-share'} is ${p1(lts)} (maximum ${ALCO_POLICY.loanToShareMaxPct}%)`),
      line('Liquidity', `Borrowings to ${word} and ${bank ? 'equity' : 'net worth'}`, `No more than ${ALCO_POLICY.borrowingsMaxPct}%`, p1(borrow), judge(borrow, ALCO_POLICY.borrowingsMaxPct, 'max'), `borrowings are ${p1(borrow)} of ${word} and ${bank ? 'equity' : 'net worth'} (maximum ${ALCO_POLICY.borrowingsMaxPct}%)`),
      ...capital.lines.map((c) => line('Capital', c.name, `At least ${c.limit}%`, p1(c.value), judge(c.value, c.limit, 'min'), `the ${c.name.replace(/ \(estimate\)$/, '').toLowerCase()} is ${p1(c.value)} (minimum ${c.limit}%)`)),
      line('Concentration', loans.concentration.name, loans.concentration.unit === '%' ? `No more than ${loans.concentration.limit}%` : `No more than ${loans.concentration.limit}×`, loans.concentration.unit === '%' ? `${Math.round(loans.concentration.value)}%` : `${loans.concentration.value.toFixed(2)}×`, judge(loans.concentration.value, loans.concentration.limit, 'max'), bank ? `commercial real estate is ${Math.round(loans.concentration.value)}% of capital (limit ${loans.concentration.limit}%)` : `business loans are ${loans.concentration.value.toFixed(2)} times net worth (limit ${loans.concentration.limit}×)`),
    ];
    const breaches = policy.filter((p) => p.status === 'Breach');
    const watch = policy.filter((p) => p.status === 'Watch');
    const irrBreach = irr.scenarios.filter((s) => !s.withinLimits);
    const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    const headline = breaches.length
      ? `${breaches.length} of ${policy.length} policy limits ${breaches.length === 1 ? 'is' : 'are'} breached. ${cap(breaches.map((b) => b.brief).join('; '))}.${watch.length ? ` Close to a limit: ${watch.map((w) => w.brief).join('; ')}.` : ''}`
      : `All ${policy.length} policy limits are met.${watch.length ? ` Closest: ${watch.map((w) => w.brief).join('; ')}.` : ''}`;

    return { asOf, bank, policy, breaches, watch, headline, irrBreachShocks: irrBreach.map((s) => s.shockBp), earnings, capital, funding: fundingView, loans, irr, liq, totalAssets };
  }
}
