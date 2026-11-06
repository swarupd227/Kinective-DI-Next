// The figures a page opens on, as slim cards edged in the Kinective palette (the colours of the DI
// dashboards bank staff know). A figure that needs attention takes the warning or danger colour, and a tile with
// a question hands that figure to DI: one click starts the task.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import clsx from 'clsx';
import { Sparkles } from 'lucide-react';
import { useSession } from '../session/SessionProvider.tsx';
import styles from './KpiTiles.module.css';

export interface KpiTile {
  label: string;
  value: string;
  detail?: string;
  tone?: 'neutral' | 'warning' | 'danger';
  ask?: string;
}

export function KpiTiles({ tiles, label = 'Key figures' }: { tiles: KpiTile[]; label?: string }) {
  const { startThread } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!tiles.length) return null;
  const act = (ask: string) => {
    setBusy(true);
    void startThread(ask).then((id) => navigate(`/c/${id}`), () => setBusy(false));
  };
  return (
    <ul className={styles.tiles} aria-label={label}>
      {tiles.map((t, i) => {
        const tone = t.tone === 'danger' ? styles.danger : t.tone === 'warning' ? styles.warning : styles[`c${i % 4}`];
        const body = (
          <>
            <span className={styles.value}>{t.value}</span>
            <span className={styles.label}>{t.label}</span>
            {t.detail && <span className={styles.detail}>{t.detail}</span>}
          </>
        );
        return (
          <li key={t.label} className={clsx(styles.tile, tone, t.ask && styles.actionable)}>
            {t.ask ? (
              <button type="button" className={styles.act} disabled={busy} onClick={() => act(t.ask!)} title={t.ask}>
                {body}
                <span className={styles.askHint}>
                  <Sparkles size={12} aria-hidden /> Ask DI
                </span>
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
