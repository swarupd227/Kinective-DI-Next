// Core Mapping against the Symitar-style replica: the standard columns are locked, DI finds the tracking
// fields Kinective's mapping doesn't read, tries a mapping on real rows, adds it on approval, brings its
// values in on the next pull, and removes it on approval. Nothing is written to the core.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, SourceService, secretKeyFrom } from '@dinext/di-core';
import { createPool, replicaDatabase, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { coreMappingModule, mappingFrom, ModuleGateway, runModuleOffline, sourcesModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = (await warehouseAvailable(SCHEMA)) && (await tenantPool(SCHEMA).query('SELECT 1 FROM src_column_map LIMIT 1').then(() => true, () => false));
const SAM = { id: 'user:test-map', name: 'Sam Taylor', title: 'DI Administrator' };
const ADMIN_URL = process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307';
const CONSENT = 'FIRST_OF(ACCOUNTTRACKING, USERCHAR1, PARENTACCOUNT = a.ACCOUNTNUMBER AND TYPE = 12)';

describe('reading a mapping request', () => {
  it('takes the expression, the name, the type and the table', () => {
    expect(mappingFrom(`Map ${CONSENT} to email consent as a yes or no`)).toEqual({ expression: CONSENT, label: 'email consent', type: 'flag' });
    expect(mappingFrom("Map COUNT_OF(LOAN, PARENTACCOUNT = a.ACCOUNTNUMBER AND CLOSEDATE = '00000000') to open loans as a number")).toMatchObject({ label: 'open loans', type: 'number' });
    expect(mappingFrom('Map the dealer visits on a map')).toBeNull();
  });
});

describe.skipIf(!up)('Core Mapping against the replica', () => {
  let pool: Pool;
  let admin: Pool;
  let approvals: ApprovalStore;
  let sources: SourceService;
  let gateway: ModuleGateway;
  let spec: ModuleSpec;
  const turn = (text: string, threadId: string): ModuleTurn => ({ runId: `R-${threadId}`, threadId, text, user: SAM, tenant: { name: 'Harborview' }, modules: ['sources', 'admin'] });
  const run = async (text: string, threadId: string) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const out = await runModuleOffline(gateway.match(text) ?? spec, turn(text, threadId), { gateway }, sink);
    return { out, text: texts.join(' '), blocks };
  };
  const approve = async (out: Awaited<ReturnType<typeof run>>['out']) => {
    const rec = out.approval!.record;
    const decided = await approvals.decide(rec.approvalId, { decision: 'approved', userId: SAM.id, payloadHash: rec.payloadHash });
    return gateway.execute(decided, { user: SAM, modules: ['sources'], runId: 'R-exec', threadId: 'thr_map_exec' });
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${ADMIN_URL}/${SCHEMA}`);
    approvals = new ApprovalStore(pool);
    sources = new SourceService(pool, { secretKey: secretKeyFrom(), allowedHosts: ['127.0.0.1'] });
    spec = coreMappingModule(sources, () => '2026-11-07');
    gateway = new ModuleGateway(approvals, [spec, sourcesModule(sources, () => '2026-11-07')]);
    // A connection to try mappings on.
    const saved = await sources.saveLogin({ system: 'symitar', host: '127.0.0.1', port: 3307, database: replicaDatabase(SCHEMA), login: 'core_reader', password: process.env.DI_CORE_READER_PASSWORD ?? 'core_reader_demo' }, { userId: SAM.id });
    await sources.create({ credentialId: saved.credentialId, name: 'Harbor test replica', schedule: 'Nightly at 2:00 am', tables: ['cdm_party', 'cdm_deposit_account', 'cdm_loan'] }, { userId: SAM.id, name: SAM.name }, { approvalId: 'apr_maptest_connect', on: '2026-11-07' });
  });
  afterAll(async () => {
    await admin.query("DELETE FROM cdm_custom_field WHERE field IN (SELECT field FROM src_column_map WHERE added_by = ?)", [SAM.id]);
    await admin.query('DELETE FROM src_column_map WHERE added_by = ?', [SAM.id]);
    const [ids] = (await admin.query('SELECT connection_id FROM src_connection WHERE created_by = ?', [SAM.id])) as unknown as [{ connection_id: number }[]];
    for (const { connection_id: id } of ids) {
      await admin.query('DELETE FROM src_sync_run WHERE connection_id = ?', [id]);
      await admin.query('DELETE FROM src_mapping WHERE connection_id = ?', [id]);
    }
    await admin.query('DELETE FROM src_connection WHERE created_by = ?', [SAM.id]);
    await admin.query('DELETE FROM src_credential WHERE created_by = ?', [SAM.id]);
    await pool.end();
    await admin.end();
  });

  it('routes mapping requests to Core Mapping, and connection requests to Data Sources', () => {
    expect(gateway.match('Show the Symitar mapping')?.prefix).toBe('map');
    expect(gateway.match('What core fields aren’t mapped yet?')?.prefix).toBe('map');
    expect(gateway.match(`Map ${CONSENT} to email consent as a yes or no`)?.prefix).toBe('map');
    expect(gateway.match('Pull from the Harbor test replica now')?.prefix).toBe('src');
    expect(gateway.match('Plan visits for my top five dealers on a map')).toBeNull();
  });

  it('shows the standard columns locked, and finds the tracking fields no one maps', async () => {
    const list = await run('Show the Symitar mapping', 'thr_map1');
    expect(list.text).toMatch(/standard columns\*\* from Kinective, locked/);
    const s = await run('What core fields aren’t mapped yet?', 'thr_map1');
    expect(s.text).toMatch(/tracking fields?\*\* with values/);
    const table = s.blocks.find((b) => b.type === 'table') as Extract<Block, { type: 'table' }>;
    // Every suggestion reads a tracking record; a Y-or-N field (unless it's already mapped) is proposed as a yes or no.
    const rows = table.data.rows!;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(String(r.expression)).toMatch(/^FIRST_OF\(ACCOUNTTRACKING, USER\w+, PARENTACCOUNT = a\.ACCOUNTNUMBER AND TYPE = \d+\)$/);
    expect(rows.some((r) => r.type === 'yes or no')).toBe(true);
    for (const b of [...list.blocks, ...s.blocks]) expect(validateBlock(b).ok).toBe(true);
  }, 60_000);

  it('tries a mapping on real rows, and refuses one that reaches outside the language', async () => {
    const p = await run(`Try mapping ${CONSENT} to email consent as a yes or no`, 'thr_map2');
    expect(p.text).toMatch(/gives \*\*[\d,]+ of [\d,]+ members\*\* a value/);
    const bad = await run("Try mapping IF(a.CLOSEDATE = '0'; DROP TABLE ACCOUNT, 1, 0) to closed as a number", 'thr_map2');
    expect(bad.text).toMatch(/can’t be used: “;” isn’t part/);
  }, 60_000);

  it('adds a mapping on approval, brings its values in on the pull, then removes it', async () => {
    const add = await run(`Map ${CONSENT} to email consent as a yes or no`, 'thr_map3');
    expect(add.out.outcome).toBe('approval');
    await approve(add.out);
    const [maps] = (await admin.query("SELECT field, state FROM src_column_map WHERE added_by = ? AND state = 'Active'", [SAM.id])) as unknown as [{ field: string }[]];
    expect(maps.map((m) => m.field)).toEqual(['email_consent']);
    const [conn] = (await admin.query('SELECT connection_id FROM src_connection WHERE created_by = ?', [SAM.id])) as unknown as [{ connection_id: number }[]];
    const pulled = await sources.pull(conn[0]!.connection_id, { approvalId: 'apr_maptest_pull' });
    expect(pulled.rows).toBeGreaterThan(0);
    const [vals] = (await admin.query("SELECT COUNT(*) AS n, SUM(value_num = 1) AS yes FROM cdm_custom_field WHERE di_table = 'cdm_party' AND field = 'email_consent'")) as unknown as [{ n: number; yes: number }[]];
    expect(Number(vals[0]!.n)).toBeGreaterThan(1000);
    expect(Number(vals[0]!.yes)).toBeGreaterThan(0);
    expect(Number(vals[0]!.yes)).toBeLessThan(Number(vals[0]!.n));
    const list = await run('Show the custom mappings', 'thr_map3');
    expect(list.text).toMatch(/email consent \([\d,]+ members after the last pull\)/);

    const rm = await run('Remove the email consent mapping', 'thr_map3');
    expect(rm.out.outcome).toBe('approval');
    await approve(rm.out);
    const [left] = (await admin.query("SELECT COUNT(*) AS n FROM cdm_custom_field WHERE field = 'email_consent'")) as unknown as [{ n: number }[]];
    expect(Number(left[0]!.n)).toBe(0);
  }, 180_000);

  it('never lets a custom mapping replace a standard column', async () => {
    await expect(sources.addColumnMap({ target: 'members', label: 'last name', expression: 'n.LAST', valueType: 'text' }, { userId: SAM.id, name: SAM.name }, { approvalId: 'apr_maptest_std', on: '2026-11-07' })).rejects.toThrow(/standard columns, which can’t be changed/);
  });
});
