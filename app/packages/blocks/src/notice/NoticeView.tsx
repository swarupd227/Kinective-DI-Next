import type { ReactNode } from 'react';
import clsx from 'clsx';
import { CircleAlert, CircleHelp, Database, FlaskConical, Info, Lock, RotateCw, SearchX, TriangleAlert, Wrench } from 'lucide-react';
import type { NoticeBlock } from '@dinext/block-schemas';
import { Button } from '@dinext/ui';
import { useBlockHost } from '../context.tsx';
import styles from './NoticeView.module.css';

type Kind = NoticeBlock['data']['kind'];

const meta: Record<Kind, { icon: ReactNode; tone: 'info' | 'warning' | 'danger' | 'neutral' | 'accent'; label: string }> = {
  info: { icon: <Info size={18} aria-hidden />, tone: 'info', label: 'Information' },
  warning: { icon: <TriangleAlert size={18} aria-hidden />, tone: 'warning', label: 'Warning' },
  error: { icon: <CircleAlert size={18} aria-hidden />, tone: 'danger', label: 'Something went wrong' },
  no_access: { icon: <Lock size={18} aria-hidden />, tone: 'neutral', label: 'No access' },
  no_data: { icon: <SearchX size={18} aria-hidden />, tone: 'neutral', label: 'No data' },
  not_supported: { icon: <Wrench size={18} aria-hidden />, tone: 'neutral', label: 'Not available' },
  uncertain: { icon: <CircleHelp size={18} aria-hidden />, tone: 'accent', label: 'Which did you mean?' },
  beta: { icon: <FlaskConical size={18} aria-hidden />, tone: 'info', label: 'Beta' },
  build_status: { icon: <Database size={18} aria-hidden />, tone: 'warning', label: 'Nightly build' },
};

/** Standard states (spec 10.5): no access, empty, error, uncertain, build status and more. */
export function NoticeView({ block }: { block: NoticeBlock }) {
  const host = useBlockHost();
  const { kind, message, detail, permission, referenceId, retryable, options } = block.data;
  const m = meta[kind];
  return (
    <div className={clsx(styles.notice, styles[m.tone])} role={kind === 'error' ? 'alert' : undefined}>
      <span className={styles.icon}>{m.icon}</span>
      <div className={styles.body}>
        <span className="dn-visually-hidden">{m.label}: </span>
        <p className={styles.message}>{message}</p>
        {detail && <p className={styles.detail}>{detail}</p>}
        {permission && (
          <p className={styles.detail}>
            Permission needed: <strong>{permission}</strong>
          </p>
        )}
        {(retryable || referenceId) && (
          <div className={styles.row}>
            {retryable && (
              <Button size="sm" icon={<RotateCw size={14} aria-hidden />} onClick={() => host.onRetry?.(block)}>
                Retry
              </Button>
            )}
            {referenceId && (
              <span className={styles.ref}>
                Reference <code>{referenceId}</code>
              </span>
            )}
          </div>
        )}
        {options && options.length > 0 && (
          <ul className={styles.options} aria-label="Options">
            {options.map((o) => (
              <li key={o.id}>
                <Button size="sm" onClick={() => host.onNoticeOption?.(block, o.id)}>
                  {o.label}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
