// What clicking a bar or point offers. Each choice is a follow-up question for the conversation, so
// the agent that owns the figures does the drilling and explaining; the chart itself never queries.
import type { BlockAction, ChartBlock } from '@dinext/block-schemas';
import { formatValue } from '../format.ts';

export interface ChartPoint {
  /** The category clicked: a branch, a product, a month. */
  x: string;
  /** The series clicked (or the first one), and its value at that category. */
  series: string;
  value: number | null;
}

export interface PointChoice {
  id: string;
  kind: 'drill' | 'why' | 'rows';
  label: string;
  question: string;
}

const MONTHS = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|^\d{4}-\d{2}|^q[1-4]\b|\b(?:19|20)\d{2}\b/i;

/** Whether the categories run along time (months, quarters, years) rather than branches or products. */
export function isTimeAxis(block: ChartBlock): boolean {
  const xDim = block.data.dataset.dimensions.find((d) => d.name === block.data.series[0]?.encode.x);
  if (xDim?.type === 'time') return true;
  if (/\b(?:month|period|quarter|year|date|week)\b/i.test(xDim?.displayName ?? '')) return true;
  const xs = block.data.dataset.source.slice(0, 6).map((r) => String(r[0] ?? ''));
  return xs.length > 0 && xs.every((x) => MONTHS.test(x));
}

/** The figure's name: the y axis title, else the series clicked (unless it names a period). */
function metricName(block: ChartBlock, point: ChartPoint): string {
  const y = block.data.axes?.y?.[0]?.title;
  const name = y ?? (MONTHS.test(point.series) ? block.title ?? 'this figure' : point.series);
  return name.replace(/\s*\(.*\)$/, '');
}

export function formatPoint(block: ChartBlock, value: number | null): string {
  if (value === null) return 'no value';
  return formatValue(value, block.data.axes?.y?.[0]?.unit ?? 'number', { decimals: block.data.axes?.y?.[0]?.unit === 'percent' ? 2 : undefined });
}

const fill = (template: string, point: ChartPoint, valueText: string) => template.replaceAll('{x}', point.x).replaceAll('{value}', valueText);

/**
 * The choices for one click: the agent's own (pointActions) when it sent them, else "Why?" and a
 * breakdown in general words, plus the records behind the figure when the block offers them.
 */
export function pointMenu(block: ChartBlock, point: ChartPoint, drill?: BlockAction): PointChoice[] {
  const valueText = formatPoint(block, point.value);
  if (block.data.pointActions?.length) {
    return block.data.pointActions.map((a) => ({ id: a.id, kind: a.kind, label: fill(a.label, point, valueText).slice(0, 60), question: fill(a.question, point, valueText) }));
  }
  const metric = metricName(block, point);
  // "Delinquency 60+" reads "delinquency 60+" mid-sentence; "NIM" and "ROA" keep their capitals.
  const lower = /^[A-Z][a-z]/.test(metric) ? metric.charAt(0).toLowerCase() + metric.slice(1) : metric;
  const time = isTimeAxis(block);
  const choices: PointChoice[] = [];
  if (drill) {
    const q = typeof drill.params?.question === 'string' ? `${drill.params.question} for ${point.x}` : `Drill into ${point.x}`;
    choices.push({ id: 'drill', kind: 'drill', label: `Drill into ${point.x}`.slice(0, 60), question: q });
  } else {
    choices.push(
      time
        ? { id: 'drill', kind: 'drill', label: `${point.x} by branch`.slice(0, 60), question: `Show ${lower} by branch for ${point.x}` }
        : { id: 'drill', kind: 'drill', label: `Break down ${point.x}`.slice(0, 60), question: `Break down ${lower} for ${point.x}` },
    );
  }
  choices.push(
    time
      ? { id: 'why', kind: 'why', label: `Why did it move in ${point.x}?`.slice(0, 60), question: `Why did ${lower} change in ${point.x}?` }
      : { id: 'why', kind: 'why', label: `Why is ${point.x} at ${valueText}?`.slice(0, 60), question: `Why is ${lower} ${valueText} for ${point.x}?` },
  );
  const records = block.actions?.find((a) => a.id === 'records' && typeof a.params?.question === 'string');
  if (records) {
    const q = String(records.params!.question);
    choices.push({ id: 'rows', kind: 'rows', label: records.label.replace(/\bit\b/, point.x).slice(0, 60), question: / for /.test(q) ? `${q}, ${point.x}` : `${q} for ${point.x}` });
  }
  return choices;
}

/** The click as a follow-up: the host sends the question with the chart attached. */
export const asAction = (c: PointChoice): BlockAction => ({ id: `point:${c.id}`, kind: 'ask_followup', label: c.label.slice(0, 40), params: { question: c.question } });
