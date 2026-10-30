// Conversation turns on the canvas (spec 6.2, 6.17, 10.8). The agent speaks in prose; finished work
// appears as a card that opens beside the conversation, and a running task shows its current step.
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronRight, Lightbulb } from 'lucide-react';
import { BlockRenderer } from '@dinext/blocks';
import type { BlockEntry, ThreadState, Turn } from '@dinext/stream-client';
import { useUi } from '../shell/uiStore.ts';
import { OutputIcon } from '../workspace/OutputIcon.tsx';
import styles from './Turns.module.css';

const clock = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export function UserTurn({ turn }: { turn: Extract<Turn, { kind: 'user' }> }) {
  return (
    <div className={styles.user}>
      <span className="dn-visually-hidden">You said at {clock(turn.at)}: </span>
      <p className={styles.bubble}>{turn.text}</p>
      <span className={styles.time} aria-hidden>
        {clock(turn.at)}
      </span>
    </div>
  );
}

function OutputCard({ entry, threadId }: { entry: BlockEntry; threadId: string }) {
  const output = entry.envelope.output!;
  return (
    <button type="button" className={styles.output} onClick={() => useUi.getState().openWorkspace({ kind: 'output', threadId, blockId: entry.envelope.id, label: output.label })}>
      <span className={styles.outputIcon}>
        <OutputIcon type={entry.envelope.type} />
      </span>
      <span className={styles.outputText}>
        <span className={styles.outputLabel}>{output.label}</span>
        {output.summary && <span className={styles.outputSummary}>{output.summary}</span>}
      </span>
      <ChevronRight size={14} aria-hidden className={styles.arrow} />
    </button>
  );
}

/** The step a task is on, at the end of the conversation while it works. */
function currentStep(thread: ThreadState, runId: string) {
  const plan = Object.values(thread.blocks).find((b) => b.envelope.type === 'plan_steps' && b.envelope.output && b.envelope.provenance.runId === runId);
  const steps = (plan?.envelope.data.steps ?? []) as { label: string; state: string }[];
  return steps.find((s) => s.state === 'running')?.label;
}

export function AgentTurn({
  turn,
  thread,
  highlight,
  onSuggestion,
}: {
  turn: Extract<Turn, { kind: 'agent' }>;
  thread: ThreadState;
  highlight?: string;
  onSuggestion: (text: string) => void;
}) {
  const agent = turn.agents.at(-1) ?? 'DI Concierge';
  const specialist = agent !== 'DI Concierge' && agent !== 'DI' ? agent : null;
  const latest = thread.turns.findLast((t) => t.kind === 'agent' && t.runId === turn.runId) === turn;
  const step = latest && turn.state === 'running' && !thread.pendingApprovals.length ? currentStep(thread, turn.runId) : undefined;
  return (
    <article className={styles.agent} aria-label={`Response from ${agent}`}>
      <h2 className={styles.who}>
        <span className={styles.name}>DI</span>
        {specialist && (
          <>
            <span className="dn-visually-hidden">, routed to </span>
            <span className={styles.agentName}>{specialist}</span>
          </>
        )}
        <span className={styles.time}>{clock(turn.at)}</span>
      </h2>
      <div className={styles.blocks}>
        {turn.blockIds.length === 0 && turn.state === 'running' && <Thinking>Thinking…</Thinking>}
        {turn.blockIds.map((id) => {
          const entry = thread.blocks[id];
          if (!entry) return null;
          // A task's plan lives beside the conversation; here it shows as the step in progress.
          if (entry.envelope.type === 'plan_steps' && entry.envelope.output) return null;
          return (
            <div key={id} id={`b-${id}`} className={clsx(styles.blockSlot, highlight === id && styles.highlight)}>
              {entry.envelope.output ? <OutputCard entry={entry} threadId={thread.threadId} /> : <BlockRenderer block={entry.envelope} status={entry.status === 'streaming' ? 'streaming' : 'complete'} />}
            </div>
          );
        })}
        {step && <Thinking>{step}…</Thinking>}
      </div>
      {turn.suggestion && (
        // Suggestions never start a write; they ask a follow-up question (FE-EXP-020).
        <button type="button" className={styles.suggestion} onClick={() => onSuggestion(turn.suggestion!)}>
          <Lightbulb size={14} aria-hidden />
          {turn.suggestion}
        </button>
      )}
    </article>
  );
}

function Thinking({ children }: { children: ReactNode }) {
  return (
    <p className={styles.thinking} role="status">
      <span className={styles.dots} aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {children}
    </p>
  );
}

export function EmptyConversation({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.empty}>
      <h1 className={styles.emptyTitle}>{title}</h1>
      {children}
    </div>
  );
}
