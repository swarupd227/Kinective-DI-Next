// Conversation turns on the canvas (spec 6.2, 6.17, 10.8): each agent response is an article
// headed by the routing ("DI Concierge → Analytics Q&A") and made of blocks.
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronRight, Lightbulb, Sparkles } from 'lucide-react';
import { BlockRenderer } from '@dinext/blocks';
import type { ThreadState, Turn } from '@dinext/stream-client';
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
  const routed = agent !== 'DI Concierge';
  return (
    <article className={styles.agent} aria-label={`Response from ${agent}`}>
      <div className={styles.avatar} aria-hidden>
        <Sparkles size={14} />
      </div>
      <div className={styles.body}>
        <h2 className={styles.who}>
          DI Concierge
          {routed && (
            <>
              <ChevronRight size={12} aria-hidden className={styles.arrow} />
              <span className="dn-visually-hidden">routed to </span>
              <span className={styles.agentName}>{agent}</span>
            </>
          )}
          <span className={styles.time}>{clock(turn.at)}</span>
        </h2>
        <div className={styles.blocks}>
          {turn.blockIds.length === 0 && turn.state === 'running' && <Thinking />}
          {turn.blockIds.map((id) => {
            const entry = thread.blocks[id];
            if (!entry) return null;
            return (
              <div key={id} id={`b-${id}`} className={clsx(styles.blockSlot, highlight === id && styles.highlight)}>
                <BlockRenderer block={entry.envelope} status={entry.status === 'streaming' ? 'streaming' : 'complete'} />
              </div>
            );
          })}
        </div>
        {turn.suggestion && (
          // Suggestions never start a write; they ask a follow-up question (FE-EXP-020).
          <button type="button" className={styles.suggestion} onClick={() => onSuggestion(turn.suggestion!)}>
            <Lightbulb size={14} aria-hidden />
            {turn.suggestion}
          </button>
        )}
      </div>
    </article>
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
      Finding the right specialist…
    </p>
  );
}

export function EmptyConversation({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyMark} aria-hidden>
        <Sparkles size={20} />
      </span>
      <h1 className={styles.emptyTitle}>{title}</h1>
      {children}
    </div>
  );
}
