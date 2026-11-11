// DI Core for operations and admin (spec 24.13, 24.14), the 5300 Call Report (24.25), collections
// early warning (24.19), campaigns (24.20) and SEG (24.22). Every figure and rule lives here. An
// access answer, a variance or a suppression count is never left to a model (AI-AGT-141, 201, 252).
import type { Pool } from '@dinext/tenant-db';
import { carryUp, crParents } from '@dinext/tenant-db';
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
