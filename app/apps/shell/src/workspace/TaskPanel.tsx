// Beside a task: the plan as it runs, the work it has produced, and what that work came from.
// Everything here is read from the thread's stream, so it survives reloads and shared links.
import { useStore } from 'zustand';
import { ChevronRight, Hand } from 'lucide-react';
import { BlockHostProvider, BlockRenderer, PlanStepsView } from '@dinext/blocks';
import type { ApprovalData, Block, PlanStepsBlock } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';
import { useShellBlockHost } from '../shell/useShellBlockHost.ts';
import { useUi } from '../shell/uiStore.ts';
import { OutputIcon } from './OutputIcon.tsx';
import styles from './TaskPanel.module.css';

export function TaskPanel({ threadId }: { threadId: string }) {
  const { stream } = useSession();
  const thread = useStore(stream.store, (s) => s.threads[threadId]);
  const host = useShellBlockHost({ threadId });
  const { openWorkspace } = useUi.getState();
  if (!thread) return null;

  const blocks = thread.turns.flatMap((t) => (t.kind === 'agent' ? t.blockIds : [])).flatMap((id) => (thread.blocks[id] ? [thread.blocks[id]!] : []));
  const plan = blocks.find((b) => b.envelope.type === 'plan_steps' && b.envelope.output)?.envelope as unknown as PlanStepsBlock | undefined;
  const outputs = blocks.filter((b) => b.envelope.output && b.envelope.type !== 'plan_steps');
  const waiting = thread.pendingApprovals.map((id) => thread.blocks[id]?.envelope.data as Partial<ApprovalData> | undefined).filter(Boolean);
  const sources = [...new Map(outputs.flatMap((b) => b.envelope.provenance.sources).map((s) => [s.label, s])).values()];

  return (
    <BlockHostProvider value={host}>
      <div className={styles.panel}>
        {waiting.length > 0 && (
          <p className={styles.waiting} role="status">
            <Hand size={15} aria-hidden />
            Waiting for your approval in the conversation
          </p>
        )}
        {plan && (
          <section aria-labelledby="task-progress">
            <h3 id="task-progress" className={styles.heading}>
              Progress
            </h3>
            <PlanStepsView block={plan} />
          </section>
        )}
        <section aria-labelledby="task-outputs">
          <h3 id="task-outputs" className={styles.heading}>
            Outputs
          </h3>
          {outputs.length === 0 ? (
            <p className={styles.empty}>What I produce for this task appears here.</p>
          ) : (
            <ul className={styles.outputs}>
              {outputs.map((b) => {
                const label = b.envelope.output!.label;
                return (
                  <li key={b.envelope.id}>
                    <button type="button" className={styles.output} onClick={() => openWorkspace({ kind: 'output', threadId, blockId: b.envelope.id, label })}>
                      <OutputIcon type={b.envelope.type} className={styles.outputIcon} />
                      <span className={styles.outputText}>
                        <span className={styles.outputLabel}>{label}</span>
                        {b.envelope.output!.summary && <span className={styles.outputSummary}>{b.envelope.output!.summary}</span>}
                      </span>
                      <ChevronRight size={14} aria-hidden className={styles.outputIcon} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {sources.length > 0 && (
          <section aria-labelledby="task-sources">
            <h3 id="task-sources" className={styles.heading}>
              Sources
            </h3>
            <ul className={styles.sources}>
              {sources.map((s) => (
                <li key={s.label}>{s.label.replace(/ \(definition\)$/, '')}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </BlockHostProvider>
  );
}

/** One output at full size beside the conversation. */
export function TaskOutput({ threadId, blockId }: { threadId: string; blockId: string }) {
  const { stream } = useSession();
  const entry = useStore(stream.store, (s) => s.threads[threadId]?.blocks[blockId]);
  const host = useShellBlockHost({ threadId });
  if (!entry) return null;
  return (
    <BlockHostProvider value={host}>
      <BlockRenderer block={entry.envelope as Block} status={entry.status === 'streaming' ? 'streaming' : 'complete'} />
    </BlockHostProvider>
  );
}
