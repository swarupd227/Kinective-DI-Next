// A catalog table in the workspace (spec 8.11). Rows come back already limited to the user's
// purview; the grid itself is the shared AG Grid host. A source chip opens here too: a curated table,
// or the month-end history behind a trend answer.
import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useMatch, useNavigate } from 'react-router';
import { Database, ExternalLink, Search, Sparkles } from 'lucide-react';
import { Button, Skeleton, TextInput } from '@dinext/ui';
import { formatAsOf } from '@dinext/blocks';
import { useSession } from '../session/SessionProvider.tsx';
import { ApiError } from '@dinext/stream-client';
import styles from './Workspace.module.css';

const DataGrid = lazy(() => import('@dinext/blocks/grid'));

export function TableWorkspace({ tableId, label, full = false }: { tableId: string; label?: string; full?: boolean }) {
  const { api } = useSession();
  const [filter, setFilter] = useState('');
  // A table loaded from someone's file isn't from the nightly build, and isn't cut to a purview.
  const uploaded = tableId.startsWith('upload-');
  const q = useQuery({ queryKey: ['table', tableId], queryFn: () => api.table(tableId) });

  if (q.isPending) return <Skeleton height="320px" radius="md" />;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return missing ? <NoTableView label={label} /> : (
      <p className={styles.message} role="alert">
        The table could not be loaded. Try again in a moment.
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
        {!full && !t.history && (
          <Link to={`/tables/${t.tableId}`} className={styles.fullLink}>
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
        {t.rowCount > t.rows.length ? `Latest ${t.rows.length.toLocaleString()} of ${t.rowCount.toLocaleString()} rows` : `${t.rowCount.toLocaleString()} rows`} ·{' '}
        {uploaded ? 'your own data, not from the nightly build' : 'limited to your purview'}
      </p>
    </div>
  );
}

/**
 * A source with no rows to show here (a working table of a module, say): what it is, and DI to ask
 * for its data in the task, rather than a dead end.
 */
function NoTableView({ label }: { label?: string }) {
  const { send, startThread } = useSession();
  const navigate = useNavigate();
  const thread = useMatch('/c/:threadId/*')?.params.threadId;
  const name = label ?? 'This source';
  const question = `Show me the data from ${label ?? 'that source'}`;
  const ask = () => {
    if (thread && thread !== 'new') void send(thread, question);
    else void startThread(question).then((id) => navigate(`/c/${id}`));
  };
  return (
    <div className={`${styles.message} ${styles.noView}`}>
      <p>{name} is one of the tables DI read for this answer. It has no table view of its own, but DI can show you what it holds.</p>
      <Button variant="secondary" size="sm" icon={<Sparkles size={14} aria-hidden />} onClick={ask}>
        Ask DI to show it
      </Button>
    </div>
  );
}
