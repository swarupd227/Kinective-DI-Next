// @vitest-environment node
// The permanent audit store and the real usage a reseed keeps, against the local MySQL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { AUDIT_SCHEMA, GOVERNANCE_DDL, WORKFLOW_DDL, createAuditStore, createPool, keepRealUsage, restoreRealUsage, warehouseAvailable } from '@dinext/tenant-db';
import { mysqlAuditKeeper } from '../src/auditStore.ts';

const available = await warehouseAvailable('dinext_t_test_cu');
const SCRATCH = 'dinext_t_audit_keep_test';
const ADMIN = process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307';
let admin: mysql.Connection;

beforeAll(async () => {
  if (!available) return;
  admin = await mysql.createConnection({ uri: ADMIN });
  await createAuditStore(admin);
});
afterAll(async () => {
  if (!available) return;
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
  await admin.end();
});

describe.skipIf(!available)('AI audit store', () => {
  it('keeps each audit line, and the application can add lines but never change or remove one', async () => {
    const keeper = (await mysqlAuditKeeper())!;
    expect(keeper).not.toBeNull();
    const runId = `R-TEST-${Date.now().toString(36)}`;
    await keeper.keep({ at: new Date().toISOString(), tenant: 'tnt_test', eventType: 'ai.run', userId: 'user:1', threadId: 'thr_x', runId, body: { question: 'Total loans by branch', outcome: 'answer' } });
    const app = createPool(undefined, { connectionLimit: 1 });
    try {
      const [rows] = (await app.query(`SELECT event_type, user_id, body FROM \`${AUDIT_SCHEMA}\`.ai_audit_event WHERE run_id = ?`, [runId])) as unknown as [{ event_type: string; user_id: string; body: string }[]];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ event_type: 'ai.run', user_id: 'user:1' });
      expect(JSON.parse(rows[0]!.body)).toMatchObject({ outcome: 'answer' });
      await expect(app.query(`UPDATE \`${AUDIT_SCHEMA}\`.ai_audit_event SET event_type = 'x' WHERE run_id = ?`, [runId])).rejects.toThrow(/denied/i);
      await expect(app.query(`DELETE FROM \`${AUDIT_SCHEMA}\`.ai_audit_event WHERE run_id = ?`, [runId])).rejects.toThrow(/denied/i);
    } finally {
      await app.end();
      await keeper.close();
    }
  });

  it('carries real runs, approvals and ratings across a reseed, and leaves the demo history to the seed', async () => {
    const build = async () => {
      await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
      await admin.query(`CREATE DATABASE \`${SCRATCH}\``);
      await admin.query(`USE \`${SCRATCH}\``);
      for (const ddl of [...WORKFLOW_DDL, ...GOVERNANCE_DDL].filter((d) => /CREATE TABLE (ai_run|ai_approvals|ai_feedback) /.test(d))) await admin.query(ddl);
    };
    const run = (id: string, source: string) => [id, '2026-11-17 09:30:00.123', 'user:9229', 'thr_1', 'Analytics Q&A', 'data_question', 'offline', 'Total loans', 'answer', null, 10, 5, 0, 0.000123, JSON.stringify([{ name: 'semantic_query', ok: true }]), source];
    const approval = (id: string, status: string) => [id, 'referral.create', JSON.stringify({ summary: 'Refer Suzanne' }), `sha256:${'0'.repeat(64)}`, 'medium', 'user:9229', 'R-real', 'thr_1', status, '2026-11-17 09:30:00.000', '2026-11-18 09:30:00.000'];
    await build();
    await admin.query('INSERT INTO ai_run VALUES ?', [[run('R-demo', 'demo'), run('R-real', 'live')]]);
    await admin.query('INSERT INTO ai_approvals (approval_id, operation, payload, payload_hash, risk_tier, requested_by, run_id, thread_id, status, created_at, expires_at) VALUES ?', [[approval('apr_demo_1', 'executed'), approval('apr_real_done', 'executed'), approval('apr_real_wait', 'pending')]]);
    await admin.query("INSERT INTO ai_feedback (run_id, user_id, at, rating, comment) VALUES ('R-real', 'user:9229', '2026-11-17 09:31:00.000', 'down', 'Wrong branch')");

    const kept = (await keepRealUsage(admin, SCRATCH))!;
    await build();
    await admin.query('INSERT INTO ai_run VALUES ?', [[run('R-demo', 'demo')]]);
    expect(await restoreRealUsage(admin, kept)).toEqual({ runs: 1, approvals: 2, feedback: 1 });

    const [runs] = (await admin.query('SELECT run_id, at, tool_calls FROM ai_run ORDER BY run_id')) as unknown as [{ run_id: string; at: Date; tool_calls: unknown }[]];
    expect(runs.map((r) => r.run_id)).toEqual(['R-demo', 'R-real']);
    expect(runs[1]!.tool_calls).toEqual([{ name: 'semantic_query', ok: true }]);
    const [[same]] = (await admin.query("SELECT COUNT(*) AS n FROM ai_run WHERE run_id = 'R-real' AND at = '2026-11-17 09:30:00.123'")) as unknown as [[{ n: number }]];
    expect(Number(same.n)).toBe(1);
    const [apps] = (await admin.query('SELECT approval_id, status FROM ai_approvals ORDER BY approval_id')) as unknown as [{ approval_id: string; status: string }[]];
    expect(apps).toEqual([
      { approval_id: 'apr_real_done', status: 'executed' },
      { approval_id: 'apr_real_wait', status: 'expired' },
    ]);
    const [fb] = (await admin.query('SELECT comment FROM ai_feedback')) as unknown as [{ comment: string }[]];
    expect(fb).toEqual([{ comment: 'Wrong branch' }]);
  });

  it('keeps nothing from a tenant that has no ledger yet', async () => {
    expect(await keepRealUsage(admin, 'dinext_no_such_schema')).toBeNull();
  });
});
