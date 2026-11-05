// Liquidity and borrowing capacity: the on-balance-sheet liquidity ratios, a 30/90/180/365-day cash-flow
// ladder, contingent funding (FHLB, the Federal Reserve discount window, unpledged securities, the
// corporate credit union line, CLF access) and survival under share runoff. The cash flows are the IRR
// engine's, so the two reports agree. Collateral values use typical lendable values, stated as
// assumptions: the FHLB's and the Reserve Bank's own collateral rules and actual pledges set the real
// figures, so this is DI's estimate, like the IRR view.
import type { Pool } from '@dinext/tenant-db';
import { IrrService } from './irr.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

/** Board policy for the demo institution; an ALCO sets its own. */
export const LIQUIDITY_POLICY = { availableToSharesMinPct: 15, liquidToAssetsMinPct: 10, survivalMinDays: 30 };

/** Lendable value of each kind of collateral, as a share of balance or fair value. */
const LENDABLE = { firstMortgage: 0.75, homeEquity: 0.6, auto: 0.7, consumer: 0.5, securities: 0.95 };
/** The FHLB lends up to about 20% of total assets, whatever the collateral. */
const FHLB_ASSET_CAP = 0.2;
/** The share of eligible loans actually listed with the FHLB as collateral. */
const FHLB_LISTED = 0.7;
const CORPORATE_LINE = 50_000_000;
const LADDER: [string, number, number][] = [['0–30 days', 0, 1], ['31–90 days', 1, 3], ['91–180 days', 3, 6], ['181–365 days', 6, 12]];
/** Of maturing certificates, the share that renews rather than leaves. */
const CERT_RENEWAL = 0.8;

export class LiquidityService {
  constructor(
    private readonly pool: Pool,
    private readonly institutionType: 'credit_union' | 'bank' = 'credit_union',
  ) {}

  async analysis() {
    const irr = new IrrService(this.pool);
    const { asOf, positions, netWorth, totalAssets, fromCallReport } = await irr.positions();
    const cr = await rows<{ code: string; amount: number }>(this.pool, `SELECT code, amount FROM cr_value WHERE quarter_end = (SELECT MAX(quarter_end) FROM cr_value) AND code IN ('AS0009','AS0067','AS0073','NV0153','860C','018','025B','010','997')`).catch(() => []);
    const v = (code: string) => Number(cr.find((x) => x.code === code)?.amount ?? 0);
    const pos = (name: string) => positions.filter((p) => p.name === name);
    const bal = (name: string) => pos(name).reduce((s, p) => s + p.balance, 0);
    const assets = positions.filter((p) => p.side === 'asset');
    const shares = positions.filter((p) => p.side === 'liability' && p.name !== 'Borrowings').reduce((s, p) => s + p.balance, 0);
    const borrowings = bal('Borrowings');
    const loans = assets.filter((p) => !['Cash and overnight funds', 'Investments'].includes(p.name)).reduce((s, p) => s + p.balance, 0);
    const cash = bal('Cash and overnight funds');
    const investments = bal('Investments');
    const invWithinYear = fromCallReport ? v('NV0153') : investments * 0.21;
    const A = totalAssets ?? assets.reduce((s, p) => s + p.balance, 0) * 1.04;
    const nw = netWorth ?? A * 0.1;

    // ---- on-balance-sheet liquidity ----
    const liquid = cash + invWithinYear;
    const certs = bal('Certificates');
    const moneyMarket = bal('Money market');
    const ratios = [
      { name: 'Liquid assets to total assets', value: (liquid / A) * 100, note: 'Cash and deposits plus investments maturing within a year.', limit: LIQUIDITY_POLICY.liquidToAssetsMinPct },
      { name: 'Liquid assets to shares and borrowings', value: (liquid / (shares + borrowings)) * 100, note: 'How much of the funding could be repaid from liquid assets.' },
      { name: 'Loan-to-share ratio', value: (loans / shares) * 100, note: 'Loans as a share of member shares; above about 90% leaves little room.' },
      { name: 'Borrowings to shares and net worth', value: (borrowings / (shares + nw)) * 100, note: 'Reliance on wholesale funding.' },
      { name: 'Certificates and money market to shares', value: ((certs + moneyMarket) / shares) * 100, note: 'The rate-sensitive share of funding, most likely to move with rates.' },
    ];

    // ---- cash-flow ladder: what comes in and goes out in each band ----
    const inflow = (from: number, to: number) => assets.filter((p) => p.name !== 'Cash and overnight funds').reduce((s, p) => s + p.flows(0).slice(from, to).reduce((a, b) => a + b, 0), 0);
    const outflow = (from: number, to: number) =>
      positions.filter((p) => p.side === 'liability').reduce((s, p) => {
        const f = p.flows(0).slice(from, to).reduce((a, b) => a + b, 0);
        // Most certificates renew at maturity; only the rest leaves.
        return s + (p.name === 'Certificates' ? f * (1 - CERT_RENEWAL) : f);
      }, 0);
    let running = cash;
    const ladder = LADDER.map(([label, from, to]) => {
      const i = inflow(from, to);
      const o = outflow(from, to);
      running += i - o;
      return { label, inflows: i, outflows: o, net: i - o, cumulative: running };
    });

    // ---- contingent funding: borrowing capacity by source ----
    const [collateral] = await rows<Record<string, number>>(this.pool, `SELECT
        SUM(CASE WHEN loan_category IN ('Mortgage') AND days_delinquent < 60 THEN balance ELSE 0 END) AS mortgage,
        SUM(CASE WHEN loan_category IN ('HELOC') AND days_delinquent < 60 THEN balance ELSE 0 END) AS heloc,
        SUM(CASE WHEN loan_category IN ('Auto') AND days_delinquent < 30 THEN balance ELSE 0 END) AS auto,
        SUM(CASE WHEN loan_category IN ('Personal', 'Credit Card', 'Consumer') AND days_delinquent < 30 THEN balance ELSE 0 END) AS consumer,
        SUM(CASE WHEN loan_category IN ('Commercial Real Estate') AND days_delinquent < 60 THEN balance ELSE 0 END) AS cre
      FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL`);
    const c = (k: string) => Number(collateral?.[k] ?? 0);
    const securities = fromCallReport ? v('AS0067') + v('AS0073') : investments;
    // Securities within a year are already counted as liquid; the rest can be pledged or sold.
    const pledgeableSecurities = Math.max(0, securities - invWithinYear);
    const fhlbCollateral = (c('mortgage') * LENDABLE.firstMortgage + c('heloc') * LENDABLE.homeEquity + c('cre') * 0.5) * FHLB_LISTED;
    const fhlbLimit = Math.min(fhlbCollateral, A * FHLB_ASSET_CAP);
    const fhlbAvailable = Math.max(0, fhlbLimit - borrowings);
    const discountWindow = c('auto') * LENDABLE.auto + c('consumer') * LENDABLE.consumer;
    const securitiesValue = pledgeableSecurities * LENDABLE.securities;
    const bank = this.institutionType === 'bank';
    const lineName = bank ? 'Correspondent bank line' : 'Corporate credit union line';
    const capacity = [
      { source: 'FHLB advances', collateral: 'First mortgages, home equity and commercial real estate, current or under 60 days', collateralValue: c('mortgage') + c('heloc') + c('cre'), lendable: fhlbLimit, used: borrowings, available: fhlbAvailable },
      { source: 'Federal Reserve discount window', collateral: 'Auto and consumer loans under 30 days, if pledged', collateralValue: c('auto') + c('consumer'), lendable: discountWindow, used: 0, available: discountWindow },
      { source: 'Unpledged securities', collateral: 'Investments beyond a year, to pledge for repo or sell', collateralValue: pledgeableSecurities, lendable: securitiesValue, used: 0, available: securitiesValue },
      { source: bank ? 'Correspondent bank line' : 'Corporate credit union line', collateral: 'Committed line of credit', collateralValue: CORPORATE_LINE, lendable: CORPORATE_LINE, used: 0, available: CORPORATE_LINE },
    ];
    const contingent = capacity.reduce((s, x) => s + x.available, 0);
    const available = liquid + contingent;

    // ---- stress: shares leave within 30 days; sources are used in order of cost ----
    const stress = [10, 20, 30].map((pct) => {
      const runoff = shares * (pct / 100);
      const sources = [['Cash and investments within a year', liquid], ['Unpledged securities', securitiesValue], ['FHLB advances', fhlbAvailable], ['Federal Reserve discount window', discountWindow], [lineName, CORPORATE_LINE]] as [string, number][];
      let need = runoff;
      const used = sources.map(([name, amt]) => {
        const take = Math.min(amt, Math.max(0, need));
        need -= take;
        return { name, amount: take };
      });
      const covered = available >= runoff;
      // Spread evenly over 30 days, sources last this many days.
      const days = Math.min(365, Math.floor((available / runoff) * 30));
      return { pct, runoff, available, covered, shortfall: covered ? 0 : runoff - available, days, used: used.filter((u) => u.amount > 0), coverage: available / runoff };
    });

    return {
      asOf,
      fromCallReport,
      totalAssets: A,
      shares,
      borrowings,
      liquid,
      contingent,
      available,
      availableToShares: (available / shares) * 100,
      ratios,
      ladder,
      capacity,
      stress,
      policy: LIQUIDITY_POLICY,
      clf: bank ? null : 'Access through the corporate credit union (agent membership); not drawn.',
      assumptions: [
        ['Liquid assets', fromCallReport ? 'Cash and deposits (5300 AS0009) plus investments maturing within a year (Schedule B, NV0153).' : 'Cash, plus 21% of investments assumed to mature within a year.'],
        ['Cash-flow ladder', `Loan payments and prepayments and investment maturities as in the IRR model; ${Math.round(CERT_RENEWAL * 100)}% of maturing certificates renew; non-maturity shares run off at the IRR model's decay rates.`],
        ['FHLB lendable values', `First mortgages ${LENDABLE.firstMortgage * 100}%, home equity ${LENDABLE.homeEquity * 100}%, commercial real estate 50% of balance, performing loans only, with ${FHLB_LISTED * 100}% of eligible loans listed as collateral; capped at ${FHLB_ASSET_CAP * 100}% of total assets, less advances outstanding.`],
        ['Discount window', `Auto loans ${LENDABLE.auto * 100}%, consumer loans and cards ${LENDABLE.consumer * 100}%, under 30 days past due, assuming they are pledged under a borrower-in-custody arrangement.`],
        ['Securities', `Investments beyond a year at ${LENDABLE.securities * 100}% of value, for repo or sale.`],
        [bank ? 'Correspondent line' : 'Corporate line and CLF', bank ? `A committed $${CORPORATE_LINE / 1e6}M correspondent bank line.` : `A committed $${CORPORATE_LINE / 1e6}M corporate line; CLF access through the corporate credit union, not counted as capacity.`],
        ['Stress', `Shares leave evenly over 30 days; sources are used in order: liquid assets, securities, FHLB, discount window, then the ${bank ? 'correspondent' : 'corporate'} line.`],
        ['Model of record', 'DI’s estimate from core data. Collateral rules and actual pledges with the FHLB and the Reserve Bank set the real capacity.'],
      ] as [string, string][],
    };
  }
}
