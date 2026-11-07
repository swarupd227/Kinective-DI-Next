// Funding risk after SVB, for a bank: can it survive 30 days of withdrawals without selling assets at
// a loss? DI answers from the Call Report and its liquidity model:
// - a deposit run aimed at uninsured deposits, met first from sources that realize no loss (cash, loan
//   payments, then borrowing against loans and securities), and what selling securities instead would
//   cost, as SVB did;
// - the securities' unrealized losses against tier 1 capital, and the leverage ratio if they were realized;
// - estimates of the liquidity coverage ratio (LCR) and the net stable funding ratio (NSFR). The US rules
//   apply to banks of $100 billion and more; a community bank doesn't file them, but its board asks, so
//   DI estimates them with the standard weights and shows every assumption.
import type { Pool } from '@dinext/tenant-db';
import { BASEL_ASSUMPTIONS } from './basel.ts';
import { LiquidityService } from './liquidity.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const TAX = 0.21;

/** How uninsured deposits behave in a 30-day stress (US LCR outflow rates), and DI's split of them. */
const UNINSURED_SPLIT = { retail: 0.5, operational: 0.25, nonOperational: 0.25 };
const OUTFLOW = { insuredStable: 0.03, uninsuredRetail: 0.1, operational: 0.25, nonOperational: 0.4, retailLines: 0.05, creditLines: 0.1 };
/** Unused commitments, from the Basel III estimate's assumptions: HELOC 60%, C&I 25%, construction 30% of drawn. */
const UNUSED = { heloc: 0.6, ci: 0.25, construction: 0.3 };
/** Loan payments due in 30 days count at half, capped at 75% of outflows (the LCR rule). */
const INFLOW_RATE = 0.5;
const INFLOW_CAP = 0.75;
/** A haircut on securities pledged to borrow: lent at 95% of fair value, so no loss is realized. */
const PLEDGE = 0.95;

export interface RunScenario {
  key: 'uninsured' | 'severe' | 'even' | 'custom';
  name: string;
  uninsuredPct: number;
  insuredPct: number;
  runoff: number;
  /** Sources that realize no loss, used in order, and how much of each the run takes. */
  used: { source: string; available: number; used: number }[];
  lossFree: number;
  covered: boolean;
  shortfall: number;
  /** Days the loss-free sources last if the run is spread evenly over 30 days. */
  days: number;
  /** If the run were met by selling securities after cash, as SVB did: the sale and the loss it realizes. */
  sale: { amount: number; loss: number; lossAfterTax: number; capitalPct: number };
}

export class FundingRiskService {
  constructor(private readonly pool: Pool) {}

  private async values() {
    const list = await rows<{ code: string; amount: number | null; q: unknown }>(this.pool, 'SELECT code, amount, quarter_end AS q FROM cr_value WHERE quarter_end = (SELECT MAX(quarter_end) FROM cr_value) AND code LIKE ?', ['RCON%']).catch(() => []);
    if (!list.length) return null;
    const v = new Map(list.map((r) => [r.code, Number(r.amount ?? 0)]));
    const q = list[0]!.q;
    return { g: (c: string) => v.get(c) ?? 0, end: (q instanceof Date ? q.toISOString() : String(q)).slice(0, 10) };
  }

  async analysis(custom?: { uninsuredPct: number; insuredPct: number }) {
    const cr = await this.values();
    if (!cr) return null;
    const { g } = cr;
    const liq = (await new LiquidityService(this.pool, 'bank').analysis())!;
    const deposits = g('RCON2200');
    const uninsured = Math.min(g('RCON5597'), deposits);
    const insured = deposits - uninsured;
    // Securities: held to maturity at amortized cost, available for sale at fair value; both have a fair value.
    const htmBook = g('RCON1754');
    const htmFair = g('RCON1771') || htmBook;
    const afsBook = g('RCON1772');
    const afsFair = g('RCON1773');
    const fair = htmFair + afsFair;
    const book = htmBook + afsBook;
    const unrealized = { htm: htmBook - htmFair, afs: afsBook - afsFair, total: book - fair };
    const lossRate = fair ? unrealized.total / fair : 0;
    const pledged = Math.min(g('RCON0416'), fair);
    const unpledgedFair = fair - pledged;
    const tier1 = g('RCON8274');
    const levAssets = g('RCONA224');
    const lossAfterTax = Math.max(0, unrealized.total) * (1 - TAX);
    const capital = {
      tier1,
      lossToTier1Pct: tier1 ? (Math.max(0, unrealized.total) / tier1) * 100 : 0,
      leveragePct: levAssets ? (tier1 / levAssets) * 100 : 0,
      leverageIfRealizedPct: levAssets ? ((tier1 - lossAfterTax) / (levAssets - Math.max(0, unrealized.total))) * 100 : 0,
    };

    // Sources that realize no loss, in the order a treasurer would use them.
    const cash = g('RCON0081') + g('RCON0071');
    const loanPayments = liq.ladder[0]?.inflows ?? 0;
    const cap = (name: string) => liq.capacity.find((c) => c.source === name)?.available ?? 0;
    const sources = [
      { source: 'Cash and balances at the Federal Reserve', available: cash },
      { source: 'Loan payments due in the next 30 days', available: loanPayments },
      { source: 'FHLB advances against loans', available: cap('FHLB advances') },
      { source: 'Federal Reserve discount window', available: cap('Federal Reserve discount window') },
      { source: 'Correspondent bank line', available: cap('Correspondent bank line') },
      { source: 'Borrowing against unpledged securities', available: unpledgedFair * PLEDGE },
    ];
    const lossFreeTotal = sources.reduce((s, x) => s + x.available, 0);
    const scenario = (key: RunScenario['key'], name: string, uninsuredPct: number, insuredPct: number): RunScenario => {
      const runoff = (uninsured * uninsuredPct + insured * insuredPct) / 100;
      let left = runoff;
      const used = sources.map((s) => {
        const take = Math.max(0, Math.min(s.available, left));
        left -= take;
        return { ...s, used: take };
      });
      // SVB met its run by selling securities once cash ran out: the loss that would realize here.
      const afterCash = Math.max(0, runoff - cash - loanPayments);
      const saleAmount = Math.min(afterCash, unpledgedFair);
      const loss = saleAmount * lossRate;
      return {
        key,
        name,
        uninsuredPct,
        insuredPct,
        runoff,
        used,
        lossFree: lossFreeTotal,
        covered: left <= 0.5,
        shortfall: Math.max(0, left),
        days: runoff ? Math.min(365, Math.floor((lossFreeTotal / (runoff / 30)) * 1)) : 365,
        sale: { amount: saleAmount, loss, lossAfterTax: loss * (1 - TAX), capitalPct: tier1 ? ((loss * (1 - TAX)) / tier1) * 100 : 0 },
      };
    };
    const scenarios = [
      scenario('uninsured', 'Uninsured run', 40, 5),
      scenario('severe', 'Severe, SVB-like run', 60, 10),
      scenario('even', 'Even run of all deposits', 20, 20),
      ...(custom ? [scenario('custom', `${custom.uninsuredPct}% of uninsured and ${custom.insuredPct}% of insured`, custom.uninsuredPct, custom.insuredPct)] : []),
    ];

    // LCR: high-quality liquid assets over 30 days of net stressed outflows.
    const share = (name: RegExp) => BASEL_ASSUMPTIONS.securities.filter((s) => name.test(s.name)).reduce((x, s) => x + s.share, 0);
    const free = fair ? unpledgedFair / fair : 0;
    const level1Sec = fair * free * share(/Treasuries|Ginnie/);
    const level2a = fair * free * share(/Fannie|Freddie/) * 0.85;
    const level2b = fair * free * share(/general obligation/) * 0.5;
    const level1 = g('RCON0081') * BASEL_ASSUMPTIONS.cashVaultShare + g('RCON0071') + level1Sec;
    // Level 2 is capped at 40% of HQLA and level 2B at 15%.
    const l2bCap = Math.min(level2b, (15 / 85) * (level1 + level2a));
    const l2 = Math.min(level2a + l2bCap, (40 / 60) * level1);
    const hqla = level1 + l2;
    const out = {
      insured: insured * OUTFLOW.insuredStable,
      uninsuredRetail: uninsured * UNINSURED_SPLIT.retail * OUTFLOW.uninsuredRetail,
      operational: uninsured * UNINSURED_SPLIT.operational * OUTFLOW.operational,
      nonOperational: uninsured * UNINSURED_SPLIT.nonOperational * OUTFLOW.nonOperational,
      retailLines: g('RCON1797') * UNUSED.heloc * OUTFLOW.retailLines,
      creditLines: (g('RCON1766') * UNUSED.ci + g('RCONF159') * UNUSED.construction) * OUTFLOW.creditLines,
    };
    const outflows = Object.values(out).reduce((s, x) => s + x, 0);
    const inflows = Math.min(loanPayments * INFLOW_RATE, outflows * INFLOW_CAP);
    const lcr = { hqla, level1, level2: l2, outflows, inflows, net: outflows - inflows, pct: outflows - inflows > 0 ? (hqla / (outflows - inflows)) * 100 : 0, lines: out };

    // NSFR: available stable funding over required stable funding, a year out.
    const asf = {
      capital: g('RCON3210') * 1,
      insured: insured * 0.95,
      uninsuredRetail: uninsured * UNINSURED_SPLIT.retail * 0.9,
      wholesale: uninsured * (UNINSURED_SPLIT.operational + UNINSURED_SPLIT.nonOperational) * 0.5,
      borrowings: g('RCON3190') * 0.5,
    };
    const nonperforming = g('RCON1403') + g('RCON1407');
    const loans = g('RCON2122');
    const securitiesCarrying = htmBook + afsFair;
    const rsf = {
      level1: 0,
      level2a: securitiesCarrying * share(/Fannie|Freddie/) * 0.15,
      level2b: securitiesCarrying * share(/municipal/i) * 0.5,
      mortgages: g('RCON5367') * 0.65,
      otherLoans: Math.max(0, loans - g('RCON5367') - nonperforming) * 0.85,
      nonperforming,
      fixedAndOther: g('RCON2145') + g('RCON2160'),
      commitments: (g('RCON1797') * UNUSED.heloc + g('RCON1766') * UNUSED.ci + g('RCONF159') * UNUSED.construction) * 0.05,
    };
    const asfTotal = Object.values(asf).reduce((s, x) => s + x, 0);
    const rsfTotal = Object.values(rsf).reduce((s, x) => s + x, 0);
    const nsfr = { asf: asfTotal, rsf: rsfTotal, pct: rsfTotal ? (asfTotal / rsfTotal) * 100 : 0, asfLines: asf, rsfLines: rsf };

    return { asOf: cr.end, deposits, uninsured, insured, uninsuredPct: deposits ? (uninsured / deposits) * 100 : 0, securities: { book, fair, pledged, unpledgedFair, lossRate }, unrealized, capital, sources, lossFreeTotal, scenarios, lcr, nsfr };
  }

  assumptions(): [string, string][] {
    return [
      ['Basis', 'The latest FFIEC 051 Call Report and DI’s liquidity model. DI’s estimates: a community bank doesn’t file the LCR or NSFR (the US rules start at $100 billion of assets).'],
      ['Uninsured deposits', `RC-O’s estimate of uninsured deposits, split ${UNINSURED_SPLIT.retail * 100}% retail, ${UNINSURED_SPLIT.operational * 100}% operational and ${UNINSURED_SPLIT.nonOperational * 100}% non-operational business deposits.`],
      ['Run scenarios', 'Uninsured run: 40% of uninsured and 5% of insured deposits leave in 30 days. Severe, SVB-like: 60% and 10%. Even: 20% of all deposits.'],
      ['Sources without a loss', `Cash and Federal Reserve balances, loan payments due in 30 days, FHLB advances against loans, the discount window, the correspondent line, then borrowing against unpledged securities at ${PLEDGE * 100}% of fair value. Borrowing against a bond realizes no loss; selling it does.`],
      ['Selling instead', 'The loss if the run, after cash and loan payments, were met by selling securities at today’s average discount to book value, after 21% tax.'],
      ['LCR', `High-quality liquid assets: currency, Federal Reserve balances, Treasuries and Ginnie Mae (level 1), agency MBS at 85% (2A), general obligation munis at 50% (2B), unpledged only, with the level 2 caps. Outflows: insured deposits ${OUTFLOW.insuredStable * 100}%, uninsured retail ${OUTFLOW.uninsuredRetail * 100}%, operational ${OUTFLOW.operational * 100}%, non-operational ${OUTFLOW.nonOperational * 100}%, unused home equity lines ${OUTFLOW.retailLines * 100}%, business lines ${OUTFLOW.creditLines * 100}%. Inflows: half of 30 days’ loan payments, capped at 75% of outflows.`],
      ['NSFR', 'Available: equity 100%, insured deposits 95%, uninsured retail 90%, business deposits 50%, borrowings 50%. Required: level 2A securities 15%, munis 50%, first mortgages 65%, other loans 85%, nonperforming loans, premises and other assets 100%, unused commitments 5%.'],
      ['Securities mix', 'From the Basel III estimate: Treasuries 20%, Ginnie Mae 10%, agency MBS 45%, general obligation munis 20%, revenue munis 5%.'],
    ];
  }
}
