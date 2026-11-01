// Number, unit and freshness formatting (spec 10.4 units and labels, 10.11 locale).
import type { ValueUnit } from '@dinext/block-schemas';

export type ColumnType = 'text' | 'number' | 'currency' | 'percent' | 'bp' | 'count' | 'date' | 'days';

const locale = () => (typeof navigator !== 'undefined' ? navigator.language : 'en-US');

export interface FormatOptions {
  compact?: boolean;
  decimals?: number;
  signed?: boolean;
}

/** Currency abbreviates to K, M, B with one decimal by default; percentages to one decimal; bp labelled "bp". */
export function formatValue(value: number | null | undefined, unit: ValueUnit | ColumnType, opts: FormatOptions = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = opts.signed ? 'exceptZero' : 'auto';
  switch (unit) {
    case 'currency': {
      const compact = opts.compact ?? Math.abs(value) >= 1_000_000;
      return new Intl.NumberFormat(locale(), {
        style: 'currency',
        currency: 'USD',
        notation: compact ? 'compact' : 'standard',
        minimumFractionDigits: compact ? (opts.decimals ?? 1) : (opts.decimals ?? 0),
        maximumFractionDigits: compact ? (opts.decimals ?? 1) : (opts.decimals ?? 0),
        signDisplay: sign,
      }).format(value);
    }
    case 'percent':
      return `${new Intl.NumberFormat(locale(), {
        minimumFractionDigits: opts.decimals ?? 1,
        maximumFractionDigits: opts.decimals ?? 1,
        signDisplay: sign,
      }).format(value)}%`;
    case 'bp':
      return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 0, signDisplay: sign }).format(value)} bp`;
    case 'days':
      return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(value)} days`;
    case 'count':
    case 'number':
      return new Intl.NumberFormat(locale(), {
        notation: opts.compact ? 'compact' : 'standard',
        maximumFractionDigits: opts.decimals ?? (unit === 'count' ? 0 : 2),
        signDisplay: sign,
      }).format(value);
    default:
      return String(value);
  }
}

/** Axis labels: always compact so ticks stay short. */
export const formatAxis = (value: number, unit: ValueUnit | undefined) => {
  // Balances sit in narrow ranges too ($1.21B-$1.24B), so ticks keep up to two decimals.
  if (unit === 'currency') return new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD', notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  // Rates sit in narrow ranges (0.39%-0.41%), so ticks keep up to three decimals to stay distinct.
  if (unit === 'percent') return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 3 }).format(value)}%`;
  return unit ? formatValue(value, unit) : String(value);
};

/** "Data as of nightly build 26 Oct 2026 04:10" (spec Part B freshness wording; never "live"). */
export function formatAsOf(iso: string | undefined): string {
  if (!iso) return 'Data as of nightly build';
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `Data as of nightly build ${date} ${time}`;
}

export function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(iso));
}

export function formatClock(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatRelativeFuture(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'expired';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'in under a minute';
  if (min < 60) return `in ${min} min`;
  return `in ${Math.round(min / 60)} h`;
}
