// @vitest-environment node
// Shareholder Value: EPS and tangible book value per share from the Call Report and the share register.
import { describe, expect, it } from 'vitest';
import { IrrService, LiquidityService, PerShareService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { irrModule, liquidityModule, parseShares, shareModule } from '../src/index.ts';

describe('shareholder value questions', () => {
  const spec = shareModule({} as PerShareService);
  const plan = (t: string) => spec.plan(t, {} as never);
  it('route to the right answer', () => {
    const cases: [string, string][] = [
      ['EPS + Tangible Book Value Per Share (TBV): what analysts value you on. If TBV is falling, stock falls.', 'overview'],
      ['What’s our tangible book value per share?', 'tbv'],
      ['Is our TBV falling?', 'why'],
      ['What moved our tangible book value per share?', 'why'],
      ['What’s our EPS?', 'eps'],
      ['What are our earnings per share this quarter?', 'eps'],
      ['What’s our price to tangible book?', 'valuation'],
      ['How do analysts value us?', 'valuation'],
      ['What’s our dividend payout ratio?', 'dividends'],
      ['What happens to tangible book value if rates rise 200 bp?', 'rates'],
      ['How is tangible book value per share calculated?', 'method'],
    ];
    const irr = irrModule({} as IrrService, async () => ({}) as never);
    const liq = liquidityModule({} as LiquidityService, null);
    for (const [q, question] of cases) {
      expect(spec.request.test(q), q).toBe(true);
      expect(plan(q), q).toEqual({ tool: 'pershare_view', args: { question } });
    }
    // Rate rises on book value come here; plain rate shocks and bond losses stay where they were.
    expect(irr.request.test('What happens to NII if rates rise 200 bp?')).toBe(true);
    expect(spec.request.test('What happens to NII if rates rise 200 bp?')).toBe(false);
    expect(spec.request.test('What are our unrealized losses on securities?')).toBe(false);
    expect(liq.request.test('What are our unrealized losses on securities?')).toBe(true);
    expect(spec.request.test('Show me the CFO scorecard')).toBe(false);
  });

  it('read shares and a price from what the CFO says', () => {
    expect(parseShares('Shares outstanding for Q3 2026 were 4,886,500, weighted 4,885,300, price $27.90')).toEqual({ shares: 4_886_500, weighted: 4_885_300, price: 27.9 });
    expect(parseShares('Set shares outstanding to 4.9 million')).toEqual({ shares: 4_900_000 });
    expect(parseShares('Our stock closed at $28.40')).toEqual({ price: 28.4 });
    expect(parseShares('What’s our tangible book value per share?')).toBeNull();
    expect(plan('Shares outstanding for Q3 2026 were 4,886,500, weighted 4,885,300, price $27.90')).toEqual({ tool: 'pershare_set', args: { shares: 4_886_500, weighted: 4_885_300, price: 27.9 } });
    expect(plan('Record the share price at $28.40')).toEqual({ tool: 'pershare_set', args: { price: 28.4 } });
  });
});

const up = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM fin_share LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('a bank’s EPS and tangible book value per share', () => {
  it('ties to the Call Report and the register, and the bridge adds up', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const svc = new PerShareService(pool);
      const f = (await svc.figures())!;
      expect(f.missing).toBe(false);
      const n = f.now;
      const [codes] = (await pool.query("SELECT code, amount FROM cr_value WHERE quarter_end = (SELECT MAX(quarter_end) FROM cr_value) AND code IN ('RCON3210', 'RCON3163', 'RCON0426')")) as unknown as [{ code: string; amount: number }[]];
      const g = (c: string) => Number(codes.find((x) => x.code === c)!.amount);
      expect(n.tce).toBeCloseTo(g('RCON3210') - g('RCON3163') - g('RCON0426'), 0);
      expect(n.tbvps!).toBeCloseTo(n.tce / n.shares!, 6);
      // Earnings, dividends, AOCI, intangibles, other and the share count explain the whole year's move.
      const b = f.bridge!;
      expect(b.start + b.earnings + b.dividends + b.aoci + b.intangibles + b.other + b.shares).toBeCloseTo(b.end, 6);
      // Equity rolls forward, so nothing is left unexplained.
      expect(Math.abs(b.other)).toBeLessThan(0.01);
      expect(f.payoutPct!).toBeCloseTo(35, 1);
      // A rate rise takes book value down through AOCI.
      expect(f.rates.find((r) => r.bp === 100)!.change).toBeLessThan(0);
      expect(f.rates.find((r) => r.bp === 200)!.tbvps).toBeLessThan(f.rates.find((r) => r.bp === 100)!.tbvps);
      expect(f.trend).toHaveLength(5);
      // The answer and the change both work for the CFO, and need the module.
      const spec = shareModule(svc);
      const ctx = { user: { id: 'u', name: 'Elena Ortiz' }, modules: ['pershare'], runId: 'r', threadId: 't' };
      const view = (await spec.tools[0]!.run({ question: 'overview' } as never, ctx)) as { text: string; blocks: unknown[] };
      expect(view.text).toMatch(/^Tangible book value per share is \$\d+\.\d{2} at Q3 2026, up/);
      expect(view.text).toMatch(/EPS is \$\d+\.\d{2} over the last twelve months/);
      expect(view.blocks).toHaveLength(4);
      const change = (await spec.tools[1]!.run({ price: 28.4 } as never, ctx)) as { change: { apply: { shares: number; price: number } } };
      // A price alone leaves both share counts as entered.
      expect(change.change.apply).toMatchObject({ shares: n.shares, weighted: n.weighted, price: 28.4 });
      await expect(spec.tools[0]!.run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/isn’t part of your DI access/);
    } finally {
      await pool.end();
    }
  });
});
