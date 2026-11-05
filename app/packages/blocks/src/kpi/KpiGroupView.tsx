import clsx from 'clsx';
import type { KpiBlock, KpiGroupBlock } from '@dinext/block-schemas';
import { useBlockHost } from '../context.tsx';
import { KpiTile } from './KpiView.tsx';
import styles from './KpiView.module.css';

const explainOf = (block: KpiBlock | KpiGroupBlock) => block.actions?.find((a) => a.kind === 'explain');

/** Opening a figure asks for it by branch: the next question people ask after reading a total. */
const openFigure = (label: string) => ({ id: `open:${label}`, kind: 'drill' as const, label: `${label} by branch`, params: { question: `Show ${label.toLowerCase()} by branch` } });

export function KpiView({ block, loading }: { block: KpiBlock; loading?: boolean }) {
  const host = useBlockHost();
  const explain = explainOf(block);
  const metric = block.data.metricRef ? block.data.label : null;
  return (
    <KpiTile
      data={block.data}
      loading={loading}
      onExplain={explain ? () => host.onAction?.(block, explain) : undefined}
      onOpen={metric && host.onAction ? () => host.onAction?.(block, openFigure(metric)) : undefined}
    />
  );
}

export function KpiGroupView({ block, loading }: { block: KpiGroupBlock; loading?: boolean }) {
  const host = useBlockHost();
  return (
    <div className={clsx(styles.kpiGroup, block.data.layout === 'grid' && styles.grid)}>
      {(loading && !block.data.items?.length ? Array.from({ length: 4 }, () => null) : block.data.items).map((item, i) =>
        item ? (
          <KpiTile
            key={item.metricRef ?? item.label}
            data={item}
            onExplain={
              item.metricRef
                ? () => host.onAction?.(block, { id: `explain:${item.metricRef}`, kind: 'explain', label: 'Explain', params: { metricRef: item.metricRef ?? null } })
                : undefined
            }
            onOpen={item.metricRef && host.onAction ? () => host.onAction?.(block, openFigure(item.label)) : undefined}
          />
        ) : (
          <KpiTile key={i} data={{ label: '', value: null, unit: 'number' }} loading />
        ),
      )}
    </div>
  );
}
