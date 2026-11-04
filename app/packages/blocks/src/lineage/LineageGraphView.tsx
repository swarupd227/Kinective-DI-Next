import { Fragment } from 'react';
import { ArrowRight, CircleCheck, CircleHelp, CircleX, Database, FileText, Layers, Server, Table2, Workflow } from 'lucide-react';
import type { LineageGraphBlock } from '@dinext/block-schemas';
import styles from './LineageGraphView.module.css';
import { formatDay } from '../format.ts';

type Node = LineageGraphBlock['data']['lanes'][number]['nodes'][number];

const ICONS: Record<Node['kind'], typeof Table2> = { table: Table2, rollup: Layers, load: Workflow, file: FileText, source: Server, unknown: CircleHelp };

function Dq({ dq }: { dq: NonNullable<Node['dq']> }) {
  if (dq.state === 'unknown') return <span className={styles.muted}>No data quality checks</span>;
  const failed = dq.state === 'failed';
  const Icon = failed ? CircleX : CircleCheck;
  return (
    <span className={failed ? styles.failed : styles.passed}>
      <Icon size={12} aria-hidden />
      {failed ? `${dq.failed} of ${dq.passed + dq.failed} checks failed` : `${dq.passed} checks passed`}
    </span>
  );
}

/** A metric traced to its sources (spec 24.10): each lane is one table, read left to right. */
export function LineageGraphView({ block }: { block: LineageGraphBlock }) {
  const d = block.data;
  return (
    <div className={styles.graph}>
      <p className={styles.metric}>
        <Database size={14} aria-hidden />
        <strong>{d.metric}</strong>
      </p>
      {d.lanes.map((lane) => (
        <ol key={lane.nodes[0]?.label} className={styles.lane}>
          {lane.nodes.map((n, i) => {
            const Icon = ICONS[n.kind];
            return (
              <Fragment key={`${n.kind}:${n.label}`}>
                {i > 0 && <ArrowRight size={14} aria-hidden className={styles.arrow} />}
                <li className={n.kind === 'unknown' ? styles.gap : styles.node}>
                  <span className={styles.label}>
                    <Icon size={14} aria-hidden />
                    {n.label}
                  </span>
                  {n.detail && <span className={styles.detail}>{n.detail}</span>}
                  {n.lastLoad && <span className={styles.muted}>Loaded {formatLoad(n.lastLoad)}</span>}
                  {n.dq && <Dq dq={n.dq} />}
                </li>
              </Fragment>
            );
          })}
        </ol>
      ))}
    </div>
  );
}

const formatLoad = (at: string) => {
  const [date, time] = at.split(' ');
  return `${formatDay(new Date(`${date}T12:00:00Z`))} at ${time}`;
};
