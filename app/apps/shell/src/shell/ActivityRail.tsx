// Agent activity rail (spec 6.2, 6.8): runs in this session, their state, and pending approvals.
// Collapsed to a strip with a count; opens by itself when a run needs the user's approval.
import { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity, CircleCheck, CircleSlash, CircleX, Loader2, PanelRightClose, ShieldAlert } from 'lucide-react';
import { IconButton, RiskBadge, useAnnouncer } from '@dinext/ui';
import type { ApprovalData } from '@dinext/block-schemas';
import type { StreamState, Turn } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { useUi } from './uiStore.ts';
import { useBreakpoint } from './useBreakpoint.ts';
import styles from './ActivityRail.module.css';

type AgentTurn = Extract<Turn, { kind: 'agent' }>;

interface RunRow {
  threadId: string;
  run: AgentTurn;
  question?: string;
}
interface ApprovalRow {
  threadId: string;
  blockId: string;
  data: Partial<ApprovalData>;
}

function selectActivity(s: StreamState): { runs: RunRow[]; approvals: ApprovalRow[] } {
  const runs: RunRow[] = [];
  const approvals: ApprovalRow[] = [];
  for (const t of Object.values(s.threads)) {
    t.turns.forEach((turn, i) => {
      if (turn.kind !== 'agent') return;
      const prev = t.turns[i - 1];
      runs.push({ threadId: t.threadId, run: turn, question: prev?.kind === 'user' ? prev.text : undefined });
    });
    for (const blockId of t.pendingApprovals) approvals.push({ threadId: t.threadId, blockId, data: t.blocks[blockId]?.envelope.data as Partial<ApprovalData> });
  }
  runs.sort((a, b) => b.run.at.localeCompare(a.run.at));
  return { runs: runs.slice(0, 12), approvals };
}

export function ActivityRail() {
  const { stream, api } = useSession();
  const bp = useBreakpoint();
  const { railOpen, setRail } = useUi();
  const { announce } = useAnnouncer();
  const navigate = useNavigate();
  const threads = useStore(stream.store, (s) => s.threads);
  const { runs, approvals } = useMemo(() => selectActivity({ threads } as StreamState), [threads]);
  const titles = useQuery({ queryKey: ['threads', ''], queryFn: () => api.threads() });
  const titleOf = (id: string) => titles.data?.find((t) => t.threadId === id)?.title ?? 'Conversation';
  const running = runs.filter((r) => r.run.state === 'running').length;
  const count = running + approvals.length;

  // Open when a new approval arrives (spec 6.2).
  const seen = useRef(approvals.length);
  useEffect(() => {
    if (approvals.length > seen.current) setRail(true);
    seen.current = approvals.length;
  }, [approvals.length, setRail]);

  const desktop = bp === 'desktop' || bp === 'laptop';
  const go = (threadId: string, blockId?: string) => {
    navigate(blockId ? `/c/${threadId}/b/${blockId}` : `/c/${threadId}`);
    if (!desktop) setRail(false);
  };

  if (!railOpen) {
    return (
      <aside className={clsx(styles.strip, !desktop && styles.fab)} aria-label="Agent activity" data-region="rail" tabIndex={-1}>
        <span className={styles.badgeWrap}>
          <IconButton
            label={`Agent activity${count ? `: ${running} running, ${approvals.length} waiting for approval` : ''}`}
            icon={<Activity size={18} aria-hidden />}
            onClick={() => setRail(true)}
            aria-expanded={false}
          />
          {count > 0 && (
            <span className={clsx(styles.badge, approvals.length > 0 && styles.badgeAlert)} aria-hidden>
              {count}
            </span>
          )}
        </span>
      </aside>
    );
  }

  return (
    <aside className={clsx(styles.panel, !desktop && styles.drawer)} aria-label="Agent activity" data-region="rail" tabIndex={-1}>
      <header className={styles.header}>
        <h2 className={styles.title}>Agent activity</h2>
        <IconButton label="Collapse agent activity" icon={<PanelRightClose size={16} aria-hidden />} onClick={() => setRail(false)} aria-expanded />
      </header>
      <div className={styles.scroll}>
        {approvals.length > 0 && (
          <section aria-labelledby="rail-approvals">
            <h3 id="rail-approvals" className={styles.section}>
              Needs your approval
            </h3>
            <ul className={styles.list}>
              {approvals.map((a) => (
                <li key={a.blockId}>
                  <button type="button" className={clsx(styles.row, styles.approval)} onClick={() => go(a.threadId, a.blockId)}>
                    <ShieldAlert size={16} aria-hidden className={styles.approvalIcon} />
                    <span className={styles.rowText}>
                      <span className={styles.rowTitle}>{a.data.summary ?? 'Approval'}</span>
                      {a.data.riskTier && <RiskBadge tier={a.data.riskTier} />}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section aria-labelledby="rail-runs">
          <h3 id="rail-runs" className={styles.section}>
            Runs this session
          </h3>
          {runs.length === 0 ? (
            <p className={styles.empty}>When you ask DI something, each run appears here with its state, so you can leave and come back.</p>
          ) : (
            <ul className={styles.list}>
              {runs.map((r) => (
                <li key={r.run.runId}>
                  <button type="button" className={styles.row} onClick={() => go(r.threadId)}>
                    <RunIcon state={r.run.state} />
                    <span className={styles.rowText}>
                      <span className={styles.rowTitle}>{r.question ?? titleOf(r.threadId)}</span>
                      <span className={styles.rowMeta}>
                        {r.run.agents.at(-1)} · {stateLabel[r.run.state]}
                      </span>
                    </span>
                  </button>
                  {r.run.state === 'running' && (
                    <button
                      type="button"
                      className={styles.stop}
                      onClick={() => {
                        void api.cancelRun(r.run.runId);
                        announce('Stopping the run');
                      }}
                    >
                      Stop
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}

const stateLabel: Record<AgentTurn['state'], string> = { running: 'Running', completed: 'Done', failed: 'Failed', cancelled: 'Stopped' };

function RunIcon({ state }: { state: AgentTurn['state'] }) {
  if (state === 'running') return <Loader2 size={16} aria-hidden className={clsx(styles.runIcon, styles.spin)} />;
  if (state === 'completed') return <CircleCheck size={16} aria-hidden className={clsx(styles.runIcon, styles.ok)} />;
  if (state === 'failed') return <CircleX size={16} aria-hidden className={clsx(styles.runIcon, styles.bad)} />;
  return <CircleSlash size={16} aria-hidden className={styles.runIcon} />;
}
