// A third core, end to end, with no seed step on DI's side (Core Mapping and Ontology, phase 12),
// against a stand-in in yet another shape: PascalCase names, amounts in cents and rates in basis
// points (named as such), US-style text dates, product descriptions and a T/F member flag. Connecting
// it creates its raw zone from the core's own columns; DI proposes the mapping (checked against an
// answer key the engine never sees), freezes it on approval, pulls, reconciles, and fills the raw zone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, SourceService, compareWith, secretKeyFrom } from '@dinext/di-core';
import { unitOf } from '../../di-core/src/mappingEngine.ts';
import { createPool, rawDatabase, tenantPool, thirdCoreDatabase, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { coreMappingModule, crosswalkFrom, ModuleGateway, runModuleOffline, sourcesModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('reading a code the core writes in words', () => {
  it('takes a description of a few words, quoted or not, and still takes short codes', () => {
    expect(crosswalkFrom('Map loan type Visa Platinum to credit card')).toEqual({ set: 'loanType', code: 'Visa Platinum', value: 'credit card' });
    expect(crosswalkFrom('Map loan type “Business Term Loan” as business')).toEqual({ set: 'loanType', code: 'Business Term Loan', value: 'business' });
    expect(crosswalkFrom('Map share type 14 to money market')).toEqual({ set: 'shareType', code: '14', value: 'money market' });
    expect(unitOf('BalanceCents')).toBe('cents');
    expect(unitOf('rate_bps')).toBe('bps');
    expect(unitOf('DIVRATE')).toBeNull();
  });
});

const SCHEMA = 'dinext_t_test_cu';
const CORE = thirdCoreDatabase(SCHEMA);
const ADMIN_URL = process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307';
// The app's own login can't read the stand-in core (only core_reader can), so its presence is checked as the admin.
const probe = createPool(`${ADMIN_URL}/${SCHEMA}`);
const up = (await warehouseAvailable(SCHEMA)) && (await probe.query(`SELECT 1 FROM \`${CORE}\`.LoanAccount LIMIT 1`).then(() => true, () => false)) && (await tenantPool(SCHEMA).query('SELECT 1 FROM map_version LIMIT 1').then(() => true, () => false));
await probe.end();
const PAT = { id: 'user:test-corec', name: 'Pat Rivera', title: 'DI Administrator' };
/** What a person who knows this core would map: the test's own answer key, never shown to the engine. */
const ANSWER = (
  [
    ['cdm_party', 'party_id', 'Customer.CustomerId', 'number'], ['cdm_party', 'first_name', 'Customer.GivenName', 'same'], ['cdm_party', 'last_name', 'Customer.FamilyName', 'same'], ['cdm_party', 'birth_date', 'Customer.DateOfBirth', 'mdy'], ['cdm_party', 'join_date', 'Customer.CustomerSince', 'mdy'], ['cdm_party', 'primary_branch_id', 'Customer.HomeBranchId', 'number'], ['cdm_party', 'segment_code', 'Customer.CustomerType', 'code'], ['cdm_party', 'household_id', 'Customer.HouseholdId', 'number'], ['cdm_party', 'is_member', 'Customer.IsMember', 'flag'],
    ['cdm_deposit_account', 'account_id', 'DepositAccount.DepositAccountId', 'number'], ['cdm_deposit_account', 'party_id', 'DepositAccount.CustomerId', 'number'], ['cdm_deposit_account', 'branch_id', 'DepositAccount.BranchId', 'number'], ['cdm_deposit_account', 'deposit_category', 'DepositAccount.ProductDescription', 'code'], ['cdm_deposit_account', 'open_date', 'DepositAccount.OpenedOn', 'mdy'], ['cdm_deposit_account', 'close_date', 'DepositAccount.ClosedOn', 'mdy'], ['cdm_deposit_account', 'maturity_date', 'DepositAccount.MaturesOn', 'mdy'], ['cdm_deposit_account', 'balance', 'DepositAccount.BalanceCents', 'cents'], ['cdm_deposit_account', 'rate', 'DepositAccount.RateBps', 'bps'],
    ['cdm_loan', 'loan_id', 'LoanAccount.LoanAccountId', 'number'], ['cdm_loan', 'party_id', 'LoanAccount.CustomerId', 'number'], ['cdm_loan', 'branch_id', 'LoanAccount.BranchId', 'number'], ['cdm_loan', 'officer_id', 'LoanAccount.OfficerId', 'number'], ['cdm_loan', 'loan_category', 'LoanAccount.ProductDescription', 'code'], ['cdm_loan', 'is_indirect', 'LoanAccount.DealerId', 'nonzero'], ['cdm_loan', 'open_date', 'LoanAccount.OpenedOn', 'mdy'], ['cdm_loan', 'close_date', 'LoanAccount.ClosedOn', 'mdy'], ['cdm_loan', 'charge_off_date', 'LoanAccount.ChargedOffOn', 'mdy'], ['cdm_loan', 'original_amount', 'LoanAccount.OriginalAmountCents', 'cents'], ['cdm_loan', 'balance', 'LoanAccount.BalanceCents', 'cents'], ['cdm_loan', 'rate', 'LoanAccount.RateBps', 'bps'], ['cdm_loan', 'days_delinquent', 'LoanAccount.DaysPastDue', 'number'],
  ] as const
).map(([diTable, diColumn, core, transform]) => ({ diTable, diColumn, core, transform }));

describe.skipIf(!up)('a third core, end to end, with no seed step', () => {
  let pool: Pool;
  let admin: Pool;
  let approvals: ApprovalStore;
  let sources: SourceService;
  let gateway: ModuleGateway;
  let spec: ModuleSpec;
  let connectionId: number;
  const turn = (text: string, threadId: string): ModuleTurn => ({ runId: `R-${threadId}`, threadId, text, user: PAT, tenant: { name: 'Harborview' }, modules: ['sources', 'admin'] });
  const ask = async (text: string, threadId: string) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const out = await runModuleOffline(gateway.match(text) ?? spec, turn(text, threadId), { gateway }, sink);
    for (const b of blocks) expect(validateBlock(b).ok, JSON.stringify(validateBlock(b))).toBe(true);
    return { out, text: texts.join(' ') };
  };
  const approve = async (out: Awaited<ReturnType<typeof ask>>['out']) => {
    expect(out.approval, `an approval card: ${JSON.stringify(out).slice(0, 600)}`).toBeTruthy();
    const rec = out.approval!.record;
    const decided = await approvals.decide(rec.approvalId, { decision: 'approved', userId: PAT.id, payloadHash: rec.payloadHash });
    return JSON.stringify(await gateway.execute(decided, { user: PAT, modules: ['sources'], runId: 'R-corec-exec', threadId: `thr_corec_exec_${rec.approvalId}` }));
  };
  const rawTables = async () => (await admin.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1', [rawDatabase(SCHEMA, connectionId)]))[0] as { t: string }[];

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${ADMIN_URL}/${SCHEMA}`);
    approvals = new ApprovalStore(pool);
    sources = new SourceService(pool, { secretKey: secretKeyFrom(), allowedHosts: ['127.0.0.1'] });
    spec = coreMappingModule(sources, () => '2026-11-19');
    gateway = new ModuleGateway(approvals, [spec, sourcesModule(sources, () => '2026-11-19')]);
    const saved = await sources.saveLogin({ system: 'other', host: '127.0.0.1', port: 3307, database: CORE, login: 'core_reader', password: process.env.DI_CORE_READER_PASSWORD ?? 'core_reader_demo' }, { userId: PAT.id });
    connectionId = await sources.create({ credentialId: saved.credentialId, name: 'Core C test', schedule: 'Nightly at 2:00 am', tables: ['cdm_party', 'cdm_deposit_account', 'cdm_loan'] }, { userId: PAT.id, name: PAT.name }, { approvalId: 'apr_corec_connect', on: '2026-11-19' });
  });
  afterAll(async () => {
    for (const t of ['map_candidate', 'map_profile']) await admin.query(`DELETE FROM ${t} WHERE run_id IN (SELECT run_id FROM map_run WHERE run_by = ?)`, [PAT.id]);
    await admin.query('DELETE FROM map_run WHERE run_by = ?', [PAT.id]);
    const [mine] = (await admin.query('SELECT connection_id AS id FROM src_connection WHERE created_by = ?', [PAT.id])) as unknown as [{ id: number }[]];
    for (const t of ['map_drift', 'map_version', 'src_sync_run', 'src_mapping']) await admin.query(`DELETE FROM ${t} WHERE connection_id IN (SELECT connection_id FROM src_connection WHERE created_by = ?)`, [PAT.id]);
    await admin.query('DELETE FROM src_connection WHERE created_by = ?', [PAT.id]);
    await admin.query('DELETE FROM src_credential WHERE created_by = ?', [PAT.id]);
    for (const c of mine) await admin.query(`DROP DATABASE IF EXISTS \`${rawDatabase(SCHEMA, c.id)}\``);
    await pool.end();
    await admin.end();
  });

  it('creates the raw zone when the core is connected, from the core’s own columns', async () => {
    expect((await rawTables()).map((r) => r.t)).toEqual(['Customer', 'DepositAccount', 'LoanAccount', 'SystemInfo']);
    const [cols] = (await admin.query('SELECT COLUMN_NAME AS c, COLUMN_TYPE AS ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [rawDatabase(SCHEMA, connectionId), 'LoanAccount'])) as unknown as [{ c: string; ty: string }[]];
    expect(cols.find((c) => c.c === 'BalanceCents')?.ty).toBe('bigint');
    expect(cols.find((c) => c.c === 'OpenedOn')?.ty).toBe('varchar(10)');
  });

  it('proposes the mapping a person would make: cents, basis points and US dates read as such, and ties out', async () => {
    const r = await sources.discover({ connectionId, runBy: PAT.id });
    expect([...r.tableOf]).toEqual(expect.arrayContaining([['Customer', 'cdm_party'], ['DepositAccount', 'cdm_deposit_account'], ['LoanAccount', 'cdm_loan']]));
    const c = compareWith(r.proposals, ANSWER);
    console.log(JSON.stringify({ right: c.right, transformsRight: c.transformsRight, wrong: c.rows.filter((x) => !x.right || !x.transformRight).map((x) => [x.di, x.expected, x.proposed, r.proposals.find((p) => `${p.diTable}.${p.diColumn}` === x.di)?.transform]), ties: r.ties, crosswalks: r.crosswalks.map((x) => [x.diColumn, x.codes.map((y) => [y.code, y.value])]) }, null, 1));
    expect(c.rows.filter((x) => !x.right).map((x) => x.di)).toEqual([]);
    expect(c.transformsRight).toBe(31);
    for (const prop of ['loan.balance', 'deposit.balance', 'member.id']) expect(r.ties.find((t) => t.property === prop && t.pass), prop).toBeTruthy();
    const cw = (col: string) => Object.fromEntries(r.crosswalks.find((x) => x.diColumn === col)!.codes.map((x) => [x.code, x.value]));
    expect(cw('deposit_category')).toEqual({ 'Regular Share Savings': 'Share Savings', 'Share Draft Checking': 'Checking', 'Money Market Share': 'Money Market', 'Share Certificate': 'Certificates', 'Traditional IRA': 'IRA' });
    expect(cw('loan_category')).toMatchObject({ 'Auto Loan': 'Auto', 'First Mortgage': 'Mortgage', 'Home Equity Line': 'HELOC', 'Visa Platinum': null, 'Signature Loan': null });
  }, 180_000);

  it('freezes the proposals on approval, pulls in dollars and percents, holds what it can’t read, and fills the raw zone', async () => {
    const done = await approve((await ask('Freeze the proposed mapping for the Core C test connection', 'thr_corec2')).out);
    expect(done).toContain('mapping version 1');
    const p = await sources.pull(connectionId, { approvalId: 'apr_corec_pull1' });
    expect(p.version).toBe(1);
    const recon = Object.fromEntries(p.tables.map((t) => [t.diTable, t]));
    // Cents, basis points and US dates read right: every share matches DI row for row.
    expect(recon.cdm_deposit_account).toMatchObject({ pulled: 100_158, matched: 100_158, differ: 0 });
    const held = Object.fromEntries((p.held ?? []).map((h) => [h.code, h]));
    console.log(JSON.stringify(Object.values(held).map((h) => [h.code, h.count, h.proposal?.options])));
    expect(Object.keys(held)).toEqual(expect.arrayContaining(['Visa Platinum', 'Signature Loan']));
    expect(recon.cdm_loan!.differ).toBe(Object.values(held).filter((h) => h.diTable === 'cdm_loan').reduce((s, h) => s + h.count, 0));
    // The raw zone has the core's tables as they came: cents and US dates, untouched.
    expect(p.rawZone).toBe(rawDatabase(SCHEMA, connectionId));
    expect(p.raw?.map((x) => x.table).sort()).toEqual(['Customer', 'DepositAccount', 'LoanAccount']);
    const [[raw]] = (await admin.query(`SELECT COUNT(*) AS n, SUM(BalanceCents) AS cents FROM \`${p.rawZone}\`.DepositAccount`)) as unknown as [{ n: number; cents: string }[]];
    expect(Number(raw!.n)).toBe(100_158);
    const [[dollars]] = (await admin.query('SELECT ROUND(SUM(balance) * 100) AS c FROM cdm_deposit_account')) as unknown as [{ c: string }[]];
    expect(Number(raw!.cents)).toBe(Number(dollars!.c));
  }, 240_000);

  it('maps the held loan codes, named as the core writes them, and the next pull reconciles every loan', async () => {
    let version = 1;
    const held = (await sources.pull(connectionId, { approvalId: 'apr_corec_pull1' })).held ?? [];
    for (const [code, value] of [['Visa Platinum', 'credit card'], ['Signature Loan', 'personal'], ['Business Term Loan', 'business']] as const) {
      if (!held.some((h) => h.code === code)) continue;
      expect(await approve((await ask(`Map loan type ${code.toLowerCase()} to ${value}`, `thr_corec_${code.replace(/\W/g, '')}`)).out)).toContain(`mapping version ${++version}`);
    }
    const p = await sources.pull(connectionId, { approvalId: 'apr_corec_pull2' });
    expect(p.version).toBe(version);
    expect(p.tables.find((t) => t.diTable === 'cdm_loan')).toMatchObject({ pulled: 31_817, matched: 31_817, differ: 0 });
    expect((p.held ?? []).filter((h) => h.diTable === 'cdm_loan')).toEqual([]);
  }, 240_000);
});
