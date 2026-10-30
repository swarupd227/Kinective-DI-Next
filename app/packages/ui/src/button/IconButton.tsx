import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Tooltip } from '../tooltip/Tooltip.tsx';
import styles from './IconButton.module.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Accessible name; also shown as the tooltip. Required because the button has no visible text. */
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md';
  pressed?: boolean;
  shortcut?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', pressed, shortcut, className, ...rest },
  ref,
) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        className={clsx(styles.iconButton, styles[size], pressed && styles.pressed, className)}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  );
});
