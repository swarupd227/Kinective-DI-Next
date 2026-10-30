// Builds an ECharts option from a declarative chart block (spec 9.4, 10.4). The server never sends
// ECharts options; everything here is client code, so formatters are safe functions, not strings.
import type { ChartBlock } from '@dinext/block-schemas';
import type { EChartsCoreOption } from 'echarts/core';
import { formatAxis, formatValue } from '../format.ts';

export interface ChartTheme {
  palette: string[];
  text: string;
  muted: string;
  grid: string;
  axis: string;
  surface: string;
  border: string;
  fontFamily: string;
  danger: string;
}

const withAlpha = (hex: string, alpha: number) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

export function pointCount(block: ChartBlock): number {
  return block.data.dataset.source.length * block.data.series.length;
}

export function buildOption(block: ChartBlock, theme: ChartTheme, reducedMotion: boolean): EChartsCoreOption {
  const { chartType, dataset, series, axes, legend, markLines } = block.data;
  const unit = axes?.y?.[0]?.unit;
  const dims = dataset.dimensions.map((d) => d.name);
  const textStyle = { fontFamily: theme.fontFamily, color: theme.muted, fontSize: 12 };

  // Prior-period series take the hue of the current series they pair with (spec 10.4).
  const current = series.filter((s) => !s.comparison);
  const comparisons = series.filter((s) => s.comparison);
  const colorOf = (s: (typeof series)[number]) => {
    const idx = s.comparison ? comparisons.indexOf(s) : current.indexOf(s);
    return theme.palette[idx % theme.palette.length]!;
  };

  const tooltipValue = (v: unknown) => (typeof v === 'number' ? formatValue(v, unit ?? 'number') : String(v ?? '—'));

  const base: EChartsCoreOption = {
    animation: !reducedMotion,
    animationDuration: 300,
    textStyle,
    aria: { enabled: true, label: { description: block.a11y?.summary ?? block.title ?? 'Chart' } },
    dataset: { dimensions: dims, source: dataset.source },
    tooltip: {
      renderMode: 'richText',
      trigger: chartType === 'pie' || chartType === 'donut' || chartType === 'scatter' ? 'item' : 'axis',
      backgroundColor: theme.surface,
      borderColor: theme.border,
      textStyle: { ...textStyle, color: theme.text },
      valueFormatter: tooltipValue,
    },
    // Legend sits top right so the y-axis title (with its unit, spec 10.4) can sit top left.
    legend: legend === false ? { show: false } : { show: series.length > 1 || chartType === 'pie' || chartType === 'donut', top: 0, right: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, textStyle },
  };

  if (chartType === 'pie' || chartType === 'donut') {
    const s = series[0]!;
    return {
      ...base,
      color: theme.palette,
      series: [
        {
          type: 'pie',
          radius: chartType === 'donut' ? ['52%', '78%'] : '78%',
          center: ['50%', '56%'],
          encode: { itemName: s.encode.x, value: s.encode.y },
          itemStyle: { borderColor: theme.surface, borderWidth: 2 },
          label: { color: theme.text, fontFamily: theme.fontFamily, formatter: '{b}' },
        },
      ],
    };
  }

  const stacked = chartType === 'stacked_bar';
  return {
    ...base,
    // ECharts 6 keeps axis labels inside the grid by default (outerBounds), replacing containLabel.
    grid: { left: 8, right: 16, top: legend === false ? 12 : 36, bottom: 8 },
    xAxis: {
      type: chartType === 'scatter' ? 'value' : 'category',
      name: axes?.x?.title,
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      axisLabel: { color: theme.muted, fontFamily: theme.fontFamily },
    },
    yAxis: (axes?.y?.length ? axes.y : [{}]).map((y) => ({
      type: 'value',
      name: y.title,
      nameTextStyle: { color: theme.muted, fontFamily: theme.fontFamily, align: 'left' },
      splitLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.muted, fontFamily: theme.fontFamily, formatter: (v: number) => formatAxis(v, y.unit) },
      scale: chartType === 'line' || chartType === 'area',
    })),
    series: series.map((s, i) => {
      const color = colorOf(s);
      const type = s.type ?? (chartType === 'line' || chartType === 'area' ? 'line' : chartType === 'scatter' ? 'scatter' : 'bar');
      const isLine = type === 'line' || type === 'area';
      return {
        name: s.name,
        type: type === 'area' ? 'line' : type,
        encode: { x: s.encode.x, y: s.encode.y, tooltip: [s.encode.y] },
        yAxisIndex: s.yAxisIndex ?? 0,
        stack: stacked ? (s.stack ?? 'total') : s.stack,
        // The series colour also drives the legend swatch, so prior periods read lighter there too.
        color: s.comparison ? withAlpha(color, isLine ? 0.6 : 0.4) : color,
        barMaxWidth: 28,
        barGap: '12%',
        itemStyle: isLine ? undefined : { borderRadius: stacked ? 0 : [3, 3, 0, 0] },
        lineStyle: isLine ? { width: s.comparison ? 1.5 : 2.25, type: s.comparison ? 'dashed' : 'solid', color: s.comparison ? withAlpha(color, 0.6) : color } : undefined,
        areaStyle: chartType === 'area' || type === 'area' ? { opacity: 0.12 } : undefined,
        showSymbol: false,
        symbolSize: 6,
        smooth: false,
        emphasis: { focus: 'series' },
        markLine:
          i === series.length - 1 && markLines?.length
            ? {
                symbol: 'none',
                silent: true,
                lineStyle: { color: theme.danger, type: 'dashed', width: 1 },
                label: { formatter: '{b}', color: theme.danger, fontFamily: theme.fontFamily, position: 'insideEndTop' },
                data: markLines.map((m) => ({ yAxis: m.value, name: m.label })),
              }
            : undefined,
      };
    }),
  };
}
