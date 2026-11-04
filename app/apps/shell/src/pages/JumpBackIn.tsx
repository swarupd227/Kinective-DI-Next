// "Jump back in" on Home: a few places worth opening today, each with a live figure, DI's reason and
// one action. Today's DI lists every dashboard and leaves the choosing to you; here DI chooses, says
// why, and the full catalog is one keystroke away (Ctrl K) or on All dashboards.
import { Link, useNavigate } from 'react-router';
import clsx from 'clsx';
import { ArrowRight, Clock, FileBarChart, LayoutGrid, Pin, Sparkles, Workflow } from 'lucide-react';
import { formatValue } from '@dinext/blocks';
import type { JumpCard } from '@dinext/block-schemas';
import { useUi } from '../shell/uiStore.ts';
import styles from './JumpBackIn.module.css';

const ICON = { report: FileBarChart, work: Workflow, pinned: Pin };
const MAX = 4;

export function JumpBackIn({ cards, ask }: { cards: JumpCard[]; ask: (text: string) => void }) {
  const navigate = useNavigate();
  // Pages opened in this session fill any space DI leaves, newest first.
  const recent = useUi((s) => s.recent)
    .filter((r) => r.kind === 'view' && r.path !== '/home' && !cards.some((c) => c.link === r.path))
    .slice(0, Math.max(0, MAX - cards.length));
  if (!cards.length && !recent.length) return null;
  const openPalette = () => useUi.getState().setPalette(true);

  return (
    <section className={styles.jump} aria-labelledby="h-jump">
      <div className={styles.head}>
        <h2 id="h-jump" className={styles.title}>
          Jump back in
        </h2>
        <span className={styles.find}>
          <button type="button" className={styles.linkButton} onClick={openPalette}>
            Find anything <kbd>Ctrl K</kbd>
          </button>
          <Link to="/dashboards" className={styles.all}>
            <LayoutGrid size={14} aria-hidden /> All dashboards
          </Link>
        </span>
      </div>
      <ul className={styles.grid}>
        {cards.map((c) => {
          const Icon = ICON[c.kind];
          return (
            <li key={c.id} className={styles.card}>
              <Link to={c.link} className={styles.open} aria-label={`Open ${c.title}`}>
                <span className={styles.cardHead}>
                  <Icon size={14} aria-hidden className={styles.icon} />
                  <span className={styles.name}>{c.title}</span>
                  <ArrowRight size={14} aria-hidden className={styles.arrow} />
                </span>
                {c.figure && (
                  <span className={styles.figure}>
                    <span className={styles.value}>{formatValue(c.figure.value, c.figure.unit, { decimals: c.figure.decimals, compact: c.figure.compact })}</span>
                    <span className={styles.figureLabel}>{c.figure.label}</span>
                  </span>
                )}
                {c.change && <span className={clsx(styles.change, c.change.good === true && styles.good, c.change.good === false && styles.bad)}>{c.change.text}</span>}
                <span className={styles.reason}>
                  <Sparkles size={12} aria-hidden className={styles.spark} />
                  {c.reason}
                </span>
              </Link>
              {c.action && (
                <button type="button" className={styles.action} onClick={() => ask(c.action!.ask)}>
                  {c.action.label}
                </button>
              )}
            </li>
          );
        })}
        {recent.map((r) => (
          <li key={r.path} className={styles.card}>
            <button type="button" className={styles.open} onClick={() => navigate(r.path)}>
              <span className={styles.cardHead}>
                <Clock size={14} aria-hidden className={styles.icon} />
                <span className={styles.name}>{r.label}</span>
                <ArrowRight size={14} aria-hidden className={styles.arrow} />
              </span>
              <span className={styles.reason}>You opened this earlier today.</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
