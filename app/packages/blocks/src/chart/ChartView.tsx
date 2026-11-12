import { useMemo, useState } from 'react';
import { readToken, chartPalette } from '@dinext/tokens';
import { Menu, Skeleton, usePreferences } from '@dinext/ui';
import type { BlockAction, ChartBlock } from '@dinext/block-schemas';
import { EChart } from './EChart.tsx';
import { buildOption, pointCount, type ChartTheme } from './buildOption.ts';
import { DatasetTable } from './DatasetTable.tsx';
import { formatPoint, pointMenu, type ChartPoint, type PointChoice } from './pointMenu.ts';
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
  /** Clicking a bar or point offers follow-ups (drill, why, the rows); the choice is asked in the conversation. */
  onPointAsk?: (choice: PointChoice) => void;
  /** The block's own drill action, if it has one: the menu's first choice. */
  drill?: BlockAction;
}

/** Charts render only at block.end so partial data never misleads (FE-GEN-041). */
export default function ChartView({ block, complete, view, onDrill, onPointAsk, drill }: ChartViewProps) {
  const theme = useChartTheme();
  const { reducedMotion } = usePreferences();
  // Scatter has no categories and a heatmap shows as a table, so neither offers the point menu.
  const askable = !!onPointAsk && block.data.chartType !== 'scatter' && block.data.chartType !== 'heatmap';
  const option = useMemo(() => (complete ? buildOption(block, theme, reducedMotion, { clickable: askable }) : null), [block, complete, theme, reducedMotion, askable]);
  const [menu, setMenu] = useState<{ point: ChartPoint; left: number; top: number } | null>(null);

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

  const openAt = ({ index, seriesIndex, offsetX, offsetY }: { index: number; seriesIndex: number | null; offsetX: number; offsetY: number }) => {
    const row = block.data.dataset.source[index];
    if (!row) return;
    // The series clicked, else the first current one (not a prior-period comparison).
    const s = (seriesIndex !== null ? block.data.series[seriesIndex] : undefined) ?? block.data.series.find((x) => !x.comparison) ?? block.data.series[0]!;
    const yAt = block.data.dataset.dimensions.findIndex((d) => d.name === s.encode.y);
    const xAt = block.data.dataset.dimensions.findIndex((d) => d.name === s.encode.x);
    const v = row[yAt];
    setMenu({ point: { x: String(row[xAt] ?? ''), series: s.name, value: typeof v === 'number' ? v : null }, left: offsetX, top: offsetY });
  };
  const choices = menu ? pointMenu(block, menu.point, drill) : [];

  return (
    <>
      <div className={styles.chart}>
        <EChart
          option={option}
          renderer={pointCount(block) > 2000 ? 'canvas' : 'svg'}
          height={HEIGHT}
          ariaLabel={block.a11y?.summary ?? `${block.title ?? 'Chart'}. Switch to table view for the values.`}
          onItemClick={askable ? undefined : onDrill}
          onPointClick={askable ? openAt : undefined}
        />
        {menu && (
          <Menu
            open
            onOpenChange={(o) => !o && setMenu(null)}
            align="start"
            heading={`${menu.point.x}: ${formatPoint(block, menu.point.value)}`}
            trigger={<span className={styles.anchor} style={{ left: menu.left, top: menu.top }} aria-hidden />}
            items={choices.map((c) => ({ id: c.id, label: c.label, onSelect: () => onPointAsk!(c) }))}
          />
        )}
      </div>
      {block.data.sampled && <p className={styles.note}>Showing a sample of the points. Open the grid for every row.</p>}
    </>
  );
}
