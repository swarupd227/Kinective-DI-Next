import { useMemo } from 'react';
import { readToken, chartPalette } from '@dinext/tokens';
import { Skeleton, usePreferences } from '@dinext/ui';
import type { ChartBlock } from '@dinext/block-schemas';
import { EChart } from './EChart.tsx';
import { buildOption, pointCount, type ChartTheme } from './buildOption.ts';
import { DatasetTable } from './DatasetTable.tsx';
import styles from './ChartView.module.css';

const HEIGHT = 280;

function useChartTheme(): ChartTheme {
  const { resolvedTheme } = usePreferences();
  return useMemo(
    () => ({
      palette: chartPalette.map((t) => readToken(t)),
      text: readToken('color.text.primary'),
      muted: readToken('color.chart.axis'),
      grid: readToken('color.chart.grid'),
      axis: readToken('color.chart.axis'),
      surface: readToken('color.bg.raised'),
      border: readToken('color.border.default'),
      fontFamily: readToken('font.family.sans'),
      danger: readToken('color.status.danger.text'),
    }),
    // Token values change with the theme attribute; recompute when it flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedTheme],
  );
}

export interface ChartViewProps {
  block: ChartBlock;
  complete: boolean;
  view: 'chart' | 'table';
  onDrill?: (category: string) => void;
}

/** Charts render only at block.end so partial data never misleads (FE-GEN-041). */
export default function ChartView({ block, complete, view, onDrill }: ChartViewProps) {
  const theme = useChartTheme();
  const { reducedMotion } = usePreferences();
  const option = useMemo(() => (complete ? buildOption(block, theme, reducedMotion) : null), [block, complete, theme, reducedMotion]);

  if (!option) {
    return (
      <div className={styles.skeleton} aria-hidden>
        {[62, 80, 45, 70, 92, 38].map((h, i) => (
          <Skeleton key={i} width="10%" height={`${h}%`} radius="sm" />
        ))}
      </div>
    );
  }

  if (view === 'table' || block.data.chartType === 'heatmap') return <DatasetTable block={block} />;

  return (
    <>
      <EChart
        option={option}
        renderer={pointCount(block) > 2000 ? 'canvas' : 'svg'}
        height={HEIGHT}
        ariaLabel={block.a11y?.summary ?? `${block.title ?? 'Chart'}. Switch to table view for the values.`}
        onItemClick={onDrill}
      />
      {block.data.sampled && <p className={styles.note}>Showing a sample of the points. Open the grid for every row.</p>}
    </>
  );
}
