// Whitelisted block renderer (spec 9.1). Validates complete blocks before render and replaces any
// failure with an error notice; unknown types never render their content.
import { lazy, Suspense, useMemo, useState } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { SegmentedControl, Skeleton } from '@dinext/ui';
import { validateBlock, type Block, type ChartBlock, type NoticeBlock, type StreamingEnvelope, type TableBlock } from '@dinext/block-schemas';
import { BlockFrame, type FrameStatus } from './frame/BlockFrame.tsx';
import { KpiGroupView, KpiView } from './kpi/KpiGroupView.tsx';
import { NoticeView } from './notice/NoticeView.tsx';
import { PlanStepsView } from './plan/PlanStepsView.tsx';
import { ApprovalCardView } from './approval/ApprovalCardView.tsx';
import { ListView } from './list/ListView.tsx';
import { DefinitionCardView } from './definition/DefinitionCardView.tsx';
import { useBlockHost } from './context.tsx';
import styles from './BlockRenderer.module.css';

const ChartView = lazy(() => import('./chart/ChartView.tsx'));
// Markdown (react-markdown, remark-gfm) stays out of the first load; Home rarely shows text blocks.
const TextBlockView = lazy(() => import('./text/TextBlockView.tsx').then((m) => ({ default: m.TextBlockView })));
const TableView = lazy(() => import('./table/TableView.tsx'));
// Member records appear only for staff with Relationship Manager, so they stay out of the first load.
const MemberCardView = lazy(() => import('./member/MemberCardView.tsx').then((m) => ({ default: m.MemberCardView })));
const Member360View = lazy(() => import('./member/Member360View.tsx').then((m) => ({ default: m.Member360View })));
const ReportCanvasView = lazy(() => import('./report/ReportCanvasView.tsx').then((m) => ({ default: m.ReportCanvasView })));

export interface BlockRendererProps {
  /** A complete block, or a streaming envelope whose data is still being patched. */
  block: Block | StreamingEnvelope;
  status?: FrameStatus;
  progressText?: string;
}

export function BlockRenderer({ block, status = 'complete', progressText }: BlockRendererProps) {
  const validation = useMemo(() => (status === 'complete' ? validateBlock(block) : null), [block, status]);

  if (validation && !validation.ok) {
    const notice = invalidNotice(block, validation.reason);
    return (
      <BlockFrame block={notice}>
        <NoticeView block={notice} />
      </BlockFrame>
    );
  }

  const b = (validation?.ok ? validation.block : block) as Block;
  const complete = status === 'complete';
  const loading = status === 'loading';

  switch (b.type) {
    case 'text':
      return (
        <BlockFrame block={b} status={status} progressText={progressText} tone="prose">
          <Suspense fallback={<TextSkeleton />}>
            <TextBlockView block={{ ...b, data: { ...b.data, markdown: b.data?.markdown ?? '' } }} status={loading ? 'loading' : complete ? 'complete' : 'streaming'} />
          </Suspense>
        </BlockFrame>
      );
    case 'kpi':
      return (
        <BlockFrame block={b} status={status} progressText={progressText} bare={!b.title}>
          <KpiView block={b} loading={!complete} />
        </BlockFrame>
      );
    case 'kpi_group':
      return (
        <BlockFrame block={b} status={status} progressText={progressText}>
          <KpiGroupView block={complete ? b : { ...b, data: { layout: 'row', items: [] as never } }} loading={!complete} />
        </BlockFrame>
      );
    case 'chart':
      return <ChartBlockView block={b} status={status} progressText={progressText} />;
    case 'table':
      return <TableBlockView block={b} status={status} progressText={progressText} />;
    case 'notice':
      return (
        <BlockFrame block={b} status={status}>
          {complete ? <NoticeView block={b} /> : <Skeleton height="56px" radius="md" />}
        </BlockFrame>
      );
    case 'plan_steps':
      return (
        <BlockFrame block={b} status={status === 'loading' ? 'loading' : 'complete'} progressText={progressText}>
          <PlanStepsView block={{ ...b, data: { runId: '', cancellable: false, state: 'running', steps: [], ...(b.data as Partial<typeof b.data>) } }} />
        </BlockFrame>
      );
    case 'definition_card':
      return (
        <BlockFrame block={b} status={status} progressText={progressText}>
          {complete ? <DefinitionCardView block={b} /> : <TextSkeleton />}
        </BlockFrame>
      );
    case 'list':
      return (
        <BlockFrame block={b} status={status} progressText={progressText}>
          {complete ? <ListView block={b} /> : <TableSkeleton />}
        </BlockFrame>
      );
    case 'approval_card':
      return (
        <BlockFrame block={b} status={status} tone="approval" bare>
          {complete ? <ApprovalCardView block={b} /> : <ApprovalSkeleton />}
        </BlockFrame>
      );
    // The card draws its own buttons, so the frame shows no header actions.
    case 'member_card':
      return (
        <BlockFrame block={b} status={status} bare>
          {complete ? (
            <Suspense fallback={<MemberSkeleton />}>
              <MemberCardView block={b} />
            </Suspense>
          ) : (
            <MemberSkeleton />
          )}
        </BlockFrame>
      );
    // The canvas frames its own widgets; each widget is a full block with its own frame and sources.
    case 'report_canvas':
      return (
        <BlockFrame block={b} status={status} bare>
          {complete ? (
            <Suspense fallback={<MemberSkeleton />}>
              <ReportCanvasView block={b} />
            </Suspense>
          ) : (
            <MemberSkeleton />
          )}
        </BlockFrame>
      );
    case 'member_360':
      return (
        <BlockFrame block={b} status={status} bare>
          {complete ? (
            <Suspense fallback={<MemberSkeleton />}>
              <Member360View block={b} />
            </Suspense>
          ) : (
            <MemberSkeleton />
          )}
        </BlockFrame>
      );
  }
}

function MemberSkeleton() {
  return (
    <div className={styles.approvalSkeleton} aria-hidden>
      <Skeleton height="40px" width="40%" radius="md" />
      <Skeleton height="56px" radius="md" />
    </div>
  );
}

function ChartBlockView({ block, status, progressText }: { block: ChartBlock; status: FrameStatus; progressText?: string }) {
  const host = useBlockHost();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const complete = status === 'complete';
  const empty = complete && block.data.dataset.source.length === 0;
  const drill = block.actions?.find((a) => a.kind === 'drill');
  const toggle = complete && !empty && (
    <SegmentedControl
      label="Display as"
      iconOnly
      value={view}
      onChange={setView}
      options={[
        { value: 'chart', label: 'Chart view', icon: <BarChart3 size={14} aria-hidden /> },
        { value: 'table', label: 'Table view', icon: <Table2 size={14} aria-hidden /> },
      ]}
    />
  );
  return (
    <BlockFrame block={block} status={status} progressText={progressText} headerExtra={toggle}>
      {empty ? (
        <NoticeView block={noData(block)} />
      ) : (
        <Suspense fallback={<Skeleton height="280px" radius="md" />}>
          <ChartView
            block={block}
            complete={complete}
            view={view}
            onDrill={drill ? (category) => host.onAction?.(block, { ...drill, params: { ...drill.params, category } }) : undefined}
          />
        </Suspense>
      )}
    </BlockFrame>
  );
}

function TableBlockView({ block, status, progressText }: { block: TableBlock; status: FrameStatus; progressText?: string }) {
  const complete = status === 'complete';
  const empty = complete && (block.data.rows?.length ?? 0) === 0 && !block.dataRef;
  return (
    <BlockFrame block={block} status={status} progressText={progressText}>
      {!complete ? (
        <TableSkeleton />
      ) : empty ? (
        <NoticeView block={noData(block)} />
      ) : (
        <Suspense fallback={<TableSkeleton />}>
          <TableView block={block} />
        </Suspense>
      )}
    </BlockFrame>
  );
}

function TextSkeleton() {
  return (
    <div className={styles.tableSkeleton} aria-hidden>
      <Skeleton width="90%" />
      <Skeleton width="70%" />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className={styles.tableSkeleton} aria-hidden>
      <Skeleton height="32px" />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height="20px" width={`${96 - i * 6}%`} />
      ))}
    </div>
  );
}

function ApprovalSkeleton() {
  return (
    <div className={styles.approvalSkeleton} aria-hidden>
      <Skeleton height="14px" width="30%" />
      <Skeleton height="22px" width="70%" />
      <Skeleton height="96px" radius="md" />
      <Skeleton height="36px" width="50%" />
    </div>
  );
}

const noData = (block: Block): NoticeBlock => ({
  id: block.id,
  type: 'notice',
  version: '1.0.0',
  provenance: block.provenance,
  freshness: block.freshness,
  data: {
    kind: 'no_data',
    message: 'No rows matched.',
    detail: block.provenance.filters?.length ? `Filters: ${block.provenance.filters.join(' · ')}. Try widening them.` : 'Try widening the period or removing a filter.',
  },
});

function invalidNotice(block: Block | StreamingEnvelope, reason: string): NoticeBlock {
  const raw = block as Partial<StreamingEnvelope>;
  const message =
    reason === 'unsupported_version'
      ? 'This result needs a newer version of DI Next. Reload to update.'
      : reason === 'not_implemented' || reason === 'unknown_type'
        ? 'This kind of result cannot be shown here yet.'
        : 'This result could not be displayed because it failed validation.';
  return {
    id: typeof raw.id === 'string' && /^blk_[A-Za-z0-9]{12,32}$/.test(raw.id) ? raw.id : 'blk_invalid000000000',
    type: 'notice',
    version: '1.0.0',
    provenance: { agent: raw.provenance?.agent ?? 'DI Concierge', sources: [] },
    freshness: { kind: 'none' },
    data: { kind: reason === 'invalid' ? 'error' : 'not_supported', message, referenceId: typeof raw.id === 'string' ? raw.id.slice(0, 40) : undefined },
  };
}
