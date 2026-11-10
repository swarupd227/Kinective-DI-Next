// @vitest-environment node
// Operational and cyber risk: incidents and the 36-hour notification rule, vendors, controls, measures,
// resilience tests, and cyber insurance against ransomware scenarios.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { OpRiskService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { OPRISK_REQUEST, opRiskAnalyses, opRiskModule, opRiskQuestion } from '../src/index.ts';

describe('operational and cyber risk questions', () => {
  it('route to the right answer', () => {
    const cases: [string, string][] = [
      ['Operational / Cyber Risk Report: one ransomware event can stop the bank', 'overview'],
      ['Would our cyber insurance cover a ransomware attack?', 'insurance'],
      ['Which critical vendors need attention?', 'vendors'],
      ['How resilient are we if the core goes down?', 'resilience'],
      ['How are our cyber controls?', 'controls'],
      ['What security incidents did we have this year?', 'incidents'],
    ];
    for (const [q, question] of cases) {
      expect(OPRISK_REQUEST.test(q), q).toBe(true);
      expect(opRiskQuestion(q), q).toBe(question);
    }
    expect(OPRISK_REQUEST.test('Connect a vendor API')).toBe(false);
  });
});

const up = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM ops_incident LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('a bank’s operational and cyber risk', () => {
  it('times regulator notifications, flags vendors, and tests insurance against ransomware', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const svc = new OpRiskService(pool);
      const a = (await svc.analysis())!;
      const notified = a.incidents.filter((i) => i.notification);
      expect(notified).toHaveLength(2);
      expect(notified.filter((i) => i.late).map((i) => i.category)).toEqual(['Ransomware attempt']);
      // A longer outage costs more and leaves more to the bank once the ransomware sublimit is used.
      const [s1, s5, s10] = a.scenarios;
      expect(s5!.total).toBeGreaterThan(s1!.total);
      expect(s10!.retained).toBeGreaterThan(s5!.retained);
      for (const s of a.scenarios) expect(s.covered + s.retained).toBeCloseTo(s.total, 2);
      expect(a.items[0]!.read).toBe('Concern');
      expect(a.functions.map((f) => f.fn)).toEqual(['Govern', 'Identify', 'Protect', 'Detect', 'Respond', 'Recover']);

      const spec = opRiskModule(svc);
      const ctx = { user: { id: 'u', name: 'Elena Ortiz' }, modules: ['oprisk'], runId: 'r', threadId: 't' };
      const ins = (await spec.tools[0]!.run({ question: 'insurance' } as never, ctx)) as { text: string; blocks: unknown[] };
      expect(ins.text).toMatch(/leaving \*\*\$\d+\.\d\dM\*\* uninsured/);
      const o = (await spec.tools[0]!.run({} as never, ctx)) as { text: string };
      expect(o.text).toMatch(/^\*\*\d+ incidents\*\* since/);
      expect(o.text).toMatch(/past the 36 allowed/);
      await expect(spec.tools[0]!.run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/isn’t part of your DI access/);
      const an = opRiskAnalyses(svc);
      for (const key of an.keys) {
        const { block, take } = await an.run(key, 'R-ops');
        expect(blockSchema.safeParse(block).success, key).toBe(true);
        if (take) expect(take.headline.length, key).toBeLessThanOrEqual(300);
      }
    } finally {
      await pool.end();
    }
  });
});
