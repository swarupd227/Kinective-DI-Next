// @vitest-environment node
// Data quality and privacy from the ontology (Core Mapping and Ontology, phase 6): checks generated from
// properties' constraints and code lists, run on both warehouses and listed with the other checks; the
// Query Browser keeping out columns the ontology classes as identifying; values masked by privacy class.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationsService, QueryService, runOntologyChecks } from '@dinext/di-core';
import { identifyingColumns, maskValue, ontology, ontologyChecks, privacyOfColumn, propertyNamed } from '@dinext/ontology';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';

const CU = 'dinext_t_test_cu';
const BANK = 'dinext_t_test_bank';

describe('checks the ontology implies', () => {
  const tables = new Set(['cdm_party', 'cdm_loan', 'cdm_deposit_account', 'cdm_loan_chargeoff', 'cdm_card', 'cdm_credit_score_history']);
  const checks = ontologyChecks(ontology(), tables, 'credit_union');
  const by = (rule: string) => checks.find((c) => c.rule === rule);

  it('turns a range, a date limit and a fixed code list into checks with names people read', () => {
    expect(by('cdm_loan.rate between 0 and 30')).toMatchObject({ name: 'Every loan interest rate is between 0% and 30%', dimension: 'Accuracy', params: [0, 30] });
    expect(by('cdm_loan.balance at least 0')?.name).toBe('No loan balance is negative');
    expect(by('cdm_deposit_account.balance at least -100000')?.name).toBe('Every share balance is at least -$100,000');
    expect(by('cdm_loan.open_date not after the as-of date')).toMatchObject({ name: 'No loan date opened is after the data’s date', dimension: 'Conformity', params: ['$asOf'] });
    const codes = by('cdm_loan.loan_category on the loan category list')!;
    expect(codes.name).toBe('Every loan type is one DI knows');
    expect(codes.params).toEqual(expect.arrayContaining(['Auto', 'Mortgage', 'Commercial Real Estate']));
  });

  it('checks the month-end rollups too, but not a weighted total as if it were a rate (phase 8)', () => {
    const hist = ontologyChecks(ontology(), new Set(['hist_deposit_month', 'hist_loan_month']), 'credit_union');
    expect(hist.map((c) => c.rule)).toEqual(expect.arrayContaining(['hist_loan_month.loan_category on the loan category list', 'hist_deposit_month.balance at least -100000']));
    expect(hist.some((c) => c.column === 'rate_weighted' || c.column === 'new_rate_weighted')).toBe(false);
    expect(ontology().columnIndex.get('hist_deposit_month.rate_weighted')).toBe('deposit.rate_weighted_sum');
  });

  it('checks only the tables the institution has, and leaves open code lists alone', () => {
    expect(checks.every((c) => tables.has(c.table))).toBe(true);
    expect(ontologyChecks(ontology(), new Set(['cdm_loan']), 'bank').every((c) => c.table === 'cdm_loan')).toBe(true);
    for (const c of checks) expect(c.rule.length, c.rule).toBeLessThanOrEqual(80);
  });

  it('says in each institution’s words what a check is about', () => {
    const bank = ontologyChecks(ontology(), tables, 'bank');
    expect(bank.find((c) => c.rule === 'cdm_deposit_account.rate between 0 and 20')?.name).toBe('Every deposit interest rate is between 0% and 20%');
    expect(checks.find((c) => c.rule === 'cdm_deposit_account.rate between 0 and 20')?.name).toBe('Every share dividend rate is between 0% and 20%');
  });
});

describe('privacy from the ontology', () => {
  it('knows which columns identify a person', () => {
    const cols = identifyingColumns(ontology());
    expect(cols).toEqual(expect.arrayContaining(['cdm_party.birth_date', 'cdm_party.first_name', 'cdm_party_contact.email']));
    expect(cols).not.toContain('cdm_loan.balance');
    expect(privacyOfColumn(ontology(), 'cdm_loan.balance')).toBe('financial');
    expect(privacyOfColumn(ontology(), 'cdm_party.birth_date')).toBe('direct');
  });

  it('finds a field by its name, and masks values without giving them away', () => {
    expect(propertyNamed(ontology(), 'Birth date')?.privacy).toBe('direct');
    expect(propertyNamed(ontology(), 'email')?.privacy).toBe('direct');
    expect(propertyNamed(ontology(), 'email consent')).toBeNull();
    expect(maskValue('nora.chen@example.com')).toBe('n•••');
    expect(maskValue('1985-03-12')).toBe('••••-••-••');
    expect(maskValue('19850312')).toBe('••••••12');
    expect(maskValue('(555) 201-7788')).toBe('(•••) •••-••88');
  });
});

const up = (await warehouseAvailable(CU)) && (await warehouseAvailable(BANK));

describe.skipIf(!up)('against both warehouses', () => {
  const pools: Pool[] = [];
  beforeAll(() => {
    pools.push(tenantPool(CU), tenantPool(BANK));
  });
  afterAll(async () => {
    for (const p of pools) await p.end();
  });

  it('runs every check on the current tables, records it with the others, and replaces its own results on a rerun', async () => {
    for (const [pool, type] of [[pools[0]!, 'credit_union'], [pools[1]!, 'bank']] as const) {
      const ops = new OperationsService(pool);
      const first = await runOntologyChecks(pool, type);
      expect(first.length, type).toBeGreaterThan(10);
      for (const r of first) expect(r.rowsFailed, r.rule).toBeGreaterThanOrEqual(0);
      const second = await runOntologyChecks(pool, type);
      expect(second.map((r) => [r.rule, r.rowsFailed])).toEqual(first.map((r) => [r.rule, r.rowsFailed]));
      const listed = await ops.checks(false);
      // The seeded checks stay; each ontology check is listed once, by name, with its rule behind it.
      for (const r of second) expect(listed.items.filter((c) => c.name === r.name), r.name).toHaveLength(1);
      for (const seeded of ['loan.branch_id not null', 'party.member_number unique', 'share balance matches the GL']) expect(listed.items.some((c) => c.rule === seeded), seeded).toBe(true);
      // A hand-written result a real check now covers is replaced, not left to contradict it.
      expect(listed.items.some((c) => c.rule === 'share.open_date not in future')).toBe(false);
      const rate = listed.items.find((c) => c.rule === 'cdm_loan.rate between 0 and 30')!;
      expect(rate.name).toBe('Every loan interest rate is between 0% and 30%');
      expect(rate.domain).toBe('Lending');
      expect(rate.passed).toBe(second.find((r) => r.rule === rate.rule)!.rowsFailed === 0);
    }
  }, 120_000);

  it('keeps identifying columns out of the Query Browser, naming the column', async () => {
    const q = new QueryService(pools[0]!);
    await expect(q.run('SELECT first_name, COUNT(*) AS n FROM cdm_party GROUP BY first_name')).rejects.toThrow('first_name holds personal data that can identify a person, so it can’t be queried here.');
    await expect(q.run('SELECT birth_date FROM cdm_party')).rejects.toThrow('birth_date holds personal data');
    expect((await q.run('SELECT loan_category, COUNT(*) AS n FROM cdm_loan GROUP BY loan_category')).rows.length).toBeGreaterThan(0);
  });
});
