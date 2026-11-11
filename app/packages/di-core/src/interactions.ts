// Interactions logged in DI against a member or customer (DI's "Spoke with Member" and call summaries):
// the channel, what was discussed, and an optional follow-up that becomes a task linked to the person.
// Written on approval; the Member 360 shows them with the core's own contact history.
import type { Pool } from '@dinext/tenant-db';
import type { CoreContext } from './referrals.ts';

export const LOG_CHANNELS = ['Phone', 'Branch', 'Email', 'Secure message', 'Video', 'Text'] as const;
export type LogChannel = (typeof LOG_CHANNELS)[number];
export const LOG_KINDS = ['Spoke with member', 'Left message', 'Branch visit', 'Service request', 'Sales conversation', 'Complaint'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

const last4 = (partyId: number) => String(10_004_520 + partyId).slice(-4);
const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);

export class InteractionService {
  constructor(private readonly pool: Pool) {}

  /** People matching a name within the purview, for picking who the interaction was with. */
  async find(name: string, ctx: CoreContext) {
    const parts = name.trim().split(/\s+/);
    const first = parts[0]!;
    const lastName = parts.length > 1 ? parts.at(-1)! : null;
    const [rows] = await this.pool.query(
      `SELECT p.party_id, p.first_name, p.last_name, b.name AS branch FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id
        WHERE ${lastName ? 'p.first_name = ? AND p.last_name = ?' : '(p.first_name = ? OR p.last_name = ?)'}${ctx.purviewBranches ? ' AND b.name IN (?)' : ''} ORDER BY p.party_id LIMIT 6`,
      [first, lastName ?? first, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])],
    );
    return (rows as { party_id: number; first_name: string; last_name: string; branch: string }[]).map((r) => ({ partyId: r.party_id, name: `${r.first_name} ${r.last_name}`, branch: r.branch, last4: last4(r.party_id) }));
  }

  async log(p: { partyId: number; name: string; channel: LogChannel; kind: LogKind; summary: string; followUp?: string | null }, meta: { approvalId: string; userId: string; userName: string; employeeId?: number }) {
    const [done] = await this.pool.query('SELECT log_id, task_id FROM rm_interaction_log WHERE approval_id = ?', [meta.approvalId]);
    const prior = (done as { log_id: number; task_id: number | null }[])[0];
    if (prior) return { logId: prior.log_id, taskId: prior.task_id, replayed: true };
    let taskId: number | null = null;
    if (p.followUp) {
      const [t] = await this.pool.query('INSERT INTO tsk_task (title, notes, owner_user_id, owner_name, due, status, created_by, created_at, approval_id, party_id) VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?)', [`Follow up with ${p.name}`.slice(0, 160), p.summary.slice(0, 500), meta.userId, meta.userName, p.followUp, 'Open', meta.userName, `${meta.approvalId}.task`, p.partyId]);
      taskId = (t as { insertId: number }).insertId;
    }
    const [r] = await this.pool.query('INSERT INTO rm_interaction_log (party_id, occurred_at, channel, kind, summary, employee_id, logged_by, follow_up, task_id, approval_id) VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?)', [p.partyId, p.channel, p.kind, p.summary.slice(0, 400), meta.employeeId ?? null, meta.userName, p.followUp ?? null, taskId, meta.approvalId]);
    return { logId: (r as { insertId: number }).insertId, taskId, replayed: false };
  }

  /** What was logged in DI lately, within the purview, newest first. */
  async recent(ctx: CoreContext, by?: string, limit = 25) {
    const [rows] = await this.pool.query(
      `SELECT l.*, p.first_name, p.last_name, b.name AS branch FROM rm_interaction_log l JOIN cdm_party p ON p.party_id = l.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id
        WHERE 1 = 1${by ? ' AND l.logged_by = ?' : ''}${ctx.purviewBranches ? ' AND b.name IN (?)' : ''} ORDER BY l.occurred_at DESC LIMIT ?`,
      [...(by ? [by] : []), ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : []), limit],
    ).catch(() => [[]]);
    return (rows as Record<string, unknown>[]).map((r) => ({ name: `${r.first_name} ${r.last_name}`, branch: r.branch as string, at: String(r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at).slice(0, 16).replace('T', ' '), channel: r.channel as string, kind: r.kind as string, summary: r.summary as string, by: r.logged_by as string, followUp: r.follow_up ? day(r.follow_up) : null }));
  }
}
