// Creates the conversation store on its own, without reseeding the tenant data (npm run db:conversations).
// The full seed does the same at its start; this is for a warehouse seeded before the store existed.
import mysql from 'mysql2/promise';
import { ADMIN_DB_URL, dbSsl } from './db.ts';
import { CONVERSATIONS_SCHEMA, createConversationStore } from './conversations.ts';

const admin = await mysql.createConnection({ uri: process.env.DI_DB_ADMIN_URL ?? ADMIN_DB_URL, ...dbSsl() });
try {
  await createConversationStore(admin);
  console.log(`Conversation store ready in ${CONVERSATIONS_SCHEMA}. Restart the server to keep tasks across restarts.`);
} finally {
  await admin.end();
}
