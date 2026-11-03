// DI's view of a page or record, first, in a sentence, with the next step it would take and the other
// steps it can take for you. The figures below it are for checking. Code on the server writes the text
// and the actions; each one starts a task, and anything that changes data still waits for approval.
import { ArrowRight, Sparkles } from 'lucide-react';
import type { DiTake } from '@dinext/block-schemas';
import { Button } from '@dinext/ui';
import styles from './DiTakeView.module.css';

export function DiTakeView({ take, busy, onAct, more = [] }: { take: DiTake; busy?: boolean; onAct: (ask: string) => void; more?: string[] }) {
  const { action } = take;
  const others = more.filter((m) => m !== action?.ask).slice(0, 3);
  return (
    <section className={styles.take} aria-label="DI’s view">
      <div className={styles.main}>
        <span className={styles.mark} aria-hidden>
          <Sparkles size={16} />
        </span>
        <div className={styles.text}>
          <p className={styles.eyebrow}>DI’s read</p>
          <p className={styles.headline}>{take.headline}</p>
        </div>
        {action && (
          <Button variant="primary" icon={<Sparkles size={14} aria-hidden />} disabled={busy} onClick={() => onAct(action.ask)}>
            {action.label}
          </Button>
        )}
      </div>
      {others.length > 0 && (
        <div className={styles.more}>
          <span className={styles.moreLabel}>DI can also</span>
          <ul className={styles.moreList}>
            {others.map((m) => (
              <li key={m}>
                <button type="button" className={styles.moreItem} disabled={busy} onClick={() => onAct(m)}>
                  {m}
                  <ArrowRight size={13} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
