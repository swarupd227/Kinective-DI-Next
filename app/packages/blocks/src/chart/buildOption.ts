// Builds an ECharts option from a declarative chart block (spec 9.4, 10.4). The server never sends
// ECharts options; everything here is client code, so formatters are safe functions, not strings.
import type { ChartBlock } from '@dinext/block-schemas';
import type { EChartsCoreOption } from 'echarts/core';
import { formatAxis, formatValue, rateDecimals } from '../format.ts';
import { isTimeAxis } from './pointMenu.ts';

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
  // A map's series each draw their own rows, not every row.
  return block.data.dataset.source.length * (block.data.chartType === 'map' ? 1 : block.data.series.length);
}

/** Room the y-axis labels and the grid's margins take from a chart's width, roughly. */
const Y_AXIS_PX = 64;
/** A category label this wide or wider wraps onto two lines, as on a desktop. */
const WIDE_LABEL_PX = 96;
/** A tilted label's longest run before it ends in an ellipsis. */
const TILTED_PX = 88;
/** Rough width of one character at the phone's 11 px axis font. */
const CHAR_PX = 6.6;

/**
 * The x-axis labels for the room the chart has. With room, every label of a short series shows,
 * wrapped onto two lines at word breaks. On a phone, labels that fit their share of the width stay
 * level; ones that don't (eight branch names) tilt, so each keeps its whole name with none overlapping;
 * a long series lets ECharts show every other label or fewer, never two over each other.
 */
export function categoryLabels(count: number, width?: number, labels: string[] = []) {
  const slot = width ? (width - Y_AXIS_PX) / Math.max(count, 1) : Infinity;
  if (count <= 8 && slot >= WIDE_LABEL_PX + 4) return { interval: 0, width: WIDE_LABEL_PX, overflow: 'break', hideOverlap: true };
  const small = width !== undefined && width < 480 ? { fontSize: 11 } : {};
  // Wrapping breaks at spaces, so the longest single word must fit the slot or it is cut mid-word.
  const longestWord = Math.max(0, ...labels.flatMap((l) => l.split(/\s+/)).map((w) => w.length)) * CHAR_PX;
  if (count <= 8 && slot - 6 >= longestWord) return { interval: 0, width: Math.floor(slot - 6), overflow: 'break', hideOverlap: true, ...small };
  if (count <= 12 && slot >= 16) return { interval: 0, rotate: 40, width: TILTED_PX, overflow: 'truncate', hideOverlap: true, ...small };
  return { hideOverlap: true, ...small };
}

export function buildOption(block: ChartBlock, theme: ChartTheme, reducedMotion: boolean, opts: { clickable?: boolean; width?: number } = {}): EChartsCoreOption {
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

  // Rates share one number of decimals across ticks and tooltip, so 0.705% does not read as 0.7%.
  const plotted = series.flatMap((s) => {
    const i = dims.indexOf(s.encode.y);
    return dataset.source.map((row) => row[i]).filter((v): v is number => typeof v === 'number');
  });
  const decimals = unit === 'percent' ? rateDecimals(plotted) : undefined;
  const tooltipValue = (v: unknown) => (typeof v === 'number' ? formatValue(v, unit ?? 'number', { decimals }) : String(v ?? '—'));
  // The hover is read up close, beside a gap in hundredths ("0.04 pts above"), so rates get two places.
  const hoverValue = (v: unknown) => (typeof v === 'number' ? formatValue(v, unit ?? 'number', { decimals: unit === 'percent' ? Math.max(decimals ?? 1, 2) : decimals }) : String(v ?? '—'));
  const axisTooltip = tooltipLines(block, hoverValue, opts.clickable === true);

  const base: EChartsCoreOption = {
    animation: !reducedMotion,
    animationDuration: 300,
    textStyle,
    aria: { enabled: true, label: { description: block.a11y?.summary ?? block.title ?? 'Chart' } },
    dataset: { dimensions: dims, source: dataset.source },
    tooltip: {
      renderMode: 'richText',
      trigger: chartType === 'pie' || chartType === 'donut' || chartType === 'scatter' || chartType === 'sunburst' || chartType === 'map' ? 'item' : 'axis',
      backgroundColor: theme.surface,
      borderColor: theme.border,
      textStyle: { ...textStyle, color: theme.text },
      valueFormatter: tooltipValue,
      ...(chartType === 'pie' || chartType === 'donut' || chartType === 'scatter' || chartType === 'sunburst' || chartType === 'map' ? {} : { formatter: axisTooltip }),
    },
    // Legend sits top right so the y-axis title (with its unit, spec 10.4) can sit top left.
    legend: legend === false ? { show: false } : { show: series.length > 1 || chartType === 'pie' || chartType === 'donut', top: 0, right: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, textStyle },
  };

  if (chartType === 'map') {
    // Points on longitude and latitude, the box padded so a mile is as long across as up and down.
    const at = (n: string) => dims.indexOf(n);
    const [kindAt, nameAt, latAt, lngAt, wAt] = ['kind', 'name', 'lat', 'lng', 'weight'].map(at) as [number, number, number, number, number];
    const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
    const lats = dataset.source.map((r) => num(r[latAt]));
    const lngs = dataset.source.map((r) => num(r[lngAt]));
    const mid = (Math.min(...lats) + Math.max(...lats)) / 2;
    let latSpan = Math.max(...lats) - Math.min(...lats) || 0.1;
    let lngSpan = (Math.max(...lngs) - Math.min(...lngs) || 0.1) * Math.cos((mid * Math.PI) / 180);
    const want = Math.max(1, (opts.width ?? 640) / 280);
    if (lngSpan / latSpan < want) lngSpan = latSpan * want;
    else latSpan = lngSpan / want;
    const cx = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const half = { lat: (latSpan * 1.08) / 2, lng: (lngSpan * 1.08) / 2 / Math.cos((mid * Math.PI) / 180) };
    const axis = (min: number, max: number) => ({ type: 'value', min, max, show: false, scale: true });
    const peak = Math.max(1, ...dataset.source.map((r) => num(r[wAt])));
    return {
      ...base,
      tooltip: { ...(base.tooltip as object), trigger: 'item', formatter: (p: { seriesName: string; name: string; value: number[] }) => `${p.name || p.seriesName}${p.value?.[2] ? `\n${p.value[2].toLocaleString('en-US')} ${p.name ? 'with us' : 'members'}` : ''}` },
      legend: { show: true, top: 0, right: 0, icon: 'circle', itemWidth: 10, itemHeight: 10, textStyle },
      grid: { left: 4, right: 4, top: 28, bottom: 4 },
      xAxis: axis(cx - half.lng, cx + half.lng),
      yAxis: axis(mid - half.lat, mid + half.lat),
      series: series.map((s, i) => {
        const mine = dataset.source.filter((r) => r[kindAt] === s.name);
        const color = theme.palette[i % theme.palette.length]!;
        const density = s.role === 'density';
        const wPeak = Math.max(1, ...mine.map((r) => num(r[wAt])));
        return {
          type: 'scatter',
          name: s.name,
          silent: density,
          z: density ? 1 : 3,
          data: mine.map((r) => ({ name: density ? '' : String(r[nameAt] ?? ''), value: [num(r[lngAt]), num(r[latAt]), num(r[wAt])] })),
          // Density: soft circles that grow and deepen with the members in each cell. Points: a size for how many bank with us.
          symbolSize: density ? (v: number[]) => 10 + Math.sqrt(num(v[2]) / wPeak) * 26 : (v: number[]) => (s.name === 'Branches' ? 14 : 7 + Math.sqrt(num(v[2]) / peak) * 14),
          symbol: s.name === 'Branches' ? 'pin' : 'circle',
          itemStyle: density ? { color, opacity: 0.16 } : { color, borderColor: theme.surface, borderWidth: 1, opacity: 0.95 },
          label: s.name === 'Branches' ? { show: true, position: 'right', formatter: '{b}', color: theme.text, fontFamily: theme.fontFamily, fontSize: 11 } : { show: false },
          emphasis: density ? { disabled: true } : { focus: 'self', label: { show: true, formatter: '{b}', position: 'top', color: theme.text } },
        };
      }),
    };
  }

  if (chartType === 'sunburst') {
    // Rows are paths, innermost ring first ("Direct", "North", "Westport", 1_250_000): sums roll up to each ring.
    const s = series[0]!;
    const at = dims.indexOf(s.encode.y);
    const levels = dims.map((_, i) => i).filter((i) => i !== at);
    type Node = { name: string; value: number; children: Node[] };
    const root: Node = { name: '', value: 0, children: [] };
    for (const row of dataset.source) {
      const v = typeof row[at] === 'number' ? (row[at] as number) : Number(row[at] ?? 0);
      let node = root;
      node.value += v;
      for (const i of levels) {
        const name = row[i] === null || row[i] === undefined || row[i] === '' ? null : String(row[i]);
        if (name === null) break;
        let child = node.children.find((c) => c.name === name);
        if (!child) node.children.push((child = { name, value: 0, children: [] }));
        child.value += v;
        node = child;
      }
    }
    const strip = (n: Node): object => (n.children.length ? { name: n.name, value: n.value, children: n.children.sort((a, b) => b.value - a.value).map(strip) } : { name: n.name, value: n.value });
    return {
      ...base,
      tooltip: { ...(base.tooltip as object), trigger: 'item', formatter: undefined },
      legend: { show: false },
      color: theme.palette,
      series: [
        {
          type: 'sunburst',
          radius: ['12%', '92%'],
          center: ['50%', '52%'],
          sort: undefined,
          nodeClick: 'rootToNode',
          data: root.children.sort((a, b) => b.value - a.value).map(strip),
          itemStyle: { borderColor: theme.surface, borderWidth: 2 },
          label: { color: theme.text, fontFamily: theme.fontFamily, fontSize: 11, minAngle: 12, rotate: 'radial' },
          levels: [{}, { label: { rotate: 0 } }, {}, { label: { show: false } }],
        },
      ],
    };
  }

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
  const xAt = dims.indexOf(series[0]?.encode.x ?? dims[0] ?? '');
  const xLabels = dataset.source.map((row) => String(row[Math.max(xAt, 0)] ?? ''));
  return {
    ...base,
    // ECharts 6 keeps axis labels inside the grid by default (outerBounds), replacing containLabel.
    grid: { left: 8, right: 16, top: legend === false ? 12 : 36, bottom: 8 },
    xAxis: {
      type: chartType === 'scatter' ? 'value' : 'category',
      name: axes?.x?.title,
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      // A handful of named bars each keep their label, wrapping onto two lines, rather than ECharts
      // dropping every other one; long series, and short ones on a phone, thin them so none overlap.
      axisLabel: { color: theme.muted, fontFamily: theme.fontFamily, ...(chartType === 'scatter' ? { hideOverlap: true } : categoryLabels(dataset.source.length, opts.width, xLabels)) },
    },
    yAxis: (axes?.y?.length ? axes.y : [{}]).map((y) => ({
      type: 'value',
      name: y.title,
      nameTextStyle: { color: theme.muted, fontFamily: theme.fontFamily, align: 'left' },
      splitLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.muted, fontFamily: theme.fontFamily, formatter: (v: number) => formatAxis(v, y.unit, y.unit === unit ? decimals : undefined) },
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
                // At the start of the line, on the chart's own background: the latest points sit at the
                // end, often near the watch level, and would run through the label there.
                label: { formatter: '{b}', color: theme.danger, fontFamily: theme.fontFamily, position: 'insideStartTop', backgroundColor: theme.surface, padding: [2, 4], borderRadius: 3 },
                data: markLines.map((m) => ({ yAxis: m.value, name: m.label })),
              }
            : undefined,
      };
    }),
  };
}

/**
 * The hover for one category: each series' value with what it means next to the others. Over time,
 * the change from the point before ("up 0.12 pts from Aug"); across branches or products, the gap
 * from their average ("0.30 pts above the average"). Plain text: the tooltip is richText (no HTML).
 */
export function tooltipLines(block: ChartBlock, fmt: (v: unknown) => string, clickable: boolean) {
  const { dataset, series, axes } = block.data;
  const unit = axes?.y?.[0]?.unit;
  const dims = dataset.dimensions.map((d) => d.name);
  const time = isTimeAxis(block);
  const pts = unit === 'percent';
  const diff = (now: number, then: number) => {
    const d = now - then;
    if (pts) return `${Math.abs(d).toFixed(2)} pts`;
    // Counts move by people or accounts ("up 12"); a percentage of 29,000 would read "0.0%".
    if (unit === 'count') return Math.abs(d) < 1 ? null : Math.round(Math.abs(d)).toLocaleString('en-US');
    if (!then) return null;
    const pct = Math.abs((d / Math.abs(then)) * 100);
    return `${pct.toFixed(pct < 0.1 ? 2 : 1)}%`;
  };
  return (raw: unknown) => {
    const list = (Array.isArray(raw) ? raw : [raw]) as { dataIndex: number; seriesIndex: number; name?: string }[];
    const first = list[0];
    if (!first) return '';
    const row = dataset.source[first.dataIndex] ?? [];
    const lines = [String(first.name ?? row[0] ?? '')];
    for (const p of list) {
      const s = series[p.seriesIndex];
      if (!s) continue;
      const at = dims.indexOf(s.encode.y);
      const v = row[at];
      let note = '';
      if (typeof v === 'number' && !s.comparison) {
        if (time && first.dataIndex > 0) {
          const before = dataset.source[first.dataIndex - 1]?.[at];
          const d = typeof before === 'number' ? diff(v, before) : null;
          if (d && v !== before) note = ` (${v > (before as number) ? 'up' : 'down'} ${d} from ${String(dataset.source[first.dataIndex - 1]?.[0] ?? 'before')})`;
        } else if (!time && dataset.source.length >= 3) {
          const all = dataset.source.map((r) => r[at]).filter((x): x is number => typeof x === 'number');
          const avg = all.reduce((a, b) => a + b, 0) / all.length;
          const d = diff(v, avg);
          if (d && Math.abs(v - avg) > 1e-9) note = ` (${d} ${v > avg ? 'above' : 'below'} the average)`;
        }
      }
      lines.push(`${series.length > 1 ? `${s.name}: ` : ''}${fmt(v)}${note}`);
    }
    if (clickable) lines.push('Click for more');
    return lines.join('\n');
  };
}
