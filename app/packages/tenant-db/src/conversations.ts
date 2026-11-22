// Conversations (spec 12.1): each task, everything streamed in it, and the approval cards waiting in
// it. They live in their own schema, which the seed creates once and never drops, so a deploy, a
// restart or a reseed of the tenant data keeps everyone's tasks. Each row carries its tenant and owner;
// a task is only ever shown to the person who started it.
import type mysql from 'mysql2/promise';

export const CONVERSATIONS_SCHEMA = 'dinext_conversations';

export const CONVERSATIONS_DDL = [
  `CREATE TABLE IF NOT EXISTS \`${CONVERSATIONS_SCHEMA}\`.di_thread (
     thread_id VARCHAR(40) PRIMARY KEY,
     tenant_id VARCHAR(40) NOT NULL,
     owner_id VARCHAR(40) NOT NULL,
     deleted TINYINT(1) NOT NULL DEFAULT 0,
     last_seq INT NOT NULL DEFAULT 0,
     updated_at DATETIME(3) NOT NULL,
     summary TEXT NOT NULL,
     KEY ix_thread_owner (tenant_id, owner_id, updated_at)
   )`,
  `CREATE TABLE IF NOT EXISTS \`${CONVERSATIONS_SCHEMA}\`.di_thread_event (
     thread_id VARCHAR(40) NOT NULL,
     seq INT NOT NULL,
     event MEDIUMTEXT NOT NULL,
     PRIMARY KEY (thread_id, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS \`${CONVERSATIONS_SCHEMA}\`.di_thread_approval (
     approval_id VARCHAR(60) PRIMARY KEY,
     thread_id VARCHAR(40) NOT NULL,
     run_id VARCHAR(40) NULL,
     block_id VARCHAR(80) NOT NULL,
     card MEDIUMTEXT NOT NULL,
     live TINYINT(1) NOT NULL,
     notice_id VARCHAR(40) NULL,
     decided TEXT NULL,
     KEY ix_thread_approval (thread_id)
   )`,
  // Platform settings an administrator sets on screen, such as the Anthropic API key (encrypted; only its
  // last four characters are kept in the clear), with who set it and the last connection test.
  `CREATE TABLE IF NOT EXISTS \`${CONVERSATIONS_SCHEMA}\`.di_setting (
     setting VARCHAR(40) PRIMARY KEY,
     value_sealed TEXT NULL,
     last4 VARCHAR(4) NULL,
     updated_by VARCHAR(80) NULL,
     updated_at DATETIME(3) NULL,
     tested_at DATETIME(3) NULL,
     test_ok TINYINT(1) NULL,
     test_message VARCHAR(200) NULL
   )`,
];

/** Creates the schema and tables if missing (never drops them) and lets the application account use them. */
export async function createConversationStore(admin: mysql.Connection) {
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${CONVERSATIONS_SCHEMA}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  for (const ddl of CONVERSATIONS_DDL) await admin.query(ddl);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${CONVERSATIONS_SCHEMA}\`.* TO 'dinext'@'%'`);
}
