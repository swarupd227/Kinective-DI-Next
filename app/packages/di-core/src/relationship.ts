// Relationship Manager (spec 8.24, 17.2): party search, the member 360 profile, score explanations,
// the next best conversation and "Member declined". Purview is applied here, in SQL, so the same
// rule holds for classic screens, APIs and agents (BE-RM-001, AI-TRG-020).
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { SCORE_MODELS, type Pool, type ScoreFactor } from '@dinext/tenant-db';
import { CoreError, type CoreContext, type PartyHit } from './referrals.ts';

// ---- opaque member tokens ----------------------------------------------------------------------

/**
 * Links and context chips carry an opaque token, never a member number (FE-ARCH-011). The token is
 * one AES block holding a marker, the tenant and the party, so it decodes without a lookup table,
 * is the same on every restart, and a token from one tenant means nothing in another.
 */
const tokenKey = () => createHash('sha256').update(process.env.DI_TOKEN_SECRET ?? 'dinext-local-member-tokens').digest().subarray(0, 16);
const tenantTag = (tenant: string) => createHash('sha256').update(tenant).digest().readUInt32BE(0);
const MARK = 0x44496d31; // "DIm1"

export function memberToken(tenant: string, partyId: number): string {
  const block = Buffer.alloc(16);
  block.writeUInt32BE(MARK, 0);
  block.writeUInt32BE(tenantTag(tenant), 4);
  block.writeUInt32BE(partyId, 8);
  block.writeUInt32BE((partyId * 2654435761) >>> 0, 12);
  const c = createCipheriv('aes-128-ecb', tokenKey(), null).setAutoPadding(false);
  return `mbr_${Buffer.concat([c.update(block), c.final()]).toString('base64url')}`;
}

export function partyFromToken(tenant: string, token: string): number | null {
  const m = /^mbr_([A-Za-z0-9_-]{22})$/.exec(token);
  if (!m) return null;
  try {
    const d = createDecipheriv('aes-128-ecb', tokenKey(), null).setAutoPadding(false);
    const b = Buffer.concat([d.update(Buffer.from(m[1]!, 'base64url')), d.final()]);
    const partyId = b.readUInt32BE(8);
    if (b.readUInt32BE(0) !== MARK || b.readUInt32BE(4) !== tenantTag(tenant) || b.readUInt32BE(12) !== (partyId * 2654435761) >>> 0) return null;
    return partyId;
  } catch {
    return null;
  }
}

// ---- types --------------------------------------------------------------------------------------

export const memberNumber = (partyId: number) => String(10_004_520 + partyId);
const last4Of = (partyId: number) => memberNumber(partyId).slice(-4);

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface PartyMatch extends PartyHit {
  /** What the query matched: a name, the member number's last digits, a phone number or an email. */
  matchedOn: 'name' | 'number' | 'phone' | 'email';
}

export interface AccountLine {
  kind: 'deposit' | 'loan';
  name: string;
  /** Last four digits of the account (AI-AGT-151). */
  suffix: string;
  relationship: 'Primary' | 'Joint' | 'Authorized';
  balance: number;
  /** Balance 30 days earlier [CA-29]. */
  balance30d: number;
  fees30d: number;
  rate: number;
  opened: string;
  maturity?: string;
  daysPastDue?: number;
}

export interface Opportunity {
  suggestionId: number;
  product: string;
  likelihood: number;
  reason: string;
  referralTypeId: string | null;
}

export interface AttritionScore {
  score: number;
  band: 'Low' | 'Medium' | 'High';
  factors: ScoreFactor[];
  model: string;
  runDate: string;
}

export interface MemberProfile {
  partyId: number;
  token: string;
  person: 'member' | 'customer';
  name: string;
  firstName: string;
  last4: string;
  branch: string;
  joined: string;
  segment: string;
  isMember: boolean;
  asOf: { buildId: string; completedAt: string; date: string };
  alerts: { code: string; label: string; tone: Tone }[];
  deposits: AccountLine[];
  loans: AccountLine[];
  totals: { deposits: number; loans: number; accounts: number; products: number };
  digital: { id: string; label: string; enrolled: boolean; since: string | null }[];
  directDeposit: { status: 'active' | 'stopped' | 'none'; changed: string | null };
  lastLogin: string | null;
  growth: { days: 30 | 60 | 90; total: number; services: number; loan: number; deposit: number }[];
  crossSell: number;
  attrition: AttritionScore;
  opportunities: Opportunity[];
  /** Suggestions the member declined that are still suppressed (spec 17.2). */
  declined: { product: string; until: string; by: string }[];
  applications: { approved: number; denied: number; pending: number; items: { product: string; amount: number; status: 'Approved' | 'Denied' | 'Pending'; detail: string; applied: string; decided: string | null }[] };
  interactions: { total: number; items: { at: string; channel: string; kind: string; summary: string; by: string | null }[] };
  contact: { email: string; phone: string; preferred: string };
  household: { name: string | null; branch: string | null; last4: string | null; inPurview: boolean }[];
}

export interface Topic {
  id: string;
  kind: 'open_issue' | 'pending_application' | 'retention_risk' | 'product_opportunity' | 'digital_gap';
  /** A short, code-written headline. */
  headline: string;
  /** The data behind it, cited in the talking point (AI-AGT-152). */
  reason: string;
  refer?: { product: string; referralTypeId: string };
}

/** Opportunities show at a likelihood of 6 or more (configurable per tenant, spec 17.2). */
export const OPPORTUNITY_THRESHOLD = 6;
/** "Member declined" suppresses a suggestion for 90 days by default [Assumption AS-091]. */
export const DECLINE_DAYS = 90;

/** A score at or above this reads as High (see attritionBand). */
export const HIGH_ATTRITION = 7;

export interface AtRiskMember {
  partyId: number;
  name: string;
  firstName: string;
  branch: string;
  last4: string;
  score: number;
  reasons: string[];
}

export const attritionBand = (score: number): AttritionScore['band'] => (score >= 7 ? 'High' : score >= 4 ? 'Medium' : 'Low');

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const sqlTime = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const longDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const LOAN_LABEL: Record<string, string> = { Auto: 'Auto loan', Personal: 'Personal loan', Business: 'Business loan', Consumer: 'Consumer loan', Mortgage: 'First mortgage', 'Home Equity': 'Home equity' };

const STOPWORDS = new Set(['at', 'the', 'member', 'customer', 'number', 'ending', 'in', 'with', 'from', 'branch', 'mr', 'mrs', 'ms', 'dr']);

// ---- service ------------------------------------------------------------------------------------

export class RelationshipService {
  private branches: string[] | null = null;
  private build: MemberProfile['asOf'] | null = null;
  private staff: Map<number, string> | null = null;

  constructor(
    private readonly pool: Pool,
    readonly tenant: string,
    readonly institutionType: 'credit_union' | 'bank',
  ) {}

  get person(): 'member' | 'customer' {
    return this.institutionType === 'bank' ? 'customer' : 'member';
  }

  token(partyId: number) {
    return memberToken(this.tenant, partyId);
  }

  /**
   * relationship.attrition.list: people with a high attrition score, highest first, limited to the
   * purview. Names, masked numbers and the model's reasons only; balances stay in the record.
   */
  async atRisk(ctx: CoreContext, limit = 25): Promise<{ total: number; items: AtRiskMember[] }> {
    const scope = ctx.purviewBranches ? 'AND b.name IN (?)' : '';
    const params = ctx.purviewBranches ? [ctx.purviewBranches] : [];
    const from = `FROM cdm_attrition_score s JOIN cdm_party p ON p.party_id = s.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE s.score >= ${HIGH_ATTRITION} ${scope}`;
    const [count] = await this.pool.query(`SELECT COUNT(*) AS n ${from}`, params);
    const [rows] = await this.pool.query(`SELECT s.party_id, s.score, s.factors, p.first_name, p.last_name, b.name AS branch ${from} ORDER BY s.score DESC, s.party_id LIMIT ?`, [...params, limit]);
    return {
      total: Number((count as { n: number }[])[0]!.n),
      items: (rows as { party_id: number; score: number; factors: unknown; first_name: string; last_name: string; branch: string }[]).map((m) => ({
        partyId: m.party_id,
        name: `${m.first_name} ${m.last_name}`,
        firstName: m.first_name,
        branch: m.branch,
        last4: last4Of(m.party_id),
        score: m.score,
        reasons: json<ScoreFactor[]>(m.factors)
          .filter((f) => f.weight > 0)
          .map((f) => f.label),
      })),
    };
  }

  /** The party behind a token, within purview. A token outside the purview reads as not found. */
  async resolve(token: string, ctx: CoreContext): Promise<PartyHit & { branchId: number }> {
    const partyId = partyFromToken(this.tenant, token);
    if (partyId === null) throw new CoreError('NOT_FOUND', `That ${this.person} record was not found.`);
    return this.party(partyId, ctx);
  }

  async party(partyId: number, ctx: CoreContext): Promise<PartyHit & { branchId: number }> {
    const [rows] = await this.pool.query('SELECT p.party_id, p.first_name, p.last_name, p.join_date, p.primary_branch_id, b.name AS branch FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.party_id = ?', [partyId]);
    const p = (rows as { party_id: number; first_name: string; last_name: string; join_date: string; primary_branch_id: number; branch: string }[])[0];
    // The same answer for "does not exist" and "outside your purview" (spec 20.7).
    if (!p || (ctx.purviewBranches && !ctx.purviewBranches.includes(p.branch))) throw new CoreError('NO_ACCESS', `That ${this.person} is outside your purview.`);
    return { partyId: p.party_id, name: `${p.first_name} ${p.last_name}`, firstName: p.first_name, branch: p.branch, branchId: p.primary_branch_id, memberSince: p.join_date.slice(0, 4), last4: last4Of(p.party_id), products: [] };
  }

  private async branchNames() {
    if (!this.branches) {
      const [rows] = await this.pool.query('SELECT name FROM cdm_location');
      this.branches = (rows as { name: string }[]).map((r) => r.name);
    }
    return this.branches;
  }

  /**
   * relationship.party.search (BE-RM-002): a name (optionally "at <branch>"), the member number or
   * its last four digits, a phone number or an email. Results are masked and limited to the purview,
   * so a miss looks the same whether or not the person exists.
   */
  async search(query: string, ctx: CoreContext, limit = 5): Promise<PartyMatch[]> {
    const q = query.normalize('NFKD').trim();
    if (!q) return [];
    const conds: string[] = [];
    const params: unknown[] = [];
    let matchedOn: PartyMatch['matchedOn'] = 'name';
    const email = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.exec(q)?.[0];
    const rest = email ? q.replace(email, ' ') : q;
    // Digit runs, allowing the separators people type or say: "(555) 123-4567", "…4521".
    const digits = (rest.match(/\d[\d\s().-]*\d|\d/g) ?? []).map((d) => d.replace(/\D/g, '')).filter(Boolean);
    const number = digits.find((d) => d.length >= 4);
    if (email) {
      conds.push('c.email = ?');
      params.push(email.toLowerCase());
      matchedOn = 'email';
    } else if (number && number.length >= 10) {
      conds.push('c.phone = ?');
      params.push(number.slice(-10));
      matchedOn = 'phone';
    } else if (number && number.length === 8) {
      conds.push('p.party_id = ?');
      params.push(Number(number) - 10_004_520);
      matchedOn = 'number';
    } else if (number && number.length === 7) {
      conds.push('c.phone LIKE ?');
      params.push(`%${number}`);
      matchedOn = 'phone';
    } else if (number && number.length === 4) {
      // Member numbers are 10004520 + party id, so the last four digits fix the party id modulo 10000.
      conds.push('MOD(p.party_id, 10000) = ?');
      params.push((Number(number) - 4520 + 10_000) % 10_000);
      matchedOn = 'number';
    }
    const branches = await this.branchNames();
    let branch: string | undefined;
    const words = rest
      .replace(/[^A-Za-z' -]/g, ' ')
      .split(/\s+/)
      .filter((w) => {
        const known = branches.find((b) => b.toLowerCase() === w.toLowerCase());
        if (known) branch = known;
        return w.length >= 2 && !known && !STOPWORDS.has(w.toLowerCase());
      })
      .slice(0, 4);
    for (const w of words) {
      conds.push('(p.first_name LIKE ? OR p.last_name LIKE ?)');
      params.push(`${w}%`, `${w}%`);
    }
    if (!conds.length) return [];
    if (matchedOn === 'number' && words.length) matchedOn = 'name';
    if (branch) {
      conds.push('b.name = ?');
      params.push(branch);
    }
    if (ctx.purviewBranches) {
      conds.push('b.name IN (?)');
      params.push(ctx.purviewBranches.length ? ctx.purviewBranches : ['']);
    }
    params.push(limit);
    const [rows] = await this.pool.query(
      `SELECT p.party_id, p.first_name, p.last_name, p.join_date, b.name AS branch
         FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id
         ${email || matchedOn === 'phone' ? 'JOIN cdm_party_contact c ON c.party_id = p.party_id' : ''}
        WHERE ${conds.join(' AND ')}
        ORDER BY p.join_date ASC, p.party_id ASC LIMIT ?`,
      params,
    );
    const hits = rows as { party_id: number; first_name: string; last_name: string; join_date: string; branch: string }[];
    if (!hits.length) return [];
    const ids = hits.map((h) => h.party_id);
    const [prod] = await this.pool.query(
      `SELECT party_id, loan_category AS c FROM cdm_loan WHERE party_id IN (?) AND close_date IS NULL AND charge_off_date IS NULL
        UNION SELECT party_id, deposit_category AS c FROM cdm_deposit_account WHERE party_id IN (?) AND close_date IS NULL`,
      [ids, ids],
    );
    const products = new Map<number, Set<string>>();
    for (const r of prod as { party_id: number; c: string }[]) (products.get(r.party_id) ?? products.set(r.party_id, new Set()).get(r.party_id)!).add(LOAN_LABEL[r.c] ?? r.c);
    return hits.map((h) => ({
      partyId: h.party_id,
      name: `${h.first_name} ${h.last_name}`,
      firstName: h.first_name,
      branch: h.branch,
      memberSince: h.join_date.slice(0, 4),
      last4: last4Of(h.party_id),
      products: [...(products.get(h.party_id) ?? [])].sort(),
      matchedOn,
    }));
  }

  private async buildInfo() {
    if (!this.build) {
      const [rows] = await this.pool.query("SELECT build_id, as_of_date, completed_at FROM meta_build WHERE state = 'completed' ORDER BY completed_at DESC LIMIT 1");
      const b = (rows as { build_id: string; as_of_date: string; completed_at: string }[])[0]!;
      this.build = { buildId: b.build_id, completedAt: b.completed_at, date: b.as_of_date };
    }
    return this.build;
  }

  private async staffNames() {
    if (!this.staff) {
      const [rows] = await this.pool.query('SELECT employee_id, display_name FROM cdm_employee');
      this.staff = new Map((rows as { employee_id: number; display_name: string }[]).map((r) => [r.employee_id, r.display_name]));
    }
    return this.staff;
  }

  /**
   * relationship.profile.get: every section of the Relationship Dashboard in its order [BK p11],
   * assembled in one call (spec 17.2). Throws NO_ACCESS outside the purview (BE-RM-001).
   */
  async profile(partyId: number, ctx: CoreContext): Promise<MemberProfile> {
    const party = await this.party(partyId, ctx);
    const build = await this.buildInfo();
    const asOf = build.date;
    const q = async <T>(sql: string, params: unknown[]) => (await this.pool.query(sql, params))[0] as T[];

    type Base = {
      join_date: string;
      segment_code: string;
      is_member: number;
      household_id: number;
      email: string;
      phone: string;
      preferred_channel: string;
      score: number;
      factors: unknown;
      model_version: string;
      run_date: string;
      online_banking_since: string | null;
      mobile_since: string | null;
      mobile_deposit_since: string | null;
      estatements_since: string | null;
      bill_pay_since: string | null;
      direct_deposit_status: 'active' | 'stopped' | 'none';
      direct_deposit_changed: string | null;
      last_login: string | null;
    };
    const [base] = await q<Base>(
      `SELECT p.join_date, p.segment_code, p.is_member, p.household_id, c.email, c.phone, c.preferred_channel,
              s.score, s.factors, s.model_version, s.run_date,
              d.online_banking_since, d.mobile_since, d.mobile_deposit_since, d.estatements_since, d.bill_pay_since, d.direct_deposit_status, d.direct_deposit_changed, d.last_login
         FROM cdm_party p JOIN cdm_party_contact c ON c.party_id = p.party_id JOIN cdm_attrition_score s ON s.party_id = p.party_id JOIN cdm_digital_usage d ON d.party_id = p.party_id
        WHERE p.party_id = ?`,
      [partyId],
    );
    if (!base) throw new CoreError('NOT_FOUND', `That ${this.person} has no relationship data in this build.`);

    const deps = await q<{ account_id: number; deposit_category: string; open_date: string; maturity_date: string | null; balance: number; rate: number; balance_30d: number; fees_30d: number }>(
      `SELECT a.account_id, a.deposit_category, a.open_date, a.maturity_date, a.balance, a.rate, COALESCE(x.balance_30d, a.balance) AS balance_30d, COALESCE(x.fees_30d, 0) AS fees_30d
         FROM cdm_deposit_account a LEFT JOIN cdm_account_activity x ON x.account_kind = 'deposit' AND x.account_id = a.account_id
        WHERE a.party_id = ? AND a.close_date IS NULL ORDER BY a.balance DESC`,
      [partyId],
    );
    const loans = await q<{ loan_id: number; loan_category: string; open_date: string; balance: number; rate: number; days_delinquent: number; balance_30d: number; fees_30d: number }>(
      `SELECT l.loan_id, l.loan_category, l.open_date, l.balance, l.rate, l.days_delinquent, COALESCE(x.balance_30d, l.balance) AS balance_30d, COALESCE(x.fees_30d, 0) AS fees_30d
         FROM cdm_loan l LEFT JOIN cdm_account_activity x ON x.account_kind = 'loan' AND x.account_id = l.loan_id
        WHERE l.party_id = ? AND l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0 ORDER BY l.balance DESC`,
      [partyId],
    );
    const [closed] = await q<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM cdm_deposit_account WHERE party_id = ? AND close_date BETWEEN ? AND ?) + (SELECT COUNT(*) FROM cdm_loan WHERE party_id = ? AND close_date BETWEEN ? AND ?) AS n`,
      [partyId, addDays(asOf, -90), asOf, partyId, addDays(asOf, -90), asOf],
    );
    const suggestions = await q<{ suggestion_id: number; product: string; referral_type_id: string | null; likelihood: number; reason: string }>('SELECT suggestion_id, product, referral_type_id, likelihood, reason FROM cdm_suggestion WHERE party_id = ? ORDER BY likelihood DESC, suggestion_id', [partyId]);
    const declines = await q<{ suggestion_id: number; product: string; suppressed_until: string; declined_by_name: string; declined_at: string }>(
      'SELECT suggestion_id, product, suppressed_until, declined_by_name, declined_at FROM mod_suggestion_decline WHERE party_id = ? AND reversed_at IS NULL AND suppressed_until >= ? ORDER BY declined_at DESC',
      [partyId, asOf],
    );
    const apps = await q<{ product: string; amount: number; status_group: 'Approved' | 'Denied' | 'Pending'; status_detail: string; applied_date: string; decided_date: string | null }>(
      'SELECT product, amount, status_group, status_detail, applied_date, decided_date FROM cdm_loan_application WHERE party_id = ? AND applied_date >= ? ORDER BY applied_date DESC',
      [partyId, addDays(asOf, -365)],
    );
    const [count] = await q<{ n: number }>('SELECT COUNT(*) AS n FROM cdm_interaction WHERE party_id = ?', [partyId]);
    const recent = await q<{ occurred_at: string; channel: string; kind: string; summary: string; employee_id: number | null }>('SELECT occurred_at, channel, kind, summary, employee_id FROM cdm_interaction WHERE party_id = ? ORDER BY occurred_at DESC LIMIT 10', [partyId]);
    const household = await q<{ party_id: number; first_name: string; last_name: string; branch: string }>(
      'SELECT p.party_id, p.first_name, p.last_name, b.name AS branch FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.household_id = ? AND p.party_id <> ? ORDER BY p.party_id LIMIT 8',
      [base.household_id, partyId],
    );
    const staff = await this.staffNames();

    const label = (c: string) => LOAN_LABEL[c] ?? c;
    const line = (kind: 'deposit' | 'loan', id: number, name: string, r: { balance: number; balance_30d: number; fees_30d: number; rate: number; open_date: string }, extra: Partial<AccountLine> = {}): AccountLine => ({
      kind,
      name,
      suffix: String(id % 10_000).padStart(4, '0'),
      relationship: 'Primary',
      balance: r.balance,
      balance30d: r.balance_30d,
      fees30d: r.fees_30d,
      rate: r.rate,
      opened: r.open_date,
      ...extra,
    });
    const depositLines = deps.map((d) => line('deposit', d.account_id, d.deposit_category, d, d.maturity_date ? { maturity: d.maturity_date } : {}));
    const loanLines = loans.map((l) => line('loan', l.loan_id, label(l.loan_category), l, { daysPastDue: l.days_delinquent }));
    const held = new Set([...deps.map((d) => d.deposit_category), ...loans.map((l) => l.loan_category)]);
    const heldLabels = new Set([...held].map((c) => label(c).toLowerCase()));
    const totals = { deposits: depositLines.reduce((s, a) => s + a.balance, 0), loans: loanLines.reduce((s, a) => s + a.balance, 0), accounts: depositLines.length + loanLines.length, products: held.size };

    const digital = [
      { id: 'online_banking', label: 'Online banking', since: base.online_banking_since },
      { id: 'mobile', label: 'Mobile app', since: base.mobile_since },
      { id: 'mobile_deposit', label: 'Mobile deposit', since: base.mobile_deposit_since },
      { id: 'estatements', label: 'eStatements', since: base.estatements_since },
      { id: 'bill_pay', label: 'Bill pay', since: base.bill_pay_since },
    ].map((d) => ({ ...d, enrolled: d.since !== null }));
    const directDeposit = { status: base.direct_deposit_status, changed: base.direct_deposit_changed };

    const opened = [...deps.map((d) => ({ kind: 'deposit' as const, at: d.open_date })), ...loans.map((l) => ({ kind: 'loan' as const, at: l.open_date })), ...digital.filter((d) => d.since).map((d) => ({ kind: 'service' as const, at: d.since! }))];
    const growth = ([30, 60, 90] as const).map((days) => {
      const from = addDays(asOf, -days);
      const inWindow = opened.filter((o) => o.at > from && o.at <= asOf);
      const n = (k: string) => inWindow.filter((o) => o.kind === k).length;
      return { days, total: inWindow.length, services: n('service'), loan: n('loan'), deposit: n('deposit') };
    });

    const attrition: AttritionScore = { score: base.score, band: attritionBand(base.score), factors: json<ScoreFactor[]>(base.factors), model: base.model_version, runDate: base.run_date };
    const suppressed = new Set(declines.map((d) => d.suggestion_id));
    // Active suggestions at or above the threshold, without products already held or declined [BK p11, CA-30].
    const opportunities = suggestions
      .filter((s) => s.likelihood >= OPPORTUNITY_THRESHOLD && !suppressed.has(s.suggestion_id) && !heldLabels.has(s.product.toLowerCase()))
      .map((s) => ({ suggestionId: s.suggestion_id, product: s.product, likelihood: s.likelihood, reason: s.reason, referralTypeId: s.referral_type_id }));

    const alerts: MemberProfile['alerts'] = [];
    if (attrition.band === 'High') alerts.push({ code: 'attrition_high', label: `High attrition risk (${attrition.score}/10)`, tone: 'danger' });
    const now = totals.deposits;
    const before = depositLines.reduce((s, a) => s + a.balance30d, 0);
    if (before > 0 && (now - before) / before <= -0.25) alerts.push({ code: 'balance_drop', label: `Deposits down ${Math.round(((before - now) / before) * 100)}% in 30 days`, tone: 'warning' });
    for (const d of depositLines.filter((a) => a.maturity && a.maturity >= asOf && a.maturity <= addDays(asOf, 30))) alerts.push({ code: 'certificate_maturing', label: `${d.name} …${d.suffix} matures ${longDate(d.maturity!)}`, tone: 'warning' });
    if (closed && closed.n > 0) alerts.push({ code: 'closed_accounts', label: `${closed.n} account${closed.n === 1 ? '' : 's'} closed in the last 90 days`, tone: 'info' });
    for (const l of loanLines.filter((a) => (a.daysPastDue ?? 0) >= 30)) alerts.push({ code: 'delinquent', label: `${l.name} …${l.suffix} is ${l.daysPastDue} days past due`, tone: 'danger' });

    const interactions = [
      ...declines.map((d) => ({ at: d.declined_at.replace(' ', 'T').slice(0, 19), channel: 'DI', kind: 'Offer declined', summary: `Declined the ${d.product} offer`, by: d.declined_by_name })),
      ...recent.map((i) => ({ at: i.occurred_at.replace(' ', 'T'), channel: i.channel, kind: i.kind, summary: i.summary, by: i.employee_id ? (staff.get(i.employee_id) ?? null) : null })),
    ].slice(0, 10);

    return {
      partyId,
      token: this.token(partyId),
      person: this.person,
      name: party.name,
      firstName: party.firstName,
      last4: party.last4,
      branch: party.branch,
      joined: base.join_date,
      segment: base.segment_code,
      isMember: base.is_member === 1,
      asOf: build,
      alerts,
      deposits: depositLines,
      loans: loanLines,
      totals,
      digital,
      directDeposit,
      lastLogin: base.last_login,
      growth,
      crossSell: held.size,
      attrition,
      opportunities,
      declined: declines.map((d) => ({ product: d.product, until: d.suppressed_until, by: d.declined_by_name })),
      applications: {
        approved: apps.filter((a) => a.status_group === 'Approved').length,
        denied: apps.filter((a) => a.status_group === 'Denied').length,
        pending: apps.filter((a) => a.status_group === 'Pending').length,
        items: apps.map((a) => ({ product: a.product, amount: a.amount, status: a.status_group, detail: a.status_detail, applied: a.applied_date, decided: a.decided_date })),
      },
      interactions: { total: (count?.n ?? 0) + declines.length, items: interactions },
      contact: { email: maskEmail(base.email), phone: `(•••) •••-${base.phone.slice(-4)}`, preferred: base.preferred_channel },
      // Household members outside the purview are counted, never named (spec 20.7).
      household: household.map((h) => {
        const inPurview = !ctx.purviewBranches || ctx.purviewBranches.includes(h.branch);
        return inPurview ? { name: `${h.first_name} ${h.last_name}`, branch: h.branch, last4: last4Of(h.party_id), inPurview } : { name: null, branch: null, last4: null, inPurview };
      }),
    };
  }

  /**
   * relationship.next_best_conversation: topics ranked by a fixed rule (spec 24.15): open service
   * issues, then pending applications, then retention risk, then product opportunities, then digital
   * adoption gaps. The model writes the talking points; it never reorders or adds topics.
   */
  nextBestConversation(p: MemberProfile): Topic[] {
    const topics: Omit<Topic, 'id'>[] = [];
    for (const a of p.applications.items.filter((x) => x.status === 'Pending')) {
      topics.push({ kind: 'pending_application', headline: `${a.product} application is pending`, reason: `Applied ${longDate(a.applied)} for ${usd(a.amount)}; status: ${a.detail.toLowerCase()}` });
    }
    if (p.attrition.band !== 'Low') {
      const top = p.attrition.factors.filter((f) => f.weight > 0).slice(0, 2).map((f) => f.label.charAt(0).toLowerCase() + f.label.slice(1));
      topics.push({ kind: 'retention_risk', headline: `${p.attrition.band} attrition risk`, reason: `Attrition score ${p.attrition.score} on a 0–10 scale; reason: ${top.join('; ') || 'model estimate'}` });
    }
    for (const o of p.opportunities.slice(0, 2)) {
      topics.push({ kind: 'product_opportunity', headline: `Next best product: ${o.product}`, reason: `Likelihood ${o.likelihood} of 10; ${o.reason.charAt(0).toLowerCase()}${o.reason.slice(1)}`, refer: o.referralTypeId ? { product: o.product, referralTypeId: o.referralTypeId } : undefined });
    }
    const gaps = p.digital.filter((d) => !d.enrolled && (d.id === 'estatements' || d.id === 'mobile')).map((d) => d.label);
    if (p.deposits.some((d) => d.name === 'Checking') && p.directDeposit.status !== 'active') gaps.push('direct deposit');
    if (gaps.length) topics.push({ kind: 'digital_gap', headline: `Not enrolled in ${gaps.join(', ')}`, reason: `Digital use shows ${gaps.join(', ')} not set up` });
    return topics.slice(0, 5).map((t, i) => ({ ...t, id: `T${i + 1}` }));
  }

  /** predictive.scores.explain: the main factors and the model's last run date (FE-RM-002). */
  explain(p: MemberProfile, score: 'attrition' | 'next_best') {
    if (score === 'attrition') return { score: 'Attrition risk', value: `${p.attrition.score} of 10 (${p.attrition.band})`, factors: p.attrition.factors.map((f) => ({ label: f.label, effect: f.weight > 0 ? `raises the score by ${f.weight}` : `lowers the score by ${-f.weight}` })), model: p.attrition.model, runDate: p.attrition.runDate };
    return { score: 'Next best product', value: p.opportunities[0] ? `${p.opportunities[0].product} (${p.opportunities[0].likelihood} of 10)` : 'No product at or above the threshold', factors: p.opportunities.map((o) => ({ label: `${o.product}: ${o.likelihood} of 10`, effect: o.reason })), model: SCORE_MODELS.nextBest, runDate: SCORE_MODELS.runDate };
  }

  /** The suggestion a "declined" request refers to, by product name, among the active ones. */
  async findSuggestion(partyId: number, product: string, ctx: CoreContext): Promise<Opportunity | null> {
    const p = await this.profile(partyId, ctx);
    const want = product.trim().toLowerCase();
    return p.opportunities.find((o) => o.product.toLowerCase() === want) ?? p.opportunities.find((o) => o.product.toLowerCase().includes(want) || want.includes(o.product.toLowerCase())) ?? null;
  }

  /**
   * relationship.suggestion.decline: suppresses the suggestion for 90 days and records it as an
   * interaction (spec 17.2). Idempotent on the approval ID, like every approved write.
   */
  async decline(d: { partyId: number; suggestionId: number; product: string }, meta: { approvalId: string; userId: string; userName: string }, ctx: CoreContext) {
    await this.party(d.partyId, ctx);
    const build = await this.buildInfo();
    const until = addDays(build.date, DECLINE_DAYS);
    await this.pool.query(
      `INSERT INTO mod_suggestion_decline (party_id, suggestion_id, product, declined_by, declined_by_name, declined_at, suppressed_until, approval_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE decline_id = decline_id`,
      [d.partyId, d.suggestionId, d.product, meta.userId, meta.userName, sqlTime(new Date()), until, meta.approvalId],
    );
    return { product: d.product, until };
  }
}

function maskEmail(email: string) {
  const [user, domain] = email.split('@');
  return `${user!.charAt(0)}•••@${domain}`;
}
