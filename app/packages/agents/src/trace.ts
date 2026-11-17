// A run's trace for the audit record (spec 26.10, AI-GRD-090): everything the run showed, in order,
// with the time it happened. Routing, the plan and each step with its operation and result, every
// answer block with the operations and sources behind it, and the follow-ups offered. Taken from what
// the run streamed, so every agent is traced the same way and nothing is reconstructed afterwards.
import type { Block } from '@dinext/block-schemas';
import type { RunSink } from './sink.ts';

export type TraceEntry =
  | { t: number; kind: 'routing'; agent: string; reason?: string }
  | { t: number; kind: 'plan'; agent: string; title: string; steps: string[] }
  | { t: number; kind: 'step'; agent?: string; label?: string; state: string; operation?: string; result?: string }
  | { t: number; kind: 'text'; agent: string; chars: number; excerpt: string; sources: string[] }
  | { t: number; kind: 'block'; agent: string; type: string; title?: string; operations: string[]; sources: string[]; rows?: number }
  | { t: number; kind: 'suggestion'; text: string };

/** Enough for any run; a runaway one is cut off rather than filling the audit store. */
const MAX_ENTRIES = 300;
const cut = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plain = (md: string) => md.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
const sourceLabels = (sources: Block['provenance']['sources'] | undefined) => (sources ?? []).map((s) => cut(s.label, 80)!).slice(0, 10);

export interface RunTrace {
  startedAt: string;
  entries: TraceEntry[];
  /** True when the run went past the limit and later entries were dropped. */
  truncated: boolean;
}

export const newTrace = (): RunTrace => ({ startedAt: new Date().toISOString(), entries: [], truncated: false });

/** Wraps a sink so everything the run shows is written to `trace` as well. */
export function traceSink(sink: RunSink, trace: RunTrace): RunSink {
  const t0 = Date.parse(trace.startedAt);
  const labels = new Map<string, string>();
  const add = (e: TraceEntry) => {
    if (trace.entries.length < MAX_ENTRIES) trace.entries.push(e);
    else trace.truncated = true;
  };
  const now = () => Date.now() - t0;
  const out = Object.create(sink) as RunSink;
  out.routing = (agent, reason) => {
    add({ t: now(), kind: 'routing', agent, reason: cut(reason, 160) });
    sink.routing(agent, reason);
  };
  out.plan = (title, agent, steps, opts) => {
    for (const s of steps) if (s.label) labels.set(s.id, s.label);
    add({ t: now(), kind: 'plan', agent, title: cut(title, 160)!, steps: steps.map((s) => cut(s.label ?? s.id, 120)!).slice(0, 30) });
    return sink.plan(title, agent, steps, opts);
  };
  out.step = (planBlockId, update) => {
    if (update.label) labels.set(update.id, update.label);
    // A step only enters the trace when something happens to it, not while it waits its turn.
    if (update.state !== 'waiting') add({ t: now(), kind: 'step', agent: update.agent, label: cut(update.label ?? labels.get(update.id) ?? update.id, 120), state: update.state, operation: update.operation, result: cut(update.resultSummary, 240) });
    sink.step(planBlockId, update);
  };
  out.text = (markdown, agent, sources) => {
    const p = plain(markdown);
    add({ t: now(), kind: 'text', agent, chars: p.length, excerpt: cut(p, 280)!, sources: sourceLabels(sources) });
    return sink.text(markdown, agent, sources);
  };
  out.block = (b) => {
    if (b.type !== 'plan_steps') {
      const data = b.data as { rows?: unknown[]; items?: unknown[] };
      const rows = Array.isArray(data?.rows) ? data.rows.length : Array.isArray(data?.items) ? data.items.length : undefined;
      add({ t: now(), kind: 'block', agent: b.provenance.agent, type: b.type, title: cut(b.output?.label ?? b.title, 160), operations: (b.provenance.operations ?? []).slice(0, 10), sources: sourceLabels(b.provenance.sources), rows });
    }
    return sink.block(b);
  };
  out.suggestion = (text) => {
    add({ t: now(), kind: 'suggestion', text: cut(text, 160)! });
    sink.suggestion(text);
  };
  return out;
}

/** The agent that answered: the last one the run was routed to, other than the Concierge itself. */
export const answeredBy = (trace: RunTrace) => trace.entries.findLast((e): e is Extract<TraceEntry, { kind: 'routing' }> => e.kind === 'routing' && e.agent !== 'DI Concierge')?.agent;
