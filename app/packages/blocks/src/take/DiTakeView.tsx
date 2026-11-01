// DI's view of a page or record, first, in a sentence, with the next step it would take. The figures
// below it are for checking. Code on the server writes the text and the action.
import { Sparkles } from 'lucide-react';
import type { DiTake } from '@dinext/block-schemas';
import { Button } from '@dinext/ui';
import styles from './DiTakeView.module.css';

export function DiTakeView({ take, busy, onAct }: { take: DiTake; busy?: boolean; onAct: (ask: string) => void }) {
  const { action } = take;
  return (
    <section className={styles.take} aria-label="DI’s view">
      <span className={styles.mark} aria-hidden>
        DI
      </span>
      <p className={styles.headline}>{take.headline}</p>
      {action && (
        <Button variant="primary" icon={<Sparkles size={14} aria-hidden />} disabled={busy} onClick={() => onAct(action.ask)}>
          {action.label}
        </Button>
      )}
    </section>
  );
}
