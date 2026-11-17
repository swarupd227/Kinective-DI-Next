// The permanent AI audit record (spec 26.10, AI-GRD-090), in the schema the seed creates and never
// drops. Lines are only ever added. Without the table (a warehouse seeded before it existed) the
// audit log keeps writing its files, as before.
import type { AuditLog } from '@dinext/agents';
import { AUDIT_SCHEMA, createPool } from '@dinext/tenant-db';

type Keeper = Parameters<AuditLog['keep']>[0];

const sqlTime = (iso: string) => iso.replace('T', ' ').replace('Z', '').slice(0, 23);
const cut = (s: string | undefined, n: number) => (s ? s.slice(0, n) : null);

export async function mysqlAuditKeeper(): Promise<{ keep: Keeper; close: () => Promise<void> } | null> {
  const pool = createPool(undefined, { connectionLimit: 2 });
  const ok = await pool.query(`SELECT 1 FROM \`${AUDIT_SCHEMA}\`.ai_audit_event LIMIT 1`).then(
    () => true,
    () => false,
  );
  if (!ok) {
    await pool.end().catch(() => {});
    return null;
  }
  let lastError = 0;
  return {
    keep: async (e) => {
      try {
        await pool.query(`INSERT INTO \`${AUDIT_SCHEMA}\`.ai_audit_event (at, tenant_id, event_type, user_id, thread_id, run_id, approval_id, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
          sqlTime(e.at),
          e.tenant.slice(0, 40),
          e.eventType.slice(0, 60),
          cut(e.userId, 40),
          cut(e.threadId, 40),
          cut(e.runId, 40),
          cut(e.approvalId, 60),
          JSON.stringify(e.body),
        ]);
      } catch (err) {
        if (Date.now() - lastError > 60_000) console.error('[audit] could not write to the audit store:', (err as Error).message);
        lastError = Date.now();
        throw err;
      }
    },
    close: () => pool.end().catch(() => {}),
  };
}
