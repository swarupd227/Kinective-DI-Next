import { useMemo } from 'react';
import clsx from 'clsx';
import { BlockHostProvider, BlockRenderer, type BlockHost } from '@dinext/blocks';
import { useToast } from '@dinext/ui';
import { buildCases } from './cases.ts';
import { AgentResponse } from './AgentResponse.tsx';
import styles from './BlocksPage.module.css';

export function BlocksPage({ caseId, onSelect }: { caseId?: string; onSelect: (id: string) => void }) {
  const cases = useMemo(() => buildCases(), []);
  const current = cases.find((c) => c.id === caseId) ?? cases[0]!;
  const toast = useToast();
  const groups = [...new Set(cases.map((c) => c.group))];

  // The workbench has no Experience Layer: decisions resolve locally after a short delay.
  const host = useMemo<BlockHost>(
    () => ({
      canViewSql: true,
      voiceMediumAllowed: true,
      onAction: (_b, a) => toast.show(`${a.label}: wired up in Slice 1`),
      onSourceOpen: (_b, s) => toast.show(`Open ${s.label}: wired up in Slice 1`),
      onCancelRun: () => toast.show('Stop requested'),
      onRetry: () => toast.show('Retry requested'),
      onNoticeOption: () => toast.show('Option sent to the Concierge'),
      onStepUp: async () => {
        toast.show('Step-up sign-in simulated');
        return 'stp_workbench';
      },
      onDecision: async (_b, d) => {
        await new Promise((r) => setTimeout(r, 600));
        const decision = d.decision === 'approve' ? 'approved' : d.decision === 'deny' ? 'denied' : 'returned';
        toast.show(`Decision sent: ${decision} (${d.channel})`);
        return { ok: true, decision, by: 'Dana Lee', at: new Date().toISOString() };
      },
    }),
    [toast],
  );

  return (
    <div className={styles.page}>
      <nav className={styles.nav} aria-label="Block types">
        {groups.map((g) => (
          <div key={g} className={styles.group}>
            <h2 className={styles.groupTitle}>{g}</h2>
            <ul>
              {cases
                .filter((c) => c.group === g)
                .map((c) => (
                  <li key={c.id}>
                    <a href={`#/blocks/${c.id}`} className={clsx(styles.navItem)} aria-current={c.id === current.id ? 'page' : undefined} onClick={() => onSelect(c.id)}>
                      {c.label}
                      <span className={styles.count}>{c.variants.length}</span>
                    </a>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className={styles.content}>
        <div className={styles.column}>
          <header className={styles.header}>
            <h1 className={styles.title}>{current.label}</h1>
            <p className={styles.desc}>{current.description}</p>
            {current.variants.length > 1 && (
              <ul className={styles.jump} aria-label="States">
                {current.variants.map((v, i) => (
                  <li key={i}>
                    <a href={`#${current.id}-${i}`} onClick={(e) => (e.preventDefault(), document.getElementById(`${current.id}-${i}`)?.scrollIntoView({ block: 'start' }))}>
                      {v.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </header>
          <BlockHostProvider value={host}>
            {current.variants.map((v, i) => (
              <section key={`${current.id}-${i}`} id={`${current.id}-${i}`} className={styles.variant} aria-labelledby={`${current.id}-${i}-h`}>
                <h2 id={`${current.id}-${i}-h`} className={styles.variantLabel}>
                  {v.label}
                </h2>
                <AgentResponse agent={v.block.provenance?.agent ?? 'DI Concierge'}>
                  <BlockRenderer block={v.block} status={v.status} progressText="running semantic.query on Loan Accounts" />
                </AgentResponse>
              </section>
            ))}
          </BlockHostProvider>
        </div>
      </div>
    </div>
  );
}
