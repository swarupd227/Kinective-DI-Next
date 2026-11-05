// Report templates, schedules and exports (spec 18.2, 18.8, 18.9). One definition format for the
// classic builder, the Report Builder agent and the export renderer (AI-AGT-050): settings matching
// the builder tabs, and a layout of widgets on a 12-column grid, each a semantic query.

export type WidgetSize = 'quarter' | 'third' | 'half' | 'full';

export interface ReportWidget {
  id: string;
  title: string;
  kind: 'kpi' | 'chart' | 'table' | 'text' | 'analysis';
  /** An analysis section the report runner fills from a service, such as "alco.policy". */
  analysis?: string;
  /** Semantic metric names: one for a kpi or chart, up to four for a table. */
  metrics: string[];
  /** A dimension to group by (chart and table), such as "branch". */
  by?: string;
  chart?: 'line' | 'bar' | 'stacked_bar' | 'donut';
  /** Periods of history ending at the report period: a trend instead of one period. */
  trend?: number;
  /** KPIs: compare with the prior period. */
  compare?: boolean;
  /** Only these values of a dimension, such as Auto loans: "Lending – Auto loans" is the loan figures where loan_category is Auto. */
  where?: { dimension: string; values: string[] };
  text?: string;
  size: WidgetSize;
}

export interface ReportSettings {
  /** Configuration tab (spec 18.2). */
  app: string;
  /**
   * User classes that may open a saved report; empty means everyone with Reports. The owner always
   * can. Stock reports keep DI's list for reference only: every Report Viewer opens them.
   */
  controlClasses: string[];
  /** A saved report that is turned off doesn't run, and others can't see it. */
  enabled: boolean;
  /** Period and Hierarchy Info tab. */
  periodType: 'month' | 'quarter';
  usePeriod: 'current' | 'previous';
  allowedPeriodTypes: ('month' | 'quarter')[];
  addHierarchyControls: boolean;
  addHistoryControls: boolean;
  /** Test/Preview tab: generated queries are shown only to Query Browser users. */
  showQueries: boolean;
}

export interface PendingEdit {
  id: string;
  summary: string;
  kind: 'add' | 'change' | 'remove' | 'move';
  widgetId: string;
  /** The widget before the edit (null when added) and its position, for Revert. */
  before: ReportWidget | null;
  index: number;
}

export interface ReportDefinition {
  templateId: string;
  name: string;
  description: string;
  folder: string;
  settings: ReportSettings;
  layoutVersion: number;
  widgets: ReportWidget[];
  pendingEdits: PendingEdit[];
}

export const REPORT_DDL = [
  `CREATE TABLE esp_report_templates (
     template_id VARCHAR(60) PRIMARY KEY,
     name VARCHAR(120) NOT NULL,
     folder VARCHAR(80) NOT NULL,
     status VARCHAR(12) NOT NULL,
     owner_user_id VARCHAR(40) NOT NULL,
     owner_name VARCHAR(80) NOT NULL,
     definition JSON NOT NULL,
     origin JSON NULL,
     version INT NOT NULL DEFAULT 1,
     thread_id VARCHAR(40) NULL,
     approval_id VARCHAR(40) NULL,
     created_at DATETIME(3) NOT NULL,
     updated_at DATETIME(3) NOT NULL,
     KEY ix_tpl_owner (owner_user_id, status)
   )`,
  `CREATE TABLE esp_report_schedules (
     schedule_id INT AUTO_INCREMENT PRIMARY KEY,
     template_id VARCHAR(60) NOT NULL,
     owner_user_id VARCHAR(40) NOT NULL,
     owner_name VARCHAR(80) NOT NULL,
     frequency VARCHAR(12) NOT NULL,
     day_rule VARCHAR(20) NOT NULL,
     format VARCHAR(8) NOT NULL,
     recipients JSON NOT NULL,
     recipient_count INT NOT NULL,
     send_if_empty TINYINT NOT NULL,
     controls JSON NOT NULL,
     status VARCHAR(12) NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     created_at DATETIME(3) NOT NULL,
     last_run_at DATETIME(3) NULL,
     last_result VARCHAR(12) NULL,
     last_detail VARCHAR(200) NULL,
     UNIQUE KEY ux_sched_approval (approval_id),
     KEY ix_sched_owner (owner_user_id, status)
   ) AUTO_INCREMENT = 301`,
  `CREATE TABLE esp_report_exports (
     export_id VARCHAR(40) PRIMARY KEY,
     template_id VARCHAR(60) NOT NULL,
     user_id VARCHAR(40) NOT NULL,
     format VARCHAR(8) NOT NULL,
     controls JSON NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     created_at DATETIME(3) NOT NULL,
     downloads INT NOT NULL DEFAULT 0,
     UNIQUE KEY ux_export_approval (approval_id)
   )`,
  `CREATE TABLE esp_report_shares (
     share_id VARCHAR(40) PRIMARY KEY,
     template_id VARCHAR(60) NOT NULL,
     user_id VARCHAR(40) NOT NULL,
     recipients JSON NOT NULL,
     recipient_count INT NOT NULL,
     subject VARCHAR(200) NOT NULL,
     body TEXT NOT NULL,
     controls JSON NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     created_at DATETIME(3) NOT NULL,
     UNIQUE KEY ux_share_approval (approval_id)
   )`,
  // A report on Home: for the person who pinned it ('me') or for everyone in a user class.
  `CREATE TABLE esp_report_pins (
     pin_id VARCHAR(40) PRIMARY KEY,
     template_id VARCHAR(60) NOT NULL,
     user_id VARCHAR(40) NOT NULL,
     user_name VARCHAR(80) NOT NULL,
     audience VARCHAR(40) NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     created_at DATETIME(3) NOT NULL,
     removed_at DATETIME(3) NULL,
     removed_approval_id VARCHAR(40) NULL,
     UNIQUE KEY ux_pin_approval (approval_id),
     KEY ix_pin_template (template_id)
   )`,
  // Settings changes to a saved report (today's DI Build Reports form), one row per approved change:
  // what it was and what it became. The approval ID keeps a retried apply from running twice.
  `CREATE TABLE esp_report_setting_changes (
     change_id INT AUTO_INCREMENT PRIMARY KEY,
     template_id VARCHAR(60) NOT NULL,
     user_id VARCHAR(40) NOT NULL,
     user_name VARCHAR(80) NOT NULL,
     before_settings JSON NOT NULL,
     after_settings JSON NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     created_at DATETIME(3) NOT NULL,
     UNIQUE KEY ux_setting_approval (approval_id),
     KEY ix_setting_template (template_id)
   )`,
];

export const REPORT_WRITE_TABLES = ['esp_report_templates', 'esp_report_schedules', 'esp_report_exports', 'esp_report_shares', 'esp_report_pins', 'esp_report_setting_changes'];

const settings = (periodType: 'month' | 'quarter', controlClasses: string[]): ReportSettings => ({
  app: 'reports',
  controlClasses,
  enabled: true,
  periodType,
  usePeriod: 'current',
  allowedPeriodTypes: ['month', 'quarter'],
  addHierarchyControls: true,
  addHistoryControls: true,
  showQueries: false,
});

const kpi = (id: string, title: string, metric: string): ReportWidget => ({ id, title, kind: 'kpi', metrics: [metric], compare: true, size: 'quarter' });

/** Stock periodic reports every tenant starts with (spec 8.5). Metric names come from the semantic model. */
export function stockReports(institutionType: 'credit_union' | 'bank'): ReportDefinition[] {
  const persons = institutionType === 'bank' ? 'customers' : 'members';
  const checking = { dimension: 'deposit_category', values: ['Checking'] };
  const auto = { dimension: 'loan_category', values: ['Auto'] };
  return [
    {
      templateId: 'branch_scorecard_monthly',
      name: 'Branch scorecard',
      description: `Loans, deposits, delinquency and new ${persons} for each branch, for one month.`,
      folder: 'Periodic / Monthly',
      settings: settings('month', ['Executive', 'Branch Manager', 'Finance']),
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { id: 'a1', title: 'Branch scorecard', kind: 'analysis', analysis: 'branch.scorecard', metrics: [], size: 'full' },
        kpi('k1', 'Total loans', 'loan_balance'),
        kpi('k2', 'Total deposits', 'deposit_balance'),
        kpi('k3', 'Delinquency 60+', 'delinquency_ratio_60_plus'),
        kpi('k4', `New ${persons}`, 'new_members'),
        { id: 'a2', title: 'Team goals', kind: 'analysis', analysis: 'branch.team', metrics: [], size: 'full' },
        { id: 'c1', title: 'Loan balance, last 13 months', kind: 'chart', chart: 'line', metrics: ['loan_balance'], trend: 13, size: 'half' },
        { id: 'c2', title: 'New loans funded, last 13 months', kind: 'chart', chart: 'bar', metrics: ['new_loan_amount'], trend: 13, size: 'half' },
      ],
    },
    {
      templateId: 'alco_monthly_pack',
      name: 'ALCO monthly pack',
      description: 'The asset-liability committee’s review: policy compliance first, then earnings and margin, interest rate risk, liquidity, capital, funding and certificate maturities, and the loan book’s mix, yields, growth and concentration.',
      folder: 'Periodic / Monthly',
      settings: { ...settings('month', ['Executive', 'Finance']), addHierarchyControls: false },
      layoutVersion: 2,
      pendingEdits: [],
      widgets: [
        // What the committee reads first: every board limit, the actual figure and whether it's met.
        { id: 'a1', title: 'Policy compliance', kind: 'analysis', analysis: 'alco.policy', metrics: [], size: 'full' },
        // Capital and earnings from the 5300, which only a credit union files; a bank's are in the sections below.
        ...(institutionType === 'credit_union'
          ? [
              { id: 'k4', title: 'Net worth ratio', kind: 'kpi' as const, metrics: ['net_worth_ratio'], size: 'third' as const },
              { id: 'k5', title: 'Net interest margin', kind: 'kpi' as const, metrics: ['net_interest_margin'], size: 'third' as const },
              { id: 'k6', title: 'Return on assets', kind: 'kpi' as const, metrics: ['return_on_assets'], size: 'third' as const },
            ]
          : []),
        { id: 'k1', title: institutionType === 'credit_union' ? 'Loan-to-share' : 'Loan-to-deposit', kind: 'kpi', metrics: ['loan_to_share_ratio'], compare: true, size: 'quarter' },
        { id: 'k2', title: 'Delinquency 60+', kind: 'kpi', metrics: ['delinquency_ratio_60_plus'], compare: true, size: 'quarter' },
        { id: 'k3', title: 'Total deposits', kind: 'kpi', metrics: ['deposit_balance'], compare: true, size: 'quarter' },
        { id: 'k7', title: 'Certificates maturing in 90 days', kind: 'kpi', metrics: ['certificates_maturing_90_days'], size: 'quarter' },
        { id: 'a2', title: 'Earnings: yields, cost of funds and margin', kind: 'analysis', analysis: 'alco.earnings', metrics: [], size: 'half' },
        { id: 'a3', title: 'Interest rate risk: NII and NEV under rate shocks', kind: 'analysis', analysis: 'alco.irr', metrics: [], size: 'half' },
        { id: 'a4', title: 'Liquidity: available funds and a deposit run', kind: 'analysis', analysis: 'alco.liquidity', metrics: [], size: 'half' },
        { id: 'a5', title: 'Capital', kind: 'analysis', analysis: 'alco.capital', metrics: [], size: 'half' },
        { id: 'a6', title: 'Funding: deposits and certificate maturities', kind: 'analysis', analysis: 'alco.funding', metrics: [], size: 'full' },
        { id: 'a7', title: 'Loans: mix, yields, growth and concentration', kind: 'analysis', analysis: 'alco.loans', metrics: [], size: 'full' },
        { id: 'c1', title: 'Loan balance by category, last 13 months', kind: 'chart', chart: 'stacked_bar', metrics: ['loan_balance'], by: 'loan_category', trend: 13, size: 'half' },
        { id: 'c2', title: 'Deposit balance by product, last 13 months', kind: 'chart', chart: 'stacked_bar', metrics: ['deposit_balance'], by: 'deposit_category', trend: 13, size: 'half' },
      ],
    },
    {
      templateId: 'executive_summary_quarterly',
      name: 'Executive summary',
      description: 'The quarter at a glance: balances, new lending, growth and new relationships.',
      folder: 'Periodic / Quarterly',
      settings: settings('quarter', ['Executive']),
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        kpi('k1', 'Total loans', 'loan_balance'),
        kpi('k2', 'Total deposits', 'deposit_balance'),
        kpi('k3', 'New loan dollars', 'new_loan_amount'),
        kpi('k4', `New ${persons}`, 'new_members'),
        { id: 'c1', title: 'New loan dollars by branch', kind: 'chart', chart: 'bar', metrics: ['new_loan_amount'], by: 'branch', size: 'half' },
        { id: 'c2', title: 'Deposit balance, last 6 quarters', kind: 'chart', chart: 'line', metrics: ['deposit_balance'], trend: 6, size: 'half' },
      ],
    },
    // Today's DI Executive Dashboard, with a comparison on every figure. Closed members aren't in the
    // warehouse, so it shows who joined and the member count, and says so rather than guess churn.
    {
      templateId: 'executive_dashboard_monthly',
      name: 'Executive dashboard',
      description: `The month for leadership: the scorecard against plan and peers, ${institutionType === 'credit_union' ? 'earnings, ' : ''}${persons}, loans and deposits, per-${persons === 'members' ? 'member' : 'customer'} averages, ${persons === 'members' ? 'member' : 'customer'} growth and new loan production by loan group.`,
      folder: 'Executive',
      settings: { ...settings('month', ['Executive', 'Finance']), addHierarchyControls: false },
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { id: 'a1', title: 'Scorecard against plan and peers', kind: 'analysis', analysis: 'board.scorecard', metrics: [], size: 'full' },
        ...(institutionType === 'credit_union'
          ? [
              { ...kpi('k8', 'Return on assets', 'return_on_assets'), size: 'third' as const },
              { ...kpi('k9', 'Net interest margin', 'net_interest_margin'), size: 'third' as const },
              { ...kpi('k10', 'Efficiency ratio', 'efficiency_ratio'), size: 'third' as const },
            ]
          : []),
        { ...kpi('k1', persons === 'members' ? 'Active members' : 'Active customers', 'member_count'), size: 'third' },
        { ...kpi('k2', 'Total loans', 'loan_balance'), size: 'third' },
        { ...kpi('k3', 'Total deposits', 'deposit_balance'), size: 'third' },
        { ...kpi('k4', `Average loans per ${persons === 'members' ? 'member' : 'customer'}`, 'loans_per_member'), size: 'half' },
        { ...kpi('k5', `Average deposits per ${persons === 'members' ? 'member' : 'customer'}`, 'deposits_per_member'), size: 'half' },
        { id: 'c1', title: `New ${persons}, last 12 months`, kind: 'chart', chart: 'bar', metrics: ['new_members'], trend: 12, size: 'half' },
        { id: 'c2', title: `Total ${persons}, last 12 months`, kind: 'chart', chart: 'line', metrics: ['member_count'], trend: 12, size: 'half' },
        { ...kpi('k6', `Net ${persons === 'members' ? 'member' : 'customer'} growth`, 'net_member_growth'), size: 'half' },
        { ...kpi('k7', 'Attrition rate', 'member_attrition_rate'), size: 'half' },
        { id: 't1', title: 'New loan production by loan group', kind: 'table', metrics: ['new_loan_count', 'new_loan_amount', 'loan_balance'], by: 'loan_category', size: 'full' },
      ],
    },
    // Membership growth and penetration: net growth with joins against exits, attrition, and how deep
    // relationships are by branch and age band. The Membership page has the reasons and new members.
    {
      templateId: 'membership_growth_monthly',
      name: `${persons === 'members' ? 'Membership' : 'Customer'} growth & penetration`,
      description: `Net ${persons === 'members' ? 'member' : 'customer'} growth, joins and exits, the attrition rate, and the share of ${persons} with checking, a loan, direct deposit and digital banking, by branch and age band.`,
      folder: 'Marketing',
      settings: settings('month', ['Executive', 'Branch Manager', 'Finance']),
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { ...kpi('k1', `Net ${persons === 'members' ? 'member' : 'customer'} growth`, 'net_member_growth'), size: 'third' },
        { ...kpi('k2', 'Attrition rate', 'member_attrition_rate'), size: 'third' },
        { ...kpi('k3', `Products per ${persons === 'members' ? 'member' : 'customer'}`, 'products_per_member'), size: 'third' },
        { id: 'c1', title: 'Joined and left, last 12 months', kind: 'chart', chart: 'bar', metrics: ['new_members', 'members_left'], trend: 12, size: 'half' },
        { id: 'c2', title: `Total ${persons}, last 12 months`, kind: 'chart', chart: 'line', metrics: ['member_count'], trend: 12, size: 'half' },
        { id: 't1', title: 'Penetration by age band', kind: 'table', metrics: ['checking_penetration', 'loan_penetration', 'direct_deposit_penetration', 'digital_active_rate', 'products_per_member'], by: 'age_band', size: 'full' },
        { id: 't2', title: 'Growth and penetration by branch', kind: 'table', metrics: ['net_member_growth', 'member_attrition_rate', 'checking_penetration', 'loan_penetration', 'products_per_member'], by: 'branch', size: 'full' },
      ],
    },
    // What a loan officer and their manager run production on: applications, approvals and dollars,
    // days to decision, the open pipeline, the funded-dollars goal, the book's credit, and stage times.
    {
      templateId: 'loan_officer_production_monthly',
      name: 'Loan officer production',
      description: 'Each loan officer’s last 90 days: applications, approvals and dollars, approval rate, days to decision, the open pipeline, the funded-dollars goal and the delinquency of the book they originated; and time in each stage.',
      folder: 'Lending',
      settings: settings('month', ['Executive', 'Branch Manager', 'Lending']),
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { id: 'a1', title: 'Loan officer production', kind: 'analysis', analysis: 'lending.officers', metrics: [], size: 'full' },
        kpi('k1', 'New loan applications', 'new_loan_applications'),
        kpi('k2', 'Approval rate', 'approval_rate'),
        kpi('k3', 'New loan dollars', 'new_loan_amount'),
        kpi('k4', 'Delinquency 60+', 'delinquency_ratio_60_plus'),
        { id: 'a2', title: 'Time in each stage', kind: 'analysis', analysis: 'lending.stages', metrics: [], size: 'half' },
        { id: 'c1', title: 'New loan dollars by loan type, last 13 months', kind: 'chart', chart: 'stacked_bar', metrics: ['new_loan_amount'], by: 'loan_category', trend: 13, size: 'half' },
      ],
    },
    // The named reports today's DI shows on its Dashboards home.
    {
      templateId: 'checking_growth_monthly',
      name: 'Checking growth',
      description: 'Checking balances and accounts, how they have grown, and where.',
      folder: 'Deposits',
      settings: settings('month', ['Executive', 'Branch Manager', 'Finance']),
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { ...kpi('k1', 'Checking balance', 'deposit_balance'), where: checking, size: 'half' },
        { ...kpi('k2', 'Checking accounts', 'deposit_account_count'), where: checking, size: 'half' },
        { id: 'c1', title: 'Checking balance, last 13 months', kind: 'chart', chart: 'line', metrics: ['deposit_balance'], where: checking, trend: 13, size: 'full' },
        { id: 't1', title: 'Checking by branch', kind: 'table', metrics: ['deposit_balance', 'deposit_account_count'], by: 'branch', where: checking, size: 'full' },
      ],
    },
    {
      templateId: 'lending_auto_loans_monthly',
      name: 'Lending – Auto loans',
      description: 'Auto loan balances, new auto lending, delinquency and the split between direct and dealer loans.',
      folder: 'Lending',
      settings: settings('month', ['Executive', 'Branch Manager', 'Lending']),
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { ...kpi('k1', 'Auto loan balance', 'loan_balance'), where: auto },
        { ...kpi('k2', 'Auto loans', 'loan_count'), where: auto },
        { ...kpi('k3', 'New auto loan dollars', 'new_loan_amount'), where: auto },
        { ...kpi('k4', 'Auto delinquency 60+', 'delinquency_ratio_60_plus'), where: auto },
        { id: 'c1', title: 'New auto loan dollars, last 13 months', kind: 'chart', chart: 'bar', metrics: ['new_loan_amount'], where: auto, trend: 13, size: 'full' },
        { id: 'c2', title: 'Auto balance by channel', kind: 'chart', chart: 'donut', metrics: ['loan_balance'], by: 'origination_channel', where: auto, size: 'half' },
        { id: 't1', title: 'Auto loans by branch', kind: 'table', metrics: ['loan_balance', 'loan_count', 'new_loan_amount', 'delinquency_ratio_60_plus'], by: 'branch', where: auto, size: 'half' },
      ],
    },
    {
      templateId: 'loan_delinquency_monthly',
      name: 'Lending – Loan delinquency',
      description: 'Loans past due: the 30+ and 60+ ratios and their trend, the aging buckets, and delinquency by category, branch and vintage. Roll rates and the loans to work are on the Delinquency page.',
      folder: 'Lending',
      settings: settings('month', ['Executive', 'Branch Manager', 'Lending', 'Finance']),
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { ...kpi('k1', 'Delinquency 60+', 'delinquency_ratio_60_plus'), size: 'third' },
        { ...kpi('k3', 'Delinquency 30+', 'delinquency_ratio_30_plus'), size: 'third' },
        { ...kpi('k2', 'Delinquent balance', 'delinquent_loan_balance'), size: 'third' },
        { id: 'c1', title: 'Delinquency 60+, last 13 months', kind: 'chart', chart: 'line', metrics: ['delinquency_ratio_60_plus'], trend: 13, size: 'full' },
        { id: 't2', title: 'Aging: balance by days past due', kind: 'table', metrics: ['loan_balance', 'loan_count'], by: 'delinquency_bucket', size: 'half' },
        { id: 'c2', title: 'Delinquent balance by loan category', kind: 'chart', chart: 'bar', metrics: ['delinquent_loan_balance'], by: 'loan_category', size: 'half' },
        { id: 't1', title: 'By branch', kind: 'table', metrics: ['delinquency_ratio_30_plus', 'delinquency_ratio_60_plus', 'delinquent_loan_balance', 'loan_balance'], by: 'branch', size: 'half' },
        { id: 't3', title: 'By vintage (year opened)', kind: 'table', metrics: ['delinquency_ratio_30_plus', 'delinquency_ratio_60_plus', 'loan_balance'], by: 'vintage', size: 'half' },
      ],
    },
    {
      templateId: 'loan_app_monthly',
      name: 'Loan app reports',
      description: 'New loan applications and how many are approved, by category and branch.',
      folder: 'Lending',
      settings: settings('month', ['Executive', 'Branch Manager', 'Lending']),
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { ...kpi('k1', 'New applications', 'new_loan_applications'), size: 'half' },
        { ...kpi('k2', 'Approval rate', 'approval_rate'), size: 'half' },
        { id: 'c1', title: 'New applications, last 13 months', kind: 'chart', chart: 'bar', metrics: ['new_loan_applications'], trend: 13, size: 'full' },
        { id: 't1', title: 'By branch', kind: 'table', metrics: ['new_loan_applications', 'approval_rate'], by: 'branch', size: 'half' },
        { id: 't2', title: 'By loan category', kind: 'table', metrics: ['new_loan_applications', 'approval_rate'], by: 'loan_category', size: 'half' },
      ],
    },
    {
      templateId: 'growth_my_branch_monthly',
      name: 'Growth report – My branch',
      description: `New ${persons}, new lending and balances for your branch, with the trend.`,
      folder: 'Branch',
      settings: settings('month', ['Executive', 'Branch Manager']),
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { id: 'a1', title: 'Branch scorecard', kind: 'analysis', analysis: 'branch.scorecard', metrics: [], size: 'full' },
        kpi('k1', `New ${persons}`, 'new_members'),
        kpi('k2', 'New loan dollars', 'new_loan_amount'),
        kpi('k3', 'Total loans', 'loan_balance'),
        kpi('k4', 'Total deposits', 'deposit_balance'),
        { id: 'c1', title: `New ${persons}, last 13 months`, kind: 'chart', chart: 'bar', metrics: ['new_members'], trend: 13, size: 'half' },
        { id: 'c2', title: 'Deposits, last 13 months', kind: 'chart', chart: 'line', metrics: ['deposit_balance'], trend: 13, size: 'half' },
      ],
    },
    {
      templateId: 'lending_portfolio_monthly',
      name: 'Lending portfolio',
      description: 'The loan book by category: balances, counts, the average rate and delinquency.',
      folder: 'Lending',
      settings: settings('month', ['Executive', 'Lending', 'Finance']),
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { ...kpi('k1', 'Total loans', 'loan_balance'), size: 'third' },
        { ...kpi('k2', 'Open loans', 'loan_count'), size: 'third' },
        { ...kpi('k3', 'Average loan rate', 'average_loan_rate'), size: 'third' },
        { id: 'c1', title: 'Loan balance by category', kind: 'chart', chart: 'donut', metrics: ['loan_balance'], by: 'loan_category', size: 'half' },
        { id: 't1', title: 'By category', kind: 'table', metrics: ['loan_balance', 'loan_count', 'delinquent_loan_balance', 'delinquency_ratio_60_plus'], by: 'loan_category', size: 'half' },
        { id: 'c2', title: 'Loan balance by category, last 13 months', kind: 'chart', chart: 'stacked_bar', metrics: ['loan_balance'], by: 'loan_category', trend: 13, size: 'full' },
      ],
    },
    {
      templateId: 'board_report_quarterly',
      name: 'Board report',
      description: `The quarter for the board: a scorecard against the 2026 plan and peers, ${institutionType === 'credit_union' ? 'earnings, capital, ' : ''}growth, ${persons}, loan-to-share and credit quality, with five quarters of trend.`,
      folder: 'Board',
      settings: { ...settings('quarter', ['Executive']), addHierarchyControls: false },
      layoutVersion: 2,
      pendingEdits: [],
      widgets: [
        { id: 'a1', title: 'Scorecard against plan and peers', kind: 'analysis', analysis: 'board.scorecard', metrics: [], size: 'full' },
        // Earnings and capital from the 5300, which only a credit union files.
        ...(institutionType === 'credit_union'
          ? [
              kpi('k5', 'Return on assets', 'return_on_assets'),
              kpi('k6', 'Net interest margin', 'net_interest_margin'),
              kpi('k7', 'Efficiency ratio', 'efficiency_ratio'),
              kpi('k8', 'Net worth ratio', 'net_worth_ratio'),
              { id: 'c3', title: 'Return on assets, last 5 quarters', kind: 'chart' as const, chart: 'line' as const, metrics: ['return_on_assets'], trend: 5, size: 'half' as const },
              { id: 'c4', title: 'Net interest margin, last 5 quarters', kind: 'chart' as const, chart: 'line' as const, metrics: ['net_interest_margin'], trend: 5, size: 'half' as const },
              { id: 'c5', title: 'Efficiency ratio, last 5 quarters', kind: 'chart' as const, chart: 'line' as const, metrics: ['efficiency_ratio'], trend: 5, size: 'half' as const },
              { id: 'c6', title: 'Net income, annualized, last 5 quarters', kind: 'chart' as const, chart: 'bar' as const, metrics: ['net_income'], trend: 5, size: 'half' as const },
            ]
          : []),
        kpi('k1', persons === 'members' ? 'Members' : 'Customers', 'member_count'),
        kpi('k2', 'Total loans', 'loan_balance'),
        kpi('k3', 'Total deposits', 'deposit_balance'),
        kpi('k4', institutionType === 'credit_union' ? 'Loan-to-share' : 'Loan-to-deposit', 'loan_to_share_ratio'),
        { id: 'c1', title: 'Loan balance by category, last 5 quarters', kind: 'chart', chart: 'stacked_bar', metrics: ['loan_balance'], by: 'loan_category', trend: 5, size: 'half' },
        { id: 'c2', title: 'Delinquency 60+, last 5 quarters', kind: 'chart', chart: 'line', metrics: ['delinquency_ratio_60_plus'], trend: 5, size: 'half' },
        { id: 't1', title: 'By region', kind: 'table', metrics: ['loan_balance', 'deposit_balance', 'new_loan_amount', 'delinquency_ratio_60_plus'], by: 'region', size: 'full' },
      ],
    },
  ];
}

/** Stock templates as rows; the system owns them, and they are visible to every Report Viewer. */
export function reportSeed(institutionType: 'credit_union' | 'bank') {
  const now = '2026-10-01 00:00:00.000';
  return stockReports(institutionType).map((d) => [d.templateId, d.name, d.folder, 'stock', 'system', 'Kinective', JSON.stringify(d), null, 1, null, null, now, now]);
}
