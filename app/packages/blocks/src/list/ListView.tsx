import { useId, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  AlarmClock,
  BadgeAlert,
  CalendarDays,
  ChevronRight,
  Database,
  FileText,
  FileWarning,
  Inbox,
  Landmark,
  ListTodo,
  PiggyBank,
  Share2,
  TrendingDown,
  TrendingUp,
  UserRound,
  Workflow,
} from 'lucide-react';
import type { ListBlock, ListIcon } from '@dinext/block-schemas';
import { Badge } from '@dinext/ui';
import { useBlockHost } from '../context.tsx';
import styles from './ListView.module.css';

const icons: Record<ListIcon, ReactNode> = {
  alert: <BadgeAlert size={16} aria-hidden />,
  trend_down: <TrendingDown size={16} aria-hidden />,
  trend_up: <TrendingUp size={16} aria-hidden />,
  calendar: <CalendarDays size={16} aria-hidden />,
  clock: <AlarmClock size={16} aria-hidden />,
  inbox: <Inbox size={16} aria-hidden />,
  task: <ListTodo size={16} aria-hidden />,
  report: <FileText size={16} aria-hidden />,
  report_failed: <FileWarning size={16} aria-hidden />,
  member: <UserRound size={16} aria-hidden />,
  referral: <Share2 size={16} aria-hidden />,
  loan: <Landmark size={16} aria-hidden />,
  certificate: <PiggyBank size={16} aria-hidden />,
  database: <Database size={16} aria-hidden />,
  workflow: <Workflow size={16} aria-hidden />,
};

type Item = ListBlock['data']['items'][number];

/** A keyboard-navigable list of items with optional "Why?" explanations (spec 6.3, 9.4). */
export function ListView({ block }: { block: ListBlock }) {
  const host = useBlockHost();
  const { items, layout } = block.data;
  return (
    <ul className={clsx(styles.list, layout === 'columns' && styles.columns)}>
      {items.map((item) => (
        <Row key={item.id} item={item} onOpen={item.link ? () => host.onNavigate?.(item.link!) : undefined} />
      ))}
    </ul>
  );
}

function Row({ item, onOpen }: { item: Item; onOpen?: () => void }) {
  const [why, setWhy] = useState(false);
  const whyId = useId();
  const body = (
    <>
      {item.icon && <span className={clsx(styles.icon, item.badge && styles[`icon_${item.badge.tone}`])}>{icons[item.icon]}</span>}
      <span className={styles.text}>
        <span className={styles.title}>{item.title}</span>
        {item.subtitle && <span className={styles.subtitle}>{item.subtitle}</span>}
      </span>
      {item.meta && <span className={clsx(styles.meta, 'dn-num')}>{item.meta}</span>}
      {item.badge && <Badge tone={item.badge.tone}>{item.badge.label}</Badge>}
      {onOpen && <ChevronRight size={16} aria-hidden className={styles.chev} />}
    </>
  );
  return (
    <li className={styles.item}>
      <div className={styles.row}>
        {onOpen ? (
          <a
            href={item.link}
            className={styles.main}
            onClick={(e) => {
              e.preventDefault();
              onOpen();
            }}
          >
            {body}
          </a>
        ) : (
          <span className={styles.main}>{body}</span>
        )}
        {item.why && (
          <button type="button" className={styles.why} aria-expanded={why} aria-controls={whyId} onClick={() => setWhy((w) => !w)}>
            Why?
          </button>
        )}
      </div>
      {item.why && why && (
        <p id={whyId} className={styles.whyText}>
          {item.why}
        </p>
      )}
    </li>
  );
}
