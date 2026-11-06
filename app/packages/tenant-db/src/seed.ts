// Creates one schema per synthetic tenant and loads it (spec 13.6 tenancy, 27.2 test tenants).
// Usage: npm run db:seed   (idempotent: drops and recreates each tenant schema)
import { generateFfiecCallReport } from './ffiecCallReport.ts';
import mysql from 'mysql2/promise';
import { ADMIN_DB_URL, DEFAULT_DB_URL, dbSsl } from './db.ts';
import { AS_OF, BUILD, generate, TENANTS } from './generate.ts';
import { DATALOG_TYPES, generateModules, MODULE_FIXTURES, MODULES_DDL, MODULES_WRITE_TABLES } from './modules.ts';
import { generateGovernance, GOVERNANCE_APPEND_TABLES, GOVERNANCE_DDL } from './governance.ts';
import { GROWTH_DDL, GROWTH_WRITE_TABLES, seedGrowth } from './growth.ts';
import { TASKS_DDL, TASKS_WRITE_TABLES, seedTasks } from './tasks.ts';
import { WORKFLOW_DEF_DDL, WORKFLOW_DEF_WRITE_TABLES, seedWorkflowDefs } from './workflowDefs.ts';
import { WORKSPACE_DDL, WORKSPACE_WRITE_TABLES, seedWorkspace } from './workspace.ts';
import { CALENDAR_SERIES_DDL, CALENDAR_SERIES_WRITE_TABLES } from './workspace.ts';
import { TABLES_DDL, TABLES_WRITE_TABLES, seedTables } from './tables.ts';
import { generateGoals, GI_GOALS, GI_INCENTIVES, GI_TIERS, GOALS_DDL, GOALS_WRITE_TABLES } from './goals.ts';
import { generatePipeline, LAP_APPLICATION_COLUMNS, LAP_HOLDS, LAP_STATUSES, PIPELINE_DDL, PIPELINE_WRITE_TABLES } from './pipeline.ts';
import { generateRelationship, RELATIONSHIP_DDL } from './relationship.ts';
import { generateMemberHistory } from './membership.ts';
import { BENCHMARK_DDL, BUDGET_WRITE_TABLES, benchmarks, budgetSeed } from './benchmarks.ts';
import { reportSeed } from './reports.ts';
import { CR_FILING, generateCallReport } from './callReport.ts';
import { NOTIFY_DDL, NOTIFY_WRITE_TABLES } from './notifications.ts';
import { TENANT_DDL } from './schema.ts';
import { createSourceTables, seedCoreReplica } from './sources.ts';
import { createApiTables } from './apis.ts';
import { createOffcoreTables } from './offcore.ts';
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
    await insert(admin, 'cdm_loan', ['loan_id', 'party_id', 'branch_id', 'officer_id', 'loan_category', 'is_indirect', 'open_date', 'close_date', 'charge_off_date', 'original_amount', 'balance', 'rate', 'days_delinquent', 'credit_score', 'ltv', 'term_months', 'risk_rating'], t.loans);
    await insert(admin, 'cdm_deposit_account', ['account_id', 'party_id', 'branch_id', 'deposit_category', 'open_date', 'close_date', 'maturity_date', 'balance', 'rate'], t.deposits);
    await insert(admin, 'hist_loan_month', ['month_end', 'branch_id', 'loan_category', 'is_indirect', 'balance', 'delinquent_60_balance', 'loan_count', 'new_loan_amount', 'new_loan_count', 'new_rate_weighted'], t.histLoan);
    await insert(admin, 'hist_deposit_month', ['month_end', 'branch_id', 'deposit_category', 'balance', 'account_count', 'rate_weighted'], t.histDeposit);
    await insert(admin, 'mkt_rate_month', ['month_end', 'fed_funds'], t.marketRates);
    await insert(admin, 'hist_party_month', ['month_end', 'branch_id', 'member_count', 'new_member_count', 'closed_member_count'], t.histParty);
    await insert(admin, 'cdm_membership_exit', ['party_id', 'branch_id', 'join_date', 'close_date', 'birth_date', 'segment_code', 'reason'], t.exits);
    await insert(admin, 'hist_loan_dq_month', ['month_end', 'branch_id', 'loan_category', 'is_indirect', 'vintage_year', 'bucket', 'balance', 'loan_count'], t.histDq);
    await insert(admin, 'hist_loan_roll_month', ['month_end', 'branch_id', 'loan_category', 'from_bucket', 'to_bucket', 'balance', 'loan_count'], t.histRoll);
    await insert(admin, 'meta_build', ['build_id', 'as_of_date', 'completed_at', 'state'], [[BUILD.buildId, AS_OF, BUILD.completedAt, 'completed']]);
    for (const ddl of RELATIONSHIP_DDL) await admin.query(ddl);
    const rm = generateRelationship(t);
    await insert(admin, 'cdm_party_contact', ['party_id', 'email', 'phone', 'preferred_channel'], rm.contacts);
    await insert(admin, 'cdm_digital_usage', ['party_id', 'online_banking_since', 'mobile_since', 'mobile_deposit_since', 'estatements_since', 'bill_pay_since', 'direct_deposit_status', 'direct_deposit_changed', 'last_login'], rm.digital);
    await insert(admin, 'hist_member_month', ['month_end', 'branch_id', 'age_band', 'member_count', 'with_checking', 'with_loan', 'with_direct_deposit', 'digital_active', 'product_count'], generateMemberHistory(t, rm.digital));
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
    for (const ddl of BENCHMARK_DDL) await admin.query(ddl);
    await insert(admin, 'fin_benchmark', ['kind', 'metric', 'value', 'source'], benchmarks(profile.institutionType));
    const budget = budgetSeed(profile.institutionType);
    await insert(admin, 'fin_budget', ['year', 'metric', 'value', 'status', 'note', 'updated_by', 'approval_id'], budget.lines);
    await insert(admin, 'fin_budget_event', ['year', 'action', 'detail', 'by_name', 'at', 'approval_id'], budget.events);
    for (const ddl of MODULES_DDL) await admin.query(ddl);
    const mods = generateModules(t, profile.institutionType);
    await insert(admin, 'cpm_issue', ['issue_id', 'party_id', 'kind', 'source', 'category', 'summary', 'status', 'owner_employee_id', 'branch_id', 'opened', 'respond_by', 'resolve_by', 'closed', 'resolution', 'root_cause'], mods.issues);
    await insert(admin, 'cpm_issue_history', ['issue_id', 'at', 'actor', 'action', 'note'], mods.history);
    await insert(admin, 'onb_task', ['task_id', 'party_id', 'touch', 'day_offset', 'due', 'status', 'assignee_employee_id', 'branch_id', 'done_on', 'note'], mods.tasks);
    await insert(admin, 'esp_datalog_type', ['type_id', 'label', 'financial', 'requires_approval'], DATALOG_TYPES.map((x) => [...x]));
    await insert(admin, 'esp_datalog', ['log_id', 'type_id', 'title', 'amount', 'branch_id', 'status', 'created_by', 'created_name', 'created_on'], mods.logs);
    await insert(admin, 'esp_datalog_history', ['log_id', 'at', 'actor', 'from_status', 'to_status', 'note'], mods.logHistory);
    const fx = MODULE_FIXTURES;
    await insert(admin, 'ops_upload', ['source', 'due_by', 'arrived', 'late'], fx.uploads);
    await insert(admin, 'ops_dq_check', ['domain', 'dimension', 'name', 'status', 'rows_failed'], fx.checks);
    await insert(admin, 'iam_user', ['user_id', 'name', 'user_class', 'branch', 'status'], [...fx.classes.map((c) => [...c, 'Active']), ...(t.employees as [number, string, string, number][]).filter((e) => e[0] > 6).map((e) => [`emp:${e[0]}`, e[1], e[2] === 'Loan officer' ? 'Lender' : e[2] === 'Branch manager' ? 'Manager' : 'MSR', String(t.locations[e[3] - 1]![1]), 'Active']), ['emp:2', 'Tom Walsh', 'Lender', 'Westport', 'Active']]);
    if (profile.institutionType === 'bank') {
      // A bank files the FFIEC 051 Call Report: the same tables, keyed by MDRM item code.
      const ff = generateFfiecCallReport(t);
      await insert(admin, 'cr_line', ['code', 'schedule', 'schedule_name', 'section', 'sort_order', 'name', 'kind', 'formula', 'source'], ff.lines);
      await insert(admin, 'cr_value', ['code', 'quarter_end', 'amount', 'text_value'], ff.values);
      await insert(admin, 'cr_check', ['name', 'status', 'detail', 'severity', 'edit_code', 'codes'], ff.checks);
      await insert(admin, 'cr_explanation', ['code', 'quarter_end', 'explanation', 'status', 'written_by'], ff.explanations);
      await insert(admin, 'cr_gl_account', ['gl_number', 'name', 'balance', 'prior_balance', 'line_code', 'opened', 'last_posted', 'likely_line', 'note'], ff.gl);
      await insert(admin, 'cr_form', ['form', 'edition', 'filed_in', 'quarter', 'due_date', 'preparer'], ff.form);
    }
    if (profile.institutionType === 'credit_union') {
      const cr = generateCallReport(t);
      await insert(admin, 'cr_line', ['code', 'schedule', 'schedule_name', 'section', 'sort_order', 'name', 'kind', 'formula', 'source'], cr.lines);
      await insert(admin, 'cr_value', ['code', 'quarter_end', 'amount', 'text_value'], cr.values);
      await insert(admin, 'cr_check', ['name', 'status', 'detail', 'severity', 'edit_code', 'codes'], cr.checks);
      await insert(admin, 'cr_explanation', ['code', 'quarter_end', 'explanation', 'status', 'written_by'], cr.explanations);
      await insert(admin, 'cr_gl_account', ['gl_number', 'name', 'balance', 'prior_balance', 'line_code', 'opened', 'last_posted', 'likely_line', 'note'], cr.gl);
      await insert(admin, 'cr_form', ['form', 'edition', 'filed_in', 'quarter', 'due_date', 'preparer'], [['5300', CR_FILING.edition, 'CUOnline', CR_FILING.quarter, CR_FILING.dueDate, CR_FILING.preparer]]);
      await insert(admin, 'seg_company', ['company_id', 'name', 'stage', 'members', 'new_members', 'loans', 'deposits', 'owner', 'sponsorship'], fx.companies);
      await insert(admin, 'seg_interaction', ['company_id', 'at', 'kind', 'note', 'by_name'], fx.interactions);
    }
    await insert(admin, 'cmp_campaign', ['campaign_id', 'name', 'channel', 'product', 'sent', 'applications', 'loan_dollars', 'control_size', 'control_responders', 'cost', 'deposit_dollars', 'launched'], fx.campaigns);
    for (const ddl of WORKFLOW_DDL) await admin.query(ddl);
    for (const ddl of GOVERNANCE_DDL) await admin.query(ddl);
    for (const ddl of GROWTH_DDL) await admin.query(ddl);
    await seedGrowth(admin);
    for (const ddl of TASKS_DDL) await admin.query(ddl);
    await seedTasks(admin);
    for (const ddl of WORKFLOW_DEF_DDL) await admin.query(ddl);
    await seedWorkflowDefs(admin);
    for (const ddl of WORKSPACE_DDL) await admin.query(ddl);
    await seedWorkspace(admin);
    // Repeating calendar events, and saved views and snapshots in Tables.
    for (const ddl of CALENDAR_SERIES_DDL) await admin.query(ddl);
    for (const ddl of TABLES_DDL) await admin.query(ddl);
    await seedTables(admin);
    // Email notifications: the simulated outbox and preferences start empty.
    for (const ddl of NOTIFY_DDL) await admin.query(ddl);
    for (const table of NOTIFY_WRITE_TABLES) await admin.query(`GRANT INSERT, UPDATE ON \`${profile.schema}\`.\`${table}\` TO 'dinext'@'%'`);
    const usage = generateGovernance();
    await insert(admin, 'ai_run', ['run_id', 'at', 'user_id', 'thread_id', 'agent', 'intent', 'mode', 'question', 'outcome', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cost_usd', 'tool_calls', 'source'], usage.runs);
    await insert(admin, 'ai_approvals', ['approval_id', 'operation', 'payload', 'payload_hash', 'risk_tier', 'requested_by', 'run_id', 'thread_id', 'status', 'created_at', 'expires_at', 'decided_by', 'decided_at', 'channel'], usage.approvals);
    const wf = workflowSeed(profile, t.employees);
    await insert(admin, 'mod_ref_types', ['type_id', 'category', 'label', 'description', 'route_rule', 'fields', 'active'], wf.types);
    await insert(admin, 'esp_com_queues', ['queue_id', 'name', 'branch_id', 'member_employee_ids', 'rr_pointer'], wf.queues);
  const firstBranch = (t.parties as unknown[][]).filter((p) => p[5] === 1 && p[0] !== 1).slice(0, 5).map((p) => p[0] as number);
  await insert(admin, 'esp_com_items', ['definition', 'type_id', 'party_id', 'fields', 'notes', 'stage', 'priority', 'sender_user_id', 'sender_name', 'to_queue_id', 'assignee_employee_id', 'routing', 'created_at'], referralSeed(firstBranch));
    await insert(admin, 'esp_report_templates', ['template_id', 'name', 'folder', 'status', 'owner_user_id', 'owner_name', 'definition', 'origin', 'version', 'thread_id', 'approval_id', 'created_at', 'updated_at'], reportSeed(profile.institutionType));
    // The application account reads tenant data only (spec 26.2: read-only on customer tables), and
    // writes only the workflow store, through approved DI Core operations.
    await admin.query(`GRANT SELECT ON \`${profile.schema}\`.* TO 'dinext'@'%'`);
    for (const table of [...WORKFLOW_WRITE_TABLES, ...PIPELINE_WRITE_TABLES, ...GOALS_WRITE_TABLES, ...MODULES_WRITE_TABLES, ...GROWTH_WRITE_TABLES, ...TASKS_WRITE_TABLES, ...WORKFLOW_DEF_WRITE_TABLES, ...WORKSPACE_WRITE_TABLES, ...CALENDAR_SERIES_WRITE_TABLES, ...TABLES_WRITE_TABLES, ...BUDGET_WRITE_TABLES]) await admin.query(`GRANT INSERT, UPDATE ON \`${profile.schema}\`.\`${table}\` TO 'dinext'@'%'`);
    // Add-only: a run record or a rating can't be changed once written (AI-GRD-090).
    for (const table of GOVERNANCE_APPEND_TABLES) await admin.query(`GRANT INSERT ON \`${profile.schema}\`.\`${table}\` TO 'dinext'@'%'`);
    // Direct core connections: DI's store for every tenant, and a Symitar-style replica for the credit union.
    await createSourceTables(admin, profile.schema);
    // API connections: DI's store, and the simulated marketing platform with the campaigns it already ran.
    await createApiTables(admin, profile.schema);
    // Off-core loans: DI's store, and the build account that publishes them into cdm_loan.
    await createOffcoreTables(admin, profile.schema);
    if (profile.institutionType === 'credit_union') await seedCoreReplica(admin, profile.schema);
    console.log(`${profile.key}: ${t.parties.length} parties, ${t.loans.length} loans, ${t.deposits.length} deposit accounts, ${t.histLoan.length} loan history rows, ${rm.interactions.length} interactions in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  await admin.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
