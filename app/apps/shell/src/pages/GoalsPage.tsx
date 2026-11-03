// Goals & Incentives (spec 8.26): DI's view first, then the figures to check. The server decides who
// sees what and works out every amount. Decisions happen on a card in a task, never from this page.
import { useEffect } from 'react';
import clsx from 'clsx';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { Button, Skeleton } from '@dinext/ui';
import type { GoalCard, GoalsIndex } from '@dinext/block-schemas';
import { ApiError } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { DiTake } from '../shell/DiTake.tsx';
import { KpiTiles, type KpiTile } from '../shell/KpiTiles.tsx';
import { useUi } from '../shell/uiStore.ts';
import page from './Page.module.css';
import styles from './GoalsPage.module.css';

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
const whole = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const value = (g: GoalCard['goals'][number], n: number) => (g.unit === 'currency' ? whole(n) : n.toLocaleString('en-US'));

export function GoalsPage() {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['gi', 'summary'], queryFn: () => api.goals() });
  useEffect(() => {
    useUi.getState().visit({ kind: 'view', path: '/m/gi', label: 'Goals & Incentives' });
  }, []);
  const d = q.data;
  return (
    <div className={page.page}>
      <header className={page.header}>
        <h1 className={page.title}>Goals &amp; Incentives</h1>
        <p className={page.lede}>{d ? (d.mine?.period ?? d.batches?.[0]?.period ?? 'This period') : 'How the month is going, and what’s waiting to be approved.'}</p>
      </header>
      {q.isPending && <Skeleton height="320px" radius="md" />}
      {q.isError && (
        <p className={styles.message} role="alert">
          {q.error instanceof ApiError && q.error.status === 404 ? 'Goals are not loaded in this environment. Run npm run db:seed, then restart the server.' : 'Goals could not be loaded. Try again in a moment.'}
        </p>
      )}
      {d && (
        <div className={styles.stack}>
          <DiTake take={d.take} />
          <KpiTiles tiles={tilesFor(d)} />
          {(d.batches || d.team) && (
            <div className={styles.split}>
              {d.batches && <Payouts data={d} />}
              {d.team && <ByBranch cards={d.team} />}
            </div>
          )}
          {d.mine && <Mine card={d.mine} />}
          {d.team && <Team cards={d.team} />}
        </div>
      )}
    </div>
  );
}

/** The page opens on its figures: what's waiting, and how the team is tracking. */
function tilesFor(d: GoalsIndex): KpiTile[] {
  const tiles: KpiTile[] = [];
  if (d.batches) {
    const sum = (k: 'total' | 'waiting' | 'flagged') => d.batches!.reduce((n, b) => n + b[k], 0);
    tiles.push({ label: 'Payouts to approve', value: whole(sum('total')), detail: `${d.batches.filter((b) => b.waiting).length} branches` });
    tiles.push({ label: 'People waiting', value: String(sum('waiting')) });
    if (sum('flagged')) tiles.push({ label: 'Flagged for review', value: String(sum('flagged')), tone: 'warning' });
  }
  if (d.team) {
    const behind = d.team.filter((c) => c.behind).length;
    tiles.push({ label: 'Behind on goals', value: `${behind} of ${d.team.length}`, tone: behind ? 'danger' : 'neutral' });
    tiles.push({ label: 'Earned by the team', value: whole(d.team.reduce((n, c) => n + c.total, 0)) });
  }
  if (d.mine) {
    const measured = d.mine.goals.filter((g) => !g.qualifier);
    tiles.unshift({ label: 'My incentive so far', value: money(d.mine.total), detail: d.mine.period });
    if (measured.length) tiles.push({ label: 'My average to goal', value: `${Math.round(measured.reduce((n, g) => n + g.pct, 0) / measured.length)}%` });
  }
  return tiles.slice(0, 5);
}

/** Average % to goal for each branch, the bar chart managers scan first. */
function ByBranch({ cards }: { cards: GoalCard[] }) {
  const branches = [...new Set(cards.map((c) => c.branch))]
    .map((branch) => {
      const pcts = cards.filter((c) => c.branch === branch).flatMap((c) => c.goals.filter((g) => !g.qualifier).map((g) => g.pct));
      return { branch, pct: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0 };
    })
    .sort((a, b) => b.pct - a.pct);
  const max = Math.max(150, ...branches.map((b) => b.pct));
  return (
    <section aria-labelledby="gi-branches" className={styles.panel}>
      <h2 id="gi-branches" className={styles.panelHead}>
        Average % to goal{branches.length > 1 ? ' by branch' : ''}
      </h2>
      <ul className={styles.bars}>
        {branches.map((b) => (
          <li key={b.branch} className={styles.barRow}>
            <span className={styles.barLabel}>{b.branch}</span>
            <span className={styles.barTrack} aria-hidden>
              <span className={clsx(styles.barFill, b.pct < 100 && styles.barUnder)} style={{ width: `${(Math.min(b.pct, max) / max) * 100}%` }} />
              <span className={styles.barGoal} style={{ left: `${(100 / max) * 100}%` }} />
            </span>
            <span className={styles.barValue}>{b.pct}%</span>
          </li>
        ))}
      </ul>
      <p className={styles.sub}>The line marks 100% of goal.</p>
    </section>
  );
}

function Mine({ card }: { card: GoalCard }) {
  return (
    <section aria-labelledby="gi-mine" className={styles.panel}>
      <h2 id="gi-mine" className={styles.panelHead}>
        My goals
      </h2>
      <ul className={styles.goals}>
        {card.goals.map((g) => (
          <li key={g.goalId} className={styles.goal}>
            <span className={styles.goalHead}>
              <span>{g.name}</span>
              <span>{g.earned ? money(g.earned) : g.qualifier ? 'Qualifier' : ''}</span>
            </span>
            <progress className={styles.progress} max={100} value={Math.min(g.pct, 100)} aria-label={`${g.name}, ${g.pct}% of goal`} />
            <span className={styles.sub}>
              {value(g, g.actual)} of {value(g, g.target)} ({g.pct}%){g.pending ? `, ${g.pending} more active` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Why someone is behind. A missed qualifier is named, since their listed goals can all be over 100%. */
function behindText(c: GoalCard) {
  const gate = c.goals.find((g) => g.qualifier && g.actual < g.target);
  return gate ? `Missed ${gate.name}: ${value(gate, gate.actual)} of ${value(gate, gate.target)}` : 'Behind';
}

function Team({ cards }: { cards: GoalCard[] }) {
  return (
    <section aria-labelledby="gi-team" className={styles.panel}>
      <h2 id="gi-team" className={styles.panelHead}>
        Team
      </h2>
      {/* Focusable so the wide table can be scrolled from the keyboard on a narrow screen. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Team scorecards">
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Branch</th>
              <th scope="col">Goals</th>
              <th scope="col">Earned</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <tr key={c.employeeId}>
                <th scope="row">
                  {c.name}
                  <span className={styles.sub}>{c.role}</span>
                  {c.behind && (
                    <span className={styles.flag}>
                      <CircleAlert size={12} aria-hidden />
                      {behindText(c)}
                    </span>
                  )}
                </th>
                <td>{c.branch}</td>
                <td>
                  {c.goals
                    .filter((g) => !g.qualifier)
                    .map((g) => `${g.name} ${g.pct}%`)
                    .join(', ')}
                </td>
                <td>{money(c.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Payouts({ data }: { data: GoalsIndex }) {
  const { startThread } = useSession();
  const navigate = useNavigate();
  return (
    <section aria-labelledby="gi-payouts" className={styles.panel}>
      <h2 id="gi-payouts" className={styles.panelHead}>
        Payouts to approve
      </h2>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Branch</th>
            <th scope="col" className={styles.num}>
              People
            </th>
            <th scope="col" className={styles.num}>
              Amount
            </th>
            <th scope="col">Flagged</th>
            <th scope="col">
              <span className="dn-visually-hidden">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.batches!.map((b) => (
            <tr key={b.branch}>
              <th scope="row">{b.branch}</th>
              <td className={styles.num}>{b.waiting || '—'}</td>
              <td className={styles.num}>{b.waiting ? money(b.total) : '—'}</td>
              <td>
                {b.flagged > 0 ? (
                  <span className={styles.flag}>
                    <CircleAlert size={12} aria-hidden />
                    {b.flagged}
                  </span>
                ) : (
                  <span className={styles.sub}>None</span>
                )}
              </td>
              <td className={styles.action}>
                {b.waiting > 0 && (
                  <Button size="sm" onClick={() => void startThread(`Show the ${b.period.split(' ')[0]} payouts for ${b.branch} for approval`).then((t) => navigate(`/c/${t}`))}>
                    Review
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
