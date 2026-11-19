// The AI audit record kept for good (spec 26.10, AI-GRD-090). Every line the audit log writes (each
// turn with its tool calls and cost, each approval decision and executed change, each member record
// opened) also goes to its own schema, which the seed creates once and never drops. The application
// account may add rows and read them, never change or remove one.
//
// The tenant's own ledger (ai_run, ai_approvals, ai_feedback) drives the AI usage reports. A reseed
// rebuilds the tenant, so the real rows in it are read first and written back after the demo history.
import type mysql from 'mysql2/promise';

export const AUDIT_SCHEMA = 'dinext_audit';

export const AUDIT_DDL = [
  `CREATE TABLE IF NOT EXISTS \`${AUDIT_SCHEMA}\`.ai_audit_event (
     event_id BIGINT AUTO_INCREMENT PRIMARY KEY,
     at DATETIME(3) NOT NULL,
     tenant_id VARCHAR(40) NOT NULL,
     event_type VARCHAR(60) NOT NULL,
     user_id VARCHAR(40) NULL,
     thread_id VARCHAR(40) NULL,
     run_id VARCHAR(40) NULL,
     approval_id VARCHAR(60) NULL,
     body MEDIUMTEXT NOT NULL,
     KEY ix_audit_tenant_at (tenant_id, at),
     KEY ix_audit_run (run_id),
     KEY ix_audit_user (user_id, at)
   )`,
];

/** Creates the schema and table if missing (never drops them). Add and read only for the application account. */
export async function createAuditStore(admin: mysql.Connection) {
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${AUDIT_SCHEMA}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  for (const ddl of AUDIT_DDL) await admin.query(ddl);
  await admin.query(`GRANT SELECT, INSERT ON \`${AUDIT_SCHEMA}\`.* TO 'dinext'@'%'`);
}

type Rows = Record<string, unknown>[];
export interface KeptUsage {
  runs: Rows;
  approvals: Rows;
  feedback: Rows;
  /** The institution's own words (phase 11). */
  words: Rows;
}

/**
 * The runs, approvals and ratings people really made in a tenant, read before a reseed drops it. The
 * seed's own demo history (source 'demo', approvals apr_demo_*) is left out: the seed writes it again.
 * Null when the tenant has no ledger yet.
 */
export async function keepRealUsage(admin: mysql.Connection, schema: string): Promise<KeptUsage | null> {
  const read = async (sql: string) => ((await admin.query(sql)) as unknown as [Rows])[0];
  try {
    return {
      runs: await read(`SELECT * FROM \`${schema}\`.ai_run WHERE source <> 'demo'`),
      approvals: await read(`SELECT * FROM \`${schema}\`.ai_approvals WHERE approval_id NOT LIKE 'apr\\_demo\\_%'`),
      feedback: await read(`SELECT * FROM \`${schema}\`.ai_feedback`),
      words: await read(`SELECT * FROM \`${schema}\`.onto_word`).catch(() => []),
    };
  } catch {
    return null;
  }
}

/** A value as the driver should write it back: JSON columns come back parsed. */
const cell = (v: unknown) => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) ? JSON.stringify(v) : v);

/**
 * Writes kept rows back into the rebuilt tenant (the current schema). A card that was still waiting
 * is marked expired: what it previewed was rebuilt, so it can no longer be approved as shown.
 */
export async function restoreRealUsage(admin: mysql.Connection, kept: KeptUsage) {
  const put = async (table: string, rows: Rows) => {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]!);
    for (let i = 0; i < rows.length; i += 1000) {
      await admin.query(`INSERT IGNORE INTO ${table} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES ?`, [rows.slice(i, i + 1000).map((r) => cols.map((c) => cell(r[c])))]);
    }
  };
  await put('ai_run', kept.runs);
  await put('ai_approvals', kept.approvals.map((a) => (a.status === 'pending' ? { ...a, status: 'expired' } : a)));
  await put('ai_feedback', kept.feedback);
  await put('onto_word', kept.words);
  return { runs: kept.runs.length, approvals: kept.approvals.length, feedback: kept.feedback.length, words: kept.words.length };
}
