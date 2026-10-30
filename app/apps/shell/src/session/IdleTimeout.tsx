// Idle and absolute session timeouts (spec 11.9, FE-ARCH-062). A warning appears two minutes
// before idle expiry with an option to stay signed in (WCAG 2.2.1).
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Clock } from 'lucide-react';
import { Button } from '@dinext/ui';
import { useSession } from './SessionProvider.tsx';
import styles from './IdleTimeout.module.css';

const WARN_MS = 2 * 60_000;

export function IdleTimeout() {
  const { session, connection } = useSession();
  const idleMs = session.timeouts.idleMinutes * 60_000;
  const absoluteMs = session.timeouts.absoluteHours * 3_600_000;
  const [remaining, setRemaining] = useState(idleMs);
  const [expired, setExpired] = useState(false);
  const lastActive = useRef(0);

  const markActive = useCallback(() => {
    lastActive.current = Date.now();
  }, []);

  useEffect(() => {
    const startedAt = Date.now();
    lastActive.current = startedAt;
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, markActive, { passive: true }));
    const tick = setInterval(() => {
      const left = Math.min(lastActive.current + idleMs, startedAt + absoluteMs) - Date.now();
      setRemaining(left);
      if (left <= 0) {
        setExpired(true);
        connection.stop();
      }
    }, 1000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, markActive));
      clearInterval(tick);
    };
  }, [idleMs, absoluteMs, connection, markActive]);

  const warn = !expired && remaining <= WARN_MS;
  const mm = Math.max(0, Math.floor(remaining / 60_000));
  const ss = String(Math.max(0, Math.floor((remaining % 60_000) / 1000))).padStart(2, '0');

  if (expired) {
    return (
      <div className={styles.ended} role="alert">
        <h1 className={styles.title}>You were signed out</h1>
        <p className={styles.text}>For your security, DI signs you out after {session.timeouts.idleMinutes} minutes without activity.</p>
        <Button variant="primary" onClick={() => location.reload()}>
          Sign in again
        </Button>
      </div>
    );
  }

  const stay = () => {
    markActive();
    setRemaining(idleMs);
  };

  return (
    <Dialog.Root open={warn}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} onEscapeKeyDown={stay}>
          <Clock size={22} aria-hidden className={styles.icon} />
          <Dialog.Title className={styles.title}>Still there?</Dialog.Title>
          <Dialog.Description className={styles.text}>
            You will be signed out in{' '}
            <strong className="dn-num">
              {mm}:{ss}
            </strong>{' '}
            because of inactivity.
          </Dialog.Description>
          <Button variant="primary" onClick={stay}>
            Stay signed in
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
