// DI Core for operations and admin (spec 24.13, 24.14), the 5300 Call Report (24.25), collections
// early warning (24.19), campaigns (24.20) and SEG (24.22). Every figure and rule lives here. An
// access answer, a variance or a suppression count is never left to a model (AI-AGT-141, 201, 252).
import type { Pool } from '@dinext/tenant-db';
import { carryUp, crParents, CR_LOAN_TYPES } from '@dinext/tenant-db';
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
  /** DI's own figure before manual adjustments, and the adjustment carried onto this line (0 when none). */
  computed: number | null;
  adjusted: number;
}

/** How a difference from the prepared figures was settled. "Prepared correct" records an adjustment. */
export const CR_RESOLUTIONS = ['DI correct', 'Prepared correct', 'Explained'] as const;
export type CrResolution = (typeof CR_RESOLUTIONS)[number];
/** Why a manual adjustment was made (DI's Correction Reason). */
export const CR_ADJUST_REASONS = ['Timing', 'Participation', 'Mapping', 'Off-core loans', 'Correction', 'Other'] as const;
export type CrAdjustReason = (typeof CR_ADJUST_REASONS)[number];

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
const YEAR_TO_DATE = (l: { schedule: string; section: string; code: string }) => l.schedule === 'SIE' || l.schedule.startsWith('RI') || l.section.startsWith('Section 3') || l.code === '031A' || l.code === '031B';

const quarterLabel = (end: string) => `Q${Math.ceil(Number(end.slice(5, 7)) / 3)} ${end.slice(0, 4)}`;

export class CallReportService {
  constructor(private readonly pool: Pool) {}

  /** Which form this institution files (the 5300 or the FFIEC 051), its edition, and where it's filed. */
  async form() {
    const [f] = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cr_form LIMIT 1').catch(() => []);
    return f ? { form: String(f.form), edition: String(f.edition), filedIn: String(f.filed_in), preparer: String(f.preparer) } : { form: '5300', edition: CALL_REPORT_EDITION, filedIn: 'CUOnline', preparer: '' };
  }

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
    // Approved manual adjustments, carried up through the totals above each adjusted line.
    const adj = await rows<{ code: string; total: number }>(this.pool, 'SELECT code, SUM(amount) AS total FROM cr_adjustment WHERE quarter_end = ? GROUP BY code', [current]).catch(() => []);
    const carried = adj.length ? carryUp(this.shapes(lines), new Map(adj.map((a) => [a.code, Number(a.total)]))) : new Map<string, number>();
    return lines.map((l) => {
      const cur = at.get(`${l.code as string}|${current}`);
      const was = prior ? at.get(`${l.code as string}|${prior}`) : undefined;
      const computed = num(cur);
      const adjusted = Math.round((carried.get(l.code as string) ?? 0) * 100) / 100;
      const c = computed === null && !adjusted ? null : (computed ?? 0) + adjusted;
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
        computed,
        adjusted,
      };
    });
  }

  private shapes(lines: Record<string, unknown>[]) {
    return lines.map((l) => ({ code: l.code as string, schedule: l.schedule as string, section: l.section as string, kind: l.kind as string, name: l.name as string, formula: (l.formula as string | null) ?? null }));
  }

  /** The manual adjustments this quarter: each is its own row, with who made it and why. */
  async adjustments() {
    const { current } = await this.quarters();
    const found = await rows<Record<string, unknown>>(this.pool, 'SELECT a.*, l.name FROM cr_adjustment a LEFT JOIN cr_line l ON l.code = a.code WHERE a.quarter_end = ? ORDER BY a.adjustment_id', [current]).catch(() => []);
    return found.map((a) => ({ id: Number(a.adjustment_id), code: a.code as string, name: (a.name as string | null) ?? '', amount: Number(a.amount), reason: a.reason as CrAdjustReason, note: a.note as string, by: a.made_by as string, at: String(a.made_at instanceof Date ? a.made_at.toISOString() : a.made_at).slice(0, 16).replace('T', ' ') }));
  }

  /** What an adjustment would do: the line and every total it carries into, before and after. */
  async previewAdjustment(code: string, amount: number) {
    const all = await this.lines();
    const l = all.find((x) => x.code.toLowerCase() === code.toLowerCase());
    if (!l) throw new CoreError('NOT_FOUND', `There’s no line ${code} on this Call Report.`);
    if (l.kind !== 'input') throw new CoreError('INVALID', `${l.code} is a total. Adjust the line underneath it that’s wrong; the totals follow.`);
    const lineRows = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cr_line');
    const carried = carryUp(this.shapes(lineRows), new Map([[l.code, amount]]));
    const touched = [...carried].map(([c, d]) => ({ line: all.find((x) => x.code === c)!, delta: d })).filter((t) => t.line);
    return { line: l, touched };
  }

  async adjust(p: { code: string; amount: number; reason: CrAdjustReason; note: string }, meta: { by: string; approvalId: string }) {
    const { current } = await this.quarters();
    const [done] = await this.pool.query('SELECT adjustment_id FROM cr_adjustment WHERE approval_id = ?', [meta.approvalId]);
    if ((done as unknown[]).length) return { replayed: true };
    await this.pool.query('INSERT INTO cr_adjustment (code, quarter_end, amount, reason, note, made_by, made_at, approval_id) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)', [p.code, current, p.amount, p.reason, p.note.slice(0, 300), meta.by, meta.approvalId]);
    return { replayed: false };
  }

  /**
   * DI's figures against the institution's own prepared ones (DI's "CU Amount" check): every line that
   * differs by a dollar or more, whether the difference starts on that line or only follows from a line
   * under it, and how each was settled.
   */
  async reconcile() {
    const { current } = await this.quarters();
    const upload = (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cr_prepared_upload WHERE quarter_end = ?', [current]).catch(() => []))[0];
    if (!upload) return null;
    const prepared = new Map((await rows<{ code: string; amount: unknown }>(this.pool, 'SELECT code, amount FROM cr_prepared WHERE quarter_end = ?', [current])).map((r) => [r.code, r.amount === null ? null : Number(r.amount)]));
    const settled = new Map((await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cr_resolution WHERE quarter_end = ?', [current]).catch(() => [])).map((r) => [r.code as string, { resolution: r.resolution as CrResolution, reason: r.reason as string, by: r.decided_by as string }]));
    const all = await this.lines();
    const diffs = all
      .filter((l) => prepared.has(l.code) && l.code !== '998' && !/ratio/i.test(l.name))
      .map((l) => ({ line: l, prepared: prepared.get(l.code)!, di: l.current ?? 0 }))
      .filter((d) => d.prepared !== null && Math.abs(d.prepared - d.di) >= 1)
      .map((d) => ({ ...d, difference: Math.round((d.prepared! - d.di) * 100) / 100 }));
    // A difference that only follows from a line under it is settled there.
    const lineRows = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cr_line');
    const fromInputs = carryUp(this.shapes(lineRows), new Map(diffs.filter((d) => d.line.kind === 'input').map((d) => [d.line.code, d.difference])), crParents(this.shapes(lineRows)));
    const items = diffs.map((d) => {
      const follows = d.line.kind !== 'input' && Math.abs((fromInputs.get(d.line.code) ?? 0) - d.difference) < 1;
      return { code: d.line.code, name: d.line.name, schedule: d.line.schedule, kind: d.line.kind, prepared: d.prepared!, di: d.di, difference: d.difference, pct: d.di ? Math.round((d.difference / Math.abs(d.di)) * 10000) / 100 : null, follows, resolution: settled.get(d.line.code) ?? null };
    });
    const compared = all.filter((l) => prepared.has(l.code)).length;
    return { quarter: current, upload: { file: upload.file_name as string, by: upload.uploaded_by as string, at: String(upload.uploaded_at instanceof Date ? upload.uploaded_at.toISOString() : upload.uploaded_at).slice(0, 10), lines: Number(upload.line_count) }, compared, matched: compared - items.length, items, open: items.filter((i) => !i.follows && !i.resolution) };
  }

  /** Settle a difference. "Prepared correct" also records the adjustment that makes DI match. */
  async resolve(p: { code: string; resolution: CrResolution; reason: string; adjustment?: number }, meta: { by: string; approvalId: string }) {
    const { current } = await this.quarters();
    await this.pool.query('INSERT INTO cr_resolution (code, quarter_end, resolution, reason, decided_by, decided_at, approval_id) VALUES (?, ?, ?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE resolution = VALUES(resolution), reason = VALUES(reason), decided_by = VALUES(decided_by), decided_at = VALUES(decided_at), approval_id = VALUES(approval_id)', [p.code, current, p.resolution, p.reason.slice(0, 300), meta.by, meta.approvalId]);
    if (p.resolution === 'Prepared correct' && p.adjustment) await this.adjust({ code: p.code, amount: p.adjustment, reason: 'Correction', note: p.reason }, { by: meta.by, approvalId: `${meta.approvalId}.adj` });
  }

  /** Write or replace the explanation NCUA asks for on a large change. */
  async explain(code: string, text: string, by: string) {
    const { current } = await this.quarters();
    await this.pool.query("INSERT INTO cr_explanation (code, quarter_end, explanation, status, written_by) VALUES (?, ?, ?, 'Written', ?) ON DUPLICATE KEY UPDATE explanation = VALUES(explanation), status = 'Written', written_by = VALUES(written_by)", [code, current, text.slice(0, 400), by]);
  }

  /**
   * The quarter as XML: each account code and its value after adjustments, with the form, period and
   * whether edits are still open. DI's own layout, for Call Report software or to map to the filing
   * system's import format; it isn't NCUA's or the FFIEC's published schema.
   */
  async xml(institution: string) {
    const [f, q, lines, r, adj] = await Promise.all([this.form(), this.quarters(), this.lines(), this.readiness(), this.adjustments()]);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const items = lines.filter((l) => l.current !== null || l.text).map((l) => `    <Item code="${esc(l.code)}" schedule="${esc(l.schedule)}">${l.text !== null ? esc(l.text) : String(l.current)}</Item>`);
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<CallReport form="${esc(f.form)}" edition="${esc(f.edition)}" periodEnd="${q.current}" institution="${esc(institution)}" status="${r.ready ? 'Final' : 'Draft'}" generatedBy="Kinective DI">`,
      `  <Edits errors="${r.errors.length}" warnings="${r.warnings.length}"/>`,
      `  <Adjustments count="${adj.length}">${adj.map((a) => `\n    <Adjustment code="${esc(a.code)}" amount="${a.amount}" reason="${esc(a.reason)}" by="${esc(a.by)}">${esc(a.note)}</Adjustment>`).join('')}${adj.length ? '\n  ' : ''}</Adjustments>`,
      '  <Items>',
      ...items,
      '  </Items>',
      '</CallReport>',
      '',
    ].join('\n');
  }

  /** One line, with what makes it up: its GL accounts, or for a total the lines its formula names. */
  async line(code: string) {
    const all = await this.lines();
    const l = all.find((x) => x.code.toLowerCase() === code.toLowerCase());
    if (!l) throw new CoreError('NOT_FOUND', `There’s no 5300 line ${code}. Lines are NCUA account codes such as 025B, 018 or 041B.`);
    const gl = (await rows<Record<string, unknown>>(this.pool, 'SELECT gl_number, name, balance, prior_balance FROM cr_gl_account WHERE line_code = ? ORDER BY gl_number', [l.code]).catch(() => [])).map((g) => ({ glNumber: g.gl_number as string, name: g.name as string, current: Number(g.balance), prior: Number(g.prior_balance) }));
    // NCUA account codes (025B, 041B) or FFIEC MDRM codes (RCON2122, RIAD4074).
    const named = l.formula ? [...new Set(l.formula.match(/\b(?:RCON|RIAD)[A-Z0-9]{4}\b|\b[A-Z]{0,2}\d{3,4}[A-Z]?\d?\b/g) ?? [])].filter((c) => c !== l.code) : [];
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
  /**
   * The loan or deposit trial balance (DI's 5300 trial balance tabs): each product category's balance
   * and count from the core, the 5300 lines it feeds, what those lines say this quarter, and the gap.
   */
  async trialBalance(kind: 'loan' | 'deposit') {
    const all = await this.lines();
    const amt = (code: string) => all.find((l) => l.code === code)?.current ?? 0;
    if (kind === 'deposit') {
      const cats = await rows<{ c: string; n: number; bal: unknown }>(this.pool, 'SELECT deposit_category AS c, COUNT(*) AS n, SUM(balance) AS bal FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY deposit_category ORDER BY bal DESC');
      const core = cats.reduce((s, r) => s + Number(r.bal), 0);
      return { kind, rows: cats.map((r) => ({ category: r.c, accounts: Number(r.n), balance: Math.round(Number(r.bal)), lines: '013 Member Shares of All Types' })), core: Math.round(core), reported: amt('013'), difference: Math.round(amt('013') - core) };
    }
    const cats = await rows<{ c: string; n: number; bal: unknown }>(this.pool, 'SELECT loan_category AS c, COUNT(*) AS n, SUM(balance) AS bal FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL AND balance > 0 GROUP BY loan_category ORDER BY bal DESC');
    const out = cats.map((r) => {
      const maps = CR_LOAN_TYPES.filter((t) => t[0] === r.c);
      const reported = maps.reduce((s, t) => s + amt(t[3]), 0);
      return { category: r.c, accounts: Number(r.n), balance: Math.round(Number(r.bal)), lines: maps.map((t) => `${t[3]} ${t[4]}`).join('; ') || 'Not on a 5300 loan line', reported: Math.round(reported), difference: Math.round(reported - Number(r.bal)) };
    });
    return { kind, rows: out, core: out.reduce((s, r) => s + r.balance, 0), reported: out.reduce((s, r) => s + r.reported, 0), difference: out.reduce((s, r) => s + r.difference, 0) };
  }

  /**
   * The 5300 loan amount lines as the loan products would report them (each product carries its line),
   * beside what the 5300 reports with today's category split. Informational: the 5300 keeps its mapping.
   */
  async productLines() {
    const found = await rows<{ code: string; n: number; bal: unknown }>(this.pool, "SELECT p.reg_amount_code AS code, COUNT(*) AS n, SUM(l.balance) AS bal FROM cdm_account_product ap JOIN cdm_loan_product p ON p.product_id = ap.product_id JOIN cdm_loan l ON l.loan_id = ap.account_id WHERE ap.account_kind = 'loan' AND p.reg_amount_code IS NOT NULL AND l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0 GROUP BY p.reg_amount_code").catch(() => null);
    if (found === null) return null;
    const all = await this.lines();
    return found.map((f) => {
      const line = all.find((l) => l.code === f.code);
      const byProduct = Math.round(Number(f.bal));
      return { code: f.code, name: line?.name ?? f.code, loans: Number(f.n), byProduct, reported: Math.round(line?.current ?? 0), difference: Math.round(byProduct - (line?.current ?? 0)) };
    }).sort((a, b) => b.byProduct - a.byProduct);
  }

  /** A GL account and where it can go: the line named, which must be an input line. */
  async glMapPreview(glNumber: string, code: string) {
    const [g] = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cr_gl_account WHERE gl_number = ?', [glNumber]).catch(() => []);
    if (!g) throw new CoreError('NOT_FOUND', `There’s no GL account ${glNumber} in the 5300 mapping.`);
    const p = await this.previewAdjustment(code, Number(g.balance));
    return { gl: { glNumber: g.gl_number as string, name: g.name as string, balance: Number(g.balance), from: (g.line_code as string | null) ?? null }, ...p };
  }

  /** Maps a GL account to a line, and carries its balance into that line (and out of the old one) as a Mapping adjustment. */
  async mapGl(p: { glNumber: string; code: string; from: string | null; balance: number }, meta: { by: string; approvalId: string }) {
    await this.pool.query('UPDATE cr_gl_account SET line_code = ? WHERE gl_number = ?', [p.code, p.glNumber]);
    await this.adjust({ code: p.code, amount: p.balance, reason: 'Mapping', note: `GL ${p.glNumber} mapped to ${p.code}.` }, { by: meta.by, approvalId: `${meta.approvalId}:to`.slice(0, 40) });
    if (p.from) await this.adjust({ code: p.from, amount: -p.balance, reason: 'Mapping', note: `GL ${p.glNumber} moved from ${p.from} to ${p.code}.` }, { by: meta.by, approvalId: `${meta.approvalId}:from`.slice(0, 40) });
  }

  /** A loan and the 5300 lines its category can sit on (Auto and Business split across two). */
  async loanForOverride(loanId: number) {
    const [l] = await rows<{ loan_id: number; loan_category: string; balance: unknown; first_name: string; last_name: string }>(this.pool, 'SELECT l.loan_id, l.loan_category, l.balance, p.first_name, p.last_name FROM cdm_loan l JOIN cdm_party p ON p.party_id = l.party_id WHERE l.loan_id = ? AND l.close_date IS NULL AND l.charge_off_date IS NULL', [loanId]);
    if (!l) throw new CoreError('NOT_FOUND', `Loan ${loanId} isn’t an open loan on this 5300.`);
    const [o] = await rows<{ to_code: string }>(this.pool, 'SELECT to_code FROM cr_loan_override WHERE loan_id = ?', [loanId]).catch(() => []);
    const lines = CR_LOAN_TYPES.filter((t) => t[0] === l.loan_category).map((t) => ({ code: t[3], name: t[4] }));
    return { loanId: l.loan_id, borrower: `${l.first_name} ${l.last_name}`, category: l.loan_category, balance: Number(l.balance), lines, overriddenTo: o?.to_code ?? null };
  }

  /** The 5300 loan amount lines, for choosing where a loan belongs. */
  loanLines() {
    return [...new Map(CR_LOAN_TYPES.map((t) => [t[3], { code: t[3], name: t[4] }])).values()];
  }

  /** Records a per-loan category override and moves its balance between the two lines as a pair of Mapping adjustments. */
  async overrideLoan(p: { loanId: number; from: string; to: string; amount: number; reason: string }, meta: { by: string; approvalId: string }) {
    const { current } = await this.quarters();
    await this.pool.query('INSERT INTO cr_loan_override (loan_id, quarter_end, from_code, to_code, amount, reason, decided_by, decided_at, approval_id) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE to_code = VALUES(to_code), reason = VALUES(reason), decided_by = VALUES(decided_by), decided_at = NOW(), approval_id = VALUES(approval_id)', [p.loanId, current, p.from, p.to, p.amount, p.reason.slice(0, 300), meta.by, meta.approvalId]);
    await this.adjust({ code: p.from, amount: -p.amount, reason: 'Mapping', note: `Loan ${p.loanId} reported on ${p.to} instead: ${p.reason}`.slice(0, 300) }, { by: meta.by, approvalId: `${meta.approvalId}:from`.slice(0, 40) });
    await this.adjust({ code: p.to, amount: p.amount, reason: 'Mapping', note: `Loan ${p.loanId} moved from ${p.from}: ${p.reason}`.slice(0, 300) }, { by: meta.by, approvalId: `${meta.approvalId}:to`.slice(0, 40) });
  }

  /**
   * An uploaded charge-off and recovery file against DI's lines: each row's loan sets its category and
   * so its 5300 charge-off or recovery line; totals by line beside what DI reports, and the gap.
   */
  async chargeoffCheck(list: { loanId?: number; category?: string; kind: 'Charge-off' | 'Recovery'; amount: number; posted?: string }[]) {
    const all = await this.lines();
    const problems: { row: number; problem: string }[] = [];
    const placed: { loanId: number | null; category: string; kind: string; amount: number; posted: string | null; code: string }[] = [];
    for (const [i, r] of list.entries()) {
      let category = r.category;
      if (r.loanId) {
        const [l] = await rows<{ loan_category: string }>(this.pool, 'SELECT loan_category FROM cdm_loan WHERE loan_id = ?', [r.loanId]);
        if (!l) {
          problems.push({ row: i + 2, problem: `Loan ${r.loanId} isn’t in the core.` });
          continue;
        }
        category = l.loan_category;
      }
      const maps = CR_LOAN_TYPES.filter((t) => t[0].toLowerCase() === (category ?? '').toLowerCase()).sort((a, b) => b[1] - a[1]);
      if (!maps.length) {
        problems.push({ row: i + 2, problem: `“${category ?? 'blank'}” isn’t a loan category on the 5300.` });
        continue;
      }
      const t = maps[0]!;
      placed.push({ loanId: r.loanId ?? null, category: t[0], kind: r.kind, amount: r.amount, posted: r.posted ?? null, code: r.kind === 'Recovery' ? t[6] : t[5] });
    }
    const codes = [...new Set(placed.map((p) => p.code))];
    const byLine = codes.map((code) => {
      const file = placed.filter((p) => p.code === code).reduce((s, p) => s + p.amount, 0);
      const line = all.find((l) => l.code === code);
      const di = line?.current ?? 0;
      return { code, name: line?.name ?? code, file: Math.round(file * 100) / 100, di, difference: Math.round((file - di) * 100) / 100 };
    });
    return { placed, problems, byLine };
  }

  /** Keeps the uploaded rows and adjusts each line that differs to the file's total. */
  async applyChargeoffs(p: { file: string; placed: { loanId: number | null; category: string; kind: string; amount: number; posted: string | null; code: string }[]; byLine: { code: string; difference: number }[] }, meta: { by: string; approvalId: string }) {
    const { current } = await this.quarters();
    const [done] = await this.pool.query('SELECT 1 FROM cr_chargeoff_upload WHERE approval_id = ? LIMIT 1', [meta.approvalId]);
    if (!(done as unknown[]).length && p.placed.length) {
      await this.pool.query('INSERT INTO cr_chargeoff_upload (quarter_end, file_name, loan_id, category, kind, amount, posted, line_code, uploaded_by, approval_id) VALUES ?', [p.placed.map((r) => [current, p.file.slice(0, 120), r.loanId, r.category, r.kind, r.amount, r.posted, r.code, meta.by, meta.approvalId])]);
    }
    for (const [i, l] of p.byLine.filter((x) => Math.abs(x.difference) >= 0.01).entries()) {
      await this.adjust({ code: l.code, amount: l.difference, reason: 'Correction', note: `From the charge-off and recovery upload ${p.file}.`.slice(0, 300) }, { by: meta.by, approvalId: `${meta.approvalId}:${i}`.slice(0, 40) });
    }
  }

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
  /** A HELOC whose draw period ends soon: the day it ends and the monthly payment before and after. */
  draw?: { ends: string; paymentNow: number; paymentAfter: number; balloon: boolean };
}

/** HELOCs draw for ten years, then repay over the rest of the term; a ten-year line is due in full. */
export const HELOC_DRAW_MONTHS = 120;
/** How far ahead an end of draw puts a current HELOC on the list. */
export const HELOC_DRAW_HORIZON_MONTHS = 12;
export const HELOC_DRAW_SIGNAL = 'HELOC draw period ending';

const STRESS: Record<string, string> = { direct_deposit_stopped: 'direct deposit stopped', balance_drop: 'deposit balances falling', no_recent_login: 'no recent login' };

export class CollectionsService {
  constructor(private readonly pool: Pool) {}

  /**
   * Borrowers with an open loan whose credit score has slid: the latest quarterly pull against the
   * score a year before (or at application, if later), largest drop first. From the score history.
   */
  async scoreDrops(ctx: CoreContext, minDrop = 40) {
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const hist = await rows<{ party_id: number; as_of: unknown; score: number }>(
      this.pool,
      `SELECT h.party_id, h.as_of, h.score FROM cdm_credit_score_history h JOIN cdm_party p ON p.party_id = h.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id
        WHERE h.score_type = 'FICO 8' AND EXISTS (SELECT 1 FROM cdm_loan l WHERE l.party_id = h.party_id AND l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0)${scope}
        ORDER BY h.party_id, h.as_of`,
      ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [],
    ).catch(() => null);
    if (hist === null) return { loaded: false, items: [] as { partyId: number; name: string; last4: string; branch: string; from: number; fromDate: string; to: number; toDate: string; drop: number; loans: number }[] };
    const byParty = new Map<number, { at: string; score: number }[]>();
    for (const h of hist) (byParty.get(h.party_id) ?? byParty.set(h.party_id, []).get(h.party_id)!).push({ at: day(h.as_of), score: Number(h.score) });
    const drops: { partyId: number; from: number; fromDate: string; to: number; toDate: string; drop: number }[] = [];
    for (const [partyId, list] of byParty) {
      const last = list.at(-1)!;
      const yearAgo = new Date(Date.parse(`${last.at}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
      // The score about a year ago: the last one on or before that date if it is no more than a quarter
      // older, otherwise the first one after it (a newer application). Never a years-old application score.
      const quarterBefore = new Date(Date.parse(`${yearAgo}T00:00:00Z`) - 92 * 86_400_000).toISOString().slice(0, 10);
      const prior = list.filter((x) => x.at <= yearAgo).at(-1);
      const base = prior && prior.at >= quarterBefore ? prior : list.find((x) => x.at > yearAgo);
      if (!base || base.at === last.at) continue;
      const drop = base.score - last.score;
      if (drop >= minDrop) drops.push({ partyId, from: base.score, fromDate: base.at, to: last.score, toDate: last.at, drop });
    }
    drops.sort((a, b) => b.drop - a.drop);
    const top = drops.slice(0, 200);
    if (!top.length) return { loaded: true, items: [] };
    const info = await rows<{ party_id: number; first_name: string; last_name: string; branch: string; loans: unknown }>(
      this.pool,
      `SELECT p.party_id, p.first_name, p.last_name, b.name AS branch, (SELECT COALESCE(SUM(l.balance), 0) FROM cdm_loan l WHERE l.party_id = p.party_id AND l.close_date IS NULL AND l.charge_off_date IS NULL) AS loans
         FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.party_id IN (?)`,
      [top.map((d) => d.partyId)],
    );
    const by = new Map(info.map((i) => [i.party_id, i]));
    return { loaded: true, total: drops.length, items: top.map((d) => ({ ...d, name: `${by.get(d.partyId)?.first_name} ${by.get(d.partyId)?.last_name}`, last4: memberNumber(d.partyId).slice(-4), branch: by.get(d.partyId)?.branch ?? '', loans: Math.round(Number(by.get(d.partyId)?.loans ?? 0)) })) };
  }

  /** Loans still current whose borrower shows stress. Already-delinquent loans belong to collections. */
  async watchlist(ctx: CoreContext) {
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const list = await rows<Record<string, unknown>>(this.pool, `SELECT l.loan_id, l.party_id, l.loan_category, l.balance, p.first_name, p.last_name, b.name AS branch, s.score, s.factors, o.loan_id AS queued FROM cdm_loan l JOIN cdm_party p ON p.party_id = l.party_id JOIN cdm_location b ON b.int_id = l.branch_id JOIN cdm_attrition_score s ON s.party_id = l.party_id LEFT JOIN col_outreach o ON o.loan_id = l.loan_id WHERE l.days_delinquent = 0 AND l.close_date IS NULL AND s.score >= 4${scope}`, ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : []);
    const items = list
      .map((r): WatchedLoan => {
        const raw = typeof r.factors === 'string' ? JSON.parse(r.factors) : (r.factors ?? []);
        return { loanId: r.loan_id as number, partyId: r.party_id as number, name: `${String(r.first_name)} ${String(r.last_name)}`, last4: memberNumber(r.party_id as number).slice(-4), category: r.loan_category as string, balance: Number(r.balance), branch: r.branch as string, score: Number(r.score), signals: (raw as { code: string }[]).flatMap((f) => (STRESS[f.code] ? [STRESS[f.code]!] : [])), queued: r.queued !== null };
      })
      .filter((l) => l.signals.length);
    // HELOCs reaching the end of their draw, whatever the borrower's score: the payment jumps from interest
    // only to principal and interest, or the whole balance falls due.
    const [b] = await rows<{ d: unknown }>(this.pool, "SELECT as_of_date AS d FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
    const asOf = b?.d ? day(b.d) : new Date().toISOString().slice(0, 10);
    const drawEnd = `DATE_ADD(l.open_date, INTERVAL ${HELOC_DRAW_MONTHS} MONTH)`;
    const helocs = await rows<Record<string, unknown>>(
      this.pool,
      `SELECT l.loan_id, l.party_id, l.loan_category, l.balance, l.rate, l.term_months, ${drawEnd} AS draw_end, p.first_name, p.last_name, b.name AS branch, s.score, s.factors, o.loan_id AS queued FROM cdm_loan l JOIN cdm_party p ON p.party_id = l.party_id JOIN cdm_location b ON b.int_id = l.branch_id LEFT JOIN cdm_attrition_score s ON s.party_id = l.party_id LEFT JOIN col_outreach o ON o.loan_id = l.loan_id WHERE l.loan_category = 'HELOC' AND l.days_delinquent = 0 AND l.close_date IS NULL AND l.balance > 0 AND ${drawEnd} > ? AND ${drawEnd} <= DATE_ADD(?, INTERVAL ${HELOC_DRAW_HORIZON_MONTHS} MONTH)${scope}`,
      [asOf, asOf, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])],
    );
    const byLoan = new Map(items.map((l) => [l.loanId, l]));
    for (const r of helocs) {
      const balance = Number(r.balance);
      const rate = Number(r.rate) / 1200;
      const left = Number(r.term_months ?? HELOC_DRAW_MONTHS) - HELOC_DRAW_MONTHS;
      const draw = { ends: day(r.draw_end), paymentNow: Math.round(balance * rate), paymentAfter: Math.round(left > 0 ? (balance * rate) / (1 - Math.pow(1 + rate, -left)) : balance), balloon: left <= 0 };
      const known = byLoan.get(r.loan_id as number);
      if (known) {
        known.signals.push(HELOC_DRAW_SIGNAL);
        known.draw = draw;
        continue;
      }
      const raw = typeof r.factors === 'string' ? JSON.parse(r.factors) : (r.factors ?? []);
      const signals = [...(raw as { code: string }[]).flatMap((f) => (STRESS[f.code] ? [STRESS[f.code]!] : [])), HELOC_DRAW_SIGNAL];
      items.push({ loanId: r.loan_id as number, partyId: r.party_id as number, name: `${String(r.first_name)} ${String(r.last_name)}`, last4: memberNumber(r.party_id as number).slice(-4), category: r.loan_category as string, balance, branch: r.branch as string, score: Number(r.score ?? 0), signals, queued: r.queued !== null, draw });
    }
    // Most signals first, then the borrower's score and the balance at stake.
    items.sort((a, b) => b.signals.length - a.signals.length || b.score - a.score || b.balance - a.balance);
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

/**
 * What a campaign's incremental dollars are worth: the product's contribution per dollar a year (after
 * funding, credit and servicing, as in Profitability), the years it typically stays on the books, and a
 * fee per response for services. Certificates bought at a special rate cost more than their funding is worth.
 */
const CAMPAIGN_VALUE: Record<string, [marginPerYear: number, years: number, feePerResponse: number]> = {
  HELOC: [0.034, 4, 0],
  Auto: [0.0185, 2.5, 0],
  'Credit Card': [0.077, 2, 0],
  'First mortgage': [0.008, 6, 0],
  'Personal Loan': [0.03, 2, 0],
  Certificate: [-0.0027, 1, 0],
  Checking: [0.028, 5, 0],
};

export class CampaignService {
  constructor(private readonly pool: Pool) {}

  async results() {
    const list = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cmp_campaign ORDER BY loan_dollars DESC');
    return list.map((c) => {
      const sent = Number(c.sent);
      const applications = Number(c.applications);
      const control = Number(c.control_size ?? 0);
      const controlResponders = Number(c.control_responders ?? 0);
      const responseRate = sent ? applications / sent : 0;
      const controlRate = control ? controlResponders / control : null;
      // Lift: what the campaign caused, over what the held-back control group did anyway.
      const incremental = controlRate === null ? null : Math.max(0, applications - sent * controlRate);
      const share = incremental === null || !applications ? null : incremental / applications;
      const dollars = Number(c.loan_dollars);
      const depositDollars = Number(c.deposit_dollars ?? 0);
      const product = String(c.product);
      const [margin, years, fee] = CAMPAIGN_VALUE[product] ?? [0.02, 2, 0];
      const incrementalDollars = share === null ? null : (dollars + depositDollars) * share;
      // Lifetime contribution of what the campaign caused (or the fee, for a service like skip-a-payment), against its cost.
      // A campaign that raises no balances (skip-a-payment) earns its service fee per response.
      const perResponse = dollars + depositDollars === 0 ? 35 : fee;
      const value = incrementalDollars === null ? null : incrementalDollars * margin * years + (incremental ?? 0) * perResponse;
      const cost = Number(c.cost ?? 0);
      return {
        name: c.name as string,
        channel: c.channel as string,
        product,
        sent,
        applications,
        dollars,
        depositDollars,
        launched: c.launched ? (c.launched instanceof Date ? c.launched.toISOString().slice(0, 10) : String(c.launched).slice(0, 10)) : null,
        responseRatePct: responseRate * 100,
        controlRatePct: controlRate === null ? null : controlRate * 100,
        liftPts: controlRate === null ? null : (responseRate - controlRate) * 100,
        incremental: incremental === null ? null : Math.round(incremental),
        incrementalDollars,
        cost,
        value,
        roiPct: value === null || !cost ? null : ((value - cost) / cost) * 100,
      };
    });
  }

  /** Return on spend by quarter launched and channel: spend, value caused and return, oldest quarter first. */
  async history() {
    const all = (await this.results()).filter((c) => c.launched && c.value !== null);
    const quarter = (d: string) => `Q${Math.ceil(Number(d.slice(5, 7)) / 3)} ${d.slice(0, 4)}`;
    const key = (d: string) => `${d.slice(0, 4)}-${Math.ceil(Number(d.slice(5, 7)) / 3)}`;
    const quarters = [...new Set(all.map((c) => key(c.launched!)))].sort();
    const channels = [...new Set(all.map((c) => c.channel))].sort();
    const cell = (list: typeof all) => {
      const cost = list.reduce((s, c) => s + c.cost, 0);
      const value = list.reduce((s, c) => s + (c.value ?? 0), 0);
      return { campaigns: list.length, cost: Math.round(cost), value: Math.round(value), roiPct: cost ? Math.round(((value - cost) / cost) * 1000) / 10 : null };
    };
    return {
      channels,
      quarters: quarters.map((q) => {
        const inQ = all.filter((c) => key(c.launched!) === q);
        return { quarter: quarter(inQ[0]!.launched!), total: cell(inQ), byChannel: Object.fromEntries(channels.map((ch) => [ch, cell(inQ.filter((c) => c.channel === ch))])) };
      }),
      byChannel: channels.map((ch) => ({ channel: ch, ...cell(all.filter((c) => c.channel === ch)) })),
    };
  }

  /** What campaigns brought in, from the accounts credited to them: by product and channel, count, dollars and lifetime value. */
  async productByChannel() {
    const found = await rows<{ product: string; channel: string; n: number; dollars: unknown }>(this.pool, 'SELECT a.product, c.channel, COUNT(*) AS n, SUM(a.amount) AS dollars FROM cmp_attribution a JOIN cmp_campaign c ON c.campaign_id = a.campaign_id GROUP BY a.product, c.channel').catch(() => []);
    if (!found.length) throw new CoreError('NOT_FOUND', 'Accounts aren’t credited to campaigns here yet.');
    return found.map((r) => {
      const [margin, years] = CAMPAIGN_VALUE[r.product] ?? [0.02, 2, 0];
      const dollars = Number(r.dollars);
      return { product: r.product, channel: r.channel, accounts: Number(r.n), dollars: Math.round(dollars), value: Math.round(dollars * margin * years) };
    }).sort((a, b) => b.value - a.value);
  }

  /** Accounts opened each day for the last days, by marketing source: each campaign channel, or no campaign. */
  async sources(days = 30) {
    const [b] = await rows<{ d: unknown }>(this.pool, "SELECT as_of_date AS d FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
    const to = String(b!.d instanceof Date ? (b!.d as Date).toISOString() : b!.d).slice(0, 10);
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const opened = await rows<{ d: unknown; n: number }>(this.pool, 'SELECT open_date AS d, COUNT(*) AS n FROM (SELECT open_date FROM cdm_loan WHERE open_date BETWEEN ? AND ? UNION ALL SELECT open_date FROM cdm_deposit_account WHERE open_date BETWEEN ? AND ?) x GROUP BY open_date', [from, to, from, to]);
    const credited = await rows<{ d: unknown; channel: string; n: number }>(this.pool, 'SELECT a.opened AS d, c.channel, COUNT(*) AS n FROM cmp_attribution a JOIN cmp_campaign c ON c.campaign_id = a.campaign_id WHERE a.opened BETWEEN ? AND ? GROUP BY a.opened, c.channel', [from, to]).catch(() => []);
    const d10 = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
    const channels = [...new Set(credited.map((r) => r.channel))].sort();
    const daysList = Array.from({ length: days }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
    return {
      from,
      to,
      channels,
      days: daysList.map((day) => {
        const total = Number(opened.find((o) => d10(o.d) === day)?.n ?? 0);
        const by = Object.fromEntries(channels.map((ch) => [ch, Number(credited.find((c) => d10(c.d) === day && c.channel === ch)?.n ?? 0)]));
        const fromCampaigns = Object.values(by).reduce((s, n) => s + n, 0);
        return { day, total, byChannel: by, none: Math.max(0, total - fromCampaigns) };
      }),
    };
  }

  /** A campaign by name, or the latest launched when none is named. */
  async campaignNamed(name?: string) {
    const list = await rows<{ campaign_id: number; name: string; channel: string; product: string; launched: unknown }>(this.pool, 'SELECT campaign_id, name, channel, product, launched FROM cmp_campaign WHERE launched IS NOT NULL ORDER BY launched DESC');
    if (!list.length) throw new CoreError('NOT_FOUND', 'No campaigns have launched.');
    if (!name?.trim()) return list[0]!;
    const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !['campaign', 'the'].includes(w));
    const hit = list.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? list.find((c) => words.length > 0 && words.every((w) => c.name.toLowerCase().includes(w)));
    if (!hit) throw new CoreError('NOT_FOUND', `There’s no campaign called “${name}”. Recent ones: ${list.slice(0, 5).map((c) => c.name).join(', ')}.`);
    return hit;
  }

  /** The accounts credited to a campaign, each with who opened it, where and for how much (account-level attribution). */
  async accounts(campaignId: number, ctx: CoreContext) {
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const list = await rows<{ party_id: number; first_name: string; last_name: string; branch: string; product: string; account_kind: string; account_id: number; opened: unknown; amount: unknown }>(
      this.pool,
      `SELECT a.party_id, p.first_name, p.last_name, b.name AS branch, a.product, a.account_kind, a.account_id, a.opened, a.amount
         FROM cmp_attribution a JOIN cdm_party p ON p.party_id = a.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id
        WHERE a.campaign_id = ?${scope} ORDER BY a.opened, a.account_id`,
      [campaignId, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])],
    );
    const d10 = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
    return list.map((r) => ({ name: `${r.first_name} ${r.last_name}`, last4: memberNumber(r.party_id).slice(-4), branch: r.branch, product: r.product, account: `${r.account_kind === 'loan' ? 'Loan' : 'Account'} …${String(r.account_id % 10_000).padStart(4, '0')}`, opened: d10(r.opened), amount: Math.round(Number(r.amount)) }));
  }

  /**
   * What campaigns brought in, split by age band, branch, segment or month opened, for one campaign or
   * all of them in a period: accounts, people and dollars.
   */
  async breakdown(by: 'age' | 'branch' | 'segment' | 'month', f: { campaignId?: number; from?: string; to?: string }, ctx: CoreContext) {
    const key = by === 'age'
      ? "CASE WHEN TIMESTAMPDIFF(YEAR, p.birth_date, a.opened) < 25 THEN 'Under 25' WHEN TIMESTAMPDIFF(YEAR, p.birth_date, a.opened) < 35 THEN '25 to 34' WHEN TIMESTAMPDIFF(YEAR, p.birth_date, a.opened) < 45 THEN '35 to 44' WHEN TIMESTAMPDIFF(YEAR, p.birth_date, a.opened) < 55 THEN '45 to 54' WHEN TIMESTAMPDIFF(YEAR, p.birth_date, a.opened) < 65 THEN '55 to 64' ELSE '65 and over' END"
      : by === 'branch' ? 'b.name' : by === 'segment' ? 'p.segment_code' : "DATE_FORMAT(a.opened, '%Y-%m')";
    const where: string[] = ['1 = 1'];
    const params: unknown[] = [];
    if (f.campaignId) where.push('a.campaign_id = ?'), params.push(f.campaignId);
    if (f.from) where.push('a.opened >= ?'), params.push(f.from);
    if (f.to) where.push('a.opened <= ?'), params.push(f.to);
    if (ctx.purviewBranches) where.push('b.name IN (?)'), params.push(ctx.purviewBranches.length ? ctx.purviewBranches : ['']);
    const list = await rows<{ k: string; accounts: number; people: number; dollars: unknown }>(
      this.pool,
      `SELECT ${key} AS k, COUNT(*) AS accounts, COUNT(DISTINCT a.party_id) AS people, SUM(a.amount) AS dollars
         FROM cmp_attribution a JOIN cdm_party p ON p.party_id = a.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id
        WHERE ${where.join(' AND ')} GROUP BY k ORDER BY k`,
      params,
    );
    const total = list.reduce((s, r) => s + Number(r.dollars), 0);
    return list.map((r) => ({ group: String(r.k), accounts: Number(r.accounts), people: Number(r.people), dollars: Math.round(Number(r.dollars)), sharePct: total ? Math.round((Number(r.dollars) / total) * 1000) / 10 : 0 }));
  }

  /** Each campaign's window (launch to 60 days after) and the accounts credited to it, week by week. */
  async timeline() {
    const list = await rows<Record<string, unknown>>(this.pool, 'SELECT campaign_id, name, channel, product, launched FROM cmp_campaign WHERE launched IS NOT NULL ORDER BY launched');
    const credited = await rows<{ campaign_id: number; week: number; n: number }>(this.pool, 'SELECT a.campaign_id, FLOOR(DATEDIFF(a.opened, c.launched) / 7) AS week, COUNT(*) AS n FROM cmp_attribution a JOIN cmp_campaign c ON c.campaign_id = a.campaign_id GROUP BY a.campaign_id, week').catch(() => []);
    const d10 = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
    return list.map((c) => {
      const launched = d10(c.launched);
      const weeks = Array.from({ length: 9 }, (_, w) => Number(credited.find((x) => x.campaign_id === c.campaign_id && Number(x.week) === w)?.n ?? 0));
      return { name: c.name as string, channel: c.channel as string, product: c.product as string, launched, ends: new Date(Date.parse(`${launched}T00:00:00Z`) + 60 * 86_400_000).toISOString().slice(0, 10), accounts: weeks.reduce((s, n) => s + n, 0), weeks, peakWeek: weeks.indexOf(Math.max(...weeks)) + 1 };
    });
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

  /** The audience's members who can be emailed: after suppression, with an email on file, in purview. */
  async audienceMembers(category: string, ctx: CoreContext) {
    const known = await rows<{ c: string }>(this.pool, 'SELECT DISTINCT loan_category AS c FROM cdm_loan');
    const match = known.find((k) => k.c.toLowerCase().includes(category.toLowerCase()));
    if (!match) throw new CoreError('NOT_FOUND', `There’s no loan category called ${category}. They are: ${known.map((k) => k.c).join(', ')}.`);
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const people = await rows<{ party_id: number; first_name: string; email: string | null }>(this.pool, `SELECT p.party_id, p.first_name, c.email FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id LEFT JOIN cdm_party_contact c ON c.party_id = p.party_id LEFT JOIN (SELECT DISTINCT party_id FROM cdm_loan WHERE loan_category = ? AND close_date IS NULL) l ON l.party_id = p.party_id WHERE p.is_member = 1 AND l.party_id IS NULL${scope} ORDER BY p.party_id`, [match.c, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])]);
    const kept = people.filter((p) => !suppressed(p.party_id));
    const reachable = kept.filter((p) => p.email);
    return { category: match.c, found: people.length, suppressed: people.length - kept.length, noEmail: kept.length - reachable.length, members: reachable.map((p) => ({ partyId: p.party_id, firstName: p.first_name, email: p.email! })) };
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

/** A ten-digit number as (555) 678-8270; anything else as it is. */
export const usPhone = (v: string) => (/^\d{10}$/.test(v) ? `(${v.slice(0, 3)}) ${v.slice(3, 6)}-${v.slice(6)}` : v);

export class SegService {
  constructor(private readonly pool: Pool) {}

  private toCompany = (c: Record<string, unknown>): SegCompany => ({ companyId: c.company_id as number, name: c.name as string, stage: c.stage as string, members: c.members as number, newMembers: c.new_members as number, loans: Number(c.loans), deposits: Number(c.deposits), owner: (c.owner as string | null) ?? null, sponsorship: (c.sponsorship as string | null) ?? null });

  async companies() {
    return (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM seg_company ORDER BY new_members DESC')).map(this.toCompany);
  }

  /** One company by the words of its name, or a refusal naming the choices. */
  async companyNamed(name: string) {
    const words = name.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = (await this.companies()).filter((c) => words.every((w) => c.name.toLowerCase().includes(w)));
    if (hits.length !== 1) throw new CoreError('NOT_FOUND', hits.length ? `More than one company matches “${name}”: ${hits.slice(0, 4).map((h) => h.name).join(', ')}.` : `There’s no company called “${name}”.`);
    return hits[0]!;
  }

  /** The SEG list with filters: stage, BD manager, branch, active, size and name words. */
  async list(f: { stage?: string; bdManager?: string; branch?: string; active?: boolean; minEmployees?: number; search?: string }) {
    const where: string[] = ['1 = 1'];
    const params: unknown[] = [];
    if (f.stage) where.push('c.stage = ?'), params.push(f.stage);
    if (f.bdManager) where.push('LOWER(x.bd_manager) LIKE ?'), params.push(`%${f.bdManager.toLowerCase()}%`);
    if (f.branch) where.push('LOWER(x.branch) = ?'), params.push(f.branch.toLowerCase());
    if (f.active !== undefined) where.push('COALESCE(x.active, 1) = ?'), params.push(f.active ? 1 : 0);
    if (f.minEmployees) where.push('x.employees >= ?'), params.push(f.minEmployees);
    if (f.search) where.push('LOWER(c.name) LIKE ?'), params.push(`%${f.search.toLowerCase()}%`);
    const found = await rows<Record<string, unknown>>(this.pool, `SELECT c.*, x.bd_manager, x.branch, x.active, x.employees FROM seg_company c LEFT JOIN seg_contact x ON x.company_id = c.company_id WHERE ${where.join(' AND ')} ORDER BY c.new_members DESC`, params).catch(() => []);
    return found.map((r) => ({ ...this.toCompany(r), bdManager: (r.bd_manager as string | null) ?? null, branch: (r.branch as string | null) ?? null, active: r.active === null || r.active === undefined ? true : Number(r.active) === 1, employees: r.employees === null || r.employees === undefined ? null : Number(r.employees) }));
  }

  async notes(companyId: number) {
    return (await rows<Record<string, unknown>>(this.pool, 'SELECT at, by_name, text FROM seg_note WHERE company_id = ? ORDER BY at DESC, note_id DESC', [companyId]).catch(() => [])).map((n) => ({ at: day(n.at), by: n.by_name as string, text: n.text as string }));
  }

  async addNote(companyId: number, text: string, meta: { by: string; approvalId: string; today: string }) {
    await this.pool.query('INSERT INTO seg_note (company_id, at, by_name, text, approval_id) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE note_id = note_id', [companyId, meta.today, meta.by, text.slice(0, 400), meta.approvalId]);
  }

  /** Sponsorships, donations and in-kind support: one company's, or every company's, newest first, with totals by year. */
  async sponsorships(companyId?: number) {
    const list = await rows<Record<string, unknown>>(this.pool, `SELECT s.*, c.name FROM seg_sponsorship s JOIN seg_company c ON c.company_id = s.company_id${companyId ? ' WHERE s.company_id = ?' : ''} ORDER BY s.given_on DESC`, companyId ? [companyId] : []).catch(() => []);
    const items = list.map((s) => ({ company: s.name as string, givenOn: day(s.given_on), kind: s.kind as string, amount: Number(s.amount), description: s.description as string, approvedBy: s.approved_by as string }));
    const years = [...new Set(items.map((i) => i.givenOn.slice(0, 4)))].sort().reverse().map((y) => ({ year: y, amount: items.filter((i) => i.givenOn.startsWith(y)).reduce((s, i) => s + i.amount, 0), count: items.filter((i) => i.givenOn.startsWith(y)).length }));
    return { items, years, total: items.reduce((s, i) => s + i.amount, 0) };
  }

  async addSponsorship(p: { companyId: number; givenOn: string; kind: string; amount: number; description: string }, meta: { by: string; approvalId: string }) {
    await this.pool.query('INSERT INTO seg_sponsorship (company_id, given_on, kind, amount, description, approved_by, approval_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE sponsorship_id = sponsorship_id', [p.companyId, p.givenOn, p.kind, p.amount, p.description.slice(0, 160), meta.by, meta.approvalId]);
  }

  /** Members who say they work at the company (from what they shared about their employment): how many, and what they hold. */
  async relationships(company: string) {
    const people = await rows<{ party_id: number; first_name: string; last_name: string; occupation: string | null; deposits: unknown; loans: unknown }>(
      this.pool,
      `SELECT p.party_id, p.first_name, p.last_name, f.occupation,
              (SELECT COALESCE(SUM(balance), 0) FROM cdm_deposit_account d WHERE d.party_id = p.party_id AND d.close_date IS NULL) AS deposits,
              (SELECT COALESCE(SUM(balance), 0) FROM cdm_loan l WHERE l.party_id = p.party_id AND l.close_date IS NULL AND l.charge_off_date IS NULL) AS loans
         FROM cdm_party_profile f JOIN cdm_party p ON p.party_id = f.party_id WHERE LOWER(f.employer) = ? ORDER BY deposits DESC`,
      [company.toLowerCase()],
    ).catch(() => []);
    return { count: people.length, deposits: people.reduce((s, x) => s + Number(x.deposits), 0), loans: people.reduce((s, x) => s + Number(x.loans), 0), people: people.slice(0, 25).map((x) => ({ name: `${x.first_name} ${x.last_name}`, last4: memberNumber(x.party_id).slice(-4), occupation: x.occupation ?? '—', deposits: Math.round(Number(x.deposits)), loans: Math.round(Number(x.loans)) })) };
  }

  /** Adds a company at the first stage, with its contact, once per approval. */
  async createCompany(p: { name: string; contact: string; title: string; phone: string; email: string; branch: string; bdManager: string; employees: number }, meta: { approvalId: string }) {
    const [dup] = await rows<{ company_id: number }>(this.pool, 'SELECT company_id FROM seg_company WHERE LOWER(name) = ?', [p.name.toLowerCase()]);
    if (dup) return dup.company_id;
    const [[m]] = (await this.pool.query('SELECT COALESCE(MAX(company_id), 0) + 1 AS id FROM seg_company')) as unknown as [{ id: number }[]];
    const id = Number(m?.id ?? 1);
    await this.pool.query("INSERT INTO seg_company (company_id, name, stage, members, new_members, loans, deposits, owner, sponsorship) VALUES (?, ?, 'Identification', 0, 0, 0, 0, ?, NULL)", [id, p.name.slice(0, 80), p.bdManager]);
    await this.pool.query('INSERT INTO seg_contact (company_id, contact_name, title, phone, email, branch, bd_manager, active, employees, next_follow_up, follow_up_note) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL)', [id, p.contact, p.title, p.phone.replace(/\D/g, '').slice(0, 20), p.email, p.branch, p.bdManager, p.employees]);
    await this.pool.query("INSERT INTO seg_interaction (company_id, at, kind, note, by_name, approval_id) VALUES (?, CURDATE(), 'Note', 'Added to SEG Management.', ?, ?)", [id, p.bdManager, meta.approvalId]);
    return id;
  }

  /** Retires a company or brings it back. Nothing is deleted: its history stays. */
  async setActive(companyId: number, active: boolean) {
    await this.pool.query('UPDATE seg_contact SET active = ?, next_follow_up = IF(?, next_follow_up, NULL) WHERE company_id = ?', [active ? 1 : 0, active ? 1 : 0, companyId]);
  }

  async company(name: string) {
    const words = name.toLowerCase().split(/\s+/);
    const hits = (await this.companies()).filter((c) => words.every((w) => c.name.toLowerCase().includes(w)));
    if (hits.length !== 1) throw new CoreError('NOT_FOUND', hits.length ? `More than one company matches “${name}”.` : `There’s no company called “${name}”.`);
    const c = hits[0]!;
    const log = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM seg_interaction WHERE company_id = ? ORDER BY at DESC, interaction_id DESC LIMIT 3', [c.companyId]);
    const contact = (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM seg_contact WHERE company_id = ?', [c.companyId]).catch(() => []))[0];
    const events = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM seg_event WHERE company_id = ? ORDER BY held DESC LIMIT 5', [c.companyId]).catch(() => []);
    return {
      ...c,
      interactions: log.map((i) => ({ at: day(i.at), kind: i.kind as string, note: i.note as string, by: i.by_name as string })),
      contact: contact ? { name: contact.contact_name as string, title: contact.title as string, phone: usPhone(String(contact.phone)), email: contact.email as string, branch: contact.branch as string, bdManager: contact.bd_manager as string, active: contact.active === 1, employees: Number(contact.employees), nextFollowUp: contact.next_follow_up ? day(contact.next_follow_up) : null, followUpNote: (contact.follow_up_note as string | null) ?? null } : null,
      events: events.map((e) => ({ held: day(e.held), kind: e.kind as string, attendees: Number(e.attendees), newMembers: Number(e.new_members), newLoanDollars: Number(e.new_loan_dollars), by: e.by_name as string })),
    };
  }

  /** The date the last build ran to. */
  async asOf() {
    const [b] = await rows<{ d: unknown }>(this.pool, "SELECT as_of_date AS d FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
    return day(b!.d);
  }

  /** Follow-ups due within some days (past due included), soonest first, optionally one BD manager's. */
  async followUps(withinDays: number, today: string, bdManager?: string) {
    const until = new Date(Date.parse(`${today}T00:00:00Z`) + withinDays * 86_400_000).toISOString().slice(0, 10);
    const found = await rows<Record<string, unknown>>(this.pool, `SELECT c.name, c.stage, x.* FROM seg_contact x JOIN seg_company c ON c.company_id = x.company_id WHERE x.next_follow_up IS NOT NULL AND c.stage NOT LIKE 'Closed%' AND x.next_follow_up <= ?${bdManager ? ' AND x.bd_manager = ?' : ''} ORDER BY x.next_follow_up`, [until, ...(bdManager ? [bdManager] : [])]).catch(() => []);
    return found.map((r) => ({ companyId: r.company_id as number, company: r.name as string, stage: r.stage as string, due: day(r.next_follow_up), overdue: day(r.next_follow_up) < today, note: (r.follow_up_note as string | null) ?? '', contact: `${r.contact_name}, ${r.title}`, phone: usPhone(String(r.phone)), bdManager: r.bd_manager as string }));
  }

  async scheduleFollowUp(companyId: number, date: string, note: string) {
    if (!moved(await this.pool.query('UPDATE seg_contact SET next_follow_up = ?, follow_up_note = ? WHERE company_id = ?', [date, note.slice(0, 200), companyId]).then((r) => r[0]))) throw new CoreError('NOT_FOUND', 'That company has no contact record.');
  }

  /**
   * The business development scorecard for a month: each BD manager's calls and emails, meetings, events,
   * and what the events brought in, against the monthly goals.
   */
  async bdScorecard(month: string) {
    const from = `${month.slice(0, 7)}-01`;
    const goals = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM seg_bd_goal ORDER BY sort_order').catch(() => []);
    if (!goals.length) throw new CoreError('NOT_FOUND', 'Business development goals aren’t set up here.');
    const touch = await rows<{ by_name: string; kind: string; n: number }>(this.pool, 'SELECT by_name, kind, COUNT(*) AS n FROM seg_interaction WHERE at BETWEEN ? AND ? GROUP BY by_name, kind', [from, month]);
    const ev = await rows<Record<string, unknown>>(this.pool, 'SELECT by_name, COUNT(*) AS events, SUM(new_members) AS m, SUM(new_checking) AS ck, SUM(new_loan_dollars) AS loans, SUM(referrals) AS refs FROM seg_event WHERE held BETWEEN ? AND ? GROUP BY by_name', [from, month]);
    const people = [...new Set([...touch.map((t) => t.by_name), ...ev.map((e) => e.by_name as string)])].sort();
    return {
      month,
      goals: goals.map((g) => ({ metric: g.metric as string, label: g.label as string, target: Number(g.monthly_target), unit: g.unit as 'count' | 'currency' })),
      people: people.map((p) => {
        const e = ev.find((x) => x.by_name === p);
        const n = (kinds: string[]) => touch.filter((t) => t.by_name === p && kinds.includes(t.kind)).reduce((s, t) => s + Number(t.n), 0);
        const actual: Record<string, number> = { contacts: n(['Phone call', 'Email']), meetings: n(['Meeting']), events: Number(e?.events ?? 0), new_members: Number(e?.m ?? 0), new_checking: Number(e?.ck ?? 0), new_loans: Number(e?.loans ?? 0), referrals: Number(e?.refs ?? 0) };
        return { name: p, actual, pct: Object.fromEntries(goals.map((g) => [g.metric as string, Number(g.monthly_target) ? Math.round((actual[g.metric as string]! / Number(g.monthly_target)) * 100) : 0])) };
      }),
    };
  }

  async log(p: { companyId: number; kind: string; note: string }, meta: { approvalId: string; actor: string; on: string }) {
    await this.pool.query('INSERT IGNORE INTO seg_interaction (company_id, at, kind, note, by_name, approval_id) VALUES (?, ?, ?, ?, ?, ?)', [p.companyId, meta.on, p.kind, p.note.slice(0, 300), meta.actor, meta.approvalId]);
  }

  async setStage(companyId: number, stage: string, note: string | null, meta: { approvalId: string; actor: string; on: string }) {
    if (!moved(await this.pool.query('UPDATE seg_company SET stage = ? WHERE company_id = ?', [stage, companyId]).then((r) => r[0]))) throw new CoreError('NOT_FOUND', 'That company no longer exists.');
    await this.log({ companyId, kind: 'Stage change', note: `Moved to ${stage}${note ? `. ${note}` : ''}` }, meta);
  }
}
