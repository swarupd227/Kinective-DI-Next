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
import { AlcoService } from './alco.ts';
import { SHARES } from './irr.ts';

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
/** A bank's loan-to-deposit band: below 80% deposits sit idle, above 100% loans lean on wholesale borrowing. */
export const LTD_BAND = { low: 80, high: 100 };
const LTD_CODES = ['RCON2122', 'RCON2200', 'RCON3190', 'RCON2365', 'RIAD4180', 'RIAD4073'];
/** Rising rates: the extra share of each product that leaves within a year for every 100 bp, on top of its usual decay. */
const RATE_RUN_PER_100 = { checking: 0.02, savings: 0.03, moneyMarket: 0.06, certificates: 0.04, uninsured: 0.08 };
/** Certificates that mature and don't renew in an ordinary year. */
const CD_ATTRITION = 0.2;
/** Non-maturity rates catch up with a lag: about three quarters of the beta within the year, as in the rate-risk model. */
const NMD_LAG = 0.75;
/** DI's watch levels for uninsured deposits as a share of deposits. SVB's was about 90%. */
export const UNINSURED_LEVELS = { watch: 40, concern: 60 };
export const RATE_SHOCKS = [100, 200, 300];

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

  /**
   * Loan-to-deposit from the Call Report, against the 80% to 100% band, with the wholesale funding
   * behind it (FHLB and other borrowed money, brokered deposits), what it costs against deposits, the
   * plan and peers, and five quarters of trend.
   */
  async loanToDeposit() {
    const list = await rows<{ code: string; amount: number | null; q: unknown }>(this.pool, `SELECT code, amount, quarter_end AS q FROM cr_value WHERE code IN (${LTD_CODES.map(() => '?').join(', ')}) ORDER BY quarter_end`, LTD_CODES).catch(() => []);
    if (!list.length) return null;
    const byQuarter = new Map<string, Map<string, number>>();
    for (const r of list) {
      const end = (r.q instanceof Date ? r.q.toISOString() : String(r.q)).slice(0, 10);
      if (!byQuarter.has(end)) byQuarter.set(end, new Map());
      byQuarter.get(end)!.set(r.code, Number(r.amount ?? 0));
    }
    const trend = [...byQuarter.entries()].map(([end, v]) => {
      const g = (c: string) => v.get(c) ?? 0;
      const loans = g('RCON2122');
      const deposits = g('RCON2200');
      const borrowings = g('RCON3190');
      const brokered = Math.min(g('RCON2365'), deposits);
      const wholesale = borrowings + brokered;
      const core = deposits - brokered;
      // Income is year to date: a September quarter holds nine months.
      const years = Number(end.slice(5, 7)) / 12;
      return {
        end,
        loans,
        deposits,
        borrowings,
        brokered,
        wholesale,
        core,
        pct: deposits ? (loans / deposits) * 100 : 0,
        corePct: core ? (loans / core) * 100 : 0,
        wholesaleSharePct: deposits + borrowings ? (wholesale / (deposits + borrowings)) * 100 : 0,
        borrowingCostPct: borrowings && years ? (g('RIAD4180') / years / borrowings) * 100 : null,
        depositCostPct: deposits && years ? ((g('RIAD4073') - g('RIAD4180')) / years / deposits) * 100 : null,
      };
    });
    const now = trend.at(-1)!;
    const [bench] = (await this.pool.query("SELECT kind, value FROM fin_benchmark WHERE metric = 'loan_to_share_ratio'").catch(() => [[]])) as [{ kind: string; value: number }[]];
    const ref = (kind: string) => {
      const b = bench.find((x) => x.kind === kind);
      return b ? Number(b.value) : null;
    };
    const zone: 'idle' | 'healthy' | 'wholesale' = now.pct < LTD_BAND.low ? 'idle' : now.pct > LTD_BAND.high ? 'wholesale' : 'healthy';
    return {
      asOf: now.end,
      ...now,
      band: { ...LTD_BAND, zone },
      /** Deposits not lent out below the band's floor: what could be lent before reaching 80%. */
      idle: Math.max(0, (LTD_BAND.low / 100) * now.deposits - now.loans),
      /** Room to lend before loans pass deposits and need borrowed money. */
      roomTo100: Math.max(0, now.deposits - now.loans),
      /** Loans that deposits don't cover, so wholesale money funds them. */
      gap: Math.max(0, now.loans - now.deposits),
      /** Loans beyond core deposits (deposits less brokered): the part resting on wholesale funding. */
      beyondCore: Math.max(0, now.loans - now.core),
      yearAgo: trend.length >= 5 ? trend[0]! : null,
      plan: ref('plan'),
      peer: ref('peer'),
      trend,
    };
  }

  /**
   * The deposit book a CFO is asked about after SVB: the mix by product with rates and betas, how much is
   * uninsured and how that has moved, the largest depositors, and what happens if rates rise: how much
   * more deposits cost and how much leaves within a year, uninsured money fastest.
   */
  async deposits() {
    const cr = await rows<{ code: string; amount: number | null; q: unknown }>(this.pool, "SELECT code, amount, quarter_end AS q FROM cr_value WHERE code IN ('RCON2200', 'RCON5597', 'RCON2365') ORDER BY quarter_end").catch(() => []);
    if (!cr.length) return null;
    const byQuarter = new Map<string, Map<string, number>>();
    for (const r of cr) {
      const end = (r.q instanceof Date ? r.q.toISOString() : String(r.q)).slice(0, 10);
      if (!byQuarter.has(end)) byQuarter.set(end, new Map());
      byQuarter.get(end)!.set(r.code, Number(r.amount ?? 0));
    }
    const uninsuredTrend = [...byQuarter.entries()].map(([end, v]) => ({ end, deposits: v.get('RCON2200') ?? 0, uninsured: Math.min(v.get('RCON5597') ?? 0, v.get('RCON2200') ?? 0), pct: v.get('RCON2200') ? ((v.get('RCON5597') ?? 0) / v.get('RCON2200')!) * 100 : 0 }));
    const now = uninsuredTrend.at(-1)!;
    const brokered = byQuarter.get(now.end)?.get('RCON2365') ?? 0;

    // The book by product, from open accounts, with the beta measured on the last rate move.
    const book = await rows<{ c: string; n: number; bal: number; rw: number; zero: number; due: number }>(
      this.pool,
      'SELECT deposit_category AS c, COUNT(*) AS n, SUM(balance) AS bal, SUM(balance * rate) AS rw, SUM(CASE WHEN rate = 0 THEN balance ELSE 0 END) AS zero, SUM(CASE WHEN maturity_date IS NOT NULL AND maturity_date <= DATE_ADD((SELECT MAX(as_of_date) FROM meta_build), INTERVAL 12 MONTH) THEN balance ELSE 0 END) AS due FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY deposit_category ORDER BY bal DESC',
    );
    const total = book.reduce((s, b) => s + Number(b.bal), 0);
    const pricing = await new AlcoService(this.pool, 'bank').pricing().catch(() => null);
    const kind = (c: string) => SHARES.find(([re]) => re.test(c))!;
    const runKey = (c: string): keyof typeof RATE_RUN_PER_100 => (/certif|\bcd/i.test(c) ? 'certificates' : /money market/i.test(c) ? 'moneyMarket' : /check|demand/i.test(c) ? 'checking' : 'savings');
    const mix = book.map((b) => {
      const balance = Number(b.bal);
      const k = kind(b.c);
      const behaviour = k[2];
      const measured = pricing?.products.find((p) => p.category === b.c)?.beta ?? null;
      return {
        product: b.c,
        accounts: Number(b.n),
        balance,
        sharePct: total ? (balance / total) * 100 : 0,
        ratePct: balance ? Number(b.rw) / balance : 0,
        noInterest: Number(b.zero),
        dueIn12: Number(b.due),
        /** Measured on the last rate move (cuts since 2025). */
        betaMeasured: measured,
        /** The rate-risk model's beta for a move up; certificates reprice in full at maturity. */
        betaRising: behaviour === 'term' ? 1 : behaviour.beta,
        decay: behaviour === 'term' ? CD_ATTRITION : behaviour.decay,
        term: behaviour === 'term',
        runPer100: RATE_RUN_PER_100[runKey(b.c)],
      };
    });
    const costNowPct = total ? book.reduce((s, b) => s + Number(b.rw), 0) / total : 0;
    const noInterest = mix.reduce((s, x) => s + x.noInterest, 0);

    // Largest depositors: the 20 customers with the most on deposit.
    const [top] = await rows<{ t: number; n: number }>(this.pool, 'SELECT SUM(t) AS t, COUNT(*) AS n FROM (SELECT SUM(balance) AS t FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY party_id ORDER BY t DESC LIMIT 20) x');
    const top20 = Number(top?.t ?? 0);

    // Rising rates over the next 12 months: added interest and deposits that leave.
    const loss = await this.analysis().catch(() => null);
    const lossFree = loss?.lossFreeTotal ?? 0;
    const scenario = (bp: number) => {
      const s = bp / 100;
      const lines = mix.map((x) => {
        // Certificates reprice as they mature, on average half way through the year; the rest follow with a lag.
        const added = x.term ? x.dueIn12 * (bp / 10_000) * 0.5 : x.balance * x.betaRising * (bp / 10_000) * NMD_LAG;
        const base = x.term ? x.dueIn12 * x.decay : x.balance * x.decay;
        const rate = (x.term ? x.dueIn12 : x.balance) * x.runPer100 * s;
        return { product: x.product, added, base, rate, leaves: base + rate };
      });
      const uninsuredExtra = now.uninsured * RATE_RUN_PER_100.uninsured * s;
      const leaves = lines.reduce((a, l) => a + l.leaves, 0) + uninsuredExtra;
      const rateDriven = lines.reduce((a, l) => a + l.rate, 0) + uninsuredExtra;
      const added = lines.reduce((a, l) => a + l.added, 0);
      const remaining = Math.max(1, total - leaves);
      return {
        bp,
        leaves,
        leavesPct: total ? (leaves / total) * 100 : 0,
        rateDriven,
        uninsuredLeaves: uninsuredExtra,
        added,
        costAfterPct: costNowPct + (added / remaining) * 100,
        covered: leaves <= lossFree,
        lossFree,
        lines,
      };
    };
    return {
      asOf: now.end,
      deposits: now.deposits,
      uninsured: now.uninsured,
      uninsuredPct: now.pct,
      uninsuredYearAgo: uninsuredTrend.length >= 5 ? uninsuredTrend[0]! : null,
      uninsuredTrend,
      levels: UNINSURED_LEVELS,
      brokered,
      mix,
      bookTotal: total,
      costNowPct,
      noInterest,
      noInterestPct: total ? (noInterest / total) * 100 : 0,
      top20,
      top20Pct: total ? (top20 / total) * 100 : 0,
      measuredBeta: pricing?.total.repricingBeta ?? null,
      marketMoveBp: pricing?.marketMoveBp ?? null,
      scenarios: RATE_SHOCKS.map(scenario),
      base: scenario(0),
    };
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
      ['Deposits if rates rise', `Usual yearly decay from the rate-risk model (checking 10%, savings 12%, money market 25%; ${CD_ATTRITION * 100}% of maturing certificates don’t renew), plus for every 100 bp: checking ${RATE_RUN_PER_100.checking * 100}%, savings ${RATE_RUN_PER_100.savings * 100}%, money market ${RATE_RUN_PER_100.moneyMarket * 100}%, maturing certificates ${RATE_RUN_PER_100.certificates * 100}%, and ${RATE_RUN_PER_100.uninsured * 100}% more of uninsured deposits, which chase yield first. Rates paid follow the model’s rising-rate betas (checking 0.05, savings 0.20, money market 0.55) at three quarters within the year; certificates reprice in full as they mature, on average half way through it.`],
      ['Uninsured deposits', `RC-O’s estimate (RCON5597). DI watches above ${UNINSURED_LEVELS.watch}% of deposits and treats ${UNINSURED_LEVELS.concern}% or more as a concern; SVB’s was about 90%.`],
      ['Loan-to-deposit', `Total loans (RC-C RCON2122) over deposits (RC RCON2200) at quarter end. A bank’s band is ${LTD_BAND.low}% to ${LTD_BAND.high}%: below, deposits sit idle in cash and securities; above, loans are funded with wholesale borrowing. Wholesale funding is other borrowed money (RCON3190, mostly FHLB advances) plus brokered deposits (RC-E RCON2365); core deposits exclude brokered. Costs are year-to-date interest annualized over quarter-end balances.`],
    ];
  }
}
