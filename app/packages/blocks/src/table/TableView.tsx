// Table block (FE-GEN-004): the client builds the grid from the declared columns only; the server
// never sends grid options. Lazy-loaded so AG Grid stays out of the shell's initial bundle.
import { useEffect, useState } from 'react';
import type { TableBlock } from '@dinext/block-schemas';
import { TextInput } from '@dinext/ui';
import { formatValue } from '../format.ts';
import DataGrid from './DataGrid.tsx';
import styles from './TableView.module.css';

// Enough for a team or a branch list to read in the conversation without a scrollbar inside it.
const MAX_AUTO_HEIGHT_ROWS = 25;
// A list longer than this gets a search box, so a person can find one row without scrolling.
const SEARCH_FROM_ROWS = 12;
// On a phone a table of three or more columns reads as one card per row, not a grid scrolled sideways.
const PHONE = '(width <= 640px)';
const STACK_MAX_ROWS = 60;
const NUMERIC = new Set(['number', 'currency', 'percent', 'count', 'days']);

function usePhone() {
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE) : null;
  const [phone, setPhone] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const on = () => setPhone(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, [query]);
  return phone;
}

type Column = TableBlock['data']['columns'][number];
const cell = (c: Column, v: unknown) => (v === null || v === undefined || v === '' ? '—' : NUMERIC.has(c.type ?? 'text') && typeof v === 'number' ? formatValue(v, c.type as never, { decimals: c.type === 'percent' ? 2 : undefined }) : String(v));

/** One card per row: the first column is the card's title, the rest are label and value. */
function Stacked({ columns, rows, label }: { columns: Column[]; rows: Record<string, unknown>[]; label: string }) {
  const [first, ...rest] = columns;
  return (
    <ul className={styles.stack} aria-label={label}>
      {rows.map((r, i) => (
        <li key={i} className={styles.card}>
          <strong className={styles.cardTitle}>{first ? cell(first, r[first.field]) : ''}</strong>
          <dl className={styles.pairs}>
            {rest.map((c) => (
              <div key={c.field} className={styles.pair}>
                <dt>{c.headerName}</dt>
                <dd className={NUMERIC.has(c.type ?? 'text') ? 'dn-num' : undefined}>{cell(c, r[c.field])}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

export default function TableView({ block }: { block: TableBlock }) {
  const { columns, rows = [], sort } = block.data;
  const [query, setQuery] = useState('');
  const phone = usePhone();
  const autoHeight = rows.length <= MAX_AUTO_HEIGHT_ROWS;
  const visible = columns.filter((c) => !c.hidden);
  const stacked = phone && visible.length >= 3 && rows.length <= STACK_MAX_ROWS;
  const q = query.trim().toLowerCase();
  const found = q ? rows.filter((r) => visible.some((c) => String(r[c.field] ?? '').toLowerCase().includes(q))) : rows;
  const name = (block.title ?? 'this table').toLowerCase();
  return (
    <div className={styles.wrap}>
      {rows.length > SEARCH_FROM_ROWS && (
        <TextInput label={`Search ${name}`} hideLabel type="search" placeholder={`Search ${name}`} value={query} onChange={(e) => setQuery(e.target.value)} className={styles.search} />
      )}
      {stacked ? (
        <Stacked columns={visible} rows={found} label={block.title ?? 'Table'} />
      ) : (
        <div className={autoHeight ? undefined : styles.fixed}>
          <DataGrid columns={columns} rows={rows} sort={sort} layout={autoHeight ? 'auto' : 'fill'} quickFilter={query.trim() || undefined} ariaLabel={block.title ?? 'Table'} />
        </div>
      )}
      {block.data.rowCount > rows.length && (
        <p className={styles.more}>
          Showing {rows.length.toLocaleString()} of {block.data.rowCount.toLocaleString()} rows. Open the grid to see them all.
        </p>
      )}
    </div>
  );
}
