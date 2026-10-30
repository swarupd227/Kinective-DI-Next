// Main stream protocol (spec 12.2-12.5). Shared by the client and the mock stream server.
import type { RiskTier, StreamingEnvelope } from './envelope.ts';
import type { AppNotification } from './api-types.ts';

export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

interface Base {
  threadId: string;
  seq: number;
  ts: string;
  runId?: string;
  messageId?: string;
}

export type StreamEvent =
  | (Base & { type: 'message.accepted'; clientMessageId: string; text: string })
  | (Base & { type: 'run.started'; runId: string; agents: string[] })
  | (Base & { type: 'routing'; runId: string; agent: string; reason?: string })
  | (Base & { type: 'token.delta'; blockId: string; text: string })
  | (Base & { type: 'block.start'; block: StreamingEnvelope })
  | (Base & { type: 'block.patch'; blockId: string; ops: JsonPatchOp[] })
  | (Base & { type: 'block.end'; blockId: string })
  | (Base & { type: 'tool.progress'; runId: string; blockId: string; step: { id: string; label?: string; agent?: string; state: string; operation?: string; resultSummary?: string } })
  | (Base & { type: 'approval.requested'; approvalId: string; blockId: string; riskTier: RiskTier; expiresAt: string })
  | (Base & {
      type: 'approval.resolved';
      approvalId: string;
      blockId: string;
      decision: 'approved' | 'denied' | 'returned' | 'expired';
      by: string;
      channel?: 'click' | 'keyboard' | 'voice';
    })
  | (Base & { type: 'run.completed'; runId: string; summary?: string })
  | (Base & { type: 'run.failed'; runId: string; error: { code: string; userMessage: string; permission?: string; referenceId?: string } })
  | (Base & { type: 'run.cancelled'; runId: string; completedSteps: string[] })
  | (Base & { type: 'suggestion'; text: string })
  | (Base & { type: 'build.status'; state: 'started' | 'completed' | 'failed' | 'late'; asOf?: string });

export type StreamEventType = StreamEvent['type'];

/** Events that are not bound to a thread sequence (heartbeat, session-level). */
export type ControlEvent =
  | { type: 'welcome'; sessionId: string; serverTime: string; heartbeatSeconds: number }
  | { type: 'pong' }
  | { type: 'replay.unavailable'; threadId: string }
  /** Bell notifications are session-wide, not part of a thread sequence (spec 8.4, FE-NOTE-002). */
  | { type: 'notification'; notification: AppNotification };

/**
 * The socket only carries threads the client follows. Resume entries in hello re-subscribe after a
 * reconnect; subscribe with lastSeq 0 replays a thread from the start (spec 12.4 subscribe).
 */
export type ClientMessage =
  | { type: 'hello'; clientVersion: string; locale: string; blockSupport: Record<string, string>; resume: { threadId: string; lastSeq: number }[] }
  | { type: 'ping' }
  | { type: 'run.cancel'; runId: string }
  | { type: 'ack'; threadId: string; seq: number }
  | { type: 'subscribe'; threadId: string; lastSeq: number }
  | { type: 'unsubscribe'; threadId: string };

/** A context chip sent as a typed reference, never as pasted text (spec 6.7, FE-EXP-050). */
export interface ContextRef {
  type: 'member' | 'hierarchy_node' | 'employee' | 'period' | 'report' | 'table' | 'rows' | 'workflow_item' | 'file' | 'block';
  ref: string;
  label: string;
}

export interface SendMessageRequest {
  clientMessageId: string;
  input: { kind: 'text'; text: string };
  inputChannel: 'text' | 'voice';
  context: ContextRef[];
  slashCommand?: string;
}

export interface ApprovalDecisionRequest {
  decision: 'approve' | 'deny' | 'return' | 'edit';
  channel: 'click' | 'keyboard' | 'voice';
  typedConfirmation: string | null;
  note: string | null;
  editedPlan: null;
  stepUpToken: string | null;
  clientContext: { blockVersionSeen: string; previewHash: string };
}

export type ApprovalErrorCode = 'STEP_UP_REQUIRED' | 'PREVIEW_CHANGED' | 'ALREADY_DECIDED' | 'EXPIRED' | 'CONFIRMATION_MISMATCH';
