// "Open grid" on a block: its rows at full size in the workspace grid (spec 6.17).
import type { Block } from '@dinext/block-schemas';
import DataGrid from '@dinext/blocks/grid';
import { formatAsOf } from '@dinext/blocks';
import styles from './Workspace.module.css';

export default function BlockGrid({ block }: { block: Block }) {
  if (block.type === 'table') {
    return (
      <div className={styles.table}>
        <div className={styles.gridArea}>
          <DataGrid columns={block.data.columns} rows={block.data.rows ?? []} sort={block.data.sort} layout="fill" filters ariaLabel={block.title ?? 'Table'} />
        </div>
        <p className={styles.count}>
          {block.data.rowCount.toLocaleString()} rows · {formatAsOf(block.freshness.asOf)}
        </p>
      </div>
    );
  }
  if (block.type === 'chart') {
    const { dimensions, source } = block.data.dataset;
    const unit = block.data.axes?.y?.[0]?.unit;
    const columns = dimensions.map((d, i) => ({ field: d.name, headerName: d.displayName ?? d.name, type: i === 0 ? ('text' as const) : unit === 'currency' ? ('currency' as const) : unit === 'percent' ? ('percent' as const) : ('number' as const) }));
    const rows = source.map((r) => Object.fromEntries(dimensions.map((d, i) => [d.name, r[i] ?? null])));
    return (
      <div className={styles.table}>
        <div className={styles.gridArea}>
          <DataGrid columns={columns} rows={rows} layout="fill" ariaLabel={block.title ?? 'Chart data'} />
        </div>
        <p className={styles.count}>
          {rows.length.toLocaleString()} rows · {formatAsOf(block.freshness.asOf)}
        </p>
      </div>
    );
  }
  return <p className={styles.message}>This result has no rows to open in a grid.</p>;
}
