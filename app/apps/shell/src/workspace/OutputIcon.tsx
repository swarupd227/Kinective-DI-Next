import { BarChart3, FileText, Gauge } from 'lucide-react';

/** The kind of work an output is, at a glance. */
export function OutputIcon({ type, className }: { type: string; className?: string }) {
  if (type === 'chart') return <BarChart3 size={16} aria-hidden className={className} />;
  if (type === 'kpi_group') return <Gauge size={16} aria-hidden className={className} />;
  return <FileText size={16} aria-hidden className={className} />;
}
