// @vitest-environment node
// Runs against the seeded MySQL warehouse (npm run db:up && npm run db:seed); skipped without it.
// Expected values come from independent hand-written SQL, so the compiler is checked end to end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { SemanticError, SemanticService } from '../src/index.ts';

const available = await warehouseAvailable('dinext_t_test_cu');
let pool: Pool;
let bankPool: Pool;
let svc: SemanticService;
let bank: SemanticService;

beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  bankPool = tenantPool('dinext_t_test_bank');
  svc = await SemanticService.create(pool, 'test_cu', 'credit_union');
  bank = await SemanticService.create(bankPool, 'test_bank', 'bank');
});
afterAll(async () => {
  await pool?.end();
  await bankPool?.end();
});

const one = async (sql: string, params: unknown[] = []) => {
  const [rows] = (await pool.query(sql, params)) as unknown as [Record<string, number>[]];
  return Number(Object.values(rows[0]!)[0]);
};
const all = { canViewSql: false };

describe.skipIf(!available)('semantic service on the synthetic credit union', () => {
  it('reads the published build and the model version', () => {
    expect(svc.build).toMatchObject({ buildId: 'bld_20261026', asOf: '2026-10-25', latestMonthEnd: '2026-09-30' });
    expect(svc.dimensionValues.branch).toEqual(['Westport', 'Northgate', 'Riverside', 'Lakeshore', 'Downtown', 'Eastgate']);
  });

  it('matches hand-written SQL for total loans and its branch breakdown', async () => {
    const expected = await one('SELECT SUM(balance) FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL');
    const total = await svc.query({ metrics: ['loan_balance'] }, all);
    expect(total.rows[0]!.loan_balance).toBeCloseTo(expected, 2);
    const byBranch = await svc.query({ metrics: ['loan_balance'], dimensions: ['branch'], order: [{ field: 'loan_balance', dir: 'desc' }] }, all);
    expect(byBranch.rows).toHaveLength(6);
    expect(byBranch.rows.reduce((s, r) => s + Number(r.loan_balance), 0)).toBeCloseTo(expected, 2);
    expect(Number(byBranch.rows[0]!.loan_balance)).toBeGreaterThan(Number(byBranch.rows[5]!.loan_balance));
  });

  it('computes the delinquency ratio as delinquent balance over open balance', async () => {
    const num = await one('SELECT SUM(balance) FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL AND days_delinquent >= 60');
    const den = await one('SELECT SUM(balance) FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL');
    const r = await svc.query({ metrics: ['delinquency_ratio_60_plus'] }, all);
    expect(r.rows[0]!.delinquency_ratio_60_plus).toBeCloseTo((num / den) * 100, 6);
  });

  it('limits rows to the purview (GQ-PERM-004)', async () => {
    const r = await svc.query({ metrics: ['loan_balance'], dimensions: ['branch'] }, { canViewSql: false, purviewBranches: ['Eastgate'] });
    expect(r.rows.map((x) => x.branch)).toEqual(['Eastgate']);
    expect(r.filtersApplied).toContain('Limited to your purview: Eastgate');
    const eastgate = await one('SELECT SUM(l.balance) FROM cdm_loan l JOIN cdm_location c ON c.int_id = l.branch_id WHERE c.name = ? AND l.close_date IS NULL AND l.charge_off_date IS NULL', ['Eastgate']);
    expect(r.rows[0]!.loan_balance).toBeCloseTo(eastgate, 2);
  });

  it('answers the deposits-by-product question over two quarters (GQ-BI-001)', async () => {
    const r = await svc.query({ metrics: ['deposit_balance'], dimensions: ['deposit_category'], time: { grain: 'quarter', last: 2 } }, all);
    expect(r.periods!.map((p) => p.label)).toEqual(['Q2 2026', 'Q3 2026']);
    expect(r.rows).toHaveLength(10);
    const certQ3 = await one("SELECT SUM(balance) FROM hist_deposit_month WHERE month_end = '2026-09-30' AND deposit_category = 'Certificates'");
    expect(r.rows.find((x) => x.deposit_category === 'Certificates' && x.period === 'Q3 2026')!.deposit_balance).toBeCloseTo(certQ3, 2);
  });

  it('sums flow metrics over every month of the period', async () => {
    const r = await svc.query({ metrics: ['new_members'], time: { grain: 'quarter', last: 1 } }, all);
    const expected = await one("SELECT SUM(new_member_count) FROM hist_party_month WHERE month_end BETWEEN '2026-07-31' AND '2026-09-30'");
    expect(r.rows[0]!.new_members).toBe(expected);
  });

  it('combines a cross-source ratio', async () => {
    const r = await svc.query({ metrics: ['loan_to_share_ratio'] }, all);
    const loans = await one('SELECT SUM(balance) FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL');
    const deposits = await one('SELECT SUM(balance) FROM cdm_deposit_account WHERE close_date IS NULL');
    expect(r.rows[0]!.loan_to_share_ratio).toBeCloseTo((loans / deposits) * 100, 6);
  });

  it('returns SQL only to users who may see it (BE-SEM-020)', async () => {
    const hidden = await svc.query({ metrics: ['loan_balance'] }, all);
    const shown = await svc.query({ metrics: ['loan_balance'] }, { canViewSql: true });
    expect(hidden.sql).toBeUndefined();
    expect(shown.sql![0]).toContain('FROM cdm_loan');
    expect(shown.sqlHash).toBe(hidden.sqlHash);
    expect(shown.queryId).toBe(hidden.queryId);
  });

  it('returns structured errors with suggestions', async () => {
    await expect(svc.query({ metrics: ['loan_balance'], filters: [{ dimension: 'branch', op: 'in', values: ['West'] }] }, all)).rejects.toMatchObject({ code: 'UNKNOWN_FILTER_VALUE', suggestions: ['Westport'] });
    await expect(svc.query({ metrics: ['loan_balance'], filters: [{ dimension: 'branch', op: 'in', values: ['West'] }] }, all)).rejects.toBeInstanceOf(SemanticError);
  });
});

describe.skipIf(!available)('semantic service on the synthetic bank', () => {
  it('uses bank terminology and bank product values', async () => {
    const r = await bank.query({ metrics: ['member_count'] }, all);
    expect(r.columns.find((c) => c.key === 'member_count')!.label).toBe('Customers');
    expect(bank.dimensionValues.deposit_category).toContain('Certificates of Deposit');
  });
});
