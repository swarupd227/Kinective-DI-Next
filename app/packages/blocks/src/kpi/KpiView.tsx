import { useId } from 'react';
import clsx from 'clsx';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Info } from 'lucide-react';
import type { KpiData } from '@dinext/block-schemas';
import { IconButton, Skeleton } from '@dinext/ui';
import { formatValue } from '../format.ts';
import styles from './KpiView.module.css';

export interface KpiTileProps {
  data: KpiData;
  loading?: boolean;
  onExplain?: () => void;
}

function deltaTone(c: NonNullable<KpiData['comparison']>): 'good' | 'bad' | 'neutral' {
  if (c.direction === 'flat') return 'neutral';
  return c.direction === c.goodWhen ? 'good' : 'bad';
}

/** One KPI: value, change with direction in icon + words (never colour alone), sparkline, definition link. */
export function KpiTile({ data, loading, onExplain }: KpiTileProps) {
  const labelId = useId();
  if (loading) {
    return (
      <div className={styles.tile} aria-hidden>
        <Skeleton width="45%" height="12px" />
        <Skeleton width="70%" height="28px" />
        <Skeleton width="55%" height="12px" />
      </div>
    );
  }
  const value = formatValue(data.value, data.unit, data.format);
  const c = data.comparison;
  const tone = c ? deltaTone(c) : 'neutral';
  const Arrow = c?.direction === 'up' ? ArrowUpRight : c?.direction === 'down' ? ArrowDownRight : ArrowRight;
  const delta = c ? formatValue(c.value, c.unit ?? data.unit, { signed: c.direction !== 'flat', decimals: c.unit === 'percent' ? 1 : undefined }) : '';
  const spoken = c
    ? `${c.direction === 'flat' ? '' : c.direction === 'up' ? 'Up ' : 'Down '}${delta.replace(/^[+−-]/, '')} ${c.label}${tone === 'neutral' ? '' : tone === 'good' ? ', favourable' : ', unfavourable'}`
    : '';

  return (
    <div className={styles.tile} role="group" aria-labelledby={labelId}>
      <div className={styles.labelRow}>
        <span id={labelId} className={styles.label}>
          {data.label}
        </span>
        {onExplain && data.metricRef && (
          <IconButton size="sm" label={`Definition of ${data.label}`} icon={<Info size={14} aria-hidden />} onClick={onExplain} />
        )}
      </div>
      <span className={clsx(styles.value, 'dn-num')}>{value}</span>
      {c && (
        <span className={clsx(styles.delta, styles[tone])}>
          <span className={styles.deltaPill} aria-hidden>
            <Arrow size={14} />
            <span className="dn-num">{delta}</span>
          </span>
          <span className={styles.deltaLabel} aria-hidden>
            {c.label}
          </span>
          <span className="dn-visually-hidden">{spoken}</span>
        </span>
      )}
      {data.sparkline && data.sparkline.length > 1 && <Sparkline points={data.sparkline} tone={tone} />}
    </div>
  );
}

function Sparkline({ points, tone }: { points: number[]; tone: 'good' | 'bad' | 'neutral' }) {
  const w = 120;
  const h = 28;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 2 - ((p - min) / span) * (h - 4)] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const last = xy[xy.length - 1]!;
  return (
    <svg className={clsx(styles.spark, styles[`spark_${tone}`])} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden focusable="false">
      <path d={area} className={styles.sparkArea} />
      <path d={line} className={styles.sparkLine} vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.5" className={styles.sparkDot} />
    </svg>
  );
}
