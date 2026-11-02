// The workspace pages: DI's view first, then the figures and records to check (spec 6.2). The server
// decides who sees what. Anything that changes data starts a task and waits on an approval card.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useMutation } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { BlockHostProvider, BlockRenderer } from '@dinext/blocks';
import { Button, Skeleton } from '@dinext/ui';
import type { AppEvent, AppView, AppViewId, QueryRun, SavedQueryView, SearchResult } from '@dinext/block-schemas';
import { ApiError } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { DiTake } from '../shell/DiTake.tsx';
import { useShellBlockHost } from '../shell/useShellBlockHost.ts';
import { useUi } from '../shell/uiStore.ts';
import page from './Page.module.css';
import styles from './AppViewPage.module.css';

function useView(app: AppViewId, path: string) {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['app', app], queryFn: () => api.appView(app) });
  const title = q.data?.title;
  useEffect(() => {
    if (title) useUi.getState().visit({ kind: 'view', path, label: title });
  }, [title, path]);
  return q;
}

function Prompts({ prompts }: { prompts: string[] }) {
  const { startThread } = useSession();
  const navigate = useNavigate();
  if (!prompts.length) return null;
  return (
    <ul className={styles.prompts} aria-label="Ask DI">
      {prompts.map((p) => (
        <li key={p}>
          <button type="button" className={page.prompt} onClick={() => void startThread(p).then((id) => navigate(`/c/${id}`))}>
            {p}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Frame({ q, children }: { q: ReturnType<typeof useView>; children: (v: AppView) => React.ReactNode }) {
  const v = q.data;
  return (
    <div className={page.page}>
      <header className={page.header}>
        <h1 className={page.title}>{v?.title ?? ' '}</h1>
        {v && <p className={page.lede}>{v.lede}</p>}
      </header>
      {q.isPending && <Skeleton height="320px" radius="md" />}
      {q.isError && (
        <p className={styles.message} role="alert">
          {q.error instanceof ApiError && q.error.status === 404 ? 'This isn’t available for your access or in this environment.' : 'This page could not be loaded. Try again in a moment.'}
        </p>
      )}
      {v && (
        <div className={styles.stack}>
          <DiTake take={v.take} />
          {v.notice && (
            <p className={styles.notice} role="note">
              {v.notice}
            </p>
          )}
          {v.tiles.length > 0 && (
            <ul className={styles.tiles}>
              {v.tiles.map((t) => (
                <li key={t.label} className={styles.tile}>
                  <span className={styles.tileLabel}>{t.label}</span>
                  <span className={t.tone === 'danger' ? styles.danger : t.tone === 'warning' ? styles.warning : styles.value}>{t.value}</span>
                  {t.detail && <span className={styles.tileLabel}>{t.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          {children(v)}
          <Prompts prompts={v.prompts} />
          {v.links?.map((l) => (
            <Link key={l.to} to={l.to} className={styles.link}>
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Blocks({ view }: { view: AppView }) {
  const host = useShellBlockHost({});
  return (
    <BlockHostProvider value={host}>
      {view.blocks.map((b) => (
        <BlockRenderer key={b.id} block={b} />
      ))}
    </BlockHostProvider>
  );
}

const PATHS: Partial<Record<AppViewId, string>> = { files: '/files', datalogs: '/datalogs', users: '/admin/users', admin: '/admin', workflows: '/workflows', seg: '/m/seg', callreport: '/m/callreport' };

export function AppViewPage({ app }: { app: AppViewId }) {
  const q = useView(app, PATHS[app] ?? `/${app}`);
  return <Frame q={q}>{(v) => <Blocks view={v} />}</Frame>;
}

// ---- calendar -----------------------------------------------------------------------------------

const monthName = (y: number, m: number) => new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m, 1));
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function Month({ events, today }: { events: AppEvent[]; today: string }) {
  const [shown, setShown] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const [day, setDay] = useState(today);
  const { startThread } = useSession();
  const navigate = useNavigate();
  const byDay = useMemo(() => {
    const map = new Map<string, AppEvent[]>();
    for (const e of events) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return map;
  }, [events]);
  const first = new Date(Date.UTC(shown.y, shown.m, 1)).getUTCDay();
  const days = new Date(Date.UTC(shown.y, shown.m + 1, 0)).getUTCDate();
  const move = (by: number) => setShown(({ y, m }) => ({ y: m + by < 0 ? y - 1 : m + by > 11 ? y + 1 : y, m: (m + by + 12) % 12 }));
  const chosen = byDay.get(day) ?? [];
  return (
    <section className={styles.calendar} aria-label="Calendar">
      <div className={styles.monthHead}>
        <h2 className={styles.heading}>{monthName(shown.y, shown.m)}</h2>
        <span className={styles.monthNav}>
          <button type="button" className={styles.nav} aria-label="Previous month" onClick={() => move(-1)}>
            <ChevronLeft size={16} aria-hidden />
          </button>
          <button type="button" className={styles.nav} aria-label="Next month" onClick={() => move(1)}>
            <ChevronRight size={16} aria-hidden />
          </button>
        </span>
      </div>
      <div className={styles.grid} role="group" aria-label={monthName(shown.y, shown.m)}>
        {WEEK.map((w) => (
          <span key={w} className={styles.weekday} aria-hidden>
            {w}
          </span>
        ))}
        {Array.from({ length: first }, (_, i) => (
          <span key={`blank${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const date = iso(shown.y, shown.m, i + 1);
          const items = byDay.get(date) ?? [];
          const late = items.some((e) => e.late);
          return (
            <button key={date} type="button" className={`${styles.day} ${date === day ? styles.chosen : ''} ${date === today ? styles.today : ''}`} aria-pressed={date === day} aria-label={`${date}, ${items.length} ${items.length === 1 ? 'item' : 'items'}`} onClick={() => setDay(date)}>
              <span>{i + 1}</span>
              {items.length > 0 && <span className={late ? styles.countLate : styles.count}>{items.length}</span>}
            </button>
          );
        })}
      </div>
      <h2 className={styles.heading}>{day}</h2>
      {chosen.length ? (
        <ul className={styles.agenda}>
          {chosen.map((e) => (
            <li key={`${e.kind}${e.title}`}>
              <button type="button" className={styles.event} onClick={() => void startThread(e.ask).then((id) => navigate(`/c/${id}`))}>
                <span className={e.late ? styles.danger : styles.tileLabel}>{e.late ? `Overdue · ${e.kind}` : e.kind}</span>
                <strong>{e.title}</strong>
                <span className={styles.tileLabel}>{e.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.tileLabel}>Nothing on this day.</p>
      )}
    </section>
  );
}

export function CalendarPage() {
  const q = useView('calendar', '/calendar');
  return <Frame q={q}>{(v) => <Month events={v.events ?? []} today={v.today ?? new Date().toISOString().slice(0, 10)} />}</Frame>;
}

// ---- queries ------------------------------------------------------------------------------------

function Editor({ saved }: { saved: SavedQueryView[] }) {
  const { api } = useSession();
  const [sql, setSql] = useState(saved[0]?.sql ?? '');
  const run = useMutation<QueryRun, Error, string>({ mutationFn: (s) => api.runQuery(s) });
  const host = useShellBlockHost({});
  return (
    <>
      <section className={styles.query} aria-label="Query editor">
        <label className={styles.heading} htmlFor="query-sql">
          SQL
        </label>
        <textarea id="query-sql" className={styles.sql} rows={8} spellCheck={false} value={sql} onChange={(e) => setSql(e.target.value)} />
        <p className={styles.tileLabel}>Read only. One SELECT, curated tables, no personal data columns, up to 500 rows.</p>
        <div>
          <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate(sql)}>
            {run.isPending ? 'Running…' : 'Run'}
          </Button>
        </div>
        {run.isError && (
          <p className={styles.message} role="alert">
            {run.error.message}
          </p>
        )}
      </section>
      {run.data && (
        <BlockHostProvider value={host}>
          <p className={styles.tileLabel} role="status">
            {run.data.statementType} on {run.data.tables.join(', ') || 'no tables'}. {run.data.rowCount} {run.data.rowCount === 1 ? 'row' : 'rows'}
            {run.data.truncated ? ', the first 500 shown' : ''}.
          </p>
          <BlockRenderer block={run.data.block} />
        </BlockHostProvider>
      )}
      <section aria-labelledby="saved-queries">
        <h2 id="saved-queries" className={styles.heading}>
          Saved queries
        </h2>
        <ul className={styles.saved}>
          {saved.map((s) => (
            <li key={s.name}>
              <button
                type="button"
                className={styles.event}
                onClick={() => {
                  setSql(s.sql);
                  run.reset();
                }}
              >
                <span className={styles.tileLabel}>{s.folder}</span>
                <strong>{s.name}</strong>
                <span className={styles.tileLabel}>{s.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function QueriesPage() {
  const q = useView('queries', '/queries');
  return <Frame q={q}>{(v) => <Editor saved={v.saved ?? []} />}</Frame>;
}

// ---- members ------------------------------------------------------------------------------------

function Finder({ who }: { who: string }) {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [found, setFound] = useState<{ q: string; results: SearchResult[] } | null>(null);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => api.search(q, ctrl.signal, 'member').then((results) => setFound({ q, results }), () => {}), 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, api]);
  const shown = text.trim().length >= 2 && found ? found : null;
  return (
    <section className={styles.query} aria-label={`Find a ${who}`}>
      <span className={styles.search}>
        <Search size={16} aria-hidden />
        <input className={styles.searchInput} type="search" aria-label={`Search ${who}s`} placeholder={`Search ${who}s by name`} value={text} onChange={(e) => setText(e.target.value)} />
      </span>
      {shown && (
        <ul className={styles.saved} aria-live="polite">
          {shown.results.map((r) => (
            <li key={r.id}>
              <Link to={r.link} className={styles.event}>
                <strong>{r.label}</strong>
                {r.detail && <span className={styles.tileLabel}>{r.detail}</span>}
              </Link>
            </li>
          ))}
          {!shown.results.length && <li className={styles.tileLabel}>No {who}s match “{shown.q}” in your purview.</li>}
        </ul>
      )}
    </section>
  );
}

export function MembersPage() {
  const q = useView('rm', '/members');
  const { terms } = useSession();
  return <Frame q={q}>{() => <Finder who={terms.person ?? 'member'} />}</Frame>;
}
