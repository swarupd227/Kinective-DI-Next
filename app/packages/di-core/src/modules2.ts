// DI Core for operations and admin (spec 24.13, 24.14), the 5300 Call Report (24.25), collections
// early warning (24.19), campaigns (24.20) and SEG (24.22). Every figure and rule lives here. An
// access answer, a variance or a suppression count is never left to a model (AI-AGT-141, 201, 252).
import type { Pool } from '@dinext/tenant-db';
import { CoreError, memberNumber, type CoreContext } from './referrals.ts';

const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const moved = (r: unknown) => (r as { affectedRows: number }).affectedRows;

// ---- operations and admin ---------------------------------------------------------------------

export const CAPABILITIES: Record<string, string> = { approve_incentives: 'approve incentives', referrals: 'work referrals', loan_pipeline: 'see the Loan Pipeline', reports: 'open reports', compliance: 'work compliance issues', manage_users: 'manage users', data_logs: 'approve data logs', platform: 'run the platform: builds, uploads and data quality' };
export const CLASSES: Record<string, string[]> = {
  // An administrator runs the platform, not the business: no member reports, which keeps duties apart.
  Administrator: ['manage_users', 'platform'],
  Executive: ['approve_incentives', 'referrals', 'loan_pipeline', 'reports', 'compliance', 'data_logs'],
  Manager: ['approve_incentives', 'referrals', 'loan_pipeline', 'reports', 'compliance', 'data_logs'],
  Lender: ['referrals', 'loan_pipeline'],
  MSR: ['referrals'],
  Analyst: ['loan_pipeline', 'reports'],
};
export const USER_CLASSES = Object.keys(CLASSES);

export interface DirectoryUser {
  userId: string;
  name: string;
  userClass: string;
  branch: string | null;
  status: string;
}

// The checks' rules are written for engineers ("loan.branch_id not null"); people read what each one means.
export const CHECK_NAMES: Record<string, string> = {
  'loan.branch_id not null': 'Every loan has a branch',
  'share.open_date not in future': 'No deposit account opens in the future',
  'party.member_number unique': 'Every person’s number is unique',
  'core extract arrived by 03:00': 'Core extract arrived by 03:00',
  'loan balance matches the GL': 'Loan balances match the general ledger',
  'delinquency days are not negative': 'Days delinquent are never negative',
  'certificate maturity present': 'Every certificate has a maturity date',
  'share balance matches the GL': 'Deposit balances match the general ledger',
};

const SOURCE_METHODS: Record<string, string> = { 'Core extract': 'Core connection, nightly snapshot', 'Card processor': 'SFTP folder, scheduled uploader', 'Goal scores': 'File upload', 'LOS feed': 'API connection' };

export class OperationsService {
  constructor(private readonly pool: Pool) {}

  async build() {
    const [b] = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM meta_build ORDER BY as_of_date DESC LIMIT 1');
    const uploads = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM ops_upload ORDER BY source');
    // asOf is the date of the data; finishedOn is when the build finished, the moment Home's header
    // names. The build's age counts from when it finished, and two days without a new one is stale.
    const asOf = day(b?.as_of_date);
    const completedAt = b?.completed_at instanceof Date ? b.completed_at.toISOString() : String(b?.completed_at ?? '');
    const finishedOn = /^\d{4}-\d{2}-\d{2}/.test(completedAt) ? completedAt.slice(0, 10) : asOf;
    const ageDays = /^\d{4}-\d{2}-\d{2}$/.test(finishedOn) ? Math.max(0, Math.floor((Date.now() - Date.parse(`${finishedOn}T00:00:00Z`)) / 86_400_000)) : 0;
    // How each source arrives. Demo values, like the sources themselves.
    return { buildId: b?.build_id as string, asOf, finishedOn, ageDays, stale: ageDays >= 2, state: b?.state as string, completedAt, uploads: uploads.map((u) => ({ source: u.source as string, method: SOURCE_METHODS[u.source as string] ?? 'File upload', dueBy: u.due_by as string, arrived: u.arrived as string, late: u.late === 1 })) };
  }

  async checks(onlyFailed: boolean) {
    const all = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM ops_dq_check ORDER BY domain, dimension');
    const items = all.map((c) => ({ domain: c.domain as string, dimension: c.dimension as string, name: CHECK_NAMES[c.name as string] ?? (c.name as string), rule: c.name as string, passed: c.status === 'Pass', rowsFailed: c.rows_failed as number }));
    return { total: items.length, failed: items.filter((c) => !c.passed).length, items: onlyFailed ? items.filter((c) => !c.passed) : items };
  }

  private toUser = (u: Record<string, unknown>): DirectoryUser => ({ userId: u.user_id as string, name: u.name as string, userClass: u.user_class as string, branch: (u.branch as string | null) ?? null, status: u.status as string });

  async users(search?: string) {
    const all = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM iam_user ORDER BY name');
    const words = search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    return all.map(this.toUser).filter((u) => words.every((w) => `${u.name} ${u.userClass} ${u.branch ?? ''}`.toLowerCase().includes(w)));
  }

  async user(name: string) {
    const hits = await this.users(name);
    if (hits.length !== 1) throw new CoreError('NOT_FOUND', hits.length ? `More than one user matches “${name}”.` : `There’s no user called “${name}”.`);
    return hits[0]!;
  }

  /** Who holds a capability, from class alone. */
  /** Each class, what it can do and how many active people hold it (spec 8.20). */
  async classes() {
    const users = await this.users();
    return USER_CLASSES.map((c) => ({ userClass: c, capabilities: CLASSES[c]!.map((k) => CAPABILITIES[k]!), active: users.filter((u) => u.userClass === c && u.status === 'Active').length, locked: users.filter((u) => u.userClass === c && u.status !== 'Active').length }));
  }

  async whoCan(capability: string) {
    const classes = USER_CLASSES.filter((c) => CLASSES[c]!.includes(capability));
    const users = (await this.users()).filter((u) => classes.includes(u.userClass) && u.status === 'Active');
    return { classes, users };
  }

  /** iam.access.explain: a deterministic answer, naming the rule that decides it (AI-AGT-141). */
  explain(u: DirectoryUser, capability: string, branch?: string) {
    if (u.status !== 'Active') return { allowed: false, because: `${u.name}’s account is ${u.status.toLowerCase()}.` };
    if (!CLASSES[u.userClass]?.includes(capability)) return { allowed: false, because: `the ${u.userClass} class doesn’t include that.` };
    if (branch && u.branch && u.branch.toLowerCase() !== branch.toLowerCase()) return { allowed: false, because: `their purview covers ${u.branch}, not ${branch}.` };
    return { allowed: true, because: `the ${u.userClass} class includes it${u.branch ? ` and their purview covers ${u.branch}` : ''}.` };
  }

  async createUser(p: { name: string; userClass: string; branch: string | null }, meta: { approvalId: string }) {
    await this.pool.query("INSERT IGNORE INTO iam_user (user_id, name, user_class, branch, status, approval_id) VALUES (?, ?, ?, ?, 'Active', ?)", [`user:${meta.approvalId.slice(-6)}`, p.name, p.userClass, p.branch, meta.approvalId]);
  }

  async setStatus(userId: string, status: 'Active' | 'Locked') {
    await this.pool.query('UPDATE iam_user SET status = ? WHERE user_id = ?', [status, userId]);
  }

  async setClass(userId: string, userClass: string) {
    await this.pool.query('UPDATE iam_user SET user_class = ? WHERE user_id = ?', [userClass, userId]);
  }
}

// ---- 5300 Call Report -------------------------------------------------------------------------

export interface UncategorizedGl {
  glNumber: string;
  name: string;
  balance: number;
  opened: string;
  lastPosted: string;
  /** Where it most likely belongs on the 5300, for the person who maps it. */
  likelyLine: string | null;
  note: string | null;
}

export interface CallReportLine {
  code: string;
  schedule: string;
  scheduleName: string;
  section: string;
  order: number;
  name: string;
  kind: 'input' | 'total' | 'memo';
  formula: string | null;
  /** Where the figure comes from: the general ledger, the core loan or share system, the member file. */
  source: string;
  current: number | null;
  prior: number | null;
  text: string | null;
  change: number | null;
  pct: number | null;
}

export interface CallReportCheck {
  name: string;
  passed: boolean;
  detail: string;
  /** NCUA's two kinds: an Error blocks submission; a Warning needs an explanation. */
  severity: 'Error' | 'Warning';
  editCode: string | null;
  codes: string[];
}

/** Version 2025.1 of Form 5300, effective March 31, 2025 until superseded. */
export const CALL_REPORT_EDITION = 'Version 2025.1 (effective March 31, 2025)';

/** Year-to-date lines grow every quarter by design, so they are never a change to explain. */
const YEAR_TO_DATE = (l: { schedule: string; section: string; code: string }) => l.schedule === 'SIE' || l.section.startsWith('Section 3') || l.code === '031A' || l.code === '031B';

const quarterLabel = (end: string) => `Q${Math.ceil(Number(end.slice(5, 7)) / 3)} ${end.slice(0, 4)}`;

export class CallReportService {
  constructor(private readonly pool: Pool) {}

  /** The quarter being prepared and the one before it, from the values on file. */
  async quarters() {
    const q = (await rows<{ q: unknown }>(this.pool, 'SELECT DISTINCT quarter_end AS q FROM cr_value ORDER BY quarter_end DESC')).map((r) => day(r.q));
    if (!q.length) throw new CoreError('NOT_FOUND', 'No 5300 is loaded for this institution.');
    const [current, prior] = q as [string, string | undefined];
    // Due the 30th of the month after quarter end, by 11:59:59 p.m. Eastern, in CUOnline.
    const due = new Date(Date.UTC(Number(current.slice(0, 4)), Number(current.slice(5, 7)), 30));
    return { current, prior: prior ?? null, label: quarterLabel(current), priorLabel: prior ? quarterLabel(prior) : null, dueDate: due.toISOString().slice(0, 10), edition: CALL_REPORT_EDITION };
  }

  async lines(): Promise<CallReportLine[]> {
    const { current, prior } = await this.quarters();
    const lines = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cr_line ORDER BY sort_order');
    const values = await rows<Record<string, unknown>>(this.pool, 'SELECT code, quarter_end, amount, text_value FROM cr_value');
    const at = new Map(values.map((v) => [`${v.code as string}|${day(v.quarter_end)}`, v]));
    const num = (v: Record<string, unknown> | undefined) => (v?.amount === null || v?.amount === undefined ? null : Number(v.amount));
    return lines.map((l) => {
      const cur = at.get(`${l.code as string}|${current}`);
      const was = prior ? at.get(`${l.code as string}|${prior}`) : undefined;
      const c = num(cur);
      const p = num(was);
      const change = c !== null && p !== null ? c - p : null;
      return {
        code: l.code as string,
        schedule: l.schedule as string,
        scheduleName: l.schedule_name as string,
        section: l.section as string,
        order: Number(l.sort_order),
        name: l.name as string,
        kind: l.kind as CallReportLine['kind'],
        formula: (l.formula as string | null) ?? null,
        source: l.source as string,
        current: c,
        prior: p,
        text: (cur?.text_value as string | null) ?? null,
        change,
        pct: change !== null && p ? Math.round((change / Math.abs(p)) * 1000) / 10 : null,
      };
    });
  }

  /** One line, with what makes it up: its GL accounts, or for a total the lines its formula names. */
  async line(code: string) {
    const all = await this.lines();
    const l = all.find((x) => x.code.toLowerCase() === code.toLowerCase());
    if (!l) throw new CoreError('NOT_FOUND', `There’s no 5300 line ${code}. Lines are NCUA account codes such as 025B, 018 or 041B.`);
    const gl = (await rows<Record<string, unknown>>(this.pool, 'SELECT gl_number, name, balance, prior_balance FROM cr_gl_account WHERE line_code = ? ORDER BY gl_number', [l.code]).catch(() => [])).map((g) => ({ glNumber: g.gl_number as string, name: g.name as string, current: Number(g.balance), prior: Number(g.prior_balance) }));
    const named = l.formula ? [...new Set(l.formula.match(/\b[A-Z]{0,2}\d{3,4}[A-Z]?\d?\b/g) ?? [])].filter((c) => c !== l.code) : [];
    const parts = named.map((c) => all.find((x) => x.code === c)).filter((x): x is CallReportLine => !!x);
    // Totals without a printed formula add Schedule A's rows by loan type (025B, 041B, 550), or their section's inputs.
    // Loans granted year to date sit in Section 1 but are activity, not part of the balance.
    const granted = (x: CallReportLine) => /Granted Year-to-Date/i.test(x.name);
    const byType: Record<string, (x: CallReportLine) => boolean> = {
      '025B': (x) => x.section.startsWith('Section 1') && x.name.endsWith(' - Amount') && x.kind === 'input' && !granted(x),
      '025A': (x) => x.section.startsWith('Section 1') && x.name.endsWith(' - Number of Loans') && x.kind === 'input' && !granted(x),
      '041B': (x) => x.section.startsWith('Section 2') && x.name.endsWith('Total Amount of Loans Delinquent 60+ Days') && x.code !== '041B',
      '041A': (x) => x.section.startsWith('Section 2') && x.name.endsWith('Total Number of Loans Delinquent 60+ Days') && x.code !== '041A',
      '550': (x) => x.section.startsWith('Section 3') && x.name.endsWith(' - Charge Offs YTD'),
      '551': (x) => x.section.startsWith('Section 3') && x.name.endsWith(' - Recoveries YTD'),
    };
    const key = ({ '025B1': '025B', '025A1': '025A' } as Record<string, string>)[l.code] ?? l.code;
    const typed = byType[key] ? all.filter((x) => x.schedule === 'A' && byType[key]!(x) && x.current) : [];
    const section = !parts.length && !typed.length && l.kind === 'total' ? all.filter((x) => x.schedule === l.schedule && x.section === l.section && x.kind === 'input' && x.current) : typed;
    return { ...l, gl, parts: parts.length ? parts : section };
  }

  async schedule(id: string) {
    return (await this.lines()).filter((l) => l.schedule.toLowerCase() === id.toLowerCase() || l.scheduleName.toLowerCase().includes(id.toLowerCase()));
  }

  /** Lines that moved at least minPct (and $100,000) since last quarter, largest first, with their explanation. */
  async variance(minPct: number, schedule?: string) {
    const explained = await this.explanations();
    return (await this.lines())
      .filter((l) => l.change !== null && l.pct !== null && Math.abs(l.pct) >= minPct && Math.abs(l.change) >= 100_000 && (schedule ? l.schedule.toLowerCase() === schedule.toLowerCase() : !YEAR_TO_DATE(l)))
      .sort((a, b) => Math.abs(b.pct!) - Math.abs(a.pct!))
      .map((l) => ({ ...l, explanation: explained.find((e) => e.code === l.code) ?? null }));
  }

  /** The explanations a large change needs before filing: written, or still needed. */
  async explanations() {
    return (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cr_explanation ORDER BY status, code').catch(() => [])).map((e) => ({ code: e.code as string, explanation: (e.explanation as string | null) ?? null, status: e.status as 'Written' | 'Needed', by: (e.written_by as string | null) ?? null }));
  }

  /** Net worth, the ratio and the classification (Schedule G), and the CCULR election (Schedule H). */
  async capital() {
    const all = await this.lines();
    const v = (code: string) => all.find((l) => l.code === code);
    return { netWorth: v('997')!.current!, assets: v('NW0010')!.current!, ratio: v('998')!.current!, priorRatio: v('998')!.prior, classification: v('700')!.text ?? '', cculr: v('LR0001')!.text === 'Yes', complex: (v('010')!.current ?? 0) > 500_000_000 };
  }

  async readiness() {
    const checks: CallReportCheck[] = (await rows<Record<string, unknown>>(this.pool, "SELECT * FROM cr_check ORDER BY status = 'Pass', severity, name")).map((c) => ({ name: c.name as string, passed: c.status === 'Pass', detail: c.detail as string, severity: (c.severity as 'Error' | 'Warning') ?? 'Error', editCode: (c.edit_code as string | null) ?? null, codes: String(c.codes ?? '').split(',').filter(Boolean) }));
    const failed = checks.filter((c) => !c.passed);
    const errors = failed.filter((c) => c.severity === 'Error');
    return { quarter: await this.quarters(), checks, failed, errors, warnings: failed.filter((c) => c.severity === 'Warning'), ready: !errors.length, uncategorized: await this.uncategorized(), explanations: await this.explanations() };
  }

  /** GL accounts with no 5300 line: what the "GL accounts categorized" check counts. */
  async uncategorized(): Promise<UncategorizedGl[]> {
    // A tenant seeded before the table existed has no accounts to show, not an error.
    const found = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cr_gl_account WHERE line_code IS NULL ORDER BY balance DESC').catch(() => []);
    return found.map((g) => ({ glNumber: g.gl_number as string, name: g.name as string, balance: Number(g.balance), opened: day(g.opened), lastPosted: day(g.last_posted), likelyLine: (g.likely_line as string | null) ?? null, note: (g.note as string | null) ?? null }));
  }
}

// ---- collections early warning ----------------------------------------------------------------

export interface WatchedLoan {
  loanId: number;
  partyId: number;
  name: string;
  last4: string;
  category: string;
  balance: number;
  branch: string;
  score: number;
  signals: string[];
  queued: boolean;
}

const STRESS: Record<string, string> = { direct_deposit_stopped: 'direct deposit stopped', balance_drop: 'deposit balances falling', no_recent_login: 'no recent login' };

export class CollectionsService {
  constructor(private readonly pool: Pool) {}

  /** Loans still current whose borrower shows stress. Already-delinquent loans belong to collections. */
  async watchlist(ctx: CoreContext) {
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const list = await rows<Record<string, unknown>>(this.pool, `SELECT l.loan_id, l.party_id, l.loan_category, l.balance, p.first_name, p.last_name, b.name AS branch, s.score, s.factors, o.loan_id AS queued FROM cdm_loan l JOIN cdm_party p ON p.party_id = l.party_id JOIN cdm_location b ON b.int_id = l.branch_id JOIN cdm_attrition_score s ON s.party_id = l.party_id LEFT JOIN col_outreach o ON o.loan_id = l.loan_id WHERE l.days_delinquent = 0 AND l.close_date IS NULL AND s.score >= 4${scope}`, ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : []);
    const items = list
      .map((r): WatchedLoan => {
        const raw = typeof r.factors === 'string' ? JSON.parse(r.factors) : (r.factors ?? []);
        return { loanId: r.loan_id as number, partyId: r.party_id as number, name: `${String(r.first_name)} ${String(r.last_name)}`, last4: memberNumber(r.party_id as number).slice(-4), category: r.loan_category as string, balance: Number(r.balance), branch: r.branch as string, score: Number(r.score), signals: (raw as { code: string }[]).flatMap((f) => (STRESS[f.code] ? [STRESS[f.code]!] : [])), queued: r.queued !== null };
      })
      .filter((l) => l.signals.length)
      .sort((a, b) => b.score - a.score || b.balance - a.balance);
    const counts = new Map<string, number>();
    for (const l of items) for (const s of l.signals) counts.set(s, (counts.get(s) ?? 0) + 1);
    return { count: items.length, dollars: Math.round(items.reduce((n, l) => n + l.balance, 0)), signals: [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count), items };
  }

  async queue(loanIds: number[], meta: { approvalId: string; actor: string }) {
    await this.pool.query('INSERT IGNORE INTO col_outreach (loan_id, status, queued_by, approval_id) VALUES ?', [loanIds.map((id) => [id, 'Queued', meta.actor, meta.approvalId])]);
  }
}

// ---- campaigns --------------------------------------------------------------------------------

/** Removed from every audience by rule, and counted (AI-AGT-201). */
const suppressed = (partyId: number) => (partyId % 9 === 0 ? 'opt_out' : partyId % 13 === 0 ? 'recent_contact' : null);

export class CampaignService {
  constructor(private readonly pool: Pool) {}

  async results() {
    const list = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cmp_campaign ORDER BY loan_dollars DESC');
    return list.map((c) => ({ name: c.name as string, channel: c.channel as string, product: c.product as string, sent: c.sent as number, applications: c.applications as number, dollars: Number(c.loan_dollars) }));
  }

  /** Members without a product, after suppression. The rule, not a model, decides who's removed. */
  async audience(category: string, ctx: CoreContext) {
    const known = await rows<{ c: string }>(this.pool, 'SELECT DISTINCT loan_category AS c FROM cdm_loan');
    const match = known.find((k) => k.c.toLowerCase().includes(category.toLowerCase()));
    if (!match) throw new CoreError('NOT_FOUND', `There’s no loan category called ${category}. They are: ${known.map((k) => k.c).join(', ')}.`);
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const people = await rows<{ party_id: number }>(this.pool, `SELECT p.party_id FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id LEFT JOIN (SELECT DISTINCT party_id FROM cdm_loan WHERE loan_category = ? AND close_date IS NULL) l ON l.party_id = p.party_id WHERE p.is_member = 1 AND l.party_id IS NULL${scope}`, [match.c, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])]);
    const optOut = people.filter((p) => suppressed(p.party_id) === 'opt_out').length;
    const recent = people.filter((p) => suppressed(p.party_id) === 'recent_contact').length;
    return { category: match.c, found: people.length, optOut, recent, size: people.length - optOut - recent };
  }

  async save(p: { name: string; category: string; size: number }, meta: { approvalId: string; userId: string }) {
    await this.pool.query('INSERT IGNORE INTO cmp_audience (name, category, size, created_by, approval_id) VALUES (?, ?, ?, ?, ?)', [p.name.slice(0, 80), p.category, p.size, meta.userId, meta.approvalId]);
  }
}

// ---- SEG --------------------------------------------------------------------------------------

export const SEG_STAGES = ['Identification', 'Contacted', 'Meeting Held', 'Proposal', 'Submit Letter for Board Approval', 'Board Approved', 'Closed - Lost'];

export interface SegCompany {
  companyId: number;
  name: string;
  stage: string;
  members: number;
  newMembers: number;
  loans: number;
  deposits: number;
  owner: string | null;
  sponsorship: string | null;
}

export class SegService {
  constructor(private readonly pool: Pool) {}

  private toCompany = (c: Record<string, unknown>): SegCompany => ({ companyId: c.company_id as number, name: c.name as string, stage: c.stage as string, members: c.members as number, newMembers: c.new_members as number, loans: Number(c.loans), deposits: Number(c.deposits), owner: (c.owner as string | null) ?? null, sponsorship: (c.sponsorship as string | null) ?? null });

  async companies() {
    return (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM seg_company ORDER BY new_members DESC')).map(this.toCompany);
  }

  async company(name: string) {
    const words = name.toLowerCase().split(/\s+/);
    const hits = (await this.companies()).filter((c) => words.every((w) => c.name.toLowerCase().includes(w)));
    if (hits.length !== 1) throw new CoreError('NOT_FOUND', hits.length ? `More than one company matches “${name}”.` : `There’s no company called “${name}”.`);
    const c = hits[0]!;
    const log = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM seg_interaction WHERE company_id = ? ORDER BY interaction_id DESC LIMIT 3', [c.companyId]);
    return { ...c, interactions: log.map((i) => ({ at: day(i.at), kind: i.kind as string, note: i.note as string, by: i.by_name as string })) };
  }

  async log(p: { companyId: number; kind: string; note: string }, meta: { approvalId: string; actor: string; on: string }) {
    await this.pool.query('INSERT IGNORE INTO seg_interaction (company_id, at, kind, note, by_name, approval_id) VALUES (?, ?, ?, ?, ?, ?)', [p.companyId, meta.on, p.kind, p.note.slice(0, 300), meta.actor, meta.approvalId]);
  }

  async setStage(companyId: number, stage: string, note: string | null, meta: { approvalId: string; actor: string; on: string }) {
    if (!moved(await this.pool.query('UPDATE seg_company SET stage = ? WHERE company_id = ?', [stage, companyId]).then((r) => r[0]))) throw new CoreError('NOT_FOUND', 'That company no longer exists.');
    await this.log({ companyId, kind: 'Stage change', note: `Moved to ${stage}${note ? `. ${note}` : ''}` }, meta);
  }
}
