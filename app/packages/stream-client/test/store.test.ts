import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dinext/block-schemas';
import { createStreamStore, GAP_TIMEOUT_MS } from '../src/index.ts';

const T = 'thr_test';
const ts = '2026-10-26T14:03:00Z';
let seq = 0;
const ev = <E extends Omit<StreamEvent, 'threadId' | 'seq' | 'ts'>>(e: E, s = ++seq) => ({ threadId: T, ts, seq: s, ...e }) as unknown as StreamEvent;

const textStart = (id: string, runId = 'R1') =>
  ({
    type: 'block.start',
    runId,
    block: { id, type: 'text', version: '1.0.0', provenance: { agent: 'Analytics Q&A', runId, sources: [] }, freshness: { kind: 'none' }, data: {} },
  }) as const;

function setup(now = { t: 0 }) {
  seq = 0;
  const onGap = vi.fn();
  const onBlockFailed = vi.fn();
  const s = createStreamStore({ onGap, onBlockFailed, now: () => now.t });
  const thread = () => s.store.getState().threads[T]!;
  return { s, thread, onGap, onBlockFailed, now };
}

describe('stream store ordering (FE-ARCH-030)', () => {
  it('builds a turn from in-order events and concatenates token deltas', () => {
    const { s, thread } = setup();
    s.applyMany([
      ev({ type: 'message.accepted', clientMessageId: 'cm1', text: 'Show loan growth' }),
      ev({ type: 'run.started', runId: 'R1', agents: ['DI Concierge'] }),
      ev({ type: 'routing', runId: 'R1', agent: 'Analytics Q&A' }),
      ev(textStart('blk_text000000001')),
      ev({ type: 'token.delta', blockId: 'blk_text000000001', text: 'Loans grew ' }),
      ev({ type: 'token.delta', blockId: 'blk_text000000001', text: '2.4%.' }),
      ev({ type: 'block.end', blockId: 'blk_text000000001' }),
      ev({ type: 'run.completed', runId: 'R1' }),
    ]);
    const t = thread();
    expect(t.lastSeq).toBe(8);
    expect(t.turns.map((x) => x.kind)).toEqual(['user', 'agent']);
    const agent = t.turns[1]!;
    expect(agent.kind === 'agent' && agent.agents).toEqual(['DI Concierge', 'Analytics Q&A']);
    expect(agent.kind === 'agent' && agent.state).toBe('completed');
    expect(t.blocks.blk_text000000001).toMatchObject({ status: 'complete', envelope: { data: { markdown: 'Loans grew 2.4%.' } } });
  });

  it('buffers out-of-order events and applies them when the gap fills', () => {
    const { s, thread } = setup();
    const e1 = ev({ type: 'run.started', runId: 'R1', agents: ['DI Concierge'] }, 1);
    const e2 = ev(textStart('blk_text000000001'), 2);
    const e3 = ev({ type: 'token.delta', blockId: 'blk_text000000001', text: 'A' }, 3);
    s.applyMany([e1, e3]);
    expect(thread().lastSeq).toBe(1);
    s.applyMany([e2]);
    expect(thread().lastSeq).toBe(3);
    expect(thread().blocks.blk_text000000001?.envelope.data.markdown).toBe('A');
  });

  it('drops duplicates and replayed events', () => {
    const { s, thread } = setup();
    const e1 = ev({ type: 'run.started', runId: 'R1', agents: [] }, 1);
    const e2 = ev(textStart('blk_text000000001'), 2);
    const e3 = ev({ type: 'token.delta', blockId: 'blk_text000000001', text: 'A' }, 3);
    s.applyMany([e1, e2, e3, e3, e2]);
    expect(thread().blocks.blk_text000000001?.envelope.data.markdown).toBe('A');
  });

  it('requests a replay when a gap persists for 2 seconds, and only once per window', () => {
    const { s, onGap, now } = setup();
    s.applyMany([ev({ type: 'run.started', runId: 'R1', agents: [] }, 1), ev({ type: 'suggestion', text: 'x' }, 3)]);
    s.checkGaps();
    expect(onGap).not.toHaveBeenCalled();
    now.t = GAP_TIMEOUT_MS;
    s.checkGaps();
    s.checkGaps();
    expect(onGap).toHaveBeenCalledTimes(1);
    expect(onGap).toHaveBeenCalledWith(T, 1);
  });

  it('marks a block failed and reports it when a patch cannot apply (FE-GEN-040)', () => {
    const { s, thread, onBlockFailed } = setup();
    s.applyMany([
      ev({ type: 'run.started', runId: 'R1', agents: [] }),
      ev(textStart('blk_text000000001')),
      ev({ type: 'block.patch', blockId: 'blk_text000000001', ops: [{ op: 'replace', path: '/missing/deep', value: 1 }] }),
      ev({ type: 'block.end', blockId: 'blk_text000000001' }),
    ]);
    expect(thread().blocks.blk_text000000001).toMatchObject({ status: 'error', failedPatch: true });
    expect(onBlockFailed).toHaveBeenCalledWith(T, 'blk_text000000001');
  });

  it('updates plan steps from tool.progress with timing', () => {
    const { s, thread } = setup();
    s.applyMany([
      ev({ type: 'run.started', runId: 'R1', agents: [] }),
      ev({
        type: 'block.start',
        runId: 'R1',
        block: {
          id: 'blk_plan000000001',
          type: 'plan_steps',
          version: '1.0.0',
          provenance: { agent: 'X', runId: 'R1', sources: [] },
          freshness: { kind: 'none' },
          data: { runId: 'R1', cancellable: true, steps: [{ id: 's1', label: 'Read', agent: 'A', state: 'waiting' }] },
        },
      }),
      ev({ type: 'tool.progress', runId: 'R1', blockId: 'blk_plan000000001', step: { id: 's1', state: 'running' } }),
      ev({ type: 'tool.progress', runId: 'R1', blockId: 'blk_plan000000001', step: { id: 's1', state: 'done', resultSummary: 'Found 3' } }),
      ev({ type: 'run.cancelled', runId: 'R1', completedSteps: ['s1'] }),
    ]);
    const data = thread().blocks.blk_plan000000001!.envelope.data as { steps: Record<string, unknown>[]; state: string };
    expect(data.steps[0]).toMatchObject({ state: 'done', resultSummary: 'Found 3', startedAt: ts, endedAt: ts });
    expect(data.state).toBe('cancelled');
  });

  it('turns run.failed into a no-access notice in the turn', () => {
    const { s, thread } = setup();
    s.applyMany([
      ev({ type: 'run.started', runId: 'R1', agents: ['Analytics Q&A'] }),
      ev({ type: 'run.failed', runId: 'R1', error: { code: 'PERMISSION_DENIED', userMessage: 'No access to Northgate.', permission: 'Purview: Northgate' } }),
    ]);
    const turn = thread().turns[0]!;
    const id = turn.kind === 'agent' ? turn.blockIds[0]! : '';
    expect(thread().blocks[id]?.envelope).toMatchObject({ type: 'notice', data: { kind: 'no_access', permission: 'Purview: Northgate' } });
  });

  it('records approval resolution on the card and clears the pending list', () => {
    const { s, thread } = setup();
    s.applyMany([
      ev({ type: 'run.started', runId: 'R1', agents: [] }),
      ev(textStart('blk_appr000000001')),
      ev({ type: 'approval.requested', approvalId: 'apr_x', blockId: 'blk_appr000000001', riskTier: 'medium', expiresAt: ts }),
    ]);
    expect(thread().pendingApprovals).toEqual(['blk_appr000000001']);
    s.applyMany([ev({ type: 'approval.resolved', approvalId: 'apr_x', blockId: 'blk_appr000000001', decision: 'approved', by: 'Dana Lee', channel: 'click' })]);
    expect(thread().pendingApprovals).toEqual([]);
    expect(thread().blocks.blk_appr000000001?.envelope.data.resolution).toMatchObject({ decision: 'approved', by: 'Dana Lee' });
  });

  it('counts unknown event types and keeps going', () => {
    const { s, thread } = setup();
    s.applyMany([ev({ type: 'hologram.start' } as never), ev({ type: 'run.started', runId: 'R1', agents: [] })]);
    expect(s.store.getState().unknownEvents).toBe(1);
    expect(thread().lastSeq).toBe(2);
  });
});
