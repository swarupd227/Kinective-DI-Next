// DI Core for the smaller business modules: compliance issues (spec 24.24), onboarding touch points
// (24.21) and data logs (14.11). Purview is a filter here, and outside it a record reads as not found.
import type { Pool } from '@dinext/tenant-db';
import { CoreError, memberNumber, type CoreContext } from './referrals.ts';

const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const between = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const inScope = (ctx: CoreContext, column = 'b.name') => (ctx.purviewBranches ? { sql: ` AND ${column} IN (?)`, params: [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] } : { sql: '', params: [] as unknown[] });

async function buildDate(pool: Pool) {
  const [b] = await pool.query("SELECT as_of_date FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
  return day((b as { as_of_date: unknown }[])[0]?.as_of_date);
}

/** One person within the purview, or a refusal that says why. */
export async function findPerson(pool: Pool, name: string, ctx: CoreContext) {
  const scope = inScope(ctx);
  const words = name.trim().split(/\s+/);
  const [rows] = await pool.query(`SELECT p.party_id, p.first_name, p.last_name, b.name AS branch, p.primary_branch_id AS branch_id FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.last_name = ? AND (? = '' OR p.first_name = ?)${scope.sql} LIMIT 6`, [words.at(-1), words.length > 1 ? words[0] : '', words[0], ...scope.params]);
  const hits = rows as { party_id: number; first_name: string; last_name: string; branch: string; branch_id: number }[];
  if (!hits.length) throw new CoreError('NOT_FOUND', `I couldn’t find anyone called “${name}” that you can see.`);
  if (hits.length > 1) throw new CoreError('INVALID', `${hits.length} people match “${name}”: ${hits.slice(0, 4).map((h) => `${h.first_name} ${h.last_name}, ending ${memberNumber(h.party_id).slice(-4)}, ${h.branch}`).join('; ')}. Which one do you mean?`);
  const h = hits[0]!;
  return { partyId: h.party_id, name: `${h.first_name} ${h.last_name}`, branch: h.branch, branchId: h.branch_id };
}

// ---- compliance issues ------------------------------------------------------------------------

export const ISSUE_ROOT_CAUSES = ['Process', 'System', 'Staff error', 'Third party', 'Member error', 'No fault found'];
export const ISSUE_REGULATORS = ['OCC', 'CFPB', 'FDIC', 'NCUA'];
const ISSUE_SLA = { regulatory: { respond: 5, resolve: 15 }, customer: { respond: 5, resolve: 30 } };

export interface Issue {
  issueId: number;
  member: string;
  last4: string;
  kind: 'customer' | 'regulatory';
  source: string;
  category: string;
  summary: string;
  status: string;
  owner: string | null;
  branch: string;
  opened: string;
  ageDays: number;
  resolveBy: string;
  overdue: boolean;
  closed: string | null;
}

export interface IssueDetail extends Issue {
  resolution: string | null;
  rootCause: string | null;
  history: { at: string; actor: string; action: string; note: string | null }[];
}

export interface IssueFilter {
  kind?: string;
  source?: string;
  olderThan?: number;
  includeClosed?: boolean;
  overdueOnly?: boolean;
}

const ISSUE_SQL = `SELECT i.*, p.first_name, p.last_name, b.name AS branch, e.display_name AS owner_name FROM cpm_issue i JOIN cdm_party p ON p.party_id = i.party_id JOIN cdm_location b ON b.int_id = i.branch_id LEFT JOIN cdm_employee e ON e.employee_id = i.owner_employee_id`;

export class IssueService {
  constructor(private readonly pool: Pool) {}

  private toIssue(r: Record<string, unknown>, asOf: string): Issue {
    const closed = r.closed ? day(r.closed) : null;
    const resolveBy = day(r.resolve_by);
    return { issueId: r.issue_id as number, member: `${String(r.first_name)} ${String(r.last_name)}`, last4: memberNumber(r.party_id as number).slice(-4), kind: r.kind as Issue['kind'], source: r.source as string, category: r.category as string, summary: r.summary as string, status: r.status as string, owner: (r.owner_name as string | null) ?? null, branch: r.branch as string, opened: day(r.opened), ageDays: between(day(r.opened), closed ?? asOf), resolveBy, overdue: !closed && resolveBy < asOf, closed };
  }

  async list(f: IssueFilter, ctx: CoreContext) {
    const asOf = await buildDate(this.pool);
    const scope = inScope(ctx);
    const [rows] = await this.pool.query(`${ISSUE_SQL} WHERE 1 = 1${f.includeClosed ? '' : " AND i.status <> 'Closed'"}${scope.sql} ORDER BY i.opened`, scope.params);
    const items = (rows as Record<string, unknown>[])
      .map((r) => this.toIssue(r, asOf))
      .filter((i) => (!f.kind || i.kind === f.kind) && (!f.source || i.source.toLowerCase() === f.source.toLowerCase()) && (f.olderThan === undefined || i.ageDays > f.olderThan) && (!f.overdueOnly || i.overdue));
    const bySource = new Map<string, number>();
    for (const i of items) bySource.set(i.source, (bySource.get(i.source) ?? 0) + 1);
    return { asOf, count: items.length, oldestDays: Math.max(0, ...items.map((i) => i.ageDays)), bySource: [...bySource].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count), items };
  }

  async get(issueId: number, ctx: CoreContext): Promise<IssueDetail> {
    const asOf = await buildDate(this.pool);
    const scope = inScope(ctx);
    const [rows] = await this.pool.query(`${ISSUE_SQL} WHERE i.issue_id = ?${scope.sql}`, [issueId, ...scope.params]);
    const r = (rows as Record<string, unknown>[])[0];
    if (!r) throw new CoreError('NOT_FOUND', `Issue ${issueId} was not found.`);
    const [hist] = await this.pool.query('SELECT at, actor, action, note FROM cpm_issue_history WHERE issue_id = ? ORDER BY history_id', [issueId]);
    return { ...this.toIssue(r, asOf), resolution: (r.resolution as string | null) ?? null, rootCause: (r.root_cause as string | null) ?? null, history: (hist as Record<string, unknown>[]).map((h) => ({ at: day(h.at), actor: h.actor as string, action: h.action as string, note: (h.note as string | null) ?? null })) };
  }

  /** Root causes of closed issues in the last quarter's window, largest first. */
  async rootCauses(ctx: CoreContext) {
    const asOf = await buildDate(this.pool);
    const scope = inScope(ctx);
    const [rows] = await this.pool.query(`SELECT i.root_cause AS cause, COUNT(*) AS n FROM cpm_issue i JOIN cdm_location b ON b.int_id = i.branch_id WHERE i.status = 'Closed' AND i.root_cause IS NOT NULL AND i.closed >= ? - INTERVAL 90 DAY${scope.sql} GROUP BY i.root_cause ORDER BY n DESC`, [asOf, ...scope.params]);
    return { asOf, causes: (rows as { cause: string; n: number }[]).map((r) => ({ cause: r.cause, count: Number(r.n) })) };
  }

  /** cpm.issue.create. Dates come from the SLA; a retry of the same approval changes nothing. */
  async create(p: { partyId: number; branchId: number; source: string; category: string; summary: string; ownerId: number | null }, meta: { approvalId: string; actor: string }) {
    const [dup] = await this.pool.query('SELECT issue_id FROM cpm_issue WHERE approval_id = ?', [meta.approvalId]);
    const found = (dup as { issue_id: number }[])[0];
    if (found) return found.issue_id;
    const asOf = await buildDate(this.pool);
    const kind = ISSUE_REGULATORS.includes(p.source) || p.source === 'BBB' ? 'regulatory' : 'customer';
    const sla = ISSUE_SLA[kind];
    const [next] = await this.pool.query('SELECT COALESCE(MAX(issue_id), 3299) + 1 AS id FROM cpm_issue');
    const id = (next as { id: number }[])[0]!.id;
    await this.pool.query("INSERT INTO cpm_issue (issue_id, party_id, kind, source, category, summary, status, owner_employee_id, branch_id, opened, respond_by, resolve_by, approval_id) VALUES (?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?, ?)", [id, p.partyId, kind, p.source, p.category, p.summary.slice(0, 200), p.ownerId, p.branchId, asOf, plusDays(asOf, sla.respond), plusDays(asOf, sla.resolve), meta.approvalId]);
    await this.note(id, meta.actor, 'Opened', `Logged from ${p.source}.`);
    return id;
  }

  private async note(issueId: number, actor: string, action: string, note: string | null) {
    await this.pool.query('INSERT INTO cpm_issue_history (issue_id, at, actor, action, note) VALUES (?, ?, ?, ?, ?)', [issueId, await buildDate(this.pool), actor, action, note]);
  }

  async escalate(issueId: number, note: string | null, meta: { actor: string }) {
    const [r] = await this.pool.query("UPDATE cpm_issue SET status = 'Escalated' WHERE issue_id = ? AND status <> 'Closed'", [issueId]);
    if (!(r as { affectedRows: number }).affectedRows) throw new CoreError('INVALID', 'That issue is closed.');
    await this.note(issueId, meta.actor, 'Escalated', note);
  }

  /** A regulatory issue can't close without a root cause (EP23-F02-S02). */
  async close(issueId: number, resolution: string, rootCause: string | null, meta: { actor: string }) {
    const asOf = await buildDate(this.pool);
    const [r] = await this.pool.query("UPDATE cpm_issue SET status = 'Closed', closed = ?, resolution = ?, root_cause = ? WHERE issue_id = ? AND status <> 'Closed' AND (kind <> 'regulatory' OR ? IS NOT NULL)", [asOf, resolution.slice(0, 300), rootCause, issueId, rootCause]);
    if (!(r as { affectedRows: number }).affectedRows) throw new CoreError('INVALID', 'That issue is already closed, or it needs a root cause.');
    await this.note(issueId, meta.actor, 'Closed', resolution);
  }
}

// ---- onboarding -------------------------------------------------------------------------------

/** 7 days past due is missed, before that late [Assumption CA-38]. */
const MISSED_AFTER = 7;

export interface TouchPoint {
  taskId: number;
  member: string;
  last4: string;
  touch: string;
  due: string;
  daysLate: number;
  state: 'Upcoming' | 'Due today' | 'Late' | 'Missed' | 'Done';
  assignee: string | null;
  assigneeId: number | null;
  branch: string;
  directDeposit: boolean;
}

const ONB_SQL = `SELECT t.*, p.first_name, p.last_name, b.name AS branch, e.display_name AS assignee, d.direct_deposit_status FROM onb_task t JOIN cdm_party p ON p.party_id = t.party_id JOIN cdm_location b ON b.int_id = t.branch_id LEFT JOIN cdm_employee e ON e.employee_id = t.assignee_employee_id LEFT JOIN cdm_digital_usage d ON d.party_id = t.party_id`;

export class OnboardingService {
  constructor(private readonly pool: Pool) {}

  private toTouch(r: Record<string, unknown>, asOf: string): TouchPoint {
    const due = day(r.due);
    const late = between(due, asOf);
    const done = r.status === 'Done';
    return { taskId: r.task_id as number, member: `${String(r.first_name)} ${String(r.last_name)}`, last4: memberNumber(r.party_id as number).slice(-4), touch: r.touch as string, due, daysLate: done ? 0 : Math.max(0, late), state: done ? 'Done' : late >= MISSED_AFTER ? 'Missed' : late > 0 ? 'Late' : late === 0 ? 'Due today' : 'Upcoming', assignee: (r.assignee as string | null) ?? null, assigneeId: (r.assignee_employee_id as number | null) ?? null, branch: r.branch as string, directDeposit: r.direct_deposit_status === 'active' };
  }

  /** Open touch points, the longest overdue first. "Mine" is one person's; otherwise the purview's. */
  async list(f: { employeeId?: number; overdueOnly?: boolean; withinDays?: number }, ctx: CoreContext) {
    const asOf = await buildDate(this.pool);
    const scope = inScope(ctx);
    const [rows] = await this.pool.query(`${ONB_SQL} WHERE t.status = 'Open'${scope.sql}${f.employeeId !== undefined ? ' AND t.assignee_employee_id = ?' : ''} ORDER BY t.due`, [...scope.params, ...(f.employeeId !== undefined ? [f.employeeId] : [])]);
    const all = (rows as Record<string, unknown>[]).map((r) => this.toTouch(r, asOf));
    const items = all.filter((t) => (f.overdueOnly ? t.daysLate > 0 : t.state !== 'Upcoming' || between(asOf, t.due) <= (f.withinDays ?? 7)));
    return { asOf, count: items.length, overdue: items.filter((t) => t.daysLate > 0).length, missed: items.filter((t) => t.state === 'Missed').length, items };
  }

  /** New members past 30 days with no active direct deposit, within the purview (EP21-F04). */
  async noDirectDeposit(ctx: CoreContext) {
    const asOf = await buildDate(this.pool);
    const scope = inScope(ctx);
    const [rows] = await this.pool.query(`${ONB_SQL} WHERE t.touch = '30-day check-in' AND t.due <= ?${scope.sql}`, [asOf, ...scope.params]);
    return { asOf, items: (rows as Record<string, unknown>[]).map((r) => this.toTouch(r, asOf)).filter((t) => !t.directDeposit) };
  }

  /** The next open touch point for someone, within the user's reach. */
  async next(member: string, ctx: CoreContext) {
    const asOf = await buildDate(this.pool);
    const scope = inScope(ctx);
    const words = member.trim().split(/\s+/);
    const [rows] = await this.pool.query(`${ONB_SQL} WHERE t.status = 'Open' AND p.last_name = ? AND (? = '' OR p.first_name = ?)${scope.sql} ORDER BY t.due LIMIT 1`, [words.at(-1), words.length > 1 ? words[0] : '', words[0], ...scope.params]);
    const r = (rows as Record<string, unknown>[])[0];
    if (!r) throw new CoreError('NOT_FOUND', `${member} has no open onboarding touch point that you can see.`);
    return this.toTouch(r, asOf);
  }

  async complete(taskId: number, note: string | null) {
    await this.pool.query("UPDATE onb_task SET status = 'Done', done_on = ?, note = ? WHERE task_id = ? AND status = 'Open'", [await buildDate(this.pool), note, taskId]);
  }

  async snooze(taskId: number, days: number) {
    await this.pool.query("UPDATE onb_task SET due = due + INTERVAL ? DAY WHERE task_id = ? AND status = 'Open'", [days, taskId]);
  }

  async reassign(taskId: number, employeeId: number) {
    await this.pool.query("UPDATE onb_task SET assignee_employee_id = ? WHERE task_id = ? AND status = 'Open'", [employeeId, taskId]);
  }

  /** A colleague at the same branch, by name. */
  async colleague(name: string, branch: string) {
    const [rows] = await this.pool.query('SELECT e.employee_id, e.display_name FROM cdm_employee e JOIN cdm_location b ON b.int_id = e.branch_id WHERE b.name = ? AND e.display_name LIKE ?', [branch, `%${name.trim().split(/\s+/).at(-1)}%`]);
    const hits = rows as { employee_id: number; display_name: string }[];
    if (hits.length !== 1) throw new CoreError('NOT_FOUND', `There’s no one person called “${name}” at ${branch}.`);
    return { employeeId: hits[0]!.employee_id, name: hits[0]!.display_name };
  }
}

// ---- data logs --------------------------------------------------------------------------------

export interface DataLog {
  logId: number;
  typeId: string;
  type: string;
  financial: boolean;
  requiresApproval: boolean;
  title: string;
  amount: number | null;
  branch: string;
  status: string;
  createdBy: string;
  createdName: string;
  createdOn: string;
}

const LOG_SQL = 'SELECT l.*, t.label, t.financial, t.requires_approval, b.name AS branch FROM esp_datalog l JOIN esp_datalog_type t ON t.type_id = l.type_id JOIN cdm_location b ON b.int_id = l.branch_id';

export class DataLogService {
  constructor(private readonly pool: Pool) {}

  private toLog = (r: Record<string, unknown>): DataLog => ({ logId: r.log_id as number, typeId: r.type_id as string, type: r.label as string, financial: r.financial === 1, requiresApproval: r.requires_approval === 1, title: r.title as string, amount: r.amount === null ? null : Number(r.amount), branch: r.branch as string, status: r.status as string, createdBy: r.created_by as string, createdName: r.created_name as string, createdOn: day(r.created_on) });

  async types() {
    const [rows] = await this.pool.query('SELECT type_id, label, financial FROM esp_datalog_type ORDER BY label');
    return rows as { type_id: string; label: string; financial: number }[];
  }

  async list(f: { status?: string; createdBy?: string[] }, ctx: CoreContext) {
    const scope = inScope(ctx);
    const [rows] = await this.pool.query(`${LOG_SQL} WHERE l.status <> 'Deleted'${scope.sql} ORDER BY l.log_id`, scope.params);
    const items = (rows as Record<string, unknown>[]).map(this.toLog).filter((l) => (!f.status || l.status.toLowerCase() === f.status.toLowerCase()) && (!f.createdBy || f.createdBy.includes(l.createdBy)));
    return { count: items.length, items };
  }

  async get(logId: number, ctx: CoreContext) {
    const scope = inScope(ctx);
    const [rows] = await this.pool.query(`${LOG_SQL} WHERE l.log_id = ?${scope.sql}`, [logId, ...scope.params]);
    const r = (rows as Record<string, unknown>[])[0];
    if (!r) throw new CoreError('NOT_FOUND', `Log ${logId} was not found.`);
    const [hist] = await this.pool.query('SELECT at, actor, from_status, to_status, note FROM esp_datalog_history WHERE log_id = ? ORDER BY history_id', [logId]);
    return { ...this.toLog(r), history: (hist as Record<string, unknown>[]).map((h) => ({ at: day(h.at), actor: h.actor as string, from: (h.from_status as string | null) ?? null, to: h.to_status as string, note: (h.note as string | null) ?? null })) };
  }

  async create(p: { typeId: string; title: string; amount: number | null; branch: string }, meta: { approvalId: string; userId: string; actor: string }) {
    const [dup] = await this.pool.query('SELECT log_id FROM esp_datalog WHERE approval_id = ?', [meta.approvalId]);
    const found = (dup as { log_id: number }[])[0];
    if (found) return found.log_id;
    const asOf = await buildDate(this.pool);
    const [next] = await this.pool.query('SELECT COALESCE(MAX(log_id), 4470) + 1 AS id, (SELECT int_id FROM cdm_location WHERE name = ?) AS branch_id FROM esp_datalog', [p.branch]);
    const row = (next as { id: number; branch_id: number | null }[])[0]!;
    if (!row.branch_id) throw new CoreError('NOT_FOUND', `There’s no branch called ${p.branch}.`);
    await this.pool.query("INSERT INTO esp_datalog (log_id, type_id, title, amount, branch_id, status, created_by, created_name, created_on, approval_id) VALUES (?, ?, ?, ?, ?, 'Entered', ?, ?, ?, ?)", [row.id, p.typeId, p.title.slice(0, 120), p.amount, row.branch_id, meta.userId, meta.actor, asOf, meta.approvalId]);
    await this.pool.query("INSERT INTO esp_datalog_history (log_id, at, actor, to_status) VALUES (?, ?, ?, 'Entered')", [row.id, asOf, meta.actor]);
    return row.id;
  }

  /** A transition, only from the status it was prepared from, with its history row. */
  async move(logId: number, from: string, to: string, note: string | null, actor: string) {
    const [r] = await this.pool.query('UPDATE esp_datalog SET status = ? WHERE log_id = ? AND status = ?', [to, logId, from]);
    if (!(r as { affectedRows: number }).affectedRows) throw new CoreError('INVALID', `That log is no longer ${from}.`);
    await this.pool.query('INSERT INTO esp_datalog_history (log_id, at, actor, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?)', [logId, await buildDate(this.pool), actor, from, to, note]);
  }
}
