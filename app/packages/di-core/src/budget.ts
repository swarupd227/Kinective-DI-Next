// The budget: next year's targets for the board's headline measures, drafted, changed and approved in
// DI. Each line has a status (Draft, then Approved) and every change is kept as an event, with who made
// it and the approval behind it. This year's approved plan is what the scorecard measures against.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

export interface BudgetLine {
  year: number;
  metric: string;
  value: number;
  status: 'Draft' | 'Approved';
  note: string | null;
  updatedBy: string | null;
  approvalId: string | null;
}

export interface BudgetEvent {
  year: number;
  action: string;
  detail: string;
  by: string;
  at: string;
  approvalId: string | null;
}

export class BudgetService {
  constructor(private readonly pool: Pool) {}

  async lines(year: number): Promise<BudgetLine[]> {
    const rs = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM fin_budget WHERE year = ? ORDER BY metric', [year]).catch(() => []);
    return rs.map((r) => ({ year: Number(r.year), metric: String(r.metric), value: Number(r.value), status: r.status as BudgetLine['status'], note: (r.note as string | null) ?? null, updatedBy: (r.updated_by as string | null) ?? null, approvalId: (r.approval_id as string | null) ?? null }));
  }

  async events(year: number): Promise<BudgetEvent[]> {
    const rs = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM fin_budget_event WHERE year = ? ORDER BY event_id DESC LIMIT 20', [year]).catch(() => []);
    return rs.map((r) => ({ year: Number(r.year), action: String(r.action), detail: String(r.detail), by: String(r.by_name), at: r.at instanceof Date ? r.at.toISOString().slice(0, 16).replace('T', ' ') : String(r.at), approvalId: (r.approval_id as string | null) ?? null }));
  }

  /** Saves a draft: every line given, as Draft, replacing any earlier draft of that year. */
  async saveDraft(year: number, lines: { metric: string; value: number; note: string }[], meta: { approvalId: string; userId: string; by: string }) {
    const approved = (await this.lines(year)).filter((l) => l.status === 'Approved');
    if (approved.length) throw new Error(`The ${year} budget is already approved.`);
    for (const l of lines) {
      await this.pool.query('INSERT INTO fin_budget (year, metric, value, status, note, updated_by, approval_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), status = VALUES(status), note = VALUES(note), updated_by = VALUES(updated_by), approval_id = VALUES(approval_id)', [year, l.metric, l.value, 'Draft', l.note.slice(0, 200), meta.by, meta.approvalId]);
    }
    await this.event(year, 'Drafted', `${lines.length} targets drafted`, meta);
  }

  async setTarget(year: number, metric: string, value: number, note: string, meta: { approvalId: string; userId: string; by: string }) {
    const before = (await this.lines(year)).find((l) => l.metric === metric);
    if (before?.status === 'Approved') throw new Error(`The ${year} budget is approved; a change needs a new version.`);
    await this.pool.query('INSERT INTO fin_budget (year, metric, value, status, note, updated_by, approval_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), note = VALUES(note), updated_by = VALUES(updated_by), approval_id = VALUES(approval_id)', [year, metric, value, 'Draft', note.slice(0, 200), meta.by, meta.approvalId]);
    await this.event(year, 'Changed', `${metric}: ${before ? before.value : '—'} to ${value}`, meta);
  }

  /** Approves the year's draft. The approval card makes sure someone other than the preparer approves it. */
  async approve(year: number, meta: { approvalId: string; userId: string; by: string }) {
    const lines = await this.lines(year);
    if (!lines.length) throw new Error(`There is no ${year} budget to approve.`);
    await this.pool.query("UPDATE fin_budget SET status = 'Approved', approval_id = ? WHERE year = ?", [meta.approvalId, year]);
    await this.event(year, 'Approved', `${lines.length} targets approved`, meta);
  }

  private async event(year: number, action: string, detail: string, meta: { approvalId: string; by: string }) {
    await this.pool.query('INSERT INTO fin_budget_event (year, action, detail, by_name, at, approval_id) VALUES (?, ?, ?, ?, NOW(), ?)', [year, action, detail.slice(0, 200), meta.by, meta.approvalId]);
  }
}
