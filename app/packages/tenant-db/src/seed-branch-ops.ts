// Adds the branch operations tables (teller balancing, vault, lobby, CTRs, fraud, audits, training,
// staff) to credit unions that are already seeded, without resetting anything else.
// Usage: npx tsx --env-file-if-exists=../../.env src/seed-branch-ops.ts
import mysql from 'mysql2/promise';
import { seedBranchOps } from './branchOps.ts';
import { ADMIN_DB_URL, dbSsl } from './db.ts';
import { TENANTS } from './generate.ts';

const admin = await mysql.createConnection({ uri: process.env.DI_DB_ADMIN_URL ?? ADMIN_DB_URL, ...dbSsl() });
for (const profile of TENANTS.filter((p) => p.institutionType === 'credit_union')) console.log(profile.key, await seedBranchOps(admin, profile.schema));
await admin.end();
