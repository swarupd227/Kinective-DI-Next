// AI audit record and usage ledger (spec 26.10, 28.2). One JSON line per turn: who asked, what the
// AI did (route, tool calls with arguments and result hashes), tokens and cost, and the outcome.
// Local development writes to app/.data; production writes to the tenant-encrypted audit store.
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costUsd, type Usage } from './model.ts';

export interface ToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
  resultRef?: string;
  error?: string;
  ms: number;
}

export interface AuditRecord {
  at: string;
  tenant: string;
  userId: string;
  threadId: string;
  runId: string;
  /** The question after pre-screen masking; raw identifiers are never written (AI-GRD-031). */
  question: string;
  maskedIdentifiers: number;
  route: { intent: string; agent: string; confidence: number | null; mode: 'live' | 'offline' | 'deterministic' };
  toolCalls: ToolCallRecord[];
  outcome: 'answer' | 'unmatched' | 'clarify' | 'not_supported' | 'no_access' | 'failed' | 'cancelled' | 'scripted' | 'approval_requested' | 'not_found';
  numericRemovals: string[];
  usage: (Usage & { costUsd: number })[];
  totalCostUsd: number;
  modelVersion?: string;
  buildId?: string;
  error?: string;
}

const DATA_DIR = process.env.DI_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.data');

export class AuditLog {
  constructor(private readonly dir = DATA_DIR) {}

  async record(r: Omit<AuditRecord, 'at' | 'totalCostUsd' | 'usage'> & { usage: Usage[] }) {
    const usage = r.usage.map((u) => ({ ...u, costUsd: Math.round(costUsd(u) * 1e6) / 1e6 }));
    const full: AuditRecord = { ...r, at: new Date().toISOString(), usage, totalCostUsd: Math.round(usage.reduce((s, u) => s + u.costUsd, 0) * 1e6) / 1e6 };
    await this.append(join('audit', `${full.at.slice(0, 10)}.jsonl`), full);
    return full;
  }

  /**
   * Approval and execution events (spec 26.10: ai.approval.*, ai.action.executed). Together with the
   * run record and the approval ID stored on the created record, they link a change to who asked,
   * what the AI did and who approved it (AI-GRD-090, AI-GRD-092).
   */
  async event(e: { eventType: string; tenant: string; userId: string; threadId: string; runId: string; approvalId: string } & Record<string, unknown>) {
    await this.append(join('audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), { at: new Date().toISOString(), ...e });
  }

  /**
   * A member record was opened (spec 8.24: viewing is a read, logged as a member record access;
   * BE-RM-002). The party is recorded by its internal ID, never by member number.
   */
  async access(e: { tenant: string; userId: string; partyId: number; via: 'agent' | 'workspace' | 'search'; threadId?: string; runId?: string }) {
    await this.append(join('audit', `${new Date().toISOString().slice(0, 10)}.jsonl`), { at: new Date().toISOString(), eventType: 'relationship.profile.viewed', ...e });
  }

  /** Questions no defined metric answers, for the tenant's data team (AI-AGT-042). */
  async unmatched(entry: { tenant: string; question: string; unknownTerms: string[]; closest: string[] }) {
    await this.append('unmatched-questions.jsonl', { at: new Date().toISOString(), ...entry });
  }

  private async append(relative: string, value: unknown) {
    const file = join(this.dir, relative);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
  }
}
