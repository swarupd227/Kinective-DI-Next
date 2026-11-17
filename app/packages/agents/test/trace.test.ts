// A run's trace for the Agent Audit Log: everything the run showed, in order, with its timing.
import { describe, expect, it } from 'vitest';
import type { Block } from '@dinext/block-schemas';
import type { GovernanceService } from '@dinext/di-core';
import { governanceModule } from '../src/governance.ts';
import { answeredBy, newTrace, traceSink } from '../src/trace.ts';
import type { RunSink } from '../src/sink.ts';

const quiet: RunSink = {
  signal: new AbortController().signal,
  routing: () => {},
  plan: () => 'plan_1',
  step: () => {},
  text: async () => {},
  block: async () => {},
  suggestion: () => {},
};

describe('run trace', () => {
  it('records routing, the plan, each step that moves, what was shown and the follow-ups, in order', async () => {
    const trace = newTrace();
    const seen: string[] = [];
    const sink = traceSink({ ...quiet, routing: (a) => void seen.push(a) }, trace);
    sink.routing('DI Concierge', 'Reading the request');
    sink.routing('Referrals', 'A referral to send');
    const plan = sink.plan('Refer Suzanne for a HELOC', 'Referrals', [
      { id: 's1', label: 'Find the member', state: 'waiting' },
      { id: 's2', label: 'Prepare the referral', state: 'waiting' },
    ]);
    sink.step(plan, { id: 's1', state: 'running', operation: 'member.search' });
    sink.step(plan, { id: 's1', state: 'done', resultSummary: '1 match in Westport' });
    sink.step(plan, { id: 's2', state: 'waiting' });
    await sink.text('**Suzanne Jackson** is ready to refer.', 'Referrals', [{ kind: 'table', label: 'Members', ref: 'table:cdm_party' }]);
    await sink.block({ id: 'b1', type: 'table', version: '1.0.0', title: 'Matches', provenance: { agent: 'Referrals', operations: ['member.search'], sources: [{ kind: 'table', label: 'Members', ref: 'table:cdm_party' }] }, data: { columns: [], rows: [{}, {}] } } as unknown as Block);
    sink.suggestion('Send it to Westport');

    // The real sink still gets everything.
    expect(seen).toEqual(['DI Concierge', 'Referrals']);
    expect(trace.entries.map((e) => e.kind)).toEqual(['routing', 'routing', 'plan', 'step', 'step', 'text', 'block', 'suggestion']);
    expect(trace.entries[3]).toMatchObject({ kind: 'step', label: 'Find the member', state: 'running', operation: 'member.search' });
    expect(trace.entries[4]).toMatchObject({ kind: 'step', label: 'Find the member', state: 'done', result: '1 match in Westport' });
    expect(trace.entries[5]).toMatchObject({ kind: 'text', agent: 'Referrals', excerpt: 'Suzanne Jackson is ready to refer.', sources: ['Members'] });
    expect(trace.entries[6]).toMatchObject({ kind: 'block', type: 'table', title: 'Matches', rows: 2, operations: ['member.search'] });
    expect(trace.entries.every((e, i, all) => e.t >= 0 && (i === 0 || e.t >= all[i - 1]!.t))).toBe(true);
    expect(answeredBy(trace)).toBe('Referrals');
  });

  it('stops at its limit instead of growing without end', () => {
    const trace = newTrace();
    const sink = traceSink(quiet, trace);
    for (let i = 0; i < 400; i++) sink.suggestion(`Follow-up ${i}`);
    expect(trace.entries).toHaveLength(300);
    expect(trace.truncated).toBe(true);
  });
});

describe('the audit log through DI', () => {
  const spec = governanceModule({} as GovernanceService, () => 2026);
  it('sends audit log questions to the audit log, with the period and outcome asked for', () => {
    expect(spec.plan!('Which agent runs failed this week, and why?', {} as never)).toEqual({ tool: 'gov_audit_log', args: { period: 'week', outcome: 'failed' } });
    expect(spec.plan!('Show the audit log for today', {} as never)).toEqual({ tool: 'gov_audit_log', args: { period: 'today' } });
    expect(spec.plan!('Show the runs that were refused this month', {} as never)).toEqual({ tool: 'gov_audit_log', args: { period: 'month', outcome: 'no_access' } });
    expect(spec.plan!('Open the trace for run R-20261117-a7a7', {} as never)).toEqual({ tool: 'gov_trace', args: { run_id: 'R-20261117-a7a7' } });
    expect(spec.request.test('Show the audit log')).toBe(true);
  });
});
