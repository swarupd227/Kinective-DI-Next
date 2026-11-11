// @vitest-environment node
// The rest of 5300 Reporting (trial balances, GL mapping, per-loan overrides, charge-off uploads) and of
// SEG Management (filters, notes, sponsorships, members at a company, adding and retiring a company).
import { describe, expect, it } from 'vitest';
import { CallReportService, SegService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { callReportModule, segModule } from '../src/index.ts';

describe('the new 5300 and SEG requests', () => {
  it('plan to the right tools', () => {
    const cr = callReportModule({} as never);
    expect(cr.plan('Show the loan trial balance', {} as never)).toEqual({ tool: 'cr_trial_balance', args: { kind: 'loan' } });
    expect(cr.plan('Map GL 1795 to line AS0013', {} as never)).toEqual({ tool: 'cr_gl_map', args: { gl: '1795', code: 'AS0013' } });
    expect(cr.plan('Loan 1234 belongs on 370 because it is a used car', {} as never)).toMatchObject({ tool: 'cr_loan_override', args: { loan_id: 1234, to: '370' } });
    expect(cr.plan('Check the charge-off upload chargeoffs.csv', {} as never)).toEqual({ tool: 'cr_chargeoff_upload', args: { file: 'chargeoffs.csv' } });
    const seg = segModule({} as never, () => '2026-11-11');
    expect(seg.plan('Show inactive SEGs', {} as never)).toMatchObject({ tool: 'seg_list', args: { active: false } });
    expect(seg.plan('What sponsorships and donations have we given?', {} as never)).toEqual({ tool: 'seg_sponsorships', args: {} });
    expect(seg.plan('Retire Valley Courier Service', {} as never)).toEqual({ tool: 'seg_company_active', args: { company: 'Valley Courier Service', active: false } });
  });
});

const DB = 'dinext_t_test_cu';
const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cr_loan_override LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('against the warehouse', () => {
  it('ties the trial balances, maps a GL account and moves a loan between lines', async () => {
    const pool = tenantPool(DB);
    const admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${DB}`);
    try {
      const cr = new CallReportService(pool);
      const loans = await cr.trialBalance('loan');
      expect(loans.rows.length).toBeGreaterThan(3);
      expect(Math.abs(loans.difference)).toBeLessThan(loans.core * 0.05);
      const deposits = await cr.trialBalance('deposit');
      expect(deposits.reported).toBeGreaterThan(0);

      const spec = callReportModule(cr);
      const tool = (n: string) => spec.tools.find((t) => t.name === n)!;
      const ctx = { user: { id: 'user:6002', name: 'Priya Shah' }, modules: ['callreport'], runId: 'r', threadId: 't' };
      const [unmapped] = await cr.uncategorized();
      const before = (await cr.lines()).find((l) => l.code === '009C')?.current ?? 0;
      const map = (await tool('cr_gl_map').run({ gl: unmapped!.glNumber, code: '009C' } as never, ctx)) as { change: { apply: unknown } };
      await tool('cr_gl_map').apply!(map.change.apply as never, { approvalId: 'apr_t_glmap' } as never, ctx as never);
      expect((await cr.lines()).find((l) => l.code === '009C')!.current).toBeCloseTo(before + unmapped!.balance, 0);
      expect((await cr.uncategorized()).some((g) => g.glNumber === unmapped!.glNumber)).toBe(false);

      const [[loan]] = (await pool.query("SELECT loan_id FROM cdm_loan WHERE loan_category = 'Personal' AND close_date IS NULL AND charge_off_date IS NULL AND balance > 1000 LIMIT 1")) as unknown as [{ loan_id: number }[]];
      const ov = (await tool('cr_loan_override').run({ loan_id: loan!.loan_id, to: '396', reason: 'A card balance converted to a personal loan, still reported as card.' } as never, ctx)) as { change: { apply: { from: string; amount: number } } };
      expect(ov.change.apply.from).toBe('397');
      await tool('cr_loan_override').apply!(ov.change.apply as never, { approvalId: 'apr_t_lnov' } as never, ctx as never);
      const adj = await cr.adjustments();
      expect(adj.filter((a) => a.reason === 'Mapping').length).toBeGreaterThanOrEqual(3);

      const co = await cr.chargeoffCheck([{ loanId: loan!.loan_id, kind: 'Charge-off', amount: 1234.56 }, { category: 'Nonsense', kind: 'Recovery', amount: 5 }]);
      expect(co.problems).toHaveLength(1);
      expect(co.byLine[0]).toMatchObject({ code: 'CH0007', file: 1234.56 });
    } finally {
      await admin.query("DELETE FROM cr_adjustment WHERE approval_id LIKE 'apr_t_%'");
      await admin.query('DELETE FROM cr_loan_override');
      await admin.query("UPDATE cr_gl_account SET line_code = NULL WHERE gl_number IN ('1188', '1795', '2310')");
      await admin.end();
    }
  });

  it('filters SEGs, keeps notes and sponsorships, and adds and retires a company', async () => {
    const pool = tenantPool(DB);
    const admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${DB}`);
    try {
      const seg = new SegService(pool);
      const approved = await seg.list({ stage: 'Board Approved' });
      expect(approved.length).toBeGreaterThan(0);
      expect(approved.every((c) => c.stage === 'Board Approved')).toBe(true);
      const s = await seg.sponsorships();
      expect(s.items.length).toBeGreaterThan(0);
      expect(await seg.notes(approved[0]!.companyId)).not.toHaveLength(0);
      const id = await seg.createCompany({ name: 'Test Harbor Bakery', contact: 'Pat Doe', title: 'Owner', phone: '555-111-2222', email: 'pat@example.com', branch: 'Westport', bdManager: 'Ana Ruiz', employees: 40 }, { approvalId: 'apr_t_segadd' });
      await seg.setActive(id, false);
      expect((await seg.list({ active: false, search: 'harbor bakery' })).map((c) => c.companyId)).toContain(id);
      const spec = segModule(seg, () => '2026-11-11');
      expect(spec.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['seg_list', 'seg_notes', 'seg_sponsorships', 'seg_relationships', 'seg_company_add', 'seg_company_active']));
    } finally {
      await admin.query("DELETE FROM seg_interaction WHERE approval_id = 'apr_t_segadd'");
      await admin.query("DELETE FROM seg_contact WHERE company_id IN (SELECT company_id FROM seg_company WHERE name = 'Test Harbor Bakery')");
      await admin.query("DELETE FROM seg_company WHERE name = 'Test Harbor Bakery'");
      await admin.end();
    }
  });
});
