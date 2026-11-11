// Interest rate risk (ALM): the repricing gap, net interest income at risk over the next 12 months
// and economic value under parallel rate shocks, the measures examiners and the ALCO review. A credit
// union calls economic value net economic value (NEV) and NCUA adds an NEV ratio; a bank calls it the
// economic value of equity (EVE) and sets a limit for each shock, on NII and on EVE. Gradual ramps and
// a second year of NII show what a Fed that moves step by step does to income. It is computed from the institution's own loans, shares and certificates (balances, rates,
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
/** A bank's limits, one for each shock up or down: the most NII and EVE may fall, percent. */
export const IRR_LIMITS_BANK: { niiDeclinePct: Record<number, number>; eveDeclinePct: Record<number, number> } = {
  niiDeclinePct: { 100: 5, 200: 10, 300: 15, 400: 20 },
  eveDeclinePct: { 100: 10, 200: 20, 300: 30, 400: 35 },
};
/** A limit is close when the change has used this much of it. */
export const IRR_WATCH_SHARE = 0.85;
/** The shocks DI also runs as a gradual ramp over 12 months, with NII for two years. */
export const RAMPS_BP = [-200, -100, 100, 200, 300];

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
export interface ShareBehaviour {
  /** Share of the balance that leaves each year (non-maturity deposits). */
  decay: number;
  /** How much of a market rate move the product's rate follows. */
  beta: number;
}
/** Each deposit product's decay and beta in the rate-risk model; certificates reprice at maturity. */
export const SHARES: [RegExp, string, ShareBehaviour | 'term'][] = [
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

/** A position grown or shrunk in proportion: the same rate, terms and behaviour on a larger or smaller balance. */
export const scalePosition = (p: Position, k: number): Position => (k === 1 ? p : { ...p, balance: p.balance * k, flows: (s) => p.flows(s).map((x) => x * k) });

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
    // A bank's FFIEC Call Report: cash (RC 0081, 0071), securities (1754, 1773), borrowings (3190), equity and assets.
    const ff = cr.length ? [] : await rows<{ code: string; amount: number }>(this.pool, `SELECT code, amount FROM cr_value WHERE quarter_end = (SELECT MAX(quarter_end) FROM cr_value) AND code IN ('RCON0081','RCON0071','RCON1754','RCON1773','RCON3190','RCON3210','RCON2170')`).catch(() => []);
    const f = (code: string) => Number(ff.find((x) => x.code === code)?.amount ?? 0);
    const fromFfiec = ff.length > 0;
    const v = (code: string) => Number(cr.find((x) => x.code === code)?.amount ?? 0);
    const shares = await rows<{ c: string; b: number; r: number }>(this.pool, 'SELECT deposit_category AS c, SUM(balance) AS b, SUM(balance * rate) / NULLIF(SUM(balance), 0) AS r FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY deposit_category');
    const totalShares = shares.reduce((s, x) => s + Number(x.b), 0);
    const fromCallReport = cr.length > 0 || fromFfiec;
    const cash = fromFfiec ? f('RCON0081') + f('RCON0071') : cr.length ? v('AS0009') - v('AS0007') : totalShares * 0.06;
    const investments = fromFfiec ? f('RCON1754') + f('RCON1773') : cr.length ? v('NV0153') + v('NV0154') + v('NV0155') + v('NV0156') + v('NV0157') : totalShares * 0.24;
    // The Call Report's RC-B has no maturity distribution in the 051's headline items, so a bank's ladder keeps the usual shape.
    const ladder = cr.length ? [v('NV0153'), v('NV0154'), v('NV0155'), v('NV0156'), v('NV0157')] : [0.21, 0.33, 0.26, 0.15, 0.05].map((x) => investments * x);
    const borrowings = fromFfiec ? f('RCON3190') : cr.length ? v('860C') : totalShares * 0.015;
    // Cash earns about the overnight rate: the latest federal funds rate on file plus 10 bp, else the market rate.
    const [mkt] = await rows<{ ff: number }>(this.pool, 'SELECT fed_funds AS ff FROM mkt_rate_month ORDER BY month_end DESC LIMIT 1').catch(() => []);
    const overnight = mkt ? Number(mkt.ff) / 100 + 0.001 : MARKET_RATE;
    out.push({ name: 'Cash and overnight funds', side: 'asset', balance: cash, rate: overnight, flows: () => [cash, ...new Array<number>(HORIZON - 1).fill(0)], repriced: () => 1, beta: 1, discount: MARKET_RATE, floating: true });
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
        // Non-maturity rates move with a lag: about three quarters of the beta within the year, all of it in the second.
        out.push({ name, side: 'liability', balance, rate, flows: () => flows, repriced: (m) => (m <= 12 ? 0.75 : 1), beta: k.beta, discount: MARKET_RATE, floating: true });
      }
    }
    if (borrowings > 0) {
      const flows = new Array<number>(HORIZON).fill(0);
      for (let m = 13; m <= 36; m++) flows[m - 1] = borrowings / 24;
      out.push({ name: 'Borrowings', side: 'liability', balance: borrowings, rate: 0.046, flows: () => flows, repriced: (m) => flows.slice(0, m).reduce((a, b) => a + b, 0) / borrowings, beta: 1, discount: 0.046, floating: false });
    }
    return { asOf, positions: out, netWorth: fromFfiec ? f('RCON3210') : cr.length ? v('997') : null, totalAssets: fromFfiec ? f('RCON2170') : cr.length ? v('010') : null, fromCallReport, form: fromFfiec ? ('FFIEC 051' as const) : cr.length ? ('5300' as const) : null };
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

  /**
   * Net interest income month by month over two years on a static balance sheet, as a shock reaches each
   * position when it reprices. Instantly, the market is at the shock from month one; as a ramp, it moves
   * a twelfth of the way each month and holds after a year.
   */
  private niiPath(ps: Position[], shockBp: number, ramp: boolean) {
    const year = [0, 0];
    for (let m = 1; m <= 24; m++) {
      const move = (shockBp / 10_000) * (ramp ? Math.min(m, 12) / 12 : 1);
      let net = 0;
      for (const p of ps) net += ((p.side === 'asset' ? 1 : -1) * p.balance * Math.max(0, p.rate + move * p.beta * Math.min(1, p.repriced(m)))) / 12;
      year[m <= 12 ? 0 : 1]! += net;
    }
    return { year1: year[0]!, year2: year[1]! };
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

  /**
   * NII and economic value at a few shocks on a changed balance sheet, for comparing plans. Each
   * percentage is against that balance sheet's own unshocked value, as the analysis measures it, and
   * the limits are the analysis's. With no change it matches the analysis.
   */
  whatIf(loaded: Awaited<ReturnType<IrrService['positions']>>, change: (ps: Position[]) => Position[] = (ps) => ps, shocks: number[] = [200, 300, 400]) {
    const bank = loaded.form === 'FFIEC 051';
    // Non-rate-sensitive assets stay at today's book, as the analysis carries them.
    const rateAssets = loaded.positions.filter((p) => p.side === 'asset').reduce((s, p) => s + p.balance, 0);
    const otherAssets = loaded.totalAssets ? Math.max(0, loaded.totalAssets - rateAssets) : rateAssets * 0.04;
    const ps = change(loaded.positions);
    const n0 = this.nii(ps, 0).nii;
    const e0 = this.nev(ps, 0).nev + otherAssets;
    return {
      ev: e0,
      nii: n0,
      shocks: shocks.map((s) => {
        const ev = this.nev(ps, s).nev + otherAssets;
        const nii = this.nii(ps, s).nii;
        return { shockBp: s, evPct: ((ev - e0) / e0) * 100, niiPct: ((nii - n0) / n0) * 100, evLimitPct: bank ? (IRR_LIMITS_BANK.eveDeclinePct[Math.abs(s)] ?? IRR_LIMITS.nevDeclinePct) : IRR_LIMITS.nevDeclinePct, niiLimitPct: bank ? (IRR_LIMITS_BANK.niiDeclinePct[Math.abs(s)] ?? IRR_LIMITS.niiDeclinePct) : IRR_LIMITS.niiDeclinePct };
      }),
    };
  }

  async analysis() {
    const { asOf, positions, netWorth, totalAssets, fromCallReport, form } = await this.positions();
    const bank = form === 'FFIEC 051';
    const limitsFor = (s: number) => (bank ? { nii: IRR_LIMITS_BANK.niiDeclinePct[Math.abs(s)] ?? IRR_LIMITS.niiDeclinePct, ev: IRR_LIMITS_BANK.eveDeclinePct[Math.abs(s)] ?? IRR_LIMITS.nevDeclinePct } : { nii: IRR_LIMITS.niiDeclinePct, ev: IRR_LIMITS.nevDeclinePct });
    // Non-rate-sensitive assets and equity are carried at book in both NEV and the ratio's denominator.
    const rateAssets = positions.filter((p) => p.side === 'asset').reduce((s, p) => s + p.balance, 0);
    const otherAssets = totalAssets ? Math.max(0, totalAssets - rateAssets) : rateAssets * 0.04;
    const base = { nii: this.nii(positions, 0), nev: this.nev(positions, 0) };
    const perShock = new Map<number, { n: ReturnType<IrrService['nii']>; e: ReturnType<IrrService['nev']> }>();
    const scenarios = SHOCKS_BP.map((s) => {
      const n = this.nii(positions, s);
      const e = this.nev(positions, s);
      perShock.set(s, { n, e });
      const nev = e.nev + otherAssets;
      const ratio = (nev / (e.assets + otherAssets)) * 100;
      const niiPct = ((n.nii - base.nii.nii) / base.nii.nii) * 100;
      const nevPct = ((nev - (base.nev.nev + otherAssets)) / (base.nev.nev + otherAssets)) * 100;
      const lim = limitsFor(s);
      // How much of each limit a fall uses; a bank has no NEV ratio floor.
      const used = Math.max(-niiPct / lim.nii, -nevPct / lim.ev, bank ? 0 : IRR_LIMITS.nevRatioMinPct / ratio);
      return {
        shockBp: s,
        nii: n.nii,
        niiChange: n.nii - base.nii.nii,
        niiPct: ((n.nii - base.nii.nii) / base.nii.nii) * 100,
        nev,
        nevChange: nev - (base.nev.nev + otherAssets),
        nevPct: ((nev - (base.nev.nev + otherAssets)) / (base.nev.nev + otherAssets)) * 100,
        nevRatio: ratio,
        niiLimitPct: lim.nii,
        nevLimitPct: lim.ev,
        withinLimits: s === 0 || used <= 1,
        status: (s === 0 || used < IRR_WATCH_SHARE ? 'Within' : used <= 1 ? 'Watch' : 'Breach') as 'Within' | 'Watch' | 'Breach',
      };
    });
    // Gradual ramps: the market moves a twelfth of the shock each month for a year, with NII for two years.
    const flat = this.niiPath(positions, 0, false);
    const ramps = RAMPS_BP.flatMap((s) => [false, true].map((ramp) => {
      const p = this.niiPath(positions, s, ramp);
      return { shockBp: s, ramp, year1: p.year1, year1Pct: ((p.year1 - flat.year1) / flat.year1) * 100, year2: p.year2, year2Pct: ((p.year2 - flat.year2) / flat.year2) * 100 };
    }));
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
    // What drives the change at each shock: each position's contribution to NII and to economic value.
    const driversAt = (s: number) => {
      const { n: up, e: upNev } = perShock.get(s) ?? perShock.get(300)!;
      return positions.map((p, i) => ({
        name: p.name,
        side: p.side,
        balance: p.balance,
        rate: p.rate * 100,
        niiChange: up.byPosition[i]!.amount - base.nii.byPosition[i]!.amount,
        nevChange: (p.side === 'asset' ? 1 : -1) * (upNev.byPosition[i]!.value - base.nev.byPosition[i]!.value),
      }));
    };
    const drivers = driversAt(300);
    const driversByShock = Object.fromEntries(SHOCKS_BP.filter((s) => s).map((s) => [s, driversAt(s)])) as Record<number, ReturnType<typeof driversAt>>;
    return {
      asOf,
      bank,
      /** What economic value is called: EVE for a bank, NEV for a credit union. */
      ev: bank ? ('EVE' as const) : ('NEV' as const),
      fromCallReport,
      netWorth,
      ramps,
      niiFlat: flat,
      totalAssets: denominator,
      scenarios,
      base: scenarios.find((s) => s.shockBp === 0)!,
      gap: gapRows,
      drivers,
      driversByShock,
      limits: IRR_LIMITS,
      bankLimits: bank ? IRR_LIMITS_BANK : null,
      assumptions: [
        ['Balance sheet', 'Static: maturing balances are replaced like for like at the new rates.'],
        ['Rate shocks', `Instantaneous, parallel shifts of ${SHOCKS_BP.filter((s) => s).map((s) => `${s > 0 ? '+' : ''}${s}`).join(', ')} bp; rates are floored at zero.`],
        ['Rate ramps', `Gradual, parallel moves of ${RAMPS_BP.map((s) => `${s > 0 ? '+' : ''}${s}`).join(', ')} bp, a twelfth each month over 12 months, then held; net interest income for the first and second year on the same static balance sheet. The second year shows the full effect once more of the book has repriced.`],
        ['Yield curve', 'Every move is parallel. Steeper or flatter curves (short and long rates moving apart) aren’t modeled.'],
        ['Market rate', `${(MARKET_RATE * 100).toFixed(2)}% for new money and for discounting ${bank ? 'deposits' : 'deposits and shares'}.`],
        ['Loan prepayments', 'Auto 18%, consumer 12%, mortgages 8%, commercial 5–6% a year (CPR); 12% faster per 100 bp fall, slower when rates rise.'],
        ['Variable-rate loans', 'Credit cards and home equity lines reprice monthly.'],
        [bank ? 'Deposit decay and betas' : 'Share decay and betas', `Savings 12% a year, beta 0.20; checking 10%, 0.05; money market 25%, 0.55; IRAs 8%, 0.40, reaching three quarters of the beta in the first year and all of it in the second. ${bank ? 'Time deposits' : 'Certificates'} reprice at maturity.`],
        ['Investments and borrowings', form === 'FFIEC 051' ? 'From the latest Call Report: securities (RC-B, held to maturity and available for sale) on a typical ladder, yielding 3.05%, and FHLB advances (RCON3190) over 1–3 years at 4.6%.' : fromCallReport ? 'From the latest 5300: Schedule B’s maturity distribution, yielding 3.05%, and FHLB borrowings over 1–3 years at 4.6%.' : 'Estimated from the balance sheet: a 24% investment ladder at 3.05% and borrowings of 1.5% of deposits.'],
        ...(bank ? [['Limits', `The board’s limits for each shock, up or down: NII no worse than ${Object.entries(IRR_LIMITS_BANK.niiDeclinePct).map(([s, v]) => `−${v}% at ${s} bp`).join(', ')}; EVE no worse than ${Object.entries(IRR_LIMITS_BANK.eveDeclinePct).map(([s, v]) => `−${v}% at ${s} bp`).join(', ')}. A change using ${IRR_WATCH_SHARE * 100}% of a limit is watched.`] as [string, string]] : []),
        ['Model of record', 'This is DI’s estimate from core data. The ALM vendor’s model remains the one reported to the board and examiners.'],
      ] as [string, string][],
    };
  }
}
