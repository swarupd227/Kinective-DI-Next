import { createContext, useContext, type ReactNode } from 'react';
import type { ApprovalDecisionRequest, ApprovalErrorCode, Block, BlockAction, ReportCanvasBlock, Source } from '@dinext/block-schemas';

/** An edit made on the canvas itself (FE-BLD-002, FE-BLD-003). */
export type ReportEditOp = { kind: 'accept' | 'revert'; editId: string } | { kind: 'move'; widgetId: string; position: number } | { kind: 'resize'; widgetId: string; size: 'quarter' | 'third' | 'half' | 'full' } | { kind: 'remove'; widgetId: string };

export type ApprovalResult =
  | { ok: true; decision: 'approved' | 'denied' | 'returned'; by: string; at: string }
  | { ok: false; code: ApprovalErrorCode; message?: string };

/**
 * What blocks can ask the host to do. The host (canvas, gallery, Home) wires these to the
 * Experience Layer; blocks never call APIs themselves.
 */
export interface BlockHost {
  onAction?: (block: Block, action: BlockAction) => void;
  onSourceOpen?: (block: Block, source: Source) => void;
  onDecision?: (block: Block & { type: 'approval_card' }, decision: ApprovalDecisionRequest, idempotencyKey: string) => Promise<ApprovalResult>;
  /** Starts step-up re-authentication with the identity provider and resolves with a token (FE-EXP-082). */
  onStepUp?: () => Promise<string | null>;
  onCancelRun?: (runId: string) => void;
  onRetry?: (block: Block) => void;
  onNoticeOption?: (block: Block, optionId: string) => void;
  /** Opens a DI Next deep link (list items, text links) in the host's router. */
  onNavigate?: (link: string) => void;
  /** Whether the user may see SQL in plan steps (Query Browser permission, FE-EXP-061). */
  canViewSql?: boolean;
  /** Home lists approvals as summaries that expand on Review (spec 6.3 wireframe). */
  approvalDisplay?: 'full' | 'summary';
  /** Tenant allows spoken confirmation of medium-risk approvals (spec 6.10). */
  voiceMediumAllowed?: boolean;
  /** Re-runs a report for new control values, without a conversation turn (spec 8.5). */
  runReport?: (templateRef: string, controls: Record<string, string>) => Promise<ReportCanvasBlock | null>;
  /** Applies a canvas edit to a draft report and returns the re-run canvas. */
  editReport?: (templateRef: string, op: ReportEditOp, controls: Record<string, string>) => Promise<ReportCanvasBlock | null>;
  now?: () => number;
}

const BlockHostContext = createContext<BlockHost>({});

export const BlockHostProvider = ({ value, children }: { value: BlockHost; children: ReactNode }) => (
  <BlockHostContext.Provider value={value}>{children}</BlockHostContext.Provider>
);

export const useBlockHost = () => useContext(BlockHostContext);
