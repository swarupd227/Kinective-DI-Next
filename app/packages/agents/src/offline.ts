// Degraded mode (spec 23.6.4): with no model available, simple data questions are still answered
// from the semantic layer by a deterministic planner. Answers say so, and nothing is guessed.
import type { CatalogResult, SemanticQueryInput, SemanticService } from '@dinext/semantic';
import { buildBlock, formatMetric, noticeBlock } from './answer.ts';
import type { RunSink } from './sink.ts';

export const OFFLINE_AGENT = 'Analytics Q&A (offline)';

/** Picks a metric, at most one dimension and a time window from the words in the question. */
export function planOffline(question: string, catalog: CatalogResult, svc: SemanticService): SemanticQueryInput | null {
  if (!catalog.matched) return null;
  const metric = svc.model.metrics[catalog.metrics[0]!.name]!;
  const q = question.toLowerCase();
  const quarters = /\bq[1-4]\b|quarter/.test(q);
  const trend = /trend|over time|by month|monthly|each month|last \d+ months|history/.test(q);
  const flow = metric.measures.some((m) => svc.model.measures[m]!.flow);
  const time = quarters ? { grain: 'quarter' as const, last: 2 } : trend ? { grain: 'month' as const, last: 6 } : flow ? { grain: 'month' as const, last: 1 } : undefined;
  if (time && metric.currentOnly) return null;
  const dimension = catalog.dimensions.find((d) => metric.dimensionsAllowed.includes(d.name))?.name;
  const filters = catalog.values
    .filter((v) => metric.dimensionsAllowed.includes(v.dimension) && v.dimension !== dimension)
    .slice(0, 1)
    .map((v) => ({ dimension: v.dimension, op: 'in' as const, values: [v.value] }));
  return { metrics: [metric.name], dimensions: dimension ? [dimension] : [], filters, time, order: dimension && !time ? [{ field: metric.name, dir: 'desc' }] : [], limit: 50 };
}

export async function runOffline(question: string, svc: SemanticService, ctx: { purviewBranches?: string[]; canViewSql: boolean }, runId: string, sink: RunSink) {
  sink.routing(OFFLINE_AGENT, 'Language model unavailable: deterministic planner');
  const catalog = svc.search(question);
  const request = planOffline(question, catalog, svc);
  if (!request) {
    await sink.block(noticeBlock('uncertain', 'I couldn’t map that question to a defined metric, so I won’t guess.', OFFLINE_AGENT, runId, { detail: 'Live AI is off in this environment, so only simple questions about defined metrics can be answered. Set DI_ANTHROPIC_API_KEY in app/.env to turn it on.' }));
    return { outcome: 'unmatched' as const, catalog };
  }
  const result = await svc.query(request, ctx);
  const results = new Map([['r1', result]]);
  const metric = result.columns.find((c) => c.kind === 'metric')!;
  const dim = result.columns.find((c) => c.kind === 'dimension');
  const hasPeriod = result.columns.some((c) => c.kind === 'period');
  const first = result.rows[0];
  const summary = !first
    ? `No rows matched.`
    : dim && !hasPeriod
      ? `**${metric.label}** by ${dim.label.toLowerCase()}: **${first[dim.key]}** is highest at **${formatMetric(Number(first[metric.key]), metric.format!)}**.`
      : hasPeriod
        ? `**${metric.label}** for ${result.periods![0]!.label} to ${result.periods![result.periods!.length - 1]!.label}.`
        : `**${metric.label}** is **${formatMetric(Number(first[metric.key]), metric.format!)}**.`;
  await sink.text(summary, OFFLINE_AGENT, [{ kind: 'metric', label: `${metric.label} (definition)`, ref: `metric:${metric.key}` }]);
  if (result.rows.length > 1) {
    const x = hasPeriod && !dim ? 'period' : dim!.key;
    await sink.block(buildBlock({ type: 'chart', result: 'r1', chart: hasPeriod && !dim ? 'line' : 'bar', x, series_by: hasPeriod && dim ? 'period' : undefined, title: `${metric.label}${dim ? ` by ${dim.label.toLowerCase()}` : ''}` }, results, new Map(), OFFLINE_AGENT, runId));
    await sink.block(buildBlock({ type: 'table', result: 'r1', title: metric.label }, results, new Map(), OFFLINE_AGENT, runId));
  }
  await sink.block(noticeBlock('info', 'Answered by the offline planner: live AI is off in this environment.', OFFLINE_AGENT, runId, { detail: 'Figures come from the semantic layer as usual. Set DI_ANTHROPIC_API_KEY in app/.env for full conversational answers and follow-ups.' }));
  return { outcome: 'answer' as const, catalog, request };
}
