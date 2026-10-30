import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  /** Shows a spinner and blocks repeat activation, without removing the button from the tab order. */
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailingIcon, busy = false, className, children, disabled, onClick, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={clsx(styles.button, styles[variant], styles[size], busy && styles.busy, className)}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={busy ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {busy ? <Loader2 className={styles.spin} aria-hidden size={16} /> : icon}
      {children !== undefined && <span className={styles.label}>{children}</span>}
      {trailingIcon}
    </button>
  );
});
