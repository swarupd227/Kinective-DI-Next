import type { ChartBlock } from '@dinext/block-schemas';
import { formatValue } from '../format.ts';
import styles from './ChartView.module.css';

/** Equivalent table for every visual block (FE-GEN-002). */
export function DatasetTable({ block }: { block: ChartBlock }) {
  const { dimensions, source } = block.data.dataset;
  const unit = block.data.axes?.y?.[0]?.unit ?? 'number';
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="dn-visually-hidden">{block.title ?? 'Chart data'}</caption>
        <thead>
          <tr>
            {dimensions.map((d) => (
              <th key={d.name} scope="col">
                {d.displayName ?? d.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {source.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) =>
                c === 0 ? (
                  <th key={c} scope="row">
                    {String(cell ?? '—')}
                  </th>
                ) : (
                  <td key={c} className="dn-num">
                    {typeof cell === 'number' ? formatValue(cell, unit) : String(cell ?? '—')}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
