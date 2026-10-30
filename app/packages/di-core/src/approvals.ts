// Approval service (spec 25.3 steps 6–7, 26.8). An approval binds one exact payload, by hash, to the
// requesting user and an expiry. The gateway executes only what was approved, and only once.
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from '@dinext/tenant-db';

export type RiskTier = 'low' | 'medium' | 'high';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'returned' | 'expired' | 'superseded' | 'executed' | 'failed';

/** Default lifetimes from AI-GRD-071: 15 minutes for medium, 5 for high. */
export const APPROVAL_TTL_MS: Record<RiskTier, number> = { low: 15 * 60_000, medium: 15 * 60_000, high: 5 * 60_000 };

export interface ApprovalRecord {
  approvalId: string;
  operation: string;
  payload: unknown;
  payloadHash: string;
  riskTier: RiskTier;
  requestedBy: string;
  runId: string;
  threadId: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  resultRef: string | null;
}

export class ApprovalError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'ALREADY_DECIDED' | 'EXPIRED' | 'WRONG_USER' | 'PAYLOAD_CHANGED',
    message: string,
  ) {
    super(message);
  }
}

/** Key order does not change the hash, so the same payload always hashes the same way. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const payloadHash = (payload: unknown) => `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`;

const sqlTime = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
const iso = (s: string) => `${s.replace(' ', 'T')}Z`;

type Row = { approval_id: string; operation: string; payload: unknown; payload_hash: string; risk_tier: RiskTier; requested_by: string; run_id: string; thread_id: string; status: ApprovalStatus; created_at: string; expires_at: string; decided_by: string | null; result_ref: string | null };

const toRecord = (r: Row): ApprovalRecord => ({
  approvalId: r.approval_id,
  operation: r.operation,
  payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
  payloadHash: r.payload_hash,
  riskTier: r.risk_tier,
  requestedBy: r.requested_by,
  runId: r.run_id,
  threadId: r.thread_id,
  status: r.status,
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  decidedBy: r.decided_by,
  resultRef: r.result_ref,
});

export class ApprovalStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async request(r: { operation: string; payload: unknown; riskTier: RiskTier; requestedBy: string; runId: string; threadId: string }): Promise<ApprovalRecord> {
    const approvalId = `apr_${randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 14).padEnd(14, '0')}`;
    const created = this.now();
    const expires = new Date(created.getTime() + APPROVAL_TTL_MS[r.riskTier]);
    await this.pool.query(
      `INSERT INTO ai_approvals (approval_id, operation, payload, payload_hash, risk_tier, requested_by, run_id, thread_id, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [approvalId, r.operation, JSON.stringify(r.payload), payloadHash(r.payload), r.riskTier, r.requestedBy, r.runId, r.threadId, sqlTime(created), sqlTime(expires)],
    );
    return (await this.get(approvalId))!;
  }

  async get(approvalId: string): Promise<ApprovalRecord | null> {
    const [rows] = await this.pool.query('SELECT * FROM ai_approvals WHERE approval_id = ?', [approvalId]);
    const row = (rows as Row[])[0];
    return row ? toRecord(row) : null;
  }

  /** The newest undecided approval in a thread, for follow-ups such as "make it email instead". */
  async pendingInThread(threadId: string): Promise<ApprovalRecord | null> {
    const [rows] = await this.pool.query("SELECT * FROM ai_approvals WHERE thread_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", [threadId]);
    const row = (rows as Row[])[0];
    return row ? toRecord(row) : null;
  }

  /** A newer draft replaces older pending ones in the same thread; they can no longer be approved. */
  async supersede(threadId: string, exceptId: string): Promise<string[]> {
    const [rows] = await this.pool.query("SELECT approval_id FROM ai_approvals WHERE thread_id = ? AND status = 'pending' AND approval_id <> ?", [threadId, exceptId]);
    const ids = (rows as { approval_id: string }[]).map((r) => r.approval_id);
    if (ids.length) await this.pool.query("UPDATE ai_approvals SET status = 'superseded', decided_at = ? WHERE approval_id IN (?) AND status = 'pending'", [sqlTime(this.now()), ids]);
    return ids;
  }

  /**
   * Records a decision. Only the user the approval was prepared for can decide it, only once, and
   * only before it expires (AI-GRD-071). The conditional UPDATE makes a double submit harmless.
   */
  async decide(approvalId: string, d: { decision: 'approved' | 'denied' | 'returned'; userId: string; channel?: string; note?: string; payloadHash?: string }): Promise<ApprovalRecord> {
    const a = await this.get(approvalId);
    if (!a) throw new ApprovalError('NOT_FOUND', 'That approval does not exist.');
    if (a.requestedBy !== d.userId) throw new ApprovalError('WRONG_USER', 'Only the person this was prepared for can approve it.');
    if (a.status !== 'pending') throw new ApprovalError(a.status === 'expired' ? 'EXPIRED' : 'ALREADY_DECIDED', a.status === 'superseded' ? 'A newer version of this draft replaced it.' : 'It has already been decided.');
    if (d.payloadHash && d.payloadHash !== a.payloadHash) throw new ApprovalError('PAYLOAD_CHANGED', 'The change differs from what was shown.');
    const now = this.now();
    if (new Date(a.expiresAt).getTime() <= now.getTime()) {
      await this.pool.query("UPDATE ai_approvals SET status = 'expired' WHERE approval_id = ? AND status = 'pending'", [approvalId]);
      throw new ApprovalError('EXPIRED', 'The approval expired. Ask again to prepare a fresh one.');
    }
    const [res] = await this.pool.query("UPDATE ai_approvals SET status = ?, decided_by = ?, decided_at = ?, channel = ?, note = ? WHERE approval_id = ? AND status = 'pending'", [
      d.decision,
      d.userId,
      sqlTime(now),
      d.channel ?? null,
      d.note?.slice(0, 500) ?? null,
      approvalId,
    ]);
    if ((res as { affectedRows: number }).affectedRows !== 1) throw new ApprovalError('ALREADY_DECIDED', 'It has already been decided.');
    return (await this.get(approvalId))!;
  }

  async markExecuted(approvalId: string, resultRef: string) {
    await this.pool.query("UPDATE ai_approvals SET status = 'executed', result_ref = ? WHERE approval_id = ? AND status = 'approved'", [resultRef, approvalId]);
  }

  async markFailed(approvalId: string) {
    await this.pool.query("UPDATE ai_approvals SET status = 'failed' WHERE approval_id = ? AND status = 'approved'", [approvalId]);
  }
}
