// Top bar on tablets and phones (spec 10.10): the menu, the thread title or app name, search and
// notifications. Wider screens keep all of this in the sidebar.
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router';
import { Check, ChevronDown, Menu as MenuIcon, Monitor, Moon, Rows3, Rows4, Search, Sun, UserRoundCog } from 'lucide-react';
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
  const { setMobileNav, mobileNavOpen, setPalette } = useUi();
  const location = useLocation();
  const thread = useQuery({ queryKey: ['thread', threadId], queryFn: () => api.thread(threadId!), enabled: !!threadId });

  // The breadcrumb is the thread title in a conversation and the app name elsewhere (spec 6.2).
  const segment = location.pathname.split('/')[1] ?? 'home';
  const crumb = threadId ? (thread.data?.title ?? 'Conversation') : (APP_META[segmentToApp(segment)]?.label ?? 'Home');

  return (
    <header className={styles.bar} data-region="topbar" tabIndex={-1}>
      <IconButton label="Menu" icon={<MenuIcon size={18} aria-hidden />} onClick={() => setMobileNav(!mobileNavOpen)} aria-expanded={mobileNavOpen} />
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
        <IconButton label="Search" icon={<Search size={18} aria-hidden />} onClick={() => setPalette(true)} aria-keyshortcuts="Control+K Meta+K" />
        <NotificationsButton />
        <UserMenu />
      </div>
    </header>
  );
}

const segmentToApp = (s: string) => (s === 'c' ? 'conversations' : s === 'members' || s === 'customers' ? 'rm' : s);

export function UserMenu() {
  const { session, switchPersona } = useSession();
  const { theme, setTheme, density, setDensity } = usePreferences();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const switchTo = (id: string) => {
    switchPersona(id);
    // Tasks are personal, so the one on screen is not the next person's.
    if (pathname.startsWith('/c/')) navigate('/home');
  };
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
                    <button type="button" className={styles.item} aria-current={active || undefined} onClick={() => switchTo(p.id)}>
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
