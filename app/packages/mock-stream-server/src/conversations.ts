// Where tasks are kept between restarts (spec 12.1). The server works from memory and writes here
// behind it, in small batches, so streaming never waits on the database. At startup it loads what
// was saved. Without the tables (a warehouse seeded before they existed) tasks stay in memory only.
import type { ApprovalCardBlock, StreamEvent, ThreadSummary } from '@dinext/block-schemas';
import { CONVERSATIONS_SCHEMA, createPool, dbUrl, type Pool } from '@dinext/tenant-db';

export interface SavedThread {
  threadId: string;
  tenant: string;
  owner: string;
  summary: ThreadSummary;
  deleted: boolean;
  seq: number;
}

export interface SavedApproval {
  approvalId: string;
  threadId: string;
  runId: string | null;
  blockId: string;
  card: ApprovalCardBlock;
  /** Decided by the approval service (a live agent's card) rather than by a scripted scenario. */
  live: boolean;
  noticeId?: string;
  decided?: { status: number; body: unknown };
}

export interface ConversationStore {
  /** Tasks touched in the last `days` days, with their events in order, and their approval cards. */
  load(): Promise<{ threads: (SavedThread & { events: StreamEvent[] })[]; approvals: SavedApproval[] }>;
  thread(t: SavedThread): void;
  event(e: StreamEvent): void;
  approval(a: SavedApproval): void;
  /** Writes everything queued so far. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Kept in memory as JSON, the way a database would hand it back. For tests of a restart. */
export function memoryConversationStore(): ConversationStore {
  const threads = new Map<string, string>();
  const events = new Map<string, Map<number, string>>();
  const approvals = new Map<string, string>();
  return {
    async load() {
      const list = [...threads.values()].map((s) => JSON.parse(s) as SavedThread).filter((t) => !t.deleted);
      return {
        threads: list.map((t) => ({ ...t, events: [...(events.get(t.threadId)?.entries() ?? [])].sort((a, b) => a[0] - b[0]).map(([, e]) => JSON.parse(e) as StreamEvent) })),
        approvals: [...approvals.values()].map((a) => JSON.parse(a) as SavedApproval),
      };
    },
    thread: (t) => void threads.set(t.threadId, JSON.stringify(t)),
    event: (e) => {
      if (!events.has(e.threadId)) events.set(e.threadId, new Map());
      events.get(e.threadId)!.set(e.seq, JSON.stringify(e));
    },
    approval: (a) => void approvals.set(a.approvalId, JSON.stringify(a)),
    flush: async () => {},
    close: async () => {},
  };
}

const sqlTime = (iso: string) => iso.replace('T', ' ').replace('Z', '').slice(0, 23);
const CHUNK = 500;

/**
 * The MySQL store, in the schema the seed creates. Null when the tables aren't there yet, so an older
 * warehouse still runs, with tasks in memory as before.
 */
export async function mysqlConversationStore(opts: { days?: number; flushMs?: number } = {}): Promise<ConversationStore | null> {
  const pool: Pool = createPool(`${dbUrl()}/${CONVERSATIONS_SCHEMA}`, { connectionLimit: 4 });
  const ok = await pool.query('SELECT 1 FROM di_thread LIMIT 1').then(
    () => true,
    () => false,
  );
  if (!ok) {
    await pool.end().catch(() => {});
    return null;
  }
  const days = opts.days ?? 90;
  const flushMs = opts.flushMs ?? 250;
  const threads = new Map<string, SavedThread>();
  let events: StreamEvent[] = [];
  const approvals = new Map<string, SavedApproval>();
  let timer: NodeJS.Timeout | null = null;
  let writing: Promise<void> = Promise.resolve();
  let lastError = 0;

  const write = async () => {
    const ts = [...threads.values()];
    const es = events;
    const as = [...approvals.values()];
    threads.clear();
    events = [];
    approvals.clear();
    try {
      if (ts.length) {
        await pool.query(
          'INSERT INTO di_thread (thread_id, tenant_id, owner_id, deleted, last_seq, updated_at, summary) VALUES ? ON DUPLICATE KEY UPDATE deleted = VALUES(deleted), last_seq = GREATEST(last_seq, VALUES(last_seq)), updated_at = VALUES(updated_at), summary = VALUES(summary)',
          [ts.map((t) => [t.threadId, t.tenant, t.owner, t.deleted ? 1 : 0, t.seq, sqlTime(t.summary.updatedAt), JSON.stringify(t.summary)])],
        );
      }
      for (let i = 0; i < es.length; i += CHUNK) {
        await pool.query('INSERT IGNORE INTO di_thread_event (thread_id, seq, event) VALUES ?', [es.slice(i, i + CHUNK).map((e) => [e.threadId, e.seq, JSON.stringify(e)])]);
      }
      if (as.length) {
        await pool.query(
          'INSERT INTO di_thread_approval (approval_id, thread_id, run_id, block_id, card, live, notice_id, decided) VALUES ? ON DUPLICATE KEY UPDATE notice_id = VALUES(notice_id), decided = VALUES(decided)',
          [as.map((a) => [a.approvalId, a.threadId, a.runId, a.blockId, JSON.stringify(a.card), a.live ? 1 : 0, a.noticeId ?? null, a.decided ? JSON.stringify(a.decided) : null])],
        );
      }
    } catch (err) {
      // A lost write costs one task its history after a restart; it never stops the conversation.
      if (Date.now() - lastError > 60_000) console.error('[conversations] could not save:', (err as Error).message);
      lastError = Date.now();
    }
  };

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    writing = writing.then(write);
    return writing;
  };
  const soon = () => {
    timer ??= setTimeout(() => void flush(), flushMs);
  };

  return {
    async load() {
      const [rows] = (await pool.query('SELECT thread_id, tenant_id, owner_id, last_seq, summary FROM di_thread WHERE deleted = 0 AND updated_at >= NOW() - INTERVAL ? DAY', [days])) as unknown as [{ thread_id: string; tenant_id: string; owner_id: string; last_seq: number; summary: string }[]];
      const byId = new Map(rows.map((r) => [r.thread_id, { threadId: r.thread_id, tenant: r.tenant_id, owner: r.owner_id, seq: r.last_seq, deleted: false, summary: JSON.parse(r.summary) as ThreadSummary, events: [] as StreamEvent[] }]));
      const ids = [...byId.keys()];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const [evs] = (await pool.query('SELECT thread_id, event FROM di_thread_event WHERE thread_id IN (?) ORDER BY thread_id, seq', [ids.slice(i, i + CHUNK)])) as unknown as [{ thread_id: string; event: string }[]];
        for (const e of evs) byId.get(e.thread_id)!.events.push(JSON.parse(e.event) as StreamEvent);
      }
      const approvalsFound: SavedApproval[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const [aps] = (await pool.query('SELECT * FROM di_thread_approval WHERE thread_id IN (?)', [ids.slice(i, i + CHUNK)])) as unknown as [{ approval_id: string; thread_id: string; run_id: string | null; block_id: string; card: string; live: number; notice_id: string | null; decided: string | null }[]];
        for (const a of aps) approvalsFound.push({ approvalId: a.approval_id, threadId: a.thread_id, runId: a.run_id, blockId: a.block_id, card: JSON.parse(a.card) as ApprovalCardBlock, live: a.live === 1, noticeId: a.notice_id ?? undefined, decided: a.decided ? (JSON.parse(a.decided) as SavedApproval['decided']) : undefined });
      }
      for (const t of byId.values()) t.seq = Math.max(t.seq, t.events.at(-1)?.seq ?? 0);
      return { threads: [...byId.values()], approvals: approvalsFound };
    },
    thread(t) {
      threads.set(t.threadId, { ...t, summary: { ...t.summary } });
      soon();
    },
    event(e) {
      events.push(e);
      soon();
    },
    approval(a) {
      approvals.set(a.approvalId, a);
      soon();
    },
    flush,
    async close() {
      await flush();
      await pool.end().catch(() => {});
    },
  };
}
