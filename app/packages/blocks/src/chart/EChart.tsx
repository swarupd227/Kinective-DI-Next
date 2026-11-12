// ECharts host. Tree-shaken, SVG renderer by default and canvas above 2,000 points (spec 11.1).
// Tooltips use richText mode so nothing is written as HTML (spec 11.9 CSP and Trusted Types).
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import { AriaComponent, DatasetComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  AriaComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  SVGRenderer,
  CanvasRenderer,
]);

export interface EChartProps {
  option: EChartsCoreOption;
  renderer: 'svg' | 'canvas';
  height: number;
  ariaLabel: string;
  onItemClick?: (name: string) => void;
  /**
   * A click anywhere over a category (not only on a bar or a line's dot, which is small): its index
   * along the x axis, the series under the pointer if any, and where in the chart it was.
   */
  onPointClick?: (p: { index: number; seriesIndex: number | null; offsetX: number; offsetY: number }) => void;
}

export function EChart({ option, renderer, height, ariaLabel, onItemClick, onPointClick }: EChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onItemClick);
  const pointRef = useRef(onPointClick);
  useEffect(() => {
    clickRef.current = onItemClick;
    pointRef.current = onPointClick;
  }, [onItemClick, onPointClick]);

  useEffect(() => {
    if (!el.current) return;
    const instance = echarts.init(el.current, undefined, { renderer });
    chart.current = instance;
    let lastSeries: number | null = null;
    instance.on('click', (p) => {
      const q = p as { name?: unknown; dataIndex?: number; seriesIndex?: number; seriesType?: string; event?: { offsetX: number; offsetY: number } };
      clickRef.current?.(String(q.name ?? ''));
      lastSeries = q.seriesIndex ?? null;
      // A pie has no x axis: its slice is the point.
      if (q.seriesType === 'pie' && typeof q.dataIndex === 'number' && q.event) pointRef.current?.({ index: q.dataIndex, seriesIndex: q.seriesIndex ?? 0, offsetX: q.event.offsetX, offsetY: q.event.offsetY });
    });
    instance.getZr().on('click', (e) => {
      if (!pointRef.current) return;
      const at: [number, number] = [e.offsetX, e.offsetY];
      if (!instance.containPixel('grid', at)) return;
      const r = instance.convertFromPixel({ gridIndex: 0 }, at) as unknown;
      const index = Array.isArray(r) ? Number(r[0]) : Number(r);
      if (!Number.isFinite(index)) return;
      const seriesIndex = lastSeries;
      lastSeries = null;
      pointRef.current({ index: Math.round(index), seriesIndex, offsetX: e.offsetX, offsetY: e.offsetY });
    });
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [renderer]);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option, renderer]);

  return <div ref={el} role="img" aria-label={ariaLabel} style={{ width: '100%', height }} />;
}
