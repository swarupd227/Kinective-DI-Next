// Interest rate risk: reading the shock from a question, and the model's behaviour on the warehouse.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IRR_LIMITS_BANK, IrrService, PerShareService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { irrModule, shockFrom } from '../src/irr.ts';

describe('the rate shock in a question', () => {
  it('reads basis points, percent and direction words, to the nearest modelled shock', () => {
    expect(shockFrom('What happens to NII if rates rise 200 bp?')).toBe(200);
    expect(shockFrom('NEV at plus 300 basis points')).toBe(300);
    expect(shockFrom('What if rates fall 1%?')).toBe(-100);
    expect(shockFrom('minus 240 bps')).toBe(-200);
    expect(shockFrom('rates drop 2 percent')).toBe(-200);
    expect(shockFrom('What is our interest rate risk?')).toBeNull();
  });

  it('routes the ALCO’s questions to the right tool', () => {
    const spec = irrModule({} as IrrService);
    const plan = (t: string) => spec.plan!(t, {} as never);
    expect(plan('What happens to NII if rates rise 200 bp?')).toEqual({ tool: 'irr_scenario', args: { shock_bp: 200 } });
    expect(plan('Show the repricing gap')).toEqual({ tool: 'irr_gap', args: {} });
    expect(plan('What drives our interest rate risk at plus 300 basis points?')).toEqual({ tool: 'irr_drivers', args: { shock_bp: 300 } });
    expect(plan('What assumptions does the model use?')).toEqual({ tool: 'irr_assumptions', args: {} });
    expect(plan('Are we within our rate risk limits?')).toEqual({ tool: 'irr_summary', args: {} });
  });

  it('hears a bank CFO’s Fed questions, at once or gradually', () => {
    const spec = irrModule({} as IrrService);
    const plan = (t: string) => spec.plan!(t, {} as never);
    for (const q of ['What happens to our value if the Fed hikes 200 bps?', 'Interest Rate Risk (IRR) / EVE & NII Sensitivity: What happens to your value if Fed hikes 200bps? This is your ALCO report.', 'What if the Fed raises rates 200 bp gradually over a year?', 'What if the Fed cuts 100 bp?', 'Are we within our rate risk limits?', 'Show our EVE sensitivity']) expect(spec.request.test(q), q).toBe(true);
    expect(plan('What happens to our value if the Fed hikes 200 bps?')).toEqual({ tool: 'irr_scenario', args: { shock_bp: 200 } });
    expect(plan('What if the Fed raises rates 200 bp gradually over a year?')).toEqual({ tool: 'irr_scenario', args: { shock_bp: 200, ramp: true } });
    expect(plan('What if the Fed cuts 100 bp?')).toEqual({ tool: 'irr_scenario', args: { shock_bp: -100 } });
    expect(plan('What does a gradual rate rise do to NII?')).toEqual({ tool: 'irr_scenario', args: { shock_bp: 200, ramp: true } });
    // Book value and bond losses stay with their own agents.
    expect(spec.request.test('What are our unrealized losses on securities?')).toBe(false);
  });
});

describe.skipIf(!(await warehouseAvailable('dinext_t_test_bank')))('a bank’s EVE and NII sensitivity', () => {
  it('says EVE, holds each shock to its own limit, ramps over a year and ties a rise to tangible book value', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const svc = new IrrService(pool);
      const a = await svc.analysis();
      expect(a.bank).toBe(true);
      expect(a.ev).toBe('EVE');
      for (const s of a.scenarios.filter((x) => x.shockBp)) {
        expect(s.nevLimitPct).toBe(IRR_LIMITS_BANK.eveDeclinePct[Math.abs(s.shockBp)]);
        expect(s.niiLimitPct).toBe(IRR_LIMITS_BANK.niiDeclinePct[Math.abs(s.shockBp)]);
        const used = Math.max(-s.niiPct / s.niiLimitPct, -s.nevPct / s.nevLimitPct);
        expect(s.status).toBe(used > 1 ? 'Breach' : used >= 0.85 ? 'Watch' : 'Within');
      }
      expect(a.scenarios.find((x) => x.shockBp === 400)!.status).toBe('Breach');
      // A gradual rise hurts the first year less than an immediate one; by the second year rates are the same either way.
      const at = (s: number, ramp: boolean) => a.ramps.find((r) => r.shockBp === s && r.ramp === ramp)!;
      expect(at(200, true).year1Pct).toBeLessThan(0);
      expect(at(200, true).year1Pct).toBeGreaterThan(at(200, false).year1Pct);
      expect(at(200, true).year2Pct).toBeCloseTo(at(200, false).year2Pct, 6);
      // The instant first year matches the 12-month shock.
      expect(at(200, false).year1Pct).toBeCloseTo(a.scenarios.find((x) => x.shockBp === 200)!.niiPct, 0);
      expect(a.driversByShock[-100]!.find((d) => d.name === 'First mortgages')!.nevChange).toBeGreaterThan(0);

      const spec = irrModule(svc, undefined, new PerShareService(pool));
      const ctx = { user: { id: 'u', name: 'Elena Ortiz' }, modules: ['irr'], runId: 'r', threadId: 't' };
      const tool = (n: string) => spec.tools.find((t) => t.name === n)!;
      const r = (await tool('irr_scenario').run({ shock_bp: 200 } as never, ctx)) as { text: string; blocks: { title: string }[] };
      expect(r.text).toMatch(/^If the Fed raised rates 200 bp at once, the bank’s economic value of equity \(EVE\) falls \*\*\$\d+\.\dM \(−\d+\.\d%\)\*\*/);
      expect(r.text).toMatch(/against the board’s limit of −20% at ±200 bp/);
      expect(r.text).toMatch(/gradually over a year/);
      expect(r.text).toMatch(/\*\*\$\d\.\d\d a share\*\* off tangible book value/);
      expect(r.text).not.toMatch(/\bNEV\b/);
      expect(r.blocks.map((b) => b.title)).toEqual(['If rates rise 200 bp', 'What drives the change in EVE at +200 bp']);
      const sum = (await tool('irr_summary').run({} as never, ctx)) as { text: string; blocks: unknown[] };
      expect(sum.text).toMatch(/economic value of equity \(EVE\)/);
      expect(sum.text).not.toMatch(/NEV ratio/);
      expect(sum.blocks).toHaveLength(2);
    } finally {
      await pool.end();
    }
  });
});

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

describe.skipIf(!up)('interest rate risk on the warehouse', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = tenantPool(SCHEMA);
  });
  afterAll(async () => pool.end());

  it('loses NEV as rates rise, on a mortgage-heavy book, and reads the 5300 for investments', async () => {
    const a = await new IrrService(pool).analysis();
    expect(a.fromCallReport).toBe(true);
    const at = (s: number) => a.scenarios.find((x) => x.shockBp === s)!;
    // Fixed-rate mortgages and investments lose value as rates rise; NEV falls with each step up.
    expect(at(100).nevChange).toBeLessThan(0);
    expect(at(300).nevChange).toBeLessThan(at(100).nevChange);
    const mortgages = a.drivers.find((d) => d.name === 'First mortgages')!;
    expect(mortgages.nevChange).toBeLessThan(0);
    // Low-rate savings are worth more to the credit union when rates rise.
    expect(a.drivers.find((d) => d.name === 'Savings')!.nevChange).toBeGreaterThan(0);
    // The base is the base; the gap's bands add up to every position's balance.
    expect(a.base.niiChange).toBe(0);
    const assets = a.drivers.filter((d) => d.side === 'asset').reduce((s, d) => s + d.balance, 0);
    expect(a.gap.reduce((s, g) => s + g.assets, 0)).toBeCloseTo(assets, -3);
    expect(a.assumptions.map(([k]) => k)).toContain('Model of record');
  });
});
