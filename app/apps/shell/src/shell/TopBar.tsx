// Top bar (spec 6.2): menu, product, breadcrumb or thread title, history, search, notifications,
// help and the user menu.
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import { Check, ChevronDown, CircleHelp, History, Menu as MenuIcon, Monitor, Moon, Rows3, Rows4, Search, Sun, UserRoundCog } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { IconButton, SegmentedControl, usePreferences, type Density, type ThemePreference } from '@dinext/ui';
import { useSession } from '../session/SessionProvider.tsx';
import { NotificationsButton } from './NotificationsPanel.tsx';
import { APP_META } from './apps.tsx';
import { useUi } from './uiStore.ts';
import { useBreakpoint } from './useBreakpoint.ts';
import styles from './TopBar.module.css';

export function TopBar({ threadId }: { threadId?: string }) {
  const { session, api } = useSession();
  const bp = useBreakpoint();
  const { toggleNav, setMobileNav, mobileNavOpen, setPalette } = useUi();
  const location = useLocation();
  const thread = useQuery({ queryKey: ['thread', threadId], queryFn: () => api.thread(threadId!), enabled: !!threadId });

  // The breadcrumb is the thread title in a conversation and the app name elsewhere (spec 6.2).
  const segment = location.pathname.split('/')[1] ?? 'home';
  const crumb = threadId ? (thread.data?.title ?? 'Conversation') : (APP_META[segmentToApp(segment)]?.label ?? 'Home');

  return (
    <header className={styles.bar} data-region="topbar" tabIndex={-1}>
      <IconButton
        label={bp === 'phone' ? 'Menu' : 'Expand or collapse navigation'}
        icon={<MenuIcon size={18} aria-hidden />}
        onClick={() => (bp === 'phone' ? setMobileNav(!mobileNavOpen) : toggleNav())}
        aria-expanded={bp === 'phone' ? mobileNavOpen : undefined}
      />
      <Link to="/home" className={styles.brand} aria-label={`Kinective Data Intelligence, ${session.tenant.name}, Home`}>
        <span className={styles.mark} aria-hidden>
          DI
        </span>
        {bp !== 'phone' && (
          <span className={styles.brandText}>
            <span className={styles.product}>Data Intelligence</span>
            <span className={styles.tenant}>{session.tenant.name}</span>
          </span>
        )}
      </Link>
      <span className={styles.divider} aria-hidden />
      <p className={styles.crumb} aria-live="polite">
        {crumb}
      </p>
      <div className={styles.tools}>
        <button type="button" className={styles.search} onClick={() => setPalette(true)} aria-keyshortcuts="Control+K Meta+K">
          <Search size={16} aria-hidden />
          {bp === 'desktop' || bp === 'laptop' ? (
            <>
              <span className={styles.searchText}>Search or ask</span>
              <kbd className={styles.kbd}>Ctrl K</kbd>
            </>
          ) : (
            <span className="dn-visually-hidden">Search or ask</span>
          )}
        </button>
        <HistoryMenu />
        <NotificationsButton />
        <IconButton label="Help: what can DI do?" icon={<CircleHelp size={18} aria-hidden />} onClick={() => setPalette(true)} />
        <UserMenu />
      </div>
    </header>
  );
}

const segmentToApp = (s: string) => (s === 'c' ? 'conversations' : s === 'members' || s === 'customers' ? 'rm' : s);

function HistoryMenu() {
  const recent = useUi((s) => s.recent);
  const navigate = useNavigate();
  const threads = recent.filter((r) => r.kind === 'thread');
  const views = recent.filter((r) => r.kind === 'view');
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label="Recent threads and views" icon={<History size={18} aria-hidden />} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.popover} align="end" sideOffset={6} collisionPadding={8}>
          {recent.length === 0 ? (
            <p className={styles.empty}>Threads and views you open appear here.</p>
          ) : (
            [
              ['Recent threads', threads],
              ['Recent views', views],
            ].map(([label, items]) =>
              (items as typeof recent).length ? (
                <div key={label as string} className={styles.group}>
                  <p className={styles.groupLabel}>{label as string}</p>
                  {(items as typeof recent).map((r) => (
                    <Popover.Close key={r.path} asChild>
                      <button type="button" className={styles.item} onClick={() => navigate(r.path)}>
                        {r.label}
                      </button>
                    </Popover.Close>
                  ))}
                </div>
              ) : null,
            )
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function UserMenu() {
  const { session, switchPersona } = useSession();
  const { theme, setTheme, density, setDensity } = usePreferences();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={styles.user} aria-label={`${session.user.name}, account and preferences`}>
          <span className={styles.avatar} aria-hidden>
            {session.user.initials}
          </span>
          <ChevronDown size={14} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.popover} align="end" sideOffset={6} collisionPadding={8}>
          <div className={styles.who}>
            <span className={styles.avatarLg} aria-hidden>
              {session.user.initials}
            </span>
            <span>
              <span className={styles.whoName}>{session.user.name}</span>
              <span className={styles.whoTitle}>{session.user.title}</span>
            </span>
          </div>
          <div className={styles.prefRow}>
            <span>Theme</span>
            <SegmentedControl<ThemePreference>
              label="Theme"
              iconOnly
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'system', label: 'Match system', icon: <Monitor size={14} aria-hidden /> },
                { value: 'light', label: 'Light', icon: <Sun size={14} aria-hidden /> },
                { value: 'dark', label: 'Dark', icon: <Moon size={14} aria-hidden /> },
              ]}
            />
          </div>
          <div className={styles.prefRow}>
            <span>Density</span>
            <SegmentedControl<Density>
              label="Density"
              iconOnly
              value={density}
              onChange={setDensity}
              options={[
                { value: 'comfortable', label: 'Comfortable', icon: <Rows3 size={14} aria-hidden /> },
                { value: 'compact', label: 'Compact', icon: <Rows4 size={14} aria-hidden /> },
              ]}
            />
          </div>
          {session.personas && (
            <div className={styles.group}>
              <p className={styles.groupLabel}>
                <UserRoundCog size={12} aria-hidden /> Developer: view as
              </p>
              {session.personas.map((p) => {
                const active = p.label.startsWith(session.user.name);
                return (
                  <Popover.Close key={p.id} asChild>
                    <button type="button" className={styles.item} aria-current={active || undefined} onClick={() => switchPersona(p.id)}>
                      <span className={styles.check}>{active && <Check size={14} aria-hidden />}</span>
                      {p.label}
                    </button>
                  </Popover.Close>
                );
              })}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
