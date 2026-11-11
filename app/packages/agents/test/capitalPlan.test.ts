// @vitest-environment node
// Capital plan: capacity to return capital against the board's floors (internal target, or minimum plus
// the stress decline), what dividends take, buybacks per share, and the CFO's targets by approval.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { CapitalPlanService, type PerShareService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { CAPITAL_PLAN_REQUEST, amountFrom, capitalPlanAnalyses, capitalPlanModule, capitalPlanQuestion, parseCapitalPlan, shareModule } from '../src/index.ts';

describe('capital plan questions', () => {
  const spec = capitalPlanModule({} as CapitalPlanService);
  const plan = (t: string) => spec.plan(t, {} as never);
  it('route to the right tool', () => {
    const cases: [string, string][] = [
      ['Capital Plan / Dividend & Buyback Capacity: can we return capital to shareholders without dropping below our internal CET1 target and stress buffer?', 'overview'],
      ['How much can we return to shareholders this year?', 'capacity'],
      ['How much can we pay in dividends without approval?', 'dividends'],
      ['What sets our capital floor?', 'stress'],
    ];
    for (const [q, question] of cases) {
      expect(CAPITAL_PLAN_REQUEST.test(q), q).toBe(true);
      expect(plan(q), q).toEqual({ tool: 'cap_view', args: { question } });
    }
    expect(plan('What would a $10M buyback do?')).toEqual({ tool: 'cap_buyback', args: { amount: 10_000_000 } });
    expect(plan('Set our CET1 target to 10.5%')).toEqual({ tool: 'cap_set', args: { cet1_target: 10.5 } });
    expect(plan('Plan a $5M buyback')).toEqual({ tool: 'cap_set', args: { buyback_planned: 5_000_000 } });
    expect(parseCapitalPlan('Raise the dividend to $0.25 a quarter')).toEqual({ dividend_per_share_q: 0.25 });
    expect(amountFrom('buy back $7,500,000 of stock')).toBe(7_500_000);
    expect(amountFrom('a 2.5 million buyback')).toBe(2_500_000);
    // Dividends per share and the payout ratio stay with Shareholder Value.
    expect(shareModule({} as PerShareService).request.test('What’s our dividend payout ratio?')).toBe(true);
    expect(capitalPlanQuestion('What’s our dividend payout ratio?')).toBe('dividends');
  });
});

const up = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM fin_capital_plan LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('a bank’s capital plan', () => {
  it('holds the binding ratio at its floor, sizes buybacks and keeps the plan the CFO’s', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const svc = new CapitalPlanService(pool);
      const a = (await svc.analysis())!;
      // Each floor is the higher of the target and the minimum plus the stress decline.
      expect(a.floors.leverage).toBeCloseTo(Math.max(a.settings.leverageTarget, 8 + a.stress.levStress), 9);
      expect(a.floors.cet1).toBeCloseTo(Math.max(a.settings.cet1Target, 4.5 + Math.max(2.5, a.stress.cet1Stress)), 9);
      // The bank is in the CBLR, and paying out exactly the capacity leaves the binding ratio at its floor.
      expect(a.cblr).toBe(true);
      expect(a.capacity.binding).toBe('leverage');
      expect(a.atCapacity.levPct).toBeCloseTo(a.floors.leverage, 6);
      expect(a.atCapacity.levStressed).toBeCloseTo(8, 6);
      expect(a.capacity.buybackRoom).toBeCloseTo(a.capacity.total - a.capacity.dividends, 2);
      // Buying above tangible book lifts EPS and dilutes tangible book value a share.
      const b = a.buyback(10_000_000)!;
      expect(b.epsAfter).toBeGreaterThan(b.epsBefore);
      expect(b.tbvAfter).toBeLessThan(b.tbvBefore);
      expect(b.levOk).toBe(true);
      expect(a.buyback(a.capacity.buybackRoom + 5_000_000)!.levOk).toBe(false);

      const spec = capitalPlanModule(svc);
      const ctx = { user: { id: 'u', name: 'Elena Ortiz' }, modules: ['capplan'], runId: 'r', threadId: 't' };
      const tool = (n: string) => spec.tools.find((t) => t.name === n)!;
      const o = (await tool('cap_view').run({} as never, ctx)) as { text: string; blocks: unknown[] };
      expect(o.text).toMatch(/^Over the next four quarters the bank can return about \*\*\$\d+\.\dM\*\* without its leverage ratio falling below \*\*\d+\.\d\d%\*\*/);
      const x = (await tool('cap_buyback').run({ amount: 10_000_000 } as never, ctx)) as { text: string };
      expect(x.text).toMatch(/\*\*within the floors\*\*/);
      const set = (await tool('cap_set').run({ cet1_target: 10.5 } as never, ctx)) as { change: { apply: unknown } };
      expect(set.change.apply).toEqual({ cet1Target: 10.5 });
      expect((await svc.settings()).cet1Target).toBe(10);
      await expect(tool('cap_view').run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/isn’t part of your DI access/);
      const an = capitalPlanAnalyses(svc);
      for (const key of an.keys) {
        const { block, take } = await an.run(key, 'R-cap');
        expect(blockSchema.safeParse(block).success, key).toBe(true);
        if (take) expect(take.headline.length, key).toBeLessThanOrEqual(300);
        // Every buyback size the report shows, including the room after dividends, is within the floor.
        if (key === 'cap.buyback') expect((block as unknown as { data: { rows: { ok: string }[] } }).data.rows.map((r) => r.ok).every((ok) => ok === 'Yes'), key).toBe(true);
      }
    } finally {
      await pool.end();
    }
  });
});
