// The sidebar (spec 6.2, FE-EXP-003): new task, search, the user's tasks with their live state, and
// only the apps the user's class permits and the tenant has licensed. Collapses to icons with
// tooltips; on tablets and phones it is a menu drawer.
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink } from 'react-router';
import { useStore } from 'zustand';
import clsx from 'clsx';
import { ChevronRight, CircleCheck, Hand, Loader2, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, Search } from 'lucide-react';
import { IconButton, Tooltip } from '@dinext/ui';
import type { AppId, ThreadSummary } from '@dinext/block-schemas';
import type { ThreadState } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { APP_META } from './apps.tsx';
import { NotificationsButton } from './NotificationsPanel.tsx';
import { UserMenu } from './TopBar.tsx';
import { useUi } from './uiStore.ts';
import { useBreakpoint } from './useBreakpoint.ts';
import styles from './NavRail.module.css';

/** Apps people reach for daily stay in view; the rest sit under More. */
const PRIMARY = new Set(['home', 'referrals', 'reports', 'tables', 'rm']);
const RECENT_TASKS = 12;

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
  if (drawer && !mobileNavOpen) return null;

  // Banks never see credit-union-only modules, even if a licence record lists them (FE-EXP-003).
  const bank = session.tenant.institutionType === 'bank';
  const apps = session.apps.filter((a): a is AppId => a in APP_META && a !== 'conversations' && !(bank && (a === 'seg' || a === 'callreport')));
  const primary = apps.filter((a) => PRIMARY.has(a));
  const rest = apps.filter((a) => !PRIMARY.has(a));

  const item = (a: AppId) => {
    const meta = APP_META[a]!;
    const link = (
      // A plain className: Tooltip's Slot would stringify NavLink's function form. NavLink sets
      // aria-current="page" on the active app, which the CSS styles.
      <NavLink to={meta.path} className={styles.item} aria-label={expanded ? undefined : meta.label} end={a === 'home'}>
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
            <span className={styles.mark} aria-hidden>
              DI
            </span>
            {expanded && (
              <span className={styles.brandText}>
                <span className={styles.product}>Data Intelligence</span>
                <span className={styles.tenant}>{session.tenant.name}</span>
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
          <button type="button" className={styles.search} onClick={() => setPalette(true)} aria-label="Search" aria-keyshortcuts="Control+K Meta+K">
            <Search size={15} aria-hidden />
            {expanded && (
              <>
                <span>Search</span>
                <kbd className={styles.kbd}>Ctrl K</kbd>
              </>
            )}
          </button>
        </div>

        <ul className={styles.list}>{primary.map(item)}</ul>

        {rest.length > 0 && expanded && (
          <details className={styles.more}>
            <summary className={styles.moreToggle}>
              <span className={styles.icon}>
                <MoreHorizontal size={18} aria-hidden />
              </span>
              <span className={styles.label}>More</span>
              <ChevronRight size={14} aria-hidden className={styles.chev} />
            </summary>
            <ul className={styles.list}>{rest.map(item)}</ul>
          </details>
        )}

        {expanded && (
          <section className={styles.tasks} aria-label="Your tasks">
            <h2 className={styles.tasksTitle}>Tasks</h2>
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

        <div className={styles.foot}>
          {expanded && <UserMenu />}
          <NotificationsButton />
        </div>
      </nav>
    </>
  );
}
