// Table block (FE-GEN-004): the client builds the grid from the declared columns only; the server
// never sends grid options. Lazy-loaded so AG Grid stays out of the shell's initial bundle.
import { useState } from 'react';
import type { TableBlock } from '@dinext/block-schemas';
import { TextInput } from '@dinext/ui';
import DataGrid from './DataGrid.tsx';
import styles from './TableView.module.css';

// Enough for a team or a branch list to read in the conversation without a scrollbar inside it.
const MAX_AUTO_HEIGHT_ROWS = 25;
// A list longer than this gets a search box, so a person can find one row without scrolling.
const SEARCH_FROM_ROWS = 12;

export default function TableView({ block }: { block: TableBlock }) {
  const { columns, rows = [], sort } = block.data;
  const [query, setQuery] = useState('');
  const autoHeight = rows.length <= MAX_AUTO_HEIGHT_ROWS;
  const name = (block.title ?? 'this table').toLowerCase();
  return (
    <div className={styles.wrap}>
      {rows.length > SEARCH_FROM_ROWS && (
        <TextInput label={`Search ${name}`} hideLabel type="search" placeholder={`Search ${name}`} value={query} onChange={(e) => setQuery(e.target.value)} className={styles.search} />
      )}
      <div className={autoHeight ? undefined : styles.fixed}>
        <DataGrid columns={columns} rows={rows} sort={sort} layout={autoHeight ? 'auto' : 'fill'} quickFilter={query.trim() || undefined} ariaLabel={block.title ?? 'Table'} />
      </div>
      {block.data.rowCount > rows.length && (
        <p className={styles.more}>
          Showing {rows.length.toLocaleString()} of {block.data.rowCount.toLocaleString()} rows. Open the grid to see them all.
        </p>
      )}
    </div>
  );
}
