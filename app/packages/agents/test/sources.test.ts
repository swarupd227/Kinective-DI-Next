// Data Sources against the warehouse and its Symitar-style replica: a login is tested and proven
// read-only, a login that can write is refused, the connection pulls and reconciles on approval, and
// switching the build moves lineage to the replica. The core is never written to.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, LineageService, SourceService, secretKeyFrom, transform } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { createPool, replicaDatabase, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, runModuleOffline, scheduleFrom, sourcesModule, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = (await warehouseAvailable(SCHEMA)) && (await tenantPool(SCHEMA).query('SELECT 1 FROM src_connection LIMIT 1').then(() => true, () => false));
const SAM = { id: 'user:test-src', name: 'Sam Taylor', title: 'DI Administrator' };
const ADMIN_URL = process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307';

function recorder() {
  const texts: string[] = [];
  const blocks: Block[] = [];
  const suggestions: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: (s) => void suggestions.push(s) };
  return { sink, blocks, texts, suggestions };
}

describe('reading the core’s values', () => {
  it('turns Symitar dates, codes, rates and due dates into DI’s', () => {
    expect(transform('20261025', { kind: 'date8' }, null)).toBe('2026-10-25');
    expect(transform('00000000', { kind: 'date8' }, null)).toBeNull();
    expect(transform(30, { kind: 'code', codes: { '30': 'Mortgage' } }, null)).toBe('Mortgage');
    expect(transform(42, { kind: 'code', codes: { '30': 'Mortgage' } }, null)).toBe('Code 42');
    expect(transform(6590, { kind: 'rate1000' }, null)).toBe(6.59);
    expect(transform('20261015', { kind: 'daysPast' }, '2026-10-25')).toBe(10);
    expect(transform('20261101', { kind: 'daysPast' }, '2026-10-25')).toBe(0);
    expect(transform(4012, { kind: 'nonzero' }, null)).toBe(1);
    expect(transform(1, { kind: 'not' }, null)).toBe(0);
  });

  it('reads a schedule from a request', () => {
    expect(scheduleFrom('Connect it, pulling nightly at 1:30 am')).toBe('Nightly at 1:30 am');
    expect(scheduleFrom('Connect it')).toBeUndefined();
  });
});

describe.skipIf(!up)('Data Sources against the replica', () => {
  let pool: Pool;
  let admin: Pool;
  let approvals: ApprovalStore;
  let sources: SourceService;
  let gateway: ModuleGateway;
  let spec: ModuleSpec;
  const NAME = 'Test Symitar replica';
  const turn = (text: string, threadId: string): ModuleTurn => ({ runId: `R-${threadId}`, threadId, text, user: SAM, tenant: { name: 'Harborview' }, modules: ['sources', 'admin'] });
  const run = async (text: string, threadId: string) => {
    const r = recorder();
    return { r, out: await runModuleOffline(spec, turn(text, threadId), { gateway }, r.sink) };
  };
  const approve = async (out: Awaited<ReturnType<typeof run>>['out']) => {
    const rec = out.approval!.record;
    const decided = await approvals.decide(rec.approvalId, { decision: 'approved', userId: SAM.id, payloadHash: rec.payloadHash });
    return gateway.execute(decided, { user: SAM, modules: ['sources'], runId: 'R-exec', threadId: 'thr_src_exec' });
  };

  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${ADMIN_URL}/${SCHEMA}`);
    approvals = new ApprovalStore(pool);
    sources = new SourceService(pool, { secretKey: secretKeyFrom(), allowedHosts: ['127.0.0.1'] });
    spec = sourcesModule(sources, () => '2026-11-05');
    gateway = new ModuleGateway(approvals, [spec]);
  });
  afterAll(async () => {
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

  it('routes core connection requests to Data Sources', () => {
    expect(gateway.match('Test the connection to the Jack Henry Symitar replica (connection details #3)')?.id).toBe('sources');
    expect(gateway.match('Connect the Symitar replica, pulling nightly at 2:00 am')?.id).toBe('sources');
    expect(gateway.match('Show the rows that differ')?.id).toBe('sources');
    expect(gateway.match('Use the Symitar replica for the next build')?.id).toBe('sources');
    expect(gateway.match('Show loan growth by branch')).toBeNull();
  });

  it('refuses a host DI can’t reach and never keeps its password', async () => {
    await expect(sources.saveLogin({ system: 'symitar', host: 'core.example.org', port: 3306, database: 'x', login: 'y', password: 'z' }, { userId: SAM.id })).rejects.toThrow(/networks Kinective has opened/);
  });

  it('refuses a login that can write', async () => {
    const saved = await sources.saveLogin({ system: 'other', host: '127.0.0.1', port: 3307, database: SCHEMA, login: 'dinext', password: 'dinext_local' }, { userId: SAM.id });
    const { r } = await run(`Test the connection (connection details #${saved.credentialId})`, 'thr_src_write');
    expect(r.texts.join(' ')).toMatch(/can change data in the core/);
    const { r: r2 } = await run(`Connect connection details #${saved.credentialId}`, 'thr_src_write');
    expect(r2.texts.join(' ')).toMatch(/won’t connect/);
  });

  it('tests a read-only login, connects on approval, and reconciles every row', async () => {
    const saved = await sources.saveLogin({ system: 'symitar', host: '127.0.0.1', port: 3307, database: replicaDatabase(SCHEMA), login: 'core_reader', password: process.env.DI_CORE_READER_PASSWORD ?? 'core_reader_demo' }, { userId: SAM.id });
    const [stored] = (await admin.query('SELECT secret FROM src_credential WHERE credential_id = ?', [saved.credentialId])) as unknown as [{ secret: string }[]];
    expect(stored[0]!.secret).not.toContain('core_reader_demo');

    const { r } = await run(`Test the connection to the Jack Henry Symitar replica (connection details #${saved.credentialId})`, 'thr_src');
    expect(r.texts.join(' ')).toMatch(/read-only/);
    expect(r.texts.join(' ')).toMatch(/Members\*\* from ACCOUNT \+ NAME/);
    for (const b of r.blocks) expect(validateBlock(b).ok).toBe(true);

    const { out, r: card } = await run(`Connect the Symitar replica as ${NAME}, pulling nightly at 2:00 am`, 'thr_src');
    expect(out.outcome).toBe('approval');
    expect(card.texts.join(' ')).toMatch(/Nothing is ever written to the core/);
    const done = await approve(out);
    expect(done.view?.text).toMatch(/Deposit accounts\*\* match exactly/);
    expect(done.view?.text).toMatch(/2 only in the core/);
    expect(done.view?.text).toMatch(/3 rows with different values/);
    for (const b of done.view?.blocks ?? []) expect(validateBlock(b).ok).toBe(true);
  }, 120_000);

  it('shows the rows that differ, then switches the build and lineage to the replica', async () => {
    const { r } = await run(`Show the rows that differ in the ${NAME}`, 'thr_src2');
    const rows = (r.blocks.find((b) => b.type === 'table' && b.title === 'Rows that differ') as Extract<Block, { type: 'table' }>).data.rows ?? [];
    expect(rows.filter((x) => x.field === 'Balance')).toHaveLength(3);
    expect(rows.filter((x) => x.field === 'Whole record')).toHaveLength(2);

    const { out } = await run(`Use the ${NAME} for the next build`, 'thr_src2');
    expect(out.outcome).toBe('approval');
    await approve(out);
    const semantic = await SemanticService.create(pool, 'test_cu', 'credit_union');
    const lineage = new LineageService(pool, semantic.model, undefined, () => sources.feeds());
    const trace = await lineage.trace(lineage.find('total loan balance').name);
    expect(trace.lanes.flatMap((l) => l.nodes).map((x) => x.label)).toContain('Jack Henry Symitar replica');

    const { out: back } = await run(`Stop using the ${NAME}`, 'thr_src2');
    await approve(back);
    expect((await sources.feeds()).size).toBe(0);
  }, 60_000);
});
