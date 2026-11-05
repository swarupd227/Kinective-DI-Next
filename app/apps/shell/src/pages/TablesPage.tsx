// Tables app as a classic view (FE-EXP-002): full width, no conversation needed to read it. Every
// change (a snapshot, a merged view, sharing, deleting, restoring) starts a conversation with DI and
// waits on an approval card; the buttons here only ask.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Table2 } from 'lucide-react';
import { SegmentedControl } from '@dinext/ui';
import type { TableWorkbench } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';
import { DiTake } from '../shell/DiTake.tsx';
import { useUi } from '../shell/uiStore.ts';
import { TableWorkspace } from '../workspace/TableWorkspace.tsx';
import { Blocks, Prompts } from './AppViewPage.tsx';
import page from './Page.module.css';
import styles from './TablesPage.module.css';

/** Starts a conversation with DI on these words. */
function useAsk() {
  const { startThread } = useSession();
  const navigate = useNavigate();
  return (ask: string) => void startThread(ask).then((id) => navigate(`/c/${id}`));
}

export function TablesPage() {
  const { api } = useSession();
  const tables = useQuery({ queryKey: ['search', 'tables'], queryFn: () => api.search('tables') });
  // Saved views, snapshots and the Recycle Bin. Without them in this environment, the list still shows.
  const bench = useQuery({ queryKey: ['app', 'tables'], queryFn: () => api.appView('tables'), retry: false });
  const v = bench.data;
  return (
    <div className={page.page}>
      <header className={page.header}>
        <h1 className={page.title}>Tables</h1>
        <p className={page.lede}>Curated tables from the nightly build, and the saved views and snapshots made from them. Open one to work in the grid, or ask DI about it.</p>
      </header>
      <div className={styles.stack}>
        {v && <DiTake take={v.take} />}
        <ul className={styles.list}>
          {(tables.data ?? [])
            .filter((t) => t.kind === 'table' || t.kind === 'view')
            .map((t) => (
              <li key={t.id}>
                <Link to={t.link} className={styles.item}>
                  <Table2 size={18} aria-hidden className={styles.icon} />
                  <span className={styles.text}>
                    <span className={styles.label}>{t.label}</span>
                    <span className={styles.detail}>{t.detail}</span>
                  </span>
                  <ChevronRight size={16} aria-hidden className={styles.icon} />
                </Link>
              </li>
            ))}
        </ul>
        {v && (
          <>
            {v.notice && (
              <p className={styles.notice} role="note">
                {v.notice}
              </p>
            )}
            <Blocks view={v} />
            {v.links && v.links.length > 0 && (
              <ul className={styles.links} aria-label="Open a saved view or snapshot">
                {v.links.map((l) => (
                  <li key={l.to}>
                    <Link to={l.to} className={styles.crumb}>
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Prompts prompts={v.prompts} />
          </>
        )}
      </div>
    </div>
  );
}

type Tab = 'records' | 'stats' | 'links' | 'saved';

function Actions({ bench }: { bench: TableWorkbench }) {
  const ask = useAsk();
  return (
    <div role="toolbar" aria-label="Ask DI about this table" className={styles.actions}>
      {bench.actions.map((a) => (
        <button key={a.label} type="button" className={page.prompt} disabled={!a.ask} title={a.ask ?? a.why} onClick={() => a.ask && ask(a.ask)}>
          {a.label}
        </button>
      ))}
    </div>
  );
}

function Stats({ bench }: { bench: TableWorkbench }) {
  if (!bench.stats.length) return <p className={styles.detail}>Column stats are worked out for curated tables. Open the table this was made from to see them.</p>;
  return (
    <section aria-label="Column stats" className={styles.section}>
      <p className={styles.detail}>Worked out over the rows in your purview.{bench.personal.length ? ` Personal columns (${bench.personal.join(', ')}) are left out.` : ''}</p>
      <div className={styles.scroll}>
        <table className={styles.grid}>
          <thead>
            <tr>
              {['Column', 'Type', 'Filled', 'Distinct', 'Range', 'Average', 'Top values'].map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bench.stats.map((s) => (
              <tr key={s.column}>
                <th scope="row">{s.column}</th>
                <td>{s.type}</td>
                <td>{s.filled}</td>
                <td>{s.distinct.toLocaleString()}</td>
                <td>{s.range}</td>
                <td>{s.average}</td>
                <td>{s.top}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Links({ bench }: { bench: TableWorkbench }) {
  const ask = useAsk();
  if (!bench.relationships.length) return <p className={styles.detail}>No other curated table links to this one.</p>;
  return (
    <ul className={styles.rows} aria-label="Linked tables">
      {bench.relationships.map((r) => (
        <li key={`${r.tableId}-${r.key}`} className={styles.row}>
          <span className={styles.text}>
            <Link to={`/tables/${r.tableId}`} className={styles.label}>
              {r.table}
            </Link>
            <span className={styles.detail}>
              On {r.key}. {r.shape}.
            </span>
          </span>
          <button type="button" className={page.prompt} onClick={() => ask(`Merge ${bench.label} with ${r.table} on ${r.key} as a saved view called ${bench.label} with ${r.table}`)}>
            Combine with a linked table…
          </button>
        </li>
      ))}
    </ul>
  );
}

function Saved({ bench }: { bench: TableWorkbench }) {
  const ask = useAsk();
  if (!bench.saved.length) return <p className={styles.detail}>Nothing is saved from this table yet. Use Save a copy or Combine with a linked table… to ask DI for one.</p>;
  return (
    <ul className={styles.rows} aria-label="Saved views and snapshots">
      {bench.saved.map((s) => (
        <li key={s.id} className={styles.row}>
          <span className={styles.text}>
            <Link to={`/tables/${s.id}`} className={styles.label}>
              {s.name}
            </Link>
            <span className={styles.detail}>
              {s.kind} · {s.rows === 'Runs when opened' ? s.rows : `${s.rows} rows`} · {s.mine ? s.shared : `From ${s.owner}`} · {s.made}
            </span>
          </span>
          {s.mine && (
            <span className={styles.rowActions}>
              <button type="button" className={page.prompt} onClick={() => ask(s.kind !== 'Saved view' ? `Make ${s.name} public` : `Make the ${s.name} view public`)}>
                Share with everyone
              </button>
              <button type="button" className={page.prompt} onClick={() => ask(s.kind !== 'Saved view' ? `Delete ${s.name}` : `Delete the ${s.name} view`)}>
                Delete
              </button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function TablePage() {
  const { tableId = '' } = useParams();
  const { api } = useSession();
  const [tab, setTab] = useState<Tab>('records');
  const data = useQuery({ queryKey: ['table', tableId], queryFn: () => api.table(tableId) });
  const bench = useQuery({ queryKey: ['table-workbench', tableId], queryFn: () => api.tableWorkbench(tableId), retry: false });
  const label = bench.data?.label ?? data.data?.label ?? tableId.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  useEffect(() => {
    useUi.getState().visit({ kind: 'view', path: `/tables/${tableId}`, label });
    // Opening a table adds it as context for the next question (FE-EXP-051).
    useUi.getState().addContext('new', { type: 'table', ref: tableId, label });
    return () => useUi.getState().removeContext('new', { type: 'table', ref: tableId, label });
  }, [tableId, label]);
  const b = bench.data;
  return (
    <div className={b ? styles.fullBench : styles.full}>
      <header className={styles.fullHeader}>
        <Link to="/tables" className={styles.crumb}>
          Tables
        </Link>
        <ChevronRight size={14} aria-hidden />
        <h1 className={styles.fullTitle}>{label}</h1>
      </header>
      {b && (
        <div className={styles.bar}>
          <SegmentedControl
            label="Show"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'records', label: 'Records' },
              { value: 'stats', label: 'Column summary' },
              { value: 'links', label: 'Linked tables' },
              { value: 'saved', label: `Saved views & snapshots (${b.saved.length})` },
            ]}
          />
          <Actions bench={b} />
        </div>
      )}
      <div className={tab === 'records' ? styles.fullBody : styles.fullScroll}>
        {tab === 'records' || !b ? <TableWorkspace tableId={tableId} full /> : tab === 'stats' ? <Stats bench={b} /> : tab === 'links' ? <Links bench={b} /> : <Saved bench={b} />}
      </div>
    </div>
  );
}
