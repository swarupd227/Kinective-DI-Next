// The figures a page opens on, as solid tiles in the Kinective palette, like the dashboards bank staff
// know from DI. A tile that needs attention takes the warning or danger colour instead.
import clsx from 'clsx';
import styles from './KpiTiles.module.css';

export interface KpiTile {
  label: string;
  value: string;
  detail?: string;
  tone?: 'neutral' | 'warning' | 'danger';
}

export function KpiTiles({ tiles, label = 'Key figures' }: { tiles: KpiTile[]; label?: string }) {
  if (!tiles.length) return null;
  return (
    <ul className={styles.tiles} aria-label={label}>
      {tiles.map((t, i) => (
        <li key={t.label} className={clsx(styles.tile, t.tone === 'danger' ? styles.danger : t.tone === 'warning' ? styles.warning : styles[`c${i % 4}`])}>
          <span className={styles.value}>{t.value}</span>
          <span className={styles.label}>{t.label}</span>
          {t.detail && <span className={styles.detail}>{t.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
