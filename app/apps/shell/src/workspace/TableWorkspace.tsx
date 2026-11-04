// A catalog table in the workspace (spec 8.11). Rows come back already limited to the user's
// purview; the grid itself is the shared AG Grid host.
import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Database, ExternalLink, Search } from 'lucide-react';
import { Skeleton, TextInput } from '@dinext/ui';
import { formatAsOf } from '@dinext/blocks';
import { useSession } from '../session/SessionProvider.tsx';
import { ApiError } from '@dinext/stream-client';
import styles from './Workspace.module.css';

const DataGrid = lazy(() => import('@dinext/blocks/grid'));

export function TableWorkspace({ tableId, full = false }: { tableId: string; full?: boolean }) {
  const { api } = useSession();
  const [filter, setFilter] = useState('');
  // A table loaded from someone's file isn't from the nightly build, and isn't cut to a purview.
  const uploaded = tableId.startsWith('upload-');
  const q = useQuery({ queryKey: ['table', tableId], queryFn: () => api.table(tableId) });

  if (q.isPending) return <Skeleton height="320px" radius="md" />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <p className={styles.message} role="alert">
        {missing ? 'There’s no table view of this data yet. Ask DI about it in the conversation instead.' : 'The table could not be loaded. Try again in a moment.'}
      </p>
    );
  }
  const t = q.data;
  return (
    <div className={styles.table}>
      <div className={styles.toolbar}>
        <TextInput
          label="Filter rows"
          hideLabel
          placeholder={`Filter ${t.rowCount.toLocaleString()} rows`}
          leading={<Search size={14} aria-hidden />}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={styles.filter}
        />
        <span className={styles.meta}>
          <Database size={12} aria-hidden />
          {uploaded ? 'Loaded from a file' : formatAsOf(t.freshnessAsOf)}
        </span>
        {!full && (
          <Link to={`/tables/${tableId}`} className={styles.fullLink}>
            Full view <ExternalLink size={12} aria-hidden />
          </Link>
        )}
      </div>
      <div className={styles.gridArea}>
        <Suspense fallback={<Skeleton height="320px" radius="md" />}>
          <DataGrid columns={t.columns} rows={t.rows} layout="fill" filters quickFilter={filter} ariaLabel={`${t.label} rows`} />
        </Suspense>
      </div>
      <p className={styles.count}>
        {t.rowCount.toLocaleString()} rows · {uploaded ? 'your own data, not from the nightly build' : 'limited to your purview'}
      </p>
    </div>
  );
}
