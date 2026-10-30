import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Lock, X } from 'lucide-react';
import styles from './Chip.module.css';

export interface ChipProps {
  children: ReactNode;
  icon?: ReactNode;
  /** Context chips (spec 6.7) show a remove button with an explicit accessible name. */
  onRemove?: () => void;
  removeLabel?: string;
  /** Source chips (spec 6.13) are clickable when the user may open the source. */
  onClick?: () => void;
  /** The source exists but the user cannot open it: shown with a lock and no link. */
  locked?: boolean;
  tone?: 'neutral' | 'accent';
  title?: string;
}

export function Chip({ children, icon, onRemove, removeLabel, onClick, locked, tone = 'neutral', title }: ChipProps) {
  const interactive = onClick && !locked;
  const body = (
    <>
      {locked ? <Lock size={12} aria-hidden /> : icon}
      <span className={styles.text}>{children}</span>
      {locked && <span className="dn-visually-hidden">(no access)</span>}
    </>
  );
  return (
    <span className={clsx(styles.chip, styles[tone], interactive && styles.interactive, locked && styles.locked)} title={title}>
      {interactive ? (
        <button type="button" className={styles.main} onClick={onClick}>
          {body}
        </button>
      ) : (
        <span className={styles.main}>{body}</span>
      )}
      {onRemove && (
        <button
          type="button"
          className={styles.remove}
          onClick={onRemove}
          aria-label={removeLabel ?? (typeof children === 'string' ? `Remove ${children}` : 'Remove')}
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </span>
  );
}
