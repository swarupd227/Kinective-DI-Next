import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Ban, Check, ChevronRight, Circle, CircleDashed, Hand, Loader2, Square, X } from 'lucide-react';
import type { PlanStep, PlanStepsBlock, StepState } from '@dinext/block-schemas';
import { Button, RiskBadge, useAnnouncer } from '@dinext/ui';
import { useBlockHost } from '../context.tsx';
import { formatDuration } from '../format.ts';
import styles from './PlanStepsView.module.css';

const stateIcon: Record<StepState, typeof Check> = {
  waiting: Circle,
  running: Loader2,
  done: Check,
  skipped: CircleDashed,
  failed: X,
  needs_input: Hand,
};

const stateLabel: Record<StepState, string> = {
  waiting: 'Waiting',
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
  needs_input: 'Needs your input',
};

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Announces step changes politely, at most once every 2 seconds (spec 10.8). */
function useStepAnnouncements(steps: PlanStep[]) {
  const { announce } = useAnnouncer();
  const prev = useRef(new Map<string, StepState>());
  const last = useRef(0);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const changed = steps.filter((s) => prev.current.has(s.id) && prev.current.get(s.id) !== s.state && s.state !== 'waiting');
    prev.current = new Map(steps.map((s) => [s.id, s.state]));
    const latest = changed[changed.length - 1];
    if (!latest) return;
    pending.current = `${latest.label}: ${stateLabel[latest.state]}${latest.resultSummary ? `. ${latest.resultSummary}` : ''}`;
    const wait = Math.max(0, 2000 - (Date.now() - last.current));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (pending.current) announce(pending.current);
      last.current = Date.now();
      pending.current = null;
    }, wait);
  }, [steps, announce]);

  useEffect(() => () => clearTimeout(timer.current), []);
}

export function PlanStepsView({ block }: { block: PlanStepsBlock }) {
  const host = useBlockHost();
  const { steps, cancellable, state, runId } = block.data;
  const running = state === 'running';
  const now = useNow(running);
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  useStepAnnouncements(steps);

  return (
    <div className={styles.plan}>
      <div className={styles.summary}>
        <div className={styles.progressTrack} aria-hidden>
          <span className={styles.progressFill} style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }} />
        </div>
        <span className={styles.count}>
          {state === 'cancelled' ? 'Cancelled · ' : state === 'failed' ? 'Stopped · ' : ''}
          {done} of {steps.length} steps
        </span>
        {cancellable && running && (
          <Button size="sm" variant="ghost" icon={<Square size={12} aria-hidden />} onClick={() => host.onCancelRun?.(runId)} aria-keyshortcuts="Escape">
            Stop
          </Button>
        )}
      </div>
      <ol className={styles.steps}>
        {steps.map((step, i) => (
          <StepRow key={step.id} step={step} now={now} last={i === steps.length - 1} canViewSql={host.canViewSql ?? false} runState={state} />
        ))}
      </ol>
    </div>
  );
}

function StepRow({ step, now, last, canViewSql, runState }: { step: PlanStep; now: number; last: boolean; canViewSql: boolean; runState: PlanStepsBlock['data']['state'] }) {
  const [open, setOpen] = useState(false);
  const state: StepState = runState === 'cancelled' && (step.state === 'waiting' || step.state === 'running') ? 'skipped' : step.state;
  const Icon = runState === 'cancelled' && state === 'skipped' && step.state !== 'skipped' ? Ban : stateIcon[state];
  const started = step.startedAt ? new Date(step.startedAt).getTime() : undefined;
  const ended = step.endedAt ? new Date(step.endedAt).getTime() : undefined;
  const elapsed = started ? (ended ?? (state === 'running' ? now : started)) - started : undefined;
  const ops = step.operations ?? [];
  const detailsId = `${step.id}-ops`;

  return (
    <li className={clsx(styles.step, styles[state])} aria-current={state === 'running' ? 'step' : undefined}>
      <span className={styles.rail} aria-hidden>
        <span className={styles.icon}>
          <Icon size={14} className={state === 'running' ? styles.spin : undefined} />
        </span>
        {!last && <span className={styles.line} />}
      </span>
      <div className={styles.content}>
        <div className={styles.head}>
          <span className={styles.label}>{step.label}</span>
          <span className="dn-visually-hidden">, {stateLabel[state]}</span>
          {step.riskTier && step.riskTier !== 'read' && <RiskBadge tier={step.riskTier} />}
        </div>
        <div className={styles.meta}>
          <span className={styles.agent}>{step.agent}</span>
          {elapsed !== undefined && <span className="dn-num">{formatDuration(elapsed)}</span>}
          {ops.length > 0 && (
            <button type="button" className={styles.disclose} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((o) => !o)}>
              <ChevronRight size={12} aria-hidden className={clsx(styles.chev, open && styles.chevOpen)} />
              {ops.length === 1 ? '1 operation' : `${ops.length} operations`}
            </button>
          )}
        </div>
        {step.resultSummary && <p className={styles.result}>{step.resultSummary}</p>}
        {open && (
          <ul id={detailsId} className={styles.ops}>
            {ops.map((op, i) => (
              <li key={i}>
                <code className={styles.opName}>{op.name}</code>
                {op.params && (
                  <span className={styles.params}>
                    {Object.entries(op.params)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(' · ')}
                  </span>
                )}
                {canViewSql && op.sql && <pre className={styles.sql}>{op.sql}</pre>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
