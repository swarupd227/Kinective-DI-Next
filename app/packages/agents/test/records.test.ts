// Drill to records: the loans, accounts or members behind a figure, under its filters and purview,
// and the same total as the figure itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SemanticService } from '@dinext/semantic';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { parseRecordsRequest, recordsModule, RECORDS_REQUEST } from '../src/index.ts';
import { recordsAction } from '../src/answer.ts';

describe('asking for the records behind a figure', () => {
  it('recognises the request and leaves other questions alone', () => {
    expect(RECORDS_REQUEST.test('Show the loans behind delinquency 60+ for Eastgate')).toBe(true);
    expect(RECORDS_REQUEST.test('List the accounts behind certificates maturing in the next 90 days')).toBe(true);
    expect(RECORDS_REQUEST.test('Show delinquency 60+ by branch')).toBe(false);
    expect(RECORDS_REQUEST.test('Show my stalled applications')).toBe(false);
  });
});

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

describe.skipIf(!up)('records on the warehouse', () => {
  let pool: Pool;
  let svc: SemanticService;
  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    svc = await SemanticService.create(pool, 'test_cu', 'credit_union');
  });
  afterAll(async () => pool.end());

  it('reads the metric and filters from the words, using the catalog', () => {
    expect(parseRecordsRequest(svc, 'Show the loans behind delinquency 60+ for Eastgate')).toEqual({ metric: 'delinquency_ratio_60_plus', filters: [{ dimension: 'branch', values: ['Eastgate'] }] });
    expect(parseRecordsRequest(svc, 'Show the accounts behind certificates maturing in the next 90 days').metric).toBe('certificates_maturing_90_days');
    expect(parseRecordsRequest(svc, 'Show the loans behind total loan balance for auto loans at Westport').filters).toEqual(expect.arrayContaining([{ dimension: 'branch', values: ['Westport'] }, { dimension: 'loan_category', values: ['Auto'] }]));
  });

  it('adds up to the figure it explains', async () => {
    const r = await svc.records({ metric: 'delinquency_ratio_60_plus', filters: [{ dimension: 'branch', values: ['Eastgate'] }] }, {});
    const q = await svc.query({ metrics: ['delinquent_loan_balance'], filters: [{ dimension: 'branch', op: 'in', values: ['Eastgate'] }] }, { canViewSql: false });
    expect(r.kind).toBe('loans');
    expect(r.total).toBeCloseTo(Number(q.rows[0]!.delinquent_loan_balance), 0);
    expect(r.rows.every((x) => Number(x.days_past_due) >= 60)).toBe(true);
    expect(r.rows[0]!.member).toMatch(/^Member …\d{4}$/);
  });

  it('stays inside the purview, and names members only with member details', async () => {
    await expect(svc.records({ metric: 'loan_balance', filters: [{ dimension: 'branch', values: ['Eastgate'] }] }, { purviewBranches: ['Westport'] })).rejects.toThrow(/outside the branches you can see/);
    const mine = await svc.records({ metric: 'loan_balance', limit: 5 }, { purviewBranches: ['Westport'], memberDetails: true });
    expect(mine.rows.every((x) => x.branch === 'Westport')).toBe(true);
    expect(mine.rows[0]!.member).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \(…\d{4}\)$/);
  });

  it('runs as a module, and offers the drill on any block from such a metric', async () => {
    const spec = recordsModule(svc);
    const plan = spec.plan('Show the loans behind delinquency 60+ for Eastgate', {} as never);
    expect(plan).toEqual({ tool: 'rec_list', args: { metric: 'delinquency_ratio_60_plus', filters: [{ dimension: 'branch', values: ['Eastgate'] }], limit: 50 } });
    const out = (await spec.tools[0]!.run((plan as unknown as { args: never }).args, { user: { id: 'u', name: 'Dana Lee' }, modules: ['records', 'records-members'], runId: 'R-rec', threadId: 't' })) as { text: string };
    expect(out.text).toMatch(/^\*\*\d+ loans\*\* \(Eastgate\) make up delinquency ratio \(60\+ days\), \*\*\$/);
    const result = await svc.query({ metrics: ['delinquency_ratio_60_plus'], filters: [{ dimension: 'branch', op: 'in', values: ['Eastgate'] }] }, { canViewSql: false });
    expect(recordsAction(result, 'delinquency_ratio_60_plus', 'Delinquency ratio (60+ days)')).toEqual([{ id: 'records', kind: 'ask_followup', label: 'Show the loans behind it', params: { question: 'Show the loans behind delinquency ratio for Eastgate' } }]);
    const ratio = await svc.query({ metrics: ['net_worth_ratio'] }, { canViewSql: false });
    expect(recordsAction(ratio, 'net_worth_ratio', 'Net worth ratio')).toEqual([]);
  });
});
