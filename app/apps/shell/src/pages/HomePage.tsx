// Home (spec 6.3, 8.2): one place to hand DI a task, then what needs you, what changed since the
// nightly build, and your own work. Figures come from governed definitions in the semantic layer.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { BlockHostProvider, BlockRenderer, formatAsOf } from '@dinext/blocks';
import { Button, Skeleton } from '@dinext/ui';
import type { ApprovalCardBlock, Block, HomeSection } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';
import { ConversationBar } from '../shell/ConversationBar.tsx';
import { useShellBlockHost } from '../shell/useShellBlockHost.ts';
import { useUi } from '../shell/uiStore.ts';
import styles from './HomePage.module.css';

type Resolution = NonNullable<ApprovalCardBlock['data']['resolution']>;

/** The narrative marks key figures with **bold**; nothing else in it is markup. */
const Narrative = ({ text }: { text: string }) => (
  <p className={styles.narrative}>
    {text.split('**').map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}
  </p>
);

export function HomePage() {
  const { api, startThread, session } = useSession();
  const { tabId } = useParams();
  const navigate = useNavigate();
  // A task may have raised a card since the last visit, so Home always checks.
  const home = useQuery({ queryKey: ['home'], queryFn: () => api.home(), refetchOnMount: 'always' });
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});

  const onResolved = useCallback((block: Block, r: { decision: 'approved' | 'denied' | 'returned'; by: string; at: string }) => {
    if (block.type !== 'approval_card') return;
    setResolved((m) => ({ ...m, [block.data.approvalId]: { decision: r.decision, by: r.by, at: r.at, channel: 'click' } }));
  }, []);
  const host = useShellBlockHost({ onResolved, approvalDisplay: 'summary' });

  useEffect(() => {
    useUi.getState().visit({ kind: 'view', path: '/home', label: 'Home' });
  }, []);

  const ask = async (text: string) => navigate(`/c/${await startThread(text)}`);

  if (home.isPending) return <HomeSkeleton />;
  if (home.isError) {
    return (
      <div className={styles.page}>
        <p className={styles.error} role="alert">
          The briefing could not be loaded. <Button size="sm" onClick={() => void home.refetch()}>Try again</Button>
        </p>
      </div>
    );
  }

  const h = home.data;
  const ok = h.build.state === 'completed';
  const withResolution = (b: Block): Block => (b.type === 'approval_card' && resolved[b.data.approvalId] ? { ...b, data: { ...b.data, resolution: resolved[b.data.approvalId] } } : b);
  const section = (id: HomeSection['id']) => h.sections.find((s) => s.id === id);
  const yourWork = section('your_work');
  const scheduled = section('scheduled_reports');
  const activeTab = h.tabs.find((t) => t.id === tabId) ?? h.tabs[0];
  const title = (s: HomeSection) => (s.id === 'approvals' ? 'Needs you' : s.id === 'what_changed' ? 'Since yesterday' : s.id === 'look_at' ? 'Worth a look' : s.title);

  return (
    <BlockHostProvider value={host}>
      <div className={styles.page}>
        <header className={styles.hero}>
          <h1 className={styles.greeting}>{h.greeting}</h1>
          <ConversationBar collapsedByDefault={false} hero />
          {h.suggestions.length > 0 && (
            <ul className={styles.prompts} aria-label="Try asking">
              {h.suggestions.map((s) => (
                <li key={s}>
                  <button type="button" className={styles.prompt} onClick={() => void ask(s)}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </header>

        {h.sections
          .filter((s) => s.id !== 'your_work' && s.id !== 'scheduled_reports')
          .map((s) => (
            <section key={s.id} className={styles.section} aria-labelledby={`h-${s.id}`}>
              <h2 id={`h-${s.id}`} className={styles.sectionTitle}>
                {title(s)}
                {s.id === 'approvals' && <span className={styles.count}>{s.blocks.reduce((n, b) => n + (b.type === 'list' ? b.data.items.length : b.type === 'approval_card' && resolved[b.data.approvalId] ? 0 : 1), 0)}</span>}
              </h2>
              {s.id === 'what_changed' && (
                <>
                  <p className={clsx(styles.freshness, !ok && styles.stale)}>
                    {ok ? <CircleCheck size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
                    {formatAsOf(h.build.asOf)}
                    {!ok && <span> · last night&apos;s build is {h.build.state}</span>}
                  </p>
                  {h.narrative && <Narrative text={h.narrative} />}
                </>
              )}
              <div className={clsx(styles.blocks, s.id === 'approvals' && styles.approvals)}>
                {s.blocks.map((b) => {
                  const task = b.type === 'approval_card' ? s.tasks?.[b.data.approvalId] : undefined;
                  const card = <BlockRenderer key={b.id} block={{ ...withResolution(b), title: s.id === 'approvals' ? b.title : undefined }} />;
                  return task ? (
                    <div key={b.id} className={styles.taskCard}>
                      {card}
                      <Link to={`/c/${task}`} className={styles.taskLink}>
                        Open the task
                      </Link>
                    </div>
                  ) : (
                    card
                  );
                })}
              </div>
            </section>
          ))}

        {(yourWork || scheduled) && (
          <div className={styles.twoUp}>
            {[yourWork, scheduled].filter(Boolean).map((s) => (
              <section key={s!.id} className={styles.section} aria-labelledby={`h-${s!.id}`}>
                <h2 id={`h-${s!.id}`} className={styles.sectionTitle}>
                  {s!.title}
                </h2>
                {s!.blocks.map((b) => (
                  <BlockRenderer key={b.id} block={{ ...b, title: undefined }} />
                ))}
              </section>
            ))}
          </div>
        )}

        {activeTab && (
          <section className={styles.section} aria-labelledby="h-pinned">
            <div className={styles.pinnedHead}>
              <h2 id="h-pinned" className={styles.sectionTitle}>
                Pinned
              </h2>
              <nav aria-label="Home tabs" className={styles.tabs}>
                {h.tabs.map((t) => (
                  <Link key={t.id} to={`/home/${t.id}`} className={clsx(styles.tab, t.id === activeTab.id && styles.tabActive)} aria-current={t.id === activeTab.id ? 'page' : undefined}>
                    {t.label}
                  </Link>
                ))}
              </nav>
            </div>
            <div className={styles.pinned}>
              {activeTab.blocks.map((b) => (
                <div key={b.id} className={clsx(styles.pin, b.type === 'table' && styles.pinWide)}>
                  <BlockRenderer block={b} />
                </div>
              ))}
            </div>
          </section>
        )}
        <p className={styles.footnote}>
          Signed in as {session.user.name}, {session.user.title}. Figures come from governed definitions in the semantic layer.
        </p>
      </div>
    </BlockHostProvider>
  );
}

function HomeSkeleton() {
  return (
    <div className={styles.page} aria-busy="true" aria-label="Loading your briefing">
      <Skeleton width="320px" height="44px" />
      <Skeleton height="120px" radius="md" />
      <Skeleton height="200px" radius="md" />
      <Skeleton height="160px" radius="md" />
    </div>
  );
}
