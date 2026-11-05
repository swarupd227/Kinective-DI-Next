// The pane beside the conversation (spec 6.2): a task's progress and outputs, or a classic view,
// resizable from 30% to 70%. On tablets and phones it is a sheet.
import { lazy, Suspense, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { Link, useMatch } from 'react-router';
import clsx from 'clsx';
import { ArrowLeft, ExternalLink, Maximize2, MessageSquarePlus, Minimize2, X } from 'lucide-react';
import { IconButton, Skeleton } from '@dinext/ui';
import { useSession } from '../session/SessionProvider.tsx';
import type { ContextRef } from '@dinext/block-schemas';
import { useUi, viewKey, type WorkspaceView } from './uiStore.ts';
import { TableWorkspace } from '../workspace/TableWorkspace.tsx';
import { PagePane } from './PagePane.tsx';
import styles from './WorkspacePane.module.css';

const MemberRecord = lazy(() => import('../workspace/MemberRecord.tsx').then((m) => ({ default: m.MemberRecord })));

const BlockGrid = lazy(() => import('../workspace/BlockGrid.tsx'));
const TaskPanel = lazy(() => import('../workspace/TaskPanel.tsx').then((m) => ({ default: m.TaskPanel })));
const TaskOutput = lazy(() => import('../workspace/TaskPanel.tsx').then((m) => ({ default: m.TaskOutput })));

export type PaneMode = 'side' | 'sheet' | 'max';

export function WorkspacePane({ mode }: { mode: PaneMode }) {
  const { workspace, workspaceTrail, workspaceBack, workspaceWidth, setWorkspaceWidth, workspaceMaximized, toggleWorkspaceMax, closeWorkspace, openWorkspace, addContext } = useUi();
  const paneRef = useRef<HTMLElement>(null);
  const routeThread = useMatch('/c/:threadId/*')?.params.threadId;
  const threadId = routeThread && routeThread !== 'new' ? routeThread : undefined;
  if (!workspace) return null;
  const previous = workspaceTrail.length > 1 ? workspaceTrail[workspaceTrail.length - 2] : null;
  const chip = contextFor(workspace);

  // "Ask about this" names what is open (its record or block, never its data) on the next message.
  const askAbout = () => {
    if (!chip || !threadId) return;
    addContext(threadId, chip);
    // The conversation has to be in view for the question (and any approval it raises): a widened
    // pane gives way, and a phone's sheet steps aside.
    if (mode === 'max') toggleWorkspaceMax();
    else if (mode === 'sheet') closeWorkspace();
    document.querySelector<HTMLTextAreaElement>('[data-region="bar"] textarea, textarea')?.focus();
  };

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
        {previous ? (
          <IconButton label={`Back to ${previous.label}`} icon={<ArrowLeft size={18} aria-hidden />} onClick={() => workspaceBack()} />
        ) : workspace.kind === 'output' ? (
          <IconButton label="Back to progress" icon={<ArrowLeft size={18} aria-hidden />} onClick={() => openWorkspace({ kind: 'task', threadId: workspace.threadId, label: 'This task' })} />
        ) : (
          mode === 'sheet' && <IconButton label="Back to conversation" icon={<ArrowLeft size={18} aria-hidden />} onClick={closeWorkspace} />
        )}
        <div className={styles.titles}>
          <h2 className={styles.title}>{workspace.label}</h2>
        </div>
        {chip && threadId && (
          <button type="button" className={styles.ask} onClick={askAbout} title="Ask DI about what is open here">
            <MessageSquarePlus size={14} aria-hidden />
            <span className={styles.askText}>Ask about this</span>
          </button>
        )}
        {workspace.kind === 'member' && <FullRecordLink token={workspace.ref} />}
        {workspace.kind === 'page' && (
          <Link to={workspace.path} className={styles.fullLink} aria-label={`Open ${workspace.label} as a page`} title="Open as a page">
            <ExternalLink size={14} aria-hidden />
          </Link>
        )}
        {mode !== 'sheet' && (
          <IconButton
            label={workspaceMaximized ? 'Restore workspace' : 'Maximise workspace'}
            icon={workspaceMaximized ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
            onClick={toggleWorkspaceMax}
          />
        )}
        <IconButton label="Close workspace" icon={<X size={16} aria-hidden />} onClick={closeWorkspace} />
      </header>
      {workspaceTrail.length > 1 && (
        <nav className={styles.crumbs} aria-label="Opened in this pane">
          <ol>
            {workspaceTrail.slice(-4).map((v, j, shown) => { const i = workspaceTrail.length - shown.length + j; return (
              <li key={`${viewKey(v)}-${i}`}>
                {i < workspaceTrail.length - 1 ? (
                  <button type="button" onClick={() => workspaceBack(i)}>
                    {v.label}
                  </button>
                ) : (
                  <span aria-current="page">{v.label}</span>
                )}
              </li>
            ); })}
          </ol>
        </nav>
      )}
      <div className={clsx(styles.body, workspace.kind === 'page' && styles.pageBody)}>
        <WorkspaceContent view={workspace} />
      </div>
    </aside>
  );
}

function contextFor(v: WorkspaceView): ContextRef | null {
  switch (v.kind) {
    case 'member':
      return { type: 'member', ref: v.ref, label: v.label };
    case 'table':
      return { type: 'table', ref: v.tableId, label: v.label };
    case 'block':
      return { type: 'table', ref: `block:${v.block.id}`, label: v.label };
    case 'output':
      return { type: 'block', ref: v.blockId, label: v.label };
    default:
      return null;
  }
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
  if (view.kind === 'page') return <PagePane path={view.path} label={view.label} threadId={threadId && threadId !== 'new' ? threadId : undefined} />;
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
