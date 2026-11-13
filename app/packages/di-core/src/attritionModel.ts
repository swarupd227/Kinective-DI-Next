// The attrition model (spec Predictive Analytics): DI trains it on its own data, checks
// it on months it didn't train on, keeps every version, scores every member monthly with the reasons
// behind each score, and watches whether today's members still look like the ones it learned from.
// - The target: does the member leave within the next month-end? From that monthly chance come the
//   chance of leaving in 90 days and how long half of members like this one stay.
// - Trained on the months before the last three it can check; checked on those three. Nothing it is
//   checked on was in training.
// - A new version is a candidate until someone approves it; only one version of a model is active.
// - Claude explains the scores; the numbers come from here.
import type { Pool } from '@dinext/tenant-db';
import { auc, capture, contributions, importance, predict, profileOf, psi, train, type Gbm, type GbmParams } from './gbm.ts';
import { CoreError } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const modelMonthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** What the attrition model reads about each member, in the order it reads them. */
export const ATTRITION_FEATURES = ['tenure_months', 'age', 'products', 'has_checking', 'has_loan', 'log_balance', 'balance_change_3m', 'direct_deposit', 'dd_stopped_90d', 'days_since_login', 'fees_3m', 'contacts_3m', 'complaints_3m', 'cert_maturing_90d'] as const;
export const ATTRITION_FEATURE_LABELS: Record<string, string> = {
  tenure_months: 'Months with us',
  age: 'Age',
  products: 'Products held',
  has_checking: 'Has checking',
  has_loan: 'Has a loan',
  log_balance: 'Deposit balance',
  balance_change_3m: 'Balance change, 3 months',
  direct_deposit: 'Direct deposit',
  dd_stopped_90d: 'Direct deposit stopped',
  days_since_login: 'Days since last login',
  fees_3m: 'Fees, 3 months',
  contacts_3m: 'Contacts, 3 months',
  complaints_3m: 'Complaints and disputes, 3 months',
  cert_maturing_90d: 'Certificate maturing',
};
export const ATTRITION_PARAMS: Partial<GbmParams> = { trees: 150, depth: 3, learningRate: 0.05, lambda: 20, minChild: 60, subsample: 0.8 };
/** Negatives are sampled at this rate for training and weighted back up, so the chances stay true. */
const NEGATIVE_SAMPLE = 0.2;
const HISTORY_MONTHS = 6;

export interface MemberSnapshot {
  month_end: string;
  party_id: number;
  branch_id: number;
  tenure_months: number;
  age: number;
  products: number;
  has_checking: number;
  has_loan: number;
  deposit_balance: number;
  balance_change_3m: number;
  direct_deposit: number;
  dd_stopped_90d: number;
  days_since_login: number;
  fees_3m: number;
  contacts_3m: number;
  complaints_3m: number;
  cert_maturing_90d: number;
}

export const vector = (s: MemberSnapshot) => [Number(s.tenure_months), Number(s.age), Number(s.products), Number(s.has_checking), Number(s.has_loan), Math.log10(1 + Math.max(0, Number(s.deposit_balance))), Number(s.balance_change_3m), Number(s.direct_deposit), Number(s.dd_stopped_90d), Number(s.days_since_login), Number(s.fees_3m), Number(s.contacts_3m), Number(s.complaints_3m), Number(s.cert_maturing_90d)];

/** A reason a member scores higher, in words, from their own values. Null when it isn't worth saying. */
function reason(feature: string, s: MemberSnapshot): string | null {
  const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
  switch (feature) {
    case 'dd_stopped_90d':
      return Number(s.dd_stopped_90d) ? 'Direct deposit stopped in the last 90 days' : null;
    case 'direct_deposit':
      return Number(s.direct_deposit) ? null : 'No direct deposit';
    case 'balance_change_3m':
      return Number(s.balance_change_3m) < -0.1 ? `Deposit balances down ${Math.round(-Number(s.balance_change_3m) * 100)}% in 3 months` : null;
    case 'days_since_login':
      return Number(s.days_since_login) >= 365 ? 'No online or mobile banking' : Number(s.days_since_login) >= 30 ? `No login for ${s.days_since_login} days` : null;
    case 'products':
      return Number(s.products) <= 1 ? 'Holds only one product' : null;
    case 'fees_3m':
      return Number(s.fees_3m) >= 25 ? `${money(Number(s.fees_3m))} in fees in 3 months` : null;
    case 'complaints_3m':
      return Number(s.complaints_3m) ? `${s.complaints_3m} fee ${Number(s.complaints_3m) === 1 ? 'question or dispute' : 'questions or disputes'} in 3 months` : null;
    case 'contacts_3m':
      return Number(s.contacts_3m) >= 3 ? `${s.contacts_3m} contacts in 3 months` : null;
    case 'cert_maturing_90d':
      return Number(s.cert_maturing_90d) ? 'Certificate matures within 90 days' : null;
    case 'tenure_months':
      return Number(s.tenure_months) < 36 ? `With us for ${s.tenure_months < 12 ? `${s.tenure_months} months` : `${Math.floor(Number(s.tenure_months) / 12)} years`}` : null;
    case 'log_balance':
      return Number(s.deposit_balance) < 500 ? `Low balances: ${money(Number(s.deposit_balance))}` : null;
    case 'age':
      return Number(s.age) >= 75 ? `Age ${s.age}` : null;
    case 'has_checking':
      return Number(s.has_checking) ? null : 'No checking account';
    default:
      return null;
  }
}

export interface ModelRecord {
  modelId: number;
  name: string;
  version: number;
  status: 'Candidate' | 'Active' | 'Retired';
  algorithm: string;
  target: string;
  trainFrom: string;
  trainTo: string;
  validFrom: string;
  validTo: string;
  examples: number;
  positives: number;
  metrics: { auc: number; captured10: number; lift10: number; predicted: number; actual: number; brier: number; validationRows: number; validationLeavers: number };
  importance: { feature: string; label: string; share: number }[];
  trainedBy: string;
  trainedAt: string;
  approvedBy: string | null;
  activatedAt: string | null;
}

/** "High" when a member is likely enough to leave in 90 days to call; "Medium" worth watching. */
export const ATTRITION_BANDS = { high: 0.1, medium: 0.03 };
const bandOf = (p90: number) => (p90 >= ATTRITION_BANDS.high ? 'High' : p90 >= ATTRITION_BANDS.medium ? 'Medium' : 'Low');

export class AttritionModelService {
  constructor(private readonly pool: Pool) {}

  async months() {
    return (await rows<{ m: string }>(this.pool, 'SELECT DISTINCT month_end AS m FROM hist_member_snapshot ORDER BY 1')).map((r) => String(r.m).slice(0, 10));
  }

  /** Snapshots with whether the member left by the next month-end; negatives sampled when asked. */
  private async examples(from: string, to: string, sample: boolean) {
    return rows<MemberSnapshot & { label: number }>(
      this.pool,
      `SELECT s.*, (e.party_id IS NOT NULL) AS label FROM hist_member_snapshot s
         LEFT JOIN cdm_membership_exit e ON e.party_id = s.party_id AND e.close_date > s.month_end AND e.close_date <= LAST_DAY(DATE_ADD(s.month_end, INTERVAL 1 MONTH))
        WHERE s.month_end BETWEEN ? AND ?${sample ? ` AND (e.party_id IS NOT NULL OR MOD(s.party_id * 31 + MONTH(s.month_end) * 7, 1000) < ${NEGATIVE_SAMPLE * 1000})` : ''}`,
      [from, to],
    );
  }

  /**
   * Trains a new version of the attrition model as a candidate: the months before the last three
   * labelled ones to learn from, those three to check it on.
   */
  async trainAttrition(by: string) {
    const months = await this.months();
    // A month is labelled once the next month-end has passed: the last snapshot month isn't.
    const labelled = months.slice(0, -1);
    if (labelled.length < 6) throw new CoreError('INVALID', 'There aren’t enough months of member history to train on: DI needs at least six.');
    const valid = labelled.slice(-3);
    const trainMonths = labelled.slice(0, -3);
    const ex = await this.examples(trainMonths[0]!, trainMonths.at(-1)!, true);
    const X = ex.map(vector);
    const y = ex.map((e) => Number(e.label));
    const w = y.map((v) => (v ? 1 : 1 / NEGATIVE_SAMPLE));
    const model = train([...ATTRITION_FEATURES], X, y, w, ATTRITION_PARAMS);
    // Checked on every member in the three months it never saw.
    const check = await this.examples(valid[0]!, valid.at(-1)!, false);
    const scores = check.map((e) => predict(model, vector(e)));
    const vy = check.map((e) => Number(e.label));
    const top = capture(scores, vy, 0.1);
    const predicted = scores.reduce((s, v) => s + v, 0) / Math.max(scores.length, 1);
    const actual = vy.reduce((s, v) => s + v, 0) / Math.max(vy.length, 1);
    const brier = scores.reduce((s, v, i) => s + (v - vy[i]!) ** 2, 0) / Math.max(scores.length, 1);
    const metrics = { auc: Math.round(auc(scores, vy) * 1000) / 1000, captured10: Math.round(top.captured * 1000) / 1000, lift10: Math.round(top.lift * 10) / 10, predicted, actual, brier, validationRows: check.length, validationLeavers: vy.reduce((s, v) => s + v, 0) };
    // What members looked like in training, for drift checks: each feature's deciles and the scores'.
    const baseline = Object.fromEntries([...ATTRITION_FEATURES.map((f, j) => [f, profileOf(X.filter((_, i) => i % 3 === 0).map((r) => r[j]!))]), ['__score', profileOf(scores.filter((_, i) => i % 3 === 0))]]);
    const [last] = await rows<{ v: number | null }>(this.pool, "SELECT MAX(version) AS v FROM ml_model WHERE name = 'attrition'");
    const version = Number(last?.v ?? 0) + 1;
    const [r] = (await this.pool.query(
      'INSERT INTO ml_model (name, version, status, algorithm, target, features, params, train_from, train_to, valid_from, valid_to, examples, positives, metrics, baseline, body, trained_by, trained_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['attrition', version, 'Candidate', 'Gradient-boosted trees, logistic loss', 'Membership closed by the next month-end', JSON.stringify(ATTRITION_FEATURES), JSON.stringify(model.params), trainMonths[0], trainMonths.at(-1), valid[0], valid.at(-1), ex.length, y.reduce((s, v) => s + v, 0), JSON.stringify({ ...metrics, importance: importance(model).slice(0, 8) }), JSON.stringify(baseline), JSON.stringify({ base: model.base, trees: model.trees }), by, nowSql()],
    )) as unknown as [{ insertId: number }];
    return (await this.model(r.insertId))!;
  }

  private async load(modelId: number): Promise<Gbm> {
    const [m] = await rows<{ features: unknown; params: unknown; body: string }>(this.pool, 'SELECT features, params, body FROM ml_model WHERE model_id = ?', [modelId]);
    if (!m) throw new CoreError('NOT_FOUND', 'That model version no longer exists.');
    const body = JSON.parse(m.body) as { base: number; trees: Gbm['trees'] };
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
    return { features: parse(m.features) as string[], params: parse(m.params) as GbmParams, base: body.base, trees: body.trees };
  }

  async model(modelId: number): Promise<ModelRecord | null> {
    return (await this.models()).find((m) => m.modelId === modelId) ?? null;
  }

  async models(name = 'attrition'): Promise<ModelRecord[]> {
    const list = await rows<Record<string, unknown>>(this.pool, 'SELECT model_id, name, version, status, algorithm, target, train_from, train_to, valid_from, valid_to, examples, positives, metrics, trained_by, trained_at, approved_by, activated_at FROM ml_model WHERE name = ? ORDER BY version DESC', [name]);
    return list.map((m) => {
      const metrics = (typeof m.metrics === 'string' ? JSON.parse(m.metrics) : m.metrics) as ModelRecord['metrics'] & { importance: { feature: string; share: number }[] };
      const d = (v: unknown) => String(v).slice(0, 10);
      return {
        modelId: Number(m.model_id),
        name: String(m.name),
        version: Number(m.version),
        status: m.status as ModelRecord['status'],
        algorithm: String(m.algorithm),
        target: String(m.target),
        trainFrom: d(m.train_from),
        trainTo: d(m.train_to),
        validFrom: d(m.valid_from),
        validTo: d(m.valid_to),
        examples: Number(m.examples),
        positives: Number(m.positives),
        metrics,
        importance: (metrics.importance ?? []).map((i) => ({ ...i, label: ATTRITION_FEATURE_LABELS[i.feature] ?? i.feature })),
        trainedBy: String(m.trained_by),
        trainedAt: String(m.trained_at).replace(' ', 'T').slice(0, 19),
        approvedBy: (m.approved_by as string | null) ?? null,
        activatedAt: m.activated_at ? String(m.activated_at).replace(' ', 'T').slice(0, 19) : null,
      };
    });
  }

  async active(name = 'attrition') {
    return (await this.models(name)).find((m) => m.status === 'Active') ?? null;
  }

  /** Makes a version the one DI uses, retires the one before, and scores every member with it. */
  async activate(modelId: number, by: string, approvalId: string | null) {
    const m = await this.model(modelId);
    if (!m) throw new CoreError('NOT_FOUND', 'That model version no longer exists.');
    // Scores first, then the switch: no one sees the new version before its scores are written.
    const scored = await this.score(modelId);
    await this.pool.query("UPDATE ml_model SET status = 'Retired' WHERE name = ? AND status = 'Active'", [m.name]);
    await this.pool.query("UPDATE ml_model SET status = 'Active', approved_by = ?, approval_id = ?, activated_at = ? WHERE model_id = ?", [by, approvalId, nowSql(), modelId]);
    return scored;
  }

  /** Scores every member at each of the last six month-ends: a history to compare against, and this month's reasons. */
  async score(modelId: number) {
    const model = await this.load(modelId);
    const months = (await this.months()).slice(-HISTORY_MONTHS);
    await this.pool.query('DELETE FROM ml_score WHERE model_id = ?', [modelId]);
    let scored = 0;
    for (const month of months) {
      const latest = month === months.at(-1);
      const snaps = await rows<MemberSnapshot>(this.pool, 'SELECT * FROM hist_member_snapshot WHERE month_end = ?', [month]);
      const out: unknown[][] = [];
      for (const s of snaps) {
        const x = vector(s);
        const h = Math.min(0.999, Math.max(1e-6, predict(model, x)));
        const p90 = 1 - (1 - h) ** 3;
        const median = Math.min(999, Math.log(0.5) / Math.log(1 - h));
        let drivers: string[] = [];
        if (latest) {
          const c = contributions(model, x);
          drivers = [...c].map((v, j) => ({ v, f: model.features[j]! })).filter((d) => d.v > 0.05).sort((a, b) => b.v - a.v).map((d) => reason(d.f, s)).filter((r): r is string => Boolean(r)).slice(0, 3);
        }
        out.push([modelId, month, s.party_id, '', Math.round(h * 1e5) / 1e5, Math.round(p90 * 1e5) / 1e5, Math.round(median * 10) / 10, bandOf(p90), JSON.stringify(drivers)]);
      }
      for (let i = 0; i < out.length; i += 2000) await this.pool.query('INSERT INTO ml_score (model_id, month_end, party_id, item, probability, probability_90d, expected_months, band, drivers) VALUES ?', [out.slice(i, i + 2000)]);
      scored += out.length;
    }
    await this.drift(modelId);
    return { modelId, months, scored };
  }

  /** How far the latest month's members have moved from what the model trained on (population stability). */
  async drift(modelId: number) {
    const [m] = await rows<{ baseline: unknown }>(this.pool, 'SELECT baseline FROM ml_model WHERE model_id = ?', [modelId]);
    const baseline = (typeof m!.baseline === 'string' ? JSON.parse(m!.baseline) : m!.baseline) as Record<string, { edges: number[]; shares: number[] }>;
    const month = (await this.months()).at(-1)!;
    const snaps = await rows<MemberSnapshot>(this.pool, 'SELECT * FROM hist_member_snapshot WHERE month_end = ?', [month]);
    const X = snaps.map(vector);
    const [scoreRows] = [await rows<{ p: number }>(this.pool, 'SELECT probability AS p FROM ml_score WHERE model_id = ? AND month_end = ?', [modelId, month])];
    const out: unknown[][] = ATTRITION_FEATURES.map((f, j) => [modelId, month, f, Math.round(psi(baseline[f]!.edges, baseline[f]!.shares, X.map((r) => r[j]!)) * 10000) / 10000]);
    out.push([modelId, month, '__score', Math.round(psi(baseline.__score!.edges, baseline.__score!.shares, scoreRows.map((r) => Number(r.p))) * 10000) / 10000]);
    await this.pool.query('DELETE FROM ml_drift WHERE model_id = ? AND month_end = ?', [modelId, month]);
    await this.pool.query('INSERT INTO ml_drift (model_id, month_end, feature, psi) VALUES ?', [out]);
  }

  async driftReport(modelId: number) {
    const list = await rows<{ month_end: string; feature: string; psi: number }>(this.pool, 'SELECT month_end, feature, psi FROM ml_drift WHERE model_id = ? ORDER BY month_end DESC, psi DESC', [modelId]);
    const month = list[0] ? String(list[0].month_end).slice(0, 10) : null;
    const now = list.filter((r) => String(r.month_end).slice(0, 10) === month);
    const state = (v: number) => (v >= 0.25 ? 'Shifted' : v >= 0.1 ? 'Moving' : 'Stable');
    return { month, items: now.map((r) => ({ feature: r.feature, label: r.feature === '__score' ? 'The scores themselves' : (ATTRITION_FEATURE_LABELS[r.feature] ?? r.feature), psi: Number(r.psi), state: state(Number(r.psi)) })) };
  }

  /** Members most likely to leave at the latest month-end, in purview, with their reasons. */
  async top(modelId: number, opts: { limit?: number; purviewBranches?: string[] } = {}) {
    const scope = opts.purviewBranches ? ' AND b.name IN (?)' : '';
    const month = (await this.months()).at(-1)!;
    const list = await rows<Record<string, unknown>>(
      this.pool,
      `SELECT s.party_id, p.first_name, p.last_name, b.name AS branch, s.probability_90d, s.expected_months, s.band, s.drivers,
              COALESCE((SELECT SUM(d.balance) FROM cdm_deposit_account d WHERE d.party_id = s.party_id AND d.close_date IS NULL), 0) AS deposits,
              a.score AS rule_score
         FROM ml_score s JOIN cdm_party p ON p.party_id = s.party_id AND p.is_member = 1 JOIN cdm_location b ON b.int_id = p.primary_branch_id
         LEFT JOIN cdm_attrition_score a ON a.party_id = s.party_id
        WHERE s.model_id = ? AND s.month_end = ? AND NOT EXISTS (SELECT 1 FROM cdm_party_detail pd WHERE pd.party_id = s.party_id AND pd.deceased_date IS NOT NULL)${scope} ORDER BY s.probability_90d DESC LIMIT ?`,
      [modelId, month, ...(opts.purviewBranches ? [opts.purviewBranches.length ? opts.purviewBranches : ['']] : []), opts.limit ?? 25],
    );
    return { month, items: list.map((r) => ({ partyId: Number(r.party_id), name: `${r.first_name} ${r.last_name}`, branch: String(r.branch), p90: Number(r.probability_90d), months: Number(r.expected_months), band: String(r.band), drivers: (typeof r.drivers === 'string' ? JSON.parse(r.drivers) : r.drivers) as string[], deposits: Number(r.deposits), ruleScore: r.rule_score === null ? null : Number(r.rule_score) })) };
  }

  /** Members by band at each scored month-end, and how many in each band left by the next month-end. */
  async history(modelId: number, purviewBranches?: string[]) {
    const scope = purviewBranches ? ' AND b.name IN (?)' : '';
    const list = await rows<{ month_end: string; band: string; members: number; avg: number; avg_month: number; left_next: number }>(
      this.pool,
      `SELECT s.month_end, s.band, COUNT(*) AS members, AVG(s.probability_90d) AS avg, AVG(s.probability) AS avg_month,
              SUM(EXISTS(SELECT 1 FROM cdm_membership_exit e WHERE e.party_id = s.party_id AND e.close_date > s.month_end AND e.close_date <= LAST_DAY(DATE_ADD(s.month_end, INTERVAL 1 MONTH)))) AS left_next
         FROM ml_score s JOIN hist_member_snapshot h ON h.party_id = s.party_id AND h.month_end = s.month_end JOIN cdm_location b ON b.int_id = h.branch_id
        WHERE s.model_id = ?${scope} GROUP BY s.month_end, s.band ORDER BY s.month_end, FIELD(s.band, 'High', 'Medium', 'Low')`,
      [modelId, ...(purviewBranches ? [purviewBranches.length ? purviewBranches : ['']] : [])],
    );
    return list.map((r) => ({ month: String(r.month_end).slice(0, 10), band: r.band, members: Number(r.members), avg90: Number(r.avg), avgMonth: Number(r.avg_month), leftNext: Number(r.left_next) }));
  }

  /** One member's latest model score and reasons, beside the rule score, with their last six months. */
  async member(partyId: number) {
    const active = await this.active();
    if (!active) return null;
    const list = await rows<{ month_end: string; probability_90d: number; expected_months: number; band: string; drivers: unknown }>(this.pool, 'SELECT month_end, probability_90d, expected_months, band, drivers FROM ml_score WHERE model_id = ? AND party_id = ? ORDER BY month_end', [active.modelId, partyId]);
    const last = list.at(-1);
    if (!last) return null;
    return {
      model: `attrition v${active.version}`,
      month: String(last.month_end).slice(0, 10),
      p90: Number(last.probability_90d),
      months: Number(last.expected_months),
      band: last.band,
      drivers: (typeof last.drivers === 'string' ? JSON.parse(last.drivers) : last.drivers) as string[],
      trend: list.map((r) => ({ month: String(r.month_end).slice(0, 10), p90: Number(r.probability_90d) })),
    };
  }

  /** First start: when no attrition model is active, train one and put it to work. */
  async bootstrap() {
    if (await this.active()) return null;
    const candidate = (await this.models()).find((m) => m.status === 'Candidate') ?? (await this.trainAttrition('DI setup'));
    await this.activate(candidate.modelId, 'DI setup (first model, before anyone could review it)', null);
    return candidate;
  }
}
