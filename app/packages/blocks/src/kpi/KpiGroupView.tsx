import clsx from 'clsx';
import type { KpiBlock, KpiGroupBlock } from '@dinext/block-schemas';
import { useBlockHost } from '../context.tsx';
import { KpiTile } from './KpiView.tsx';
import styles from './KpiView.module.css';

const explainOf = (block: KpiBlock | KpiGroupBlock) => block.actions?.find((a) => a.kind === 'explain');

export function KpiView({ block, loading }: { block: KpiBlock; loading?: boolean }) {
  const host = useBlockHost();
  const explain = explainOf(block);
  return <KpiTile data={block.data} loading={loading} onExplain={explain ? () => host.onAction?.(block, explain) : undefined} />;
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
          />
        ) : (
          <KpiTile key={i} data={{ label: '', value: null, unit: 'number' }} loading />
        ),
      )}
    </div>
  );
}
