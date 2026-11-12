// The survival model: how long members stay, and what makes them stay longer. Two parts.
// - Retention curves (Kaplan–Meier, period method): of members who join, the share still here after
//   each month of membership, from what members of every tenure actually did over the months DI holds
//   exits for. A member who joined years ago counts from where they were when the window opened, so the
//   curve uses the last year and a half's experience at every tenure, as an actuary's period table does.
// - A Cox proportional-hazards model with tenure as the time scale, learned from the monthly snapshots:
//   how much each thing about a member raises or lowers the rate of leaving at any tenure (a hazard
//   ratio), checked on the months it never saw. From it and the baseline (Breslow) hazard by tenure come
//   each member's chance of leaving in the next 12 months and how long half of members like them stay,
//   assuming they stay as they are now.
// The attrition model answers who is about to leave; this answers how long relationships last and why.
import type { Pool } from '@dinext/tenant-db';
import { auc } from './gbm.ts';
import { CoreError } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const iso = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) - (Number(b.slice(8, 10)) < Number(a.slice(8, 10)) ? 1 : 0);

/** What the Cox model reads about each member: tenure is its clock, so it isn't one of these. */
export const SURVIVAL_FEATURES = ['age', 'products', 'has_checking', 'has_loan', 'log_balance', 'balance_change_3m', 'direct_deposit', 'dd_stopped_90d', 'login_gap_months', 'fees_3m', 'contacts_3m', 'complaints_3m', 'cert_maturing_90d'] as const;
export const SURVIVAL_LABELS: Record<string, string> = {
  age: 'Age (per 10 years)',
  products: 'Each product held',
  has_checking: 'Has checking',
  has_loan: 'Has a loan',
  log_balance: 'Deposits (each tenfold)',
  balance_change_3m: 'Balance change, 3 months (per 10 points)',
  direct_deposit: 'Direct deposit',
  dd_stopped_90d: 'Direct deposit stopped in 90 days',
  login_gap_months: 'Each month without a login',
  fees_3m: 'Fees, 3 months (per $25)',
  contacts_3m: 'Each contact, 3 months',
  complaints_3m: 'Each complaint or dispute, 3 months',
  cert_maturing_90d: 'Certificate maturing in 90 days',
};
/** Each feature in units a committee reads, so a hazard ratio is "per" something sensible. */
const vector = (s: Record<string, unknown>) => [
  Number(s.age) / 10,
  Number(s.products),
  Number(s.has_checking),
  Number(s.has_loan),
  Math.log10(1 + Math.max(0, Number(s.deposit_balance))),
  Number(s.balance_change_3m) * 10,
  Number(s.direct_deposit),
  Number(s.dd_stopped_90d),
  Math.min(12, Number(s.days_since_login) / 30),
  Number(s.fees_3m) / 25,
  Number(s.contacts_3m),
  Number(s.complaints_3m),
  Number(s.cert_maturing_90d),
];
/** Tenure months the baseline hazard is kept for; longer tenures share the last value. */
const MAX_TENURE = 360;
/** Monthly baseline hazards are pooled into bands after the first two years, where months are thin. */
const band = (t: number) => (t < 24 ? t : t < 120 ? 24 + Math.floor((t - 24) / 12) * 12 : 120 + Math.floor((t - 120) / 60) * 60);

export interface CoxFit {
  features: string[];
  beta: number[];
  se: number[];
  /** Cumulative baseline hazard at each tenure month 0..MAX_TENURE. */
  H0: number[];
}

/**
 * Cox partial likelihood (Breslow ties) on monthly intervals: each snapshot is one month at risk at its
 * tenure, and the member either leaves by the next month-end or doesn't. Risk sets are the rows at the
 * same tenure. Newton–Raphson with a small ridge for stability.
 */
export function fitCox(Xraw: Float64Array[], tenure: Int32Array, event: Uint8Array, p: number, iterations = 25, ridge = 1) {
  // Standardized internally, so the ridge treats every feature alike and steps stay in scale; the
  // coefficients come back in each feature's own units.
  const mean = new Float64Array(p);
  const sd = new Float64Array(p);
  for (const x of Xraw) for (let k = 0; k < p; k++) mean[k]! += x[k]! / Xraw.length;
  for (const x of Xraw) for (let k = 0; k < p; k++) sd[k]! += (x[k]! - mean[k]!) ** 2 / Xraw.length;
  for (let k = 0; k < p; k++) sd[k] = Math.sqrt(sd[k]!) || 1;
  const X = Xraw.map((x) => Float64Array.from(x, (v, k) => (v - mean[k]!) / sd[k]!));
  const groups = new Map<number, number[]>();
  for (let i = 0; i < tenure.length; i++) {
    const g = tenure[i]!;
    const list = groups.get(g);
    if (list) list.push(i);
    else groups.set(g, [i]);
  }
  // Only tenures with someone leaving add to the likelihood.
  const active = [...groups.entries()].filter(([, idx]) => idx.some((i) => event[i]));
  /** The penalized log partial likelihood, and optionally its gradient and Hessian. */
  const evaluate = (beta: Float64Array, derivatives: boolean) => {
    let ll = 0;
    const grad = new Float64Array(p);
    const H = new Float64Array(p * p);
    for (const [, idx] of active) {
      let s0 = 0;
      const s1 = new Float64Array(p);
      const s2 = derivatives ? new Float64Array(p * p) : null;
      let d = 0;
      const xsum = new Float64Array(p);
      let etaSum = 0;
      for (const i of idx) {
        const x = X[i]!;
        let eta = 0;
        for (let k = 0; k < p; k++) eta += x[k]! * beta[k]!;
        const w = Math.exp(Math.max(-30, Math.min(30, eta)));
        s0 += w;
        if (derivatives) {
          for (let k = 0; k < p; k++) {
            s1[k]! += w * x[k]!;
            for (let l = 0; l <= k; l++) s2![k * p + l]! += w * x[k]! * x[l]!;
          }
        }
        if (event[i]) {
          d++;
          etaSum += eta;
          for (let k = 0; k < p; k++) xsum[k]! += x[k]!;
        }
      }
      ll += etaSum - d * Math.log(s0);
      if (derivatives) {
        for (let k = 0; k < p; k++) {
          grad[k]! += xsum[k]! - (d * s1[k]!) / s0;
          for (let l = 0; l <= k; l++) H[k * p + l]! += d * (s2![k * p + l]! / s0 - (s1[k]! * s1[l]!) / (s0 * s0));
        }
      }
    }
    for (let k = 0; k < p; k++) {
      ll -= (ridge / 2) * beta[k]! ** 2;
      grad[k]! -= ridge * beta[k]!;
      H[k * p + k]! += ridge;
      for (let l = 0; l < k; l++) H[l * p + k] = H[k * p + l]!;
    }
    return { ll, grad, H };
  };
  let beta: Float64Array = new Float64Array(p);
  let cur = evaluate(beta, true);
  for (let it = 0; it < iterations; it++) {
    const step = solve(cur.H, cur.grad, p);
    // Halve the step until the likelihood improves: plain Newton overshoots when a sign nearly separates leavers.
    let scale = 1;
    let next: Float64Array | null = null as Float64Array | null;
    let nextEval: ReturnType<typeof evaluate> | null = null;
    for (let h = 0; h < 20; h++) {
      const cand = Float64Array.from(beta, (b, k) => b + scale * step[k]!);
      const e = evaluate(cand, false);
      if (e.ll >= cur.ll - 1e-9) {
        next = cand;
        nextEval = e;
        break;
      }
      scale /= 2;
    }
    if (!next || !nextEval) break;
    const gain = nextEval.ll - cur.ll;
    beta = next;
    cur = evaluate(beta, true);
    if (gain < 1e-6) break;
  }
  const inv = invert(cur.H, p);
  // Back to each feature's own units.
  return { beta: [...beta].map((b, k) => b / sd[k]!), se: [...beta].map((_, k) => Math.sqrt(Math.max(0, inv[k * p + k]!)) / sd[k]!), groups };
}

/** Solves A x = b for a symmetric positive-definite A (Gaussian elimination with pivoting). */
function solve(A: Float64Array, b: Float64Array, n: number) {
  const M = Array.from({ length: n }, (_, i) => [...A.slice(i * n, i * n + n), b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    const d = M[c]![c]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / d;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / (row[i] || 1e-12));
}

function invert(A: Float64Array, n: number) {
  const out = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const e = new Float64Array(n);
    e[j] = 1;
    const col = solve(A, e, n);
    for (let i = 0; i < n; i++) out[i * n + j] = col[i]!;
  }
  return out;
}

/** The chance of leaving within `months` from tenure `t`, and the months until half of members like this one have left. */
export function outlook(fit: Pick<CoxFit, 'beta' | 'H0'>, x: number[], t: number, months = 12) {
  let eta = 0;
  for (let k = 0; k < x.length; k++) eta += x[k]! * fit.beta[k]!;
  const r = Math.exp(Math.max(-30, Math.min(30, eta)));
  const at = (k: number) => fit.H0[Math.min(fit.H0.length - 1, Math.max(0, k))]!;
  const h = (k: number) => {
    // Beyond the last tenure kept, the last band's monthly hazard carries on.
    const last = fit.H0.length - 1;
    if (k <= last) return at(k);
    return at(last) + (k - last) * (at(last) - at(last - 12)) / 12;
  };
  const leave = 1 - Math.exp(-r * (h(t + months) - h(t)));
  let median: number | null = null;
  for (let k = 1; k <= 600; k++) {
    if (r * (h(t + k) - h(t)) >= Math.LN2) {
      median = k;
      break;
    }
  }
  return { risk: r, leave, median };
}

export interface SurvivalRecord {
  modelId: number;
  version: number;
  status: 'Candidate' | 'Active' | 'Retired';
  trainFrom: string;
  trainTo: string;
  validFrom: string;
  validTo: string;
  examples: number;
  positives: number;
  metrics: { auc: number; predicted: number; actual: number; validationRows: number; validationLeavers: number; ratios: { feature: string; label: string; hr: number; lo: number; hi: number; p: number }[] };
  trainedBy: string;
  trainedAt: string;
  approvedBy: string | null;
  activatedAt: string | null;
}

/** Two-sided p-value of a z statistic. */
const pValue = (z: number) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.min(1, 2 * q);
};

export class SurvivalModelService {
  constructor(
    private readonly pool: Pool,
    private readonly institutionType: 'credit_union' | 'bank' = 'credit_union',
  ) {}

  async months() {
    return (await rows<{ m: string }>(this.pool, 'SELECT DISTINCT month_end AS m FROM hist_member_snapshot ORDER BY 1')).map((r) => iso(r.m));
  }

  private async examples(from: string, to: string) {
    return rows<Record<string, unknown> & { label: number }>(
      this.pool,
      `SELECT s.*, (e.party_id IS NOT NULL) AS label FROM hist_member_snapshot s
         LEFT JOIN cdm_membership_exit e ON e.party_id = s.party_id AND e.close_date > s.month_end AND e.close_date <= LAST_DAY(DATE_ADD(s.month_end, INTERVAL 1 MONTH))
        WHERE s.month_end BETWEEN ? AND ?`,
      [from, to],
    );
  }

  /** Fits the Cox model on the months before the last three labelled ones, checks it on those three, and keeps it as a candidate. */
  async train(by: string) {
    const months = await this.months();
    const labelled = months.slice(0, -1);
    if (labelled.length < 6) throw new CoreError('INVALID', 'There aren’t enough months of member history to fit on: DI needs at least six.');
    const valid = labelled.slice(-3);
    const trainMonths = labelled.slice(0, -3);
    const ex = await this.examples(trainMonths[0]!, trainMonths.at(-1)!);
    const p = SURVIVAL_FEATURES.length;
    const X = ex.map((e) => Float64Array.from(vector(e)));
    const tenure = Int32Array.from(ex.map((e) => Math.min(MAX_TENURE, Number(e.tenure_months))));
    const event = Uint8Array.from(ex.map((e) => Number(e.label)));
    const fit = fitCox(X, tenure, event, p);
    // Breslow baseline hazard by tenure month, pooled into bands where months are thin.
    const d = new Map<number, number>();
    const s0 = new Map<number, number>();
    for (let i = 0; i < ex.length; i++) {
      let eta = 0;
      for (let k = 0; k < p; k++) eta += X[i]![k]! * fit.beta[k]!;
      const b = band(tenure[i]!);
      s0.set(b, (s0.get(b) ?? 0) + Math.exp(eta));
      if (event[i]) d.set(b, (d.get(b) ?? 0) + 1);
    }
    const H0: number[] = [0];
    for (let t = 0; t < MAX_TENURE; t++) {
      const b = band(t);
      const h = (s0.get(b) ?? 0) > 0 ? (d.get(b) ?? 0) / s0.get(b)! : 0;
      H0.push(H0[t]! + h);
    }
    // Checked on every member in the three months it never saw: does a higher risk mean leaving, and
    // does it expect about as many to leave as did?
    const check = await this.examples(valid[0]!, valid.at(-1)!);
    const risk = check.map((e) => outlook({ beta: fit.beta, H0 }, vector(e), Math.min(MAX_TENURE, Number(e.tenure_months)), 1));
    const vy = check.map((e) => Number(e.label));
    const ratios = SURVIVAL_FEATURES.map((f, k) => ({ feature: f, label: SURVIVAL_LABELS[f]!, hr: Math.exp(fit.beta[k]!), lo: Math.exp(fit.beta[k]! - 1.96 * fit.se[k]!), hi: Math.exp(fit.beta[k]! + 1.96 * fit.se[k]!), p: pValue(fit.beta[k]! / (fit.se[k]! || 1e-9)) }));
    const metrics = {
      auc: Math.round(auc(risk.map((r) => r.risk), vy) * 1000) / 1000,
      predicted: risk.reduce((s, r) => s + r.leave, 0) / Math.max(1, risk.length),
      actual: vy.reduce((s, v) => s + v, 0) / Math.max(1, vy.length),
      validationRows: check.length,
      validationLeavers: vy.reduce((s, v) => s + v, 0),
      ratios,
    };
    const [last] = await rows<{ v: number | null }>(this.pool, "SELECT MAX(version) AS v FROM ml_model WHERE name = 'survival'");
    const version = Number(last?.v ?? 0) + 1;
    const [r] = (await this.pool.query(
      'INSERT INTO ml_model (name, version, status, algorithm, target, features, params, train_from, train_to, valid_from, valid_to, examples, positives, metrics, baseline, body, trained_by, trained_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['survival', version, 'Candidate', 'Cox proportional hazards, Breslow baseline', 'Time to membership closed, by tenure month', JSON.stringify(SURVIVAL_FEATURES), JSON.stringify({ ties: 'Breslow', ridge: 1e-4, maxTenure: MAX_TENURE }), trainMonths[0], trainMonths.at(-1), valid[0], valid.at(-1), ex.length, event.reduce((s, v) => s + v, 0), JSON.stringify(metrics), JSON.stringify({}), JSON.stringify({ beta: fit.beta, se: fit.se, H0 }), by, nowSql()],
    )) as unknown as [{ insertId: number }];
    return (await this.model(r.insertId))!;
  }

  async models(): Promise<SurvivalRecord[]> {
    const list = await rows<Record<string, unknown>>(this.pool, "SELECT model_id, version, status, train_from, train_to, valid_from, valid_to, examples, positives, metrics, trained_by, trained_at, approved_by, activated_at FROM ml_model WHERE name = 'survival' ORDER BY version DESC");
    return list.map((m) => ({
      modelId: Number(m.model_id),
      version: Number(m.version),
      status: m.status as SurvivalRecord['status'],
      trainFrom: iso(m.train_from),
      trainTo: iso(m.train_to),
      validFrom: iso(m.valid_from),
      validTo: iso(m.valid_to),
      examples: Number(m.examples),
      positives: Number(m.positives),
      metrics: (typeof m.metrics === 'string' ? JSON.parse(m.metrics) : m.metrics) as SurvivalRecord['metrics'],
      trainedBy: String(m.trained_by),
      trainedAt: String(m.trained_at instanceof Date ? (m.trained_at as Date).toISOString() : m.trained_at).replace(' ', 'T').slice(0, 19),
      approvedBy: (m.approved_by as string | null) ?? null,
      activatedAt: m.activated_at ? String(m.activated_at instanceof Date ? (m.activated_at as Date).toISOString() : m.activated_at).replace(' ', 'T').slice(0, 19) : null,
    }));
  }

  async model(modelId: number) {
    return (await this.models()).find((m) => m.modelId === modelId) ?? null;
  }

  async active() {
    return (await this.models()).find((m) => m.status === 'Active') ?? null;
  }

  private async load(modelId: number): Promise<CoxFit> {
    const [m] = await rows<{ body: string }>(this.pool, 'SELECT body FROM ml_model WHERE model_id = ?', [modelId]);
    if (!m) throw new CoreError('NOT_FOUND', 'That model version no longer exists.');
    const b = JSON.parse(m.body) as { beta: number[]; se: number[]; H0: number[] };
    return { features: [...SURVIVAL_FEATURES], ...b };
  }

  /** Puts a version to work, retires the one before, and scores every member at the latest month-end. */
  async activate(modelId: number, by: string, approvalId: string | null) {
    const m = await this.model(modelId);
    if (!m) throw new CoreError('NOT_FOUND', 'That model version no longer exists.');
    // Scores first, then the switch: no one sees the new version before its scores are written.
    const scored = await this.score(modelId);
    const old = (await this.models()).filter((x) => x.status === 'Active').map((x) => x.modelId);
    if (old.length) {
      await this.pool.query("UPDATE ml_model SET status = 'Retired' WHERE model_id IN (?)", [old]);
      await this.pool.query('DELETE FROM ml_score WHERE model_id IN (?)', [old]);
    }
    await this.pool.query("UPDATE ml_model SET status = 'Active', approved_by = ?, approval_id = ?, activated_at = ? WHERE model_id = ?", [by, approvalId, nowSql(), modelId]);
    return scored;
  }

  async score(modelId: number) {
    const fit = await this.load(modelId);
    const month = (await this.months()).at(-1)!;
    const snaps = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM hist_member_snapshot WHERE month_end = ?', [month]);
    await this.pool.query('DELETE FROM ml_score WHERE model_id = ?', [modelId]);
    const out = snaps.map((s) => {
      const o = outlook(fit, vector(s), Math.min(MAX_TENURE, Number(s.tenure_months)), 12);
      const band12 = o.leave >= 0.2 ? 'High' : o.leave >= 0.08 ? 'Medium' : 'Low';
      // probability: leaving within 12 months; probability_90d holds the rate against a baseline member (capped);
      // expected_months: months until half of members like this one have left, null past 25 years.
      return [modelId, month, s.party_id, 'survival', Math.round(o.leave * 1e5) / 1e5, Math.round(Math.min(99.99, o.risk) * 1e4) / 1e4, o.median === null || o.median > 300 ? null : o.median, band12, '[]'];
    });
    for (let i = 0; i < out.length; i += 2000) await this.pool.query('INSERT INTO ml_score (model_id, month_end, party_id, item, probability, probability_90d, expected_months, band, drivers) VALUES ?', [out.slice(i, i + 2000)]);
    return { modelId, month, scored: out.length };
  }

  /**
   * Retention curves, period method: every member's months at risk from when the exit window opened (or
   * when they joined, if later) to when they left or today, by tenure month. Optionally by age band or branch.
   */
  async curves(by: 'all' | 'age' | 'branch' = 'all', purviewBranches?: string[]) {
    const [w] = await rows<{ a: unknown; b: unknown }>(this.pool, 'SELECT MIN(close_date) AS a, (SELECT MAX(as_of_date) FROM meta_build) AS b FROM cdm_membership_exit');
    if (!w?.a) throw new CoreError('NOT_FOUND', 'DI holds no membership closures yet, so there’s nothing to learn how long members stay from.');
    const open = `${iso(w.a).slice(0, 7)}-01`;
    const asOf = iso(w.b ?? w.a);
    const scope = purviewBranches ? ' AND b.name IN (?)' : '';
    const pv = purviewBranches ? [purviewBranches.length ? purviewBranches : ['']] : [];
    const people = await rows<{ join_date: unknown; birth_date: unknown; close_date: unknown; branch: string }>(
      this.pool,
      `SELECT p.join_date, p.birth_date, NULL AS close_date, b.name AS branch FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.is_member = 1${scope}
       UNION ALL
       SELECT e.join_date, e.birth_date, e.close_date, b.name FROM cdm_membership_exit e JOIN cdm_location b ON b.int_id = e.branch_id WHERE e.close_date >= ?${scope}`,
      [...pv, open, ...pv],
    );
    const ageBand = (birth: string) => {
      const a = monthsBetween(birth, open) / 12;
      return a < 30 ? 'Under 30' : a < 45 ? '30 to 44' : a < 60 ? '45 to 59' : '60 and over';
    };
    const groups = new Map<string, { at: Float64Array; d: Float64Array }>();
    const add = (g: string, entry: number, exit: number, left: boolean) => {
      let x = groups.get(g);
      if (!x) groups.set(g, (x = { at: new Float64Array(MAX_TENURE + 2), d: new Float64Array(MAX_TENURE + 2) }));
      // At risk in each tenure month from entry to exit; the last month is where they left, if they did.
      for (let t = Math.max(0, entry); t <= Math.min(MAX_TENURE, exit); t++) x.at[t]! += 1;
      if (left && exit <= MAX_TENURE) x.d[exit]! += 1;
    };
    for (const p of people) {
      const join = iso(p.join_date);
      const end = p.close_date ? iso(p.close_date) : asOf;
      if (end < open || join > end) continue;
      const entry = join >= open ? 0 : monthsBetween(join, open);
      const exit = monthsBetween(join, end);
      if (exit < entry) continue;
      const g = by === 'age' ? ageBand(iso(p.birth_date)) : by === 'branch' ? p.branch : 'All';
      add(g, entry, exit, Boolean(p.close_date));
    }
    const MILESTONES = [12, 36, 60, 120, 180];
    const order = ['Under 30', '30 to 44', '45 to 59', '60 and over'];
    const out = [...groups.entries()].map(([group, x]) => {
      const S: number[] = [1];
      for (let t = 0; t <= MAX_TENURE; t++) S.push(S[t]! * (x.at[t]! > 0 ? 1 - x.d[t]! / x.at[t]! : 1));
      const median = S.findIndex((v) => v <= 0.5);
      return { group, members: x.at.reduce((m, v) => Math.max(m, v), 0), exits: x.d.reduce((s, v) => s + v, 0), at: Object.fromEntries(MILESTONES.map((m) => [m, S[m]!])) as Record<number, number>, median: median > 0 ? median : null, curve: S.filter((_, i) => i % 6 === 0).slice(0, 41) };
    });
    out.sort((a, b) => (by === 'age' ? order.indexOf(a.group) - order.indexOf(b.group) : b.members - a.members));
    return { window: { from: open, to: asOf, months: monthsBetween(open, asOf) }, by, groups: out, milestones: MILESTONES };
  }

  /** Deposits at risk over the next 12 months, by branch, and the members with the most at stake, in purview. */
  async atRisk(opts: { limit?: number; purviewBranches?: string[] } = {}) {
    const m = await this.active();
    if (!m) return null;
    const scope = opts.purviewBranches ? ' AND b.name IN (?)' : '';
    const pv = opts.purviewBranches ? [opts.purviewBranches.length ? opts.purviewBranches : ['']] : [];
    const month = (await this.months()).at(-1)!;
    const byBranch = await rows<{ branch: string; members: number; leave: number; deposits: number; at_risk: number; median: number | null }>(
      this.pool,
      `SELECT b.name AS branch, COUNT(*) AS members, SUM(s.probability) AS \`leave\`, SUM(h.deposit_balance) AS deposits, SUM(h.deposit_balance * s.probability) AS at_risk
         FROM ml_score s JOIN hist_member_snapshot h ON h.party_id = s.party_id AND h.month_end = s.month_end JOIN cdm_location b ON b.int_id = h.branch_id
        WHERE s.model_id = ? AND s.month_end = ?${scope} GROUP BY b.name ORDER BY at_risk DESC`,
      [m.modelId, month, ...pv],
    );
    const top = await rows<Record<string, unknown>>(
      this.pool,
      `SELECT s.party_id, p.first_name, p.last_name, b.name AS branch, s.probability, s.expected_months, h.deposit_balance, h.tenure_months, h.deposit_balance * s.probability AS at_risk
         FROM ml_score s JOIN hist_member_snapshot h ON h.party_id = s.party_id AND h.month_end = s.month_end JOIN cdm_party p ON p.party_id = s.party_id JOIN cdm_location b ON b.int_id = h.branch_id
        WHERE s.model_id = ? AND s.month_end = ?${scope} ORDER BY at_risk DESC LIMIT ?`,
      [m.modelId, month, ...pv, opts.limit ?? 15],
    );
    return {
      model: m,
      month,
      branches: byBranch.map((r) => ({ branch: r.branch, members: Number(r.members), leave: Number(r.leave), deposits: Number(r.deposits), atRisk: Number(r.at_risk) })),
      items: top.map((r) => ({ partyId: Number(r.party_id), name: `${r.first_name} ${r.last_name}`, branch: String(r.branch), leave: Number(r.probability), median: r.expected_months === null ? null : Number(r.expected_months), deposits: Number(r.deposit_balance), tenure: Number(r.tenure_months), atRisk: Number(r.at_risk) })),
    };
  }

  /** On first start: fit the first version and put it to work, unless one is in use. */
  async bootstrap() {
    if (await this.active()) return null;
    const c = (await this.models()).find((m) => m.status === 'Candidate') ?? (await this.train('DI setup'));
    await this.activate(c.modelId, 'DI setup (first model, before anyone could review it)', null);
    return c;
  }

  get people() {
    return this.institutionType === 'bank' ? 'customers' : 'members';
  }
}
