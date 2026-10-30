// Notifications (spec 8.4): approvals, workflow, system and agent runs, each with its own unread
// count. New items arrive over the main stream without a reload (FE-NOTE-001, FE-NOTE-002).
import { useState } from 'react';
import { useNavigate } from 'react-router';
import * as Popover from '@radix-ui/react-popover';
import clsx from 'clsx';
import { Bell, Bot, CheckCheck, Inbox, ShieldAlert, TriangleAlert } from 'lucide-react';
import { IconButton } from '@dinext/ui';
import type { AppNotification, NotificationGroup } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';
import styles from './NotificationsPanel.module.css';

const GROUPS: { id: NotificationGroup | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'system', label: 'System' },
  { id: 'agent_runs', label: 'Agent runs' },
];

const icon: Record<NotificationGroup, typeof Bell> = { approvals: ShieldAlert, workflow: Inbox, system: TriangleAlert, agent_runs: Bot };

const ago = (iso: string) => {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
};

export function NotificationsButton() {
  const { notifications, markRead } = useSession();
  const [group, setGroup] = useState<NotificationGroup | 'all'>('all');
  const navigate = useNavigate();
  const unread = notifications.filter((n) => !n.read);
  const shown = notifications.filter((n) => group === 'all' || n.group === group);
  const unreadIn = (g: NotificationGroup | 'all') => unread.filter((n) => g === 'all' || n.group === g).length;

  const open = (n: AppNotification) => {
    markRead([n.id]);
    if (n.link) navigate(n.link);
  };

  return (
    <Popover.Root>
      <span className={styles.trigger}>
        <Popover.Trigger asChild>
          <IconButton label={unread.length ? `Notifications, ${unread.length} unread` : 'Notifications'} icon={<Bell size={18} aria-hidden />} />
        </Popover.Trigger>
        {unread.length > 0 && (
          <span className={styles.count} aria-hidden>
            {unread.length > 99 ? '99+' : unread.length}
          </span>
        )}
      </span>
      <Popover.Portal>
        <Popover.Content className={styles.panel} align="end" sideOffset={6} collisionPadding={8} aria-label="Notifications">
          <header className={styles.header}>
            <h2 className={styles.title}>Notifications</h2>
            <button type="button" className={styles.markAll} onClick={() => markRead(unread.map((n) => n.id))} disabled={!unread.length}>
              <CheckCheck size={14} aria-hidden /> Mark all read
            </button>
          </header>
          <div role="tablist" aria-label="Notification groups" className={styles.tabs}>
            {GROUPS.map((g) => (
              <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={clsx(styles.tab, group === g.id && styles.tabActive)} onClick={() => setGroup(g.id)}>
                {g.label}
                {unreadIn(g.id) > 0 && <span className={styles.tabCount}>{unreadIn(g.id)}</span>}
              </button>
            ))}
          </div>
          <ul className={styles.list} role="tabpanel" aria-label={GROUPS.find((g) => g.id === group)?.label}>
            {shown.length === 0 && <li className={styles.empty}>Nothing here.</li>}
            {shown.map((n) => {
              const Icon = icon[n.group];
              return (
                <li key={n.id}>
                  <Popover.Close asChild>
                    <button type="button" className={clsx(styles.item, !n.read && styles.unread)} onClick={() => open(n)}>
                      <span className={clsx(styles.icon, styles[n.group])}>
                        <Icon size={16} aria-hidden />
                      </span>
                      <span className={styles.text}>
                        <span className={styles.itemTitle}>
                          {!n.read && <span className="dn-visually-hidden">Unread: </span>}
                          {n.title}
                        </span>
                        {n.detail && <span className={styles.detail}>{n.detail}</span>}
                        <span className={styles.when}>{ago(n.at)}</span>
                      </span>
                    </button>
                  </Popover.Close>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
