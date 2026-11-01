// Creates one schema per synthetic tenant and loads it (spec 13.6 tenancy, 27.2 test tenants).
// Usage: npm run db:seed   (idempotent: drops and recreates each tenant schema)
import mysql from 'mysql2/promise';
import { ADMIN_DB_URL, DEFAULT_DB_URL, dbSsl } from './db.ts';
import { AS_OF, BUILD, generate, TENANTS } from './generate.ts';
import { generateGoals, GI_GOALS, GI_INCENTIVES, GI_TIERS, GOALS_DDL, GOALS_WRITE_TABLES } from './goals.ts';
import { generatePipeline, LAP_APPLICATION_COLUMNS, LAP_HOLDS, LAP_STATUSES, PIPELINE_DDL, PIPELINE_WRITE_TABLES } from './pipeline.ts';
import { generateRelationship, RELATIONSHIP_DDL } from './relationship.ts';
import { reportSeed } from './reports.ts';
import { TENANT_DDL } from './schema.ts';
import { referralSeed, WORKFLOW_DDL, WORKFLOW_WRITE_TABLES, workflowSeed } from './workflow.ts';

const BATCH = 2000;

async function insert(conn: mysql.Connection, table: string, cols: string[], rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await conn.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ?`, [rows.slice(i, i + BATCH)]);
  }
}

async function main() {
  const admin = await mysql.createConnection({ uri: process.env.DI_DB_ADMIN_URL ?? ADMIN_DB_URL, multipleStatements: false, ...dbSsl() });
  // The application account (read-only on the warehouse, see the grants below). Docker creates it
  // locally; on Azure the seed creates it with DI_DB_APP_PASSWORD.
  const appPassword = process.env.DI_DB_APP_PASSWORD ?? new URL(process.env.DI_DB_URL ?? DEFAULT_DB_URL).password;
  await admin.query("CREATE USER IF NOT EXISTS 'dinext'@'%' IDENTIFIED BY ?", [decodeURIComponent(appPassword)]);
  for (const profile of TENANTS) {
    const started = Date.now();
    const t = generate(profile);
    await admin.query(`DROP DATABASE IF EXISTS \`${profile.schema}\``);
    await admin.query(`CREATE DATABASE \`${profile.schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await admin.query(`USE \`${profile.schema}\``);
    for (const ddl of TENANT_DDL) await admin.query(ddl);
    await insert(admin, 'cdm_location', ['int_id', 'name', 'region', 'opened_date'], t.locations);
    await insert(admin, 'cdm_employee', ['employee_id', 'display_name', 'role', 'branch_id'], t.employees);
    await insert(admin, 'cdm_party', ['party_id', 'first_name', 'last_name', 'birth_date', 'join_date', 'primary_branch_id', 'segment_code', 'household_id', 'is_member'], t.parties);
    await insert(admin, 'cdm_loan', ['loan_id', 'party_id', 'branch_id', 'officer_id', 'loan_category', 'is_indirect', 'open_date', 'close_date', 'charge_off_date', 'original_amount', 'balance', 'rate', 'days_delinquent'], t.loans);
    await insert(admin, 'cdm_deposit_account', ['account_id', 'party_id', 'branch_id', 'deposit_category', 'open_date', 'close_date', 'maturity_date', 'balance', 'rate'], t.deposits);
    await insert(admin, 'hist_loan_month', ['month_end', 'branch_id', 'loan_category', 'is_indirect', 'balance', 'delinquent_60_balance', 'loan_count', 'new_loan_amount', 'new_loan_count'], t.histLoan);
    await insert(admin, 'hist_deposit_month', ['month_end', 'branch_id', 'deposit_category', 'balance', 'account_count'], t.histDeposit);
    await insert(admin, 'hist_party_month', ['month_end', 'branch_id', 'member_count', 'new_member_count'], t.histParty);
    await insert(admin, 'meta_build', ['build_id', 'as_of_date', 'completed_at', 'state'], [[BUILD.buildId, AS_OF, BUILD.completedAt, 'completed']]);
    for (const ddl of RELATIONSHIP_DDL) await admin.query(ddl);
    const rm = generateRelationship(t);
    await insert(admin, 'cdm_party_contact', ['party_id', 'email', 'phone', 'preferred_channel'], rm.contacts);
    await insert(admin, 'cdm_digital_usage', ['party_id', 'online_banking_since', 'mobile_since', 'mobile_deposit_since', 'estatements_since', 'bill_pay_since', 'direct_deposit_status', 'direct_deposit_changed', 'last_login'], rm.digital);
    await insert(admin, 'cdm_attrition_score', ['party_id', 'score', 'factors', 'model_version', 'run_date'], rm.attrition);
    await insert(admin, 'cdm_suggestion', ['suggestion_id', 'party_id', 'product', 'referral_type_id', 'likelihood', 'reason', 'model_version', 'run_date'], rm.suggestions);
    const lap = generatePipeline(t, rm.applications);
    await insert(admin, 'cdm_loan_application', LAP_APPLICATION_COLUMNS, lap.applications);
    await insert(admin, 'cdm_interaction', ['interaction_id', 'party_id', 'occurred_at', 'channel', 'kind', 'summary', 'employee_id'], rm.interactions);
    await insert(admin, 'cdm_account_activity', ['account_kind', 'account_id', 'balance_30d', 'fees_30d'], rm.activity);
    for (const ddl of PIPELINE_DDL) await admin.query(ddl);
    await insert(admin, 'mod_lap_status_map', ['status_code', 'label', 'definition', 'in_progress', 'visible', 'reporting_group', 'sort_order', 'stall_days'], LAP_STATUSES.map((s) => [...s]));
    await insert(admin, 'cdm_loan_app_status_history', ['application_id', 'status_code', 'entered_date'], lap.history);
    await insert(admin, 'mod_lap_hold_reason', ['hold_code', 'label', 'waiting_on', 'next_step'], LAP_HOLDS.map((h) => h.slice(0, 4) as unknown[]));
    await insert(admin, 'cdm_loan_app_hold', ['application_id', 'hold_code', 'since_date'], lap.holds);
    await insert(admin, 'hist_lap_month', ['month_end', 'branch_id', 'loan_category', 'application_count', 'approved_count', 'decided_count'], lap.months);
    await insert(admin, 'meta_lap_load', ['load_date', 'state'], [[AS_OF, 'completed']]);
    for (const ddl of GOALS_DDL) await admin.query(ddl);
    const gi = generateGoals(t);
    await insert(admin, 'mod_gi_goal', ['goal_id', 'name', 'unit', 'role', 'goal_kind', 'target', 'unit_label'], GI_GOALS.map((g) => [...g]));
    await insert(admin, 'mod_gi_target', ['goal_id', 'employee_id', 'target', 'reason'], gi.targets);
    await insert(admin, 'mod_gi_incentive', ['incentive_id', 'goal_id', 'name', 'payout_type', 'per_unit', 'cap_amount'], GI_INCENTIVES.map((i) => [...i]));
    await insert(admin, 'mod_gi_tier', ['incentive_id', 'tier', 'lower_pct', 'amount'], GI_TIERS.map((x) => [...x]));
    await insert(admin, 'mod_gi_period', ['period_end', 'state'], gi.periods);
    await insert(admin, 'cdm_gi_credit', ['goal_id', 'employee_id', 'period_end', 'occurred', 'label', 'value', 'state'], gi.credits);
    await insert(admin, 'mod_gi_adjustment', ['employee_id', 'period_end', 'amount', 'reason_code', 'note', 'status', 'created_by'], gi.adjustments);
    for (const ddl of WORKFLOW_DDL) await admin.query(ddl);
    const wf = workflowSeed(profile, t.employees);
    await insert(admin, 'mod_ref_types', ['type_id', 'category', 'label', 'description', 'route_rule', 'fields', 'active'], wf.types);
    await insert(admin, 'esp_com_queues', ['queue_id', 'name', 'branch_id', 'member_employee_ids', 'rr_pointer'], wf.queues);
  const firstBranch = (t.parties as unknown[][]).filter((p) => p[5] === 1 && p[0] !== 1).slice(0, 5).map((p) => p[0] as number);
  await insert(admin, 'esp_com_items', ['definition', 'type_id', 'party_id', 'fields', 'notes', 'stage', 'priority', 'sender_user_id', 'sender_name', 'to_queue_id', 'assignee_employee_id', 'routing', 'created_at'], referralSeed(firstBranch));
    await insert(admin, 'esp_report_templates', ['template_id', 'name', 'folder', 'status', 'owner_user_id', 'owner_name', 'definition', 'origin', 'version', 'thread_id', 'approval_id', 'created_at', 'updated_at'], reportSeed(profile.institutionType));
    // The application account reads tenant data only (spec 26.2: read-only on customer tables), and
    // writes only the workflow store, through approved DI Core operations.
    await admin.query(`GRANT SELECT ON \`${profile.schema}\`.* TO 'dinext'@'%'`);
    for (const table of [...WORKFLOW_WRITE_TABLES, ...PIPELINE_WRITE_TABLES, ...GOALS_WRITE_TABLES]) await admin.query(`GRANT INSERT, UPDATE ON \`${profile.schema}\`.\`${table}\` TO 'dinext'@'%'`);
    console.log(`${profile.key}: ${t.parties.length} parties, ${t.loans.length} loans, ${t.deposits.length} deposit accounts, ${t.histLoan.length} loan history rows, ${rm.interactions.length} interactions in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  await admin.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
