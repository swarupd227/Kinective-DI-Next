// Common block envelope (spec 9.2). Every agent block is data only: no markup, no code (spec 9.1).
import { z } from 'zod';

export const BLOCK_TYPES = [
  'text',
  'kpi',
  'kpi_group',
  'chart',
  'table',
  'pivot',
  'member_card',
  'member_360',
  'list',
  'form',
  'approval_card',
  'plan_steps',
  'timeline',
  'map',
  'funnel',
  'lineage_graph',
  'report_canvas',
  'file_drop',
  'sql_view',
  'definition_card',
  'notice',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const blockId = z.string().regex(/^blk_[A-Za-z0-9]{12,32}$/);
export const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
export const riskTier = z.enum(['read', 'low', 'medium', 'high']);
export type RiskTier = z.infer<typeof riskTier>;

export const source = z.object({
  kind: z.enum(['table', 'view', 'metric', 'report', 'template', 'model', 'file', 'workflow']),
  label: z.string().max(80),
  ref: z.string().optional(),
  accessible: z.boolean().optional(),
});
export type Source = z.infer<typeof source>;

export const provenance = z.object({
  agent: z.string(),
  runId: z.string().optional(),
  operations: z.array(z.string()).optional(),
  sources: z.array(source).max(20),
  filters: z.array(z.string()).optional(),
  purviewApplied: z.boolean().optional(),
  semanticQueryId: z.string().optional(),
});
export type Provenance = z.infer<typeof provenance>;

export const freshness = z.object({
  kind: z.enum(['nightly_build', 'workflow_event', 'static', 'none']),
  asOf: z.iso.datetime({ offset: true }).optional(),
  buildId: z.string().optional(),
  /** Set when last night's build has not completed and this block shows an older build (spec 10.5). */
  stale: z.boolean().optional(),
});
export type Freshness = z.infer<typeof freshness>;

/** Action params are plain values only, so an agent can never smuggle code through an action. */
const plainValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const action = z.object({
  id: z.string(),
  kind: z.enum([
    'pin',
    'explain',
    'open_workspace',
    'export',
    'share_link',
    'drill',
    'ask_followup',
    'open_record',
    'run_operation',
    'download',
    'copy',
    'speak',
  ]),
  label: z.string().max(40),
  operation: z.string().optional(),
  params: z.record(z.string(), plainValue).optional(),
  riskTier: riskTier.optional(),
});
export type BlockAction = z.infer<typeof action>;

export const control = z.object({
  id: z.string(),
  kind: z.enum(['period', 'hierarchy', 'select', 'multiselect', 'date_range', 'toggle', 'number']),
  label: z.string().optional(),
  value: z.unknown().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

export const dataRef = z.object({
  handle: z.string(),
  rowCount: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

export const envelopeFields = {
  id: blockId,
  version: semver,
  title: z.string().max(120).optional(),
  subtitle: z.string().max(200).optional(),
  dataRef: dataRef.optional(),
  provenance,
  freshness,
  actions: z.array(action).max(12).optional(),
  permissions: z
    .object({
      requires: z.array(z.string()).optional(),
      pinnable: z.boolean().optional(),
      exportable: z.boolean().optional(),
      shareable: z.boolean().optional(),
    })
    .optional(),
  controls: z.array(control).optional(),
  a11y: z.object({ summary: z.string().max(600) }).optional(),
  speakable: z.string().max(600).optional(),
  dqStatus: z.enum(['ok', 'warning', 'failed', 'unknown']).optional(),
  status: z.enum(['streaming', 'complete', 'error']).optional(),
};

/** Envelope as it arrives in block.start: data may be partial until block.end (spec 9.8). */
export const streamingEnvelope = z.strictObject({
  ...envelopeFields,
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type StreamingEnvelope = z.infer<typeof streamingEnvelope>;
