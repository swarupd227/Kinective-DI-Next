// Report engine and report tool gateway (spec 8.5–8.9, 18, 24.5). A report definition plus control
// values becomes a report_canvas whose widgets are ordinary kpi, chart and table blocks built by code
// from semantic queries, under the user's purview. Saving, scheduling and exporting are writes: the
// gateway returns approval_required, and only the approved payload runs, once.
import { z } from 'zod';
import type { ApprovalCardBlock, Block, DiTake, ReportCanvasBlock, ReportControl, ReportWidgetView } from '@dinext/block-schemas';
import { ApprovalStore, CoreError, DELIVERY_GROUPS, SCHEDULE_RECIPIENT_CAP, type ApprovalRecord, type PinDraft, type Recipient, type ReportStore, type RiskTier, type ScheduleDraft, type ScheduleRow, type SettingsPayload, type ShareDraft, type TemplateRow } from '@dinext/di-core';
import { SemanticError, type SemanticService } from '@dinext/semantic';
import type { ReportDefinition, ReportWidget, WidgetSize } from '@dinext/tenant-db';
import { buildBlock, newBlockId, noticeBlock, type BlockSpec } from './answer.ts';
import { effectiveTier, reservedKeys, type ToolDef } from './gateway.ts';
import { applySettings, fieldsFrom, settingsDiff, settingsView, type SettingsInput } from './reportSettings.ts';

export const REPORT_AGENT = 'Report Builder';

// ---- periods and controls (spec 18.3) ---------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const shift = (y: number, m: number, by: number) => {
  const t = y * 12 + (m - 1) + by;
  return [Math.floor(t / 12), (t % 12) + 1] as const;
};

/** Complete periods, newest first: 13 months or 6 quarters ending at the build's last month-end. */
export function periodOptions(type: 'month' | 'quarter', latestMonthEnd: string) {
  const [y, m] = latestMonthEnd.split('-').map(Number) as [number, number];
  if (type === 'month') return Array.from({ length: 13 }, (_, i) => shift(y, m, -i)).map(([yy, mm]) => ({ value: ym(yy, mm), label: `${MONTHS[mm - 1]} ${yy}` }));
  let q = Math.floor(m / 3);
  let qy = y;
  if (q === 0) [qy, q] = [y - 1, 4];
  return Array.from({ length: 6 }, (_, i) => {
    const t = qy * 4 + (q - 1) - i;
    return { value: `${Math.floor(t / 4)}-Q${(t % 4) + 1}`, label: `Q${(t % 4) + 1} ${Math.floor(t / 4)}` };
  });
}

/** The semantic time range for `span` periods ending at `period`. */
export function timeFor(type: 'month' | 'quarter', period: string, span = 1) {
  if (type === 'month') {
    const [y, m] = period.split('-').map(Number) as [number, number];
    const [fy, fm] = shift(y, m, -(span - 1));
    return { grain: 'month' as const, from: ym(fy, fm), to: period };
  }
  const [y, q] = [Number(period.slice(0, 4)), Number(period.slice(-1))];
  const [ty, tm] = [y, q * 3];
  const [fy, fm] = shift(ty, tm, -(span * 3 - 1));
  return { grain: 'quarter' as const, from: ym(fy, fm), to: ym(ty, tm) };
}

/** Reads "September", "Sep 2026", "last month", "Q2" or "2026-09" as a period value of the given type. */
export function parsePeriod(text: string, type: 'month' | 'quarter', latestMonthEnd: string): string | undefined {
  const opts = periodOptions(type, latestMonthEnd);
  const t = text.toLowerCase();
  if (/\b(last|previous) (month|quarter)\b/.test(t)) return opts[0]!.value;
  const direct = /\b(\d{4})-(\d{2}|q[1-4])\b/i.exec(text)?.[0]?.toUpperCase().replace('-Q', '-Q');
  if (direct && opts.some((o) => o.value === direct)) return direct;
  if (type === 'quarter') {
    const q = /\bq([1-4])\b(?:\s*(\d{4}))?/i.exec(text);
    if (q) return opts.find((o) => o.label === `Q${q[1]} ${q[2] ?? ''}`.trim() || (!q[2] && o.label.startsWith(`Q${q[1]} `)))?.value;
    return undefined;
  }
  const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const i = names.findIndex((n) => new RegExp(`\\b(${n}|${n.slice(0, 3)})\\b`).test(t));
  if (i < 0) return undefined;
  const year = /\b(20\d{2})\b/.exec(t)?.[1];
  return opts.find((o) => o.label.startsWith(MONTHS[i]!) && (!year || o.label.endsWith(year)))?.value;
}

export interface ReportControls {
  period?: string;
  node?: string;
}

export interface RunContext {
  purviewBranches?: string[];
  canViewSql: boolean;
  /** The person's user class: a saved report limited to some classes opens only for them. */
  userClass?: string;
}

const SIZE_W: Record<WidgetSize, number> = { quarter: 3, third: 4, half: 6, full: 12 };
const HEIGHT: Record<ReportWidget['kind'], number> = { kpi: 2, chart: 4, table: 4, text: 2 };

/** Widgets flow left to right on a 12-column grid (spec 8.9). */
export function layout(widgets: ReportWidget[]) {
  let x = 0;
  let y = 0;
  let rowH = 0;
  return widgets.map((w) => {
    const width = SIZE_W[w.size];
    if (x + width > 12) {
      y += rowH;
      x = 0;
      rowH = 0;
    }
    const pos = { x, y, w: width, h: HEIGHT[w.kind] };
    x += width;
    rowH = Math.max(rowH, pos.h);
    return pos;
  });
}

/** Resolves control values against the build and the user's purview (spec 18.3, FE-RPTP-003). */
export function resolveControls(def: ReportDefinition, input: ReportControls, svc: SemanticService, ctx: RunContext) {
  const periods = periodOptions(def.settings.periodType, svc.build.latestMonthEnd);
  let notice: string | undefined;
  let period = input.period ?? periods[def.settings.usePeriod === 'previous' ? 1 : 0]!.value;
  if (!periods.some((p) => p.value === period)) {
    notice = `${input.period} has not been built yet. Showing ${periods[0]!.label}, the latest complete ${def.settings.periodType}.`;
    period = periods[0]!.value;
  }
  // Hierarchy: nodes within the viewer's purview; the default is the user's own location (spec 18.3).
  const branches = ctx.purviewBranches ?? svc.dimensionValues.branch ?? [];
  const nodes = [...(ctx.purviewBranches ? [] : [{ value: 'all', label: 'All branches' }]), ...branches.map((b) => ({ value: b, label: b }))];
  const allowed = !input.node || nodes.some((n) => n.value === input.node);
  // A branch outside the purview is never run; the report says which one it shows instead (spec 20.7).
  if (!allowed) notice = `${input.node} is outside your access. Showing ${nodes[0]!.label}.`;
  const node = input.node && allowed ? input.node : nodes[0]!.value;
  const controls: ReportControl[] = [{ id: 'period', kind: 'period', label: def.settings.periodType === 'month' ? 'Month' : 'Quarter', value: period, options: periods }];
  if (def.settings.addHierarchyControls) controls.push({ id: 'node', kind: 'hierarchy', label: 'Branch', value: node, options: nodes });
  return { period, node: def.settings.addHierarchyControls ? node : ctx.purviewBranches ? branches[0]! : 'all', controls, notice, periodLabel: periods.find((p) => p.value === period)!.label };
}

/** One widget's block. A failure becomes a notice in its place; the rest of the report still runs. */
async function widgetBlock(w: ReportWidget, def: ReportDefinition, c: { period: string; node: string }, svc: SemanticService, ctx: RunContext, runId: string): Promise<{ block: Block; sql?: string[] }> {
  const type = def.settings.periodType;
  const filters = [...(c.node !== 'all' ? [{ dimension: 'branch', op: 'in' as const, values: [c.node] }] : []), ...(w.where ? [{ dimension: w.where.dimension, op: 'in' as const, values: w.where.values }] : [])];
  const scope = c.node === 'all' ? '' : ` · ${c.node}`;
  try {
    if (w.kind === 'text') {
      return { block: { id: newBlockId('rtx'), type: 'text', version: '1.0.0', provenance: { agent: REPORT_AGENT, runId, sources: [] }, freshness: { kind: 'static' }, data: { markdown: w.text ?? '' } } };
    }
    const metric = w.metrics[0]!;
    if (!svc.model.metrics[metric]) throw new SemanticError('UNKNOWN_METRIC', `“${metric}” is not defined in the semantic layer.`);
    const results = new Map();
    let spec: BlockSpec;
    if (w.kind === 'kpi') {
      let r;
      try {
        r = await svc.query({ metrics: [metric], filters, time: timeFor(type, c.period, w.compare ? 2 : 1) }, ctx);
      } catch (e) {
        // Measures without month-end history show their value as of the build.
        if (!(e instanceof SemanticError) || e.code !== 'CURRENT_ONLY') throw e;
        r = await svc.query({ metrics: [metric], filters }, ctx);
      }
      results.set('r', r);
      const labels = (r.periods ?? []).map((p) => p.label);
      const cur = labels.at(-1);
      spec = { type: 'kpi', result: 'r', metric, where: cur ? { period: cur } : {}, compare_to: w.compare && labels.length > 1 ? { period: labels.at(-2)! } : undefined, title: w.title };
    } else if (w.kind === 'chart' && w.trend) {
      results.set('r', await svc.query({ metrics: [metric], dimensions: w.by ? [w.by] : [], filters, time: timeFor(type, c.period, w.trend), limit: 500 }, ctx));
      spec = { type: 'chart', result: 'r', chart: w.chart ?? 'line', x: 'period', series_by: w.by, metric, title: w.title };
    } else {
      const r = await svc.query({ metrics: w.kind === 'table' ? w.metrics.slice(0, 4) : [metric], dimensions: w.by ? [w.by] : [], filters, time: timeFor(type, c.period, 1), limit: 500 }, ctx);
      results.set('r', r);
      spec = w.kind === 'table' ? { type: 'table', result: 'r', title: w.title } : { type: 'chart', result: 'r', chart: w.chart ?? 'bar', x: w.by ?? 'period', metric, title: w.title };
    }
    const block = buildBlock(spec, results, new Map(), REPORT_AGENT, runId);
    // Pin and export belong to the whole report; a widget keeps Explain and Open grid.
    const actions = (block.actions ?? []).filter((a) => a.kind === 'explain' || a.kind === 'open_workspace');
    return { block: { ...block, title: `${w.title}${scope && w.kind !== 'kpi' ? scope : ''}`, actions } as Block, sql: results.get('r')?.sql };
  } catch (e) {
    if (!(e instanceof SemanticError)) throw e;
    const missing = e.code === 'UNKNOWN_METRIC';
    // A measure that is not in the catalog is marked "not defined", never invented (spec 24.5).
    const n = noticeBlock(e.code === 'NO_ACCESS' ? 'no_access' : missing ? 'not_supported' : 'no_data', missing ? `${w.title}: not defined` : `${w.title} is not available here`, REPORT_AGENT, runId, { detail: missing ? `${e.message} Ask your data team to add it to the catalog.` : e.message });
    return { block: n };
  }
}

export interface RunMeta {
  runId: string;
  mode: 'read' | 'edit';
  status: 'stock' | 'published' | 'draft';
  version: number;
  origin?: string;
  test?: boolean;
}

const lowerLabel = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** What stands out in this run: the biggest move the wrong way, or failing that, the biggest move. */
export function reportTake(widgets: ReportWidgetView[], periodLabel: string, node: string): DiTake | undefined {
  const moved = widgets.flatMap((w) => {
    const c = w.view.type === 'kpi' ? w.view.data.comparison : undefined;
    return w.view.type === 'kpi' && c && c.direction !== 'flat' && c.value !== 0 ? [{ label: w.view.data.label, c, worse: c.direction !== c.goodWhen, size: Math.abs(c.value) / (c.unit === 'bp' ? 100 : 1) }] : [];
  });
  const [top] = moved.sort((a, b) => Number(b.worse) - Number(a.worse) || b.size - a.size);
  if (!top) return undefined;
  const others = moved.filter((m) => m.worse).length - 1;
  const change = top.c.unit === 'bp' ? `${Math.round(Math.abs(top.c.value))} bp` : `${Math.round(Math.abs(top.c.value) * 10) / 10}%`;
  const rise = top.c.direction === 'up' ? 'rise' : 'fall';
  const verdict = others > 0 ? `, the biggest move the wrong way. ${others} other ${others === 1 ? 'measure' : 'measures'} also moved the wrong way.` : top.worse ? ', the only move the wrong way.' : ', and nothing moved the wrong way.';
  const headline = `${top.label} ${top.c.direction === 'up' ? 'rose' : 'fell'} ${change} ${top.c.label}${verdict}`;
  return { headline, action: { label: `Why did it ${rise}?`, ask: `Why did ${lowerLabel(top.label)} ${rise} in ${periodLabel}${node === 'all' ? '' : ` at ${node}`}?` } };
}

/** The library's first line: a schedule that went wrong, then a draft left open, then what's ready. */
export function reportsTake(templates: { name: string; status: string }[], schedules: { report: string; lastResult: 'ok' | 'empty' | 'failed' | null; lastRunAt: string | null }[]): DiTake {
  const failed = schedules.find((s) => s.lastResult === 'failed');
  if (failed) return { headline: `Your ${failed.report} schedule failed on its last run.`, action: { label: 'Show my schedules', ask: 'Which reports are scheduled for me?' } };
  const empty = schedules.find((s) => s.lastResult === 'empty');
  if (empty) return { headline: `Your ${empty.report} schedule ran with no data.`, action: { label: 'Show my schedules', ask: 'Which reports are scheduled for me?' } };
  const draft = templates.find((t) => t.status === 'draft');
  if (draft) return { headline: `Your draft ${draft.name} is waiting to be finished.`, action: { label: 'Open the draft', ask: `Open the ${draft.name} report` } };
  const ran = schedules.filter((s) => s.lastRunAt).sort((a, b) => b.lastRunAt!.localeCompare(a.lastRunAt!));
  if (ran[0]) return { headline: `${ran.length === 1 ? 'Your scheduled report' : `All ${ran.length} of your scheduled reports`} ran. ${ran[0].report} is the latest.`, action: { label: 'Open it', ask: `Open the ${ran[0].report} report` } };
  if (schedules.length) return { headline: `${schedules.length === 1 ? 'Your scheduled report runs' : `Your ${schedules.length} scheduled reports run`} after tonight’s build.` };
  return { headline: 'Nothing is scheduled for you yet. Open a report and ask DI to send it to you.' };
}

/** report.run: renders a definition for control values as a report_canvas block. */
export async function runReport(def: ReportDefinition, input: ReportControls, svc: SemanticService, ctx: RunContext, meta: RunMeta): Promise<{ canvas: ReportCanvasBlock; notice?: string }> {
  const c = resolveControls(def, input, svc, ctx);
  const positions = layout(def.widgets);
  const built = await Promise.all(def.widgets.map((w) => widgetBlock(w, def, c, svc, ctx, meta.runId)));
  const editOf = new Map(def.pendingEdits.map((e) => [e.widgetId, e.id]));
  const widgets: ReportWidgetView[] = def.widgets.map((w, i) => ({
    id: w.id,
    title: w.title,
    gridPos: positions[i]!,
    view: built[i]!.block as ReportWidgetView['view'],
    ...(editOf.has(w.id) ? { editId: editOf.get(w.id) } : {}),
  }));
  // Generated queries show in a test run, or when the report's Show queries setting is on, and only to Query Browser users.
  const showSql = Boolean((meta.test || def.settings.showQueries) && ctx.canViewSql);
  const canvas: ReportCanvasBlock = {
    id: newBlockId('rpt'),
    type: 'report_canvas',
    version: '1.0.0',
    title: def.name,
    subtitle: `${c.periodLabel}${c.node !== 'all' && def.settings.addHierarchyControls ? ` · ${c.node}` : ''}`,
    provenance: { agent: REPORT_AGENT, runId: meta.runId, operations: ['report.run'], sources: [{ kind: 'template', label: def.name, ref: `report:${def.templateId}` }], purviewApplied: Boolean(ctx.purviewBranches) },
    freshness: { kind: 'nightly_build', asOf: `${svc.build.completedAt}-04:00`, buildId: svc.build.buildId },
    actions: [{ id: 'pin', kind: 'pin', label: 'Pin to Home', riskTier: 'low' }],
    a11y: { summary: `${def.name} for ${c.periodLabel}, ${def.widgets.length} sections.` },
    data: {
      templateRef: def.templateId,
      name: def.name,
      description: def.description || undefined,
      folder: def.folder,
      status: meta.status,
      mode: meta.mode,
      version: meta.version,
      periodLabel: c.periodLabel,
      take: reportTake(widgets, c.periodLabel, c.node),
      controls: c.controls,
      widgets,
      pendingEdits: def.pendingEdits.map((e) => ({ id: e.id, widgetId: e.widgetId, summary: e.summary, kind: e.kind })),
      origin: meta.origin,
      ...(showSql ? { queries: built.flatMap((b, i) => (b.sql ?? []).map((sql) => ({ widgetId: def.widgets[i]!.id, sql: sql.slice(0, 4000) }))) } : {}),
    },
  };
  return { canvas, notice: c.notice };
}

export const originText = (t: TemplateRow) => (t.origin ? `Created by ${t.origin.agent} for ${t.ownerName}, approved ${new Date(t.origin.at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}` : undefined);

// ---- draft edits (spec 8.9, FE-BLD-003) -------------------------------------------------------

export const WidgetInput = z
  .object({
    title: z.string().min(1).max(100),
    kind: z.enum(['kpi', 'chart', 'table', 'text']),
    metrics: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).max(4).describe('Metric names from semantic_search. One for kpi and chart, up to four for table.'),
    by: z.string().regex(/^[a-z][a-z0-9_]*$/).optional().describe('A dimension to group by, such as branch or loan_category'),
    chart: z.enum(['line', 'bar', 'stacked_bar', 'donut']).optional(),
    trend: z.number().int().min(2).max(18).optional().describe('Periods of history ending at the report period, for a trend chart'),
    compare: z.boolean().optional().describe('KPIs: compare with the prior period'),
    size: z.enum(['quarter', 'third', 'half', 'full']).default('half'),
  })
  .strict();

export const EditInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), widget: WidgetInput, position: z.number().int().min(0).max(24).optional() }).strict(),
  z.object({ op: z.literal('change'), widget_id: z.string(), set: WidgetInput.partial() }).strict(),
  z.object({ op: z.literal('remove'), widget_id: z.string() }).strict(),
  z.object({ op: z.literal('move'), widget_id: z.string(), position: z.number().int().min(0).max(24) }).strict(),
]);
export type EditInput = z.infer<typeof EditInput>;

let editCounter = 0;
const nextEditId = () => `e${Date.now().toString(36).slice(-4)}${(editCounter++).toString(36)}`;
const widgetId = (def: ReportDefinition, kind: string) => {
  for (let i = 1; ; i++) if (!def.widgets.some((w) => w.id === `${kind[0]}${i}`)) return `${kind[0]}${i}`;
};

/** Applies agent or canvas edits, each recorded as a pending edit that can be reverted. */
export function applyEdits(def: ReportDefinition, edits: EditInput[], summaries: string[] = []): ReportDefinition {
  const d: ReportDefinition = structuredClone(def);
  edits.forEach((e, i) => {
    const id = nextEditId();
    if (e.op === 'add') {
      const w: ReportWidget = { id: widgetId(d, e.widget.kind), ...e.widget, size: e.widget.size ?? 'half' };
      const at = Math.min(e.position ?? d.widgets.length, d.widgets.length);
      d.widgets.splice(at, 0, w);
      d.pendingEdits.push({ id, kind: 'add', widgetId: w.id, before: null, index: at, summary: summaries[i] ?? `Added “${w.title}”` });
      return;
    }
    const at = d.widgets.findIndex((w) => w.id === e.widget_id);
    if (at < 0) throw new CoreError('NOT_FOUND', `No widget "${e.widget_id}". Widgets: ${d.widgets.map((w) => `${w.id} (${w.title})`).join(', ')}.`);
    const before = d.widgets[at]!;
    if (e.op === 'remove') {
      d.widgets.splice(at, 1);
      d.pendingEdits.push({ id, kind: 'remove', widgetId: before.id, before, index: at, summary: summaries[i] ?? `Removed “${before.title}”` });
    } else if (e.op === 'move') {
      d.widgets.splice(at, 1);
      d.widgets.splice(Math.min(e.position, d.widgets.length), 0, before);
      d.pendingEdits.push({ id, kind: 'move', widgetId: before.id, before, index: at, summary: summaries[i] ?? `Moved “${before.title}”` });
    } else {
      const after = { ...before, ...Object.fromEntries(Object.entries(e.set).filter(([, v]) => v !== undefined)) } as ReportWidget;
      d.widgets[at] = after;
      d.pendingEdits.push({ id, kind: 'change', widgetId: before.id, before, index: at, summary: summaries[i] ?? describeChange(before, after) });
    }
  });
  d.layoutVersion += 1;
  return d;
}

function describeChange(a: ReportWidget, b: ReportWidget) {
  if (a.chart !== b.chart && b.chart) return `Made “${b.title}” a ${b.chart.replace('_', ' ')} chart`;
  if (a.size !== b.size) return `Resized “${b.title}” to ${b.size} width`;
  if (a.trend !== b.trend && b.trend) return `Showed ${b.trend} periods in “${b.title}”`;
  if (a.title !== b.title) return `Renamed “${a.title}” to “${b.title}”`;
  return `Changed “${b.title}”`;
}

/** Accept keeps an edit; revert undoes it. Either way it leaves the pending list. */
export function resolveEdit(def: ReportDefinition, editId: string, action: 'accept' | 'revert'): ReportDefinition {
  const d: ReportDefinition = structuredClone(def);
  const e = d.pendingEdits.find((x) => x.id === editId);
  if (!e) throw new CoreError('NOT_FOUND', 'That change was already accepted or reverted.');
  d.pendingEdits = d.pendingEdits.filter((x) => x.id !== editId);
  if (action === 'accept') return d;
  const at = d.widgets.findIndex((w) => w.id === e.widgetId);
  if (e.kind === 'add' && at >= 0) d.widgets.splice(at, 1);
  else if (e.kind === 'remove' && e.before) d.widgets.splice(Math.min(e.index, d.widgets.length), 0, e.before);
  else if (e.kind === 'move' && at >= 0) {
    const [w] = d.widgets.splice(at, 1);
    d.widgets.splice(Math.min(e.index, d.widgets.length), 0, w!);
  } else if (e.kind === 'change' && at >= 0 && e.before) d.widgets[at] = e.before;
  d.layoutVersion += 1;
  return d;
}

/** Checks a widget against the semantic model before it is saved; the agent never invents a measure. */
export function checkWidget(w: Pick<ReportWidget, 'metrics' | 'by' | 'kind' | 'trend'>, svc: SemanticService): string[] {
  const problems: string[] = [];
  for (const m of w.metrics) {
    const metric = svc.model.metrics[m];
    // A measure the catalog does not define is kept and shown as "not defined" (spec 24.5).
    if (!metric) continue;
    else if (w.by && !metric.dimensionsAllowed.includes(w.by)) problems.push(`${metric.label} cannot be grouped by "${w.by}". Allowed: ${metric.dimensionsAllowed.join(', ') || 'none (institution level)'}.`);
    else if (w.trend && metric.currentOnly) problems.push(`${metric.label} has no history, so it cannot be a trend.`);
  }
  if (w.by && !svc.model.dimensions[w.by]) problems.push(`"${w.by}" is not a dimension.`);
  return problems;
}

// ---- schedules (spec 8.8, 18.9) ----------------------------------------------------------------

const DAYS: Record<string, string> = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday' };
const FORMAT_LABEL = { xlsx: 'Excel', csv: 'CSV', pdf: 'PDF' } as const;

export const describeSchedule = (s: Pick<ScheduleDraft, 'frequency' | 'dayRule'>) =>
  s.frequency === 'daily' ? 'Every business day' : s.frequency === 'weekly' ? `Every ${DAYS[s.dayRule] ?? 'Monday'}` : `Monthly, business day ${s.dayRule.replace('BD', '')}`;

/** Resolves names to recipients: "me", a delivery group, or an outside email address (high risk). */
export function resolveRecipients(names: string[], user: { name: string }): Recipient[] {
  return names.map((raw) => {
    const n = raw.trim();
    if (/^(me|myself)$/i.test(n) || n.toLowerCase() === user.name.toLowerCase()) return { name: user.name, kind: 'user', count: 1 };
    const group = Object.keys(DELIVERY_GROUPS).find((g) => g.toLowerCase() === n.toLowerCase() || g.toLowerCase().startsWith(n.toLowerCase().replace(/^the /, '')));
    if (group) return { name: group, kind: 'group', count: DELIVERY_GROUPS[group]! };
    if (/@/.test(n)) return { name: n, kind: 'external', count: 1 };
    throw new CoreError('NOT_FOUND', `No user or group called "${n}". Groups: ${Object.keys(DELIVERY_GROUPS).join(', ')}.`);
  });
}

// ---- approval cards ----------------------------------------------------------------------------

type CardInput = { approval: ApprovalRecord; runId: string; user: { id: string; name: string }; title: string; summary: string; fields: { label: string; value: string }[]; records: number; users: number; external: number; typed?: { prompt: string; expected: string }; preview?: ApprovalCardBlock['data']['preview']; agent?: string };

function card(c: CardInput, operation: string): ApprovalCardBlock {
  return {
    id: newBlockId('apr'),
    type: 'approval_card',
    version: '1.2.0',
    title: c.title,
    provenance: { agent: c.agent ?? REPORT_AGENT, runId: c.runId, operations: [operation], sources: [{ kind: 'template', label: 'Reports', ref: 'report:library' }] },
    freshness: { kind: 'workflow_event' },
    data: {
      approvalId: c.approval.approvalId,
      summary: c.summary.slice(0, 200),
      riskTier: c.approval.riskTier,
      operation,
      requestedBy: { kind: 'agent_run', runId: c.runId, agent: c.agent ?? REPORT_AGENT, onBehalfOf: c.user.id, onBehalfOfName: c.user.name },
      preview: c.preview ?? { kind: 'record', fields: c.fields },
      affected: { records: c.records, users: c.users, external: c.external },
      // High risk (over 25 recipients or outside addresses) is confirmed on screen by typing the count.
      confirmation: { methods: c.approval.riskTier === 'high' ? ['click', 'keyboard'] : ['click', 'keyboard', 'voice'], typedValue: c.typed ?? null, stepUp: false, secondApprover: null, noteRequired: false },
      editablePlan: true,
      expiresAt: c.approval.expiresAt,
      idempotencyKey: `idem_${c.approval.approvalId}`,
      previewHash: c.approval.payloadHash,
    },
  };
}

// ---- gateway ------------------------------------------------------------------------------------

export interface ReportThread {
  /** The report on screen: what "make the chart a donut", "export it" and "schedule it" refer to. */
  current?: { templateId: string; controls: ReportControls };
  history: { user: string; reply: string }[];
}

export const newReportThread = (): ReportThread => ({ history: [] });

export interface ReportGatewayContext extends RunContext {
  user: { id: string; name: string };
  apps: string[];
  runId: string;
  threadId: string;
  state: ReportThread;
}

const tpl = z.string().regex(/^[a-z0-9_]{3,60}$/).describe('A template_id from report_template_list');

export const REPORT_TOOLS = [
  { name: 'report_template_list', operation: 'report.template.list', description: 'Reports the user can open: stock periodic reports, published reports and their own drafts, with template_id, folder and period type. Optionally filtered by words in the name or folder.', input: z.object({ query: z.string().max(80).optional() }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'reports', purviewScope: 'report_viewer', maxResultRowsToModel: 20, agents: [] },
  { name: 'report_run', operation: 'report.run', description: 'Run a report for a period and branch and show it. Period is YYYY-MM for monthly reports or YYYY-Qn for quarterly ones; omit for the latest. Branch must be within the user’s purview; omit for the default.', input: z.object({ template_id: tpl, period: z.string().max(10).optional(), branch: z.string().max(40).optional() }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'reports', purviewScope: 'report_viewer', maxResultRowsToModel: 24, agents: [] },
  { name: 'semantic_search', operation: 'semantic.search', description: 'Find defined metrics and dimensions for a report widget, by the user’s words. Use only metric names this returns.', input: z.object({ query: z.string().min(2).max(120) }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'reports', purviewScope: 'none', maxResultRowsToModel: 12, agents: [] },
  { name: 'report_draft_create', operation: 'report.draft.save', description: 'Create a private draft report from widgets and show it with live data. Drafts are autosaved privately and are not shared until saved with report_save.', input: z.object({ name: z.string().min(3).max(120), description: z.string().max(300).default(''), period_type: z.enum(['month', 'quarter']).default('month'), branch_control: z.boolean().default(true), widgets: z.array(WidgetInput).min(1).max(12) }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'reports', purviewScope: 'report_viewer', maxResultRowsToModel: 24, agents: [] },
  { name: 'report_draft_update', operation: 'report.draft.save', description: 'Change the draft on screen: add, change, remove or move widgets. Each change is highlighted for the user to accept or revert. Use widget ids from the last result.', input: z.object({ changes: z.array(EditInput).min(1).max(8), summaries: z.array(z.string().max(160)).max(8).default([]).describe('One short line per change, such as "Made Deposit mix a donut chart"') }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'reports', purviewScope: 'report_viewer', maxResultRowsToModel: 24, agents: [] },
  { name: 'report_save', operation: 'report.template.create', description: 'Save the draft on screen as a report in a folder, so others with access can open it. Returns approval_required; nothing is saved until the user approves.', input: z.object({ folder: z.string().min(2).max(80).describe('Such as "Finance / ALCO" or "My Reports"'), name: z.string().min(3).max(120).optional() }).strict(), sideEffect: 'write', riskTier: 'medium', requiredApp: 'reports', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: [] },
  {
    name: 'report_schedule_create',
    operation: 'report.schedule.create',
    description: 'Schedule the report on screen (or template_id) to run after the nightly build and be delivered. Recipients are "me", delivery group names or email addresses. Returns approval_required.',
    input: z.object({ template_id: tpl.optional(), frequency: z.enum(['daily', 'weekly', 'monthly']), day: z.string().regex(/^(MON|TUE|WED|THU|FRI|BD[1-5])$/).optional().describe('MON..FRI for weekly; BD1..BD5 (business day) for monthly'), format: z.enum(['xlsx', 'csv', 'pdf']).default('xlsx'), recipients: z.array(z.string().min(2).max(120)).min(1).max(10), send_if_empty: z.boolean().default(false) }).strict(),
    sideEffect: 'write',
    riskTier: 'medium',
    requiredApp: 'reports',
    purviewScope: 'report_viewer',
    maxResultRowsToModel: 1,
    agents: [],
  },
  { name: 'report_schedule_list', operation: 'report.schedule.list', description: 'The user’s active report schedules, with the last result of each.', input: z.object({}).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'reports', purviewScope: 'none', maxResultRowsToModel: 20, agents: [] },
  { name: 'report_schedule_cancel', operation: 'report.schedule.cancel', description: 'Stop one of the user’s schedules. Returns approval_required.', input: z.object({ schedule_id: z.number().int().positive() }).strict(), sideEffect: 'write', riskTier: 'medium', requiredApp: 'reports', purviewScope: 'none', maxResultRowsToModel: 1, agents: [] },
  { name: 'report_share', operation: 'report.share', description: 'Send the report on screen once, with a covering note, to delivery groups or "me". Returns approval_required with the note shown in full; nothing is sent until the user approves.', input: z.object({ recipients: z.array(z.string().min(2).max(120)).min(1).max(6), subject: z.string().min(3).max(200), body: z.string().min(10).max(3000) }).strict(), sideEffect: 'write', riskTier: 'medium', requiredApp: 'reports', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: [] },
  { name: 'report_export', operation: 'report.export', description: 'Export the report on screen, as run, to Excel or CSV. Exports are logged and need approval.', input: z.object({ format: z.enum(['xlsx', 'csv']) }).strict(), sideEffect: 'write', riskTier: 'medium', requiredApp: 'reports', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: [] },
  { name: 'report_pin', operation: 'report.pin', description: 'Put a saved report (the one on screen, or template_id) on Home: for "me", or published to everyone in a user class (Executive, Manager, Analyst, Administrator). Each person sees it with their own data access. Returns approval_required.', input: z.object({ template_id: tpl.optional(), audience: z.string().min(2).max(40).default('me').describe('"me" or a user class name') }).strict(), sideEffect: 'write', riskTier: 'low', requiredApp: 'reports', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: [] },
  { name: 'report_unpin', operation: 'report.unpin', description: 'Take a report (the one on screen, or template_id) off Home: the pins this user made, for themselves or for a class. Returns approval_required.', input: z.object({ template_id: tpl.optional() }).strict(), sideEffect: 'write', riskTier: 'low', requiredApp: 'reports', purviewScope: 'none', maxResultRowsToModel: 1, agents: [] },
  { name: 'report_delete', operation: 'report.delete', description: 'Move one of the user’s own saved reports (the one on screen, or template_id) to the Recycle Bin. It leaves every Home and folder and can be restored. Stock reports can’t be deleted. Returns approval_required.', input: z.object({ template_id: tpl.optional() }).strict(), sideEffect: 'write', riskTier: 'medium', requiredApp: 'reports', purviewScope: 'none', maxResultRowsToModel: 1, agents: [] },
  { name: 'report_bin_list', operation: 'report.bin.list', description: 'The user’s reports in the Recycle Bin, with template_id.', input: z.object({}).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'reports', purviewScope: 'none', maxResultRowsToModel: 20, agents: [] },
  { name: 'report_restore', operation: 'report.restore', description: 'Bring a report back from the Recycle Bin to its folder. Use a template_id from report_bin_list. Returns approval_required.', input: z.object({ template_id: tpl }).strict(), sideEffect: 'write', riskTier: 'low', requiredApp: 'reports', purviewScope: 'none', maxResultRowsToModel: 1, agents: [] },
  // Settings: today's DI Build Reports form (Basics, Configuration, Report Controls, Period and Hierarchy Info, Test/Preview).
  { name: 'report_settings_show', operation: 'report.settings.get', description: 'The settings of the report on screen (or template_id): period type, default period, branch control, who can open it, whether it is on, and whether queries show.', input: z.object({ template_id: tpl.optional() }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'reports', purviewScope: 'none', maxResultRowsToModel: 30, agents: [] },
  {
    name: 'report_settings_update',
    operation: 'report.settings.update',
    description: 'Change settings of the draft on screen, or of a saved report the user owns (template_id, or the one on screen). Give only what changes. On a draft it changes at once; on a saved report it returns approval_required. Stock reports can’t be changed: suggest report_copy.',
    input: z
      .object({
        template_id: tpl.optional(),
        name: z.string().min(3).max(120).optional(),
        description: z.string().max(300).optional(),
        period_type: z.enum(['month', 'quarter']).optional().describe('"Make it quarterly"'),
        use_period: z.enum(['current', 'previous']).optional().describe('Which period it opens on: the latest complete one, or the one before'),
        branch_control: z.boolean().optional().describe('The branch picker on the report'),
        history_controls: z.boolean().optional(),
        who_can_open: z.array(z.string().min(2).max(40)).max(4).optional().describe('User classes that may open it, such as ["Manager", "Executive"], or ["everyone"]'),
        enabled: z.boolean().optional().describe('false turns the report off: it stops running and others stop seeing it'),
        show_queries: z.boolean().optional().describe('Show generated queries under the report, to Query Browser users only'),
      })
      .strict(),
    sideEffect: 'write',
    riskTier: 'medium',
    requiredApp: 'reports',
    purviewScope: 'none',
    maxResultRowsToModel: 24,
    agents: [],
  },
  { name: 'report_copy', operation: 'report.draft.save', description: 'Make a private draft copy of a report the user can open (the one on screen, or template_id), so its settings and sections can be changed. Not shared until saved with report_save.', input: z.object({ template_id: tpl.optional(), name: z.string().min(3).max(120).optional() }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'reports', purviewScope: 'report_viewer', maxResultRowsToModel: 24, agents: [] },
] satisfies ToolDef[];

/** User classes that include Reports, so a report published to them opens for everyone in them. */
export const REPORT_CLASSES = ['Executive', 'Manager', 'Analyst', 'Administrator'];

export interface SavePayload {
  draftId: string;
  name: string;
  folder: string;
  definition: ReportDefinition;
}
export type CancelPayload = { scheduleId: number; templateName: string };
export type SharePayload = ShareDraft & { templateName: string };
export type ExportPayload = { templateId: string; format: 'xlsx' | 'csv'; controls: Record<string, string> };
export type PinPayload = PinDraft & { templateName: string };
export type UnpinPayload = { templateId: string; templateName: string; pinIds: string[]; audiences: string[] };
export type BinPayload = { templateId: string; templateName: string; folder: string };

export type ReportResult =
  | { ok: true; content: unknown; canvas?: ReportCanvasBlock; notice?: string; list?: { kind: 'templates'; items: TemplateRow[] } | { kind: 'schedules'; items: ScheduleRow[] }; card?: ApprovalCardBlock; approval?: ApprovalRecord; superseded?: string[]; blocks?: Block[]; said?: string }
  | { ok: false; code: 'UNKNOWN_TOOL' | 'INVALID_INPUT' | 'RESERVED_KEY' | 'NOT_FOUND' | 'NO_ACCESS' | 'INVALID' | 'NO_REPORT'; content: unknown };

export type ReportExecuted =
  | { operation: 'report.template.create'; template: TemplateRow & { replayed: boolean } }
  | { operation: 'report.schedule.create'; schedule: ScheduleRow & { replayed: boolean } }
  | { operation: 'report.schedule.cancel'; schedule: ScheduleRow }
  | { operation: 'report.share'; shareId: string; recipientCount: number; templateName: string }
  | { operation: 'report.export'; exportId: string; format: 'xlsx' | 'csv'; templateName: string }
  | { operation: 'report.pin'; pinId: string; templateId: string; templateName: string; audience: string }
  | { operation: 'report.unpin'; removed: number; templateName: string }
  | { operation: 'report.delete'; templateId: string; templateName: string }
  | { operation: 'report.restore'; templateId: string; templateName: string; folder: string }
  | { operation: 'report.settings.update'; templateId: string; templateName: string; changes: { label: string; before: string; after: string }[]; turnedOff: boolean; replayed: boolean };

/** What the model sees of a report: titles and headline values, not every row. */
function canvasForModel(c: ReportCanvasBlock) {
  return {
    template_id: c.data.templateRef,
    name: c.data.name,
    status: c.data.status,
    period: c.data.periodLabel,
    controls: Object.fromEntries(c.data.controls.map((x) => [x.id, x.value])),
    widgets: c.data.widgets.map((w) => {
      const v = w.view;
      const base = { widget_id: w.id, title: w.title, kind: v.type };
      if (v.type === 'kpi') return { ...base, value: v.data.value, unit: v.data.unit, change: v.data.comparison ? `${v.data.comparison.value} ${v.data.comparison.unit} ${v.data.comparison.label}` : undefined };
      if (v.type === 'notice') return { ...base, problem: v.data.message, detail: v.data.detail };
      if (v.type === 'table') return { ...base, rows: v.data.rowCount };
      return base;
    }),
    pending_changes: c.data.pendingEdits.map((e) => e.summary),
  };
}

export class ReportGateway {
  constructor(
    private readonly deps: { store: ReportStore; semantic: SemanticService; approvals: ApprovalStore; tenantRaise?: Partial<Record<string, RiskTier>>; classSize?: (userClass: string) => Promise<number> },
    private readonly tools: ToolDef[] = REPORT_TOOLS,
  ) {}

  get store() {
    return this.deps.store;
  }

  get semantic() {
    return this.deps.semantic;
  }

  visible(ctx: Pick<ReportGatewayContext, 'apps'>) {
    return this.tools.filter((t) => ctx.apps.includes(t.requiredApp as string));
  }

  /** Runs a template the user can see; used by the agent and by control changes on the canvas. */
  async run(templateId: string, controls: ReportControls, ctx: RunContext & { user: { id: string }; runId: string; test?: boolean }) {
    const t = await this.deps.store.get(templateId, ctx.user.id, { userClass: ctx.userClass });
    // Only the owner reaches a report that is turned off; it still doesn't run.
    if (t.definition.settings.enabled === false) throw new CoreError('INVALID', `${t.name} is turned off, so it doesn’t run. Ask DI to turn it back on.`);
    return runReport(t.definition, controls, this.deps.semantic, ctx, { runId: ctx.runId, mode: t.status === 'draft' ? 'edit' : 'read', status: t.status === 'draft' ? 'draft' : t.status === 'stock' ? 'stock' : 'published', version: t.definition.layoutVersion, origin: originText(t), test: ctx.test });
  }

  /** A report's settings, read-only, for its Settings view and for report_settings_show. */
  async settings(templateId: string, ctx: { user: { id: string }; canViewSql: boolean; userClass?: string }) {
    const t = await this.deps.store.get(templateId, ctx.user.id, { userClass: ctx.userClass });
    const [pins, schedules, lastChange] = await Promise.all([this.deps.store.pinsOf(t.templateId).catch(() => []), this.deps.store.activeSchedules().catch(() => []), this.deps.store.lastSettingsChange(t.templateId)]);
    return settingsView(t, { userId: ctx.user.id, canViewSql: ctx.canViewSql }, { pins: pins.length, schedules: schedules.filter((s) => s.templateId === t.templateId).length, lastChange });
  }

  /** Accept or revert one highlighted change, or move or resize a widget, from the canvas itself. */
  async edit(templateId: string, op: { kind: 'accept' | 'revert'; editId: string } | { kind: 'move'; widgetId: string; position: number } | { kind: 'resize'; widgetId: string; size: WidgetSize } | { kind: 'remove'; widgetId: string }, controls: ReportControls, ctx: RunContext & { user: { id: string; name: string }; runId: string; threadId: string }) {
    const t = await this.deps.store.get(templateId, ctx.user.id);
    if (t.status !== 'draft') throw new CoreError('NO_ACCESS', 'Only a draft can be edited here. Ask to make a copy to change a saved report.');
    let settled: ReportDefinition;
    if (op.kind === 'accept' || op.kind === 'revert') settled = resolveEdit(t.definition, op.editId, op.kind);
    else {
      let edit: EditInput;
      if (op.kind === 'move') edit = { op: 'move', widget_id: op.widgetId, position: op.position };
      else if (op.kind === 'remove') edit = { op: 'remove', widget_id: op.widgetId };
      else if (op.kind === 'resize') edit = { op: 'change', widget_id: op.widgetId, set: { size: op.size } };
      else throw new CoreError('INVALID', 'Unknown edit.');
      const d = applyEdits(t.definition, [edit]);
      // Moves, resizes and removals made by hand need no review: they are accepted at once.
      settled = { ...d, pendingEdits: d.pendingEdits.slice(0, -1) };
    }
    await this.deps.store.saveDraft(settled, ctx.user, ctx.threadId);
    return this.run(templateId, controls, ctx);
  }

  async call(name: string, input: unknown, ctx: ReportGatewayContext): Promise<ReportResult> {
    const def = this.visible(ctx).find((t) => t.name === name);
    if (!def) return { ok: false, code: 'UNKNOWN_TOOL', content: { error: 'UNKNOWN_TOOL', message: `No tool ${name} for this user.` } };
    const reserved = reservedKeys(input);
    if (reserved.length) return { ok: false, code: 'RESERVED_KEY', content: { error: 'RESERVED_KEY', message: `These keys are set by the platform: ${reserved.join(', ')}.` } };
    const parsed = def.input.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT', content: { error: 'INVALID_INPUT', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } };
    const a = parsed.data as Record<string, unknown>;
    const { store, semantic } = this.deps;
    const current = ctx.state.current;
    const viewer = { userClass: ctx.userClass };
    const needCurrent = (): ReportResult | null => (current ? null : { ok: false, code: 'NO_REPORT', content: { error: 'NO_REPORT', message: 'No report is open in this conversation. Run or create one first.' } });
    const approve = async (payload: unknown, tier: RiskTier) => {
      const approval = await this.deps.approvals.request({ operation: def.operation, payload, riskTier: tier, requestedBy: ctx.user.id, runId: ctx.runId, threadId: ctx.threadId });
      const superseded = await this.deps.approvals.supersede(ctx.threadId, approval.approvalId);
      return { approval, superseded };
    };
    const tierOf = (raised?: RiskTier) => {
      const t = effectiveTier(def, this.deps.tenantRaise);
      const base: RiskTier = t === 'none' ? 'low' : t;
      return raised && ['low', 'medium', 'high'].indexOf(raised) > ['low', 'medium', 'high'].indexOf(base) ? raised : base;
    };

    try {
      switch (def.operation) {
        case 'report.template.list': {
          const q = String(a.query ?? '').toLowerCase();
          const words = q.split(/\s+/).filter((w) => w.length > 2 && !['report', 'reports', 'the', 'for', 'pack'].includes(w));
          const items = (await store.list(ctx.user.id, viewer)).filter((t) => !words.length || words.some((w) => `${t.name} ${t.folder}`.toLowerCase().includes(w)));
          return { ok: true, content: { reports: items.map((t) => ({ template_id: t.templateId, name: t.name, folder: t.folder, period_type: t.definition.settings.periodType, status: t.status })) }, list: { kind: 'templates', items } };
        }
        case 'report.run': {
          const t = await store.get(String(a.template_id), ctx.user.id, viewer);
          const period = a.period ? String(a.period) : undefined;
          const { canvas, notice } = await this.run(t.templateId, { period, node: a.branch ? String(a.branch) : undefined }, ctx);
          ctx.state.current = { templateId: t.templateId, controls: Object.fromEntries(canvas.data.controls.map((c) => [c.id, c.value])) };
          return { ok: true, content: { ...canvasForModel(canvas), notice }, canvas, notice };
        }
        case 'semantic.search': {
          const r = semantic.search(String(a.query));
          return { ok: true, content: { metrics: r.metrics.slice(0, 8).map((m) => ({ name: m.name, label: m.label, description: m.description.slice(0, 160), group_by: m.dimensionsAllowed, trendable: m.trendable })), dimensions: r.dimensions.slice(0, 6).map((d) => ({ name: d.name, label: d.label })), unknown_terms: r.unknownTerms } };
        }
        case 'report.settings.get': {
          const templateId = a.template_id ? String(a.template_id) : current?.templateId;
          if (!templateId) return needCurrent()!;
          const v = await this.settings(templateId, ctx);
          const rows = v.groups.flatMap((g) => g.fields.filter((f) => f.used).map((f) => ({ group: g.title, setting: f.label, value: f.value })));
          const block: Block = { id: newBlockId('rst'), type: 'table', version: '1.0.0', title: `${v.name}: settings`, provenance: { agent: REPORT_AGENT, runId: ctx.runId, operations: ['report.settings.get'], sources: [{ kind: 'template', label: v.name, ref: `report:${v.templateId}` }] }, freshness: { kind: 'none' }, data: { columns: [{ field: 'group', headerName: 'Group', type: 'text' }, { field: 'setting', headerName: 'Setting', type: 'text' }, { field: 'value', headerName: 'Value', type: 'text' }], rows, rowCount: rows.length } };
          const said = `**${v.name}**: ${v.tiles.map((x) => `${x.label.toLowerCase()} ${x.value.toLowerCase()}`).slice(0, 3).join(', ')}. ${v.changeNote} [Open its settings](/reports/${v.templateId}?view=settings).`;
          return { ok: true, content: { template_id: v.templateId, name: v.name, status: v.status, can_change: v.canChange, note: v.changeNote, settings: rows.map((r) => `${r.setting}: ${r.value}`) }, blocks: [block], said };
        }
        case 'report.settings.update': {
          const templateId = a.template_id ? String(a.template_id) : current?.templateId;
          if (!templateId) return needCurrent()!;
          const t = await store.get(templateId, ctx.user.id, viewer);
          const { fields, unknown } = fieldsFrom(a as SettingsInput, REPORT_CLASSES);
          const refuse = (message: string, code: 'NO_ACCESS' | 'INVALID' = 'NO_ACCESS'): ReportResult => ({ ok: false, code, content: { error: code, message } });
          // Checked in code, whatever the model asks: generated SQL is for Query Browser users only.
          if (fields.showQueries === true && !ctx.canViewSql) return refuse('Showing the generated queries needs the Query Browser permission, which isn’t part of your access, so I can’t turn it on.');
          if (t.status === 'stock') return refuse(`${t.name} is a stock report every user starts with, so its settings can’t be changed. Say “make a copy of the ${t.name}” and change the copy.`);
          if (t.status !== 'draft' && t.ownerUserId !== ctx.user.id) return refuse(`${t.name} belongs to ${t.ownerName}. Only they can change its settings.`);
          if (unknown.length) return refuse(`I can’t limit it to ${unknown.join(', ')}: only the ${REPORT_CLASSES.join(', ')} classes include Reports.`, 'INVALID');
          if (t.status === 'draft' && fields.enabled === false) return refuse('A draft is private and never runs on a schedule, so there’s nothing to turn off.', 'INVALID');
          const diff = settingsDiff(t.definition, fields);
          if (!diff.changes.length) return refuse(Object.keys(fields).length ? `${t.name} is already set that way, so nothing changes.` : 'Say which setting to change, for example “make it quarterly”.', 'INVALID');
          if (t.status === 'draft') {
            // A draft is private, so a settings change is an ordinary autosave (spec 8.9).
            await store.saveDraft(applySettings(t.definition, diff.after), ctx.user, ctx.threadId);
            const { canvas } = await this.run(t.templateId, current?.templateId === t.templateId ? current.controls : {}, ctx);
            ctx.state.current = { templateId: t.templateId, controls: Object.fromEntries(canvas.data.controls.map((c) => [c.id, c.value])) };
            return { ok: true, content: { draft: canvasForModel(canvas), changed: diff.changes }, canvas, said: `Done on your draft: ${diff.changes.map((c) => `${c.label.toLowerCase()} ${c.after.charAt(0).toLowerCase()}${c.after.slice(1)}`).join('; ')}.` };
          }
          const pins = await store.pinsOf(t.templateId);
          const schedules = (await store.activeSchedules()).filter((s) => s.templateId === t.templateId);
          const uses = `${pins.length === 1 ? '1 Home pin' : `${pins.length} Home pins`}, ${schedules.length === 1 ? '1 active schedule' : `${schedules.length} active schedules`}`;
          const impact = [
            ...(diff.after.enabled === false ? [{ label: 'What it affects', before: uses, after: 'Others stop seeing it in Reports and on Home; scheduled runs skip it until it’s turned back on' }] : []),
            ...(diff.after.controlClasses?.length ? [{ label: 'What it affects', before: uses, after: `Only the ${diff.after.controlClasses.join(', ')} ${diff.after.controlClasses.length === 1 ? 'class sees' : 'classes see'} it in Reports and on Home, and you` }] : []),
          ].slice(0, 1);
          const payload: SettingsPayload = { templateId: t.templateId, templateName: t.name, before: diff.before, after: diff.after };
          const { approval, superseded } = await approve(payload, tierOf());
          const c = card(
            {
              approval,
              runId: ctx.runId,
              user: ctx.user,
              title: 'Change report settings',
              summary: `Change “${t.name}”: ${diff.changes.map((x) => x.label.toLowerCase()).join(', ')}`,
              fields: [],
              preview: { kind: 'diff', changes: [...diff.changes, ...impact] },
              records: 1,
              users: pins.length,
              external: 0,
            },
            def.operation,
          );
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, risk_tier: approval.riskTier, changes: diff.changes, affects: uses, note: 'Nothing has changed. The user approves on screen.' }, card: c, approval, superseded };
        }
        case 'report.draft.save': {
          if (name === 'report_copy') {
            const templateId = a.template_id ? String(a.template_id) : current?.templateId;
            if (!templateId) return needCurrent()!;
            const t = await store.get(templateId, ctx.user.id, viewer);
            // The copy is yours alone, open to everyone with Reports once saved, and turned on.
            const copy: ReportDefinition = { ...structuredClone(t.definition), templateId: 'new', name: String(a.name ?? `${t.name} (copy)`), folder: 'Drafts', settings: { ...t.definition.settings, controlClasses: [], enabled: true }, pendingEdits: [], layoutVersion: 1 };
            const saved = await store.saveDraft(copy, ctx.user, ctx.threadId);
            const { canvas } = await this.run(saved.templateId, {}, ctx);
            ctx.state.current = { templateId: saved.templateId, controls: Object.fromEntries(canvas.data.controls.map((x) => [x.id, x.value])) };
            return { ok: true, content: { draft: canvasForModel(canvas), note: 'A private draft copy. Change its settings or sections, then report_save.' }, canvas, said: `Here’s **${copy.name}**, a private draft copy of ${t.name}. Change its settings or sections, then ask me to save it.` };
          }
          if (name === 'report_draft_create') {
            const widgets = (a.widgets as z.infer<typeof WidgetInput>[]).map((w, i) => ({ id: `${w.kind[0]}${i + 1}`, ...w, size: w.size ?? 'half' })) as ReportWidget[];
            const problems = widgets.flatMap((w) => checkWidget(w, semantic).map((p) => `${w.title}: ${p}`));
            if (problems.length) return { ok: false, code: 'INVALID', content: { error: 'INVALID', problems } };
            const draft: ReportDefinition = {
              // A new draft gets its own ID when it is saved.
              templateId: 'new',
              name: String(a.name),
              description: String(a.description ?? ''),
              folder: 'Drafts',
              settings: { app: 'reports', controlClasses: [], enabled: true, periodType: a.period_type as 'month' | 'quarter', usePeriod: 'current', allowedPeriodTypes: ['month', 'quarter'], addHierarchyControls: Boolean(a.branch_control), addHistoryControls: true, showQueries: false },
              layoutVersion: 1,
              widgets,
              pendingEdits: [],
            };
            const saved = await store.saveDraft(draft, ctx.user, ctx.threadId);
            const { canvas } = await this.run(saved.templateId, {}, ctx);
            ctx.state.current = { templateId: saved.templateId, controls: Object.fromEntries(canvas.data.controls.map((c) => [c.id, c.value])) };
            return { ok: true, content: { draft: canvasForModel(canvas), note: 'Draft saved privately. Nothing is shared until report_save is approved.' }, canvas };
          }
          const none = needCurrent();
          if (none) return none;
          const t = await store.get(current!.templateId, ctx.user.id, viewer);
          if (t.status !== 'draft') return { ok: false, code: 'NO_ACCESS', content: { error: 'NO_ACCESS', message: 'The report on screen is saved, not a draft. Create a draft to build a new one.' } };
          const changes = a.changes as EditInput[];
          for (const ch of changes) {
            const w = ch.op === 'add' ? ch.widget : ch.op === 'change' ? { ...t.definition.widgets.find((x) => x.id === ch.widget_id), ...ch.set } : null;
            const problems = w?.metrics ? checkWidget(w as ReportWidget, semantic) : [];
            if (problems.length) return { ok: false, code: 'INVALID', content: { error: 'INVALID', problems } };
          }
          const next = applyEdits(t.definition, changes, a.summaries as string[]);
          await store.saveDraft(next, ctx.user, ctx.threadId);
          const { canvas } = await this.run(t.templateId, current!.controls, ctx);
          return { ok: true, content: { draft: canvasForModel(canvas) }, canvas };
        }
        case 'report.template.create': {
          const none = needCurrent();
          if (none) return none;
          const t = await store.get(current!.templateId, ctx.user.id, viewer);
          if (t.status !== 'draft') return { ok: false, code: 'INVALID', content: { error: 'INVALID', message: 'Only a draft can be saved this way.' } };
          // Saving keeps what is on screen: pending highlights are accepted as shown.
          const payload: SavePayload = { draftId: t.templateId, name: String(a.name ?? t.name), folder: String(a.folder), definition: { ...t.definition, pendingEdits: [] } };
          const { approval, superseded } = await approve(payload, tierOf());
          const c = card(
            {
              approval,
              runId: ctx.runId,
              user: ctx.user,
              title: 'Save report',
              summary: `Save “${payload.name}” in ${payload.folder}`,
              fields: [
                { label: 'Report', value: payload.name },
                { label: 'Folder', value: payload.folder },
                { label: 'Sections', value: payload.definition.widgets.map((w) => w.title).join(' · ').slice(0, 400) },
                { label: 'Period', value: payload.definition.settings.periodType === 'month' ? 'Monthly, latest complete month' : 'Quarterly, latest complete quarter' },
                { label: 'Who can open it', value: 'Anyone with Reports access; each person sees only data their purview allows' },
                { label: 'Origin', value: `Created by ${REPORT_AGENT} for ${ctx.user.name}` },
              ],
              records: 1,
              users: 0,
              external: 0,
            },
            def.operation,
          );
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, risk_tier: approval.riskTier, note: 'Nothing has been saved. The user approves on screen.' }, card: c, approval, superseded };
        }
        case 'report.schedule.create': {
          const templateId = a.template_id ? String(a.template_id) : current?.templateId;
          if (!templateId) return needCurrent()!;
          const t = await store.get(templateId, ctx.user.id, viewer);
          if (t.status === 'draft') return { ok: false, code: 'INVALID', content: { error: 'INVALID', message: 'Save the draft before scheduling it.' } };
          const recipients = resolveRecipients(a.recipients as string[], ctx.user);
          const count = recipients.reduce((s, r) => s + r.count, 0);
          const external = recipients.filter((r) => r.kind === 'external').length;
          const frequency = a.frequency as ScheduleDraft['frequency'];
          const dayRule = String(a.day ?? (frequency === 'weekly' ? 'MON' : frequency === 'monthly' ? 'BD1' : 'DAILY'));
          const controls = current?.templateId === templateId ? Object.fromEntries(Object.entries(current.controls).filter(([k]) => k === 'node')) : {};
          const payload: ScheduleDraft = { templateId, frequency, dayRule, format: a.format as ScheduleDraft['format'], recipients, sendIfEmpty: Boolean(a.send_if_empty), controls: controls as Record<string, string> };
          // More than 25 recipients, or anyone outside the institution, is high risk (spec 8.8).
          const high = count > SCHEDULE_RECIPIENT_CAP || external > 0;
          const { approval, superseded } = await approve(payload, tierOf(high ? 'high' : undefined));
          const when = describeSchedule(payload);
          const c = card(
            {
              approval,
              runId: ctx.runId,
              user: ctx.user,
              title: 'Schedule report',
              summary: `Send “${t.name}” ${when.toLowerCase()}, after the nightly build, to ${count} ${count === 1 ? 'recipient' : 'recipients'}`,
              fields: [
                { label: 'Report', value: t.name },
                { label: 'When', value: `${when}, after the nightly build completes` },
                { label: 'Format', value: FORMAT_LABEL[payload.format] },
                { label: 'Recipients', value: recipients.map((r) => (r.kind === 'group' ? `${r.name} (${r.count})` : r.kind === 'external' ? `${r.name} (outside the institution)` : r.name)).join(', ') },
                { label: 'If there is no data', value: payload.sendIfEmpty ? 'Send it anyway' : 'Skip that run' },
                { label: 'Delivery', value: 'Secure link that needs sign-in. Each recipient sees only data their permissions allow.' },
              ],
              records: 1,
              users: count,
              external,
              typed: high ? { prompt: 'Type the number of recipients to confirm', expected: String(count) } : undefined,
            },
            def.operation,
          );
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, risk_tier: approval.riskTier, recipients: count, when }, card: c, approval, superseded };
        }
        case 'report.schedule.list': {
          const items = await store.schedules(ctx.user.id);
          return { ok: true, content: { schedules: items.map((s) => ({ schedule_id: s.scheduleId, report: s.templateName, when: describeSchedule(s), format: s.format, recipients: s.recipientCount, last_result: s.lastResult ?? 'not run yet' })) }, list: { kind: 'schedules', items } };
        }
        case 'report.schedule.cancel': {
          const s = await store.schedule(Number(a.schedule_id));
          if (s.ownerUserId !== ctx.user.id || s.status !== 'active') return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: 'No active schedule of yours with that ID.' } };
          const payload: CancelPayload = { scheduleId: s.scheduleId, templateName: s.templateName };
          const { approval, superseded } = await approve(payload, tierOf());
          const c = card({ approval, runId: ctx.runId, user: ctx.user, title: 'Stop schedule', summary: `Stop sending “${s.templateName}” ${describeSchedule(s).toLowerCase()}`, fields: [{ label: 'Report', value: s.templateName }, { label: 'Schedule', value: `${describeSchedule(s)}, ${FORMAT_LABEL[s.format]}` }, { label: 'Recipients', value: `${s.recipientCount}` }], records: 1, users: s.recipientCount, external: 0 }, def.operation);
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId }, card: c, approval, superseded };
        }
        case 'report.share': {
          const none = needCurrent();
          if (none) return none;
          const t = await store.get(current!.templateId, ctx.user.id, viewer);
          if (t.status === 'draft') return { ok: false, code: 'INVALID', content: { error: 'INVALID', message: 'Save the draft before sending it.' } };
          const recipients = resolveRecipients(a.recipients as string[], ctx.user);
          const count = recipients.reduce((s, r) => s + r.count, 0);
          const external = recipients.filter((r) => r.kind === 'external').length;
          const payload: SharePayload = { templateId: t.templateId, templateName: t.name, recipients, subject: String(a.subject), body: String(a.body), controls: current!.controls as Record<string, string> };
          const high = count > SCHEDULE_RECIPIENT_CAP || external > 0;
          const { approval, superseded } = await approve(payload, tierOf(high ? 'high' : undefined));
          const period = resolveControls(t.definition, current!.controls, semantic, ctx).periodLabel;
          const c = card(
            {
              approval,
              runId: ctx.runId,
              user: ctx.user,
              title: 'Send report',
              summary: `Send “${t.name}” for ${period} to ${count} ${count === 1 ? 'person' : 'people'} with this note`,
              fields: [],
              agent: 'DI',
              preview: { kind: 'message', to: recipients.map((r) => (r.kind === 'group' ? `${r.name} (${r.count})` : r.kind === 'external' ? `${r.name} (outside the institution)` : r.name)), subject: payload.subject, body: payload.body },
              records: 1,
              users: count,
              external,
              typed: high ? { prompt: 'Type the number of recipients to confirm', expected: String(count) } : undefined,
            },
            def.operation,
          );
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, risk_tier: approval.riskTier, recipients: count }, card: c, approval, superseded };
        }
        case 'report.export': {
          const none = needCurrent();
          if (none) return none;
          const t = await store.get(current!.templateId, ctx.user.id, viewer);
          const payload: ExportPayload = { templateId: t.templateId, format: a.format as 'xlsx' | 'csv', controls: current!.controls as Record<string, string> };
          const { approval, superseded } = await approve(payload, tierOf());
          const period = resolveControls(t.definition, current!.controls, semantic, ctx).periodLabel;
          const c = card(
            {
              approval,
              runId: ctx.runId,
              user: ctx.user,
              title: 'Export report',
              summary: `Export “${t.name}” for ${period} to ${FORMAT_LABEL[payload.format]}`,
              fields: [
                { label: 'Report', value: t.name },
                { label: 'Period', value: period },
                ...(current!.controls.node && t.definition.settings.addHierarchyControls ? [{ label: 'Branch', value: current!.controls.node === 'all' ? 'All branches' : current!.controls.node }] : []),
                { label: 'Format', value: FORMAT_LABEL[payload.format] },
                { label: 'Contents', value: 'The figures as shown, limited to your purview. The export is logged.' },
              ],
              records: 1,
              users: 1,
              external: 0,
            },
            def.operation,
          );
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId }, card: c, approval, superseded };
        }
        case 'report.pin': {
          const templateId = a.template_id ? String(a.template_id) : current?.templateId;
          if (!templateId) return needCurrent()!;
          const t = await store.get(templateId, ctx.user.id, viewer);
          if (t.status === 'draft') return { ok: false, code: 'INVALID', content: { error: 'INVALID', message: 'Save the draft before putting it on Home.' } };
          const asked = String(a.audience ?? 'me').trim();
          const me = /^(me|myself|my home|mine)$/i.test(asked);
          const cls = me ? 'me' : REPORT_CLASSES.find((k) => asked.toLowerCase().replace(/^the /, '').replace(/ (class|team|users?|group)$/, '').replace(/s$/, '') === k.toLowerCase());
          if (!cls) return { ok: false, code: 'INVALID', content: { error: 'INVALID', message: `I can’t publish it to the ${asked.charAt(0).toUpperCase()}${asked.slice(1).replace(/ class$/i, '')} class: only the ${REPORT_CLASSES.join(', ')} classes include Reports, so only they can open it on Home.` } };
          const payload: PinPayload = { templateId: t.templateId, templateName: t.name, audience: cls };
          const people = me ? 1 : ((await this.deps.classSize?.(cls)) ?? 0);
          const { approval, superseded } = await approve(payload, tierOf(me ? undefined : 'medium'));
          const c = card(
            {
              approval,
              runId: ctx.runId,
              user: ctx.user,
              title: me ? 'Pin to Home' : 'Publish to Home',
              summary: me ? `Pin “${t.name}” to your Home` : `Publish “${t.name}” to Home for the ${cls} class`,
              fields: [
                { label: 'Report', value: t.name },
                { label: 'Where', value: me ? 'Your Home, under Pinned' : `Home for everyone in the ${cls} class${people ? ` (${people} ${people === 1 ? 'person' : 'people'})` : ''}, under Pinned` },
                { label: 'Data', value: 'Each person sees the latest period, limited to their own purview' },
                { label: 'Undo', value: 'Ask DI to take it off Home at any time' },
              ],
              records: 1,
              users: people,
              external: 0,
            },
            def.operation,
          );
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, risk_tier: approval.riskTier, audience: cls }, card: c, approval, superseded };
        }
        case 'report.unpin': {
          const templateId = a.template_id ? String(a.template_id) : current?.templateId;
          if (!templateId) return needCurrent()!;
          const t = await store.get(templateId, ctx.user.id, viewer);
          const all = await store.pinsOf(t.templateId);
          // Your own Home first, then the classes, so the card reads the same way every time.
          const mine = all.filter((p) => p.pinnedById === ctx.user.id).sort((x, y) => (x.audience === 'me' ? -1 : y.audience === 'me' ? 1 : x.audience.localeCompare(y.audience)));
          if (!mine.length) {
            // Someone else's own pin is private; only a pin published to a class is theirs to explain.
            const other = all.find((p) => p.audience !== 'me');
            return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: other ? `${t.name} is on Home because ${other.pinnedBy} published it to the ${other.audience} class. Only they can take it off.` : `${t.name} isn’t on Home.` } };
          }
          const audiences = mine.map((p) => (p.audience === 'me' ? 'your Home' : `the ${p.audience} class`));
          const payload: UnpinPayload = { templateId: t.templateId, templateName: t.name, pinIds: mine.map((p) => p.pinId), audiences };
          const shared = mine.some((p) => p.audience !== 'me');
          const { approval, superseded } = await approve(payload, tierOf(shared ? 'medium' : undefined));
          const c = card({ approval, runId: ctx.runId, user: ctx.user, title: 'Take off Home', summary: `Take “${t.name}” off ${audiences.join(' and ')}`, fields: [{ label: 'Report', value: t.name }, { label: 'From', value: audiences.join(', ') }, { label: 'The report itself', value: `Stays in ${t.folder}` }], records: mine.length, users: shared ? 0 : 1, external: 0 }, def.operation);
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, removes: audiences }, card: c, approval, superseded };
        }
        case 'report.delete': {
          const templateId = a.template_id ? String(a.template_id) : current?.templateId;
          if (!templateId) return needCurrent()!;
          const t = await store.get(templateId, ctx.user.id, viewer);
          if (t.status === 'stock') return { ok: false, code: 'NO_ACCESS', content: { error: 'NO_ACCESS', message: `${t.name} is a stock report every user starts with, so it can’t be deleted.` } };
          if (t.status === 'draft') return { ok: false, code: 'INVALID', content: { error: 'INVALID', message: 'Drafts are private and aren’t kept once you leave them, so there’s nothing to delete.' } };
          if (t.ownerUserId !== ctx.user.id) return { ok: false, code: 'NO_ACCESS', content: { error: 'NO_ACCESS', message: `${t.name} belongs to ${t.ownerName}. Only they can delete it.` } };
          const pins = await store.pinsOf(t.templateId);
          const schedules = (await store.schedules(ctx.user.id)).filter((s) => s.templateId === t.templateId);
          const payload: BinPayload = { templateId: t.templateId, templateName: t.name, folder: t.folder };
          const { approval, superseded } = await approve(payload, tierOf());
          const c = card(
            {
              approval,
              runId: ctx.runId,
              user: ctx.user,
              title: 'Delete report',
              summary: `Move “${t.name}” to the Recycle Bin`,
              fields: [
                { label: 'Report', value: `${t.name}, in ${t.folder}` },
                { label: 'Home', value: pins.length ? `Taken off ${pins.length} ${pins.length === 1 ? 'Home pin' : 'Home pins'}` : 'Not on anyone’s Home' },
                ...(schedules.length ? [{ label: 'Schedules', value: `${schedules.length} active ${schedules.length === 1 ? 'schedule stops' : 'schedules stop'} finding it until it’s restored` }] : []),
                { label: 'Undo', value: 'Restore it from the Recycle Bin. Nothing is erased.' },
              ],
              records: 1,
              users: 0,
              external: 0,
            },
            def.operation,
          );
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId }, card: c, approval, superseded };
        }
        case 'report.bin.list': {
          const items = await store.bin(ctx.user.id);
          return { ok: true, content: { recycle_bin: items.map((t) => ({ template_id: t.templateId, name: t.name, folder: t.folder, deleted: t.updatedAt.slice(0, 10) })) }, list: { kind: 'templates', items } };
        }
        case 'report.restore': {
          const t = (await store.bin(ctx.user.id)).find((x) => x.templateId === String(a.template_id));
          if (!t) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: 'That report isn’t in your Recycle Bin.' } };
          const payload: BinPayload = { templateId: t.templateId, templateName: t.name, folder: t.folder };
          const { approval, superseded } = await approve(payload, tierOf());
          const c = card({ approval, runId: ctx.runId, user: ctx.user, title: 'Restore report', summary: `Restore “${t.name}” to ${t.folder}`, fields: [{ label: 'Report', value: t.name }, { label: 'Back to', value: t.folder }, { label: 'Home', value: 'Not pinned again; ask to put it back on Home' }], records: 1, users: 0, external: 0 }, def.operation);
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId }, card: c, approval, superseded };
        }
      }
      return { ok: false, code: 'UNKNOWN_TOOL', content: { error: 'UNKNOWN_TOOL' } };
    } catch (e) {
      if (e instanceof CoreError) return { ok: false, code: e.code === 'INVALID' ? 'INVALID' : e.code, content: { error: e.code, message: e.message } };
      throw e;
    }
  }

  /** Runs an approved report write. The stored payload is executed as approved, once. */
  async execute(approval: ApprovalRecord, ctx: { user: { id: string; name: string } }): Promise<ReportExecuted> {
    if (approval.status !== 'approved') throw new Error(`Approval ${approval.approvalId} is ${approval.status}`);
    const meta = { approvalId: approval.approvalId, userId: ctx.user.id, userName: ctx.user.name };
    try {
      let out: ReportExecuted;
      if (approval.operation === 'report.template.create') {
        const template = await this.deps.store.publish(approval.payload as SavePayload, { ...meta, agent: REPORT_AGENT, modelVersion: this.deps.semantic.model.version });
        out = { operation: 'report.template.create', template };
      } else if (approval.operation === 'report.schedule.create') {
        out = { operation: 'report.schedule.create', schedule: await this.deps.store.createSchedule(approval.payload as ScheduleDraft, meta) };
      } else if (approval.operation === 'report.schedule.cancel') {
        out = { operation: 'report.schedule.cancel', schedule: await this.deps.store.cancelSchedule((approval.payload as CancelPayload).scheduleId, ctx.user.id) };
      } else if (approval.operation === 'report.share') {
        const p = approval.payload as SharePayload;
        const s = await this.deps.store.createShare(p, meta);
        out = { operation: 'report.share', shareId: s.shareId, recipientCount: s.recipientCount, templateName: p.templateName };
      } else if (approval.operation === 'report.export') {
        const p = approval.payload as ExportPayload;
        const e = await this.deps.store.createExport(p, meta);
        const t = await this.deps.store.get(p.templateId, ctx.user.id);
        out = { operation: 'report.export', exportId: e.exportId, format: p.format, templateName: t.name };
      } else if (approval.operation === 'report.pin') {
        const p = approval.payload as PinPayload;
        const r = await this.deps.store.pin(p, meta);
        out = { operation: 'report.pin', pinId: r.pinId, templateId: p.templateId, templateName: p.templateName, audience: p.audience };
      } else if (approval.operation === 'report.unpin') {
        const p = approval.payload as UnpinPayload;
        await this.deps.store.unpin(p.pinIds, meta);
        out = { operation: 'report.unpin', removed: p.pinIds.length, templateName: p.templateName };
      } else if (approval.operation === 'report.delete') {
        const p = approval.payload as BinPayload;
        await this.deps.store.toBin(p.templateId, meta);
        out = { operation: 'report.delete', templateId: p.templateId, templateName: p.templateName };
      } else if (approval.operation === 'report.restore') {
        const p = approval.payload as BinPayload;
        const t = await this.deps.store.restore(p.templateId, meta);
        out = { operation: 'report.restore', templateId: t.templateId, templateName: t.name, folder: t.folder };
      } else if (approval.operation === 'report.settings.update') {
        const p = approval.payload as SettingsPayload;
        const t = await this.deps.store.updateSettings(p, meta);
        // The card's before and after, read again from the stored payload.
        const changes = settingsDiff(applySettings(t.definition, p.before), p.after).changes;
        out = { operation: 'report.settings.update', templateId: t.templateId, templateName: t.name, changes, turnedOff: p.after.enabled === false, replayed: t.replayed };
      } else throw new Error(`No executor for ${approval.operation}`);
      await this.deps.approvals.markExecuted(approval.approvalId, approval.operation);
      return out;
    } catch (e) {
      await this.deps.approvals.markFailed(approval.approvalId);
      throw e;
    }
  }
}
