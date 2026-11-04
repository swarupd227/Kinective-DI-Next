// Data Load against the warehouse: a staged CSV becomes a new uploaded table on approval, a second
// file adds to it, and what can't load is said before anything is written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, FileStore, IngestService, TableService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, dataLoadModule, loadTarget, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);
const SAM = { id: 'user:1002', name: 'Sam Taylor', title: 'DI Administrator' };

function recorder() {
  const texts: string[] = [];
  const blocks: Block[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { sink, blocks, texts };
}

describe('reading where to load from a request', () => {
  it('finds a new table, a named table, or a replace', () => {
    expect(loadTarget('Load “targets.csv” into a new table called Branch targets')).toEqual({ mode: 'new', table: 'Branch targets' });
    expect(loadTarget('Load “targets.csv” into the Branch targets table')).toEqual({ table: 'Branch targets' });
    expect(loadTarget('Replace the Branch targets table with targets.csv')).toMatchObject({ mode: 'replace' });
    expect(loadTarget('Load “targets.csv”')).toEqual({});
  });
});

describe.skipIf(!up)('Data Load against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let approvals: ApprovalStore;
  let gateway: ModuleGateway;
  let dl: ModuleSpec;
  let files: FileStore;
  const NAME = 'Test branch targets';
  const turn = (text: string, threadId: string): ModuleTurn => ({ runId: `R-${threadId}`, threadId, text, user: SAM, tenant: { name: 'Harborview' }, modules: ['files', 'tables', 'operations', 'admin'] });
  const run = async (t: ModuleTurn) => {
    const r = recorder();
    return { r, out: await runModuleOffline(dl, t, { gateway }, r.sink) };
  };
  const stage = (name: string, csv: string) => files.stage({ name, body: Buffer.from(csv), owner: { userId: SAM.id, name: SAM.name }, on: '2026-10-25' });
  const approveAndRun = async (out: Awaited<ReturnType<typeof run>>['out']) => {
    const rec = out.approval!.record;
    const decided = await approvals.decide(rec.approvalId, { decision: 'approved', userId: SAM.id, payloadHash: rec.payloadHash });
    await gateway.execute(decided, turn('', 'thr_dl_exec'));
  };

  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    approvals = new ApprovalStore(pool);
    files = new FileStore(pool);
    dl = dataLoadModule(files, new IngestService(pool, null), () => '2026-10-25');
    gateway = new ModuleGateway(approvals, [dl]);
  });
  afterAll(async () => {
    await admin.query("DELETE FROM tbl_object WHERE kind = 'Upload' AND name LIKE 'Test branch targets%'");
    await admin.query("DELETE FROM fil_file WHERE name LIKE 'test_branch_targets%'");
    await pool.end();
    await admin.end();
  });

  it('routes data file requests to Data Load', () => {
    expect(gateway.match('Load “test_branch_targets.csv”')?.id).toBe('dataload');
    expect(gateway.match('Check targets.xlsx')?.id).toBe('dataload');
    expect(gateway.match('Set up uploaders from our SFTP folder')?.id).toBe('dataload');
  });

  it('profiles a file and says what won’t load', async () => {
    await stage('test_branch_targets_profile.csv', 'Branch,Target\nWestport,100\nEastgate,200\nNorthgate,300\nRiverside,400\nDowntown,500\nLakeshore,600\nA,700\nB,800\nC,900\nD,lots');
    const { r } = await run(turn('Check test_branch_targets_profile.csv', 'thr_dl1'));
    expect(r.texts[0]).toContain('10 rows and 2 columns');
    expect(r.texts[0]).toContain('“lots”');
    for (const b of r.blocks) expect(validateBlock(b).ok).toBe(true);
  });

  it('loads a new table on approval, then adds a second file to it', async () => {
    await stage('test_branch_targets.csv', 'Branch,Target,Start\nWestport,"$12,000",2026-10-01\nEastgate,"$8,500",10/1/2026');
    const first = await run(turn('Load “test_branch_targets.csv”', 'thr_dl2'));
    expect(first.out.approval!.card.data).toMatchObject({ riskTier: 'medium', summary: `Load test_branch_targets.csv into a new table, ${NAME}` });
    await approveAndRun(first.out);
    const svc = new TableService(pool);
    const made = (await svc.objects(SAM.id)).find((o) => o.kind === 'Upload' && o.name === NAME)!;
    expect(made.rowCount).toBe(2);
    const opened = await svc.objectRows(SAM.id, made.objId, { purviewBranches: ['Westport'] });
    // An upload is the uploader's own data, so a purview doesn't filter it.
    expect(opened!.rows).toHaveLength(2);
    expect(opened!.rows[1]).toMatchObject({ branch: 'Eastgate', target: 8500, start: '2026-10-01' });

    await stage('test_branch_targets_nov.csv', 'Branch,Target\nNorthgate,9000');
    const second = await run(turn(`Load “test_branch_targets_nov.csv” into the ${NAME} table`, 'thr_dl3'));
    expect(second.out.approval!.card.data.summary).toBe(`Add rows to ${NAME} from test_branch_targets_nov.csv`);
    expect(JSON.stringify(second.out.approval!.card.data.preview)).toContain('Start isn’t in the file');
    await approveAndRun(second.out);
    expect((await svc.objects(SAM.id)).find((o) => o.objId === made.objId)!.rowCount).toBe(3);
  });

  it('refuses a file with columns the table doesn’t have', async () => {
    await stage('test_branch_targets_extra.csv', 'Branch,Target,Owner\nWestport,1,Ana');
    const { r, out } = await run(turn(`Load “test_branch_targets_extra.csv” into the ${NAME} table`, 'thr_dl4'));
    expect(out.approval).toBeUndefined();
    expect(r.texts[0]).toContain('Owner');
  });
});
