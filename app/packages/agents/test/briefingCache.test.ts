// @vitest-environment node
// Home's briefing is kept for a while instead of querying the warehouse on every visit; "Brief me" in a
// conversation is always fresh, and a failed briefing is never kept.
import { describe, expect, it } from 'vitest';
import { buildBriefing } from '../src/index.ts';

const stub = () => {
  const svc = { calls: 0, model: { metrics: {} }, query: async () => { svc.calls++; throw new Error('warehouse down'); } };
  return svc;
};

describe('Home briefing cache', () => {
  it('shares one briefing between Home visits, and computes "Brief me" fresh', async () => {
    const svc = stub();
    const a = buildBriefing(svc as never, { canViewSql: false });
    const b = buildBriefing(svc as never, { canViewSql: false });
    expect(b).toBe(a);
    await expect(a).rejects.toThrow('warehouse down');
    const calls = svc.calls;
    await expect(buildBriefing(svc as never, { canViewSql: false }, 'run_1')).rejects.toThrow();
    expect(svc.calls).toBeGreaterThan(calls);
  });

  it('keeps each purview apart and drops a failed briefing', async () => {
    const svc = stub();
    const a = buildBriefing(svc as never, { purviewBranches: ['Harbor'], canViewSql: false });
    expect(buildBriefing(svc as never, { purviewBranches: ['Midtown'], canViewSql: false })).not.toBe(a);
    await expect(a).rejects.toThrow();
    await Promise.resolve();
    expect(buildBriefing(svc as never, { purviewBranches: ['Harbor'], canViewSql: false })).not.toBe(a);
  });
});
