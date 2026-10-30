// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compile, loadModel, resolvePeriods, searchCatalog, SemanticError, SemanticQueryRequest, type QueryContext } from '../src/index.ts';

const cu = loadModel('test_cu', 'credit_union');
const bank = loadModel('test_bank', 'bank');
const env = {
  model: cu,
  dimensionValues: {
    branch: ['Westport', 'Northgate', 'Riverside', 'Lakeshore', 'Downtown', 'Eastgate'],
    loan_category: ['Auto', 'Business', 'Credit Card', 'HELOC', 'Mortgage', 'Personal'],
    deposit_category: ['Certificates', 'Checking', 'IRA', 'Money Market', 'Share Savings'],
    origination_channel: ['Direct', 'Indirect'],
    region: ['Central', 'North', 'South'],
  },
  branchIds: { Westport: 1, Northgate: 2, Riverside: 3, Lakeshore: 4, Downtown: 5, Eastgate: 6 },
  latestMonthEnd: '2026-09-30',
};
const all: QueryContext = { canViewSql: false };
const req = (r: unknown) => SemanticQueryRequest.parse(r);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof SemanticError ? e.code : String(e);
  }
  return 'no error';
};

describe('semantic model (BE-SEM-002, BE-SEM-003)', () => {
  it('loads the stock model with tenant revisions in the version', () => {
    expect(cu.version).toBe('1.0.0+t3');
    expect(bank.version).toBe('1.0.0+t1');
  });

  it('labels people and products by institution type (AI-AGT-002)', () => {
    expect(cu.metrics.member_count!.label).toBe('Members');
    expect(bank.metrics.member_count!.label).toBe('Customers');
    expect(cu.metrics.deposit_balance!.label).toBe('Total share balance');
    expect(bank.metrics.loan_to_share_ratio!.label).toBe('Loan-to-deposit ratio');
    expect(bank.dimensions.deposit_category!.label).toBe('Deposit product');
  });

  it('applies tenant synonym overrides', () => {
    expect(cu.dimensions.branch!.synonyms).toContain('store');
  });
});

describe('compiler (spec 16.8)', () => {
  it('produces identical SQL for identical requests (BE-SEM-021)', () => {
    const r = req({ metrics: ['loan_balance', 'delinquency_ratio_60_plus'], dimensions: ['branch'] });
    expect(compile(r, all, env).parts).toEqual(compile(r, all, env).parts);
  });

  it('shares one query for measures on the same source, with the setting inlined', () => {
    const c = compile(req({ metrics: ['loan_balance', 'delinquency_ratio_60_plus'], dimensions: ['branch'] }), all, env);
    expect(c.parts).toHaveLength(1);
    expect(c.parts[0]!.sql).toContain('l.days_delinquent >= 60');
    expect(c.parts[0]!.sql).toContain('l.close_date IS NULL');
  });

  it('passes filter values and purview as bind parameters, never in the SQL text (BE-SEM-022)', () => {
    const c = compile(req({ metrics: ['loan_balance'], filters: [{ dimension: 'loan_category', op: 'in', values: ['auto'] }] }), { canViewSql: false, purviewBranches: ['Eastgate'] }, env);
    expect(c.parts[0]!.sql).not.toContain('Auto');
    expect(c.parts[0]!.params).toEqual([6, 'Auto']);
    expect(c.filtersApplied).toEqual(['Loan category is Auto', 'Limited to your purview: Eastgate']);
  });

  it('rejects filter values that are not in the dimension value list', () => {
    expect(codeOf(() => compile(req({ metrics: ['loan_balance'], filters: [{ dimension: 'branch', op: 'in', values: ["Westport' OR 1=1 --"] }] }), all, env))).toBe('UNKNOWN_FILTER_VALUE');
  });

  it('keeps institution-level metrics institution-level', () => {
    expect(codeOf(() => compile(req({ metrics: ['loan_to_share_ratio'], dimensions: ['branch'] }), all, env))).toBe('DIMENSION_NOT_ALLOWED');
  });

  it('splits a cross-source ratio into one query per source', () => {
    const c = compile(req({ metrics: ['loan_to_share_ratio'] }), all, env);
    expect(c.parts.map((p) => p.source)).toEqual(['deposit_current', 'loan_current']);
  });

  it('refuses dimensions a metric does not allow', () => {
    expect(codeOf(() => compile(req({ metrics: ['deposit_balance'], dimensions: ['loan_category'] }), all, env))).toBe('DIMENSION_NOT_ALLOWED');
  });

  it('reads trends from history and flows from complete months only', () => {
    const c = compile(req({ metrics: ['deposit_balance', 'new_members'], time: { grain: 'quarter', last: 2 } }), all, env);
    expect(c.periods!.map((p) => p.label)).toEqual(['Q2 2026', 'Q3 2026']);
    expect(c.parts.map((p) => [p.source, p.timeMode])).toEqual([
      ['deposit_history', 'pit'],
      ['party_history', 'flow'],
    ]);
    expect(c.parts[0]!.params).toEqual(['2026-06-30', '2026-09-30']);
    expect(c.parts[1]!.params).toEqual(['2026-04-30', '2026-09-30']);
  });

  it('asks for a period when a flow metric is requested as of the build', () => {
    expect(codeOf(() => compile(req({ metrics: ['new_loan_amount'] }), all, env))).toBe('NO_SOURCE');
  });

  it('keeps current-only metrics out of trends', () => {
    expect(codeOf(() => compile(req({ metrics: ['average_loan_rate'], time: { grain: 'month', last: 3 } }), all, env))).toBe('CURRENT_ONLY');
  });

  it('refuses a filter on a branch outside the purview (AI-AGT-008)', () => {
    expect(codeOf(() => compile(req({ metrics: ['loan_balance'], filters: [{ dimension: 'branch', op: 'in', values: ['Northgate'] }] }), { canViewSql: false, purviewBranches: ['Westport'] }, env))).toBe('NO_ACCESS');
  });

  it('refuses a purview with no known branches', () => {
    expect(codeOf(() => compile(req({ metrics: ['loan_balance'] }), { canViewSql: false, purviewBranches: ['Atlantis'] }, env))).toBe('NO_ACCESS');
  });
});

describe('periods', () => {
  it('drops incomplete quarters and years', () => {
    expect(resolvePeriods({ grain: 'quarter' }, '2026-09-30').map((p) => p.label)).toEqual(['Q2 2025', 'Q3 2025', 'Q4 2025', 'Q1 2026', 'Q2 2026', 'Q3 2026']);
    // History starts in April 2025, so no calendar year is complete yet.
    expect(codeOf(() => resolvePeriods({ grain: 'year' }, '2026-09-30'))).toBe('INVALID_TIME');
  });

  it('supports explicit month ranges', () => {
    expect(resolvePeriods({ grain: 'month', from: '2026-07', to: '2026-09' }, '2026-09-30').map((p) => p.label)).toEqual(['Jul 2026', 'Aug 2026', 'Sep 2026']);
  });
});

describe('catalog search (spec 23.5.3)', () => {
  it('finds metrics by synonym and named values', () => {
    const r = searchCatalog(cu, 'Show loan growth by branch for Q3 vs Q2', env.dimensionValues);
    expect(r.matched).toBe(true);
    expect(r.metrics[0]!.name).toBe('loan_balance');
    expect(r.dimensions[0]!.name).toBe('branch');
  });

  it('finds delinquency from everyday words', () => {
    expect(searchCatalog(cu, 'which branches have the most loans that are behind?', env.dimensionValues).metrics[0]!.name).toBe('delinquency_ratio_60_plus');
  });

  it('finds deposits by product type and the certificate value', () => {
    const r = searchCatalog(cu, 'What did deposit balances do by product type over the last two quarters? How about certificates?', env.dimensionValues);
    expect(r.metrics[0]!.name).toBe('deposit_balance');
    expect(r.values).toContainEqual({ dimension: 'deposit_category', value: 'Certificates' });
  });

  it('does not match questions outside the model (AI-ARC-042)', () => {
    const r = searchCatalog(cu, "What's our wallet share with gig workers?", env.dimensionValues);
    expect(r.matched).toBe(false);
    expect(r.unknownTerms).toEqual(expect.arrayContaining(['wallet', 'gig', 'worker']));
  });

  it('still matches everyday questions in full', () => {
    for (const q of ['How many members joined last quarter?', 'Total loans by region', 'Show me the loan-to-share ratio', 'Auto loan originations by month this year', 'What is our weighted average loan rate by loan type?']) {
      expect(searchCatalog(cu, q, env.dimensionValues).matched, q).toBe(true);
    }
  });
});
