// Block type schemas for Slice 0 (spec 9.4, 9.7). Objects are strict: unknown keys are rejected,
// which is how ECharts/AG Grid options, formatters and HTML are kept out (FE-GEN-003, FE-GEN-004).
import { z } from 'zod';
import { envelopeFields, riskTier } from './envelope.ts';

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// ---- text -------------------------------------------------------------------------------------
export const textData = z.strictObject({
  markdown: z.string().max(8000),
  citations: z.array(z.number().int().nonnegative()).optional(),
});

// ---- kpi --------------------------------------------------------------------------------------
export const valueUnit = z.enum(['currency', 'percent', 'count', 'bp', 'days', 'number']);
export type ValueUnit = z.infer<typeof valueUnit>;

export const kpiData = z.strictObject({
  label: z.string().max(80),
  value: z.number().nullable(),
  unit: valueUnit,
  format: z.strictObject({ decimals: z.number().int().min(0).max(4).optional(), compact: z.boolean().optional() }).optional(),
  comparison: z
    .strictObject({
      label: z.string().max(60),
      value: z.number(),
      unit: valueUnit.optional(),
      direction: z.enum(['up', 'down', 'flat']),
      goodWhen: z.enum(['up', 'down']),
    })
    .optional(),
  sparkline: z.array(z.number()).max(60).optional(),
  metricRef: z.string().optional(),
});

export const kpiGroupData = z.strictObject({
  items: z.array(kpiData).min(2).max(8),
  layout: z.enum(['row', 'grid']).default('row'),
});

// ---- chart ------------------------------------------------------------------------------------
export const chartData = z.strictObject({
  chartType: z.enum(['line', 'bar', 'stacked_bar', 'area', 'pie', 'donut', 'scatter', 'heatmap', 'combo']),
  dataset: z.strictObject({
    dimensions: z
      .array(z.strictObject({ name: z.string(), displayName: z.string().optional(), type: z.enum(['ordinal', 'number', 'time']).optional() }))
      .min(1),
    source: z.array(z.array(cell)).max(5000),
  }),
  series: z
    .array(
      z.strictObject({
        name: z.string().max(60),
        type: z.enum(['line', 'bar', 'area', 'scatter']).optional(),
        encode: z.strictObject({ x: z.string(), y: z.string() }),
        stack: z.string().optional(),
        yAxisIndex: z.number().int().min(0).max(1).optional(),
        /** Prior-period series: same hue, lighter, dashed (spec 10.4). */
        comparison: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(20),
  axes: z
    .strictObject({
      x: z.strictObject({ title: z.string().optional() }).optional(),
      y: z.array(z.strictObject({ title: z.string().optional(), unit: valueUnit.optional() })).max(2).optional(),
    })
    .optional(),
  legend: z.boolean().optional(),
  markLines: z.array(z.strictObject({ value: z.number(), label: z.string().max(40) })).max(4).optional(),
  sampled: z.boolean().optional(),
});

// ---- table ------------------------------------------------------------------------------------
export const columnType = z.enum(['text', 'number', 'currency', 'percent', 'bp', 'count', 'date', 'days']);

export const tableData = z.strictObject({
  columns: z
    .array(
      z.strictObject({
        field: z.string(),
        headerName: z.string().max(60),
        type: columnType.default('text'),
        pinned: z.enum(['left', 'right']).optional(),
        hidden: z.boolean().optional(),
        width: z.number().int().min(48).max(600).optional(),
      }),
    )
    .min(1)
    .max(60),
  rows: z.array(z.record(z.string(), cell)).max(500).optional(),
  sort: z.array(z.strictObject({ field: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
  rowCount: z.number().int().nonnegative(),
});

// ---- notice -----------------------------------------------------------------------------------
export const noticeData = z.strictObject({
  kind: z.enum(['info', 'warning', 'error', 'no_access', 'no_data', 'not_supported', 'uncertain', 'beta', 'build_status']),
  message: z.string().max(600),
  detail: z.string().max(1200).optional(),
  permission: z.string().max(120).optional(),
  referenceId: z.string().max(40).optional(),
  retryable: z.boolean().optional(),
  options: z.array(z.strictObject({ id: z.string(), label: z.string().max(80) })).max(6).optional(),
});

// ---- plan_steps -------------------------------------------------------------------------------
export const stepState = z.enum(['waiting', 'running', 'done', 'skipped', 'failed', 'needs_input']);
export type StepState = z.infer<typeof stepState>;

export const planStep = z.strictObject({
  id: z.string(),
  label: z.string().max(160),
  agent: z.string().max(60),
  state: stepState,
  startedAt: z.iso.datetime({ offset: true }).optional(),
  endedAt: z.iso.datetime({ offset: true }).optional(),
  resultSummary: z.string().max(240).optional(),
  operations: z
    .array(
      z.strictObject({
        name: z.string(),
        params: z.record(z.string(), cell).optional(),
        /** Present only when the server knows the user holds Query Browser (FE-EXP-061). */
        sql: z.string().optional(),
      }),
    )
    .optional(),
  riskTier: riskTier.optional(),
});

export const planStepsData = z.strictObject({
  runId: z.string(),
  steps: z.array(planStep).max(40),
  cancellable: z.boolean(),
  state: z.enum(['running', 'completed', 'failed', 'cancelled']).default('running'),
});

// ---- approval_card ----------------------------------------------------------------------------
const previewField = z.strictObject({ label: z.string().max(60), value: z.string().max(400) });

export const approvalPreview = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('record'), fields: z.array(previewField).max(40) }),
  z.strictObject({
    kind: z.literal('diff'),
    changes: z.array(z.strictObject({ label: z.string().max(60), before: z.string().max(400), after: z.string().max(400) })).max(40),
  }),
  z.strictObject({
    kind: z.literal('bulk'),
    description: z.string().max(300),
    count: z.number().int().nonnegative(),
    columns: z.array(z.strictObject({ field: z.string(), headerName: z.string(), type: columnType.default('text') })).max(8),
    sample: z.array(z.record(z.string(), cell)).max(10),
    totals: z.array(previewField).max(4).optional(),
  }),
  z.strictObject({
    kind: z.literal('message'),
    to: z.array(z.string().max(120)).max(50),
    subject: z.string().max(200).optional(),
    body: z.string().max(4000),
  }),
]);
export type ApprovalPreview = z.infer<typeof approvalPreview>;

export const approvalData = z.strictObject({
  approvalId: z.string().regex(/^apr_[A-Za-z0-9]{8,32}$/),
  summary: z.string().max(200),
  riskTier: riskTier.exclude(['read']),
  operation: z.string(),
  requestedBy: z.strictObject({
    kind: z.enum(['user', 'agent_run']),
    runId: z.string().optional(),
    agent: z.string().optional(),
    onBehalfOf: z.string(),
    onBehalfOfName: z.string().optional(),
  }),
  preview: approvalPreview,
  affected: z.strictObject({ records: z.number().int(), users: z.number().int(), external: z.number().int() }),
  confirmation: z.strictObject({
    methods: z.array(z.enum(['click', 'keyboard', 'voice'])).min(1),
    /** High risk: the user must type this key value exactly (FE-EXP-081). */
    typedValue: z.strictObject({ prompt: z.string().max(120), expected: z.string().max(80) }).nullable(),
    stepUp: z.boolean(),
    secondApprover: z.strictObject({ role: z.string().max(80), policy: z.string().max(40).optional() }).nullable(),
    noteRequired: z.boolean(),
  }),
  editablePlan: z.boolean(),
  expiresAt: z.iso.datetime({ offset: true }),
  idempotencyKey: z.string().min(8),
  previewHash: z.string().regex(/^sha256:[a-f0-9]{8,64}$/),
  /** Set by approval.resolved; the card then becomes a read-only record of the decision. */
  resolution: z
    .strictObject({
      decision: z.enum(['approved', 'denied', 'returned', 'expired']),
      by: z.string(),
      at: z.iso.datetime({ offset: true }),
      channel: z.enum(['click', 'keyboard', 'voice']).optional(),
      note: z.string().optional(),
    })
    .optional(),
});
export type ApprovalData = z.infer<typeof approvalData>;

// ---- list -------------------------------------------------------------------------------------
/** Icons are named, never markup; the client maps names to its own icon set. */
export const listIcon = z.enum([
  'alert',
  'trend_down',
  'trend_up',
  'calendar',
  'clock',
  'inbox',
  'task',
  'report',
  'report_failed',
  'member',
  'referral',
  'loan',
  'certificate',
  'database',
  'workflow',
]);
export type ListIcon = z.infer<typeof listIcon>;

export const listData = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string().max(160),
        subtitle: z.string().max(240).optional(),
        meta: z.string().max(80).optional(),
        icon: listIcon.optional(),
        /** A DI Next deep link (spec 11.4). Relative paths only. */
        link: z.string().regex(/^\/[^/]/).optional(),
        badge: z.strictObject({ label: z.string().max(30), tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'accent']) }).optional(),
        /** Plain-language reason an item was flagged ("Why?", spec 6.3 FE-EXP-013). */
        why: z.string().max(400).optional(),
      }),
    )
    .max(200),
  groupBy: z.string().optional(),
  layout: z.enum(['list', 'columns']).default('list'),
});

// ---- definition_card --------------------------------------------------------------------------
/** A metric's governed definition from the semantic layer (spec 6.12, AI-AGT-041). */
export const definitionData = z.strictObject({
  term: z.string().max(120),
  metricRef: z.string().max(80),
  definition: z.string().max(800),
  formula: z.string().max(300),
  regulatoryBasis: z.string().max(600).optional(),
  owner: z.string().max(80),
  version: z.string().max(40),
  dimensions: z.array(z.string().max(60)).max(20).default([]),
  trendable: z.boolean().default(true),
});

/** DI's view of a record: one sentence, and the next step it would take. Code writes both. */
export const diTake = z.strictObject({
  headline: z.string().max(300),
  action: z.strictObject({ label: z.string().max(40), ask: z.string().max(200) }).optional(),
});

// ---- member_card and member_360 ---------------------------------------------------------------
/** Spec 8.24, 24.15. Identifiers are masked to the last four digits; no SSN or date of birth (AI-AGT-151). */
const tone = z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'accent']);
const isoDate = z.iso.date();
const labelValue = z.strictObject({ label: z.string().max(40), value: z.string().max(120) });
const count = z.number().int().nonnegative();

const memberHeader = {
  /** Opaque record token; never a member or account number (FE-ARCH-011). */
  memberRef: z.string().regex(/^mbr_[A-Za-z0-9_-]{16,40}$/),
  /** "member" or "customer" by tenant type (FE-RM-005). */
  person: z.enum(['member', 'customer']),
  displayName: z.string().max(80),
  maskedNumber: z.string().regex(/^…\d{4}$/),
  branch: z.string().max(60),
  since: z.string().regex(/^\d{4}$/),
  badges: z.array(z.strictObject({ label: z.string().max(30), tone })).max(6),
};

const figure = z.strictObject({ label: z.string().max(40), value: z.number().nullable(), unit: valueUnit, detail: z.string().max(80).optional() });

/** A model score on a 0-10 scale [Assumption CA-41]; "Why?" shows its factors and run date (FE-RM-002). */
export const memberScore = z.strictObject({
  id: z.enum(['attrition', 'next_best', 'lifetime_value']),
  label: z.string().max(40),
  value: z.number().min(0).max(10),
  scale: z.literal(10),
  band: z.string().max(40),
  tone,
  modelDate: isoDate,
});

export const memberCardData = z.strictObject({
  ...memberHeader,
  figures: z.array(figure).max(4),
  scores: z.array(memberScore).max(3),
  nextBest: z.array(z.string().max(40)).max(3),
  /** True for the record the conversation is now about; false for a card in a pick list. */
  selected: z.boolean(),
});

const accountRow = z.strictObject({
  name: z.string().max(60),
  suffix: z.string().regex(/^\d{4}$/),
  relationship: z.enum(['Primary', 'Joint', 'Authorized']),
  balance: z.number(),
  /** Balance change against 30 days earlier [CA-29]. */
  change30d: z.number(),
  fees30d: z.number(),
  rate: z.number().optional(),
  detail: z.string().max(80).optional(),
});

/** The Relationship Dashboard's sections, in its order [BK p11] (FE-RM-001). */
export const member360Section = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('overview'), figures: z.array(figure).max(8), scores: z.array(memberScore).max(3), facts: z.array(labelValue).max(8) }),
  z.strictObject({ kind: z.literal('accounts'), deposits: z.array(accountRow).max(40), loans: z.array(accountRow).max(40) }),
  z.strictObject({ kind: z.literal('digital'), services: z.array(z.strictObject({ id: z.string().max(40), label: z.string().max(40), enrolled: z.boolean(), detail: z.string().max(80).optional() })).max(12) }),
  z.strictObject({
    kind: z.literal('cross_sell'),
    windows: z.array(z.strictObject({ days: z.number().int().positive(), total: count, services: count, loan: count, deposit: count })).max(3),
    crossSell: count,
    attrition: memberScore,
  }),
  z.strictObject({
    kind: z.literal('loan_apps'),
    approved: count,
    denied: count,
    pending: count,
    items: z.array(z.strictObject({ product: z.string().max(60), amount: z.number(), status: z.enum(['Approved', 'Denied', 'Pending']), detail: z.string().max(80), applied: isoDate })).max(20),
  }),
  z.strictObject({ kind: z.literal('engagement'), attrition: memberScore, factors: z.array(z.strictObject({ label: z.string().max(120), weight: z.number() })).max(10), facts: z.array(labelValue).max(8) }),
  z.strictObject({
    kind: z.literal('opportunities'),
    threshold: z.number().int().min(0).max(10),
    items: z.array(z.strictObject({ suggestionId: z.number().int().positive(), product: z.string().max(60), likelihood: z.number().min(0).max(10), reason: z.string().max(200), referralTypeId: z.string().max(40).nullable() })).max(10),
    declined: z.array(z.strictObject({ product: z.string().max(60), until: isoDate, by: z.string().max(80) })).max(10),
  }),
  z.strictObject({
    kind: z.literal('interactions'),
    total: count,
    items: z.array(z.strictObject({ at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/), channel: z.string().max(30), kind: z.string().max(40), summary: z.string().max(200), by: z.string().max(80).nullable() })).max(20),
  }),
  z.strictObject({ kind: z.literal('rewards'), status: z.enum(['not_configured', 'enrolled', 'not_enrolled']), detail: z.string().max(200).optional() }),
  z.strictObject({ kind: z.literal('contact'), preferred: z.string().max(30), email: z.string().max(120), phone: z.string().max(30) }),
  z.strictObject({
    kind: z.literal('household'),
    members: z.array(z.strictObject({ name: z.string().max(80).nullable(), branch: z.string().max(60).nullable(), maskedNumber: z.string().regex(/^…\d{4}$/).nullable(), inPurview: z.boolean() })).max(12),
  }),
]);
export type Member360Section = z.infer<typeof member360Section>;

export const member360Data = z.strictObject({
  ...memberHeader,
  alerts: z.array(z.strictObject({ id: z.string().max(40), label: z.string().max(120), tone })).max(12),
  take: diTake.optional(),
  sections: z.array(member360Section).min(1).max(12),
});

// ---- union ------------------------------------------------------------------------------------
const block = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.strictObject({ ...envelopeFields, type: z.literal(type), data });

export const textBlock = block('text', textData);
export const kpiBlock = block('kpi', kpiData);
export const kpiGroupBlock = block('kpi_group', kpiGroupData);
export const chartBlock = block('chart', chartData);
export const tableBlock = block('table', tableData);
export const noticeBlock = block('notice', noticeData);
export const planStepsBlock = block('plan_steps', planStepsData);
export const approvalCardBlock = block('approval_card', approvalData);
export const listBlock = block('list', listData);
export const definitionCardBlock = block('definition_card', definitionData);
export const memberCardBlock = block('member_card', memberCardData);
export const member360Block = block('member_360', member360Data);

// ---- report_canvas ----------------------------------------------------------------------------
/**
 * A report on a 12-column grid (spec 8.9, 9.4). Each widget carries a complete kpi, chart, table,
 * text or notice block, built by code from a semantic query, so the canvas reuses those renderers
 * and their validation. Controls re-run the report without a new turn (spec 8.5).
 */
export const reportControl = z.strictObject({
  id: z.enum(['period', 'node']),
  kind: z.enum(['period', 'hierarchy']),
  label: z.string().max(40),
  value: z.string().max(40),
  options: z.array(z.strictObject({ value: z.string().max(40), label: z.string().max(60) })).min(1).max(40),
});

export const reportWidget = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]{1,30}$/),
  title: z.string().max(100),
  gridPos: z.strictObject({ x: z.number().int().min(0).max(11), y: z.number().int().min(0).max(200), w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(12) }),
  view: z.discriminatedUnion('type', [kpiBlock, chartBlock, tableBlock, textBlock, noticeBlock]),
  /** The agent edit that produced this widget, highlighted until accepted or reverted (FE-BLD-003). */
  editId: z.string().max(20).optional(),
});

export const reportCanvasData = z.strictObject({
  templateRef: z.string().regex(/^[a-z0-9_]{3,60}$/),
  name: z.string().max(120),
  description: z.string().max(300).optional(),
  folder: z.string().max(80),
  status: z.enum(['stock', 'published', 'draft']),
  mode: z.enum(['read', 'edit']),
  version: z.number().int().positive(),
  periodLabel: z.string().max(40),
  /** Worked out on each run, so it follows the controls. */
  take: diTake.optional(),
  controls: z.array(reportControl).max(6),
  widgets: z.array(reportWidget).max(24),
  pendingEdits: z.array(z.strictObject({ id: z.string().max(20), widgetId: z.string().max(30), summary: z.string().max(160), kind: z.enum(['add', 'change', 'remove', 'move']) })).max(24),
  /** "Created by Report Builder for Dana Lee, approved 28 Oct 2026" (AI-AGT-052). */
  origin: z.string().max(200).optional(),
  /** Generated queries, present only for Query Browser users in test mode (FE-BLD-004). */
  queries: z.array(z.strictObject({ widgetId: z.string(), sql: z.string().max(4000) })).max(24).optional(),
});

export const reportCanvasBlock = block('report_canvas', reportCanvasData);

export const blockSchema = z.discriminatedUnion('type', [
  reportCanvasBlock,
  memberCardBlock,
  member360Block,
  textBlock,
  kpiBlock,
  kpiGroupBlock,
  chartBlock,
  tableBlock,
  noticeBlock,
  planStepsBlock,
  approvalCardBlock,
  listBlock,
  definitionCardBlock,
]);

export type Block = z.infer<typeof blockSchema>;
export type BlockOf<T extends Block['type']> = Extract<Block, { type: T }>;
export type TextBlock = BlockOf<'text'>;
export type KpiBlock = BlockOf<'kpi'>;
export type KpiData = z.infer<typeof kpiData>;
export type KpiGroupBlock = BlockOf<'kpi_group'>;
export type ChartBlock = BlockOf<'chart'>;
export type TableBlock = BlockOf<'table'>;
export type NoticeBlock = BlockOf<'notice'>;
export type PlanStepsBlock = BlockOf<'plan_steps'>;
export type PlanStep = z.infer<typeof planStep>;
export type ApprovalCardBlock = BlockOf<'approval_card'>;
export type ListBlock = BlockOf<'list'>;
export type DefinitionCardBlock = BlockOf<'definition_card'>;
export type MemberCardBlock = BlockOf<'member_card'>;
export type Member360Block = BlockOf<'member_360'>;
export type MemberScore = z.infer<typeof memberScore>;
export type ReportCanvasBlock = BlockOf<'report_canvas'>;
export type ReportWidgetView = z.infer<typeof reportWidget>;
export type ReportControl = z.infer<typeof reportControl>;

export const blockSchemasByType = {
  report_canvas: reportCanvasBlock,
  member_card: memberCardBlock,
  member_360: member360Block,
  text: textBlock,
  kpi: kpiBlock,
  kpi_group: kpiGroupBlock,
  chart: chartBlock,
  table: tableBlock,
  notice: noticeBlock,
  plan_steps: planStepsBlock,
  approval_card: approvalCardBlock,
  list: listBlock,
  definition_card: definitionCardBlock,
} as const;
