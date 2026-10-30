import { Component, useEffect, useId, useState, type ErrorInfo, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  BookOpenText,
  Database,
  Download,
  FileText,
  Grid3x3,
  Info,
  LayoutTemplate,
  MoreHorizontal,
  Pin,
  Sparkles,
  Table2,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import { Chip, IconButton, Menu } from '@dinext/ui';
import type { Block, BlockAction, Source } from '@dinext/block-schemas';
import { useBlockHost } from '../context.tsx';
import { formatAsOf } from '../format.ts';
import styles from './BlockFrame.module.css';

export type FrameStatus = 'loading' | 'streaming' | 'complete' | 'error';

const actionIcon: Partial<Record<BlockAction['kind'], ReactNode>> = {
  explain: <Sparkles size={16} aria-hidden />,
  pin: <Pin size={16} aria-hidden />,
  open_workspace: <Grid3x3 size={16} aria-hidden />,
  export: <Download size={16} aria-hidden />,
};

const sourceIcon: Record<Source['kind'], ReactNode> = {
  table: <Table2 size={12} aria-hidden />,
  view: <Table2 size={12} aria-hidden />,
  metric: <BookOpenText size={12} aria-hidden />,
  report: <FileText size={12} aria-hidden />,
  template: <LayoutTemplate size={12} aria-hidden />,
  model: <Sparkles size={12} aria-hidden />,
  file: <FileText size={12} aria-hidden />,
  workflow: <Workflow size={12} aria-hidden />,
};

/** Primary actions show as icon buttons; the rest go to the overflow menu. */
const PRIMARY: BlockAction['kind'][] = ['explain', 'pin', 'open_workspace'];

export interface BlockFrameProps {
  block: Block;
  status?: FrameStatus;
  /** Plain-language progress line shown after 3 s of loading (spec 10.5). */
  progressText?: string;
  /** Hide the header (e.g. kpi tiles inside a group carry their own label). */
  bare?: boolean;
  /** Extra controls for the header, e.g. the chart/table view toggle. */
  headerExtra?: ReactNode;
  tone?: 'default' | 'approval';
  children: ReactNode;
}

/**
 * Shared chrome for every block: title, actions, source chips and freshness (spec 6.12, 6.13, 9.2).
 * It owns the block's error boundary so one failing block never breaks the canvas (spec 11.8).
 */
export function BlockFrame({ block, status = 'complete', progressText, bare, headerExtra, tone = 'default', children }: BlockFrameProps) {
  const host = useBlockHost();
  const headingId = useId();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (status !== 'loading') return;
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [status]);

  const actions = block.actions ?? [];
  const primary = actions.filter((a) => PRIMARY.includes(a.kind));
  const overflow = actions.filter((a) => !PRIMARY.includes(a.kind));
  const title = block.title;
  const showHeader = !bare && (title || actions.length > 0 || headerExtra);

  return (
    <article
      className={clsx(styles.frame, tone === 'approval' && styles.approval)}
      aria-labelledby={title ? headingId : undefined}
      aria-label={title ? undefined : `${block.provenance.agent} result`}
      aria-busy={status === 'loading' || status === 'streaming' || undefined}
      data-block-type={block.type}
      data-block-id={block.id}
    >
      {showHeader && (
        <header className={styles.header}>
          <div className={styles.titles}>
            {title && (
              <h3 id={headingId} className={styles.title}>
                {title}
              </h3>
            )}
            {block.subtitle && <p className={styles.subtitle}>{block.subtitle}</p>}
          </div>
          <div className={styles.tools}>
            {headerExtra}
            {status === 'complete' &&
              primary.map((a) => (
                <IconButton
                  key={a.id}
                  size="sm"
                  label={a.label}
                  icon={actionIcon[a.kind] ?? <Info size={16} aria-hidden />}
                  onClick={() => host.onAction?.(block, a)}
                />
              ))}
            {status === 'complete' && overflow.length > 0 && (
              <Menu
                trigger={<IconButton size="sm" label="More actions" icon={<MoreHorizontal size={16} aria-hidden />} />}
                items={overflow.map((a) => ({
                  id: a.id,
                  label: a.label,
                  icon: actionIcon[a.kind],
                  onSelect: () => host.onAction?.(block, a),
                }))}
              />
            )}
          </div>
        </header>
      )}

      {block.freshness.stale && (
        <p className={styles.stale} role="note">
          <TriangleAlert size={14} aria-hidden />
          Showing data from the {formatAsOf(block.freshness.asOf).replace('Data as of nightly build ', '')} build. Last night's build has not completed.
        </p>
      )}

      <div className={styles.body}>
        <BlockErrorBoundary block={block}>{children}</BlockErrorBoundary>
      </div>

      {status === 'loading' && slow && progressText && (
        <p className={styles.progress} role="status">
          Still working: {progressText}
        </p>
      )}
      {status === 'streaming' && (
        <p className={styles.writing} aria-hidden>
          <span className={styles.dot} />
          Writing…
        </p>
      )}

      <Footer block={block} status={status} />
    </article>
  );
}

function Footer({ block, status }: { block: Block; status: FrameStatus }) {
  const host = useBlockHost();
  const { sources } = block.provenance;
  const showFreshness = block.freshness.kind === 'nightly_build' && block.type !== 'notice';
  if (status === 'loading' || (!sources.length && !showFreshness)) return null;
  return (
    <footer className={styles.footer}>
      {sources.length > 0 && (
        <ul className={styles.sources} aria-label="Sources">
          {sources.map((s) => (
            <li key={`${s.kind}:${s.ref ?? s.label}`}>
              <Chip
                icon={sourceIcon[s.kind]}
                locked={s.accessible === false}
                onClick={host.onSourceOpen ? () => host.onSourceOpen?.(block, s) : undefined}
                title={s.accessible === false ? 'You do not have access to this source' : `Open ${s.label}`}
              >
                {s.label}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {showFreshness && (
        <span className={styles.freshness} data-build-id={block.freshness.buildId}>
          <Database size={12} aria-hidden />
          {formatAsOf(block.freshness.asOf)}
        </span>
      )}
      {block.dqStatus && block.dqStatus !== 'ok' && block.dqStatus !== 'unknown' && (
        <span className={styles.dq}>
          <TriangleAlert size={12} aria-hidden />
          Data quality {block.dqStatus === 'failed' ? 'check failed' : 'warning'}
        </span>
      )}
    </footer>
  );
}

interface BoundaryProps {
  block: Block;
  children: ReactNode;
}

class BlockErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Telemetry hook lands with the telemetry package; never include block data (FE-ARCH-080).
    console.error(`[block ${this.props.block.type}] render failed`, error.message, info.componentStack?.split('\n')[1]);
  }

  override render() {
    if (this.state.failed) {
      return (
        <p className={styles.renderError} role="alert">
          <TriangleAlert size={16} aria-hidden />
          This {this.props.block.type.replace('_', ' ')} could not be displayed. Reference {this.props.block.id}.
        </p>
      );
    }
    return this.props.children;
  }
}
