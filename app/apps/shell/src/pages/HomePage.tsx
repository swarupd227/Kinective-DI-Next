// Home as a daily briefing (spec 6.3, 8.2): assembled after each nightly build, approvals first,
// then what changed, things to look at, your work, scheduled reports, pinned tabs and prompts.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AudioLines, CircleCheck, Search, TriangleAlert } from 'lucide-react';
import { BlockHostProvider, BlockRenderer, formatAsOf } from '@dinext/blocks';
import { Button, Skeleton } from '@dinext/ui';
import type { ApprovalCardBlock, Block, HomeSection } from '@dinext/block-schemas';
import { useSession } from '../session/SessionProvider.tsx';
import { useShellBlockHost } from '../shell/useShellBlockHost.ts';
import { useUi } from '../shell/uiStore.ts';
import styles from './HomePage.module.css';

type Resolution = NonNullable<ApprovalCardBlock['data']['resolution']>;

export function HomePage() {
  const { api, startThread, session } = useSession();
  const { tabId } = useParams();
  const navigate = useNavigate();
  const home = useQuery({ queryKey: ['home'], queryFn: () => api.home() });
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

  return (
    <BlockHostProvider value={host}>
      <div className={styles.page}>
        <header className={styles.hero}>
          <div className={styles.heroText}>
            <h1 className={styles.greeting}>{h.greeting}</h1>
            <p className={clsx(styles.freshness, !ok && styles.stale)}>
              {ok ? <CircleCheck size={16} aria-hidden /> : <TriangleAlert size={16} aria-hidden />}
              {formatAsOf(h.build.asOf)}
              {!ok && <span> · last night&apos;s build is {h.build.state}</span>}
            </p>
          </div>
          <div className={styles.heroActions}>
            <Button variant="primary" icon={<AudioLines size={16} aria-hidden />} onClick={() => void ask('Brief me')}>
              Brief me
            </Button>
            <button type="button" className={styles.searchBox} onClick={() => useUi.getState().setPalette(true)}>
              <Search size={16} aria-hidden />
              <span>Search or ask…</span>
              <kbd>Ctrl K</kbd>
            </button>
          </div>
        </header>

        {h.sections
          .filter((s) => s.id !== 'your_work' && s.id !== 'scheduled_reports')
          .map((s) => (
            <section key={s.id} className={styles.section} aria-labelledby={`h-${s.id}`}>
              <h2 id={`h-${s.id}`} className={styles.sectionTitle}>
                {s.title}
                {s.id === 'approvals' && <span className={styles.count}>{s.blocks.filter((b) => !(b.type === 'approval_card' && resolved[b.data.approvalId])).length}</span>}
              </h2>
              <div className={clsx(styles.blocks, s.id === 'approvals' && styles.approvals)}>
                {s.blocks.map((b) => (
                  <BlockRenderer key={b.id} block={{ ...withResolution(b), title: s.id === 'approvals' ? b.title : undefined }} />
                ))}
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

        {h.suggestions.length > 0 && (
          <section className={styles.section} aria-labelledby="h-try">
            <h2 id="h-try" className={styles.sectionTitle}>
              Try asking
            </h2>
            <ul className={styles.prompts}>
              {h.suggestions.map((s) => (
                <li key={s}>
                  <button type="button" className={styles.prompt} onClick={() => void ask(s)}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className={styles.footnote}>
          Signed in as {session.user.name}, {session.user.title}. Briefing figures come from governed definitions in the semantic layer.
        </p>
      </div>
    </BlockHostProvider>
  );
}

function HomeSkeleton() {
  return (
    <div className={styles.page} aria-busy="true" aria-label="Loading your briefing">
      <Skeleton width="320px" height="36px" />
      <Skeleton width="240px" height="16px" />
      <Skeleton height="132px" radius="md" />
      <Skeleton height="200px" radius="md" />
      <Skeleton height="160px" radius="md" />
    </div>
  );
}
