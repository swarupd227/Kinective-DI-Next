import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import styles from './TextInput.module.css';

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string;
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: string;
  leading?: ReactNode;
}

/** Labelled text field. Errors use text plus border, so colour is never the only cue (spec 9.6). */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { label, hideLabel, hint, error, leading, className, id, required, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className={clsx(styles.field, className)}>
      <label htmlFor={inputId} className={clsx(styles.label, hideLabel && 'dn-visually-hidden')}>
        {label}
        {required && (
          <span className={styles.required} aria-hidden>
            *
          </span>
        )}
      </label>
      <div className={clsx(styles.control, error && styles.invalid)}>
        {leading && <span className={styles.leading}>{leading}</span>}
        <input
          ref={ref}
          id={inputId}
          className={styles.input}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
          {...rest}
        />
      </div>
      {hint && (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className={styles.error}>
          {error}
        </span>
      )}
    </div>
  );
});
