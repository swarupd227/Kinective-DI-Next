// member_card (spec 8.24, 9.4): who the person is, what they hold and their scores, with "Why?" on
// each score. In a pick list it shows only what a search may show, and "Choose" opens the record.
import { ArrowUpRight, Share2 } from 'lucide-react';
import type { MemberCardBlock } from '@dinext/block-schemas';
import { Button } from '@dinext/ui';
import { useBlockHost } from '../context.tsx';
import { formatValue } from '../format.ts';
import { memberActions, PersonHeader, ScoreMeter } from './shared.tsx';
import styles from './Member.module.css';

export function MemberCardView({ block }: { block: MemberCardBlock }) {
  const host = useBlockHost();
  const d = block.data;
  const run = (a: ReturnType<typeof memberActions.open>) => host.onAction?.(block, a);
  const open = block.actions?.find((a) => a.kind === 'open_record') ?? memberActions.open(d);
  const refers = (block.actions ?? []).filter((a) => a.kind === 'run_operation');

  if (!d.selected) {
    return (
      <div className={styles.card} data-variant="choice">
        <PersonHeader m={d}>
          <Button size="sm" variant="primary" onClick={() => run(open)} aria-label={`Choose ${d.displayName}, number ending ${d.maskedNumber.slice(1)}, ${d.branch}`}>
            {open.label}
          </Button>
        </PersonHeader>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <PersonHeader m={d}>
        <Button size="sm" icon={<ArrowUpRight size={14} aria-hidden />} onClick={() => run(open)}>
          {open.label}
        </Button>
      </PersonHeader>
      {d.figures.length > 0 && (
        <dl className={styles.figures}>
          {d.figures.map((f) => (
            <div key={f.label} className={styles.figure}>
              <dt>{f.label}</dt>
              <dd className="dn-num">{formatValue(f.value, f.unit)}</dd>
            </div>
          ))}
        </dl>
      )}
      {d.scores.length > 0 && (
        <div className={styles.scores}>
          {d.scores.map((s) => (
            <ScoreMeter key={s.id} s={s} onWhy={() => run(memberActions.why(d, s))} />
          ))}
        </div>
      )}
      {refers.length > 0 && (
        <div className={styles.actions}>
          {refers.map((a) => (
            <Button key={a.id} size="sm" icon={<Share2 size={14} aria-hidden />} onClick={() => run(a)}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
