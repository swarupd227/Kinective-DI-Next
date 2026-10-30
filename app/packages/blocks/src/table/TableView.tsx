// Table block (FE-GEN-004): the client builds the grid from the declared columns only; the server
// never sends grid options. Lazy-loaded so AG Grid stays out of the shell's initial bundle.
import type { TableBlock } from '@dinext/block-schemas';
import DataGrid from './DataGrid.tsx';
import styles from './TableView.module.css';

const MAX_AUTO_HEIGHT_ROWS = 10;

export default function TableView({ block }: { block: TableBlock }) {
  const { columns, rows = [], sort } = block.data;
  const autoHeight = rows.length <= MAX_AUTO_HEIGHT_ROWS;
  return (
    <div className={styles.wrap}>
      <div className={autoHeight ? undefined : styles.fixed}>
        <DataGrid columns={columns} rows={rows} sort={sort} layout={autoHeight ? 'auto' : 'fill'} ariaLabel={block.title ?? 'Table'} />
      </div>
      {block.data.rowCount > rows.length && (
        <p className={styles.more}>
          Showing {rows.length.toLocaleString()} of {block.data.rowCount.toLocaleString()} rows. Open the grid to see them all.
        </p>
      )}
    </div>
  );
}
