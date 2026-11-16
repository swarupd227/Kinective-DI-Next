// @vitest-environment node
// ESP phase 2: charge-offs and recoveries loan by loan, adding up to the Call Report, and insider lending
// (Regulation O for a bank, NCUA 701.21(d) for a credit union).
import { describe, expect, it } from 'vitest';
import { DelinquencyService, InsiderService, RelationshipService, type IssueService } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { complianceModule, delinquencyModule } from '../src/index.ts';

describe('routing', () => {
  it('sends charge-offs loan by loan to dq_chargeoffs and insider lending to Compliance, without taking their old questions', () => {
    const dq = delinquencyModule({} as DelinquencyService);
    const plan = (t: string) => (dq.plan(t, {} as never) as { tool?: string; args?: { category?: string } });
    for (const q of ['Show charge-offs and recoveries by loan type', 'Which loans were charged off this year?', 'Show the largest charge-offs', 'How much have we recovered on charged-off loans?']) {
      expect(dq.request.test(q), q).toBe(true);
      expect(plan(q).tool, q).toBe('dq_chargeoffs');
    }
    expect(plan('Show auto charge-offs and recoveries').args?.category).toBe('Auto');
    expect(plan('What’s our net charge-off ratio?').tool).toBe('dq_losses');
    expect(plan('What’s our allowance coverage?').tool).toBe('dq_losses');
    expect(plan('What is our NPL ratio and net charge-off rate?').tool).toBe('dq_losses');
    const cpm = complianceModule({} as IssueService, {} as never);
    const cp = (t: string) => (cpm.plan(t, {} as never) as { tool?: string }).tool;
    for (const q of ['Show our insider loans', 'Are we within Regulation O?', 'Show loans to directors and officials', 'Any employee-owned loans to review?']) expect(cp(q), q).toBe('cpm_insider_loans');
    expect(cpm.request.test('Show our insider loans')).toBe(true);
    expect(cpm.request.test('Are we within Reg O?')).toBe(true);
    expect(cp('Which regulatory issues are open more than 3 weeks?')).toBe('cpm_issues_list');
    expect(cp('Summarize case 4471')).toBe('cpm_issue_get');
    expect(cpm.request.test('What is the regulation of overdraft fees?')).toBe(false);
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cdm_loan_chargeoff LIMIT 1').then(() => true, () => false));
  const type = DB.endsWith('bank') ? 'bank' : 'credit_union';
  describe.skipIf(!up)(`${DB}: phase 2`, () => {
    const pool = tenantPool(DB);
    const one = async (sql: string, params: unknown[] = []) => Number(((await pool.query(sql, params)) as unknown as [{ n: unknown }[]])[0][0]!.n ?? 0);

    it('has one charge-off row for every charged-off loan, and recoveries only after it, never more than it', async () => {
      expect(await one('SELECT COUNT(*) AS n FROM cdm_loan l LEFT JOIN cdm_loan_chargeoff c ON c.loan_id = l.loan_id WHERE l.charge_off_date IS NOT NULL AND (c.loan_id IS NULL OR c.charge_off_date <> l.charge_off_date)')).toBe(0);
      expect(await one('SELECT COUNT(*) AS n FROM cdm_loan_chargeoff c LEFT JOIN cdm_loan l ON l.loan_id = c.loan_id WHERE l.charge_off_date IS NULL')).toBe(0);
      expect(await one('SELECT COUNT(*) AS n FROM cdm_loan_chargeoff WHERE amount <= 0')).toBe(0);
      expect(await one('SELECT COUNT(*) AS n FROM cdm_loan_recovery r JOIN cdm_loan_chargeoff c ON c.loan_id = r.loan_id WHERE r.recovery_date <= c.charge_off_date OR r.recovery_date > (SELECT MAX(as_of_date) FROM meta_build)')).toBe(0);
      expect(await one('SELECT COUNT(*) AS n FROM (SELECT c.loan_id FROM cdm_loan_chargeoff c JOIN cdm_loan_recovery r ON r.loan_id = c.loan_id GROUP BY c.loan_id, c.amount HAVING SUM(r.amount) > c.amount) x')).toBe(0);
      // Charged-off loans carry no balance and aren't counted delinquent.
      expect(await one('SELECT COUNT(*) AS n FROM cdm_loan WHERE charge_off_date IS NOT NULL AND (balance <> 0 OR days_delinquent <> 0)')).toBe(0);
    });

    it('adds up to the Call Report’s charge-off and recovery lines every quarter', async () => {
      const [co, rec] = type === 'bank' ? ['RIAD4635', 'RIAD4605'] : ['550', '551'];
      const quarters = ((await pool.query('SELECT DISTINCT quarter_end AS q FROM cr_value ORDER BY q')) as unknown as [{ q: unknown }[]])[0].map((r) => (r.q instanceof Date ? r.q.toISOString() : String(r.q)).slice(0, 10));
      expect(quarters.length).toBeGreaterThanOrEqual(5);
      for (const q of quarters) {
        const from = `${q.slice(0, 4)}-01-01`;
        const reportedCo = await one('SELECT amount AS n FROM cr_value WHERE code = ? AND quarter_end = ?', [co, q]);
        const reportedRec = await one('SELECT amount AS n FROM cr_value WHERE code = ? AND quarter_end = ?', [rec, q]);
        // Each loan type's line is rounded to the dollar, so the total can be a few dollars off the detail.
        expect(Math.abs(reportedCo - (await one('SELECT SUM(amount) AS n FROM cdm_loan_chargeoff WHERE charge_off_date BETWEEN ? AND ?', [from, q]))), q).toBeLessThan(10);
        expect(Math.abs(reportedRec - (await one('SELECT SUM(amount) AS n FROM cdm_loan_recovery WHERE recovery_date BETWEEN ? AND ?', [from, q]))), q).toBeLessThan(10);
      }
      // The year's net charge-offs are what a real institution of this kind reports.
      const l = (await new DelinquencyService(pool).losses())!;
      if (type === 'bank') expect(l.ncoRatio).toBeGreaterThan(0.2), expect(l.ncoRatio).toBeLessThan(0.6);
      else expect(l.ncoRatio).toBeGreaterThan(0.4), expect(l.ncoRatio).toBeLessThan(0.9);
    });

    it('shows charge-offs by loan type that tie to the Call Report, narrowed by purview', async () => {
      const dq = new DelinquencyService(pool);
      const c = (await dq.chargeOffs())!;
      expect(c.reported).not.toBeNull();
      expect(Math.abs(c.reported!.chargeOffs - c.total.chargedOff)).toBeLessThan(10);
      expect(Math.abs(c.reported!.recoveries - c.total.recovered)).toBeLessThan(10);
      expect(c.byCategory.reduce((s, x) => s + x.count, 0)).toBe(c.total.count);
      expect(c.largest[0]!.amount).toBeGreaterThanOrEqual(c.largest.at(-1)!.amount);
      const branch = c.largest[0]!.branch;
      const mine = (await dq.chargeOffs({ purviewBranches: [branch] }))!;
      expect(mine.reported).toBeNull();
      expect(mine.largest.every((x) => x.branch === branch)).toBe(true);
      expect(mine.total.chargedOff).toBeLessThan(c.total.chargedOff);
      // The semantic metrics read the same rows.
      const svc = await SemanticService.create(pool, DB.replace('dinext_t_', ''), type);
      const ytd = await one("SELECT SUM(amount) AS n FROM cdm_loan_chargeoff WHERE charge_off_date >= MAKEDATE(YEAR((SELECT MAX(as_of_date) FROM meta_build)), 1)");
      expect(Number((await svc.query({ metrics: ['loan_charge_offs_ytd'] }, { canViewSql: false })).rows[0]!.loan_charge_offs_ytd)).toBeCloseTo(ytd, 0);
      const byCat = (await svc.query({ metrics: ['loan_recoveries_ytd'], dimensions: ['loan_category'] }, { canViewSql: false })).rows;
      expect(byCat.length).toBeGreaterThan(1);
    });

    it('shows a borrower’s charge-off and what has come back on Member 360', async () => {
      const [[r]] = (await pool.query('SELECT l.party_id AS p, c.amount AS a FROM cdm_loan_chargeoff c JOIN cdm_loan l ON l.loan_id = c.loan_id JOIN cdm_loan_recovery r ON r.loan_id = c.loan_id ORDER BY c.loan_id LIMIT 1')) as unknown as [{ p: number; a: number }[]];
      const p = await new RelationshipService(pool, DB.replace('dinext_t_', ''), type).profile(Number(r!.p), {});
      const item = p.chargeOffs.items.find((x) => x.amount !== null && Math.abs(x.amount - Number(r!.a)) < 0.01)!;
      expect(item.recovered).toBeGreaterThan(0);
    });

    it('charges off overdrawn checking only when the account closed', async () => {
      expect(await one("SELECT COUNT(*) AS n FROM cdm_deposit_chargeoff c JOIN cdm_deposit_account d ON d.account_id = c.account_id WHERE d.close_date IS NULL OR d.close_date <> c.charge_off_date OR d.deposit_category NOT LIKE 'Checking%'")).toBe(0);
      expect(await one('SELECT COUNT(*) AS n FROM cdm_deposit_chargeoff')).toBeGreaterThan(0);
    });

    it('lists insiders and their loans, with the board’s approval where the rule asks for it', async () => {
      expect(await one('SELECT COUNT(*) AS n FROM cdm_insider_loan il JOIN cdm_loan l ON l.loan_id = il.loan_id WHERE l.party_id <> il.party_id')).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM cdm_insider WHERE role = 'Director'")).toBe(type === 'bank' ? 9 : 9);
      const r = (await new InsiderService(pool, type).loans())!;
      expect(r.rule).toBe(type === 'bank' ? 'Regulation O (12 CFR 215)' : 'NCUA 701.21(d)');
      expect(r.officials.borrowers).toBeGreaterThan(5);
      expect(r.employees.loans).toBeGreaterThan(0);
      // One credit-union official's loan went through without the board; the bank's all have approval.
      const missing = r.exceptions.flatMap((x) => x.unapproved);
      expect(missing.length).toBe(type === 'bank' ? 0 : 1);
      if (type === 'bank') {
        expect(r.threshold).toBe(500_000);
        expect(r.aggregateToCapital!).toBeLessThan(100);
      } else expect(r.threshold).toBe(20_000);
    });
  });
}
