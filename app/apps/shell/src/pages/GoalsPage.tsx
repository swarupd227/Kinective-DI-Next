// Goals & Incentives (spec 8.26): DI's view first, then the figures to check. The server decides who
// sees what and works out every amount. Decisions happen on a card in a task, never from this page.
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { Button, Skeleton } from '@dinext/ui';
import type { GoalCard, GoalsIndex } from '@dinext/block-schemas';
import { ApiError } from '@dinext/stream-client';
import { useSession } from '../session/SessionProvider.tsx';
import { DiTake } from '../shell/DiTake.tsx';
import { useUi } from '../shell/uiStore.ts';
import page from './Page.module.css';
import styles from './GoalsPage.module.css';

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
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
          {d.batches && <Payouts data={d} />}
          {d.mine && <Mine card={d.mine} />}
          {d.team && <Team cards={d.team} />}
        </div>
      )}
    </div>
  );
}

function Mine({ card }: { card: GoalCard }) {
  return (
    <section aria-labelledby="gi-mine">
      <h2 id="gi-mine" className={styles.heading}>
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

function Team({ cards }: { cards: GoalCard[] }) {
  return (
    <section aria-labelledby="gi-team">
      <h2 id="gi-team" className={styles.heading}>
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
    <section aria-labelledby="gi-payouts">
      <h2 id="gi-payouts" className={styles.heading}>
        Payouts to approve
      </h2>
      <ul className={styles.batches}>
        {data.batches!.map((b) => (
          <li key={b.branch} className={styles.batch}>
            <span className={styles.batchText}>
              <span>{b.branch}</span>
              <span className={styles.sub}>{b.waiting ? `${b.waiting} ${b.waiting === 1 ? 'person' : 'people'}, ${money(b.total)}` : 'Nothing waiting'}</span>
              {b.flagged > 0 && (
                <span className={styles.flag}>
                  <CircleAlert size={12} aria-hidden />
                  {b.flagged} flagged
                </span>
              )}
            </span>
            {b.waiting > 0 && (
              <Button size="sm" onClick={() => void startThread(`Show the ${b.period.split(' ')[0]} payouts for ${b.branch} for approval`).then((t) => navigate(`/c/${t}`))}>
                Review
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
