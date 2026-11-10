// @vitest-environment node
// BSA/AML and fraud: SAR timeliness, the alert backlog, CTRs, OFAC, high-risk customers, the program's
// open items and fraud losses, in aggregate only.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { BsaService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { BSA_REQUEST, bsaAnalyses, bsaModule, bsaQuestion } from '../src/index.ts';

describe('BSA and fraud questions', () => {
  it('route to the right answer', () => {
    const cases: [string, string][] = [
      ['BSA / AML + Fraud Report: SARs, fraud losses, OFAC', 'overview'],
      ['Are our SARs filed on time?', 'sars'],
      ['How old is our alert backlog?', 'alerts'],
      ['Any OFAC hits this year?', 'ofac'],
      ['How many CTRs did we file?', 'ctr'],
      ['Are high-risk customer reviews current?', 'customers'],
      ['Which fraud types are rising?', 'fraud'],
      ['What’s open from the BSA independent test?', 'program'],
    ];
    for (const [q, question] of cases) {
      expect(BSA_REQUEST.test(q), q).toBe(true);
      expect(bsaQuestion(q), q).toBe(question);
    }
    expect(BSA_REQUEST.test('What’s our net charge-off rate?')).toBe(false);
  });
});

const up = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM bsa_sar LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('a bank’s BSA/AML and fraud measures', () => {
  it('counts SARs and their timeliness, ages alerts, totals fraud, and never names a customer', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const svc = new BsaService(pool);
      const a = (await svc.analysis())!;
      const [n] = (await pool.query('SELECT COUNT(*) AS n FROM bsa_sar')) as unknown as [{ n: number }[]];
      expect(a.sars.byQuarter.reduce((t, s) => t + s.filed, 0)).toBe(Number(n[0]!.n));
      // The July SAR filed after 38 days is the board's first concern.
      expect(a.sars.lateThisYear).toHaveLength(1);
      expect(a.sars.lateThisYear[0]!.days).toBeGreaterThan(30);
      expect(a.items[0]!.read).toBe('Concern');
      expect(a.alerts.aging.under30 + a.alerts.aging.d31to60 + a.alerts.aging.over60).toBe(a.alerts.open);
      for (const q of a.fraud.byQuarter) expect(q.net).toBeCloseTo(q.gross - q.recovered, 2);
      expect(a.fraud.net12BpOfDeposits!).toBeGreaterThan(0);
      expect(a.fraud.net12BpOfDeposits!).toBeLessThan(25);

      const spec = bsaModule(svc);
      const ctx = { user: { id: 'u', name: 'Elena Ortiz' }, modules: ['bsa'], runId: 'r', threadId: 't' };
      const o = (await spec.tools[0]!.run({} as never, ctx)) as { text: string; blocks: unknown[] };
      expect(o.text).toMatch(/^\*\*\d+ SARs\*\* were filed over the last four quarters/);
      expect(o.text).toMatch(/Fraud cost \*\*\$[\d.]+[MK]\*\* net/);
      const s = (await spec.tools[0]!.run({ question: 'sars' } as never, ctx)) as { text: string; blocks: { data: { rows: Record<string, string>[] } }[] };
      expect(s.text).toMatch(/only in aggregate/);
      // No answer or table carries a member's name or number.
      const [names] = (await pool.query('SELECT p.last_name FROM bsa_sar s JOIN cdm_party p ON p.party_id = s.party_id LIMIT 20')) as unknown as [{ last_name: string }[]];
      const all = JSON.stringify([o, s]);
      for (const x of names) expect(all.includes(` ${x.last_name} `)).toBe(false);
      await expect(spec.tools[0]!.run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/isn’t part of your DI access/);
      const an = bsaAnalyses(svc);
      for (const key of an.keys) {
        const { block, take } = await an.run(key, 'R-bsa');
        expect(blockSchema.safeParse(block).success, key).toBe(true);
        if (take) expect(take.headline.length, key).toBeLessThanOrEqual(300);
      }
    } finally {
      await pool.end();
    }
  });
});
