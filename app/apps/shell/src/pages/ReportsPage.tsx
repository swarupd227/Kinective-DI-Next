// Reports app (spec 8.5–8.9): the library by folder, the user's schedules with their last result,
// and a report page that runs a template with its controls. Building and changing reports happens
// in the conversation with the Report Builder; this view opens, runs and reviews them.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronRight, FileBarChart, ListTree, PlayCircle, Rows3, Search, Settings2, Sigma, Sparkles, Trash2 } from 'lucide-react';
import { KpiTiles } from '../shell/KpiTiles.tsx';
import { BlockHostProvider, BlockRenderer } from '@dinext/blocks';
import { Badge, Button, SegmentedControl, Skeleton, TextInput, useToast } from '@dinext/ui';
import { ApiError, type ReportsIndex } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { useShellBlockHost } from '../shell/useShellBlockHost.ts';
import { useUi } from '../shell/uiStore.ts';
import { useBreakpoint } from '../shell/useBreakpoint.ts';
import { DetailReports, OnDemandReports, TableSummary } from './ReportTypes.tsx';
import page from './Page.module.css';
import styles from './ReportsPage.module.css';

type Tab = 'library' | 'summary' | 'detail' | 'ondemand' | 'schedules' | 'bin';
const TABS: Tab[] = ['library', 'summary', 'detail', 'ondemand', 'schedules', 'bin'];

export function ReportsPage() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((t) => t === params.get('tab')) ?? 'library';
  const [filter, setFilter] = useState('');
  const q = useQuery({ queryKey: ['reports'], queryFn: () => api.reports() });

  const folders = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const items = (q.data?.templates ?? []).filter((t) => words.every((w) => `${t.name} ${t.folder} ${t.description}`.toLowerCase().includes(w)));
    const by = new Map<string, ReportsIndex['templates']>();
    for (const t of items) {
      const f = t.status === 'draft' ? 'My drafts' : t.folder;
      by.set(f, [...(by.get(f) ?? []), t]);
    }
    return [...by].sort(([a], [b]) => (a === 'My drafts' ? 1 : b === 'My drafts' ? -1 : a.localeCompare(b)));
  }, [q.data, filter]);

  // Building happens in a new task, where the composer is the page: the starting sentence waits there
  // to be finished, and nothing is sent until the user does. (In the bar at the foot of this long page,
  // it was easy to miss and type into "Find a report" instead.)
  const navigate = useNavigate();
  // The draft travels with the navigation, so this page's own bar doesn't take it on the way out.
  const build = (what = '') => navigate('/c/new', { state: { draft: `Build me a monthly report with ${what}` } });

  return (
    <div className={page.page}>
      <header className={page.header}>
        <div className={page.headerRow}>
          <h1 className={page.title}>Reports</h1>
          <Button variant="primary" icon={<Sparkles size={16} aria-hidden />} onClick={() => build()}>
            Build a report
          </Button>
        </div>
        <p className={page.lede}>Standard and saved reports, run on the latest build and limited to your access. Ask DI to build or change one, or to send it to you on a schedule.</p>
        <SegmentedControl
          label="Reports view"
          value={tab}
          onChange={(v) => setParams(v === 'library' ? {} : { tab: v })}
          options={[
            { value: 'library', label: 'Periodic', icon: <FileBarChart size={14} aria-hidden /> },
            { value: 'summary', label: 'Table Summary', icon: <Sigma size={14} aria-hidden /> },
            { value: 'detail', label: 'Detail', icon: <Rows3 size={14} aria-hidden /> },
            { value: 'ondemand', label: 'On-Demand', icon: <ListTree size={14} aria-hidden /> },
            { value: 'schedules', label: `Schedules${q.data?.schedules.length ? ` (${q.data.schedules.length})` : ''}`, icon: <CalendarClock size={14} aria-hidden /> },
            { value: 'bin', label: `Recycle Bin${q.data?.bin?.length ? ` (${q.data.bin.length})` : ''}`, icon: <Trash2 size={14} aria-hidden /> },
          ]}
        />
      </header>

      {q.isPending && (tab === 'library' || tab === 'schedules') && <Skeleton height="200px" radius="md" />}
      {q.isError && (
        <p className={styles.message} role="alert">
          {q.error instanceof ApiError && q.error.status === 404 ? 'Reports are not loaded in this environment. Run npm run db:seed, then restart the server.' : 'Reports could not be loaded. Try again in a moment.'}
        </p>
      )}

      {q.data && tab === 'library' && (
        <>
          <TextInput
            label="Find a report"
            hideLabel
            placeholder="Find a report"
            leading={<Search size={14} aria-hidden />}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            // Enter on a search that finds nothing is someone describing a report: offer to build it.
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !folders.length && filter.trim()) build(filter.trim());
            }}
            className={styles.filter}
          />
          {folders.length === 0 && (
            <p className={styles.message}>
              No reports match “{filter.trim()}”.{' '}
              <button type="button" className={styles.linkButton} onClick={() => build(filter.trim())}>
                Build a report with {filter.trim()}
              </button>
            </p>
          )}
          {folders.map(([folder, items]) => (
            <section key={folder} className={styles.folder} aria-labelledby={`f-${folder}`}>
              <h2 id={`f-${folder}`} className={styles.folderTitle}>
                {folder}
              </h2>
              <ul className={styles.list}>
                {items.map((t) => (
                  <li key={t.templateId}>
                    <Link to={`/reports/${t.templateId}`} className={styles.item}>
                      <FileBarChart size={18} aria-hidden className={styles.icon} />
                      <span className={styles.text}>
                        <span className={styles.label}>
                          {t.name}
                          {t.status === 'draft' && <Badge tone="warning">Draft</Badge>}
                          {t.onHome && <Badge tone="info">On Home</Badge>}
                        </span>
                        <span className={styles.detail}>{t.description || `${t.sections} sections`}</span>
                        <span className={styles.meta}>
                          {t.periodType === 'month' ? 'Monthly' : 'Quarterly'} · {t.sections} sections{t.origin ? ` · ${t.origin}` : t.status === 'stock' ? ' · Standard report' : ` · ${t.owner}`}
                        </span>
                      </span>
                      <ChevronRight size={16} aria-hidden className={styles.icon} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className={styles.hint}>
            <button type="button" className={styles.linkButton} onClick={() => build()}>
              Describe a report to build
            </button>{' '}
            or try “Build me a monthly ALCO pack with loan balance trend, deposit mix and delinquency ratio”.
          </p>
        </>
      )}

      {tab === 'summary' && <TableSummary />}
      {tab === 'detail' && <DetailReports />}
      {tab === 'ondemand' && <OnDemandReports />}
      {q.data && tab === 'schedules' && <Schedules schedules={q.data.schedules} />}
      {q.data && tab === 'bin' && <RecycleBin items={q.data.bin ?? []} />}
    </div>
  );
}

/** Reports you deleted. Nothing is erased; restoring is a request to DI, approved on a card. */
function RecycleBin({ items }: { items: NonNullable<ReportsIndex['bin']> }) {
  if (!items.length) return <p className={styles.message}>Your Recycle Bin is empty. A report you delete waits here until you restore it.</p>;
  return (
    <ul className={styles.list}>
      {items.map((t) => (
        <li key={t.templateId}>
          <Link to={`/c/new?q=${encodeURIComponent(`Restore the ${t.name} report`)}`} className={styles.item}>
            <Trash2 size={18} aria-hidden className={styles.icon} />
            <span className={styles.text}>
              <span className={styles.label}>{t.name}</span>
              <span className={styles.meta}>
                From {t.folder} · deleted {new Date(t.deletedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}
              </span>
            </span>
            <span className={styles.meta}>Ask DI to restore</span>
            <ChevronRight size={16} aria-hidden className={styles.icon} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Schedules({ schedules }: { schedules: ReportsIndex['schedules'] }) {
  const { api } = useSession();
  const client = useQueryClient();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  // Local stand-in for the after-build trigger, so the last-result column can be seen working.
  const runNow = async () => {
    setRunning(true);
    try {
      await api.runSchedules();
      await client.invalidateQueries({ queryKey: ['reports'] });
      await client.invalidateQueries({ queryKey: ['home'] });
      toast.show('Schedules ran as they will after tonight’s build');
    } finally {
      setRunning(false);
    }
  };
  if (!schedules.length) return <p className={styles.message}>You have no scheduled reports. Open a report and choose Schedule, or say “send this to me every Monday”.</p>;
  return (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="dn-visually-hidden">Your scheduled reports</caption>
          <thead>
            <tr>
              <th scope="col">Report</th>
              <th scope="col">When</th>
              <th scope="col">Format</th>
              <th scope="col">Recipients</th>
              <th scope="col">Last result</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.scheduleId}>
                <th scope="row">
                  <Link to={`/reports/${s.templateId}`}>{s.report}</Link>
                  <span className={styles.detail}>#{s.scheduleId}</span>
                </th>
                <td>{s.when}</td>
                <td>{s.format}</td>
                <td className="dn-num">{s.recipients}</td>
                <td>
                  {s.lastResult ? <Badge tone={s.lastResult === 'failed' ? 'danger' : s.lastResult === 'empty' ? 'neutral' : 'success'}>{s.lastResult === 'failed' ? 'Failed' : s.lastResult === 'empty' ? 'No data' : 'Ran'}</Badge> : <Badge tone="info">Not run yet</Badge>}
                  {s.lastDetail && <span className={styles.detail}>{s.lastDetail}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.hint}>
        Schedules run after each nightly build. To stop one, ask DI “stop the {schedules[0]!.report} schedule”.{' '}
        <Button size="sm" variant="ghost" icon={<PlayCircle size={14} aria-hidden />} busy={running} onClick={() => void runNow()}>
          Run tonight’s schedules now (demo)
        </Button>
      </p>
    </>
  );
}

/** Report settings, read-only: what's in use, with today's DI Build Reports fields DI Next doesn't use folded away. */
function ReportSettings({ templateId }: { templateId: string }) {
  const { api, startThread } = useSession();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['report-settings', templateId], queryFn: () => api.reportSettings(templateId), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1 });
  if (q.isPending) return <Skeleton height="320px" radius="md" />;
  if (q.isError) return <p className={styles.message} role="alert">{q.error instanceof ApiError && q.error.status === 404 ? 'This report was not found, or it is outside your access.' : 'The settings could not be loaded. Try again in a moment.'}</p>;
  const v = q.data;
  // What matters comes first; today's DI fields that DI Next doesn't use fold away, and a field that
  // appears in two groups (Report ID) is shown once.
  const seen = new Set<string>();
  const inUse = v.groups.map((g) => ({ ...g, fields: g.fields.filter((f) => f.used && !seen.has(f.label) && seen.add(f.label)) })).filter((g) => g.fields.length > 0);
  const classic = v.groups.flatMap((g) => g.fields.filter((f) => !f.used && !seen.has(f.label) && seen.add(f.label)).map((f) => ({ ...f, group: g.title })));
  return (
    <section className={styles.summary} aria-label={`${v.name} settings`}>
      <KpiTiles label="Settings at a glance" tiles={v.tiles.map((t) => ({ label: t.label, value: t.value, detail: t.detail, tone: t.tone === 'warning' || t.tone === 'danger' ? t.tone : 'neutral' }))} />
      <p className={styles.message}>
        {v.changeNote}
        {v.lastChange ? ` ${v.lastChange}.` : ''}
      </p>
      {v.prompts.length > 0 && (
        <ul className={page.prompts} aria-label="Ask DI">
          {v.prompts.map((p) => (
            <li key={p}>
              <button type="button" className={page.prompt} onClick={() => void startThread(p, [{ type: 'report', ref: `report:${v.templateId}`, label: v.name }]).then((id) => navigate(`/c/${id}`))}>
                {p}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.settingsGrid}>
        {inUse.map((g) => (
          <section key={g.id} className={styles.settingsGroup} aria-labelledby={`set-${g.id}`}>
            <h2 id={`set-${g.id}`} className={styles.folderTitle}>
              {g.title}
            </h2>
            <dl className={styles.settingsList}>
              {g.fields.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      {classic.length > 0 && (
        <details className={styles.settingsGroup}>
          <summary className={styles.folderTitle}>Classic DI fields ({classic.length})</summary>
          <p className={styles.hint}>Today’s DI form has these too. DI Next doesn’t use them, so they’re kept here for comparison only.</p>
          <dl className={styles.settingsList}>
            {classic.map((f) => (
              <div key={`${f.group}:${f.label}`}>
                <dt>
                  {f.label} <span className={styles.detail}>{f.group}</span>
                </dt>
                <dd className={styles.notUsed}>{f.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <p className={styles.hint}>The classic Start Building Report, Reset, Review, Add Field and Edit Form Layout buttons aren’t needed: ask DI, and approve the change on its card.</p>
    </section>
  );
}

export function ReportPage() {
  const { templateId = '' } = useParams();
  const { api } = useSession();
  const host = useShellBlockHost();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'settings' ? 'settings' : 'report';
  const q = useQuery({ queryKey: ['report', templateId], queryFn: () => api.runReport(templateId), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1, enabled: view === 'report' });
  const name = q.data?.data.name;
  const bp = useBreakpoint();
  const wide = bp === 'desktop' || bp === 'laptop';
  useEffect(() => {
    if (name) useUi.getState().visit({ kind: 'view', path: `/reports/${templateId}`, label: name });
  }, [name, templateId]);
  return (
    <div className={page.page}>
      {/* On wider screens the top bar carries the trail; smaller ones only show the page name there. */}
      {!wide && (
        <nav className={styles.crumbs} aria-label="Breadcrumb">
          <Link to="/reports">Reports</Link>
          <ChevronRight size={14} aria-hidden />
          <span aria-current="page">{name ?? 'Report'}</span>
        </nav>
      )}
      <SegmentedControl
        label="Report view"
        value={view}
        onChange={(v) => setParams(v === 'report' ? {} : { view: v })}
        options={[
          { value: 'report', label: 'Report', icon: <FileBarChart size={14} aria-hidden /> },
          { value: 'settings', label: 'Settings', icon: <Settings2 size={14} aria-hidden /> },
        ]}
      />
      {view === 'settings' && <ReportSettings templateId={templateId} />}
      {view === 'report' && q.isPending && <Skeleton height="420px" radius="md" />}
      {view === 'report' && q.isError && (
        <p className={styles.message} role="alert">
          {q.error instanceof ApiError && q.error.status === 404 ? 'This report was not found, it is outside your access, or it is turned off. Its owner can check Settings.' : 'The report could not be run. Try again in a moment.'}
        </p>
      )}
      {view === 'report' && q.data && (
        <BlockHostProvider value={host}>
          <BlockRenderer block={q.data} />
        </BlockHostProvider>
      )}
    </div>
  );
}
