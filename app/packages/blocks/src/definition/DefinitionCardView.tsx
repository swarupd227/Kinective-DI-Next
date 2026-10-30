import { BookOpenText, Scale, UserRound } from 'lucide-react';
import type { DefinitionCardBlock } from '@dinext/block-schemas';
import { Badge } from '@dinext/ui';
import styles from './DefinitionCardView.module.css';

/** A governed metric definition: what it means, how it is computed, who owns it (spec 6.12). */
export function DefinitionCardView({ block }: { block: DefinitionCardBlock }) {
  const d = block.data;
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden>
          <BookOpenText size={18} />
        </span>
        <div className={styles.titles}>
          <p className={styles.term}>{d.term}</p>
          <p className={styles.meta}>
            <code>{d.metricRef}</code> · semantic model {d.version}
          </p>
        </div>
        {!d.trendable && <Badge tone="neutral">As of build only</Badge>}
      </div>
      <p className={styles.definition}>{d.definition}</p>
      <dl className={styles.facts}>
        <div>
          <dt>Formula</dt>
          <dd className={styles.formula}>{d.formula}</dd>
        </div>
        {d.regulatoryBasis && (
          <div>
            <dt>
              <Scale size={12} aria-hidden /> Regulatory basis
            </dt>
            <dd>{d.regulatoryBasis}</dd>
          </div>
        )}
        {d.dimensions.length > 0 && (
          <div>
            <dt>Can be broken down by</dt>
            <dd>{d.dimensions.join(', ')}</dd>
          </div>
        )}
        <div>
          <dt>
            <UserRound size={12} aria-hidden /> Owner
          </dt>
          <dd>{d.owner}</dd>
        </div>
      </dl>
    </div>
  );
}
