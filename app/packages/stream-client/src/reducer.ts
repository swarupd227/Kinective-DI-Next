// Pure thread reducer for main-stream events (spec 9.8, 12.4). The store wraps it with sequence
// ordering; this function assumes events arrive in order.
import { applyPatch, deepClone } from 'fast-json-patch';
import type { NoticeBlock, StreamEvent, StreamingEnvelope } from '@dinext/block-schemas';

export type BlockStatus = 'streaming' | 'complete' | 'error';

export interface BlockEntry {
  envelope: StreamingEnvelope;
  status: BlockStatus;
  /** Set when a patch failed to apply; the block is discarded and must be re-requested (FE-GEN-040). */
  failedPatch?: boolean;
}

export type RunState = 'running' | 'completed' | 'failed' | 'cancelled';

export type Turn =
  | { kind: 'user'; id: string; text: string; at: string }
  | { kind: 'agent'; id: string; runId: string; agents: string[]; blockIds: string[]; state: RunState; at: string; suggestion?: string };

export interface ThreadState {
  threadId: string;
  lastSeq: number;
  turns: Turn[];
  blocks: Record<string, BlockEntry>;
  pendingApprovals: string[];
}

export const emptyThread = (threadId: string): ThreadState => ({ threadId, lastSeq: 0, turns: [], blocks: {}, pendingApprovals: [] });

const agentTurn = (s: ThreadState, runId: string | undefined) =>
  runId ? (s.turns.findLast((t) => t.kind === 'agent' && t.runId === runId) as Extract<Turn, { kind: 'agent' }> | undefined) : undefined;

function updateTurn(s: ThreadState, runId: string | undefined, fn: (t: Extract<Turn, { kind: 'agent' }>) => Extract<Turn, { kind: 'agent' }>): Turn[] {
  const target = agentTurn(s, runId);
  return target ? s.turns.map((t) => (t === target ? fn(target) : t)) : s.turns;
}

function updateBlock(s: ThreadState, blockId: string, fn: (b: BlockEntry) => BlockEntry): Record<string, BlockEntry> {
  const b = s.blocks[blockId];
  return b ? { ...s.blocks, [blockId]: fn(b) } : s.blocks;
}

function findPlanBlock(s: ThreadState, runId: string): string | undefined {
  const turn = agentTurn(s, runId);
  return turn?.blockIds.find((id) => s.blocks[id]?.envelope.type === 'plan_steps');
}

function setPlanState(s: ThreadState, runId: string, state: RunState): Record<string, BlockEntry> {
  const id = findPlanBlock(s, runId);
  return id ? updateBlock(s, id, (b) => ({ ...b, envelope: { ...b.envelope, data: { ...b.envelope.data, state } } })) : s.blocks;
}

let noticeCounter = 0;
const errorNotice = (runId: string, agent: string, error: { code: string; userMessage: string; permission?: string; referenceId?: string }): StreamingEnvelope => {
  const kind: NoticeBlock['data']['kind'] = error.code === 'PERMISSION_DENIED' ? 'no_access' : 'error';
  noticeCounter += 1;
  return {
    id: `blk_runerr${runId.replace(/[^A-Za-z0-9]/g, '').slice(-10)}${noticeCounter}`.padEnd(16, '0'),
    type: 'notice',
    version: '1.0.0',
    provenance: { agent, runId, sources: [] },
    freshness: { kind: 'none' },
    data: { kind, message: error.userMessage, permission: error.permission, referenceId: error.referenceId, retryable: kind === 'error' },
  };
};

export function reduce(s: ThreadState, e: StreamEvent): ThreadState {
  const next: ThreadState = { ...s, lastSeq: e.seq };
  switch (e.type) {
    case 'message.accepted':
      return { ...next, turns: [...s.turns, { kind: 'user', id: e.messageId ?? e.clientMessageId, text: e.text, at: e.ts }] };

    case 'run.started':
      return { ...next, turns: [...s.turns, { kind: 'agent', id: e.runId, runId: e.runId, agents: e.agents, blockIds: [], state: 'running', at: e.ts }] };

    case 'routing':
      return { ...next, turns: updateTurn(s, e.runId, (t) => ({ ...t, agents: t.agents.includes(e.agent) ? t.agents : [...t.agents, e.agent] })) };

    case 'block.start': {
      const envelope = { ...e.block, status: 'streaming' as const };
      return {
        ...next,
        blocks: { ...s.blocks, [envelope.id]: { envelope, status: 'streaming' } },
        turns: updateTurn(s, e.runId ?? envelope.provenance.runId, (t) => (t.blockIds.includes(envelope.id) ? t : { ...t, blockIds: [...t.blockIds, envelope.id] })),
      };
    }

    case 'token.delta':
      return {
        ...next,
        blocks: updateBlock(s, e.blockId, (b) => ({
          ...b,
          envelope: { ...b.envelope, data: { ...b.envelope.data, markdown: `${String(b.envelope.data.markdown ?? '')}${e.text}` } },
        })),
      };

    case 'block.patch':
      return {
        ...next,
        blocks: updateBlock(s, e.blockId, (b) => {
          if (b.failedPatch) return b;
          try {
            const data = applyPatch(deepClone(b.envelope.data), e.ops as Parameters<typeof applyPatch>[1], true, false).newDocument;
            return { ...b, envelope: { ...b.envelope, data } };
          } catch {
            return { ...b, status: 'error', failedPatch: true };
          }
        }),
      };

    case 'block.end':
      return {
        ...next,
        blocks: updateBlock(s, e.blockId, (b) => (b.failedPatch ? b : { ...b, status: 'complete', envelope: { ...b.envelope, status: 'complete' } })),
      };

    case 'tool.progress': {
      const planId = e.blockId ?? findPlanBlock(s, e.runId);
      if (!planId) return next;
      return {
        ...next,
        blocks: updateBlock(s, planId, (b) => {
          const steps = (b.envelope.data.steps as Array<Record<string, unknown>> | undefined) ?? [];
          const exists = steps.some((st) => st.id === e.step.id);
          const merged = (st: Record<string, unknown>) => ({
            ...st,
            ...Object.fromEntries(Object.entries(e.step).filter(([k, v]) => v !== undefined && k !== 'operation')),
            ...(e.step.state === 'running' && !st.startedAt ? { startedAt: e.ts } : {}),
            ...(['done', 'failed', 'skipped'].includes(e.step.state) ? { endedAt: e.ts } : {}),
          });
          const nextSteps = exists ? steps.map((st) => (st.id === e.step.id ? merged(st) : st)) : [...steps, merged({ id: e.step.id, agent: e.step.agent ?? '', label: e.step.label ?? '' })];
          return { ...b, envelope: { ...b.envelope, data: { ...b.envelope.data, steps: nextSteps } } };
        }),
      };
    }

    case 'approval.requested':
      return { ...next, pendingApprovals: s.pendingApprovals.includes(e.blockId) ? s.pendingApprovals : [...s.pendingApprovals, e.blockId] };

    case 'approval.resolved':
      return {
        ...next,
        pendingApprovals: s.pendingApprovals.filter((id) => id !== e.blockId),
        blocks: updateBlock(s, e.blockId, (b) => ({
          ...b,
          envelope: { ...b.envelope, data: { ...b.envelope.data, resolution: { decision: e.decision, by: e.by, at: e.ts, channel: e.channel } } },
        })),
      };

    case 'run.completed':
      return { ...next, turns: updateTurn(s, e.runId, (t) => ({ ...t, state: 'completed' })), blocks: setPlanState(s, e.runId, 'completed') };

    case 'run.cancelled':
      return { ...next, turns: updateTurn(s, e.runId, (t) => ({ ...t, state: 'cancelled' })), blocks: setPlanState(s, e.runId, 'cancelled') };

    case 'run.failed': {
      const turn = agentTurn(s, e.runId);
      const notice = errorNotice(e.runId, turn?.agents.at(-1) ?? 'DI Concierge', e.error);
      const withPlan = setPlanState(s, e.runId, 'failed');
      return {
        ...next,
        blocks: { ...withPlan, [notice.id]: { envelope: { ...notice, status: 'complete' }, status: 'complete' } },
        turns: updateTurn(s, e.runId, (t) => ({ ...t, state: 'failed', blockIds: [...t.blockIds, notice.id] })),
      };
    }

    case 'suggestion':
      return { ...next, turns: updateTurn(s, e.runId, (t) => ({ ...t, suggestion: e.text })) };

    default:
      // Unknown or session-level events advance the sequence only (FE-API-001).
      return next;
  }
}
