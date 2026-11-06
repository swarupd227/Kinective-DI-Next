// The workspace pages: DI's view first, then the figures and records to check (spec 6.2). The server
// decides who sees what. Anything that changes data starts a task and waits on an approval card.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, Search } from 'lucide-react';
import { BlockHostProvider, BlockRenderer, formatDay } from '@dinext/blocks';
import { Button, Skeleton } from '@dinext/ui';
import type { AppEvent, AppFile, AppView, AppViewId, QueryRun, SavedQueryView, SearchResult } from '@dinext/block-schemas';
import { ApiError } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { DiTake } from '../shell/DiTake.tsx';
import { KpiTiles } from '../shell/KpiTiles.tsx';
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

export function Prompts({ prompts }: { prompts: string[] }) {
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
        {v?.downloads?.length ? (
          <ul className={styles.downloads} aria-label="Downloads">
            {v.downloads.map((d) => (
              <li key={d.href}>
                <a className={styles.download} href={d.href} download title={d.detail}>
                  <Download size={16} aria-hidden />
                  {d.label}
                </a>
                {d.detail && <span className={styles.downloadDetail}>{d.detail}</span>}
              </li>
            ))}
          </ul>
        ) : null}
      </header>
      {q.isPending && <Skeleton height="320px" radius="md" />}
      {q.isError && (
        <p className={styles.message} role="alert">
          {q.error instanceof ApiError && q.error.status === 404 ? 'This isn’t available for your access or in this environment.' : 'This page could not be loaded. Try again in a moment.'}
        </p>
      )}
      {v && (
        <div className={styles.stack}>
          <DiTake take={v.take} more={v.prompts} />
          {v.notice && (
            <p className={styles.notice} role="note">
              {v.notice}
            </p>
          )}
          <KpiTiles tiles={v.tiles.map((t) => ({ label: t.label, value: t.value, detail: t.detail, ask: t.ask, tone: t.tone === 'danger' || t.tone === 'warning' ? t.tone : 'neutral' }))} />
          {children(v)}
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

/** Charts, short lists and narrow tables sit side by side when there are two or more; wide tables take the row. */
const half = (b: AppView['blocks'][number]) => b.type === 'chart' || b.type === 'list' || b.type === 'kpi' || (b.type === 'table' && b.data.columns.length <= 4);

export function Blocks({ view }: { view: AppView }) {
  const host = useShellBlockHost({});
  const halves = view.blocks.filter(half).length;
  return (
    <BlockHostProvider value={host}>
      <div className={styles.dashboard}>
        {view.blocks.map((b) => (
          <div key={b.id} className={halves > 1 && half(b) ? styles.half : styles.full}>
            <BlockRenderer block={b} />
          </div>
        ))}
      </div>
    </BlockHostProvider>
  );
}

const PATHS: Partial<Record<AppViewId, string>> = { files: '/files', datalogs: '/datalogs', users: '/admin/users', admin: '/admin', workflows: '/workflows', seg: '/m/seg', callreport: '/m/callreport', indirect: '/m/indirect', prospecting: '/m/prospecting', campaigns: '/m/campaigns', onboarding: '/m/onboarding', compliance: '/m/compliance', predictive: '/m/predictive', dq: '/dq', tasks: '/tasks', integrations: '/integrations', classes: '/admin/classes', wfbuilder: '/workflows/builder' };

export function AppViewPage({ app }: { app: AppViewId }) {
  const q = useView(app, PATHS[app] ?? `/${app}`);
  return (
    <Frame q={q}>
      {(v) => (
        <>
          {app === 'integrations' && (
            <>
              <ConnectSource />
              <DataUpload />
            </>
          )}
          <Blocks view={v} />
        </>
      )}
    </Frame>
  );
}

const DATA_ACCEPT = '.csv,.txt,.xlsx';

/**
 * Upload a data file (Integrations > Files): the file is staged, then DI reads it, matches it to a
 * table and prepares a card that says exactly what will load. Nothing loads until it's approved.
 */
function DataUpload() {
  const { api, startThread } = useSession();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [into, setInto] = useState('');
  const [as, setAs] = useState<'table' | 'offcore'>('table');
  const load = useMutation<void, Error, { file: File; into: string; as: 'table' | 'offcore' }>({
    mutationFn: async (u) => {
      if (u.file.size > MAX_BYTES) throw new Error(`That file is ${(u.file.size / 1024 / 1024).toFixed(1)} MB. Data files can be up to 5 MB.`);
      const staged = await api.stageFile({ name: u.file.name, data: await base64(u.file) });
      const table = u.into.trim();
      const id = await startThread(u.as === 'offcore' ? `Load “${staged.name}” as off-core loans` : table ? `Load “${staged.name}” into the ${table} table` : `Load “${staged.name}”`);
      navigate(`/c/${id}`);
    },
  });
  // The demo servicer spreadsheet, staged as though it had been uploaded.
  const demo = useMutation<void, Error, void>({
    mutationFn: async () => {
      const staged = await api.stageDemoOffcore();
      const id = await startThread(`Load “${staged.name}” as off-core loans`);
      navigate(`/c/${id}`);
    },
  });
  return (
    <section className={styles.query} aria-labelledby="data-upload">
      <h2 id="data-upload" className={styles.heading}>
        Upload a data file
      </h2>
      <div className={styles.uploadRow}>
        <label className={styles.field}>
          <span className={styles.tileLabel}>CSV or Excel file</span>
          <input
            type="file"
            accept={DATA_ACCEPT}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              load.reset();
            }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.tileLabel}>Load as</span>
          <select className={styles.select} value={as} onChange={(e) => setAs(e.target.value as 'table' | 'offcore')}>
            <option value="table">A table of my own</option>
            <option value="offcore">Off-core loans (participations, purchased pools)</option>
          </select>
        </label>
        {as === 'table' && (
          <label className={styles.field}>
            <span className={styles.tileLabel}>Into (optional)</span>
            <input className={styles.select} value={into} onChange={(e) => setInto(e.target.value)} placeholder="New table" />
          </label>
        )}
      </div>
      <p className={styles.tileLabel}>
        {as === 'offcore'
          ? 'For loans your core doesn’t carry, from a servicer’s monthly spreadsheet. DI matches the columns to its loan fields, places each loan type in one of your categories and says which rows won’t load. Once approved, the loans are in every loan figure, tagged with their source; next month’s file replaces this one.'
          : 'DI reads every row, says what each column holds and what won’t load, and prepares a card. Nothing is loaded until you approve. Up to 5 MB and 5,000 rows, with a header row.'}
      </p>
      <div className={styles.uploadRow}>
        <Button variant="primary" disabled={!file || load.isPending} onClick={() => file && load.mutate({ file, into, as })}>
          {load.isPending ? 'Uploading…' : 'Upload and ask DI to load it'}
        </Button>
        {as === 'offcore' && (
          <Button variant="secondary" disabled={demo.isPending} onClick={() => demo.mutate()}>
            {demo.isPending ? 'Staging…' : 'Use the demo servicer file'}
          </Button>
        )}
      </div>
      {(load.isError || demo.isError) && (
        <p className={styles.message} role="alert">
          {(load.error ?? demo.error)!.message}
        </p>
      )}
    </section>
  );
}

// ---- connect a source ---------------------------------------------------------------------------

const CORES = [
  { id: 'symitar', label: 'Jack Henry Symitar' },
  { id: 'dna', label: 'Fiserv DNA' },
  { id: 'keystone', label: 'Corelation KeyStone' },
  { id: 'premier', label: 'Fiserv Premier' },
  { id: 'other', label: 'Another MySQL database' },
];
const KINDS = [
  { id: 'database', label: 'Core database' },
  { id: 'sftp', label: 'SFTP folder' },
  { id: 'api', label: 'Vendor API' },
] as const;
const EMPTY_LOGIN = { system: 'symitar', host: '', port: '3306', database: '', login: '', password: '' };

/**
 * Connect a source (Integrations > Databases): one place for every way data arrives. For a core
 * database the person enters the replica and a read-only login; the password goes to DI Core, which
 * keeps it encrypted, and DI's agent only ever sees its number. DI then tests it, proves it can't
 * write, and proposes the mapping. Nothing is connected until the card is approved.
 */
function ConnectSource() {
  const { api, startThread } = useSession();
  const navigate = useNavigate();
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('database');
  const [f, setF] = useState(EMPTY_LOGIN);
  const demo = useQuery({ queryKey: ['sources', 'demo'], queryFn: () => api.demoSource(), staleTime: Infinity });
  const set = (k: keyof typeof EMPTY_LOGIN) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const test = useMutation<void, Error, typeof EMPTY_LOGIN>({
    mutationFn: async (v) => {
      const saved = await api.saveSourceLogin({ ...v, port: Number(v.port) });
      setF((x) => ({ ...x, password: '' }));
      const id = await startThread(`Test the connection to the ${saved.system} replica (connection details #${saved.credentialId})`);
      navigate(`/c/${id}`);
    },
  });
  const ready = f.host.trim() && f.database.trim() && f.login.trim() && f.password && Number(f.port) > 0;
  return (
    <section className={styles.query} aria-labelledby="connect-source">
      <h2 id="connect-source" className={styles.heading}>
        Connect a source
      </h2>
      <div className={styles.choices} role="radiogroup" aria-label="How the data arrives">
        {KINDS.map((k) => (
          <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={kind === k.id ? styles.choiceOn : styles.choice} onClick={() => setKind(k.id)}>
            {k.label}
          </button>
        ))}
      </div>
      {kind === 'database' ? (
        <form
          className={styles.query}
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) test.mutate(f);
          }}
        >
          <div className={styles.loginGrid}>
            <label className={styles.field}>
              <span className={styles.tileLabel}>Core system</span>
              <select className={styles.select} value={f.system} onChange={set('system')}>
                {CORES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.tileLabel}>Replica host</span>
              <input className={styles.select} value={f.host} onChange={set('host')} placeholder="replica.core.example.org" autoComplete="off" spellCheck={false} />
            </label>
            <label className={styles.field}>
              <span className={styles.tileLabel}>Port</span>
              <input className={styles.select} value={f.port} onChange={set('port')} inputMode="numeric" autoComplete="off" />
            </label>
            <label className={styles.field}>
              <span className={styles.tileLabel}>Database</span>
              <input className={styles.select} value={f.database} onChange={set('database')} autoComplete="off" spellCheck={false} />
            </label>
            <label className={styles.field}>
              <span className={styles.tileLabel}>Read-only login</span>
              <input className={styles.select} value={f.login} onChange={set('login')} autoComplete="off" spellCheck={false} />
            </label>
            <label className={styles.field}>
              <span className={styles.tileLabel}>Password</span>
              <input className={styles.select} type="password" value={f.password} onChange={set('password')} autoComplete="new-password" />
            </label>
          </div>
          <p className={styles.tileLabel}>DI tests the login, checks it can only read, and proposes how the core’s tables map to DI’s. Nothing connects until you approve. The password is encrypted, never shown again, and never seen by DI’s agents.</p>
          <div className={styles.uploadRow}>
            <Button type="submit" variant="primary" disabled={!ready || test.isPending}>
              {test.isPending ? 'Saving…' : 'Test it and ask DI to connect it'}
            </Button>
            {demo.data && (
              <Button type="button" variant="secondary" onClick={() => setF({ system: demo.data!.system, host: demo.data!.host, port: String(demo.data!.port), database: demo.data!.database, login: demo.data!.login, password: demo.data!.password })}>
                Fill in the demo replica
              </Button>
            )}
          </div>
          {test.isError && (
            <p className={styles.message} role="alert">
              {test.error.message}
            </p>
          )}
        </form>
      ) : kind === 'api' ? (
        <ConnectApi />
      ) : (
        <p className={styles.notice} role="note">
          SFTP folders are set up by Kinective today. They’ll join this flow next: DI checks the first file, proposes the mapping and the late-file time, and connects it when you approve.
        </p>
      )}
    </section>
  );
}

const AUTH_KINDS = [
  { id: 'api_key', label: 'API key' },
  { id: 'basic', label: 'Basic credentials' },
  { id: 'session_token', label: 'Session token' },
  { id: 'oauth', label: 'OAuth' },
];
const EMPTY_API = { platform: 'relay', kind: 'api_key', label: '', placement: 'X-Api-Key', username: '', secret: '' };

/**
 * Connect a vendor API (Integrations > APIs). The person picks the platform and enters its key; the
 * key goes to DI Core, which seals it, and DI's agent only ever sees its number. DI then calls the
 * platform once, read-only, and proposes the connection and its saved requests for approval.
 */
function ConnectApi() {
  const { api, startThread } = useSession();
  const navigate = useNavigate();
  const [f, setF] = useState(EMPTY_API);
  const demo = useQuery({ queryKey: ['apis', 'demo'], queryFn: () => api.demoApi(), staleTime: Infinity });
  const set = (k: keyof typeof EMPTY_API) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation<void, Error, typeof EMPTY_API>({
    mutationFn: async (v) => {
      const saved = await api.saveApiLogin({ kind: v.kind, label: v.label.trim() || 'Relay Marketing key', placement: v.kind === 'api_key' ? v.placement : undefined, username: v.username || undefined, secret: v.secret });
      setF((x) => ({ ...x, secret: '' }));
      const id = await startThread(`Test the Relay Marketing API (API details #${saved.credentialId})`);
      navigate(`/c/${id}`);
    },
  });
  const needsUser = f.kind !== 'api_key';
  const ready = f.secret && (!needsUser || f.username.trim()) && (f.kind !== 'api_key' || f.placement.trim());
  return (
    <form
      className={styles.query}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save.mutate(f);
      }}
    >
      <div className={styles.loginGrid}>
        <label className={styles.field}>
          <span className={styles.tileLabel}>Platform</span>
          <select className={styles.select} value={f.platform} onChange={set('platform')}>
            <option value="relay">Relay Marketing (demo platform)</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.tileLabel}>Signs in with</span>
          <select className={styles.select} value={f.kind} onChange={set('kind')}>
            {AUTH_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.tileLabel}>Name for these details</span>
          <input className={styles.select} value={f.label} onChange={set('label')} placeholder="Relay Marketing key" autoComplete="off" />
        </label>
        {f.kind === 'api_key' ? (
          <label className={styles.field}>
            <span className={styles.tileLabel}>Header</span>
            <input className={styles.select} value={f.placement} onChange={set('placement')} autoComplete="off" spellCheck={false} />
          </label>
        ) : (
          <label className={styles.field}>
            <span className={styles.tileLabel}>{f.kind === 'oauth' ? 'Client ID' : 'User name'}</span>
            <input className={styles.select} value={f.username} onChange={set('username')} autoComplete="off" spellCheck={false} />
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.tileLabel}>{f.kind === 'api_key' ? 'API key' : f.kind === 'oauth' ? 'Client secret' : 'Password'}</span>
          <input className={styles.select} type="password" value={f.secret} onChange={set('secret')} autoComplete="new-password" />
        </label>
      </div>
      <p className={styles.tileLabel}>DI calls the platform once, read-only, to check the sign-in, then proposes the connection and its saved requests. Nothing connects until you approve. The key is encrypted, never shown again, kept out of the request log, and never seen by DI’s agents.</p>
      <div className={styles.uploadRow}>
        <Button type="submit" variant="primary" disabled={!ready || save.isPending}>
          {save.isPending ? 'Saving…' : 'Test it and ask DI to connect it'}
        </Button>
        {demo.data && (
          <Button type="button" variant="secondary" onClick={() => setF({ platform: demo.data!.platform, kind: demo.data!.kind, label: demo.data!.label, placement: demo.data!.placement, username: '', secret: demo.data!.secret })}>
            Fill in the demo platform
          </Button>
        )}
      </div>
      {save.isError && (
        <p className={styles.message} role="alert">
          {save.error.message}
        </p>
      )}
    </form>
  );
}

// ---- email notifications ------------------------------------------------------------------------

/** My simulated outbox and preferences. Changes are asked of DI; the button runs this morning's job locally. */
export function EmailsPage() {
  const q = useView('emails', '/settings/email');
  const { api } = useSession();
  const client = useQueryClient();
  const morning = useMutation<{ emails: number }, Error, void>({ mutationFn: () => api.runMorningEmails(), onSuccess: () => void client.invalidateQueries({ queryKey: ['app', 'emails'] }) });
  return (
    <Frame q={q}>
      {(v) => (
        <>
          <Blocks view={v} />
          <p className={styles.tileLabel} role="status">
            <Button size="sm" variant="ghost" busy={morning.isPending} onClick={() => morning.mutate()}>
              Send this morning’s emails now (demo)
            </Button>{' '}
            {morning.data ? `${morning.data.emails} new ${morning.data.emails === 1 ? 'email' : 'emails'} across your institution: follow-up reminders and digests, for those who want them.` : 'Follow-up reminders and digests go out once each morning.'}
          </p>
        </>
      )}
    </Frame>
  );
}

// ---- calendar -----------------------------------------------------------------------------------

/** "25 Oct 2026", as dates read everywhere else in DI; anything that isn't an ISO date shows as it is. */
const longDay = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? formatDay(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : iso);
/** 1 KB, 212 KB, 4.1 MB. */
const fileSize = (kb: number) => (kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toLocaleString('en-US')} KB`);
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
              <span className={styles.dayHead}>
                <span>{i + 1}</span>
                {items.length > 0 && <span className={late ? styles.countLate : styles.count}>{items.length}</span>}
              </span>
              {/* The month says what's on each day: the first two, then how many more. */}
              {items.slice(0, 2).map((e) => (
                <span key={`${e.kind}${e.title}`} className={e.late ? styles.dayItemLate : styles.dayItem} aria-hidden>
                  {e.title}
                </span>
              ))}
              {items.length > 2 && (
                <span className={styles.dayMore} aria-hidden>
                  +{items.length - 2} more
                </span>
              )}
            </button>
          );
        })}
      </div>
      <h2 className={styles.heading}>{longDay(day)}</h2>
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

// ---- files --------------------------------------------------------------------------------------

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt';
const MAX_BYTES = 5 * 1024 * 1024;

/** The file's bytes as base64, without the data URL prefix. */
const base64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('That file could not be read.'));
    r.readAsDataURL(file);
  });

/** Uploading stages the file; DI then prepares the card that saves it. The server checks type and size again. */
function Upload({ folders }: { folders: string[] }) {
  const { api, startThread } = useSession();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [folder, setFolder] = useState(folders[0] ?? '');
  const stage = useMutation<void, Error, { file: File; folder: string }>({
    mutationFn: async (u) => {
      if (u.file.size > MAX_BYTES) throw new Error(`That file is ${(u.file.size / 1024 / 1024).toFixed(1)} MB. Files can be up to 5 MB.`);
      const staged = await api.stageFile({ name: u.file.name, data: await base64(u.file) });
      const id = await startThread(`Save “${staged.name}” to the ${u.folder} folder`);
      navigate(`/c/${id}`);
    },
  });
  if (!folders.length) return null;
  return (
    <section className={styles.query} aria-labelledby="upload-file">
      <h2 id="upload-file" className={styles.heading}>
        Upload a file
      </h2>
      <div className={styles.uploadRow}>
        {/* The browser's own file control, hidden behind a button that matches the page. */}
        <div className={styles.field}>
          <span className={styles.tileLabel}>File</span>
          <span className={styles.pickRow}>
            <label className={styles.picker}>
              <input
                type="file"
                accept={ACCEPT}
                className={styles.pickInput}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  stage.reset();
                }}
              />
              {file ? 'Choose another file' : 'Choose a file'}
            </label>
            <span className={styles.tileLabel}>{file ? `${file.name}, ${(file.size / 1024 / 1024).toFixed(1)} MB` : 'No file chosen'}</span>
          </span>
        </div>
        <label className={styles.field}>
          <span className={styles.tileLabel}>Save to</span>
          <select className={styles.select} value={folder} onChange={(e) => setFolder(e.target.value)}>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={styles.tileLabel}>PDF, images, Office, CSV or text, up to 5 MB. DI prepares a card to save it, and nothing is saved until you approve.</p>
      <div>
        <Button variant="primary" disabled={!file || stage.isPending} onClick={() => file && stage.mutate({ file, folder })}>
          {stage.isPending ? 'Uploading…' : 'Upload and ask DI to save it'}
        </Button>
      </div>
      {stage.isError && (
        <p className={styles.message} role="alert">
          {stage.error.message}
        </p>
      )}
    </section>
  );
}

function FileList({ files }: { files: AppFile[] }) {
  return (
    <section aria-labelledby="all-files">
      <h2 id="all-files" className={styles.heading}>
        All files
      </h2>
      {files.length ? (
        <ul className={styles.saved}>
          {files.map((f) => (
            <li key={`${f.folder}/${f.name}/${f.download ?? ''}`} className={styles.file}>
              <span className={styles.tileLabel}>
                {f.folder} · {f.type} · {fileSize(f.sizeKb)}
              </span>
              <strong>{f.name}</strong>
              <span className={styles.tileLabel}>
                {f.owner}, {longDay(f.modified)}
              </span>
              {f.download ? (
                <a className={styles.link} href={f.download} download={f.name}>
                  Download
                </a>
              ) : (
                <span className={styles.tileLabel}>Sample: listed only</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.tileLabel}>There are no files in your folders yet.</p>
      )}
    </section>
  );
}

export function FilesPage() {
  const q = useView('files', '/files');
  return (
    <Frame q={q}>
      {(v) => (
        <>
          <Upload folders={v.folders ?? []} />
          <FileList files={v.files ?? []} />
          <Blocks view={v} />
        </>
      )}
    </Frame>
  );
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
  return (
    <Frame q={q}>
      {(v) => (
        <>
          <Finder who={terms.person ?? 'member'} />
          <Blocks view={v} />
        </>
      )}
    </Frame>
  );
}
