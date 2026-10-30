// Model router (spec 23.6). Agents ask for a role, never a model; model IDs are configuration.
// The ModelClient interface keeps the Anthropic SDK behind one seam, so the Azure move swaps the
// client for Claude on Microsoft Foundry, and tests swap it for a scripted fake.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

export type ModelRole = 'router_fast' | 'specialist_default' | 'specialist_strong';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RoleConfig {
  model: string;
  effort: Effort;
  maxTokens: number;
  /** Server-side refusal fallback ("default" routing), Claude API only (spec 23.6.4). */
  fallback: boolean;
}

/**
 * Defaults follow spec 23.6.1 model classes: a Haiku-class router, a Sonnet-class default
 * specialist and the strongest approved model for hard query construction. Override per
 * environment with DI_MODEL_ROUTER, DI_MODEL_DEFAULT, DI_MODEL_STRONG and DI_EFFORT_*.
 */
export function modelRoles(env: NodeJS.ProcessEnv = process.env): Record<ModelRole, RoleConfig> {
  const effort = (v: string | undefined, d: Effort): Effort => (v && ['low', 'medium', 'high', 'xhigh', 'max'].includes(v) ? (v as Effort) : d);
  return {
    router_fast: { model: env.DI_MODEL_ROUTER ?? 'claude-haiku-5-5', effort: effort(env.DI_EFFORT_ROUTER, 'low'), maxTokens: 4000, fallback: false },
    specialist_default: { model: env.DI_MODEL_DEFAULT ?? 'claude-sonnet-5-5', effort: effort(env.DI_EFFORT_DEFAULT, 'medium'), maxTokens: 16000, fallback: true },
    specialist_strong: { model: env.DI_MODEL_STRONG ?? 'claude-opus-5-5', effort: effort(env.DI_EFFORT_STRONG, 'medium'), maxTokens: 16000, fallback: true },
  };
}

export interface Usage {
  model: string;
  role: ModelRole;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TurnRequest {
  role: ModelRole;
  /** Stable instructions first, so the prefix caches (spec 23.6.3). */
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
  signal?: AbortSignal;
}

export interface ModelClient {
  /** One step of an agent's tool loop. */
  turn(req: TurnRequest): Promise<{ message: Anthropic.Beta.BetaMessage; usage: Usage }>;
  /** Schema-validated JSON from the fast model, for routing (spec 23.3.2). */
  structured<T extends z.ZodType>(req: { role: ModelRole; system: string; user: string; schema: T; signal?: AbortSignal }): Promise<{ value: z.infer<T> | null; usage: Usage }>;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  constructor(
    private readonly roles = modelRoles(),
    client?: Anthropic,
  ) {
    // Only DI_ANTHROPIC_API_KEY (from app/.env) is used. Ambient ANTHROPIC_* variables belong
    // to whatever tool launched the process and must never carry DI traffic or cost.
    this.client =
      client ??
      new Anthropic({
        apiKey: process.env.DI_ANTHROPIC_API_KEY ?? null,
        authToken: null,
        baseURL: process.env.DI_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
        maxRetries: 2,
        timeout: 60_000,
      });
  }

  async turn(req: TurnRequest) {
    const cfg = this.roles[req.role];
    const stream = this.client.beta.messages.stream(
      {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        output_config: { effort: cfg.effort },
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        tools: req.tools,
        messages: req.messages,
        ...(cfg.fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
      },
      { signal: req.signal },
    );
    const message = await stream.finalMessage();
    return { message, usage: usageOf(cfg.model, req.role, message.usage) };
  }

  async structured<T extends z.ZodType>(req: { role: ModelRole; system: string; user: string; schema: T; signal?: AbortSignal }) {
    const cfg = this.roles[req.role];
    const response = await this.client.messages.parse(
      {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        output_config: { effort: cfg.effort, format: zodOutputFormat(req.schema) },
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      },
      { signal: req.signal },
    );
    const value = response.stop_reason === 'refusal' ? null : ((response.parsed_output as z.infer<T> | null) ?? null);
    return { value, usage: usageOf(cfg.model, req.role, response.usage) };
  }
}

function usageOf(model: string, role: ModelRole, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): Usage {
  return { model, role, inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 };
}

/** Per-million-token list prices (input, output, cache read) for cost records (spec 28.2). */
const PRICES: Record<string, [number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
};

export function costUsd(u: Usage): number {
  const p = PRICES[u.model];
  if (!p) return 0;
  return (u.inputTokens * p[0] + u.outputTokens * p[1] + u.cacheReadTokens * p[2] + u.cacheWriteTokens * p[0] * 1.25) / 1_000_000;
}

/** True when the SDK can find credentials; without them the Concierge runs in offline mode. */
export const hasClaudeCredentials = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.DI_ANTHROPIC_API_KEY);
