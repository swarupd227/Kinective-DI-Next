// Proposing a core's mapping (Core Mapping and Ontology, phase 2). The name splitter and the value
// reading on their own, then the whole run against the Symitar-style replica with Kinective's mapping
// hidden: every DI column it maps is matched, read the same way, and the totals tie out to the 5300.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, SourceService, Vocabulary, kindOf, secretKeyFrom, type CoreColumnProfile as ColumnProfile } from '@dinext/di-core';
import { ontology } from '@dinext/ontology';
import { createPool, rawDatabase, replicaDatabase, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { coreMappingModule, DISCOVER_REQUEST, ModuleGateway, runModuleOffline, sourcesModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('reading a core’s names and values', () => {
  const v = new Vocabulary(ontology());
  it('splits names into words and expands abbreviations', () => {
    expect(v.split('DIVRATE')).toEqual(['dividend', 'rate']);
    expect(v.split('CHARGEOFFDATE')).toEqual(['charge', 'off', 'date']);
    expect(v.split('ORIGINALBALANCE')).toEqual(['original', 'balance']);
    expect(v.split('NONMEMBER')).toEqual(['non', 'member']);
    expect(v.split('HOUSEHOLDACCOUNT')).toEqual(['household', 'account']);
    expect(v.split('acct_open_dt')).toEqual(['account', 'open', 'date']);
  });

  it('tells dates, rates in thousandths, money, flags, codes and keys apart', () => {
    const base: ColumnProfile = { table: 'T', column: 'C', dataType: 'char', rows: 1000, filled: 1000, distinct: 500, min: null, max: null, dateShare: 0, numericShare: 0, fractionShare: 0, flagShare: 0, avg: null, top: [] };
    expect(kindOf({ ...base, dateShare: 0.99 })).toBe('date');
    expect(kindOf({ ...base, numericShare: 1, distinct: 1681, min: '3100', max: '19900', avg: 9871 })).toBe('rate1000');
    expect(kindOf({ ...base, numericShare: 1, distinct: 13, min: '1', max: '502', avg: 226 })).toBe('code');
    expect(kindOf({ ...base, numericShare: 1, fractionShare: 0.9 })).toBe('money');
    expect(kindOf({ ...base, numericShare: 1, flagShare: 1, distinct: 2 })).toBe('flag');
    expect(kindOf({ ...base, numericShare: 1, distinct: 1000 })).toBe('key');
    expect(kindOf({ ...base, filled: 0 })).toBe('empty');
  });

  it('recognizes requests to propose, review and explain a mapping', () => {
    for (const q of ['Map our core connection', 'Propose a mapping for the Symitar connection', 'How well would DI map Symitar without its standard mapping?', 'Which mappings need me?', 'Why did you map LOAN.DUEDATE to days past due?']) expect(DISCOVER_REQUEST.test(q), q).toBe(true);
    for (const q of ['Show the Symitar mapping', 'Map FIRST_OF(ACCOUNTTRACKING, USERCHAR1, PARENTACCOUNT = a.ACCOUNTNUMBER AND TYPE = 12) to email consent as a yes or no', 'Plan visits for my top five dealers on a map']) expect(DISCOVER_REQUEST.test(q), q).toBe(false);
  });
});

const SCHEMA = 'dinext_t_test_cu';
const up = (await warehouseAvailable(SCHEMA)) && (await tenantPool(SCHEMA).query('SELECT 1 FROM map_run LIMIT 1').then(() => true, () => false));
const SAM = { id: 'user:test-discover', name: 'Sam Taylor', title: 'DI Administrator' };
const ADMIN_URL = process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307';

describe.skipIf(!up)('proposing the Symitar mapping from the replica', () => {
  let pool: Pool;
  let admin: Pool;
  let sources: SourceService;
  let gateway: ModuleGateway;
  let spec: ModuleSpec;
  const turn = (text: string, threadId: string): ModuleTurn => ({ runId: `R-${threadId}`, threadId, text, user: SAM, tenant: { name: 'Harborview' }, modules: ['sources', 'admin'] });
  const ask = async (text: string, threadId: string) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    await runModuleOffline(gateway.match(text) ?? spec, turn(text, threadId), { gateway }, sink);
    for (const b of blocks) expect(validateBlock(b).ok, JSON.stringify(validateBlock(b))).toBe(true);
    return { text: texts.join(' '), blocks };
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${ADMIN_URL}/${SCHEMA}`);
    sources = new SourceService(pool, { secretKey: secretKeyFrom(), allowedHosts: ['127.0.0.1'] });
    spec = coreMappingModule(sources, () => '2026-11-17');
    gateway = new ModuleGateway(new ApprovalStore(pool), [spec, sourcesModule(sources, () => '2026-11-17')]);
    const saved = await sources.saveLogin({ system: 'symitar', host: '127.0.0.1', port: 3307, database: replicaDatabase(SCHEMA), login: 'core_reader', password: process.env.DI_CORE_READER_PASSWORD ?? 'core_reader_demo' }, { userId: SAM.id });
    await sources.create({ credentialId: saved.credentialId, name: 'Discover test replica', schedule: 'Nightly at 2:00 am', tables: ['cdm_party', 'cdm_deposit_account', 'cdm_loan'] }, { userId: SAM.id, name: SAM.name }, { approvalId: 'apr_discover_connect', on: '2026-11-17' });
  });
  afterAll(async () => {
    await admin.query('DELETE FROM map_candidate WHERE run_id IN (SELECT run_id FROM map_run WHERE run_by = ?)', [SAM.id]);
    await admin.query('DELETE FROM map_profile WHERE run_id IN (SELECT run_id FROM map_run WHERE run_by = ?)', [SAM.id]);
    await admin.query('DELETE FROM map_run WHERE run_by = ?', [SAM.id]);
    const [ids] = (await admin.query('SELECT connection_id FROM src_connection WHERE created_by = ?', [SAM.id])) as unknown as [{ connection_id: number }[]];
    for (const { connection_id: id } of ids) await admin.query('DELETE FROM src_mapping WHERE connection_id = ?', [id]);
    // Each connection's raw zone (phase 12) goes with it.
    const [made] = (await admin.query('SELECT connection_id AS id FROM src_connection WHERE created_by = ?', [SAM.id])) as unknown as [{ id: number }[]];
    for (const m of made) await admin.query(`DROP DATABASE IF EXISTS \`${rawDatabase(SCHEMA, m.id)}\``);
    await admin.query('DELETE FROM src_connection WHERE created_by = ?', [SAM.id]);
    await admin.query('DELETE FROM src_credential WHERE created_by = ?', [SAM.id]);
    await pool.end();
    await admin.end();
  });

  it('matches Kinective’s mapping on every column with it hidden, names only, and ties out', async () => {
    const r = await sources.discover({ hideStandard: true, descriptions: false, runBy: SAM.id });
    expect([...r.tableOf]).toEqual(expect.arrayContaining([['ACCOUNT', 'cdm_party'], ['SAVINGS', 'cdm_deposit_account'], ['LOAN', 'cdm_loan']]));
    expect(r.owner.get('NAME')).toBe('ACCOUNT');
    expect(r.comparison!.rows.filter((x) => !x.right)).toEqual([]);
    expect(r.comparison!.transformsRight).toBe(r.comparison!.total);
    expect(r.comparison!.total).toBe(31);
    for (const prop of ['loan.balance', 'deposit.balance', 'member.id']) expect(r.ties.find((t) => t.property === prop && t.pass), prop).toBeTruthy();
    // The two totals that tie out are ready to approve; nothing is applied.
    expect(r.proposals.filter((p) => p.band === 'auto').map((p) => `${p.coreTable}.${p.coreColumn}`).sort()).toEqual(['LOAN.BALANCE', 'SAVINGS.BALANCE']);
    expect(r.proposals.find((p) => p.coreColumn === 'DUEDATE')).toMatchObject({ diColumn: 'days_delinquent', transform: 'daysPast' });
    expect(r.proposals.find((p) => p.coreColumn === 'NONMEMBER')).toMatchObject({ diColumn: 'is_member', transform: 'not' });
    expect(r.proposals.find((p) => p.coreTable === 'LOAN' && p.coreColumn === 'INTERESTRATE')).toMatchObject({ transform: 'rate1000' });
  }, 120_000);

  it('with Kinective’s mapping in view, marks its columns as standard', async () => {
    const r = await sources.discover({ runBy: SAM.id });
    expect(r.bands.standard).toBe(31);
    expect(r.unmatched).toEqual(expect.arrayContaining(['ACCOUNTTRACKING.USERCHAR1']));
  }, 120_000);

  it('answers through the Core Mapping agent: measure, review and explain', async () => {
    expect(gateway.match('Map our core connection')?.prefix).toBe('map');
    const m = await ask('How well would DI map Symitar without its standard mapping?', 'thr_disc1');
    expect(m.text).toContain('**31 of 31 columns**');
    expect(m.text).toContain('Tie-outs to the 5300');
    const rv = await ask('Which mappings need me?', 'thr_disc2');
    expect(rv.text).toMatch(/proposals? needs? you/);
    const ex = await ask('Why did you map LOAN.DUEDATE?', 'thr_disc3');
    expect(ex.text).toContain('**LOAN.DUEDATE → cdm_loan.days_delinquent**');
    expect(ex.text).toContain('it can be derived (daysPast)');
  }, 180_000);
});
