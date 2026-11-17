// Mapping versions and drift (Core Mapping and Ontology, phase 3), against the Symitar-style replica.
// A new share type appears in the core: the pull holds its rows instead of landing a wrong name, says
// which known type they look like, and records the drift; an approved crosswalk change becomes
// mapping version 2, and the next pull maps the rows. A new column is reported, and the raw zone
// keeps the core's tables as they came. The replica is put back afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, SourceService, secretKeyFrom } from '@dinext/di-core';
import { createPool, replicaDatabase, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { coreMappingModule, crosswalkFrom, ModuleGateway, runModuleOffline, sourcesModule, VERSION_REQUEST, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

describe('reading crosswalk and drift requests', () => {
  it('takes the code list, the code and the value', () => {
    expect(crosswalkFrom('Map share type 14 to money market')).toEqual({ set: 'shareType', code: '14', value: 'money market' });
    expect(crosswalkFrom('Map loan type 75 as a business loan.')).toEqual({ set: 'loanType', code: '75', value: 'business loan' });
    expect(crosswalkFrom('Map our core connection')).toBeNull();
    for (const q of ['Show the mapping versions', 'What changed in the core?', 'Any held rows?', 'Map share type 14 to money market']) expect(VERSION_REQUEST.test(q), q).toBe(true);
  });
});

const SCHEMA = 'dinext_t_test_cu';
const REPLICA = replicaDatabase(SCHEMA);
const up = (await warehouseAvailable(SCHEMA)) && (await tenantPool(SCHEMA).query('SELECT 1 FROM map_version LIMIT 1').then(() => true, () => false));
const SAM = { id: 'user:test-drift', name: 'Sam Taylor', title: 'DI Administrator' };
const ADMIN_URL = process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307';
const NEW_SERIAL = 5_000_000;

describe.skipIf(!up)('a new share type in the core', () => {
  let pool: Pool;
  let admin: Pool;
  let core: Pool;
  let approvals: ApprovalStore;
  let sources: SourceService;
  let gateway: ModuleGateway;
  let spec: ModuleSpec;
  let connectionId: number;
  let added = 0;
  const turn = (text: string, threadId: string): ModuleTurn => ({ runId: `R-${threadId}`, threadId, text, user: SAM, tenant: { name: 'Harborview' }, modules: ['sources', 'admin'] });
  const ask = async (text: string, threadId: string) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const out = await runModuleOffline(gateway.match(text) ?? spec, turn(text, threadId), { gateway }, sink);
    for (const b of blocks) expect(validateBlock(b).ok, JSON.stringify(validateBlock(b))).toBe(true);
    return { out, text: texts.join(' '), blocks };
  };
  const count = async (sql: string, params: unknown[] = []) => Number(((await admin.query(sql, params)) as unknown as [{ n: number }[]])[0][0]!.n);

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${ADMIN_URL}/${SCHEMA}`);
    core = createPool(`${ADMIN_URL}/${REPLICA}`);
    approvals = new ApprovalStore(pool);
    sources = new SourceService(pool, { secretKey: secretKeyFrom(), allowedHosts: ['127.0.0.1'] });
    spec = coreMappingModule(sources, () => '2026-11-17');
    gateway = new ModuleGateway(approvals, [spec, sourcesModule(sources, () => '2026-11-17')]);
    const saved = await sources.saveLogin({ system: 'symitar', host: '127.0.0.1', port: 3307, database: REPLICA, login: 'core_reader', password: process.env.DI_CORE_READER_PASSWORD ?? 'core_reader_demo' }, { userId: SAM.id });
    connectionId = await sources.create({ credentialId: saved.credentialId, name: 'Drift test replica', schedule: 'Nightly at 2:00 am', tables: ['cdm_party', 'cdm_deposit_account', 'cdm_loan'] }, { userId: SAM.id, name: SAM.name }, { approvalId: 'apr_drift_connect', on: '2026-11-17' });
  });
  afterAll(async () => {
    await core.query('DELETE FROM SAVINGS WHERE SERIAL > ?', [NEW_SERIAL]);
    await core.query('ALTER TABLE ACCOUNT DROP COLUMN EMAILOPTIN').catch(() => {});
    // Land the replica as it is again, so later tests see the usual rows.
    if (connectionId) await sources.pull(connectionId, { approvalId: 'apr_drift_restore' }).catch(() => {});
    for (const t of ['map_drift', 'map_version', 'src_sync_run', 'src_mapping']) await admin.query(`DELETE FROM ${t} WHERE connection_id IN (SELECT connection_id FROM src_connection WHERE created_by = ?)`, [SAM.id]);
    await admin.query('DELETE FROM src_connection WHERE created_by = ?', [SAM.id]);
    await admin.query('DELETE FROM src_credential WHERE created_by = ?', [SAM.id]);
    await pool.end();
    await admin.end();
    await core.end();
  });

  it('starts at version 1, Kinective’s standard mapping', async () => {
    const { versions } = await sources.versions(connectionId);
    expect(versions.map((v) => [v.versionNo, v.source])).toEqual([[1, 'standard']]);
    const r = await ask('Show the mapping versions', 'thr_drift1');
    expect(r.text).toContain('**version 1**');
  });

  it('holds the rows of a share type the crosswalk doesn’t know, and says what they look like', async () => {
    // The first pull records the columns version 1 was made for; then the core changes.
    const first = await sources.pull(connectionId, { approvalId: 'apr_drift_pull1' });
    expect(first.version).toBe(1);
    expect(first.held).toEqual([]);
    await core.query(
      `INSERT IGNORE INTO SAVINGS (PARENTACCOUNT, ID, SERIAL, TYPE, BRANCH, OPENDATE, CLOSEDATE, MATURITYDATE, BALANCE, DIVRATE)
       SELECT PARENTACCOUNT, '9914', SERIAL + ?, 14, BRANCH, OPENDATE, CLOSEDATE, MATURITYDATE, BALANCE, DIVRATE + 10 FROM SAVINGS WHERE TYPE = 12 AND CLOSEDATE = '00000000' ORDER BY SERIAL LIMIT 312`,
      [NEW_SERIAL],
    );
    await core.query("ALTER TABLE ACCOUNT ADD COLUMN EMAILOPTIN CHAR(1) NOT NULL DEFAULT 'N'");
    added = await count('SELECT COUNT(*) AS n FROM SAVINGS WHERE SERIAL > ?'.replace('SAVINGS', `\`${REPLICA}\`.SAVINGS`), [NEW_SERIAL]);
    expect(added).toBeGreaterThan(200);

    const r = await sources.pull(connectionId, { approvalId: 'apr_drift_pull2' });
    expect(r.held).toHaveLength(1);
    expect(r.held![0]).toMatchObject({ table: 'SAVINGS', column: 'TYPE', set: 'shareType', code: '14', count: added });
    expect(r.held![0]!.proposal!.value).toBe('Money Market');
    // Held rows land without a share type, never as a wrong one.
    expect(await count('SELECT COUNT(*) AS n FROM src_land_deposit_account WHERE account_id > ? AND deposit_category IS NULL', [NEW_SERIAL])).toBe(added);
    // The raw zone has the core's table as it is, new rows included.
    expect(await count('SELECT COUNT(*) AS n FROM src_raw_savings')).toBe(await count(`SELECT COUNT(*) AS n FROM \`${REPLICA}\`.SAVINGS`));
    const { items } = await sources.drift(connectionId);
    expect(items.map((d) => `${d.kind} ${d.table}.${d.column}${d.value ? `=${d.value}` : ''}`).sort()).toEqual(['new_code SAVINGS.TYPE=14', 'new_column ACCOUNT.EMAILOPTIN']);

    const said = await ask('What changed in the core?', 'thr_drift2');
    expect(said.text).toContain('share type 14 in SAVINGS.TYPE');
    expect(said.text).toContain('look most like Money Market');
    expect(said.text).toContain('ACCOUNT.EMAILOPTIN appeared in the core');
  }, 180_000);

  it('maps the code on approval in version 2, and the next pull maps the held rows', async () => {
    const r = await ask('Map share type 14 to money market', 'thr_drift3');
    expect(r.out.approval).toBeTruthy();
    const rec = r.out.approval!.record;
    const decided = await approvals.decide(rec.approvalId, { decision: 'approved', userId: SAM.id, payloadHash: rec.payloadHash });
    const done = await gateway.execute(decided, { user: SAM, modules: ['sources'], runId: 'R-drift-exec', threadId: 'thr_drift_exec' });
    expect(JSON.stringify(done)).toContain('mapping version 2');
    const { versions } = await sources.versions(connectionId);
    expect(versions[0]).toMatchObject({ versionNo: 2, source: 'crosswalk', summary: 'Share type 14 → Money Market' });

    const p = await sources.pull(connectionId, { approvalId: 'apr_drift_pull3' });
    expect(p.version).toBe(2);
    expect(p.held).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM src_land_deposit_account WHERE account_id > ? AND deposit_category = 'Money Market'", [NEW_SERIAL])).toBe(added);
    const { items } = await sources.drift(connectionId);
    expect(items.map((d) => d.kind)).toEqual(['new_column']);
  }, 180_000);

  it('refuses a value DI doesn’t know for that code list', async () => {
    await expect(sources.checkCrosswalk({ set: 'shareType', code: '15', value: 'mortgage escrow' })).rejects.toThrow(/isn’t a share type DI knows/);
  });
});
