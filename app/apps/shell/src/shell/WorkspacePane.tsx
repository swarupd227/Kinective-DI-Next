// The pane beside the conversation (spec 6.2): a task's progress and outputs, or a classic view,
// resizable from 30% to 70%. On tablets and phones it is a sheet.
import { lazy, Suspense, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { Link, useMatch } from 'react-router';
import clsx from 'clsx';
import { ArrowLeft, ExternalLink, Maximize2, Minimize2, X } from 'lucide-react';
import { IconButton, Skeleton } from '@dinext/ui';
import { useSession } from '../session/SessionProvider.tsx';
import { useUi, type WorkspaceView } from './uiStore.ts';
import { TableWorkspace } from '../workspace/TableWorkspace.tsx';
import styles from './WorkspacePane.module.css';

const MemberRecord = lazy(() => import('../workspace/MemberRecord.tsx').then((m) => ({ default: m.MemberRecord })));

const BlockGrid = lazy(() => import('../workspace/BlockGrid.tsx'));
const TaskPanel = lazy(() => import('../workspace/TaskPanel.tsx').then((m) => ({ default: m.TaskPanel })));
const TaskOutput = lazy(() => import('../workspace/TaskPanel.tsx').then((m) => ({ default: m.TaskOutput })));

export type PaneMode = 'side' | 'sheet' | 'max';

export function WorkspacePane({ mode }: { mode: PaneMode }) {
  const { workspace, workspaceWidth, setWorkspaceWidth, workspaceMaximized, toggleWorkspaceMax, closeWorkspace, openWorkspace } = useUi();
  const paneRef = useRef<HTMLElement>(null);
  if (!workspace) return null;

  // Dragging the edge resizes; the separator is also operable with arrow keys (spec 10.7, 2.5.7).
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const body = paneRef.current?.parentElement;
    if (!body) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = body.getBoundingClientRect();
    const move = (ev: globalThis.PointerEvent) => setWorkspaceWidth(((rect.right - ev.clientX) / rect.width) * 100);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onSepKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') setWorkspaceWidth(workspaceWidth + step);
    else if (e.key === 'ArrowRight') setWorkspaceWidth(workspaceWidth - step);
    else if (e.key === 'Home') setWorkspaceWidth(70);
    else if (e.key === 'End') setWorkspaceWidth(30);
    else return;
    e.preventDefault();
  };

  return (
    <aside ref={paneRef} className={clsx(styles.pane, styles[mode])} aria-label={`Workspace: ${workspace.label}`} data-region="workspace" tabIndex={-1}>
      {/* An ARIA window splitter is focusable and keyboard operable. */}
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      {mode === 'side' && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize workspace"
          aria-valuemin={30}
          aria-valuemax={70}
          aria-valuenow={workspaceWidth}
          tabIndex={0}
          className={styles.separator}
          onPointerDown={onPointerDown}
          onKeyDown={onSepKey}
        />
      )}
      {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <header className={styles.header}>
        {workspace.kind === 'output' ? (
          <IconButton label="Back to progress" icon={<ArrowLeft size={18} aria-hidden />} onClick={() => openWorkspace({ kind: 'task', threadId: workspace.threadId, label: 'This task' })} />
        ) : (
          mode === 'sheet' && <IconButton label="Back to conversation" icon={<ArrowLeft size={18} aria-hidden />} onClick={closeWorkspace} />
        )}
        <div className={styles.titles}>
          <h2 className={styles.title}>{workspace.label}</h2>
        </div>
        {workspace.kind === 'member' && <FullRecordLink token={workspace.ref} />}
        {mode !== 'sheet' && (
          <IconButton
            label={workspaceMaximized ? 'Restore workspace' : 'Maximise workspace'}
            icon={workspaceMaximized ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
            onClick={toggleWorkspaceMax}
          />
        )}
        <IconButton label="Close workspace" icon={<X size={16} aria-hidden />} onClick={closeWorkspace} />
      </header>
      <div className={styles.body}>
        <WorkspaceContent view={workspace} />
      </div>
    </aside>
  );
}

function FullRecordLink({ token }: { token: string }) {
  const { terms } = useSession();
  return (
    <Link to={`/${terms.personRoute}/${token}`} className={styles.fullLink} aria-label={`Open the full ${terms.person} page`}>
      <ExternalLink size={14} aria-hidden />
    </Link>
  );
}

function WorkspaceContent({ view }: { view: WorkspaceView }) {
  // Actions in the pane (Refer, Why?) continue the conversation beside it.
  const threadId = useMatch('/c/:threadId/*')?.params.threadId;
  if (view.kind === 'table') return <TableWorkspace key={view.tableId} tableId={view.tableId} />;
  if (view.kind === 'task' || view.kind === 'output') {
    return <Suspense fallback={<Skeleton height="240px" radius="md" />}>{view.kind === 'task' ? <TaskPanel threadId={view.threadId} /> : <TaskOutput threadId={view.threadId} blockId={view.blockId} />}</Suspense>;
  }
  if (view.kind === 'member') {
    return (
      <Suspense fallback={<Skeleton height="240px" radius="md" />}>
        <MemberRecord key={view.ref} token={view.ref} threadId={threadId && threadId !== 'new' ? threadId : undefined} />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<Skeleton height="240px" radius="md" />}>
      <BlockGrid block={view.block} />
    </Suspense>
  );
}
