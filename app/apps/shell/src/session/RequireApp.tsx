import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type { AppId } from '@dinext/block-schemas';
import { useSession } from './SessionProvider.tsx';
import styles from '../pages/Page.module.css';

/** A deep link never grants access (FE-ARCH-010): apps outside the user's class show a notice. */
export function RequireApp({ app, children }: { app: AppId; children: ReactNode }) {
  const { can } = useSession();
  if (can(app)) return children;
  return (
    <div className={styles.center}>
      <span className={styles.lockIcon} aria-hidden>
        <Lock size={22} />
      </span>
      <h1 className={styles.title}>You do not have access to this view</h1>
      <p className={styles.lede}>Your role doesn’t include this page. If you need it, ask your DI administrator.</p>
    </div>
  );
}
