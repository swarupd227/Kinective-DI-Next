// Grounded answer composition (spec 24.4 "Compose", 26.6 grounding, 26.7 numeric verification).
// The agent never types figures. It submits a narrative with {{placeholders}} bound to result cells
// and derived operations; code computes and formats every number, builds every chart and table
// from the full server-side results, and strips any sentence with a number it cannot verify.
import { z } from 'zod';
import type { Block, ChartBlock, DefinitionCardBlock, KpiBlock, NoticeBlock, TableBlock } from '@dinext/block-schemas';
import type { MetricDefinition, MetricFormat, ResultRow, SemanticResult } from '@dinext/semantic';

const refId = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/);
const where = z.record(z.string(), z.string()).default({});

export const Ref = z
  .object({
    id: refId.describe('Placeholder name used as {{id}} in the narrative.'),
    result: z.string().describe('Result ID returned by semantic_query, e.g. "r1".'),
    metric: z.string().describe('Metric column in that result.'),
    op: z
      .enum(['value', 'sum', 'average', 'max', 'min', 'count', 'change', 'pct_change', 'share'])
      .default('value')
      .describe('value: one row. sum/average/max/min/count: over matching rows. change, pct_change: "where" minus "compare_to". share: "where" as a percent of "compare_to" (all rows in the same period by default).'),
    where: where.describe('Row selector: dimension or "period" to value, e.g. {"branch": "Westport", "period": "Q3 2026"}. Empty selects all rows.'),
    compare_to: where.optional().describe('Second selector for change, pct_change and share.'),
    up: z.string().max(30).optional().describe('For change and pct_change: the word for an increase, e.g. "rose". Code picks up or down from the actual sign.'),
    down: z.string().max(30).optional().describe('The word for a decrease, e.g. "fell".'),
  })
  .strict();

const BlockSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chart'), result: z.string(), chart: z.enum(['bar', 'line', 'stacked_bar', 'donut']), x: z.string().describe('Dimension key or "period".'), series_by: z.string().optional().describe('A second dimension key or "period" to split series by.'), metric: z.string().optional(), title: z.string().max(100), subtitle: z.string().max(140).optional() }).strict(),
  z.object({ type: z.literal('table'), result: z.string(), title: z.string().max(100) }).strict(),
  z.object({ type: z.literal('kpi'), result: z.string(), metric: z.string(), where: where, compare_to: where.optional(), title: z.string().max(100).optional() }).strict(),
  z.object({ type: z.literal('definition'), metric: z.string() }).strict(),
]);
export type BlockSpec = z.infer<typeof BlockSpec>;

export const SubmitAnswer = z
  .object({
    outcome: z.enum(['answer', 'unmatched', 'clarify', 'not_supported', 'no_access']).describe('no_access when semantic_query returned NO_ACCESS: the item is outside the user’s access, nothing more.'),
    narrative: z.string().max(1500).describe('1-3 short sentences in Markdown. Every figure is a {{placeholder}}; never type digits for institution data.'),
    refs: z.array(Ref).max(12).default([]),
    blocks: z.array(BlockSpec).max(4).default([]),
    suggestion: z.string().max(140).optional().describe('One follow-up question the user might ask next.'),
    options: z.array(z.string().max(80)).max(3).default([]).describe('For clarify or unmatched: questions the user can pick instead.'),
    spoken: z.string().max(300).optional().describe('Up to 2 sentences for voice, with the same placeholders.'),
  })
  .strict();
export type SubmitAnswer = z.infer<typeof SubmitAnswer>;

// ---- formatting (AI-GRD-062: by code, in the tenant's locale) ---------------------------------

const LOCALE = 'en-US';
export function formatMetric(value: number | null, format: MetricFormat | 'percent_point' | 'bp' | 'pct', compactCurrency = true): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  switch (format) {
    case 'currency': {
      const abs = Math.abs(value);
      const compact = compactCurrency && abs >= 10_000;
      return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? (abs >= 1e9 ? 2 : 1) : 0 }).format(value);
    }
    case 'count':
      return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value);
    case 'percent_1':
    case 'pct':
      return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(value)}%`;
    case 'percent_2':
      return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value)}%`;
    case 'rate':
      return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value)}%`;
    case 'bp':
      return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value)} bp`;
    case 'percent_point':
      return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 }).format(value)} pts`;
  }
}

const isPercent = (f: MetricFormat) => f === 'percent_1' || f === 'percent_2' || f === 'rate';

// ---- reference evaluation ---------------------------------------------------------------------

export class AnswerError extends Error {}

function select(result: SemanticResult, sel: Record<string, string>) {
  const keys = Object.keys(sel);
  for (const k of keys) if (!result.columns.some((c) => c.key === k && c.kind !== 'metric')) throw new AnswerError(`"${k}" is not a dimension of ${result.queryId}`);
  return result.rows.filter((r) => keys.every((k) => String(r[k]).toLowerCase() === sel[k]!.toLowerCase()));
}

function aggregate(rows: ResultRow[], metric: string, fmt: MetricFormat, how: 'one' | 'sum') {
  if (!rows.length) throw new AnswerError('No row matches that selector');
  if (how === 'one' || isPercent(fmt)) {
    if (rows.length !== 1) throw new AnswerError(`${rows.length} rows match; narrow the selector to one row`);
    return Number(rows[0]![metric]);
  }
  return rows.reduce((s, r) => s + Number(r[metric] ?? 0), 0);
}

export interface Resolved {
  id: string;
  text: string;
  value: number;
}

export function resolveRef(ref: z.infer<typeof Ref>, results: Map<string, SemanticResult>): Resolved {
  const result = results.get(ref.result);
  if (!result) throw new AnswerError(`Unknown result ${ref.result}`);
  const col = result.columns.find((c) => c.key === ref.metric && c.kind === 'metric');
  if (!col?.format) throw new AnswerError(`${ref.metric} is not a metric in ${ref.result}`);
  const fmt = col.format;
  const rows = select(result, ref.where);
  const directional = (v: number, text: string) => {
    if (!ref.up || !ref.down) return text;
    return v === 0 ? `was unchanged at` : `${v > 0 ? ref.up : ref.down} ${text}`;
  };
  switch (ref.op) {
    case 'value': {
      const v = aggregate(rows, ref.metric, fmt, 'one');
      return { id: ref.id, value: v, text: formatMetric(v, fmt) };
    }
    case 'sum': {
      const v = aggregate(rows, ref.metric, fmt, 'sum');
      return { id: ref.id, value: v, text: formatMetric(v, fmt) };
    }
    case 'average': {
      if (!rows.length) throw new AnswerError('No row matches that selector');
      const v = rows.reduce((s, r) => s + Number(r[ref.metric] ?? 0), 0) / rows.length;
      return { id: ref.id, value: v, text: formatMetric(v, fmt) };
    }
    case 'max':
    case 'min': {
      if (!rows.length) throw new AnswerError('No row matches that selector');
      const vals = rows.map((r) => Number(r[ref.metric]));
      const v = ref.op === 'max' ? Math.max(...vals) : Math.min(...vals);
      return { id: ref.id, value: v, text: formatMetric(v, fmt) };
    }
    case 'count':
      return { id: ref.id, value: rows.length, text: formatMetric(rows.length, 'count') };
    case 'change': {
      if (!ref.compare_to) throw new AnswerError('change needs compare_to');
      const a = aggregate(rows, ref.metric, fmt, 'sum');
      const b = aggregate(select(result, ref.compare_to), ref.metric, fmt, 'sum');
      const d = a - b;
      // Changes in a rate are reported in basis points (spec 10.4 units: "bp").
      return { id: ref.id, value: d, text: directional(d, isPercent(fmt) ? formatMetric(Math.abs(d) * 100, 'bp') : formatMetric(Math.abs(d), fmt)) };
    }
    case 'pct_change': {
      if (!ref.compare_to) throw new AnswerError('pct_change needs compare_to');
      const a = aggregate(rows, ref.metric, fmt, 'sum');
      const b = aggregate(select(result, ref.compare_to), ref.metric, fmt, 'sum');
      if (!b) throw new AnswerError('Cannot compute a percent change from zero');
      const p = ((a - b) / Math.abs(b)) * 100;
      return { id: ref.id, value: p, text: directional(p, formatMetric(Math.abs(p), 'pct')) };
    }
    case 'share': {
      if (isPercent(fmt)) throw new AnswerError('A share of a ratio is not meaningful');
      const part = aggregate(rows, ref.metric, fmt, 'sum');
      const scope = ref.compare_to ?? (ref.where.period ? { period: ref.where.period } : {});
      const whole = aggregate(select(result, scope), ref.metric, fmt, 'sum');
      if (!whole) throw new AnswerError('Cannot compute a share of zero');
      const p = (part / whole) * 100;
      return { id: ref.id, value: p, text: formatMetric(p, 'pct') };
    }
  }
}

// ---- verification -----------------------------------------------------------------------------

export interface Verified {
  text: string;
  /** Sentences removed because they held a number no result backs (AI-GRD-061). */
  removed: string[];
  unresolved: string[];
}

/**
 * Substitutes placeholders and removes any sentence that still contains a figure the results do
 * not back. Allowed bare numbers are those in result labels (periods, names) and the question.
 */
export function verifyNarrative(template: string, resolved: Map<string, Resolved>, allowedText: string[]): Verified {
  const allowed = new Set(allowedText.flatMap((t) => t.match(/\d+(?:\.\d+)?/g) ?? []));
  const sentences = template.split(/(?<=[.!?])\s+(?=[A-Z*_])/);
  const removed: string[] = [];
  const unresolved: string[] = [];
  const kept = sentences.filter((s) => {
    const withoutPlaceholders = s.replace(/\{\{\s*[a-z][a-z0-9_]*\s*\}\}/g, '');
    const bare = (withoutPlaceholders.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));
    const missing = [...s.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!).filter((id) => !resolved.has(id));
    if (missing.length) {
      unresolved.push(...missing);
      removed.push(s);
      return false;
    }
    if (bare.some((n) => !allowed.has(n))) {
      removed.push(s);
      return false;
    }
    return true;
  });
  const text = kept
    .join(' ')
    .replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, id: string) => resolved.get(id)!.text)
    .trim();
  return { text, removed, unresolved };
}

// ---- blocks -----------------------------------------------------------------------------------

let counter = 0;
export const newBlockId = (prefix: string) => `blk_${prefix}${Date.now().toString(36)}${(counter++).toString(36).padStart(4, '0')}`.slice(0, 32).padEnd(16, '0');

const TABLE_LABELS: Record<string, string> = {
  cdm_loan: 'Loan Accounts',
  cdm_deposit_account: 'Deposit Accounts',
  cdm_party: 'Members',
  hist_loan_month: 'Loan history (month-end)',
  hist_deposit_month: 'Deposit history (month-end)',
  hist_party_month: 'Member history (month-end)',
};
const TABLE_ROUTES: Record<string, string> = { cdm_loan: 'loan_accounts', cdm_deposit_account: 'deposit_accounts' };

function provenance(results: SemanticResult[], agent: string, runId: string, definitions: Map<string, MetricDefinition>) {
  const sources: Block['provenance']['sources'] = [];
  const seen = new Set<string>();
  for (const r of results) {
    for (const l of r.lineage) {
      const key = `metric:${l.metric}`;
      if (!seen.has(key)) {
        seen.add(key);
        const label = definitions.get(l.metric)?.label ?? r.columns.find((c) => c.key === l.metric)?.label ?? l.metric;
        sources.push({ kind: 'metric', label: `${label} (definition)`, ref: key });
      }
      for (const t of l.tables) {
        if (!TABLE_LABELS[t] || seen.has(t)) continue;
        seen.add(t);
        sources.push({ kind: 'table', label: TABLE_LABELS[t]!, ref: TABLE_ROUTES[t] ? `table:${TABLE_ROUTES[t]}` : undefined });
      }
    }
  }
  return {
    agent,
    runId,
    operations: ['semantic.query'],
    sources: sources.slice(0, 20),
    filters: [...new Set(results.flatMap((r) => r.filtersApplied))],
    purviewApplied: results.some((r) => r.filtersApplied.some((f) => f.startsWith('Limited to your purview'))),
    semanticQueryId: results[0]?.queryId,
  };
}

/** Build completion is recorded in the tenant's local time (Eastern for both synthetic tenants). */
export const TENANT_UTC_OFFSET = '-04:00';
const freshness = (r: SemanticResult): Block['freshness'] => ({ kind: 'nightly_build', asOf: `${r.build.completedAt}${TENANT_UTC_OFFSET}`, buildId: r.build.buildId });

const unitOf = (f: MetricFormat) => (f === 'currency' ? 'currency' : f === 'count' ? 'count' : 'percent');

const blockActions = (): Block['actions'] => [
  { id: 'explain', kind: 'explain', label: 'Explain' },
  { id: 'open', kind: 'open_workspace', label: 'Open grid' },
  { id: 'pin', kind: 'pin', label: 'Pin', riskTier: 'low' },
  { id: 'export', kind: 'export', label: 'Export' },
];

export function buildBlock(spec: BlockSpec, results: Map<string, SemanticResult>, definitions: Map<string, MetricDefinition>, agent: string, runId: string): Block {
  if (spec.type === 'definition') {
    const d = definitions.get(spec.metric);
    if (!d) throw new AnswerError(`No definition loaded for ${spec.metric}; call semantic_metric_get first`);
    const block: DefinitionCardBlock = {
      id: newBlockId('def'),
      type: 'definition_card',
      version: '1.0.0',
      title: `${d.label}: definition`,
      provenance: { agent, runId, operations: ['semantic.metric.get'], sources: [{ kind: 'metric', label: d.label, ref: `metric:${d.name}` }] },
      freshness: { kind: 'static' },
      actions: [{ id: 'trace', kind: 'ask_followup', label: 'Trace to source', params: { question: `Trace ${d.label} to its source tables` } }],
      data: { term: d.label, metricRef: d.name, definition: d.description, formula: d.formula, regulatoryBasis: d.regulatoryBasis, owner: d.owner, version: d.version, dimensions: d.dimensionsAllowed, trendable: d.trendable },
    };
    return block;
  }
  const result = results.get(spec.result);
  if (!result) throw new AnswerError(`Unknown result ${spec.result}`);
  const prov = provenance([result], agent, runId, definitions);
  const metricCols = result.columns.filter((c) => c.kind === 'metric');

  if (spec.type === 'table') {
    const block: TableBlock = {
      id: newBlockId('tbl'),
      type: 'table',
      version: '1.0.0',
      title: spec.title,
      provenance: prov,
      freshness: freshness(result),
      actions: blockActions(),
      data: {
        columns: result.columns.map((c, i) => ({
          field: c.key,
          headerName: c.label,
          type: c.kind === 'metric' ? (c.format === 'currency' ? 'currency' : c.format === 'count' ? 'count' : 'percent') : 'text',
          pinned: i === 0 && c.kind !== 'metric' ? ('left' as const) : undefined,
        })),
        rows: result.rows.slice(0, 500),
        rowCount: result.rowCount,
      },
    };
    return block;
  }

  if (spec.type === 'kpi') {
    const col = metricCols.find((c) => c.key === spec.metric);
    if (!col?.format) throw new AnswerError(`${spec.metric} is not in ${spec.result}`);
    const rows = select(result, spec.where);
    const value = aggregate(rows, spec.metric, col.format, 'sum');
    let comparison: KpiBlock['data']['comparison'];
    if (spec.compare_to) {
      const before = aggregate(select(result, spec.compare_to), spec.metric, col.format, 'sum');
      const pct = isPercent(col.format);
      const change = pct ? (value - before) * 100 : before ? ((value - before) / Math.abs(before)) * 100 : 0;
      comparison = {
        label: `vs ${Object.values(spec.compare_to).join(' ')}`,
        value: Math.round(change * 10) / 10,
        unit: pct ? 'bp' : 'percent',
        direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
        goodWhen: /delinquen/.test(spec.metric) ? 'down' : 'up',
      };
    }
    const block: KpiBlock = {
      id: newBlockId('kpi'),
      type: 'kpi',
      version: '1.0.0',
      title: spec.title,
      provenance: prov,
      freshness: freshness(result),
      actions: [{ id: 'explain', kind: 'explain', label: 'Explain' }, { id: 'pin', kind: 'pin', label: 'Pin', riskTier: 'low' }],
      data: { label: col.label, value, unit: unitOf(col.format), format: col.format === 'currency' ? { compact: true, decimals: 2 } : { decimals: col.format === 'percent_1' ? 1 : 2 }, comparison, metricRef: `metric:${spec.metric}` },
    };
    return block;
  }

  // Chart: x along one dimension (or period), series per metric or per a second dimension.
  const metric = spec.metric ?? metricCols[0]!.key;
  const col = metricCols.find((c) => c.key === metric);
  if (!col?.format) throw new AnswerError(`${metric} is not in ${spec.result}`);
  const xCol = result.columns.find((c) => c.key === spec.x && c.kind !== 'metric');
  if (!xCol) throw new AnswerError(`"${spec.x}" is not a dimension of ${spec.result}`);
  const xValues = [...new Set(result.rows.map((r) => String(r[spec.x])))];
  let dimensions: ChartBlock['data']['dataset']['dimensions'];
  let source: (string | number | null)[][];
  let series: ChartBlock['data']['series'];
  if (spec.series_by) {
    const sCol = result.columns.find((c) => c.key === spec.series_by && c.kind !== 'metric');
    if (!sCol) throw new AnswerError(`"${spec.series_by}" is not a dimension of ${spec.result}`);
    const sValues = [...new Set(result.rows.map((r) => String(r[spec.series_by!])))].slice(0, 8);
    dimensions = [{ name: 'x', displayName: xCol.label, type: 'ordinal' }, ...sValues.map((s, i) => ({ name: `s${i}`, displayName: s }))];
    source = xValues.map((x) => [x, ...sValues.map((s) => (result.rows.find((r) => String(r[spec.x]) === x && String(r[spec.series_by!]) === s)?.[metric] as number | undefined) ?? null)]);
    // Earlier periods draw as the prior-period style (spec 10.4).
    series = sValues.map((s, i) => ({ name: s, encode: { x: 'x', y: `s${i}` }, comparison: spec.series_by === 'period' && i < sValues.length - 1 }));
  } else {
    dimensions = [{ name: 'x', displayName: xCol.label, type: 'ordinal' }, { name: 'y', displayName: col.label }];
    source = xValues.map((x) => [x, (result.rows.find((r) => String(r[spec.x]) === x)?.[metric] as number | undefined) ?? null]);
    series = [{ name: col.label, encode: { x: 'x', y: 'y' } }];
  }
  const values = source.flatMap((r) => r.slice(1)).filter((v): v is number => typeof v === 'number');
  const block: ChartBlock = {
    id: newBlockId('cht'),
    type: 'chart',
    version: '2.0.0',
    title: spec.title,
    subtitle: spec.subtitle,
    provenance: prov,
    freshness: freshness(result),
    actions: blockActions(),
    a11y: {
      summary: `${spec.chart === 'line' ? 'Line' : spec.chart === 'donut' ? 'Donut' : 'Bar'} chart of ${col.label.toLowerCase()} by ${xCol.label.toLowerCase()}${spec.series_by ? `, split by ${spec.series_by}` : ''}. Values range from ${formatMetric(Math.min(...values), col.format)} to ${formatMetric(Math.max(...values), col.format)}. Switch to the table view for every value.`.slice(0, 600),
    },
    data: { chartType: spec.chart, dataset: { dimensions, source }, series, axes: { y: [{ title: col.label, unit: unitOf(col.format) }] }, legend: series.length > 1 },
  };
  return block;
}

export function noticeBlock(kind: NoticeBlock['data']['kind'], message: string, agent: string, runId: string, extra: Partial<NoticeBlock['data']> = {}): NoticeBlock {
  return { id: newBlockId('ntc'), type: 'notice', version: '1.0.0', provenance: { agent, runId, sources: [] }, freshness: { kind: 'none' }, data: { kind, message, ...extra } };
}

/** Labels and values in results that may legitimately appear as bare numbers in text. */
export function allowedNumberSources(results: SemanticResult[], question: string): string[] {
  return [question, ...results.flatMap((r) => [...r.columns.map((c) => c.label), ...r.rows.flatMap((row) => r.columns.filter((c) => c.kind !== 'metric').map((c) => String(row[c.key])))])];
}
