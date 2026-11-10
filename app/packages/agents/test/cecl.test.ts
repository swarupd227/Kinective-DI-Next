// @vitest-environment node
// CECL: the booked provision and allowance from the Call Report, DI's own estimate from the loan book, what
// a forecast change would cost, and the CFO's scenario weights and Q-factors.
import { describe, expect, it } from 'vitest';
import { CeclService, type DelinquencyService, type ProfitabilityService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { CECL_REQUEST, ceclModule, ceclQuestion, delinquencyModule, parseCecl, profitabilityModule } from '../src/index.ts';

describe('CECL questions', () => {
  const spec = ceclModule({} as CeclService);
  const plan = (t: string) => spec.plan(t, {} as never);
  it('route to the right answer', () => {
    const cases: [string, string][] = [
      ['Provision for Credit Losses (CECL): your forward-looking estimate of future loan losses. CFO owns this model.', 'overview'],
      ['How does our CECL look?', 'overview'],
      ['What drove our provision this quarter?', 'provision'],
      ['Why did the provision go up?', 'provision'],
      ['What’s our provision for credit losses?', 'provision'],
      ['Is our allowance enough?', 'estimate'],
      ['Is the reserve adequate under CECL?', 'estimate'],
      ['What would a recession do to our CECL allowance?', 'forecast'],
      ['What would an adverse scenario do to our allowance?', 'forecast'],
      ['What are our CECL Q-factors and scenario weights?', 'assumptions'],
      ['How does DI estimate CECL?', 'method'],
    ];
    for (const [q, question] of cases) {
      expect(CECL_REQUEST.test(q), q).toBe(true);
      expect(plan(q), q).toEqual({ tool: 'cecl_view', args: { question } });
      expect(ceclQuestion(q), q).toBe(question);
    }
    // The allowance by segment, coverage of problem loans, charts, the stress test and pre-provision earnings stay where they were.
    for (const q of ['Show the allowance by segment', 'Where is the allowance?', 'Which CECL pools are largest?', 'What’s our allowance coverage?', 'What is our net charge-off rate?', 'Chart our provision over five quarters', 'Run the stress test', 'What are our pre-provision earnings?']) expect(CECL_REQUEST.test(q), q).toBe(false);
    expect(profitabilityModule({} as ProfitabilityService).request.test('Show the allowance by segment')).toBe(true);
    expect(delinquencyModule({} as DelinquencyService).request.test('What’s our allowance coverage?')).toBe(true);
  });

  it('read scenario weights and Q-factors from what the CFO says', () => {
    expect(parseCecl('Set scenario weights to 70% baseline, 25% adverse, 5% severe')).toEqual({ baseline: 70, adverse: 25, severe: 5 });
    expect(parseCecl('Set the CRE Q-factor to 10 bp')).toEqual({ loanType: 'Commercial Real Estate', bp: 10 });
    expect(parseCecl('Raise the consumer qualitative factor to 40 basis points')).toEqual({ loanType: 'Consumer', bp: 40 });
    expect(parseCecl('Is our allowance enough?')).toBeNull();
    expect(plan('Set scenario weights to 70% baseline, 25% adverse, 5% severe')).toEqual({ tool: 'cecl_set', args: { baseline: 70, adverse: 25, severe: 5 } });
  });

  it('weights the forecast and accrues losses on a paying-down balance', () => {
    // The baseline scenario is about the long-run rate; adverse and severe raise it.
    const base = CeclService.forecastRate('Commercial Real Estate', { baseline: 100, adverse: 0, severe: 0 });
    const adverse = CeclService.forecastRate('Commercial Real Estate', { baseline: 0, adverse: 100, severe: 0 });
    expect(adverse).toBeGreaterThan(base * 4);
    expect(CeclService.forecastRate('Commercial Real Estate', { baseline: 50, adverse: 50, severe: 0 })).toBeCloseTo((base + adverse) / 2, 10);
    // At a flat 1% a year over 4 years, paying down straight line: 1 + 0.75 + 0.5 + 0.25 = 2.5% of today's balance.
    expect(CeclService.lifetime(1, 1, 4)).toBeCloseTo(0.025, 10);
  });
});

const up = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM fin_cecl LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('a bank’s CECL provision and allowance', () => {
  it('ties to the Call Report, walks the provision and sets DI’s estimate against the booked allowance', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const svc = new CeclService(pool);
      const f = (await svc.analysis())!;
      const [codes] = (await pool.query("SELECT code, amount FROM cr_value WHERE quarter_end = (SELECT MAX(quarter_end) FROM cr_value) AND code IN ('RCON3123', 'RIADJJ33', 'RCON2122')")) as unknown as [{ code: string; amount: number }[]];
      const g = (c: string) => Number(codes.find((x) => x.code === c)!.amount);
      expect(f.now.allowance).toBeCloseTo(g('RCON3123'), 0);
      expect(f.now.provisionYtd).toBeCloseTo(g('RIADJJ33'), 0);
      // The walk adds up: start, less net charge-offs, plus the provision, is the end; the provision's parts explain all of it.
      for (const w of [f.quarterWalk!, f.ytdWalk]) {
        expect(w.start - w.netChargeOffs + w.provision).toBeCloseTo(w.end, 0);
        expect(Math.abs(w.other)).toBeLessThan(1);
      }
      // The estimate is its loan types', and the CFO's Q-factors are on top.
      const e = f.estimate;
      expect(e.total).toBeCloseTo(e.pools.reduce((s, p) => s + p.estimate, 0), 0);
      expect(e.qualitative).toBeGreaterThan(0);
      expect(f.settings.weights).toEqual({ baseline: 75, adverse: 20, severe: 5 });
      expect(f.bookedPct!).toBeCloseTo((f.now.allowance / e.total) * 100, 6);
      expect(f.read).toBe('light');
      // A worse forecast needs a bigger allowance, and the provision takes capital down.
      const [cur, base, adverse, severe] = f.scenarios;
      expect(base!.estimate).toBeLessThan(cur!.estimate);
      expect(adverse!.estimate).toBeGreaterThan(cur!.estimate);
      expect(severe!.estimate).toBeGreaterThan(adverse!.estimate);
      expect(severe!.leveragePct!).toBeLessThan(f.leveragePct!);
      expect(adverse!.eps!).toBeCloseTo(adverse!.afterTax / Number(((await pool.query('SELECT weighted_shares FROM fin_share ORDER BY quarter_end DESC LIMIT 1')) as unknown as [{ weighted_shares: number }[]])[0][0]!.weighted_shares), 6);

      const spec = ceclModule(svc);
      const ctx = { user: { id: 'u', name: 'Elena Ortiz' }, modules: ['cecl'], runId: 'r', threadId: 't' };
      const view = (await spec.tools[0]!.run({ question: 'overview' } as never, ctx)) as { text: string; blocks: unknown[] };
      expect(view.text).toMatch(/^The provision for credit losses was \*\*\$\d+\.\d\dM\*\* in Q3 2026/);
      expect(view.text).toMatch(/so the booked allowance is \d+\.\d% of it: light by/);
      expect(view.blocks).toHaveLength(4);
      // A change previews the new estimate and saves only on approval.
      const change = (await spec.tools[1]!.run({ baseline: 70, adverse: 25 } as never, ctx)) as { change: { apply: { weights: unknown }; text: string } };
      expect(change.change.apply.weights).toEqual({ baseline: 70, adverse: 25, severe: 5 });
      expect(change.change.text).toMatch(/would move from \$10\.\d\dM to/);
      const bad = (await spec.tools[1]!.run({ baseline: 90, adverse: 20, severe: 5 } as never, ctx)) as { text: string };
      expect(bad.text).toMatch(/need to add to 100%/);
      expect((await svc.settings()).weights.baseline).toBe(75);
      await expect(spec.tools[0]!.run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/isn’t part of your DI access/);
    } finally {
      await pool.end();
    }
  });
});
