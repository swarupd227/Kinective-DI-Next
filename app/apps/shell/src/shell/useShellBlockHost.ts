// Wires block actions to the shell (spec 6.12 Explain, 6.13 source chips, 6.10 approvals).
// Blocks never call APIs; everything they can do goes through this host.
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { Block, BlockAction, ContextRef } from '@dinext/block-schemas';
import type { ApprovalResult, BlockHost } from '@dinext/blocks';
import { useToast } from '@dinext/ui';
import { useSession } from '../session/SessionProvider.tsx';
import { useUi } from './uiStore.ts';

const humanise = (metricRef: string) => metricRef.replace(/^metric:/, '').replaceAll('_', ' ');

function labelOf(block: Block, action?: BlockAction): string {
  const metricRef = action?.params?.metricRef;
  if (typeof metricRef === 'string') {
    if (block.type === 'kpi_group') return block.data.items.find((i) => i.metricRef === metricRef)?.label ?? humanise(metricRef);
    return humanise(metricRef);
  }
  if (block.type === 'kpi') return block.data.label;
  return block.title ?? block.type.replace('_', ' ');
}

export interface ShellHostOptions {
  /** The thread the blocks belong to; without one (Home), follow-ups start a new thread. */
  threadId?: string;
  /** Home cards have no thread to carry approval.resolved, so the page records the result itself. */
  onResolved?: (block: Block, result: Extract<ApprovalResult, { ok: true }>) => void;
  approvalDisplay?: 'full' | 'summary';
}

export function useShellBlockHost({ threadId, onResolved, approvalDisplay = 'full' }: ShellHostOptions = {}): BlockHost {
  const { session, api, send, startThread } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { openWorkspace, addContext } = useUi.getState();

  return useMemo<BlockHost>(() => {
    const ask = async (text: string, context: ContextRef[] = []) => {
      if (threadId) return send(threadId, text, context);
      const id = await startThread(text, context);
      navigate(`/c/${id}`);
    };

    return {
      canViewSql: session.permissions.queryBrowser,
      approvalDisplay,
      voiceMediumAllowed: session.flags.voiceMediumConfirm,
      runReport: (templateRef, controls) => api.runReport(templateRef, controls).catch(() => null),
      editReport: (templateRef, op, controls) => api.editReport(templateRef, op, controls).catch(() => null),
      // Export downloads are plain links to the server, not routes in the app.
      onNavigate: (link) => (link.startsWith('/v1/exports/') ? window.location.assign(link) : navigate(link)),
      onAction: (block, action) => {
        const label = labelOf(block, action);
        // Member actions carry the record token: the request goes with a member chip, never a number (FE-RM-003).
        const memberRef = typeof action.params?.memberRef === 'string' ? action.params.memberRef : null;
        const member: ContextRef[] = memberRef ? [{ type: 'member', ref: memberRef, label: String(action.params?.label ?? 'Member') }] : [];
        if (memberRef) addContext(threadId ?? 'new', member[0]!);
        switch (action.kind) {
          case 'open_record':
            if (memberRef) openWorkspace({ kind: 'member', ref: memberRef, label: member[0]!.label });
            return;
          case 'explain':
            if (memberRef && action.params?.question) void ask(String(action.params.question), member);
            else void ask(`Explain ${label}`, [{ type: 'block', ref: block.id, label }]);
            return;
          case 'run_operation':
            // "Refer" and "Member declined" become a request in the conversation, so the agent
            // prepares the approval card; nothing runs from the click itself (spec 6.10).
            if (action.params?.question) void ask(String(action.params.question), member);
            return;
          case 'open_workspace':
            openWorkspace({ kind: 'block', block, label: block.title ?? label });
            addContext(threadId ?? 'new', { type: 'table', ref: `block:${block.id}`, label: block.title ?? label });
            return;
          case 'drill':
          case 'ask_followup':
            void ask(String(action.params?.question ?? `Drill into ${String(action.params?.category ?? label)}`), [{ type: 'block', ref: block.id, label }]);
            return;
          case 'pin':
            toast.show('Pinning to Home arrives in the next slice');
            return;
          case 'export':
            // Report exports are approved writes: the request goes to the conversation (spec 8.5).
            if (action.params?.question) void ask(String(action.params.question));
            else toast.show('Export a table or chart as part of a report: open it in Reports');
            return;
          default:
            toast.show(`${action.label} is not available yet`);
        }
      },
      onSourceOpen: (block, source) => {
        if ((source.kind === 'table' || source.kind === 'view') && source.ref?.startsWith('table:')) {
          // Table chips open the table in the workspace with the block's filters (FE-EXP-111).
          const tableId = source.ref.slice('table:'.length);
          openWorkspace({ kind: 'table', tableId, label: source.label });
          addContext(threadId ?? 'new', { type: 'table', ref: tableId, label: source.label });
        } else if (source.kind === 'metric') {
          void ask(`Explain ${source.label.replace(/ \(definition\)$/, '')}`, [{ type: 'block', ref: block.id, label: source.label }]);
        } else {
          toast.show(`${source.label} opens in its classic view in a later slice`);
        }
      },
      onDecision: async (block, decision, key) => {
        const result = await api.decide(block.data.approvalId, decision, key);
        if (result.ok) onResolved?.(block, result);
        return result;
      },
      onStepUp: async () => {
        // The identity provider would prompt here (prompt=login); the mock issues a token at once.
        toast.show('Signed in again for this approval');
        return api.stepUp();
      },
      onCancelRun: (runId) => void api.cancelRun(runId),
      onRetry: (block) => void ask('Try that again', [{ type: 'block', ref: block.id, label: block.title ?? 'previous answer' }]),
      onNoticeOption: (block, optionId) => {
        const option = block.type === 'notice' ? block.data.options?.find((o) => o.id === optionId) : undefined;
        if (option) void ask(option.label);
      },
    };
  }, [session, api, send, startThread, navigate, toast, threadId, onResolved, approvalDisplay, openWorkspace, addContext]);
}
