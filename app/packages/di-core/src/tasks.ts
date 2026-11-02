// DI Core for Tasks and My Time (spec 8.17). One list of what a person has to do: their own tasks,
// referrals assigned to them, onboarding touch points and outreach calls, each with its source and a
// link to it (FE-TASK-001). Own tasks and time entries change only through approved operations.
import type { Pool } from '@dinext/tenant-db';
import { CoreError, type CoreContext } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

export interface TaskItem {
  ref: string;
  title: string;
  due: string | null;
  status: string;
  source: string;
  link: string;
  taskId?: number;
}

export interface Person {
  userId: string;
  name: string;
  employeeId?: number;
}

export class TaskService {
  constructor(private readonly pool: Pool) {}

  private async asOf() {
    const [b] = await rows<{ d: unknown }>(this.pool, "SELECT MAX(as_of_date) AS d FROM meta_build WHERE state = 'completed'");
    return day(b?.d);
  }

  /** Everything open for one person, oldest due date first. */
  async mine(who: Person, ctx: CoreContext) {
    const asOf = await this.asOf();
    const own = await rows<Record<string, unknown>>(this.pool, "SELECT task_id, title, due, status FROM tsk_task WHERE owner_user_id = ? AND status = 'Open'", [who.userId]);
    const items: TaskItem[] = own.map((t) => ({ ref: `task:${t.task_id}`, taskId: t.task_id as number, title: t.title as string, due: t.due ? day(t.due) : null, status: 'Open', source: 'Task', link: '/tasks' }));
    if (who.employeeId !== undefined) {
      const refs = await rows<Record<string, unknown>>(this.pool, "SELECT com_id, type_id, stage, created_at, JSON_UNQUOTE(JSON_EXTRACT(fields, '$.summary')) AS summary FROM esp_com_items WHERE definition = 'referral' AND assignee_employee_id = ? AND stage NOT IN ('Sold', 'Not Interested', 'Done')", [who.employeeId]);
      for (const r of refs) items.push({ ref: `com:${r.com_id}`, title: (r.summary as string | null) ?? `Referral #${r.com_id}: ${String(r.type_id).replaceAll('_', ' ')}`, due: null, status: r.stage as string, source: 'Referral', link: '/workflows/referrals/inbox' });
      const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
      const touch = await rows<Record<string, unknown>>(this.pool, `SELECT t.task_id, t.touch, t.due, p.first_name, p.last_name FROM onb_task t JOIN cdm_party p ON p.party_id = t.party_id JOIN cdm_location b ON b.int_id = t.branch_id WHERE t.status = 'Open' AND t.assignee_employee_id = ? AND t.due <= DATE_ADD(?, INTERVAL 7 DAY)${scope}`, [who.employeeId, asOf, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])]);
      for (const t of touch) items.push({ ref: `onb:${t.task_id}`, title: `${t.first_name} ${t.last_name}: ${String(t.touch).toLowerCase()}`, due: day(t.due), status: day(t.due) < asOf ? 'Late' : 'Open', source: 'Onboarding', link: '/m/onboarding' });
    }
    const late = (t: TaskItem) => Boolean(t.due && t.due < asOf);
    items.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
    return { asOf, items, late: items.filter(late).length, bySource: [...new Set(items.map((i) => i.source))].map((s) => ({ source: s, count: items.filter((i) => i.source === s).length })) };
  }

  async own(who: Person, title: string) {
    const words = title.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const open = await rows<Record<string, unknown>>(this.pool, "SELECT task_id, title FROM tsk_task WHERE owner_user_id = ? AND status = 'Open'", [who.userId]);
    const hits = open.filter((t) => words.every((w) => String(t.title).toLowerCase().includes(w)));
    if (hits.length !== 1) throw new CoreError(hits.length ? 'INVALID' : 'NOT_FOUND', hits.length ? `${hits.length} of your tasks match: ${hits.map((h) => h.title).join('; ')}. Which one?` : `You have no open task matching “${title}”.`);
    return { taskId: hits[0]!.task_id as number, title: hits[0]!.title as string };
  }

  async create(p: { title: string; notes: string | null; owner: { userId: string; name: string }; due: string | null }, meta: { approvalId: string; actor: string; on: string }) {
    await this.pool.query("INSERT IGNORE INTO tsk_task (title, notes, owner_user_id, owner_name, due, status, created_by, created_at, approval_id) VALUES (?, ?, ?, ?, ?, 'Open', ?, ?, ?)", [p.title.slice(0, 160), p.notes, p.owner.userId, p.owner.name, p.due, meta.actor, meta.on, meta.approvalId]);
  }

  async complete(taskId: number, note: string | null) {
    await this.pool.query("UPDATE tsk_task SET status = 'Done', done_note = ? WHERE task_id = ? AND status = 'Open'", [note, taskId]);
  }

  // ---- My Time ---------------------------------------------------------------------------------

  async logTime(p: { userId: string; on: string; hours: number; project: string; note: string | null }, meta: { approvalId: string }) {
    await this.pool.query('INSERT IGNORE INTO tsk_time (user_id, on_date, hours, project, note, approval_id) VALUES (?, ?, ?, ?, ?, ?)', [p.userId, p.on, p.hours, p.project.slice(0, 80), p.note, meta.approvalId]);
  }

  /** A person's hours for a month by project; the newest month they logged time in if none is given. */
  async hours(userId: string, month?: string) {
    const m = month ?? (await rows<{ m: string | null }>(this.pool, "SELECT DATE_FORMAT(MAX(on_date), '%Y-%m') AS m FROM tsk_time WHERE user_id = ?", [userId]))[0]?.m;
    if (!m) return { month: null, total: 0, byProject: [] as { project: string; hours: number }[] };
    const list = await rows<{ project: string; hours: string }>(this.pool, "SELECT project, SUM(hours) AS hours FROM tsk_time WHERE user_id = ? AND DATE_FORMAT(on_date, '%Y-%m') = ? GROUP BY project ORDER BY hours DESC", [userId, m]);
    const byProject = list.map((r) => ({ project: r.project, hours: Number(r.hours) }));
    return { month: m, total: byProject.reduce((n, p) => n + p.hours, 0), byProject };
  }

  async projects(userId: string) {
    return (await rows<{ project: string }>(this.pool, 'SELECT DISTINCT project FROM tsk_time WHERE user_id = ? ORDER BY project', [userId])).map((r) => r.project);
  }
}
