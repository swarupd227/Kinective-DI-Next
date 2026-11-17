// Creates the stores that outlive a reseed, without reseeding the tenant data (npm run db:conversations):
// conversations, and the AI audit record. The full seed does the same at its start; this is for a
// warehouse seeded before the stores existed.
import mysql from 'mysql2/promise';
import { ADMIN_DB_URL, dbSsl } from './db.ts';
import { CONVERSATIONS_SCHEMA, createConversationStore } from './conversations.ts';
import { AUDIT_SCHEMA, createAuditStore } from './auditStore.ts';

const admin = await mysql.createConnection({ uri: process.env.DI_DB_ADMIN_URL ?? ADMIN_DB_URL, ...dbSsl() });
try {
  await createConversationStore(admin);
  await createAuditStore(admin);
  console.log(`Stores ready in ${CONVERSATIONS_SCHEMA} and ${AUDIT_SCHEMA}. Restart the server to use them.`);
} finally {
  await admin.end();
}
