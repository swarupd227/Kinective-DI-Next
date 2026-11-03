// The sidebar (spec 6.2, FE-EXP-003): new task, search, the user's tasks with their live state, and
// only the apps the user's class permits and the tenant has licensed. Collapses to icons with
// tooltips; on tablets and phones it is a menu drawer.
import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, useMatch } from 'react-router';
import { useStore } from 'zustand';
import clsx from 'clsx';
import { CircleCheck, Hand, Loader2, PanelLeftClose, PanelLeftOpen, Plus, Search } from 'lucide-react';
import { IconButton, Tooltip } from '@dinext/ui';
import type { AppId, ThreadSummary } from '@dinext/block-schemas';
import type { ThreadState } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { APP_META } from './apps.tsx';
import { NotificationsButton } from './NotificationsPanel.tsx';
import { UserMenu } from './TopBar.tsx';
import { opensBeside } from './paneViews.ts';
import { useUi } from './uiStore.ts';
import { useBreakpoint } from './useBreakpoint.ts';
import styles from './NavRail.module.css';

/** Apps sit in the groups bank staff know from DI: the workspace, the modules, then administration. */
const GROUPS: { id: 'core' | 'modules' | 'admin'; label?: string }[] = [{ id: 'core' }, { id: 'modules', label: 'Modules' }, { id: 'admin', label: 'Administration' }];
const RECENT_TASKS = 5;

/** The Kinective mark: three rising bars and a dot, the shape the DI booklet uses. */
function Mark() {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden className={styles.markSvg}>
      <rect x="5" y="11" width="5" height="16" rx="2.5" fill="#1d5f9e" />
      <rect x="12.5" y="5" width="5" height="22" rx="2.5" fill="#1c8ea2" />
      <rect x="20" y="9" width="5" height="18" rx="2.5" fill="#4fb3c4" />
      <circle cx="25.5" cy="23.5" r="4" fill="#66b24a" />
    </svg>
  );
}

type TaskState = 'needs_you' | 'running' | 'done' | 'idle';

function taskState(t: ThreadState | undefined): TaskState {
  if (!t) return 'idle';
  if (t.pendingApprovals.length) return 'needs_you';
  const last = t.turns.findLast((x) => x.kind === 'agent');
  if (last?.kind === 'agent' && last.state === 'running') return 'running';
  return last ? 'done' : 'idle';
}

const stateLabel: Record<TaskState, string> = { needs_you: 'needs you', running: 'working', done: 'done', idle: '' };

function TaskRow({ thread, live }: { thread: ThreadSummary; live: ThreadState | undefined }) {
  const state = taskState(live);
  return (
    <li>
      <NavLink to={`/c/${thread.threadId}`} className={styles.task}>
        <span className={clsx(styles.taskIcon, styles[state])} aria-hidden>
          {state === 'needs_you' ? <Hand size={14} /> : state === 'running' ? <Loader2 size={14} className={styles.spin} /> : state === 'done' ? <CircleCheck size={14} /> : <span className={styles.dot} />}
        </span>
        <span className={styles.taskTitle}>{thread.title}</span>
        {stateLabel[state] && <span className="dn-visually-hidden">, {stateLabel[state]}</span>}
      </NavLink>
    </li>
  );
}

export function NavRail() {
  const { session, api, stream } = useSession();
  const bp = useBreakpoint();
  const { navCollapsed, toggleNav, mobileNavOpen, setMobileNav, setPalette } = useUi();
  const drawer = bp === 'phone' || bp === 'tablet';
  const expanded = drawer || !navCollapsed;
  const threads = useQuery({ queryKey: ['threads', ''], queryFn: () => api.threads(), enabled: expanded, refetchInterval: 10_000 });
  const live = useStore(stream.store, (s) => s.threads);
  const newTask = Boolean(useMatch('/c/new'));
  const inTask = Boolean(useMatch('/c/:threadId/*')) && !newTask;
  if (drawer && !mobileNavOpen) return null;

  // Banks never see credit-union-only modules, even if a licence record lists them (FE-EXP-003).
  const bank = session.tenant.institutionType === 'bank';
  const apps = session.apps.filter((a): a is AppId => a in APP_META && a !== 'conversations' && !(bank && (a === 'seg' || a === 'callreport')));
  const grouped = GROUPS.map((g) => ({ ...g, apps: apps.filter((a) => APP_META[a]!.group === g.id) })).filter((g) => g.apps.length);

  const item = (a: AppId) => {
    const meta = APP_META[a]!;
    const link = (
      // A plain className: Tooltip's Slot would stringify NavLink's function form. NavLink sets
      // aria-current="page" on the active app, which the CSS styles.
      <NavLink
        to={meta.path}
        className={styles.item}
        aria-label={expanded ? undefined : meta.label}
        // A parent path (Workflows above Referrals and the Builder) is current only on its own page.
        end={a === 'home' || apps.some((o) => o !== a && APP_META[o]!.path.startsWith(`${meta.path}/`))}
        onClick={(e) => {
          // During a task an app opens beside it. Ctrl or Cmd-click still opens it on its own.
          if (!inTask || !opensBeside(meta.path) || e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.preventDefault();
          setMobileNav(false);
          useUi.getState().openWorkspace({ kind: 'page', path: meta.path, label: meta.label });
        }}
      >
        <span className={styles.icon}>{meta.icon}</span>
        {expanded && <span className={styles.label}>{meta.label}</span>}
      </NavLink>
    );
    return (
      <li key={a}>
        {expanded ? (
          link
        ) : (
          <Tooltip content={meta.label} side="right">
            {link}
          </Tooltip>
        )}
      </li>
    );
  };

  const tasks = (threads.data ?? []).filter((t) => !t.archived).slice(0, RECENT_TASKS);

  return (
    <>
      {drawer && <button type="button" className={styles.scrim} aria-label="Close menu" onClick={() => setMobileNav(false)} />}
      <nav className={clsx(styles.rail, expanded && styles.expanded, drawer && styles.drawer)} aria-label="Apps" data-region="nav" tabIndex={-1}>
        <div className={styles.head}>
          <Link to="/home" className={styles.brand} aria-label={`Kinective Data Intelligence, ${session.tenant.name}, Home`}>
            <Mark />
            {expanded && (
              <span className={styles.brandText}>
                <span className={styles.company}>Kinective</span>
                <span className={styles.product}>Data Intelligence</span>
              </span>
            )}
          </Link>
          {!drawer && expanded && <IconButton label="Collapse sidebar" icon={<PanelLeftClose size={16} aria-hidden />} onClick={toggleNav} />}
        </div>

        {!expanded && <IconButton label="Expand sidebar" icon={<PanelLeftOpen size={16} aria-hidden />} onClick={toggleNav} />}

        <div className={styles.actions}>
          <Link to="/c/new" className={styles.newTask} aria-label="New task">
            <Plus size={16} aria-hidden />
            {expanded && <span>New task</span>}
          </Link>
          {/* On desktop, search lives in the header. */}
          {drawer && (
            <button type="button" className={styles.search} onClick={() => setPalette(true)} aria-label="Search" aria-keyshortcuts="Control+K Meta+K">
              <Search size={15} aria-hidden />
              <span>Search</span>
              <kbd className={styles.kbd}>Ctrl K</kbd>
            </button>
          )}
        </div>

        <div className={styles.scroll}>
          {grouped.map((g, gi) => (
            <Fragment key={g.id}>
              <section className={styles.group} aria-label={g.label ?? 'Workspace'}>
                {g.label && expanded && <h2 className={styles.groupTitle}>{g.label}</h2>}
                <ul className={styles.list}>{g.apps.map(item)}</ul>
              </section>
              {/* Recent tasks sit right under the workspace, so work in progress stays in view. */}
              {gi === 0 && expanded && (
                <section className={styles.tasks} aria-label="Your tasks">
                  <h2 className={styles.groupTitle}>Recent tasks</h2>
                  {tasks.length === 0 ? (
                    <p className={styles.tasksEmpty}>Tasks you start appear here, so you can leave and come back.</p>
                  ) : (
                    <ul className={styles.taskList}>
                      {tasks.map((t) => (
                        <TaskRow key={t.threadId} thread={t} live={live[t.threadId]} />
                      ))}
                    </ul>
                  )}
                  <Link to="/c" className={styles.allTasks}>
                    All tasks
                  </Link>
                </section>
              )}
            </Fragment>
          ))}
        </div>

        {/* On desktop, notifications and the account menu live in the header. */}
        {drawer ? (
          <div className={styles.foot}>
            <UserMenu />
            <NotificationsButton />
          </div>
        ) : (
          expanded && <p className={styles.tenantFoot}>{session.tenant.name}</p>
        )}
      </nav>
    </>
  );
}
