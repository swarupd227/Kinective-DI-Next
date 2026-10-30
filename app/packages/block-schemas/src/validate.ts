import { blockSchemasByType, type Block } from './blocks.ts';
import { BLOCK_TYPES, type BlockType } from './envelope.ts';

/** Block majors this client renders; sent in the stream hello (spec 12.2, FE-GEN-050). */
export const BLOCK_SUPPORT = {
  text: '1.x',
  kpi: '1.x',
  kpi_group: '1.x',
  chart: '2.x',
  table: '1.x',
  notice: '1.x',
  plan_steps: '1.x',
  approval_card: '1.x',
  list: '1.x',
  definition_card: '1.x',
  member_card: '1.x',
  member_360: '1.x',
  report_canvas: '1.x',
} as const satisfies Partial<Record<BlockType, `${number}.x`>>;

export type SupportedBlockType = keyof typeof BLOCK_SUPPORT;

export type BlockValidation =
  | { ok: true; block: Block }
  | { ok: false; reason: 'unknown_type' | 'not_implemented' | 'unsupported_version' | 'invalid'; type?: string; issues: string[] };

const majorOf = (version: unknown) => (typeof version === 'string' ? Number(version.split('.')[0]) : NaN);

export const isSupportedType = (type: string): type is SupportedBlockType => type in BLOCK_SUPPORT;

/**
 * Validates a complete block before render (spec 9.1). Anything that fails is dropped and replaced
 * by an error notice by the caller; unknown optional properties within a known major are an error
 * here because the schemas are strict, which is the safer reading of 9.9 until v1.1 blocks exist.
 */
export function validateBlock(raw: unknown): BlockValidation {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'invalid', issues: ['Block is not an object'] };
  const { type, version } = raw as { type?: unknown; version?: unknown };
  if (typeof type !== 'string' || !(BLOCK_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'unknown_type', type: String(type), issues: [`Unknown block type "${String(type)}"`] };
  }
  if (!isSupportedType(type)) {
    return { ok: false, reason: 'not_implemented', type, issues: [`Block type "${type}" is not available in this client yet`] };
  }
  const supportedMajor = Number(BLOCK_SUPPORT[type].split('.')[0]);
  if (majorOf(version) !== supportedMajor) {
    return { ok: false, reason: 'unsupported_version', type, issues: [`${type} ${String(version)} needs a newer client`] };
  }
  const parsed = blockSchemasByType[type].safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid',
      type,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, block: parsed.data as Block };
}
