// CECL for a bank CFO: the provision for credit losses and the allowance it builds, from the FFIEC Call
// Report, and DI's own estimate of the allowance from the loan book, to set against the one the bank
// booked. A bank books its allowance from its own CECL model (often a vendor's), which its auditors
// review; DI's estimate is a second, independent figure the CFO can challenge it with.
//
// DI's estimate is the remaining-life (WARM) loss-rate method common at community banks:
// - each open loan's annual loss rate is its loan type's long-run rate, raised or lowered for its credit
//   band (score or risk rating) and raised for loans 60 or more days past due;
// - for a two-year reasonable and supportable period the rate follows the CFO's weighted economic
//   forecast, using the stress test's baseline, adverse and severely adverse scenarios; it then reverts
//   to the long-run rate over a year, straight line;
// - losses accrue on the balance expected to be outstanding as the loan pays down over its remaining
//   life;
// - the CFO's qualitative adjustments (Q-factors), in basis points of each loan type's balance, go on top.
// The scenario weights and Q-factors are the CFO's: they live in fin_cecl and each change is approved.
import type { Pool } from '@dinext/tenant-db';
import { BAND_FACTOR, LIFE_YEARS, bandName } from './profitability.ts';
import { SCENARIOS, type ScenarioKey } from './stress.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const TAX = 0.21;
/** The reasonable and supportable forecast period, then the straight-line reversion, in years. */
export const CECL_FORECAST_YEARS = 2;
export const CECL_REVERSION_YEARS = 1;
/** The stress scenarios' loss rates are cumulative over nine quarters; a year is 4/9 of that. */
const NINE_QUARTERS_IN_YEARS = 2.25;
/** Long-run annual loss rates over a full credit cycle (2008 on), percent: higher than a benign year's. */
export const CECL_LOSS_RATE: Record<string, number> = { Mortgage: 0.08, HELOC: 0.2, Auto: 0.6, Personal: 2.4, 'Credit Card': 3.3, Consumer: 2.1, Business: 0.6, 'Commercial Real Estate': 0.35, 'Commercial & Industrial': 0.65 };
/** How much more a loan 60 or more days past due loses than its band's rate. */
const PAST_DUE_FACTOR = 4;
/** DI's read of the booked allowance against its estimate, as a share of the estimate. */
export const CECL_LIGHT = 97;
export const CECL_SHORT = 90;
export const CECL_HEAVY = 115;
const CODES = ['RCON3123', 'RCON2122', 'RCON1403', 'RCON1407', 'RIAD4635', 'RIAD4605', 'RIADJJ33', 'RIADJH88', 'RIADB522', 'RIAD4340', 'RCON8274', 'RCONA224'];

export type CeclWeights = Record<ScenarioKey, number>;
export interface CeclSettings {
  weights: CeclWeights;
  qFactors: Record<string, number>;
  notes: Record<string, string>;
  by: string | null;
}

/** The default weights when the CFO hasn't set any. */
export const CECL_DEFAULT_WEIGHTS: CeclWeights = { baseline: 75, adverse: 20, severe: 5 };

export interface CeclPool {
  category: string;
  balance: number;
  loans: number;
  /** Long-run annual loss rate, percent. */
  histPct: number;
  /** The weighted forecast's annual loss rate over the forecast period, percent. */
  forecastPct: number;
  life: number;
  quantitative: number;
  qBp: number;
  qualitative: number;
  estimate: number;
  coveragePct: number;
  /** Balance in the weakest bands (substandard or subprime) and 60+ days past due. */
  weak: number;
  pastDue60: number;
}

export class CeclService {
  constructor(private readonly pool: Pool) {}

  async settings(): Promise<CeclSettings> {
    const list = await rows<{ setting: string; value: number; note: string | null; updated_by: string | null }>(this.pool, 'SELECT setting, value, note, updated_by FROM fin_cecl').catch(() => []);
    const weights = { ...CECL_DEFAULT_WEIGHTS };
    const qFactors: Record<string, number> = {};
    const notes: Record<string, string> = {};
    let by: string | null = null;
    for (const r of list) {
      if (r.setting.startsWith('weight:')) weights[r.setting.slice(7) as ScenarioKey] = Number(r.value);
      else if (r.setting.startsWith('q:')) qFactors[r.setting.slice(2)] = Number(r.value);
      if (r.note) notes[r.setting] = r.note;
      by = r.updated_by ?? by;
    }
    return { weights, qFactors, notes, by };
  }

  /** Saves new weights or a loan type's Q-factor. Called once the change is approved. */
  async record(change: { weights?: CeclWeights; qFactor?: { category: string; bp: number; note?: string } }, meta: { approvalId: string; by: string }) {
    const put = (setting: string, value: number, note: string | null) =>
      this.pool.query('INSERT INTO fin_cecl (setting, value, note, updated_by, approval_id) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), note = COALESCE(VALUES(note), note), updated_by = VALUES(updated_by), approval_id = VALUES(approval_id)', [setting, value, note, meta.by, meta.approvalId]);
    if (change.weights) for (const k of ['baseline', 'adverse', 'severe'] as const) await put(`weight:${k}`, change.weights[k], null);
    if (change.qFactor) await put(`q:${change.qFactor.category}`, change.qFactor.bp, change.qFactor.note ?? null);
  }

  private async loans() {
    return rows<{ category: string; balance: number; score: number | null; rating: number | null; dpd: number }>(this.pool, 'SELECT loan_category AS category, balance, credit_score AS score, risk_rating AS rating, days_delinquent AS dpd FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL AND balance > 0');
  }

  /** The annual loss rate a scenario mix gives a loan type over the forecast period, percent. */
  static forecastRate(category: string, weights: CeclWeights) {
    const total = weights.baseline + weights.adverse + weights.severe || 100;
    return SCENARIOS.reduce((s, sc) => s + ((weights[sc.key] / total) * (sc.lossPct[category] ?? (CECL_LOSS_RATE[category] ?? 0.5) * NINE_QUARTERS_IN_YEARS)) / NINE_QUARTERS_IN_YEARS, 0);
  }

  /** Lifetime loss per dollar for a loan with these rates and life: rates follow the forecast, revert, then hold; the balance pays down straight line. */
  static lifetime(histPct: number, forecastPct: number, life: number) {
    // Year by year, the rate on the balance outstanding at the start of the year (the WARM convention).
    let loss = 0;
    for (let t = 0; t < life; t += 1) {
      const mid = t + 0.5;
      const rate = mid < CECL_FORECAST_YEARS ? forecastPct : mid < CECL_FORECAST_YEARS + CECL_REVERSION_YEARS ? (forecastPct + histPct) / 2 : histPct;
      loss += (rate / 100) * (1 - t / life) * Math.min(1, life - t);
    }
    return loss;
  }

  /** DI's estimate by loan type under a set of weights (the CFO's, unless others are given). */
  async estimate(weights?: CeclWeights, settings?: CeclSettings) {
    const s = settings ?? (await this.settings());
    const w = weights ?? s.weights;
    const pools = new Map<string, CeclPool>();
    const factor = new Map<string, number>();
    for (const l of await this.loans()) {
      const c = l.category;
      const bal = Number(l.balance);
      const score = l.score === null ? null : Number(l.score);
      const rating = l.rating === null ? null : Number(l.rating);
      const hist = CECL_LOSS_RATE[c] ?? 0.5;
      const life = LIFE_YEARS[c] ?? 2.5;
      if (!factor.has(c)) factor.set(c, CeclService.lifetime(hist, CeclService.forecastRate(c, w), life) / (hist / 100));
      const p = pools.get(c) ?? { category: c, balance: 0, loans: 0, histPct: hist, forecastPct: CeclService.forecastRate(c, w), life, quantitative: 0, qBp: s.qFactors[c] ?? 0, qualitative: 0, estimate: 0, coveragePct: 0, weak: 0, pastDue60: 0 };
      const band = BAND_FACTOR(score, rating);
      const pastDue = Number(l.dpd) >= 60;
      // The loan's own annual rate is its type's, scaled by band and past due; the forecast moves it in proportion.
      p.quantitative += bal * (hist / 100) * band * (pastDue ? PAST_DUE_FACTOR : 1) * factor.get(c)!;
      p.balance += bal;
      p.loans += 1;
      const name = bandName(score, rating);
      if (/Substandard|Subprime/.test(name)) p.weak += bal;
      if (pastDue) p.pastDue60 += bal;
      pools.set(c, p);
    }
    const list = [...pools.values()]
      .map((p) => {
        p.qualitative = (p.balance * p.qBp) / 10_000;
        p.estimate = p.quantitative + p.qualitative;
        p.coveragePct = p.balance ? (p.estimate / p.balance) * 100 : 0;
        return p;
      })
      .sort((a, b) => b.estimate - a.estimate);
    const balance = list.reduce((x, p) => x + p.balance, 0);
    const quantitative = list.reduce((x, p) => x + p.quantitative, 0);
    const qualitative = list.reduce((x, p) => x + p.qualitative, 0);
    return { pools: list, balance, quantitative, qualitative, total: quantitative + qualitative, coveragePct: balance ? ((quantitative + qualitative) / balance) * 100 : 0, weights: w };
  }

  /** The booked allowance, the provision and the estimate, with what drove the provision and what a forecast change would do. */
  async analysis() {
    const list = await rows<{ code: string; amount: number | null; q: unknown }>(this.pool, `SELECT code, amount, quarter_end AS q FROM cr_value WHERE code IN (${CODES.map(() => '?').join(', ')}) ORDER BY quarter_end`, CODES).catch(() => []);
    if (!list.length) return null;
    const byQ = new Map<string, Map<string, number>>();
    for (const r of list) {
      const end = day(r.q);
      if (!byQ.has(end)) byQ.set(end, new Map());
      byQ.get(end)!.set(r.code, Number(r.amount ?? 0));
    }
    const base = [...byQ.entries()].map(([end, v]) => {
      const g = (c: string) => v.get(c) ?? 0;
      return { end, months: Number(end.slice(5, 7)), allowance: g('RCON3123'), loans: g('RCON2122'), nonaccrual: g('RCON1403'), pastDue90: g('RCON1407'), chargeOffsYtd: g('RIAD4635'), recoveriesYtd: g('RIAD4605'), provisionYtd: g('RIADJJ33') || g('RIADJH88'), startOfYear: g('RIADB522'), niYtd: g('RIAD4340'), tier1: g('RCON8274'), leverageAssets: g('RCONA224') };
    });
    // A quarter's own flows are its year to date less the quarter before's in the same year.
    const own = (i: number, key: 'chargeOffsYtd' | 'recoveriesYtd' | 'provisionYtd' | 'niYtd') => {
      const q = base[i]!;
      if (q.months === 3) return q[key];
      const p = base[i - 1];
      return p && p.end.slice(0, 4) === q.end.slice(0, 4) && p.months === q.months - 3 ? q[key] - p[key] : null;
    };
    const quarters = base.map((q, i) => {
      const prior = base[i - 1] ?? null;
      const chargeOffs = own(i, 'chargeOffsYtd');
      const recoveries = own(i, 'recoveriesYtd');
      const provision = own(i, 'provisionYtd');
      return { ...q, start: prior?.allowance ?? null, chargeOffs, recoveries, provision, netIncome: own(i, 'niYtd'), coveragePct: q.loans ? (q.allowance / q.loans) * 100 : 0 };
    });
    const now = quarters.at(-1)!;
    const prior = quarters.at(-2) ?? null;
    const yearEnd = quarters.find((q) => q.end === `${Number(now.end.slice(0, 4)) - 1}-12-31`) ?? null;

    // What drove the provision: replacing what was charged off, reserving for new loans at the old
    // coverage, and the change in coverage on the whole book (credit quality, the forecast, the model).
    const walk = (from: { allowance: number; loans: number }, netChargeOffs: number, provision: number) => {
      const oldCoverage = from.loans ? from.allowance / from.loans : 0;
      const growth = (now.loans - from.loans) * oldCoverage;
      const coverage = now.loans * (now.allowance / now.loans - oldCoverage);
      return { start: from.allowance, netChargeOffs, growth, coverage, provision, end: now.allowance, other: provision - netChargeOffs - growth - coverage };
    };
    const quarterWalk = prior && now.chargeOffs !== null && now.recoveries !== null && now.provision !== null ? walk(prior, now.chargeOffs - now.recoveries, now.provision) : null;
    const ytdStart = yearEnd ?? { allowance: now.startOfYear, loans: now.loans };
    const ytdWalk = walk(ytdStart, now.chargeOffsYtd - now.recoveriesYtd, now.provisionYtd);

    const settings = await this.settings();
    const est = await this.estimate(undefined, settings);
    const gap = est.total - now.allowance;
    const bookedPct = est.total ? (now.allowance / est.total) * 100 : null;
    const read = bookedPct === null ? null : bookedPct < CECL_SHORT ? 'short' : bookedPct < CECL_LIGHT ? 'light' : bookedPct > CECL_HEAVY ? 'heavy' : 'about right';

    // Shares, for what the provision and a forecast change do per share.
    const [reg] = await rows<{ shares_outstanding: number; weighted_shares: number }>(this.pool, 'SELECT shares_outstanding, weighted_shares FROM fin_share WHERE quarter_end = ?', [now.end]).catch(() => []);
    const shares = reg ? Number(reg.shares_outstanding) : null;
    const weighted = reg ? Number(reg.weighted_shares) : null;
    const perShare = (n: number, s: number | null) => (s ? n / s : null);
    const leveragePct = now.leverageAssets ? (now.tier1 / now.leverageAssets) * 100 : null;
    const impact = (extra: number) => {
      const afterTax = extra * (1 - TAX);
      return { provision: extra, afterTax, eps: perShare(afterTax, weighted), tbvps: perShare(afterTax, shares), leveragePct: now.leverageAssets ? ((now.tier1 - afterTax) / (now.leverageAssets - afterTax)) * 100 : null };
    };
    const mixes: { key: string; label: string; weights: CeclWeights }[] = [
      { key: 'current', label: `Your weights (${settings.weights.baseline}% baseline, ${settings.weights.adverse}% adverse, ${settings.weights.severe}% severe)`, weights: settings.weights },
      { key: 'baseline', label: 'All baseline', weights: { baseline: 100, adverse: 0, severe: 0 } },
      { key: 'adverse', label: 'All adverse', weights: { baseline: 0, adverse: 100, severe: 0 } },
      { key: 'severe', label: 'All severely adverse', weights: { baseline: 0, adverse: 0, severe: 100 } },
    ];
    const scenarios = [];
    for (const m of mixes) {
      const e = m.key === 'current' ? est : await this.estimate(m.weights, settings);
      scenarios.push({ ...m, estimate: e.total, coveragePct: e.coveragePct, ...impact(e.total - now.allowance) });
    }

    const [bench] = (await this.pool.query("SELECT kind, metric, value FROM fin_benchmark WHERE metric IN ('provision_to_average_loans', 'allowance_to_loans')").catch(() => [[]])) as [{ kind: string; metric: string; value: number }[]];
    const ref = (kind: string, metric: string) => {
      const b = bench.find((x) => x.kind === kind && x.metric === metric);
      return b ? Number(b.value) : null;
    };
    const averageLoans = (now.loans + (yearEnd?.loans ?? now.loans)) / 2;
    const provisionRatio = averageLoans ? ((now.provisionYtd * 12) / now.months / averageLoans) * 100 : null;
    return {
      asOf: now.end,
      now,
      prior,
      quarters,
      quarterWalk,
      ytdWalk,
      estimate: est,
      settings,
      gap,
      bookedPct,
      read,
      scenarios,
      provisionRatio,
      provisionEpsQuarter: now.provision !== null ? perShare(now.provision * (1 - TAX), weighted) : null,
      provisionEpsYtd: perShare(now.provisionYtd * (1 - TAX), weighted),
      shares,
      leveragePct,
      plan: { provisionRatio: ref('plan', 'provision_to_average_loans'), coverage: ref('plan', 'allowance_to_loans') },
      peer: { provisionRatio: ref('peer', 'provision_to_average_loans'), coverage: ref('peer', 'allowance_to_loans') },
    };
  }

  assumptions(): [string, string][] {
    const life = Object.entries(LIFE_YEARS).filter(([k]) => ['Mortgage', 'Commercial Real Estate', 'Commercial & Industrial', 'Auto', 'Consumer'].includes(k)).map(([k, v]) => `${k.toLowerCase().replace('commercial & industrial', 'C&I').replace('commercial real estate', 'CRE')} ${v} years`).join(', ');
    return [
      ['Booked figures', 'From the FFIEC 051 Call Report: the allowance for credit losses on loans (RC RCON3123), the provision (RI RIADJJ33) and charge-offs and recoveries (RI-B RIAD4635, RIAD4605), which are year to date. A quarter’s own figure is its year to date less the quarter before’s.'],
      ['Method', 'The remaining-life (WARM) loss-rate method, by loan type: each loan’s annual loss rate, year by year over its remaining life, on the balance expected to be outstanding at the start of each year as it pays down. The bank’s own CECL model, and its auditors’ review of it, is what the books follow; DI’s estimate is a second figure to challenge it with.'],
      ['Loss rates', `DI’s long-run rates for a community lender over a full credit cycle (2008 on), a year: ${Object.entries(CECL_LOSS_RATE).filter(([k]) => ['Mortgage', 'Commercial Real Estate', 'Commercial & Industrial', 'Auto', 'Consumer'].includes(k)).map(([k, v]) => `${k} ${v}%`).join(', ')}. Weaker credit bands lose more (substandard loans six times the pass rate, subprime borrowers over four times), and loans 60 or more days past due ${PAST_DUE_FACTOR} times their band’s rate. The bank’s own loss history replaces these once it is loaded.`],
      ['Remaining life', `${life}, including prepayments. The balance runs off straight line over it; the year after the forecast period takes the average of the forecast and long-run rates.`],
      ['Economic forecast', `For ${CECL_FORECAST_YEARS} years (the reasonable and supportable period), loss rates follow the CFO’s weighted mix of the stress test’s baseline, adverse and severely adverse scenarios, then revert to the long-run rate over ${CECL_REVERSION_YEARS} year. The weights are the CFO’s and each change is approved.`],
      ['Qualitative adjustments', 'Q-factors, in basis points of a loan type’s balance, for what the loss rates and forecast don’t capture: concentrations, underwriting changes, collateral values. They are the CFO’s and each change is approved.'],
      ['What DI reads', `The booked allowance as a share of DI’s estimate: under ${CECL_SHORT}% is short, under ${CECL_LIGHT}% light, over ${CECL_HEAVY}% heavy (earnings held back), and in between about right.`],
      ['Not covered', 'The reserve for unfunded commitments (lines of credit and loans not yet drawn) and the allowance on held-to-maturity securities; loans evaluated one by one, such as a collateral-dependent commercial loan, are pooled at the substandard rate here.'],
    ];
  }
}
