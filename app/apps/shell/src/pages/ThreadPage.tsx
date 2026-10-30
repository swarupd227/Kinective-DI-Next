// A task (spec 6.6, 6.8). The thread is rebuilt from the stream: following it replays its events, so
// reloads, shared links and reconnects all land on the same state. A task with a plan opens its
// progress beside the conversation, and the report it builds opens there when it is ready.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { useStore } from 'zustand';
import { BlockHostProvider } from '@dinext/blocks';
import { Button, useAnnouncer } from '@dinext/ui';
import { ApiError } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { useShellBlockHost } from '../shell/useShellBlockHost.ts';
import { useUi } from '../shell/uiStore.ts';
import { useBreakpoint } from '../shell/useBreakpoint.ts';
import { AgentTurn, EmptyConversation, UserTurn } from '../conversation/Turns.tsx';
import styles from './ThreadPage.module.css';
import page from './Page.module.css';

export function ThreadPage() {
  const { threadId = '', blockId } = useParams();
  const { api, connection, stream, send, terms } = useSession();
  const { announce } = useAnnouncer();
  const host = useShellBlockHost({ threadId });
  const summary = useQuery({ queryKey: ['thread', threadId], queryFn: () => api.thread(threadId), refetchInterval: (q) => (q.state.data?.title === 'New conversation' ? 1500 : false) });
  const thread = useStore(stream.store, (s) => s.threads[threadId]);

  useEffect(() => {
    connection.subscribe(threadId);
  }, [connection, threadId]);

  useEffect(() => {
    if (summary.data) useUi.getState().visit({ kind: 'thread', path: `/c/${threadId}`, label: summary.data.title });
  }, [summary.data, threadId]);

  const bp = useBreakpoint();
  const wide = bp === 'desktop' || bp === 'laptop';
  const blocks = thread?.blocks;
  const hasPlan = Object.values(blocks ?? {}).some((b) => b.envelope.type === 'plan_steps' && b.envelope.output);
  const report = Object.values(blocks ?? {}).find((b) => (b.envelope.type === 'report_canvas' || b.envelope.type === 'member_360') && b.envelope.output && b.status === 'complete');
  const openTask = () => useUi.getState().openWorkspace({ kind: 'task', threadId, label: 'This task' });
  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (!wide) return;
    if (hasPlan && !shown.current.has('plan')) {
      shown.current.add('plan');
      openTask();
    }
    if (report && !shown.current.has(report.envelope.id)) {
      shown.current.add(report.envelope.id);
      useUi.getState().openWorkspace({ kind: 'output', threadId, blockId: report.envelope.id, label: report.envelope.output!.label });
      // A member a task reviewed goes on the composer, so "refer her" means them (FE-RM-003).
      if (report.envelope.type === 'member_360') useUi.getState().addContext(threadId, { type: 'member', ref: String(report.envelope.data.memberRef), label: String(report.envelope.data.displayName) });
    }
  });
  // A task's pane belongs to that task.
  useEffect(
    () => () => {
      const w = useUi.getState().workspace;
      if (w && (w.kind === 'task' || w.kind === 'output') && w.threadId === threadId) useUi.getState().closeWorkspace();
    },
    [threadId],
  );

  // Keep the newest content in view unless the user has scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const canvas = document.getElementById('canvas');
    if (!canvas) return;
    const onScroll = () => {
      pinned.current = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 120;
    };
    canvas.addEventListener('scroll', onScroll, { passive: true });
    return () => canvas.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    const canvas = document.getElementById('canvas');
    if (canvas && pinned.current && !blockId) canvas.scrollTop = canvas.scrollHeight;
  });

  // /c/:threadId/b/:blockId scrolls to the block and highlights it (spec 11.4).
  const blockReady = Boolean(blockId && thread?.blocks[blockId]);
  useEffect(() => {
    if (!blockId || !blockReady) return;
    pinned.current = false;
    document.getElementById(`b-${blockId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [blockId, blockReady]);

  // "Response complete, 3 blocks: chart, table, approval needed" (spec 10.8).
  const announced = useRef(new Set<string>());
  const first = useRef(true);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!thread) return;
    for (const t of thread.turns) {
      if (t.kind !== 'agent' || t.state === 'running' || announced.current.has(t.runId)) continue;
      announced.current.add(t.runId);
      if (first.current) continue; // replayed history is not announced
      const types = t.blockIds.map((id) => thread.blocks[id]?.envelope.type).filter((x) => x && x !== 'plan_steps');
      announce(t.state === 'completed' ? `Response complete, ${types.length} ${types.length === 1 ? 'block' : 'blocks'}: ${types.map((x) => x!.replace('_', ' ')).join(', ')}` : `Run ${t.state}`);
      // One member found: the 360 opens beside the conversation and the member becomes a context
      // chip (spec 8.24 acceptance, FE-RM-003). Phones keep the conversation; the card has Open 360.
      const blocks = t.blockIds.map((id) => thread.blocks[id]?.envelope);
      const card = blocks.find((b) => b?.type === 'member_card' && b.data.selected === true);
      if (card && t.state === 'completed') {
        const ref = String(card.data.memberRef);
        const label = String(card.data.displayName);
        useUi.getState().addContext(threadId, { type: 'member', ref, label });
        if (bp === 'desktop' || bp === 'laptop') useUi.getState().openWorkspace({ kind: 'member', ref, label });
      }
      // An approved change to a member record (a decline) shows at once in an open 360.
      if (blocks.some((b) => b?.type === 'approval_card' && b.data.operation === 'relationship.suggestion.decline')) void queryClient.invalidateQueries({ queryKey: ['member'] });
    }
    first.current = false;
  }, [thread, announce, threadId, bp, queryClient]);

  const running = thread?.turns.findLast((t) => t.kind === 'agent' && t.state === 'running');
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && running?.kind === 'agent') {
      e.preventDefault();
      void api.cancelRun(running.runId);
      announce('Stopping the run');
    }
  };

  if (summary.isError && summary.error instanceof ApiError && summary.error.status === 404) {
    return (
      <div className={page.center}>
        <h1 className={page.title}>This conversation is not available</h1>
        <p className={page.lede}>It may have been deleted, or it was shared with someone else.</p>
      </div>
    );
  }

  return (
    // Esc cancels the running run from anywhere in the canvas (FE-EXP-090).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div className={styles.thread} role="log" aria-label={summary.data?.title ?? 'Conversation'} onKeyDown={onKeyDown}>
      {summary.data && (
        <header className={styles.head}>
          <h1 className={styles.title}>{summary.data.title}</h1>
          {hasPlan && (
            <Button size="sm" variant="ghost" icon={<ListChecks size={14} aria-hidden />} onClick={openTask}>
              Progress
            </Button>
          )}
        </header>
      )}
      {!thread?.turns.length && (
        <EmptyConversation title={summary.isPending ? 'Opening conversation…' : 'Ask DI anything'}>
          <p className={page.lede}>Type below, or press Ctrl+K to find a report, table or {terms.person}.</p>
        </EmptyConversation>
      )}
      <BlockHostProvider value={host}>
        {thread?.turns.map((t) =>
          t.kind === 'user' ? (
            <UserTurn key={t.id} turn={t} />
          ) : (
            <AgentTurn key={t.id} turn={t} thread={thread} highlight={blockId} onSuggestion={(s) => void send(threadId, s)} />
          ),
        )}
      </BlockHostProvider>
    </div>
  );
}
