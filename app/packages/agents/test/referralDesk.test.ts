// @vitest-environment node
// The Referral Desk and DI's full stage bar: a prospect's referral in its branch queue and the team
// inbox, referrals from an uploaded list, copying a colleague, priority, and saved views.
import { describe, expect, it } from 'vitest';
import { CLOSED_STAGES, ReferralDeskService, ReferralReportService, ReferralService, parseReferralCsv } from '@dinext/di-core';
import { createPool, REFERRAL_TYPES, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { REFERRAL_DESK_REQUEST, referralDeskModule, referralDeskPlan } from '../src/index.ts';

describe('the Referral Desk reads requests', () => {
  it('routes and plans each kind', () => {
    const cases: [string, string][] = [
      ['Refer Maria Lopez, who isn’t a member yet, for a checking account at Westport, 555-201-3344', 'refd_prospect'],
      ['Create referrals from the upload referrals.csv', 'refd_bulk'],
      ['Copy Ana Ruiz on referral #88300', 'refd_cc'],
      ['Make referral #88300 urgent priority', 'refd_priority'],
      ['Save a view of open HELOC referrals at Westport called Westport HELOCs', 'refd_view_save'],
      ['Show my saved referral views', 'refd_views'],
    ];
    for (const [q, tool] of cases) {
      expect(REFERRAL_DESK_REQUEST.test(q), q).toBe(true);
      expect(referralDeskPlan(q).tool, q).toBe(tool);
    }
    expect(referralDeskPlan('Refer Maria Lopez, who isn’t a member yet, for a checking account at Westport, 555-201-3344').args).toMatchObject({ name: 'Maria Lopez', branch: 'Westport', phone: '555-201-3344' });
    expect(referralDeskPlan('Copy Ana Ruiz and Marcus Reed on referral #88300').args).toEqual({ referral_id: 88300, people: ['Ana Ruiz', 'Marcus Reed'] });
    expect(REFERRAL_DESK_REQUEST.test('Refer Suzanne Jackson for a HELOC')).toBe(false);
  });

  it('reads a CSV with quoted cells, and DI’s types and stages are there', () => {
    const x = parseReferralCsv('Member number,Referral type,Notes\n10004521,HELOC,"Kitchen, bath"\nJohn Smith,Wealth management,\n');
    expect(x.rows).toEqual([{ line: 2, member: '10004521', type: 'HELOC', notes: 'Kitchen, bath' }, { line: 3, member: 'John Smith', type: 'Wealth management' }]);
    expect(REFERRAL_TYPES.length).toBeGreaterThanOrEqual(17);
    expect(CLOSED_STAGES).toEqual(expect.arrayContaining(['Sold', 'Product Opened', 'Denied', 'Not Interested', 'Expired']));
  });
});

const DB = 'dinext_t_test_cu';
const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM ref_saved_view LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('the Referral Desk against the warehouse', () => {
  it('refers a prospect, copies a colleague, changes priority and saves a view', async () => {
    const pool = tenantPool(DB);
    const admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${DB}`);
    try {
      const referrals = new ReferralService(pool, 'credit_union');
      const desk = new ReferralDeskService(pool, referrals);
      const spec = referralDeskModule(desk, new ReferralReportService(pool), null);
      const tool = (n: string) => spec.tools.find((t) => t.name === n)!;
      const ctx = { user: { id: 'user:6001', name: 'Marcus Reed' }, modules: ['refdesk'], purviewBranches: ['Westport'], employeeId: 1, runId: 'r', threadId: 't' };
      await admin.query("DELETE FROM esp_com_items WHERE approval_id LIKE 'apr_test_refd%'");
      await admin.query("DELETE FROM ref_saved_view WHERE user_id = 'user:6001'");

      const out = (await tool('refd_prospect').run({ type: 'Checking account', name: 'Maria Lopez', phone: '555-201-3344', branch: 'Westport' } as never, ctx)) as { change: { apply: Record<string, unknown> } };
      expect(out.change.apply).toMatchObject({ typeId: 'checking', branch: 'Westport' });
      await tool('refd_prospect').apply!(out.change.apply as never, { approvalId: 'apr_test_refd_1', userId: 'user:6001' } as never, ctx as never);
      await tool('refd_prospect').apply!(out.change.apply as never, { approvalId: 'apr_test_refd_1', userId: 'user:6001' } as never, ctx as never);
      const [made] = (await pool.query("SELECT com_id, party_id FROM esp_com_items WHERE approval_id = 'apr_test_refd_1'")) as unknown as [{ com_id: number; party_id: number | null }[]];
      expect(made).toHaveLength(1);
      expect(made[0]!.party_id).toBeNull();
      const team = await referrals.inbox('team', { userId: 'user:6001', employeeId: 1 }, { purviewBranches: ['Westport'] });
      expect(team.find((i) => i.comId === made[0]!.com_id)).toMatchObject({ name: 'Maria Lopez (prospect)', branch: 'Westport', last4: 'new' });

      const cc = (await tool('refd_cc').run({ referral_id: made[0]!.com_id, people: ['Ana Ruiz'] } as never, ctx)) as { change: { apply: { employeeIds: number[] } } };
      await tool('refd_cc').apply!(cc.change.apply as never, { approvalId: 'x' } as never, ctx as never);
      const ana = cc.change.apply.employeeIds[0]!;
      const copied = await referrals.inbox('cc', { userId: 'user:x', employeeId: ana }, {});
      expect(copied.map((i) => i.comId)).toContain(made[0]!.com_id);

      const pr = (await tool('refd_priority').run({ referral_id: made[0]!.com_id, priority: 'Urgent' } as never, ctx)) as { change: { apply: unknown } };
      await tool('refd_priority').apply!(pr.change.apply as never, { approvalId: 'y' } as never, ctx as never);
      expect((await desk.referral(made[0]!.com_id, ctx)).priority).toBe('Urgent');

      const sv = (await tool('refd_view_save').run({ name: 'Westport open', filters: { branch: 'Westport', open: true } } as never, ctx)) as { change: { apply: unknown } };
      await tool('refd_view_save').apply!(sv.change.apply as never, { approvalId: 'z' } as never, ctx as never);
      const run = (await tool('refd_view_run').run({ name: 'westport' } as never, ctx)) as { text: string };
      expect(run.text).toMatch(/Westport open/);
    } finally {
      await admin.query("DELETE FROM esp_com_items WHERE approval_id LIKE 'apr_test_refd%'").catch(() => {});
      await admin.query("DELETE FROM ref_saved_view WHERE user_id = 'user:6001'").catch(() => {});
      await admin.end();
    }
  });

  it('checks an uploaded list row by row', async () => {
    const pool = tenantPool(DB);
    const desk = new ReferralDeskService(pool, new ReferralService(pool, 'credit_union'));
    const x = await desk.checkBulk(
      [
        { line: 2, member: '10004521', type: 'Wealth management' },
        { line: 3, member: 'Nobody Atall', type: 'HELOC' },
        { line: 4, member: '10004521', type: 'Space travel' },
      ],
      {},
    );
    expect(x.ready).toHaveLength(1);
    expect(x.ready[0]).toMatchObject({ partyId: 1, typeId: 'wealth', queueId: 'q_wealth' });
    expect(x.problems.map((p) => p.line)).toEqual([3, 4]);
  });
});
