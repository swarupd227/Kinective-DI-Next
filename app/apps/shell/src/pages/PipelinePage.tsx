// Loan Pipeline (spec 8.27, FE-LAP-001 to 004): the view selector, the funnel, Pipeline By Product and
// the applications behind them. Names, groups and views come from the server, never from this file.
// Someone without Application Details sees counts and dollars by product instead of applicants.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CircleAlert, ListChecks, Sparkles, UserRound, X } from 'lucide-react';
import { Button, SegmentedControl, Skeleton } from '@dinext/ui';
import type { ContextRef, PipelineApplicationRow, PipelineCell, PipelineIndex, PipelineList, PipelineViewId } from '@dinext/block-schemas';
import { ApiError } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { DiTake } from '../shell/DiTake.tsx';
import { useUi } from '../shell/uiStore.ts';
import page from './Page.module.css';
import styles from './PipelinePage.module.css';

const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const money = (n: number) => compact.format(n);
const whole = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const VIEW_LABEL: Record<PipelineViewId, string> = { mine: 'My applications', location: 'My location', team: 'Team', institution: 'Institution' };

type Filter = { kind: 'stalled' } | { kind: 'group'; group: string };

export function PipelinePage() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get('id')) || null;
  const [view, setView] = useState<PipelineViewId | undefined>();
  const [filter, setFilter] = useState<Filter>({ kind: 'stalled' });
  const q = useQuery({ queryKey: ['lap', 'summary', view ?? ''], queryFn: () => api.pipeline(view) });
  const data = q.data;
  const active = view ?? data?.view;
  const list = useQuery({
    queryKey: ['lap', 'applications', active, filter],
    queryFn: () => api.pipelineApplications({ view: active!, ...(filter.kind === 'group' ? { group: filter.group } : { stalled: true }) }),
    enabled: !!active,
  });
  const open = (id: number | null) => setParams(id ? { id: String(id) } : {});

  useEffect(() => {
    useUi.getState().visit({ kind: 'view', path: '/m/lap', label: 'Loan Pipeline' });
  }, []);

  return (
    <div className={clsx(page.page, styles.page)}>
      <header className={page.header}>
        <h1 className={page.title}>Loan Pipeline</h1>
        <p className={page.lede}>
          {data ? (
            <>
              {data.stalled.count} of {data.open.count} open applications have stalled. {data.stale ? `The LOS feed missed the last build, so this is from the ${shortDate(data.asOf)} load.` : `As of the ${shortDate(data.asOf)} LOS load.`}
            </>
          ) : (
            'Where applications sit, and which ones need a push.'
          )}
        </p>
        {data && data.views.length > 1 && (
          <SegmentedControl
            label="Pipeline view"
            value={active!}
            onChange={(v) => {
              setView(v);
              setFilter({ kind: 'stalled' });
              open(null);
            }}
            options={data.views.map((v) => ({ value: v, label: VIEW_LABEL[v] }))}
          />
        )}
      </header>

      {q.isPending && <Skeleton height="320px" radius="md" />}
      {q.isError && (
        <p className={styles.message} role="alert">
          {q.error instanceof ApiError && q.error.status === 404 ? 'The pipeline is not loaded in this environment. Run npm run db:seed, then restart the server.' : 'The pipeline could not be loaded. Try again in a moment.'}
        </p>
      )}

      {data && (
        <>
          <DiTake take={data.take} />
          <dl className={styles.tiles}>
            <Tile label="Open applications" value={String(data.open.count)} />
            <Tile label="Open dollars" value={money(data.open.dollars)} />
            <Tile label="Stalled" value={String(data.stalled.count)} tone={data.stalled.count ? 'danger' : undefined} detail={data.stalled.count ? money(data.stalled.dollars) : undefined} />
            <Tile label="Oldest stall" value={data.stalled.count ? days(data.stalled.oldestDays) : 'None'} />
          </dl>

          <section className={styles.section} aria-labelledby="lap-funnel">
            <h2 id="lap-funnel" className={styles.heading}>
              Where applications sit
            </h2>
            <p className={styles.sub}>Open now, plus finished in the last {data.windowDays} days. Pick a stage to see what’s in it.</p>
            <Funnel data={data} filter={filter} onPick={(group) => setFilter(filter.kind === 'group' && filter.group === group ? { kind: 'stalled' } : { kind: 'group', group })} />
          </section>

          <div className={clsx(styles.columns, selected && styles.withDetail)}>
            <section className={styles.section} aria-labelledby="lap-list">
              <h2 id="lap-list" className={styles.heading}>
                {filter.kind === 'group' ? filter.group : 'Stalled applications'}
              </h2>
              {list.isPending && <Skeleton height="160px" radius="md" />}
              {list.data && <Applications list={list.data} selected={selected} onOpen={open} empty={filter.kind === 'stalled' ? 'Nothing has stalled.' : 'Nothing is in this stage.'} />}
            </section>
            {selected && <Detail id={selected} onClose={() => open(null)} />}
          </div>

          <section className={styles.section} aria-labelledby="lap-products">
            <h2 id="lap-products" className={styles.heading}>
              Pipeline by product
            </h2>
            <Products data={data} />
          </section>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'danger' }) {
  return (
    <div className={styles.tile}>
      <dt>{label}</dt>
      <dd className={clsx(styles.tileValue, tone === 'danger' && styles.danger)}>{value}</dd>
      {detail && <dd className={styles.sub}>{detail}</dd>}
    </div>
  );
}

function Funnel({ data, filter, onPick }: { data: PipelineIndex; filter: Filter; onPick: (group: string) => void }) {
  const most = Math.max(1, ...data.funnel.map((f) => f.count));
  return (
    <ol className={styles.funnel}>
      {data.funnel.map((f) => {
        const on = filter.kind === 'group' && filter.group === f.group;
        return (
          <li key={f.group}>
            <button type="button" className={clsx(styles.stage, on && styles.stageOn)} aria-pressed={on} onClick={() => onPick(f.group)}>
              <span className={styles.stageName}>{f.group}</span>
              <span className={styles.track} aria-hidden>
                <span className={styles.bar} style={{ width: `${(f.count / most) * 100}%` }} />
              </span>
              <span className={styles.stageCount}>{f.count}</span>
              <span className={styles.stageFacts}>
                {f.pct}% · {money(f.dollars)} · {f.avgDays} days avg
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Applications({ list, selected, onOpen, empty }: { list: PipelineList; selected: number | null; onOpen: (id: number) => void; empty: string }) {
  if (!list.count) return <p className={styles.message}>{empty}</p>;
  if (list.detailsHidden) {
    return (
      <>
        <p className={styles.sub}>
          {list.count} applications, {money(list.dollars)}. Your access shows totals by product, not individual applications.
        </p>
        <ul className={styles.list} aria-label="Applications by product">
          {list.byProduct.map((p) => (
            <li key={p.product} className={clsx(styles.row, styles.rowStatic)}>
              <span className={styles.rowTitle}>{p.product}</span>
              <span className={styles.sub}>
                {p.count} · {money(p.dollars)}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <ul className={styles.list} aria-label="Applications">
      {list.items.map((a) => (
        <li key={a.applicationId}>
          <Row app={a} selected={a.applicationId === selected} onOpen={() => onOpen(a.applicationId)} />
        </li>
      ))}
    </ul>
  );
}

function Row({ app, selected, onOpen }: { app: PipelineApplicationRow; selected: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={clsx(styles.row, selected && styles.rowSelected)} aria-current={selected || undefined} onClick={onOpen}>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>
          {app.name}, {whole(app.amount)}
        </span>
        <span className={styles.sub}>
          {app.product} · {app.status} · {app.owner?.name ?? 'No owner'}
        </span>
        {app.hold && <span className={styles.sub}>{app.hold.label}</span>}
      </span>
      <span className={styles.rowSide}>
        {app.stalled ? (
          <span className={styles.stalled}>
            <CircleAlert size={12} aria-hidden />
            Stalled
          </span>
        ) : (
          <span className={styles.sub}>{app.group}</span>
        )}
        <span className={styles.sub}>{days(app.daysInStatus)}</span>
      </span>
    </button>
  );
}

function CellFacts({ cell }: { cell: PipelineCell }) {
  if (!cell.count) return <span className={styles.sub}>0</span>;
  return (
    <>
      <span className={styles.cellCount}>{cell.count}</span>
      <span className={styles.sub}>
        {cell.pct}% · {money(cell.dollars)} · {cell.avgDays}d
      </span>
    </>
  );
}

function Products({ data }: { data: PipelineIndex }) {
  return (
    // Focusable so the wide table can be scrolled from the keyboard on a narrow screen.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Pipeline by product">
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Product</th>
            {data.groups.map((g) => (
              <th key={g} scope="col">
                {g}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {data.products.map((p) => (
            <tr key={p.product}>
              <th scope="row">{p.product}</th>
              {data.groups.map((g) => (
                <td key={g}>
                  <CellFacts cell={p.cells[g]!} />
                </td>
              ))}
              <td>
                <CellFacts cell={p.total} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.sub}>Each cell shows applications, then percent of the product, dollars and average days.</p>
    </div>
  );
}

function Detail({ id, onClose }: { id: number; onClose: () => void }) {
  const { api, startThread, terms } = useSession();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['lap', 'application', id], queryFn: () => api.pipelineApplication(id), retry: false });
  const name = q.data?.name;
  // While it's open, DI knows which application "this" means (FE-EXP-051).
  useEffect(() => {
    if (!name) return;
    const chip: ContextRef = { type: 'workflow_item', ref: `application:${id}`, label: `Application #${id}, ${name}` };
    useUi.getState().addContext('new', chip);
    return () => useUi.getState().removeContext('new', chip);
  }, [id, name]);
  if (q.isPending) return <Skeleton height="320px" radius="md" />;
  if (!q.data) {
    return (
      <section className={styles.detail}>
        <p className={styles.message}>This application isn’t available. It may be outside your access.</p>
      </section>
    );
  }
  const a = q.data;
  const chip: ContextRef = { type: 'member', ref: a.memberRef, label: a.name };
  return (
    <section className={styles.detail} aria-labelledby="application-title">
      <header className={styles.detailHead}>
        <div>
          <h2 id="application-title" className={styles.detailTitle}>
            {a.name}
          </h2>
          <p className={styles.sub}>
            {a.product} · #{a.applicationId} · …{a.last4}
          </p>
        </div>
        <button type="button" className={styles.close} aria-label="Close application" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </header>
      {a.stalled && (
        <p className={styles.alert}>
          <CircleAlert size={14} aria-hidden />
          {days(a.daysInStatus)} in this status, over the {a.threshold}-day threshold, as of the {shortDate(a.asOf)} LOS load.
        </p>
      )}
      {a.hold && (
        <p className={styles.hold}>
          <strong>{a.hold.label}.</strong> {a.hold.days > 0 ? `Waiting on ${a.hold.waitingOn} for ${days(a.hold.days)}.` : `Waiting on ${a.hold.waitingOn}.`} {a.hold.nextStep}
        </p>
      )}
      <dl className={styles.facts}>
        <div>
          <dt>Amount</dt>
          <dd>{whole(a.amount)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{a.status}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{a.owner?.name ?? 'No owner'}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{a.branch}</dd>
        </div>
      </dl>
      <div className={styles.actions}>
        {a.open && (
          <Button variant="primary" icon={<ListChecks size={14} aria-hidden />} onClick={() => void startThread(`Create a follow-up task for application #${a.applicationId}`).then((t) => navigate(`/c/${t}`))}>
            Create follow-up
          </Button>
        )}
        {a.memberRef && (
          <Button icon={<UserRound size={14} aria-hidden />} onClick={() => useUi.getState().openWorkspace({ kind: 'member', ref: a.memberRef, label: a.name })}>
            Open {terms.person}
          </Button>
        )}
        <Button variant="ghost" icon={<Sparkles size={14} aria-hidden />} onClick={() => void startThread(`Prepare me for my meeting with ${a.name}`, [chip]).then((t) => navigate(`/c/${t}`))}>
          Prepare me
        </Button>
      </div>
      <section aria-labelledby="application-history">
        <h3 id="application-history" className={styles.subheading}>
          Path so far
        </h3>
        <ol className={styles.path}>
          {a.history.map((h, i) => (
            <li key={i}>
              <span>{h.status}</span>
              <span className={styles.sub}>{shortDate(h.at)}</span>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
