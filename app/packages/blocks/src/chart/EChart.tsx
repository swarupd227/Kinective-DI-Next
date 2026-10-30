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
}

export function EChart({ option, renderer, height, ariaLabel, onItemClick }: EChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onItemClick);
  useEffect(() => {
    clickRef.current = onItemClick;
  }, [onItemClick]);

  useEffect(() => {
    if (!el.current) return;
    const instance = echarts.init(el.current, undefined, { renderer });
    chart.current = instance;
    instance.on('click', (p) => clickRef.current?.(String((p as { name?: unknown }).name ?? '')));
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
