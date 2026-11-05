// Interest rate risk: reading the shock from a question, and the model's behaviour on the warehouse.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IrrService } from '@dinext/di-core';
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
