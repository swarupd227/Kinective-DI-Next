// Stream store (spec 11.5, 11.6). Applies events strictly by per-thread sequence (FE-ARCH-030):
// duplicates are dropped, early events are buffered for up to 2 s, then a replay is requested.
import { createStore } from 'zustand/vanilla';
import type { StreamEvent } from '@dinext/block-schemas';
import { emptyThread, reduce, type ThreadState } from './reducer.ts';

export const GAP_TIMEOUT_MS = 2000;

interface Buffered {
  event: StreamEvent;
  receivedAt: number;
}

export interface StreamState {
  threads: Record<string, ThreadState>;
  /** Out-of-order events waiting for the gap before them to fill. */
  buffers: Record<string, Record<number, Buffered>>;
  /** Event types the client did not recognise, for telemetry (FE-API-001). */
  unknownEvents: number;
}

export interface StreamStoreOptions {
  /** Called when a gap has not filled within GAP_TIMEOUT_MS; the connection asks for a replay. */
  onGap?: (threadId: string, lastSeq: number) => void;
  /** Called when a block patch fails and the block must be re-requested (FE-GEN-040). */
  onBlockFailed?: (threadId: string, blockId: string) => void;
  now?: () => number;
}

const KNOWN = new Set<StreamEvent['type']>([
  'message.accepted',
  'run.started',
  'routing',
  'token.delta',
  'block.start',
  'block.patch',
  'block.end',
  'tool.progress',
  'approval.requested',
  'approval.resolved',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'suggestion',
  'build.status',
]);

export function createStreamStore(opts: StreamStoreOptions = {}) {
  const now = opts.now ?? Date.now;
  const store = createStore<StreamState>(() => ({ threads: {}, buffers: {}, unknownEvents: 0 }));
  const gapNotifiedAt = new Map<string, number>();

  const applyOne = (state: StreamState, event: StreamEvent): StreamState => {
    const thread = state.threads[event.threadId] ?? emptyThread(event.threadId);
    if (event.seq <= thread.lastSeq) return state; // duplicate or replayed
    const buffer = { ...(state.buffers[event.threadId] ?? {}) };
    if (event.seq > thread.lastSeq + 1) {
      buffer[event.seq] = { event, receivedAt: now() };
      return { ...state, buffers: { ...state.buffers, [event.threadId]: buffer } };
    }
    let current = thread;
    let unknown = state.unknownEvents;
    let e: StreamEvent | undefined = event;
    while (e) {
      if (!KNOWN.has(e.type)) unknown += 1;
      const before = current;
      current = reduce(current, e);
      if (e.type === 'block.patch' && !before.blocks[e.blockId]?.failedPatch && current.blocks[e.blockId]?.failedPatch) {
        opts.onBlockFailed?.(e.threadId, e.blockId);
      }
      const nextSeq: number = current.lastSeq + 1;
      e = buffer[nextSeq]?.event;
      delete buffer[nextSeq];
    }
    return {
      threads: { ...state.threads, [event.threadId]: current },
      buffers: { ...state.buffers, [event.threadId]: buffer },
      unknownEvents: unknown,
    };
  };

  return {
    store,
    /** Apply a batch in one state update, so a frame of tokens renders once (FE-ARCH-031). */
    applyMany(events: StreamEvent[]) {
      if (!events.length) return;
      store.setState((s) => events.reduce(applyOne, s));
    },
    /** Checks buffered gaps; call periodically. Requests a replay for gaps older than 2 s. */
    checkGaps() {
      const { threads, buffers } = store.getState();
      for (const [threadId, buf] of Object.entries(buffers)) {
        const oldest = Math.min(...Object.values(buf).map((b) => b.receivedAt));
        const notified = gapNotifiedAt.get(threadId) ?? 0;
        if (Number.isFinite(oldest) && now() - oldest >= GAP_TIMEOUT_MS && now() - notified >= GAP_TIMEOUT_MS) {
          gapNotifiedAt.set(threadId, now());
          opts.onGap?.(threadId, threads[threadId]?.lastSeq ?? 0);
        }
      }
    },
    /** Replaces a thread with a server snapshot (used when replay is no longer available). */
    resetThread(snapshot: ThreadState) {
      store.setState((s) => ({ ...s, threads: { ...s.threads, [snapshot.threadId]: snapshot }, buffers: { ...s.buffers, [snapshot.threadId]: {} } }));
    },
    lastSeqs: () => Object.values(store.getState().threads).map((t) => ({ threadId: t.threadId, lastSeq: t.lastSeq })),
  };
}

export type StreamStore = ReturnType<typeof createStreamStore>;
