// Adds direct core connections to tenants that are already seeded, without resetting anything else.
// Usage: npm -w @dinext/tenant-db run seed:sources
import mysql from 'mysql2/promise';
import { ADMIN_DB_URL, dbSsl } from './db.ts';
import { TENANTS } from './generate.ts';
import { createSourceTables, seedCoreReplica } from './sources.ts';

const admin = await mysql.createConnection({ uri: process.env.DI_DB_ADMIN_URL ?? ADMIN_DB_URL, ...dbSsl() });
for (const profile of TENANTS) {
  await createSourceTables(admin, profile.schema);
  if (profile.institutionType === 'credit_union') {
    const r = await seedCoreReplica(admin, profile.schema);
    console.log(`${profile.key}: source tables ready, replica ${r.database} as of ${r.processDate}`);
  } else console.log(`${profile.key}: source tables ready`);
}
await admin.end();
