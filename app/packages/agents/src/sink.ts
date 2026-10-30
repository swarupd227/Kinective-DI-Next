// What an agent run can show the user. The Experience Layer maps these to stream events
// (spec 12.4); agents never touch the socket or the client.
import type { Block } from '@dinext/block-schemas';

export interface StepUpdate {
  id: string;
  label?: string;
  agent?: string;
  state: 'waiting' | 'running' | 'done' | 'skipped' | 'failed' | 'needs_input';
  operation?: string;
  resultSummary?: string;
}

export interface RunSink {
  readonly signal: AbortSignal;
  routing(agent: string, reason?: string): void;
  /** Opens a plan_steps block and returns its block id. */
  plan(title: string, agent: string, steps: StepUpdate[]): string;
  step(planBlockId: string, update: StepUpdate): void;
  /** Streams verified Markdown as a text block. */
  text(markdown: string, agent: string, sources?: Block['provenance']['sources']): Promise<void>;
  block(block: Block): Promise<void>;
  suggestion(text: string): void;
  /** Ends work that continued after the turn, such as executing an approved write. */
  done?(result: unknown): void;
}
