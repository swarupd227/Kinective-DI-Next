// The next-best-product model: which product each member is likely to open next, trained on DI's own
// history of who opened what. One gradient-boosted model for each product with enough openings to learn
// from (a credit union's checking, savings, certificates, money market, IRAs, auto, personal and card
// loans, HELOCs; a bank's checking, savings, CDs, money market, consumer, auto and commercial loans).
// - The target: an existing member who doesn't hold the product opens it by the next month-end.
// - What it reads: the member's month-end snapshot (tenure, age, balances and their change, direct
//   deposit, logins, fees, contacts, certificates maturing), whether they were shopping for a loan or a
//   large deposit landed in the last 90 days, and which other products they hold.
// - Trained on the months before the last three labelled ones; checked on those three, which it never saw.
// - A version is the set of product models trained together. It is a candidate until someone other than
//   the person who asked for it approves putting it to work, as with the attrition model. A product model
//   that can't rank who opens it (AUC under 0.65 on the months it never saw) is kept on record, not used.
// - Each member is scored at the latest month-end for every product they don't hold; their top three are
//   kept when they're at least one and a half times as likely as the average member, with the reasons
//   from their own data. The seeded "products to suggest" stay as they are; this is
//   the trained model beside them.
import type { Pool } from '@dinext/tenant-db';
import { auc, capture, contributions, importance, predict, train, type Gbm, type GbmParams } from './gbm.ts';
import { CoreError } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
export const NEXT_PRODUCT_PREFIX = 'next_product:';

const BASE_FEATURES = ['tenure_months', 'age', 'products', 'log_balance', 'balance_change_3m', 'direct_deposit', 'days_since_login', 'fees_3m', 'contacts_3m', 'cert_maturing_90d', 'loan_shopping_90d', 'large_deposit_90d'] as const;
export const NEXT_PRODUCT_PARAMS: Partial<GbmParams> = { trees: 70, depth: 3, learningRate: 0.1, lambda: 20, minChild: 40, subsample: 0.8 };
/** Negatives are sampled at this rate for training and weighted back up, so the chances stay true. */
const NEGATIVE_SAMPLE = 0.04;
/** A product needs at least this many openings in training, and this many in the months it's checked on. */
const MIN_TRAIN_POSITIVES = 120;
const MIN_VALID_POSITIVES = 25;
/** A product model that can't rank who opens it any better than this on the months it never saw isn't used. */
export const NEXT_PRODUCT_MIN_AUC = 0.65;
/** How much likelier than the average member to open it: High at four times, Medium at twice. */
export const NEXT_PRODUCT_BANDS = { high: 4, medium: 2 };
const KEEP_PER_MEMBER = 3;
/** A product is kept for a member only when they're at least this much likelier than average to open it. */
const KEEP_LIFT = 1.5;

interface Snapshot {
  month_end: string;
  party_id: number;
  branch_id: number;
  tenure_months: number;
  age: number;
  products: number;
  deposit_balance: number;
  balance_change_3m: number;
  direct_deposit: number;
  days_since_login: number;
  fees_3m: number;
  contacts_3m: number;
  cert_maturing_90d: number;
  loan_shopping_90d: number;
  large_deposit_90d: number;
  held: string;
}

export interface ProductModel {
  modelId: number;
  product: string;
  version: number;
  /** Not used: trained, but too weak at telling who opens the product to put to work. */
  status: 'Candidate' | 'Active' | 'Retired' | 'Not used';
  trainFrom: string;
  trainTo: string;
  validFrom: string;
  validTo: string;
  examples: number;
  positives: number;
  metrics: { auc: number; captured10: number; lift10: number; baseRate: number; validationRows: number; validationOpened: number };
  importance: { feature: string; label: string; share: number }[];
  trainedBy: string;
  trainedAt: string;
  approvedBy: string | null;
  activatedAt: string | null;
}

const slug = (p: string) => p.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const heldOf = (s: Snapshot) => new Set(String(s.held ?? '').split(',').filter(Boolean));
const featureLabel = (f: string) =>
  ({
    tenure_months: 'Months with us',
    age: 'Age',
    products: 'Products held',
    log_balance: 'Deposit balance',
    balance_change_3m: 'Balance change, 3 months',
    direct_deposit: 'Direct deposit',
    days_since_login: 'Days since last login',
    fees_3m: 'Fees, 3 months',
    contacts_3m: 'Contacts, 3 months',
    cert_maturing_90d: 'Certificate maturing',
    loan_shopping_90d: 'Shopping for a loan',
    large_deposit_90d: 'A large deposit',
  })[f] ?? (f.startsWith('has_') ? `Holds ${f.slice(4).replace(/_/g, ' ')}` : f);

/** A reason a member is likelier to open the product, in words, from their own values. */
function reason(feature: string, s: Snapshot, products: string[]): string | null {
  const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
  if (feature.startsWith('has_')) {
    const p = products.find((x) => `has_${slug(x)}` === feature);
    if (!p) return null;
    return heldOf(s).has(p) ? `Already has ${p.toLowerCase()}` : null;
  }
  switch (feature) {
    case 'loan_shopping_90d':
      return Number(s.loan_shopping_90d) ? 'Shopping for a loan in the last 90 days' : null;
    case 'large_deposit_90d':
      return Number(s.large_deposit_90d) ? 'A large deposit in the last 90 days' : null;
    case 'balance_change_3m':
      return Number(s.balance_change_3m) > 0.1 ? `Deposit balances up ${Math.round(Number(s.balance_change_3m) * 100)}% in 3 months` : Number(s.balance_change_3m) < -0.15 ? `Deposit balances down ${Math.round(-Number(s.balance_change_3m) * 100)}% in 3 months` : null;
    case 'log_balance':
      return Number(s.deposit_balance) >= 25_000 ? `${money(Number(s.deposit_balance))} on deposit` : null;
    case 'cert_maturing_90d':
      return Number(s.cert_maturing_90d) ? 'A certificate matures within 90 days' : null;
    case 'direct_deposit':
      return Number(s.direct_deposit) ? 'Direct deposit comes here' : null;
    case 'days_since_login':
      return Number(s.days_since_login) <= 14 ? 'Uses online banking every week or two' : null;
    case 'contacts_3m':
      return Number(s.contacts_3m) >= 2 ? `${s.contacts_3m} contacts with staff in 3 months` : null;
    case 'tenure_months':
      return Number(s.tenure_months) >= 60 ? `With us for ${Math.floor(Number(s.tenure_months) / 12)} years` : Number(s.tenure_months) < 12 ? 'Joined in the last year' : null;
    case 'age':
      return `Age ${s.age}`;
    case 'products':
      return Number(s.products) >= 3 ? `Holds ${s.products} products` : null;
    default:
      return null;
  }
}

const shiftMonthEnd = (iso: string, k: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k + 1, 0)).toISOString().slice(0, 10);
};

export class NextProductModelService {
  constructor(private readonly pool: Pool) {}

  async months() {
    return (await rows<{ m: string }>(this.pool, 'SELECT DISTINCT month_end AS m FROM hist_member_snapshot ORDER BY 1')).map((r) => String(r.m).slice(0, 10));
  }

  /** The products members hold, deposits and loans, by their own names. */
  private async catalog() {
    const list = await rows<{ c: string }>(this.pool, 'SELECT DISTINCT deposit_category AS c FROM cdm_deposit_account UNION SELECT DISTINCT loan_category FROM cdm_loan WHERE source IS NULL');
    return list.map((r) => String(r.c)).sort();
  }

  /** Who opened what, and when: each member's openings after they joined. */
  private async openings() {
    const list = await rows<{ party_id: number; c: string; d: string }>(this.pool, "SELECT party_id, deposit_category AS c, open_date AS d FROM cdm_deposit_account UNION ALL SELECT party_id, loan_category, open_date FROM cdm_loan WHERE source IS NULL AND party_id IS NOT NULL");
    const by = new Map<number, { c: string; d: string }[]>();
    for (const r of list) (by.get(Number(r.party_id)) ?? by.set(Number(r.party_id), []).get(Number(r.party_id))!).push({ c: String(r.c), d: String((r.d as unknown) instanceof Date ? (r.d as unknown as Date).toISOString() : r.d).slice(0, 10) });
    return by;
  }

  private features(products: string[]) {
    return [...BASE_FEATURES, ...products.map((p) => `has_${slug(p)}`)];
  }

  private vector(s: Snapshot, products: string[]) {
    const held = heldOf(s);
    return [Number(s.tenure_months), Number(s.age), Number(s.products), Math.log10(1 + Math.max(0, Number(s.deposit_balance))), Number(s.balance_change_3m), Number(s.direct_deposit), Number(s.days_since_login), Number(s.fees_3m), Number(s.contacts_3m), Number(s.cert_maturing_90d), Number(s.loan_shopping_90d ?? 0), Number(s.large_deposit_90d ?? 0), ...products.map((p) => (held.has(p) ? 1 : 0))];
  }

  private async snapshots(from: string, to: string) {
    return rows<Snapshot>(this.pool, 'SELECT month_end, party_id, branch_id, tenure_months, age, products, deposit_balance, balance_change_3m, direct_deposit, days_since_login, fees_3m, contacts_3m, cert_maturing_90d, loan_shopping_90d, large_deposit_90d, held FROM hist_member_snapshot WHERE month_end BETWEEN ? AND ? AND tenure_months >= 1', [from, to]);
  }

  /**
   * Trains a new version: one model for each product with enough openings, on the months before the
   * last three labelled ones, checked on those three. Every product model in the version is a candidate.
   */
  async train(by: string) {
    const months = await this.months();
    const labelled = months.slice(0, -1);
    if (labelled.length < 6) throw new CoreError('INVALID', 'There aren’t enough months of member history to train on: DI needs at least six.');
    const valid = labelled.slice(-3);
    const trainMonths = labelled.slice(0, -3);
    const products = await this.catalog();
    const opened = await this.openings();
    const snaps = await this.snapshots(trainMonths[0]!, valid.at(-1)!);
    const month = (s: Snapshot) => String((s.month_end as unknown) instanceof Date ? (s.month_end as unknown as Date).toISOString() : s.month_end).slice(0, 10);
    // What each snapshot went on to open by the next month-end.
    const next = snaps.map((s) => {
      const m = month(s);
      const until = shiftMonthEnd(m, 1);
      return new Set((opened.get(Number(s.party_id)) ?? []).filter((o) => o.d > m && o.d <= until).map((o) => o.c));
    });
    const features = this.features(products);
    const X = snaps.map((s) => this.vector(s, products));
    const inTrain = snaps.map((s) => month(s) <= trainMonths.at(-1)!);
    const [last] = await rows<{ v: number | null }>(this.pool, "SELECT MAX(version) AS v FROM ml_model WHERE name LIKE 'next_product:%'");
    const version = Number(last?.v ?? 0) + 1;
    const out: { product: string; modelId: number; auc: number; captured10: number }[] = [];
    const skipped: string[] = [];
    for (const product of products) {
      const idx = snaps.map((s, i) => (heldOf(s).has(product) ? -1 : i)).filter((i) => i >= 0);
      const label = (i: number) => (next[i]!.has(product) ? 1 : 0);
      const trainIdx = idx.filter((i) => inTrain[i] && (label(i) || ((Number(snaps[i]!.party_id) * 31 + i * 7) % 1000) / 1000 < NEGATIVE_SAMPLE));
      const validIdx = idx.filter((i) => !inTrain[i]);
      const trainPos = trainIdx.reduce((s, i) => s + label(i), 0);
      const validPos = validIdx.reduce((s, i) => s + label(i), 0);
      if (trainPos < MIN_TRAIN_POSITIVES || validPos < MIN_VALID_POSITIVES) {
        skipped.push(product);
        continue;
      }
      const y = trainIdx.map(label);
      const model = train(features, trainIdx.map((i) => X[i]!), y, y.map((v) => (v ? 1 : 1 / NEGATIVE_SAMPLE)), NEXT_PRODUCT_PARAMS);
      const scores = validIdx.map((i) => predict(model, X[i]!));
      const vy = validIdx.map(label);
      const top = capture(scores, vy, 0.1);
      const baseRate = validPos / Math.max(1, validIdx.length);
      const metrics = { auc: Math.round(auc(scores, vy) * 1000) / 1000, captured10: Math.round(top.captured * 1000) / 1000, lift10: Math.round(top.lift * 10) / 10, baseRate, validationRows: validIdx.length, validationOpened: validPos, importance: importance(model).slice(0, 8) };
      const [r] = (await this.pool.query(
        'INSERT INTO ml_model (name, version, status, algorithm, target, features, params, train_from, train_to, valid_from, valid_to, examples, positives, metrics, baseline, body, trained_by, trained_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`${NEXT_PRODUCT_PREFIX}${product}`, version, metrics.auc >= NEXT_PRODUCT_MIN_AUC ? 'Candidate' : 'Not used', 'Gradient-boosted trees, logistic loss', `Opens ${product} by the next month-end`, JSON.stringify(features), JSON.stringify(model.params), trainMonths[0], trainMonths.at(-1), valid[0], valid.at(-1), trainIdx.length, trainPos, JSON.stringify(metrics), JSON.stringify({ products }), JSON.stringify({ base: model.base, trees: model.trees }), by, nowSql()],
      )) as unknown as [{ insertId: number }];
      out.push({ product, modelId: r.insertId, auc: metrics.auc, captured10: metrics.captured10 });
    }
    if (!out.some((o) => o.auc >= NEXT_PRODUCT_MIN_AUC)) throw new CoreError('INVALID', 'No product has enough openings to learn from yet, or none of the models could tell who would open one.');
    return { version, products: out.filter((o) => o.auc >= NEXT_PRODUCT_MIN_AUC), weak: out.filter((o) => o.auc < NEXT_PRODUCT_MIN_AUC), skipped };
  }

  /** Every product model, newest version first. */
  async models(): Promise<ProductModel[]> {
    const list = await rows<Record<string, unknown>>(this.pool, "SELECT model_id, name, version, status, train_from, train_to, valid_from, valid_to, examples, positives, metrics, trained_by, trained_at, approved_by, activated_at FROM ml_model WHERE name LIKE 'next_product:%' ORDER BY version DESC, name");
    return list.map((m) => {
      const metrics = (typeof m.metrics === 'string' ? JSON.parse(m.metrics) : m.metrics) as ProductModel['metrics'] & { importance: { feature: string; share: number }[] };
      const d = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
      return {
        modelId: Number(m.model_id),
        product: String(m.name).slice(NEXT_PRODUCT_PREFIX.length),
        version: Number(m.version),
        status: m.status as ProductModel['status'],
        trainFrom: d(m.train_from),
        trainTo: d(m.train_to),
        validFrom: d(m.valid_from),
        validTo: d(m.valid_to),
        examples: Number(m.examples),
        positives: Number(m.positives),
        metrics,
        importance: (metrics.importance ?? []).map((i) => ({ ...i, label: featureLabel(i.feature) })),
        trainedBy: String(m.trained_by),
        trainedAt: String(m.trained_at instanceof Date ? (m.trained_at as Date).toISOString() : m.trained_at).replace(' ', 'T').slice(0, 19),
        approvedBy: (m.approved_by as string | null) ?? null,
        activatedAt: m.activated_at ? String(m.activated_at instanceof Date ? (m.activated_at as Date).toISOString() : m.activated_at).replace(' ', 'T').slice(0, 19) : null,
      };
    });
  }

  /** The version in use: its product models. */
  async active() {
    const all = await this.models();
    const v = all.find((m) => m.status === 'Active')?.version;
    return v === undefined ? null : { version: v, models: all.filter((m) => m.version === v && m.status === 'Active'), notUsed: all.filter((m) => m.version === v && m.status === 'Not used') };
  }

  async candidate() {
    const all = await this.models();
    const v = all.find((m) => m.status === 'Candidate')?.version;
    return v === undefined ? null : { version: v, models: all.filter((m) => m.version === v && m.status === 'Candidate'), notUsed: all.filter((m) => m.version === v && m.status === 'Not used') };
  }

  private async load(modelId: number): Promise<{ model: Gbm; products: string[] }> {
    const [m] = await rows<{ features: unknown; params: unknown; body: string; baseline: unknown }>(this.pool, 'SELECT features, params, body, baseline FROM ml_model WHERE model_id = ?', [modelId]);
    if (!m) throw new CoreError('NOT_FOUND', 'That model version no longer exists.');
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
    const body = JSON.parse(m.body) as { base: number; trees: Gbm['trees'] };
    return { model: { features: parse(m.features) as string[], params: parse(m.params) as GbmParams, base: body.base, trees: body.trees }, products: (parse(m.baseline) as { products: string[] }).products };
  }

  /** Puts a version to work: retires the one before and scores every member with it. */
  async activate(version: number, by: string, approvalId: string | null) {
    const set = (await this.models()).filter((m) => m.version === version && m.status !== 'Not used');
    if (!set.length) throw new CoreError('NOT_FOUND', `There’s no version ${version} of the next-best-product model.`);
    // Scores first, then the switch: no one sees the new version before its scores are written.
    const scored = await this.score(version);
    const old = (await this.models()).filter((m) => m.status === 'Active').map((m) => m.modelId);
    if (old.length) {
      await this.pool.query("UPDATE ml_model SET status = 'Retired' WHERE model_id IN (?)", [old]);
      await this.pool.query('DELETE FROM ml_score WHERE model_id IN (?)', [old]);
    }
    await this.pool.query("UPDATE ml_model SET status = 'Active', approved_by = ?, approval_id = ?, activated_at = ? WHERE model_id IN (?)", [by, approvalId, nowSql(), set.map((m) => m.modelId)]);
    return scored;
  }

  /** Scores every member at the latest month-end for each product they don't hold, keeping their top three. */
  async score(version: number) {
    const set = (await this.models()).filter((m) => m.version === version && m.status !== 'Not used');
    const loaded = await Promise.all(set.map(async (m) => ({ m, ...(await this.load(m.modelId)) })));
    const month = (await this.months()).at(-1)!;
    const snaps = await this.snapshots(month, month);
    await this.pool.query('DELETE FROM ml_score WHERE model_id IN (?)', [set.map((m) => m.modelId)]);
    const out: unknown[][] = [];
    for (const s of snaps) {
      const held = heldOf(s);
      const scored = loaded
        .filter((l) => !held.has(l.m.product))
        .map((l) => {
          const x = this.vector(s, l.products);
          const p = Math.min(0.999, Math.max(1e-6, predict(l.model, x)));
          return { l, x, p, lift: p / Math.max(1e-6, l.m.metrics.baseRate) };
        })
        .filter((c) => c.lift >= KEEP_LIFT)
        .sort((a, b) => b.lift - a.lift)
        .slice(0, KEEP_PER_MEMBER);
      for (const c of scored) {
        const contrib = contributions(c.l.model, c.x);
        const drivers = [...contrib].map((v, j) => ({ v, f: c.l.model.features[j]! })).filter((d) => d.v > 0.05).sort((a, b) => b.v - a.v).map((d) => reason(d.f, s, c.l.products)).filter((r): r is string => Boolean(r)).slice(0, 3);
        const band = c.lift >= NEXT_PRODUCT_BANDS.high ? 'High' : c.lift >= NEXT_PRODUCT_BANDS.medium ? 'Medium' : 'Low';
        out.push([c.l.m.modelId, month, s.party_id, c.l.m.product, Math.round(c.p * 1e5) / 1e5, null, Math.round(Math.min(c.lift, 99999) * 10) / 10, band, JSON.stringify(drivers)]);
      }
    }
    for (let i = 0; i < out.length; i += 2000) await this.pool.query('INSERT INTO ml_score (model_id, month_end, party_id, item, probability, probability_90d, expected_months, band, drivers) VALUES ?', [out.slice(i, i + 2000)]);
    return { version, month, scored: out.length, members: snaps.length };
  }

  /** For one product, the members likeliest to open it at the latest month-end, in purview, with reasons. */
  async top(product: string, opts: { limit?: number; purviewBranches?: string[] } = {}) {
    const act = await this.active();
    const m = act?.models.find((x) => x.product.toLowerCase() === product.toLowerCase());
    if (!m) return null;
    const scope = opts.purviewBranches ? ' AND b.name IN (?)' : '';
    const list = await rows<Record<string, unknown>>(
      this.pool,
      `SELECT s.party_id, p.first_name, p.last_name, b.name AS branch, s.probability, s.expected_months AS lift, s.band, s.drivers, s.month_end,
              COALESCE((SELECT SUM(d.balance) FROM cdm_deposit_account d WHERE d.party_id = s.party_id AND d.close_date IS NULL), 0) AS deposits
         FROM ml_score s JOIN cdm_party p ON p.party_id = s.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id
        WHERE s.model_id = ?${scope} ORDER BY s.probability DESC LIMIT ?`,
      [m.modelId, ...(opts.purviewBranches ? [opts.purviewBranches.length ? opts.purviewBranches : ['']] : []), opts.limit ?? 20],
    );
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as string[];
    return { model: m, month: list[0] ? String(list[0].month_end instanceof Date ? (list[0].month_end as Date).toISOString() : list[0].month_end).slice(0, 10) : null, items: list.map((r) => ({ partyId: Number(r.party_id), name: `${r.first_name} ${r.last_name}`, branch: String(r.branch), probability: Number(r.probability), lift: Number(r.lift), band: String(r.band), drivers: parse(r.drivers), deposits: Number(r.deposits) })) };
  }

  /** How many members are in the High and Medium bands for each product this month, in purview. */
  async summary(purviewBranches?: string[]) {
    const act = await this.active();
    if (!act) return null;
    const scope = purviewBranches ? ' AND b.name IN (?)' : '';
    const list = await rows<{ item: string; band: string; n: number }>(
      this.pool,
      `SELECT s.item, s.band, COUNT(*) AS n FROM ml_score s JOIN cdm_party p ON p.party_id = s.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id
        WHERE s.model_id IN (?)${scope} GROUP BY s.item, s.band`,
      [act.models.map((m) => m.modelId), ...(purviewBranches ? [purviewBranches.length ? purviewBranches : ['']] : [])],
    );
    return act.models.map((m) => ({ ...m, high: Number(list.find((x) => x.item === m.product && x.band === 'High')?.n ?? 0), medium: Number(list.find((x) => x.item === m.product && x.band === 'Medium')?.n ?? 0) })).sort((a, b) => b.high - a.high);
  }

  /** One member's likeliest next products, with reasons. */
  async member(partyId: number) {
    const act = await this.active();
    if (!act) return null;
    const list = await rows<{ item: string; probability: number; lift: number; band: string; drivers: unknown }>(this.pool, 'SELECT item, probability, expected_months AS lift, band, drivers FROM ml_score WHERE model_id IN (?) AND party_id = ? ORDER BY expected_months DESC', [act.models.map((m) => m.modelId), partyId]);
    return list.map((r) => ({ product: r.item, probability: Number(r.probability), lift: Number(r.lift), band: r.band, drivers: (typeof r.drivers === 'string' ? JSON.parse(r.drivers) : r.drivers) as string[] }));
  }

  /** On first start: train the first version and put it to work, unless there is one already. */
  async bootstrap() {
    if (await this.active()) return null;
    // A candidate waiting from an earlier start is put to work; otherwise the first version is trained.
    const waiting = await this.candidate();
    const t = waiting ? { version: waiting.version, products: waiting.models.map((m) => ({ product: m.product, modelId: m.modelId, auc: m.metrics.auc, captured10: m.metrics.captured10 })), weak: [], skipped: [] } : await this.train('DI setup');
    await this.activate(t.version, 'DI setup (first model, before anyone could review it)', null);
    return t;
  }
}
