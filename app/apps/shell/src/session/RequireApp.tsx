import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import type { AppId } from '@dinext/block-schemas';
import { useSession } from './SessionProvider.tsx';
import styles from '../pages/Page.module.css';

/** A deep link never grants access (FE-ARCH-010): apps outside the user's class show a notice. */
export function RequireApp({ app, children }: { app: AppId; children: ReactNode }) {
  const { can } = useSession();
  if (can(app)) return children;
  // An administrator manages classes, so they get told where; everyone else, who to ask.
  const admin = can('classes');
  return (
    <div className={styles.center}>
      <span className={styles.lockIcon} aria-hidden>
        <Lock size={22} />
      </span>
      <h1 className={styles.title}>You don’t have access to this page</h1>
      <p className={styles.lede}>{admin ? 'Your class doesn’t include this page. Classes shows what each class can open.' : 'Your role doesn’t include this page. If you need it, ask your DI administrator.'}</p>
    </div>
  );
}
