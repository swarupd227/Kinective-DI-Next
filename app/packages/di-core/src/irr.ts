// Interest rate risk (ALM): the repricing gap, net interest income at risk over the next 12 months
// and net economic value (NEV) under parallel rate shocks, the measures NCUA examiners and the ALCO
// review. It is computed from the institution's own loans, shares and certificates (balances, rates,
// ages and maturity dates), with the investments, cash and borrowings from the latest 5300 when there
// is one. Behaviour that the data can't show (prepayment speeds, deposit decay and betas, the market
// rate) is stated as assumptions, as an ALM model does. It is DI's estimate, not the model of record.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

export const SHOCKS_BP = [-300, -200, -100, 0, 100, 200, 300, 400];
const BUCKETS: [string, number, number][] = [['0–3 months', 0, 3], ['3–12 months', 3, 12], ['1–3 years', 12, 36], ['3–5 years', 36, 60], ['5–10 years', 60, 120], ['Over 10 years', 120, 1000]];
const HORIZON = 360;
/** The rate new money earns or costs at the margin: the curve DI shocks in parallel. */
const MARKET_RATE = 0.0425;

/** Board policy limits for the demo institution; an ALCO sets its own. */
export const IRR_LIMITS = { niiDeclinePct: 20, nevDeclinePct: 30, nevRatioMinPct: 6 };

interface LoanBehaviour {
  /** Contractual term in months. */
  term: number;
  /** Variable-rate products reprice every month; fixed ones as principal comes back. */
  variable: boolean;
  /** Annual prepayment speed at today's rates (CPR). */
  cpr: number;
}
const LOANS: [RegExp, string, LoanBehaviour][] = [
  [/credit card/i, 'Credit cards', { term: 36, variable: true, cpr: 0 }],
  [/heloc|home equity/i, 'Home equity lines', { term: 180, variable: true, cpr: 0.1 }],
  [/mortgage|1st|first|residential/i, 'First mortgages', { term: 360, variable: false, cpr: 0.08 }],
  [/auto|vehicle/i, 'Auto loans', { term: 66, variable: false, cpr: 0.18 }],
  [/commercial real estate|cre\b/i, 'Commercial real estate', { term: 240, variable: false, cpr: 0.05 }],
  [/business|commercial|c&i|industrial/i, 'Commercial loans', { term: 84, variable: false, cpr: 0.06 }],
  [/personal|consumer|unsecured/i, 'Consumer loans', { term: 48, variable: false, cpr: 0.12 }],
];
interface ShareBehaviour {
  /** Share of the balance that leaves each year (non-maturity deposits). */
  decay: number;
  /** How much of a market rate move the product's rate follows. */
  beta: number;
}
const SHARES: [RegExp, string, ShareBehaviour | 'term'][] = [
  [/certif|\bcd/i, 'Certificates', 'term'],
  [/money market/i, 'Money market', { decay: 0.25, beta: 0.55 }],
  [/ira|retire/i, 'IRAs', { decay: 0.08, beta: 0.4 }],
  [/check|draft|demand/i, 'Checking', { decay: 0.1, beta: 0.05 }],
  [/./, 'Savings', { decay: 0.12, beta: 0.2 }],
];

export interface Position {
  name: string;
  side: 'asset' | 'liability';
  balance: number;
  rate: number;
  /** Monthly principal returned (or run off) at a given shock, months 1..HORIZON. */
  flows: (shockBp: number) => number[];
  /** The fraction that has repriced by month m (1..12), for the income horizon. */
  repriced: (m: number) => number;
  /** How much of a shock reaches this position's rate when it reprices. */
  beta: number;
  /** The rate its cash flows are discounted at, before the shock. */
  discount: number;
  /** Its rate floats with the market (variable loans, cash, non-maturity shares); fixed ones keep their coupon. */
  floating: boolean;
}

/** Amortizing cash flows with prepayment that speeds up when rates fall and slows when they rise. */
function amortizing(balance: number, remaining: number, cpr: number, shockBp: number) {
  const speed = Math.min(2, Math.max(0.5, 1 - (shockBp / 100) * 0.12));
  const smm = 1 - Math.pow(1 - Math.min(0.6, cpr * speed), 1 / 12);
  const flows = new Array<number>(HORIZON).fill(0);
  let left = balance;
  for (let m = 0; m < HORIZON && left > 0.5; m++) {
    const scheduled = left / Math.max(1, remaining - m);
    const prepay = (left - scheduled) * smm;
    const paid = Math.min(left, scheduled + prepay);
    flows[m] = paid;
    left -= paid;
  }
  return flows;
}

export class IrrService {
  constructor(private readonly pool: Pool) {}

  /** The rate-sensitive balance sheet: every position with its cash flows, as the IRR and liquidity views use it. */
  async positions() {
    const [build] = await rows<{ as_of: unknown }>(this.pool, 'SELECT MAX(as_of_date) AS as_of FROM meta_build');
    const asOf = String(build?.as_of instanceof Date ? build.as_of.toISOString() : build?.as_of ?? '2026-10-25').slice(0, 10);
    const out: Position[] = [];

    // Loans by product: balance-weighted rate and remaining term from each loan's age.
    const loans = await rows<{ c: string; b: number; r: number; age: number }>(this.pool, `SELECT loan_category AS c, SUM(balance) AS b, SUM(balance * rate) / NULLIF(SUM(balance), 0) AS r, SUM(balance * TIMESTAMPDIFF(MONTH, open_date, ?)) / NULLIF(SUM(balance), 0) AS age FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL GROUP BY loan_category`, [asOf]);
    for (const l of loans) {
      const [, name, k] = LOANS.find(([re]) => re.test(l.c)) ?? [null, l.c, { term: 60, variable: false, cpr: 0.1 }];
      const balance = Number(l.b);
      const rate = Number(l.r) / 100;
      const remaining = Math.max(6, k.term - Number(l.age));
      const base = amortizing(balance, remaining, k.cpr, 0);
      out.push({
        name: `${name}`,
        side: 'asset',
        balance,
        rate,
        flows: (s) => amortizing(balance, remaining, k.cpr, s),
        repriced: (m) => (k.variable ? 1 : base.slice(0, m).reduce((a, b) => a + b, 0) / balance),
        beta: 1,
        discount: rate,
        floating: k.variable,
      });
    }

    // Investments, cash and borrowings from the latest 5300 when there is one; otherwise from the balance sheet's shape.
    const cr = await rows<{ code: string; amount: number }>(this.pool, `SELECT code, amount FROM cr_value WHERE quarter_end = (SELECT MAX(quarter_end) FROM cr_value) AND code IN ('AS0009','AS0067','AS0073','AS0055','NV0153','NV0154','NV0155','NV0156','NV0157','860C','997','010','AS0007')`).catch(() => []);
    const v = (code: string) => Number(cr.find((x) => x.code === code)?.amount ?? 0);
    const shares = await rows<{ c: string; b: number; r: number }>(this.pool, 'SELECT deposit_category AS c, SUM(balance) AS b, SUM(balance * rate) / NULLIF(SUM(balance), 0) AS r FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY deposit_category');
    const totalShares = shares.reduce((s, x) => s + Number(x.b), 0);
    const fromCallReport = cr.length > 0;
    const cash = fromCallReport ? v('AS0009') - v('AS0007') : totalShares * 0.06;
    const investments = fromCallReport ? v('NV0153') + v('NV0154') + v('NV0155') + v('NV0156') + v('NV0157') : totalShares * 0.24;
    const ladder = fromCallReport ? [v('NV0153'), v('NV0154'), v('NV0155'), v('NV0156'), v('NV0157')] : [0.21, 0.33, 0.26, 0.15, 0.05].map((f) => investments * f);
    const borrowings = fromCallReport ? v('860C') : totalShares * 0.015;
    out.push({ name: 'Cash and overnight funds', side: 'asset', balance: cash, rate: MARKET_RATE, flows: () => [cash, ...new Array<number>(HORIZON - 1).fill(0)], repriced: () => 1, beta: 1, discount: MARKET_RATE, floating: true });
    // Each maturity band matures evenly across its range; the portfolio yields 3.05%.
    const bands: [number, number][] = [[1, 12], [13, 36], [37, 60], [61, 120], [121, 240]];
    const invFlows = new Array<number>(HORIZON).fill(0);
    ladder.forEach((amt, i) => {
      const [a, b] = bands[i]!;
      for (let m = a; m <= b; m++) invFlows[m - 1]! += amt / (b - a + 1);
    });
    out.push({ name: 'Investments', side: 'asset', balance: investments, rate: 0.0305, flows: () => invFlows, repriced: (m) => invFlows.slice(0, m).reduce((a, b) => a + b, 0) / (investments || 1), beta: 1, discount: 0.0305, floating: false });

    // Shares: certificates reprice as they mature; the rest decay and follow the market by their beta.
    for (const s of shares) {
      const [, name, k] = SHARES.find(([re]) => re.test(s.c))!;
      const balance = Number(s.b);
      const rate = Number(s.r) / 100;
      if (k === 'term') {
        const maturing = await rows<{ m: number; b: number }>(this.pool, 'SELECT GREATEST(1, CEIL(DATEDIFF(maturity_date, ?) / 30.4375)) AS m, SUM(balance) AS b FROM cdm_deposit_account WHERE close_date IS NULL AND deposit_category = ? GROUP BY m', [asOf, s.c]);
        const flows = new Array<number>(HORIZON).fill(0);
        for (const x of maturing) flows[Math.min(HORIZON, Number(x.m)) - 1]! += Number(x.b);
        out.push({ name, side: 'liability', balance, rate, flows: () => flows, repriced: (m) => flows.slice(0, m).reduce((a, b) => a + b, 0) / (balance || 1), beta: 1, discount: MARKET_RATE - 0.0025, floating: false });
      } else {
        const monthly = 1 - Math.pow(1 - k.decay, 1 / 12);
        const flows = new Array<number>(HORIZON).fill(0);
        let left = balance;
        for (let m = 0; m < HORIZON; m++) {
          flows[m] = m === HORIZON - 1 ? left : left * monthly;
          left -= flows[m]!;
        }
        // Non-maturity rates move with a lag: about three quarters of the beta within the year.
        out.push({ name, side: 'liability', balance, rate, flows: () => flows, repriced: () => 0.75, beta: k.beta, discount: MARKET_RATE, floating: true });
      }
    }
    if (borrowings > 0) {
      const flows = new Array<number>(HORIZON).fill(0);
      for (let m = 13; m <= 36; m++) flows[m - 1] = borrowings / 24;
      out.push({ name: 'Borrowings', side: 'liability', balance: borrowings, rate: 0.046, flows: () => flows, repriced: (m) => flows.slice(0, m).reduce((a, b) => a + b, 0) / borrowings, beta: 1, discount: 0.046, floating: false });
    }
    return { asOf, positions: out, netWorth: fromCallReport ? v('997') : null, totalAssets: fromCallReport ? v('010') : null, fromCallReport };
  }

  /** Net interest income over the next 12 months on a static balance sheet, at one shock. */
  private nii(ps: Position[], shockBp: number) {
    const d = shockBp / 10_000;
    const of = (p: Position) => {
      // Average over the 12 months of the share already repriced, so a shock reaches it gradually.
      let repriced = 0;
      for (let m = 1; m <= 12; m++) repriced += p.repriced(m) / 12;
      // Rates can't go below zero; a product's rate is floored there.
      return p.balance * Math.max(0, p.rate + d * p.beta * repriced);
    };
    const income = ps.filter((p) => p.side === 'asset').reduce((s, p) => s + of(p), 0);
    const expense = ps.filter((p) => p.side === 'liability').reduce((s, p) => s + of(p), 0);
    return { income, expense, nii: income - expense, byPosition: ps.map((p) => ({ name: p.name, side: p.side, amount: (p.side === 'asset' ? 1 : -1) * of(p) })) };
  }

  /** Present value of each position's cash flows plus interest, discounted at its rate plus the shock. */
  private nev(ps: Position[], shockBp: number) {
    const d = shockBp / 10_000;
    const pv = (p: Position) => {
      const flows = p.flows(shockBp);
      // A fixed-rate position keeps its coupon while the discount rate moves; that is what changes its value.
      const monthlyRate = Math.max(0, p.rate + (p.floating ? d * p.beta : 0)) / 12;
      const disc = Math.max(0.0005, p.discount + d) / 12;
      let left = p.balance;
      let value = 0;
      for (let m = 0; m < HORIZON; m++) {
        const cash = flows[m]! + left * monthlyRate;
        value += cash / Math.pow(1 + disc, m + 1);
        left -= flows[m]!;
        if (left <= 0.5) break;
      }
      return value;
    };
    const values = ps.map((p) => ({ name: p.name, side: p.side, book: p.balance, value: pv(p) }));
    const assets = values.filter((x) => x.side === 'asset').reduce((s, x) => s + x.value, 0);
    const liabilities = values.filter((x) => x.side === 'liability').reduce((s, x) => s + x.value, 0);
    return { assets, liabilities, nev: assets - liabilities, byPosition: values };
  }

  async analysis() {
    const { asOf, positions, netWorth, totalAssets, fromCallReport } = await this.positions();
    // Non-rate-sensitive assets and equity are carried at book in both NEV and the ratio's denominator.
    const rateAssets = positions.filter((p) => p.side === 'asset').reduce((s, p) => s + p.balance, 0);
    const otherAssets = totalAssets ? Math.max(0, totalAssets - rateAssets) : rateAssets * 0.04;
    const base = { nii: this.nii(positions, 0), nev: this.nev(positions, 0) };
    const scenarios = SHOCKS_BP.map((s) => {
      const n = this.nii(positions, s);
      const e = this.nev(positions, s);
      const nev = e.nev + otherAssets;
      const ratio = (nev / (e.assets + otherAssets)) * 100;
      return {
        shockBp: s,
        nii: n.nii,
        niiChange: n.nii - base.nii.nii,
        niiPct: ((n.nii - base.nii.nii) / base.nii.nii) * 100,
        nev,
        nevChange: nev - (base.nev.nev + otherAssets),
        nevPct: ((nev - (base.nev.nev + otherAssets)) / (base.nev.nev + otherAssets)) * 100,
        nevRatio: ratio,
        withinLimits: ((n.nii - base.nii.nii) / base.nii.nii) * 100 >= -IRR_LIMITS.niiDeclinePct && ((nev - (base.nev.nev + otherAssets)) / (base.nev.nev + otherAssets)) * 100 >= -IRR_LIMITS.nevDeclinePct && ratio >= IRR_LIMITS.nevRatioMinPct,
      };
    });
    // The repricing gap: what reprices or matures in each band, assets against liabilities.
    const gap = BUCKETS.map(([label, from, to]) => {
      // Variable-rate products and cash reprice in the first band; the rest as their cash flows come back.
      const inBand = (p: Position) => (p.repriced(1) === 1 ? (from === 0 ? p.balance : 0) : p.flows(0).slice(from, Math.min(to, HORIZON)).reduce((a, b) => a + b, 0));
      const assets = positions.filter((p) => p.side === 'asset').reduce((s, p) => s + inBand(p), 0);
      const liabilities = positions.filter((p) => p.side === 'liability').reduce((s, p) => s + inBand(p), 0);
      return { label, assets, liabilities, gap: assets - liabilities };
    });
    let running = 0;
    const denominator = totalAssets ?? rateAssets + otherAssets;
    const gapRows = gap.map((g) => {
      running += g.gap;
      return { ...g, cumulative: running, cumulativePct: (running / denominator) * 100 };
    });
    // What drives the change at +300 bp: each position's contribution to NII and to NEV.
    const up = this.nii(positions, 300);
    const upNev = this.nev(positions, 300);
    const drivers = positions.map((p, i) => ({
      name: p.name,
      side: p.side,
      balance: p.balance,
      rate: p.rate * 100,
      niiChange: up.byPosition[i]!.amount - base.nii.byPosition[i]!.amount,
      nevChange: (p.side === 'asset' ? 1 : -1) * (upNev.byPosition[i]!.value - base.nev.byPosition[i]!.value),
    }));
    return {
      asOf,
      fromCallReport,
      netWorth,
      totalAssets: denominator,
      scenarios,
      base: scenarios.find((s) => s.shockBp === 0)!,
      gap: gapRows,
      drivers,
      limits: IRR_LIMITS,
      assumptions: [
        ['Balance sheet', 'Static: maturing balances are replaced like for like at the new rates.'],
        ['Rate shocks', `Instantaneous, parallel shifts of ${SHOCKS_BP.filter((s) => s).map((s) => `${s > 0 ? '+' : ''}${s}`).join(', ')} bp; rates are floored at zero.`],
        ['Market rate', `${(MARKET_RATE * 100).toFixed(2)}% for new money and for discounting deposits and shares.`],
        ['Loan prepayments', 'Auto 18%, consumer 12%, mortgages 8%, commercial 5–6% a year (CPR); 12% faster per 100 bp fall, slower when rates rise.'],
        ['Variable-rate loans', 'Credit cards and home equity lines reprice monthly.'],
        ['Share decay and betas', 'Savings 12% a year, beta 0.20; checking 10%, 0.05; money market 25%, 0.55; IRAs 8%, 0.40. Certificates reprice at maturity.'],
        ['Investments and borrowings', fromCallReport ? 'From the latest 5300: Schedule B’s maturity distribution, yielding 3.05%, and FHLB borrowings over 1–3 years at 4.6%.' : 'Estimated from the balance sheet: a 24% investment ladder at 3.05% and borrowings of 1.5% of deposits.'],
        ['Model of record', 'This is DI’s estimate from core data. The ALM vendor’s model remains the one reported to the board and examiners.'],
      ] as [string, string][],
    };
  }
}
