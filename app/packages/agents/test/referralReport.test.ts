// @vitest-environment node
// Referral reporting: the list with filters, conversion by type and sender, sales checked against the
// accounts the core shows opened, and stale referrals expired on approval.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { ReferralReportService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { REFERRAL_REPORT_REQUEST, referralReportModule, referralReportPlan } from '../src/index.ts';

describe('referral report questions', () => {
  it('route to the right tool, and leave making and working referrals alone', () => {
    const cases: [string, string, Record<string, unknown>?][] = [
      ['Show referral conversion by type', 'ref_performance', { by: 'type' }],
      ['Who makes the most referrals?', 'ref_performance', { by: 'sender' }],
      ['Show referral performance by branch', 'ref_performance', { by: 'branch' }],
      ['Show referral performance by branch this quarter', 'ref_performance', { by: 'branch', period: 'quarter' }],
      ['Show all sold HELOC referrals', 'ref_list', { stage: 'Sold', type: 'HELOC' }],
      ['Which referrals have gone stale?', 'ref_expire', {}],
    ];
    for (const [q, tool, args] of cases) {
      expect(REFERRAL_REPORT_REQUEST.test(q), q).toBe(true);
      const p = referralReportPlan(q);
      expect(p.tool, q).toBe(tool);
      if (args) expect(p.args, q).toMatchObject(args);
    }
    expect(REFERRAL_REPORT_REQUEST.test('Refer Suzanne Jackson for a HELOC')).toBe(false);
    expect(REFERRAL_REPORT_REQUEST.test('Show my overdue referrals')).toBe(false);
  });
});

const up = await warehouseAvailable('dinext_t_test_cu').then((ok) => ok && tenantPool('dinext_t_test_cu').query('SELECT closed_at FROM esp_com_items LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('referral reports on the credit union', () => {
  it('reports conversion, checks sales against opened accounts, keeps to purview, and expires stale ones', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    const admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
    let expired: number[] = [];
    try {
      const svc = new ReferralReportService(pool);
      const all = await svc.performance('type', {});
      expect(all.total.referrals).toBeGreaterThan(500);
      expect(all.total.sold + all.total.notInterested + all.total.expired + all.total.open).toBe(all.total.referrals);
      // Most sales opened the product; a few didn't, and they are listed.
      expect(all.total.openedPct!).toBeGreaterThan(80);
      expect(all.notOpened.length).toBeGreaterThan(0);
      const westport = await svc.performance('branch', { purviewBranches: ['Westport'] });
      expect(westport.rows.map((r) => r.name)).toEqual(['Westport']);
      const sold = await svc.list({ stage: 'Sold', type: 'Auto loan' }, {});
      expect(sold.items.every((r) => r.stage === 'Sold' && r.type === 'Auto loan')).toBe(true);

      const spec = referralReportModule(svc);
      const ctx = { user: { id: 'user:9229', name: 'Dana Lee' }, modules: ['refreport'], runId: 'r', threadId: 't' };
      for (const [name, args] of [['ref_performance', { by: 'type' }], ['ref_list', { open: true }]] as const) {
        const out = (await spec.tools.find((t) => t.name === name)!.run(args as never, ctx)) as { text: string; blocks: unknown[] };
        expect(out.text, name).toMatch(/\*\*\d[\d,]* referrals\*\*/);
        for (const b of out.blocks) expect(blockSchema.safeParse(b).success, name).toBe(true);
      }
      const stale = (await spec.tools.find((t) => t.name === 'ref_expire')!.run({} as never, ctx)) as { change: { apply: { comIds: number[] }; risk: string } };
      expect(stale.change.risk).toBe('medium');
      expired = stale.change.apply.comIds;
      expect(expired.length).toBeGreaterThan(0);
      await spec.tools.find((t) => t.name === 'ref_expire')!.apply!(stale.change.apply as never, { approvalId: 'apr_test_expire', userId: 'user:9229' }, ctx);
      expect((await svc.stale({})).items).toEqual([]);
      await expect(spec.tools[0]!.run({} as never, { ...ctx, modules: [] })).rejects.toThrow(/aren’t part of your DI access/);
    } finally {
      // Put the stale referrals back the way the seed left them.
      if (expired.length) {
        await admin.query("UPDATE esp_com_items SET stage = 'Active', closed_at = NULL WHERE com_id IN (?)", [expired]);
        await admin.query("DELETE FROM esp_com_lines WHERE com_id IN (?) AND text LIKE 'Expired after%'", [expired]);
      }
      await Promise.all([pool.end(), admin.end()]);
    }
  });
});
