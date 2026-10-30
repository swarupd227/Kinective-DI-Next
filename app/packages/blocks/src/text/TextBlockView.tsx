import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TextBlock } from '@dinext/block-schemas';
import { useMemo } from 'react';
import { Skeleton } from '@dinext/ui';
import { useBlockHost } from '../context.tsx';
import { safeHref } from './safeHref.ts';
import styles from './TextBlockView.module.css';

/** Restricted Markdown subset (spec 9.5); raw HTML is skipped. */
const ALLOWED = ['p', 'strong', 'em', 'ul', 'ol', 'li', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'del'];

const makeComponents = (navigate?: (link: string) => void): Components => ({
  a: ({ href, children }) => {
    const safe = href ? safeHref(href) : null;
    if (!safe) return <span className={styles.blockedLink}>{children}</span>;
    const external = !safe.startsWith('/');
    return (
      <a
        href={safe}
        className={styles.link}
        onClick={
          !external && navigate
            ? (e) => {
                e.preventDefault();
                navigate(safe);
              }
            : undefined
        }
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {children}
        {external && <span className="dn-visually-hidden"> (opens in a new tab)</span>}
      </a>
    );
  },
  table: ({ children }) => (
    <div className={styles.tableWrap}>
      <table>{children}</table>
    </div>
  ),
});

export function TextBlockView({ block, status }: { block: TextBlock; status: 'loading' | 'streaming' | 'complete' }) {
  const { onNavigate } = useBlockHost();
  const components = useMemo(() => makeComponents(onNavigate), [onNavigate]);
  if (status === 'loading' && !block.data.markdown) {
    return (
      <div className={styles.skeleton}>
        <Skeleton width="92%" />
        <Skeleton width="80%" />
        <Skeleton width="56%" />
      </div>
    );
  }
  return (
    <div className={styles.prose}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        allowedElements={ALLOWED}
        unwrapDisallowed
        urlTransform={(url) => safeHref(url) ?? ''}
        components={components}
      >
        {block.data.markdown}
      </Markdown>
    </div>
  );
}
