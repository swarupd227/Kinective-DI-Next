// @vitest-environment node
// Off-core loans: a servicer's spreadsheet of loans the core doesn't carry is matched to DI's loan
// fields, checked row by row, and on approval joins every loan figure, tagged by its source. Next
// month's file replaces it; the core's rows are never touched, and the application account can't
// change curated loans at all.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, FileStore, IngestService, OffcoreService, categoryFor, feedNameFrom, matchColumns, monthFromName } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { AS_OF, buildDbUrl, createPool, offcoreDemoRows, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, buildBriefing, dataLoadModule, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const BRANCHES = ['Westport', 'Northgate', 'Riverside', 'Lakeshore', 'Downtown', 'Eastgate'];
const csv = (headers: string[], rows: (string | number | null)[][]) => [headers, ...rows].map((r) => r.map((v) => (v === null ? '' : /[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\n');

describe('reading a servicer’s spreadsheet', () => {
  it('matches each DI loan field to a column, and keeps borrower names out', () => {
    const demo = offcoreDemoRows(BRANCHES);
    const { columns, ignored } = matchColumns(demo.headers);
    const at = (f: string) => columns.find((c) => c.field === f)!.header;
    expect([at('ref'), at('balance'), at('type'), at('rate'), at('dpd'), at('open'), at('maturity'), at('score'), at('ltv'), at('rating'), at('branch'), at('asOf')]).toEqual(['Loan Number', 'Current Balance', 'Loan Type', 'Interest Rate', 'Days Past Due', 'Origination Date', 'Maturity Date', 'FICO', 'LTV', 'Risk Grade', 'Branch', 'As Of Date']);
    expect(ignored[0]).toMatchObject({ header: 'Borrower' });
  });

  it('places loan types in each institution’s categories', () => {
    const cu = ['Auto', 'Business', 'Credit Card', 'HELOC', 'Mortgage', 'Personal'];
    const bank = ['Auto', 'Commercial & Industrial', 'Commercial Real Estate', 'Consumer', 'Mortgage'];
    expect(categoryFor('CRE Participation', 'credit_union', cu)).toMatchObject({ category: 'Business' });
    expect(categoryFor('CRE Participation', 'bank', bank)).toMatchObject({ category: 'Commercial Real Estate' });
    expect(categoryFor('Indirect Auto Pool', 'credit_union', cu)).toMatchObject({ category: 'Auto', indirect: true });
    expect(categoryFor('Solar Loan', 'bank', bank)).toMatchObject({ category: 'Consumer' });
    expect(categoryFor('Taxi medallion', 'credit_union', cu)).toBeNull();
    expect(categoryFor('Taxi medallion', 'credit_union', cu, { 'taxi medallion': 'business' })).toMatchObject({ category: 'Business', how: 'said' });
  });

  it('names the spreadsheet without its month, and reads the month from the name', () => {
    expect(feedNameFrom('Participations and purchased loans October 2026.xlsx')).toBe('Participations and purchased loans');
    expect(monthFromName('Participations and purchased loans October 2026.xlsx')).toBe('2026-10-31');
    expect(monthFromName('pool_2026-09.csv')).toBe('2026-09-30');
  });
});

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT source FROM cdm_loan LIMIT 1').then(() => true, () => false));

describe.skipIf(!up)('off-core loans against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let build: Pool;
  let svc: OffcoreService;
  let files: FileStore;
  let approvals: ApprovalStore;
  let gateway: ModuleGateway;
  let dl: ModuleSpec;
  const SAM = { id: 'user:1002', name: 'Sam Taylor', title: 'DI Administrator' };
  const NAME = 'Participations and purchased loans October 2026.csv';
  const turn = (text: string): ModuleTurn => ({ runId: 'R-offcore', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: SAM, tenant: { name: 'Harborview Federal Credit Union' }, modules: ['files', 'tables', 'dataload'] });
  const run = async (t: ModuleTurn) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const out = await runModuleOffline(dl, t, { gateway }, sink);
    return { text: texts.join(' '), blocks, out, t };
  };
  const approve = async (o: Awaited<ReturnType<typeof run>>) => {
    const a = await approvals.decide(o.out.approval!.record.approvalId, { decision: 'approved', userId: SAM.id, payloadHash: o.out.approval!.record.payloadHash });
    return gateway.execute(a, { user: SAM, modules: o.t.modules, runId: o.t.runId, threadId: o.t.threadId });
  };
  const stage = (name: string, body: string) => files.stage({ name, body: Buffer.from(body), owner: { userId: SAM.id, name: SAM.name }, on: '2026-10-25' });
  const clear = async () => {
    await build.query("DELETE FROM cdm_loan WHERE source LIKE 'Off-core:%'");
    for (const t of ['ofc_loan', 'ofc_load', 'ofc_feed']) await admin.query(`DELETE FROM ${t}`);
    await admin.query("DELETE FROM fil_file WHERE name LIKE 'Participations and purchased loans%'");
  };
  const total = async () => {
    const [r] = (await admin.query("SELECT SUM(balance) AS b, SUM(source IS NULL) AS core FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL")) as unknown as [{ b: number; core: number }[]];
    return { balance: Number(r[0]!.b), core: Number(r[0]!.core) };
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    build = createPool(`${buildDbUrl()}/${SCHEMA}`);
    svc = new OffcoreService(pool, 'credit_union', () => build, AS_OF);
    files = new FileStore(pool);
    approvals = new ApprovalStore(pool);
    dl = dataLoadModule(files, new IngestService(pool, null), () => '2026-10-25', svc);
    gateway = new ModuleGateway(approvals, [dl]);
    await clear();
  });
  afterAll(async () => {
    await clear();
    await Promise.all([pool.end(), admin.end(), build.end()]);
  });

  it('routes off-core requests to Data Load', () => {
    expect(gateway.match(`Load “${NAME}” as off-core loans`)?.id).toBe('dataload');
    expect(gateway.match('Show the off-core loans')?.id).toBe('dataload');
  });

  it('checks the file: what maps, what loads and what won’t, changing nothing', async () => {
    const demo = offcoreDemoRows(BRANCHES);
    await stage(NAME, csv(demo.headers, demo.rows));
    const before = await total();
    const r = await run(turn(`Check “${NAME}” as off-core loans`));
    expect(r.out.approval).toBeUndefined();
    expect(r.text).toMatch(/38 loans can load/);
    expect(r.text).toMatch(/The same row appears twice/i);
    expect(r.text).toMatch(/no balance/);
    expect(r.text).toMatch(/no interest rate/);
    for (const b of r.blocks) expect(validateBlock(b).ok).toBe(true);
    expect(await total()).toEqual(before);
  });

  it('loads on a high-risk approval into every loan figure, tagged by source, and leaves the core alone', async () => {
    const semantic = await SemanticService.create(pool, 'test_cu', 'credit_union');
    const before = await total();
    const plan = await svc.prepare(NAME, { headers: offcoreDemoRows(BRANCHES).headers, rows: offcoreDemoRows(BRANCHES).rows, hasHeader: true });
    const card = await run(turn(`Load “${NAME}” as off-core loans`));
    expect(card.out.approval?.record.riskTier).toBe('high');
    expect(card.text).toMatch(/Call Report comes from the general ledger/);
    await approve(card);
    const after = await total();
    expect(after.core).toBe(before.core);
    expect(after.balance).toBeCloseTo(before.balance + plan.balance, 0);
    const q = await semantic.query({ metrics: ['loan_balance'], dimensions: ['loan_source'] }, { canViewSql: false });
    const off = q.rows.find((x) => String(x.loan_source).startsWith('Off-core'));
    expect(off?.loan_source).toBe('Off-core: Participations and purchased loans');
    expect(Number(off?.loan_balance)).toBeCloseTo(plan.balance, 0);
    // The CRE participation 97 days past due is in reportable delinquency now.
    const [dq] = (await admin.query("SELECT SUM(balance) AS b FROM cdm_loan WHERE source LIKE 'Off-core:%' AND days_delinquent >= 60")) as unknown as [{ b: number }[]];
    expect(Number(dq[0]!.b)).toBeGreaterThan(1_000_000);
    // Home compares core with core against last month-end, and says so.
    const brief = await buildBriefing(semantic, { canViewSql: false });
    expect(brief.kpis.data.items[0]!.comparison?.label).toMatch(/core loans/);
    expect(brief.narrative).toMatch(/of off-core loans; core loans are/);
  });

  it('replaces last month’s load with the next file, keeping each loan’s DI number', async () => {
    const [ids] = (await admin.query("SELECT loan_id FROM cdm_loan WHERE source LIKE 'Off-core:%' ORDER BY loan_id")) as unknown as [{ loan_id: number }[]];
    const demo = offcoreDemoRows(BRANCHES);
    // November: one auto loan paid off, everything else the same.
    const nov = demo.rows.filter((r) => r[0] !== 'IAP-50315').map((r) => r.map((v, i) => (i === 14 ? '2026-11-30' : v)));
    const name = 'Participations and purchased loans November 2026.csv';
    await stage(name, csv(demo.headers, nov));
    const card = await run(turn(`Load “${name}” as off-core loans`));
    expect(card.text).toMatch(/replacing the 2026-10-31 load/);
    await approve(card);
    const [now] = (await admin.query("SELECT loan_id FROM cdm_loan WHERE source LIKE 'Off-core:%' ORDER BY loan_id")) as unknown as [{ loan_id: number }[]];
    expect(now.length).toBe(ids.length - 1);
    expect(now.every((x) => ids.some((y) => y.loan_id === x.loan_id))).toBe(true);
    expect((await svc.feeds())[0]).toMatchObject({ loans: 37, asOf: '2026-11-30' });
  });

  it('won’t place a loan type it doesn’t know until told, and the application account can’t change loans', async () => {
    const demo = offcoreDemoRows(BRANCHES);
    const rows = demo.rows.map((r, i) => (i === 0 ? r.map((v, j) => (j === 2 ? 'Taxi medallion' : v)) : r));
    const name = 'Participations and purchased loans December 2026.csv';
    await stage(name, csv(demo.headers, rows));
    const blocked = await run(turn(`Load “${name}” as off-core loans`));
    expect(blocked.out.approval).toBeUndefined();
    expect(blocked.text).toMatch(/can’t tell which of your loan categories “Taxi medallion” is/);
    const told = await run(turn(`Load “${name}” as off-core loans, and treat Taxi medallion as Business`));
    expect(told.out.approval).toBeTruthy();
    await expect(pool.query("DELETE FROM cdm_loan WHERE source LIKE 'Off-core:%'")).rejects.toThrow(/denied/i);
  });
});
