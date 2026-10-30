// Tables app as a classic view (FE-EXP-002): full width, no conversation needed.
import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Table2 } from 'lucide-react';
import { useSession } from '../session/SessionProvider.tsx';
import { useUi } from '../shell/uiStore.ts';
import { TableWorkspace } from '../workspace/TableWorkspace.tsx';
import page from './Page.module.css';
import styles from './TablesPage.module.css';

export function TablesPage() {
  const { api } = useSession();
  const tables = useQuery({ queryKey: ['search', 'tables'], queryFn: () => api.search('tables') });
  return (
    <div className={page.page}>
      <header className={page.header}>
        <h1 className={page.title}>Tables</h1>
        <p className={page.lede}>Curated tables and saved views from the nightly build. Open one to work in the grid, or ask DI about it.</p>
      </header>
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
    </div>
  );
}

export function TablePage() {
  const { tableId = '' } = useParams();
  const label = tableId.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  useEffect(() => {
    useUi.getState().visit({ kind: 'view', path: `/tables/${tableId}`, label });
    // Opening a table adds it as context for the next question (FE-EXP-051).
    useUi.getState().addContext('new', { type: 'table', ref: tableId, label });
    return () => useUi.getState().removeContext('new', { type: 'table', ref: tableId, label });
  }, [tableId, label]);
  return (
    <div className={styles.full}>
      <header className={styles.fullHeader}>
        <Link to="/tables" className={styles.crumb}>
          Tables
        </Link>
        <ChevronRight size={14} aria-hidden />
        <h1 className={styles.fullTitle}>{label}</h1>
      </header>
      <div className={styles.fullBody}>
        <TableWorkspace tableId={tableId} full />
      </div>
    </div>
  );
}
