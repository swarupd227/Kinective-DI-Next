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
import { BENCHMARK_DDL, BUDGET_WRITE_TABLES, benchmarks, budgetSeed, capitalPlanSeed, ceclSeed, shareSeed } from './benchmarks.ts';
import { reportSeed } from './reports.ts';
import { CR_FILING, generateCallReport } from './callReport.ts';
import { preparedFigures } from './callReportTree.ts';
import { GL_DDL, generateGl } from './gl.ts';
import { SALES_GOALS_DDL, generateSalesGoals } from './salesGoals.ts';
import { CAMPAIGN_HISTORY_DDL, attribution, earlierCampaigns } from './campaignHistory.ts';
import { SEG_DETAIL_DDL, SEG_DETAIL_WRITE_TABLES, generateSegDetail } from './segDetail.ts';
import { MEMBER360_EXTRA_DDL, MEMBER360_EXTRA_WRITE_TABLES, generateMember360Extra } from './member360Extra.ts';
import { ONB_DESK_DDL, ONB_DESK_UPDATES, ONB_DESK_WRITE_TABLES, generateOnboardingDesk } from './onboardingDesk.ts';
import { CR_EXTRA_DDL, CR_EXTRA_WRITE_TABLES } from './cr5300Extra.ts';
import { ESP_ORIGINATION_DDL, generateOrigination } from './espOrigination.ts';
import { ESP_PRODUCT_DDL, generateProducts } from './espProducts.ts';
import { ESP_ORG_DDL, generateOrg } from './espOrg.ts';
import { ESP_TXN_DDL, generateTransactions30 } from './espTransactions.ts';
import { ESP_OWNER_DDL, generateOwners } from './espOwners.ts';
import { ONB_JOURNEY_DDL, ONB_JOURNEY_WRITE_TABLES, generateOnboardingJourney } from './onboardingJourney.ts';
import { NOTIFY_DDL, NOTIFY_WRITE_TABLES } from './notifications.ts';
import { TENANT_DDL } from './schema.ts';
import { createSourceTables, seedCoreReplica } from './sources.ts';
import { createApiTables } from './apis.ts';
import { createOffcoreTables } from './offcore.ts';
import { ML_DDL, ML_WRITE_TABLES, SNAPSHOT_COLUMNS, generateSnapshots } from './ml.ts';
import { DECISION_TABLE_COLUMNS, DMN_DDL, DMN_WRITE_TABLES, decisionTableRows } from './dmn.ts';
import { referralHistory, referralSeed, WORKFLOW_DDL, WORKFLOW_WRITE_TABLES, workflowSeed } from './workflow.ts';
import { generateTransactions, LOAN_GROWTH_DDL, LOAN_GROWTH_WRITE_TABLES, planLoanGrowth } from './loanGrowth.ts';
import { CONCENTRATION_DDL, generateLoanDetail } from './concentration.ts';
import { BSA_DDL, generateBsa } from './bsa.ts';
import { seedBranchOps } from './branchOps.ts';
import { generateOpRisk, OPRISK_DDL } from './oprisk.ts';

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
    // A credit union's members who borrow elsewhere, and the July refinance campaign's loans, before loans load.
    const growthPlan = profile.institutionType === 'credit_union' ? planLoanGrowth(t) : null;
    await insert(admin, 'cdm_location', ['int_id', 'name', 'region', 'opened_date'], t.locations);
    await insert(admin, 'cdm_employee', ['employee_id', 'display_name', 'role', 'branch_id'], t.employees);
    await insert(admin, 'cdm_party', ['party_id', 'first_name', 'last_name', 'birth_date', 'join_date', 'primary_branch_id', 'segment_code', 'household_id', 'is_member'], t.parties);
    await insert(admin, 'cdm_loan', ['loan_id', 'party_id', 'branch_id', 'officer_id', 'loan_category', 'is_indirect', 'open_date', 'close_date', 'charge_off_date', 'original_amount', 'balance', 'rate', 'days_delinquent', 'credit_score', 'ltv', 'term_months', 'risk_rating'], t.loans);
    // A bank's commercial loan detail for concentration reviews: property type, county, industry, maturity.
    for (const ddl of CONCENTRATION_DDL) await admin.query(ddl);
    if (profile.institutionType === 'bank') await insert(admin, 'cdm_loan_detail', ['loan_id', 'property_type', 'owner_occupied', 'county', 'state', 'naics_sector', 'industry', 'maturity_date', 'dscr', 'appraised_value', 'appraisal_date', 'relationship_id'], generateLoanDetail(t));
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
    await insert(admin, 'cdm_card', ['card_id', 'party_id', 'kind', 'last4', 'status', 'opened', 'activated', 'closed', 'account_id'], rm.cards);
    await insert(admin, 'cdm_suggestion_history', ['run_date', 'party_id', 'product', 'likelihood', 'opened_date'], rm.history);
    const lap = generatePipeline(t, rm.applications);
    await insert(admin, 'cdm_loan_application', LAP_APPLICATION_COLUMNS, lap.applications);
    await insert(admin, 'cdm_interaction', ['interaction_id', 'party_id', 'occurred_at', 'channel', 'kind', 'summary', 'employee_id'], rm.interactions);
    await insert(admin, 'cdm_account_activity', ['account_kind', 'account_id', 'balance_30d', 'fees_30d'], rm.activity);
    // The rest of Member 360: 90-day activity and fees, surveys, account comments and warnings, rewards.
    for (const ddl of MEMBER360_EXTRA_DDL) await admin.query(ddl);
    const m360 = generateMember360Extra(t.parties as unknown[][], rm.digital as unknown[][], t.deposits as unknown[][], t.loans as unknown[][], rm.activity as unknown[][]);
    await insert(admin, 'cdm_party_activity', ['party_id', 'logins_90d', 'mobile_logins_90d', 'bill_payments_90d', 'mobile_deposits_90d', 'fees_90d'], m360.partyActivity);
    await insert(admin, 'cdm_survey', ['party_id', 'survey_date', 'kind', 'score', 'comment'], m360.surveys);
    await insert(admin, 'cdm_account_comment', ['party_id', 'account_id', 'kind', 'code', 'text', 'created', 'created_by', 'active'], m360.comments);
    await insert(admin, 'rwd_member', ['party_id', 'tier', 'points', 'enrolled_on'], m360.rewards);
    await insert(admin, 'rwd_ledger', ['party_id', 'posted', 'description', 'points'], m360.ledger);
    // ESP alignment, step 1: who opened each account and where, and credit score history. Tables of their own.
    for (const ddl of ESP_ORIGINATION_DDL) await admin.query(ddl);
    const esp1 = generateOrigination(t.employees as unknown[][], (t.locations as unknown[][]).length, t.loans as unknown[][], t.deposits as unknown[][]);
    await insert(admin, 'cdm_account_origination', ['account_kind', 'account_id', 'opened_by_employee_id', 'originating_branch_id', 'channel'], esp1.origination);
    await insert(admin, 'cdm_credit_score_history', ['party_id', 'as_of', 'score_type', 'score', 'source'], esp1.history);
    // ESP alignment, step 2: loan and share products, and which product each account is.
    for (const ddl of ESP_PRODUCT_DDL) await admin.query(ddl);
    const esp2 = generateProducts(profile.institutionType, t.loans as unknown[][], t.deposits as unknown[][]);
    await insert(admin, 'cdm_loan_product', ['product_id', 'name', 'loan_category', 'reg_amount_code', 'reg_count_code', 'secured', 'revolving'], esp2.loanProducts);
    await insert(admin, 'cdm_deposit_product', ['product_id', 'name', 'deposit_category', 'interest_bearing', 'minimum_balance', 'monthly_fee'], esp2.depositProducts);
    await insert(admin, 'cdm_account_product', ['account_kind', 'account_id', 'product_id'], esp2.accounts);
    // ESP alignment, step 3: the org hierarchy, institution to region to branch.
    for (const ddl of ESP_ORG_DDL) await admin.query(ddl);
    await insert(admin, 'cdm_org_unit', ['unit_id', 'name', 'level', 'parent_id', 'branch_id'], generateOrg(profile.name, t.locations as unknown[][]));
    // ESP alignment, step 4: the last 30 days of loan and share transactions, with their codes.
    for (const ddl of ESP_TXN_DDL) await admin.query(ddl);
    const productFee = new Map(esp2.depositProducts.map((p) => [p[0] as string, Number(p[5])]));
    const accountFee = new Map(esp2.accounts.filter((a) => a[0] === 'deposit').map((a) => [a[1] as number, productFee.get(a[2] as string) ?? 0]));
    const esp4 = generateTransactions30(t.deposits as unknown[][], t.loans as unknown[][], accountFee);
    await insert(admin, 'cdm_transaction_code', ['code', 'description', 'direction', 'fee_type'], esp4.codes);
    await insert(admin, 'cdm_share_transaction', ['txn_id', 'account_id', 'party_id', 'posted', 'code', 'amount', 'channel', 'branch_id'], esp4.share);
    await insert(admin, 'cdm_loan_transaction', ['txn_id', 'loan_id', 'party_id', 'posted', 'code', 'amount', 'principal', 'interest', 'channel'], esp4.loan);
    // ESP alignment, step 5: who is on each account and in what role. Totals keep counting the primary owner.
    for (const ddl of ESP_OWNER_DDL) await admin.query(ddl);
    await insert(admin, 'cdm_account_owner', ['account_kind', 'account_id', 'party_id', 'role'], generateOwners(t.parties as unknown[][], t.deposits as unknown[][], t.loans as unknown[][]));
    // Predictive models: each member at each of the last 12 month-ends, and where models and scores are kept.
    for (const ddl of ML_DDL) await admin.query(ddl);
    await insert(admin, 'hist_member_snapshot', SNAPSHOT_COLUMNS, generateSnapshots(t, rm));
    // Decision tables people can change, each starting at version 1.
    for (const ddl of DMN_DDL) await admin.query(ddl);
    await insert(admin, 'dmn_table_version', DECISION_TABLE_COLUMNS, decisionTableRows(profile.institutionType, BUILD.completedAt));
    for (const ddl of LOAN_GROWTH_DDL) await admin.query(ddl);
    for (const ddl of BSA_DDL) await admin.query(ddl);
    for (const ddl of OPRISK_DDL) await admin.query(ddl);
    if (profile.institutionType === 'bank') {
      // The information security officer's register: incidents, vendors, controls, measures, tests and insurance.
      const ops = generateOpRisk();
      await insert(admin, 'ops_incident', ['incident_id', 'opened', 'category', 'severity', 'summary', 'downtime_minutes', 'customers_affected', 'loss', 'notification_incident', 'determined_at', 'notified_at', 'status'], ops.incidents);
      await insert(admin, 'ops_vendor', ['vendor', 'service', 'criticality', 'last_review', 'next_review', 'soc_report_date', 'soc_opinion', 'exit_plan', 'note'], ops.vendors);
      await insert(admin, 'ops_control', ['control', 'csf_function', 'status', 'target_date', 'note'], ops.controls);
      await insert(admin, 'ops_metric', ['month', 'metric', 'value'], ops.metrics);
      await insert(admin, 'ops_test', ['test', 'kind', 'tested_on', 'result', 'rto_target_hours', 'rto_actual_hours', 'findings_open', 'note'], ops.tests);
      await insert(admin, 'ops_insurance', ['coverage', 'carrier', 'limit_amount', 'retention', 'premium', 'renewal', 'note'], ops.insurance);
    }
    if (profile.institutionType === 'bank') {
      // The BSA officer's case system and the fraud team's records.
      const bsa = generateBsa(t.parties.length);
      await insert(admin, 'bsa_alert', ['alert_id', 'opened', 'source', 'typology', 'party_id', 'amount', 'status', 'closed', 'sar_id'], bsa.alerts);
      await insert(admin, 'bsa_sar', ['sar_id', 'detected_on', 'filed_on', 'typology', 'amount', 'continuing', 'party_id', 'next_review', 'reviewed_on'], bsa.sars);
      await insert(admin, 'bsa_ctr', ['month', 'filed', 'late', 'exempt_customers'], bsa.ctr);
      await insert(admin, 'bsa_ofac', ['month', 'screened', 'potential', 'true_matches', 'blocked_amount', 'rejected_amount'], bsa.ofac);
      await insert(admin, 'bsa_customer_risk', ['party_id', 'rating', 'category', 'last_review', 'next_review'], bsa.risk);
      await insert(admin, 'fraud_case', ['case_id', 'opened', 'fraud_type', 'channel', 'party_id', 'gross_loss', 'recovered', 'prevented', 'elder', 'status'], bsa.fraud);
      await insert(admin, 'bsa_program', ['item', 'area', 'status', 'as_of', 'due', 'detail'], bsa.program);
    }
    // A credit union's branch operations: teller balancing, vault, lobby, CTRs and referrals, fraud, audits, training and staff.
    if (profile.institutionType === 'credit_union') await seedBranchOps(admin, profile.schema);
    if (growthPlan) {
      await insert(admin, 'cdm_transaction', ['txn_id', 'account_id', 'party_id', 'post_date', 'amount', 'txn_type', 'description', 'counterparty'], generateTransactions(growthPlan, t, rm.digital));
      await insert(admin, 'lg_campaign', ['campaign_id', 'name', 'segments', 'holdout_pct', 'treatment', 'control', 'status', 'created_by', 'created_on', 'sent_on', 'push_id', 'approval_id'], growthPlan.campaign);
      await insert(admin, 'lg_campaign_member', ['campaign_id', 'party_id', 'segment', 'arm', 'lender', 'est_monthly_saving'], growthPlan.members);
    }
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
    // Loan goals by channel (minimum and stretch) and sales contests.
    for (const ddl of SALES_GOALS_DDL) await admin.query(ddl);
    const sales = generateSalesGoals(t, profile.institutionType === 'bank');
    await insert(admin, 'fin_loan_goal', ['year', 'channel', 'minimum', 'stretch', 'sort_order'], sales.goals);
    await insert(admin, 'gi_contest', ['contest_id', 'name', 'categories', 'metric', 'by_level', 'starts', 'ends', 'prize'], sales.contests);
    await insert(admin, 'cdm_gi_credit', ['goal_id', 'employee_id', 'period_end', 'occurred', 'label', 'value', 'state'], gi.credits);
    await insert(admin, 'mod_gi_adjustment', ['employee_id', 'period_end', 'amount', 'reason_code', 'note', 'status', 'created_by'], gi.adjustments);
    for (const ddl of BENCHMARK_DDL) await admin.query(ddl);
    await insert(admin, 'fin_benchmark', ['kind', 'metric', 'value', 'source'], benchmarks(profile.institutionType));
    const budget = budgetSeed(profile.institutionType);
    await insert(admin, 'fin_budget', ['year', 'metric', 'value', 'status', 'note', 'updated_by', 'approval_id'], budget.lines);
    await insert(admin, 'fin_budget_event', ['year', 'action', 'detail', 'by_name', 'at', 'approval_id'], budget.events);
    const shares = shareSeed(profile.institutionType);
    if (shares.length) await insert(admin, 'fin_share', ['quarter_end', 'shares_outstanding', 'weighted_shares', 'price', 'source', 'entered_by', 'approval_id'], shares);
    const cecl = ceclSeed(profile.institutionType);
    if (cecl.length) await insert(admin, 'fin_cecl', ['setting', 'value', 'note', 'updated_by', 'approval_id'], cecl);
    const capPlan = capitalPlanSeed(profile.institutionType);
    if (capPlan.length) await insert(admin, 'fin_capital_plan', ['setting', 'value', 'note', 'updated_by', 'approval_id'], capPlan);
    for (const ddl of MODULES_DDL) await admin.query(ddl);
    const mods = generateModules(t, profile.institutionType);
    await insert(admin, 'cpm_issue', ['issue_id', 'party_id', 'kind', 'source', 'category', 'summary', 'status', 'owner_employee_id', 'branch_id', 'opened', 'respond_by', 'resolve_by', 'closed', 'resolution', 'root_cause'], mods.issues);
    await insert(admin, 'cpm_issue_history', ['issue_id', 'at', 'actor', 'action', 'note'], mods.history);
    await insert(admin, 'onb_task', ['task_id', 'party_id', 'touch', 'day_offset', 'due', 'status', 'assignee_employee_id', 'branch_id', 'done_on', 'note'], mods.tasks);
    // Onboarding's touch types and priorities, subscriptions, follow-up rules, and members' employment, leisure and life events.
    for (const ddl of ONB_DESK_DDL) await admin.query(ddl);
    for (const sql of ONB_DESK_UPDATES) await admin.query(sql);
    const onbDesk = generateOnboardingDesk(t.parties as unknown[][], mods.tasks as unknown[][]);
    await insert(admin, 'onb_subscription', ['party_id', 'subscribed', 'changed'], onbDesk.subscriptions);
    await insert(admin, 'onb_rule', ['name', 'group_name', 'condition_code', 'after_day', 'touch', 'touch_type', 'priority', 'active', 'created_by', 'created_on', 'copied_from', 'approval_id'], onbDesk.rules);
    await insert(admin, 'cdm_party_profile', ['party_id', 'employer', 'occupation', 'income_band', 'years_employed', 'interests', 'life_events', 'goals'], onbDesk.profiles);
    // The onboarding journey: messages the scheduled process sent and opened, and touch-point checklists.
    for (const ddl of ONB_JOURNEY_DDL) await admin.query(ddl);
    const journey = generateOnboardingJourney(t, mods.tasks as unknown[][], rm.digital as unknown[][]);
    await insert(admin, 'onb_message', ['party_id', 'step', 'channel', 'day_offset', 'sent_on', 'opened', 'clicked'], journey.messages);
    await insert(admin, 'onb_checklist', ['task_id', 'debit_card_activated', 'online_banking', 'mobile_app', 'estatements', 'bill_pay', 'direct_deposit', 'perks_reviewed', 'loans_discussed', 'referral_made', 'recorded_by', 'recorded_on'], journey.checklists);
    await insert(admin, 'esp_datalog_type', ['type_id', 'label', 'financial', 'requires_approval'], DATALOG_TYPES.map((x) => [...x]));
    await insert(admin, 'esp_datalog', ['log_id', 'type_id', 'title', 'amount', 'branch_id', 'status', 'created_by', 'created_name', 'created_on'], mods.logs);
    await insert(admin, 'esp_datalog_history', ['log_id', 'at', 'actor', 'from_status', 'to_status', 'note'], mods.logHistory);
    const fx = MODULE_FIXTURES;
    await insert(admin, 'ops_upload', ['source', 'due_by', 'arrived', 'late'], fx.uploads);
    await insert(admin, 'ops_dq_check', ['domain', 'dimension', 'name', 'status', 'rows_failed'], fx.checks);
    await insert(admin, 'iam_user', ['user_id', 'name', 'user_class', 'branch', 'status'], [...fx.classes.map((c) => [...c, 'Active']), ...(t.employees as [number, string, string, number][]).filter((e) => e[0] > 6).map((e) => [`emp:${e[0]}`, e[1], e[2] === 'Loan officer' ? 'Lender' : e[2] === 'Branch manager' ? 'Manager' : 'MSR', String(t.locations[e[3] - 1]![1]), 'Active']), ['emp:2', 'Tom Walsh', 'Lender', 'Westport', 'Active']]);
    // SEG detail tables exist for every tenant (granted below); only a credit union fills them.
    for (const ddl of SEG_DETAIL_DDL) await admin.query(ddl);
    // 5300 per-loan overrides and charge-off uploads exist for every tenant; a bank's are simply empty.
    for (const ddl of CR_EXTRA_DDL) await admin.query(ddl);
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
      // The credit union's own prepared 5300, uploaded to check DI's against, and one difference already settled.
      const shapes = (cr.lines as unknown[][]).map((l) => ({ code: l[0] as string, schedule: l[1] as string, section: l[3] as string, name: l[5] as string, kind: l[6] as string, formula: (l[7] as string | null) ?? null }));
      const prepared = preparedFigures(shapes, cr.values as unknown[][]);
      await insert(admin, 'cr_prepared', ['code', 'quarter_end', 'amount'], prepared.rows);
      await insert(admin, 'cr_prepared_upload', ['quarter_end', 'file_name', 'uploaded_by', 'uploaded_at', 'line_count'], [[prepared.quarter, '5300_Q3_2026_prepared.xlsx', 'Priya Shah', '2026-10-21 16:40:00', prepared.rows.length]]);
      await insert(admin, 'cr_resolution', ['code', 'quarter_end', 'resolution', 'reason', 'decided_by', 'decided_at', 'approval_id'], [['013', prepared.quarter, 'Explained', 'Share drafts presented September 30 cleared after DI’s build; the core matches on the October 1 build. No change.', 'Priya Shah', '2026-10-22 09:15:00', null]]);
      await insert(admin, 'seg_company', ['company_id', 'name', 'stage', 'members', 'new_members', 'loans', 'deposits', 'owner', 'sponsorship'], fx.companies);
      await insert(admin, 'seg_interaction', ['company_id', 'at', 'kind', 'note', 'by_name'], fx.interactions);
      // SEG detail: contacts and follow-ups, events, six months of BD activity, and the BD scorecard goals.
      const segDetail = generateSegDetail(fx.companies as unknown[][], (t.locations as unknown[][]).map((l) => String(l[1])));
      await insert(admin, 'seg_contact', ['company_id', 'contact_name', 'title', 'phone', 'email', 'branch', 'bd_manager', 'active', 'employees', 'next_follow_up', 'follow_up_note'], segDetail.contacts);
      await insert(admin, 'seg_event', ['company_id', 'held', 'kind', 'attendees', 'new_members', 'new_checking', 'new_loan_dollars', 'referrals', 'by_name'], segDetail.events);
      await insert(admin, 'seg_interaction', ['company_id', 'at', 'kind', 'note', 'by_name'], segDetail.interactions);
      await insert(admin, 'seg_bd_goal', ['metric', 'label', 'monthly_target', 'unit', 'sort_order'], segDetail.goals);
      await insert(admin, 'seg_note', ['company_id', 'at', 'by_name', 'text'], segDetail.notes);
      await insert(admin, 'seg_sponsorship', ['company_id', 'given_on', 'kind', 'amount', 'description', 'approved_by'], segDetail.sponsorships);
    }
    {
      // The general ledger behind the Call Report: statements, budget by cost center, journal entries.
      const glSource = profile.institutionType === 'bank' ? generateFfiecCallReport(t).gl : generateCallReport(t).gl;
      const gl = generateGl(t, glSource as unknown[][], profile.institutionType === 'bank');
      for (const ddl of GL_DDL) await admin.query(ddl);
      await insert(admin, 'gl_company', ['company_id', 'name', 'kind'], gl.companies);
      await insert(admin, 'gl_account', ['company_id', 'gl_number', 'name', 'type', 'statement', 'grp', 'sort_order'], gl.accounts);
      await insert(admin, 'gl_cost_center', ['cost_center', 'name', 'department'], gl.costCenters);
      await insert(admin, 'gl_balance_month', ['month_end', 'company_id', 'gl_number', 'cost_center', 'amount'], gl.months);
      await insert(admin, 'gl_balance_day', ['day', 'company_id', 'gl_number', 'balance'], gl.days);
      await insert(admin, 'gl_budget', ['month_end', 'gl_number', 'cost_center', 'amount'], gl.budget);
      await insert(admin, 'gl_journal', ['je_id', 'posted', 'company_id', 'gl_number', 'cost_center', 'debit', 'credit', 'description', 'source', 'ticket', 'offset_gl', 'posted_by'], gl.journal);
    }
    // The current campaigns and a year of earlier ones, and the accounts each one is credited with.
    const allCampaigns = [...(fx.campaigns as unknown[][]), ...earlierCampaigns(fx.campaigns.length + 1)];
    await insert(admin, 'cmp_campaign', ['campaign_id', 'name', 'channel', 'product', 'sent', 'applications', 'loan_dollars', 'control_size', 'control_responders', 'cost', 'deposit_dollars', 'launched'], allCampaigns);
    for (const ddl of CAMPAIGN_HISTORY_DDL) await admin.query(ddl);
    await insert(admin, 'cmp_attribution', ['campaign_id', 'party_id', 'account_kind', 'account_id', 'product', 'opened', 'amount'], attribution(t, allCampaigns));
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
  await insert(admin, 'esp_com_items', ['definition', 'type_id', 'party_id', 'fields', 'notes', 'stage', 'priority', 'sender_user_id', 'sender_name', 'sender_employee_id', 'to_queue_id', 'assignee_employee_id', 'routing', 'created_at'], referralSeed(firstBranch));
  // A year of referral history for reporting: sales tied to accounts opened, declines, expiries.
  await insert(admin, 'esp_com_items', ['definition', 'type_id', 'party_id', 'fields', 'notes', 'stage', 'priority', 'sender_user_id', 'sender_name', 'sender_employee_id', 'to_queue_id', 'assignee_employee_id', 'routing', 'created_at', 'closed_at'], referralHistory(t, AS_OF));
    await insert(admin, 'esp_report_templates', ['template_id', 'name', 'folder', 'status', 'owner_user_id', 'owner_name', 'definition', 'origin', 'version', 'thread_id', 'approval_id', 'created_at', 'updated_at'], reportSeed(profile.institutionType));
    // The application account reads tenant data only (spec 26.2: read-only on customer tables), and
    // writes only the workflow store, through approved DI Core operations.
    await admin.query(`GRANT SELECT ON \`${profile.schema}\`.* TO 'dinext'@'%'`);
    for (const table of [...WORKFLOW_WRITE_TABLES, ...PIPELINE_WRITE_TABLES, ...GOALS_WRITE_TABLES, ...MODULES_WRITE_TABLES, ...GROWTH_WRITE_TABLES, ...TASKS_WRITE_TABLES, ...WORKFLOW_DEF_WRITE_TABLES, ...WORKSPACE_WRITE_TABLES, ...CALENDAR_SERIES_WRITE_TABLES, ...TABLES_WRITE_TABLES, ...BUDGET_WRITE_TABLES, ...LOAN_GROWTH_WRITE_TABLES, ...SEG_DETAIL_WRITE_TABLES, ...MEMBER360_EXTRA_WRITE_TABLES, ...ONB_DESK_WRITE_TABLES, ...CR_EXTRA_WRITE_TABLES, ...ONB_JOURNEY_WRITE_TABLES]) await admin.query(`GRANT INSERT, UPDATE ON \`${profile.schema}\`.\`${table}\` TO 'dinext'@'%'`);
    // Add-only: a run record or a rating can't be changed once written (AI-GRD-090).
    for (const table of GOVERNANCE_APPEND_TABLES) await admin.query(`GRANT INSERT ON \`${profile.schema}\`.\`${table}\` TO 'dinext'@'%'`);
    // Direct core connections: DI's store for every tenant, and a Symitar-style replica for the credit union.
    await createSourceTables(admin, profile.schema);
    // API connections: DI's store, and the simulated marketing platform with the campaigns it already ran.
    await createApiTables(admin, profile.schema);
    // Off-core loans: DI's store, and the build account that publishes them into cdm_loan.
    await createOffcoreTables(admin, profile.schema);
    for (const table of [...ML_WRITE_TABLES, ...DMN_WRITE_TABLES]) await admin.query(`GRANT INSERT, UPDATE, DELETE ON \`${profile.schema}\`.\`${table}\` TO 'dinext'@'%'`);
    if (profile.institutionType === 'credit_union') await seedCoreReplica(admin, profile.schema);
    console.log(`${profile.key}: ${t.parties.length} parties, ${t.loans.length} loans, ${t.deposits.length} deposit accounts, ${t.histLoan.length} loan history rows, ${rm.interactions.length} interactions in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  await admin.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
