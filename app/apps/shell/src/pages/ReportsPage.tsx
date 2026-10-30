// Reports app (spec 8.5–8.9): the library by folder, the user's schedules with their last result,
// and a report page that runs a template with its controls. Building and changing reports happens
// in the conversation with the Report Builder; this view opens, runs and reviews them.
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronRight, FileBarChart, PlayCircle, Search, Sparkles } from 'lucide-react';
import { BlockHostProvider, BlockRenderer } from '@dinext/blocks';
import { Badge, Button, SegmentedControl, Skeleton, TextInput, useToast } from '@dinext/ui';
import { ApiError, type ReportsIndex } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { useShellBlockHost } from '../shell/useShellBlockHost.ts';
import { useUi } from '../shell/uiStore.ts';
import page from './Page.module.css';
import styles from './ReportsPage.module.css';

type Tab = 'library' | 'schedules';

export function ReportsPage() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'schedules' ? 'schedules' : 'library';
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

  // The composer gets a starting sentence to finish; nothing is sent until the user does.
  const build = () => useUi.getState().setPrefill('Build me a monthly report with ');

  return (
    <div className={page.page}>
      <header className={page.header}>
        <div className={page.headerRow}>
          <h1 className={page.title}>Reports</h1>
          <Button variant="primary" icon={<Sparkles size={16} aria-hidden />} onClick={build}>
            Build a report
          </Button>
        </div>
        <p className={page.lede}>Standard and saved reports, run on last night’s build and limited to your access. Ask DI to build or change one, or to send it to you on a schedule.</p>
        <SegmentedControl
          label="Reports view"
          value={tab}
          onChange={(v) => setParams(v === 'schedules' ? { tab: 'schedules' } : {})}
          options={[
            { value: 'library', label: 'Library', icon: <FileBarChart size={14} aria-hidden /> },
            { value: 'schedules', label: `Schedules${q.data?.schedules.length ? ` (${q.data.schedules.length})` : ''}`, icon: <CalendarClock size={14} aria-hidden /> },
          ]}
        />
      </header>

      {q.isPending && <Skeleton height="200px" radius="md" />}
      {q.isError && (
        <p className={styles.message} role="alert">
          {q.error instanceof ApiError && q.error.status === 404 ? 'Reports are not loaded in this environment. Run npm run db:seed, then restart the server.' : 'Reports could not be loaded. Try again in a moment.'}
        </p>
      )}

      {q.data && tab === 'library' && (
        <>
          <TextInput label="Find a report" hideLabel placeholder="Find a report" leading={<Search size={14} aria-hidden />} value={filter} onChange={(e) => setFilter(e.target.value)} className={styles.filter} />
          {folders.length === 0 && <p className={styles.message}>No reports match. Try other words, or ask DI to build one.</p>}
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
            <button type="button" className={styles.linkButton} onClick={build}>
              Describe a report to build
            </button>{' '}
            or try “Build me a monthly ALCO pack with loan balance trend, deposit mix and delinquency ratio”.
          </p>
        </>
      )}

      {q.data && tab === 'schedules' && <Schedules schedules={q.data.schedules} />}
    </div>
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
          Run now (local test of tonight’s run)
        </Button>
      </p>
    </>
  );
}

export function ReportPage() {
  const { templateId = '' } = useParams();
  const { api } = useSession();
  const host = useShellBlockHost();
  const q = useQuery({ queryKey: ['report', templateId], queryFn: () => api.runReport(templateId), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1 });
  const name = q.data?.data.name;
  useEffect(() => {
    if (name) useUi.getState().visit({ kind: 'view', path: `/reports/${templateId}`, label: name });
  }, [name, templateId]);
  return (
    <div className={page.page}>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/reports">Reports</Link>
        <ChevronRight size={14} aria-hidden />
        <span aria-current="page">{name ?? 'Report'}</span>
      </nav>
      {q.isPending && <Skeleton height="420px" radius="md" />}
      {q.isError && (
        <p className={styles.message} role="alert">
          {q.error instanceof ApiError && q.error.status === 404 ? 'This report was not found, or it is outside your access.' : 'The report could not be run. Try again in a moment.'}
        </p>
      )}
      {q.data && (
        <BlockHostProvider value={host}>
          <BlockRenderer block={q.data} />
        </BlockHostProvider>
      )}
    </div>
  );
}
