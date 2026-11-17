// A second core with no standard mapping (Core Mapping and Ontology, phase 4), against the stand-in
// built in another shape: members in person; shares and loans together in acct, told apart by
// acct_class; DATE columns, percent rates, text codes and a Y/N flag. DI proposes the mapping (checked
// here against an answer key the engine never sees), reads the codes it can, freezes the proposals on
// approval, pulls, holds the codes it can't read with DI's unused types as options, and maps them
// once someone says what they are.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, SourceService, compareWith, secretKeyFrom } from '@dinext/di-core';
import { createPool, secondCoreDatabase, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { coreMappingModule, crosswalkFrom, DISCOVER_REQUEST, ModuleGateway, runModuleOffline, sourcesModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('reading second-core requests', () => {
  it('takes text codes and a named connection', () => {
    expect(crosswalkFrom('Map loan type VISA to credit card')).toEqual({ set: 'loanType', code: 'VISA', value: 'credit card' });
    expect(crosswalkFrom('Map member type SEN to senior')).toEqual({ set: 'memberType', code: 'SEN', value: 'senior' });
    expect(DISCOVER_REQUEST.test('Map the Core B stand-in connection')).toBe(true);
  });
});

const SCHEMA = 'dinext_t_test_cu';
const CORE = secondCoreDatabase(SCHEMA);
const ADMIN_URL = process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307';
// The app's own login can't read the stand-in core (only core_reader can), so its presence is checked as the admin.
const probe = createPool(`${ADMIN_URL}/${SCHEMA}`);
const up = (await warehouseAvailable(SCHEMA)) && (await probe.query(`SELECT 1 FROM \`${CORE}\`.acct LIMIT 1`).then(() => true, () => false)) && (await tenantPool(SCHEMA).query('SELECT 1 FROM map_version LIMIT 1').then(() => true, () => false));
await probe.end();
const SAM = { id: 'user:test-coreb', name: 'Sam Taylor', title: 'DI Administrator' };
const DP = 'acct[acct_class=DP]';
const LN = 'acct[acct_class=LN]';
/** What a person who knows this core would map: the test's own answer key, never shown to the engine. */
const ANSWER = (
  [
    ['cdm_party', 'party_id', 'person.pers_nbr', 'number'], ['cdm_party', 'first_name', 'person.first_nm', 'same'], ['cdm_party', 'last_name', 'person.last_nm', 'same'], ['cdm_party', 'birth_date', 'person.birth_dt', 'same'], ['cdm_party', 'join_date', 'person.mbr_since_dt', 'same'], ['cdm_party', 'primary_branch_id', 'person.home_brch_nbr', 'number'], ['cdm_party', 'segment_code', 'person.mbr_type_cd', 'code'], ['cdm_party', 'household_id', 'person.hhld_pers_nbr', 'number'], ['cdm_party', 'is_member', 'person.nonmbr_yn', 'not'],
    ['cdm_deposit_account', 'account_id', `${DP}.acct_nbr`, 'number'], ['cdm_deposit_account', 'party_id', `${DP}.pers_nbr`, 'number'], ['cdm_deposit_account', 'branch_id', `${DP}.brch_nbr`, 'number'], ['cdm_deposit_account', 'deposit_category', `${DP}.prod_cd`, 'code'], ['cdm_deposit_account', 'open_date', `${DP}.open_dt`, 'same'], ['cdm_deposit_account', 'close_date', `${DP}.close_dt`, 'same'], ['cdm_deposit_account', 'maturity_date', `${DP}.mat_dt`, 'same'], ['cdm_deposit_account', 'balance', `${DP}.cur_bal`, 'number'], ['cdm_deposit_account', 'rate', `${DP}.int_rate`, 'number'],
    ['cdm_loan', 'loan_id', `${LN}.acct_nbr`, 'number'], ['cdm_loan', 'party_id', `${LN}.pers_nbr`, 'number'], ['cdm_loan', 'branch_id', `${LN}.brch_nbr`, 'number'], ['cdm_loan', 'officer_id', `${LN}.ofcr_nbr`, 'number'], ['cdm_loan', 'loan_category', `${LN}.prod_cd`, 'code'], ['cdm_loan', 'is_indirect', `${LN}.dlr_nbr`, 'nonzero'], ['cdm_loan', 'open_date', `${LN}.open_dt`, 'same'], ['cdm_loan', 'close_date', `${LN}.close_dt`, 'same'], ['cdm_loan', 'charge_off_date', `${LN}.chgoff_dt`, 'same'], ['cdm_loan', 'original_amount', `${LN}.orig_bal`, 'number'], ['cdm_loan', 'balance', `${LN}.cur_bal`, 'number'], ['cdm_loan', 'rate', `${LN}.int_rate`, 'number'], ['cdm_loan', 'days_delinquent', `${LN}.days_dlq`, 'number'],
  ] as const
).map(([diTable, diColumn, core, transform]) => ({ diTable, diColumn, core, transform }));

describe.skipIf(!up)('mapping a core Kinective hasn’t mapped', () => {
  let pool: Pool;
  let admin: Pool;
  let approvals: ApprovalStore;
  let sources: SourceService;
  let gateway: ModuleGateway;
  let spec: ModuleSpec;
  let connectionId: number;
  const turn = (text: string, threadId: string): ModuleTurn => ({ runId: `R-${threadId}`, threadId, text, user: SAM, tenant: { name: 'Harborview' }, modules: ['sources', 'admin'] });
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
    const decided = await approvals.decide(rec.approvalId, { decision: 'approved', userId: SAM.id, payloadHash: rec.payloadHash });
    return JSON.stringify(await gateway.execute(decided, { user: SAM, modules: ['sources'], runId: 'R-coreb-exec', threadId: `thr_coreb_exec_${rec.approvalId}` }));
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${ADMIN_URL}/${SCHEMA}`);
    approvals = new ApprovalStore(pool);
    sources = new SourceService(pool, { secretKey: secretKeyFrom(), allowedHosts: ['127.0.0.1'] });
    spec = coreMappingModule(sources, () => '2026-11-17');
    gateway = new ModuleGateway(approvals, [spec, sourcesModule(sources, () => '2026-11-17')]);
    const saved = await sources.saveLogin({ system: 'other', host: '127.0.0.1', port: 3307, database: CORE, login: 'core_reader', password: process.env.DI_CORE_READER_PASSWORD ?? 'core_reader_demo' }, { userId: SAM.id });
    connectionId = await sources.create({ credentialId: saved.credentialId, name: 'Core B test', schedule: 'Nightly at 2:00 am', tables: ['cdm_party', 'cdm_deposit_account', 'cdm_loan'] }, { userId: SAM.id, name: SAM.name }, { approvalId: 'apr_coreb_connect', on: '2026-11-17' });
  });
  afterAll(async () => {
    for (const t of ['map_candidate', 'map_profile']) await admin.query(`DELETE FROM ${t} WHERE run_id IN (SELECT run_id FROM map_run WHERE run_by = ?)`, [SAM.id]);
    await admin.query('DELETE FROM map_run WHERE run_by = ?', [SAM.id]);
    for (const t of ['map_drift', 'map_version', 'src_sync_run', 'src_mapping']) await admin.query(`DELETE FROM ${t} WHERE connection_id IN (SELECT connection_id FROM src_connection WHERE created_by = ?)`, [SAM.id]);
    await admin.query('DELETE FROM src_connection WHERE created_by = ?', [SAM.id]);
    await admin.query('DELETE FROM src_credential WHERE created_by = ?', [SAM.id]);
    await pool.end();
    await admin.end();
  });

  it('proposes the mapping a person would make, splitting the shared table, and ties out', async () => {
    const r = await sources.discover({ connectionId, runBy: SAM.id });
    expect([...r.tableOf]).toEqual(expect.arrayContaining([['person', 'cdm_party'], [DP, 'cdm_deposit_account'], [LN, 'cdm_loan']]));
    const c = compareWith(r.proposals, ANSWER);
    expect(c.rows.filter((x) => !x.right).map((x) => x.di)).toEqual([]);
    expect(c.transformsRight).toBe(31);
    for (const prop of ['loan.balance', 'deposit.balance']) expect(r.ties.find((t) => t.property === prop && t.pass), prop).toBeTruthy();
    const cw = (col: string) => Object.fromEntries(r.crosswalks.find((x) => x.diColumn === col)!.codes.map((x) => [x.code, x.value]));
    expect(cw('deposit_category')).toEqual({ SAV: 'Share Savings', CHK: 'Checking', MMA: 'Money Market', CD: 'Certificates', IRA: 'IRA' });
    expect(cw('loan_category')).toMatchObject({ AUTO: 'Auto', MTG: 'Mortgage', HELOC: 'HELOC', BUS: 'Business', VISA: null, UNSEC: null });
    expect(cw('segment_code')).toMatchObject({ YA: 'Young Adult', SMB: 'Small Business', RET: null, SEN: null });
  }, 180_000);

  it('freezes the proposals on approval, and the pull reconciles what it can read and holds the rest', async () => {
    const said = await ask('Map the Core B test connection', 'thr_coreb1');
    expect(said.text).toContain('Code lists');
    expect(said.text).toContain('VISA');
    const done = await approve((await ask('Freeze the proposed mapping', 'thr_coreb2')).out);
    expect(done).toContain('mapping version 1');
    const p = await sources.pull(connectionId, { approvalId: 'apr_coreb_pull1' });
    expect(p.version).toBe(1);
    const recon = Object.fromEntries(p.tables.map((t) => [t.diTable, t]));
    expect(recon.cdm_deposit_account).toMatchObject({ pulled: 100_158, matched: 100_158, differ: 0 });
    const held = Object.fromEntries((p.held ?? []).map((h) => [h.code, h]));
    expect(Object.keys(held).sort()).toEqual(['RET', 'SEN', 'UNSEC', 'VISA']);
    expect(recon.cdm_loan!.differ).toBe(held.VISA!.count + held.UNSEC!.count);
    // Nothing the core already uses looks like a credit card, so DI offers its unused types instead of a wrong guess.
    expect(held.VISA!.proposal).toMatchObject({ close: false });
    expect(held.VISA!.proposal!.options).toEqual(expect.arrayContaining(['Credit Card', 'Personal']));
    expect(held.SEN!.proposal!.options).toEqual(expect.arrayContaining(['Senior', 'Retail']));
    expect(p.raw?.map((x) => x.table).sort()).toEqual(['acct', 'person']);
  }, 240_000);

  it('maps the held loan codes on approval, and the next pull reconciles every loan', async () => {
    expect(await approve((await ask('Map loan type VISA to credit card', 'thr_coreb3')).out)).toContain('mapping version 2');
    expect(await approve((await ask('Map loan type UNSEC to personal', 'thr_coreb4')).out)).toContain('mapping version 3');
    const p = await sources.pull(connectionId, { approvalId: 'apr_coreb_pull2' });
    expect(p.version).toBe(3);
    expect(p.tables.find((t) => t.diTable === 'cdm_loan')).toMatchObject({ pulled: 31_817, matched: 31_817, differ: 0 });
    expect((p.held ?? []).map((h) => h.code).sort()).toEqual(['RET', 'SEN']);
  }, 240_000);
});
