// Agent Audit Log (spec 26.10, AI-GRD-090): every agent run, who asked, which agent answered and how
// it ended, and for each run a step-by-step trace. Read only: nothing here can be changed or removed.
// Someone with AI-admin access sees every run; anyone else sees their own, through an answer's trace link.
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, CircleAlert, CircleCheck, CircleDashed, CircleMinus, Search } from 'lucide-react';
import { Badge, Button, SegmentedControl, Skeleton, TextInput, type BadgeTone } from '@dinext/ui';
import type { AuditRunSummary, AuditRunTrace, AuditTraceEntry } from '@dinext/block-schemas';
import { ApiError } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { DiTake } from '../shell/DiTake.tsx';
import { KpiTiles } from '../shell/KpiTiles.tsx';
import { useUi } from '../shell/uiStore.ts';
import page from './Page.module.css';
import styles from './AuditLogPage.module.css';

const OUTCOMES: Record<string, { label: string; tone: BadgeTone }> = {
  answer: { label: 'Answered', tone: 'success' },
  approval_requested: { label: 'Sent for approval', tone: 'info' },
  clarify: { label: 'Asked to clarify', tone: 'warning' },
  unmatched: { label: 'No measure for it', tone: 'warning' },
  not_supported: { label: 'Out of scope', tone: 'warning' },
  not_found: { label: 'Not found', tone: 'warning' },
  no_access: { label: 'Refused: access', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
  scripted: { label: 'Sample scenario', tone: 'neutral' },
};
const outcome = (o: string) => OUTCOMES[o] ?? { label: o.replaceAll('_', ' '), tone: 'neutral' as BadgeTone };
const PERIODS = [
  { value: '1', label: 'Today' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;
type Period = (typeof PERIODS)[number]['value'];

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2 }).format(n);
const duration = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const when = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const full = (iso: string) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
const offset = (ms: number | null) => (ms === null ? '' : ms < 1000 ? `+${ms} ms` : `+${(ms / 1000).toFixed(1)} s`);
const PAGE = 50;

export function AuditLogPage() {
  const { api } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const period = (PERIODS.some((p) => p.value === params.get('days')) ? params.get('days') : '7') as Period;
  const agent = params.get('agent') ?? '';
  const person = params.get('person') ?? '';
  const result = params.get('outcome') ?? '';
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const [offsetBy, setOffsetBy] = useState(0);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setOffsetBy(0);
    setParams(next, { replace: true });
  };
  const runs = useQuery({
    queryKey: ['audit', 'runs', period, agent, person, result, q, offsetBy],
    queryFn: () => api.auditRuns({ days: Number(period), agent, person, outcome: result, q, offset: offsetBy }),
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    useUi.getState().visit({ kind: 'view', path: '/audit', label: 'Agent Audit Log' });
  }, []);
  const d = runs.data;
  const periodText = PERIODS.find((p) => p.value === period)!.label.toLowerCase();
  const inPeriod = period === '1' ? 'today' : `in the last ${periodText}`;
  return (
    <div className={page.page}>
      <header className={page.header}>
        <h1 className={page.title}>Agent Audit Log</h1>
        <p className={page.lede}>
          {d && !d.everyone ? 'Your own runs: ' : 'Every agent run: '}who asked, which agent answered, each step it took, and how it ended. Open a run for its full trace. Nothing here can be changed or removed.
          {d?.since ? ` Kept since ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(d.since))}.` : ''}
        </p>
      </header>
      {runs.isPending && <Skeleton height="320px" radius="md" />}
      {runs.isError && (
        <p className={styles.message} role="alert">
          {runs.error instanceof ApiError && runs.error.status === 404 ? 'The audit log isn’t set up in this environment yet. Run the seed, then restart the server.' : 'The audit log could not be loaded. Try again in a moment.'}
        </p>
      )}
      {d && (
        <>
          <DiTake
            take={{
              headline: d.totals.runs ? `${d.totals.runs.toLocaleString('en-US')} ${d.totals.runs === 1 ? 'run' : 'runs'} ${inPeriod}${d.totals.failed || d.totals.refused ? `: ${[d.totals.failed ? `${d.totals.failed} failed` : '', d.totals.refused ? `${d.totals.refused} refused for access` : ''].filter(Boolean).join(', ')}` : ', none failed'}. ${d.totals.approvals ? `${d.totals.approvals} sent changes for approval.` : 'None asked to change anything.'}` : `No agent runs ${inPeriod}.`,
              action: d.totals.failed ? { label: 'Ask why runs failed', ask: `Which agent runs failed ${inPeriod}, and why?` } : undefined,
            }}
          />
          <KpiTiles
            label="Audit figures"
            tiles={[
              { label: 'Runs', value: d.totals.runs.toLocaleString('en-US'), detail: inPeriod },
              { label: 'Failed', value: String(d.totals.failed), tone: d.totals.failed ? 'danger' : 'neutral' },
              { label: 'Refused for access', value: String(d.totals.refused), tone: d.totals.refused ? 'warning' : 'neutral' },
              { label: 'Sent for approval', value: String(d.totals.approvals) },
              { label: 'Model cost', value: usd(d.totals.costUsd) },
            ]}
          />
          <section className={styles.panel} aria-labelledby="audit-runs">
            <div className={styles.panelHead}>
              <h2 id="audit-runs" className={styles.panelTitle}>
                Runs
              </h2>
              <SegmentedControl label="Period" value={period} options={PERIODS.map((p) => ({ value: p.value, label: p.label }))} onChange={(v) => set('days', v === '7' ? '' : v)} />
            </div>
            <div className={styles.filters}>
              <label className={styles.select}>
                <span>Agent</span>
                <select value={agent} onChange={(e) => set('agent', e.target.value)}>
                  <option value="">Every agent</option>
                  {d.agents.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              {d.everyone && (
                <label className={styles.select}>
                  <span>Person</span>
                  <select value={person} onChange={(e) => set('person', e.target.value)}>
                    <option value="">Everyone</option>
                    {d.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className={styles.select}>
                <span>Outcome</span>
                <select value={result} onChange={(e) => set('outcome', e.target.value)}>
                  <option value="">Any outcome</option>
                  <option value="problems">Problems only</option>
                  {Object.entries(OUTCOMES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
              <form
                className={styles.search}
                role="search"
                onSubmit={(e) => {
                  e.preventDefault();
                  set('q', text.trim());
                }}
              >
                <TextInput label="Search questions or a run ID" hideLabel placeholder="Search questions or a run ID" leading={<Search size={16} aria-hidden />} value={text} maxLength={120} onChange={(e) => setText(e.target.value)} />
              </form>
            </div>
            {d.items.length === 0 ? (
              <p className={styles.empty}>No runs match. Widen the period or clear a filter.</p>
            ) : (
              // Focusable so the wide table can be scrolled from the keyboard on a narrow screen.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Agent runs">
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      {d.everyone && <th scope="col">Person</th>}
                      <th scope="col">Agent</th>
                      <th scope="col">Question</th>
                      <th scope="col">Outcome</th>
                      <th scope="col" className={styles.num}>
                        Steps
                      </th>
                      <th scope="col" className={styles.num}>
                        Time
                      </th>
                      <th scope="col" className={styles.num}>
                        Cost
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((r) => (
                      <RunRow key={r.runId} run={r} everyone={d.everyone} onOpen={() => navigate(`/audit/runs/${r.runId}`)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.total > PAGE && (
              <div className={styles.pager}>
                <span>
                  {offsetBy + 1}–{Math.min(offsetBy + PAGE, d.total)} of {d.total.toLocaleString('en-US')}
                </span>
                <Button size="sm" variant="secondary" disabled={offsetBy === 0} onClick={() => setOffsetBy(Math.max(0, offsetBy - PAGE))}>
                  Newer
                </Button>
                <Button size="sm" variant="secondary" disabled={offsetBy + PAGE >= d.total} onClick={() => setOffsetBy(offsetBy + PAGE)}>
                  Older
                </Button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function RunRow({ run, everyone, onOpen }: { run: AuditRunSummary; everyone: boolean; onOpen: () => void }) {
  const o = outcome(run.outcome);
  return (
    <tr className={styles.row} onClick={onOpen}>
      <td className={styles.nowrap}>{when(run.at)}</td>
      {everyone && <td className={styles.nowrap}>{run.user.name}</td>}
      <td className={styles.nowrap}>{run.agent}</td>
      <td className={styles.question}>
        <Link to={`/audit/runs/${run.runId}`} onClick={(e) => e.stopPropagation()}>
          {run.question || '(no question)'}
        </Link>
        <span className={styles.runId}>{run.runId}</span>
      </td>
      <td>
        <Badge tone={o.tone}>{o.label}</Badge>
        {run.approvals > 0 && <span className={styles.sub}>{run.approvals === 1 ? '1 approval' : `${run.approvals} approvals`}</span>}
      </td>
      <td className={styles.num}>{run.steps || run.toolCalls || '—'}</td>
      <td className={styles.num}>{duration(run.durationMs)}</td>
      <td className={styles.num}>{run.costUsd ? usd(run.costUsd) : '—'}</td>
    </tr>
  );
}

// ---- one run ------------------------------------------------------------------------------------

const STATUS_ICON = {
  ok: <CircleCheck size={16} aria-hidden />,
  failed: <CircleAlert size={16} aria-hidden />,
  waiting: <CircleDashed size={16} aria-hidden />,
  skipped: <CircleMinus size={16} aria-hidden />,
};
const STATUS_TEXT = { ok: 'Done', failed: 'Failed', waiting: 'Waiting', skipped: 'Skipped' };

export function RunTracePage() {
  const { runId = '' } = useParams();
  const { api, can, session } = useSession();
  const trace = useQuery({ queryKey: ['audit', 'trace', runId], queryFn: () => api.auditTrace(runId), retry: false });
  const t = trace.data;
  return (
    <div className={clsx(page.page, styles.tracePage)}>
      <nav aria-label="Breadcrumb">
        {can('audit') ? (
          <Link to="/audit" className={styles.back}>
            <ArrowLeft size={16} aria-hidden />
            Agent Audit Log
          </Link>
        ) : t?.threadId ? (
          <Link to={`/c/${t.threadId}`} className={styles.back}>
            <ArrowLeft size={16} aria-hidden />
            Back to the conversation
          </Link>
        ) : null}
      </nav>
      {trace.isPending && <Skeleton height="420px" radius="md" />}
      {trace.isError && (
        <div className={page.center}>
          <h1 className={page.title}>This run isn’t available</h1>
          <p className={page.lede}>{trace.error instanceof ApiError && trace.error.status === 404 ? 'It may be someone else’s, or from before the audit log was kept.' : 'The trace could not be loaded. Try again in a moment.'}</p>
        </div>
      )}
      {t && <Trace t={t} mine={t.user.id === session.user.id} />}
    </div>
  );
}

function Trace({ t, mine }: { t: AuditRunTrace; mine: boolean }) {
  const o = outcome(t.outcome);
  const tokens = t.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0);
  return (
    <>
      <header className={page.header}>
        <p className={styles.eyebrow}>Run trace · {t.runId}</p>
        <h1 className={page.title}>“{t.question || 'No question recorded'}”</h1>
        <p className={page.lede}>
          Asked by {t.user.name} on {full(t.at)}. {t.agent} handled it.
          {mine && t.threadId && (
            <>
              {' '}
              <Link to={`/c/${t.threadId}`}>Open the conversation</Link>.
            </>
          )}
        </p>
      </header>
      <KpiTiles
        label="Run figures"
        tiles={[
          { label: 'Outcome', value: o.label, tone: o.tone === 'danger' ? 'danger' : o.tone === 'warning' ? 'warning' : 'neutral' },
          { label: 'Agent', value: t.agent },
          { label: 'Time to answer', value: duration(t.durationMs) },
          { label: 'Tokens', value: tokens.toLocaleString('en-US'), detail: t.usage.length ? `${t.usage.length} model ${t.usage.length === 1 ? 'call' : 'calls'}` : 'No model calls' },
          { label: 'Model cost', value: usd(t.costUsd) },
        ]}
      />
      {t.partial && <p className={styles.note}>This run was recorded before step-by-step tracing, so only the usage ledger’s summary of it is shown.</p>}
      <div className={styles.traceGrid}>
        <section className={styles.panel} aria-labelledby="trace-timeline">
          <div className={styles.panelHead}>
            <h2 id="trace-timeline" className={styles.panelTitle}>
              What happened, step by step
            </h2>
          </div>
          <ol className={styles.timeline}>
            {t.timeline.map((e, i) => (
              <TimelineItem key={i} e={e} />
            ))}
          </ol>
          {t.truncated && <p className={styles.note}>The run went on past what a trace keeps; later steps aren’t shown.</p>}
        </section>
        <aside className={styles.side}>
          <section className={styles.panel} aria-labelledby="trace-facts">
            <div className={styles.panelHead}>
              <h2 id="trace-facts" className={styles.panelTitle}>
                Details
              </h2>
            </div>
            <dl className={styles.facts}>
              <dt>Run</dt>
              <dd className={styles.mono}>{t.runId}</dd>
              <dt>Asked by</dt>
              <dd>{t.user.name}</dd>
              <dt>Routed as</dt>
              <dd>
                {t.route.intent.replaceAll('_', ' ')}
                {t.route.confidence !== null ? `, ${Math.round(t.route.confidence * 100)}% sure` : ''}
              </dd>
              <dt>Mode</dt>
              <dd>{t.route.mode === 'live' ? 'Live model' : t.route.mode === 'offline' ? 'Offline planner, no model' : t.route.mode}</dd>
              <dt>Identifiers masked</dt>
              <dd>{t.maskedIdentifiers ? `${t.maskedIdentifiers}, before any model saw the question` : 'None in the question'}</dd>
              {t.modelVersion && (
                <>
                  <dt>Semantic model</dt>
                  <dd>{t.modelVersion}</dd>
                </>
              )}
              {t.buildId && (
                <>
                  <dt>Data build</dt>
                  <dd className={styles.mono}>{t.buildId}</dd>
                </>
              )}
              {t.error && (
                <>
                  <dt>Error</dt>
                  <dd className={styles.error}>{t.error}</dd>
                </>
              )}
            </dl>
          </section>
          {t.usage.length > 0 && (
            <section className={styles.panel} aria-labelledby="trace-models">
              <div className={styles.panelHead}>
                <h2 id="trace-models" className={styles.panelTitle}>
                  Model calls
                </h2>
              </div>
              <ul className={styles.calls}>
                {t.usage.map((u, i) => (
                  <li key={i}>
                    <span className={styles.callName}>{u.model}</span>
                    <span className={styles.sub}>
                      {u.role}: {u.inputTokens.toLocaleString('en-US')} in, {u.outputTokens.toLocaleString('en-US')} out{u.cacheReadTokens ? `, ${u.cacheReadTokens.toLocaleString('en-US')} from cache` : ''} · {usd(u.costUsd)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {t.numericRemovals.length > 0 && (
            <section className={styles.panel} aria-labelledby="trace-removed">
              <div className={styles.panelHead}>
                <h2 id="trace-removed" className={styles.panelTitle}>
                  Figures taken out
                </h2>
              </div>
              <p className={styles.note}>These couldn’t be checked against the data, so they were removed from the answer.</p>
              <ul className={styles.calls}>
                {t.numericRemovals.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
      {t.toolCalls.length > 0 && (
        <section className={styles.panel} aria-labelledby="trace-tools">
          <div className={styles.panelHead}>
            <h2 id="trace-tools" className={styles.panelTitle}>
              Tool calls, with their inputs
            </h2>
          </div>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Tool calls">
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Inputs</th>
                  <th scope="col">Result</th>
                  <th scope="col" className={styles.num}>
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {t.toolCalls.map((c, i) => (
                  <tr key={i}>
                    <td className={clsx(styles.mono, styles.nowrap)}>{c.name}</td>
                    <td>
                      <pre className={styles.json}>{JSON.stringify(c.input ?? {}, null, 2)}</pre>
                    </td>
                    <td>{c.ok ? <Badge tone="success">OK{c.resultRef ? `, ${c.resultRef}` : ''}</Badge> : <Badge tone="danger">Failed{c.error ? `: ${c.error}` : ''}</Badge>}</td>
                    <td className={styles.num}>{duration(c.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function TimelineItem({ e }: { e: AuditTraceEntry }) {
  const status = e.status ?? 'ok';
  return (
    <li className={clsx(styles.event, styles[status])}>
      <span className={styles.dot} title={STATUS_TEXT[status]}>
        {STATUS_ICON[status]}
        <span className="dn-visually-hidden">{STATUS_TEXT[status]}: </span>
      </span>
      <div className={styles.eventBody}>
        <p className={styles.eventHead}>
          <span className={styles.eventTitle}>{e.title}</span>
          <span className={styles.eventTime} title={full(e.at)}>
            {offset(e.offsetMs) || when(e.at)}
          </span>
        </p>
        {(e.agent || e.operation) && (
          <p className={styles.tags}>
            {e.agent && <span className={styles.tag}>{e.agent}</span>}
            {e.operation && <span className={clsx(styles.tag, styles.mono)}>{e.operation}</span>}
          </p>
        )}
        {e.detail && <p className={styles.detail}>{e.detail}</p>}
        {e.sources && e.sources.length > 0 && <p className={styles.sources}>Sources: {e.sources.join(', ')}</p>}
      </div>
    </li>
  );
}
