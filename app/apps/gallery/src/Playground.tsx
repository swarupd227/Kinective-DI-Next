// A thin conversation canvas over the mock stream server. It exercises the real protocol
// (ticketed socket, ordering, patches, approvals over REST) ahead of the Slice 1 shell.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { ArrowUp, CornerDownLeft, Lightbulb, Paperclip, Mic, WifiOff } from 'lucide-react';
import { BlockHostProvider, BlockRenderer, type BlockHost } from '@dinext/blocks';
import { IconButton, useAnnouncer, useToast } from '@dinext/ui';
import { createApiClient, createStreamStore, newClientMessageId, StreamConnection, type ConnectionState, type Turn } from '@dinext/stream-client';
import { AgentResponse } from './AgentResponse.tsx';
import styles from './Playground.module.css';

const SAMPLES = [
  { label: 'Loan growth by branch', text: 'Show loan growth by branch for Q3 vs Q2' },
  { label: 'Brief me', text: 'Brief me on what changed overnight' },
  { label: 'Refer a member', text: 'Refer Suzanne Jackson for a HELOC, she prefers a call after 5 pm' },
  { label: 'Approve payouts', text: 'Approve October incentive payouts for Westport' },
  { label: 'Long run', text: 'Find certificates at risk of leaving' },
  { label: 'No access', text: 'Show Northgate loan detail' },
  { label: 'Protocol chaos', text: 'Run the protocol resilience test' },
];

const threadId = `thr_${Math.random().toString(36).slice(2, 10)}`;

export function Playground() {
  const toast = useToast();
  const { announce } = useAnnouncer();
  const [conn, setConn] = useState<ConnectionState>('connecting');
  const [api] = useState(() => createApiClient({ baseUrl: '' }));
  const [session] = useState(() => {
    const connection: { current?: StreamConnection } = {};
    // A gap that does not fill within 2 s triggers a reconnect, and the resume replays it.
    const stream = createStreamStore({ onGap: () => connection.current?.requestReplay() });
    connection.current = new StreamConnection({
      store: stream,
      clientVersion: '0.1.0',
      onState: setConn,
      url: async () => {
        const res = await fetch('/v1/stream/ticket', { method: 'POST' });
        if (!res.ok) throw new Error('ticket');
        const { ticket } = (await res.json()) as { ticket: string };
        return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/stream?ticket=${ticket}`;
      },
    });
    return { stream, connection: connection.current };
  });
  const thread = useStore(session.stream.store, (s) => s.threads[threadId]);

  useEffect(() => {
    session.connection.subscribe(threadId);
    session.connection.start();
    return () => session.connection.stop();
  }, [session]);

  const turns = useMemo(() => thread?.turns ?? [], [thread]);
  const running = turns.find((t): t is Extract<Turn, { kind: 'agent' }> => t.kind === 'agent' && t.state === 'running');

  // Announce completion once per run (spec 10.8: "Response complete, 3 blocks").
  const announcedRuns = useRef(new Set<string>());
  useEffect(() => {
    for (const t of turns) {
      if (t.kind !== 'agent' || t.state === 'running' || announcedRuns.current.has(t.runId)) continue;
      announcedRuns.current.add(t.runId);
      const types = t.blockIds.map((id) => thread?.blocks[id]?.envelope.type.replace('_', ' ')).filter((x) => x && x !== 'plan steps');
      announce(t.state === 'completed' ? `Response complete, ${types.length} blocks: ${types.join(', ')}` : `Run ${t.state}`);
    }
  }, [turns, thread, announce]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      try {
        await api.sendMessage(threadId, { clientMessageId: newClientMessageId(), input: { kind: 'text', text: trimmed }, inputChannel: 'text', context: [] });
        return true;
      } catch {
        toast.show('Could not send. Is the mock server running?');
        return false;
      }
    },
    [api, toast],
  );

  const host = useMemo<BlockHost>(
    () => ({
      canViewSql: true,
      voiceMediumAllowed: true,
      onDecision: (block, decision, key) => api.decide(block.data.approvalId, decision, key),
      onStepUp: async () => {
        toast.show('Signed in again (simulated step-up)');
        return api.stepUp();
      },
      onCancelRun: (runId) => void api.cancelRun(runId),
      onAction: (_b, a) => toast.show(`${a.label}: wired up in Slice 1`),
      onSourceOpen: (_b, s) => toast.show(`Open ${s.label}: wired up in Slice 1`),
      onRetry: () => toast.show('Retry requested'),
      onNoticeOption: (_b, id) => toast.show(`Clarification ${id} sent`),
    }),
    [api, toast],
  );

  // Esc cancels the running run while focus is in the canvas or composer (FE-EXP-090).
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && running) {
      e.preventDefault();
      void api.cancelRun(running.runId);
      announce('Stopping the run');
    }
  };

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    // Esc to cancel is a canvas-wide shortcut, captured from whichever control has focus.
    <div className={styles.page} onKeyDownCapture={onKeyDownCapture}>
      {conn !== 'open' && (
        <div className={styles.banner} role="status">
          <WifiOff size={14} aria-hidden />
          {conn === 'connecting' ? 'Connecting to the mock stream server…' : 'Reconnecting… Messages are held until the connection is back.'}
        </div>
      )}
      <div
        ref={scroller}
        className={styles.canvas}
        role="log"
        aria-label="Conversation"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className={styles.column}>
          {turns.length === 0 && <Empty onPick={(t) => void send(t)} />}
          <BlockHostProvider value={host}>
            {turns.map((t) =>
              t.kind === 'user' ? (
                <div key={t.id} className={styles.user}>
                  <p>{t.text}</p>
                </div>
              ) : (
                <article key={t.id} aria-label={`Response from ${t.agents.at(-1) ?? 'DI Concierge'}`}>
                  <AgentResponse
                    agent={t.agents.at(-1) ?? 'DI Concierge'}
                    footer={
                      t.suggestion && (
                        <button type="button" className={styles.suggestion} onClick={() => void send(t.suggestion!)}>
                          <Lightbulb size={14} aria-hidden />
                          {t.suggestion}
                        </button>
                      )
                    }
                  >
                    {t.blockIds.length === 0 && t.state === 'running' && <Thinking />}
                    {t.blockIds.map((id) => {
                      const entry = thread?.blocks[id];
                      if (!entry) return null;
                      return <BlockRenderer key={id} block={entry.envelope} status={entry.status === 'complete' ? 'complete' : entry.status === 'error' ? 'complete' : 'streaming'} />;
                    })}
                  </AgentResponse>
                </article>
              ),
            )}
          </BlockHostProvider>
        </div>
      </div>
      <Composer disabled={conn !== 'open'} running={Boolean(running)} onSend={send} />
    </div>
  );
}

function Thinking() {
  return (
    <p className={styles.thinking} role="status">
      <span className={styles.dots} aria-hidden>
        <span />
        <span />
        <span />
      </span>
      Working out who should answer…
    </p>
  );
}

function Empty({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className={styles.empty}>
      <h1 className={styles.emptyTitle}>Good morning, Dana</h1>
      <p className={styles.emptySub}>This canvas is connected to the mock stream server. Each prompt plays a scripted agent run.</p>
      <ul className={styles.samples} aria-label="Try asking">
        {SAMPLES.map((s) => (
          <li key={s.label}>
            <button type="button" className={styles.sample} onClick={() => onPick(s.text)}>
              <span className={styles.sampleLabel}>{s.label}</span>
              <span className={styles.sampleText}>{s.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Composer({ disabled, running, onSend }: { disabled: boolean; running: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // "/" focuses the conversation bar when focus is not already in a field (spec 10.7).
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = async () => {
    if (disabled || !text.trim()) return;
    if (await onSend(text)) setText('');
  };

  return (
    <div className={styles.composerWrap}>
      <div className={styles.composer}>
        <IconButton label="Attach a file (Slice 1)" icon={<Paperclip size={18} aria-hidden />} disabled />
        <label htmlFor="composer" className="dn-visually-hidden">
          Ask DI
        </label>
        <textarea
          id="composer"
          ref={ref}
          rows={1}
          className={styles.input}
          placeholder="Ask DI or type / for commands…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <IconButton label="Push to talk (Slice 3)" icon={<Mic size={18} aria-hidden />} disabled />
        <button type="button" className={styles.send} onClick={() => void submit()} disabled={disabled || !text.trim()} aria-label="Send">
          <ArrowUp size={18} aria-hidden />
        </button>
      </div>
      <p className={styles.hint}>
        <CornerDownLeft size={12} aria-hidden /> Enter to send · Shift+Enter for a new line{running && ' · Esc to stop the run'}
      </p>
    </div>
  );
}
