import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import styles from './SegmentedControl.module.css';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  iconOnly?: boolean;
}

/** A radio group styled as segments. Arrow keys move the selection, as WAI-ARIA radio groups do. */
export function SegmentedControl<T extends string>({ label, value, options, onChange, iconOnly }: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={label} className={styles.group}>
      {options.map((option, i) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={iconOnly ? option.label : undefined}
            title={iconOnly ? option.label : undefined}
            tabIndex={checked ? 0 : -1}
            className={clsx(styles.segment, checked && styles.checked)}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {option.icon}
            {!iconOnly && <span>{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
