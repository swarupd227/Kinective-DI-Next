// A member's 360 by opaque token (spec 8.24): in the workspace pane beside a conversation, or on
// /members/{token}. The server applies purview and logs the access; a 404 covers both "not found"
// and "outside your access", so the screen never hints that a record exists (spec 20.7).
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BlockHostProvider, BlockRenderer } from '@dinext/blocks';
import { Skeleton } from '@dinext/ui';
import { ApiError } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { useShellBlockHost } from '../shell/useShellBlockHost.ts';
import styles from './Workspace.module.css';

export function MemberRecord({ token, threadId, onLoaded }: { token: string; threadId?: string; onLoaded?: (name: string) => void }) {
  const { api, terms } = useSession();
  const host = useShellBlockHost({ threadId });
  const q = useQuery({ queryKey: ['member', token], queryFn: ({ signal }) => api.member(token, signal), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
  const name = q.data?.data.displayName;
  useEffect(() => {
    if (name) onLoaded?.(name);
  }, [name, onLoaded]);

  if (q.isPending) {
    return (
      <div className={styles.member} aria-busy>
        <Skeleton height="56px" width="60%" radius="md" />
        <Skeleton height="36px" radius="md" />
        <Skeleton height="200px" radius="md" />
      </div>
    );
  }
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <p className={styles.message} role="alert">
        {missing ? `This ${terms.person} record was not found, or it is outside your access.` : `The ${terms.person} record could not be loaded. Try again in a moment.`}
      </p>
    );
  }
  return (
    <div className={styles.member}>
      <BlockHostProvider value={host}>
        <BlockRenderer block={q.data} />
      </BlockHostProvider>
    </div>
  );
}
