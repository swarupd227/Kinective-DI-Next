// Report templates, schedules and exports (spec 18.2, 18.8, 18.9). One definition format for the
// classic builder, the Report Builder agent and the export renderer (AI-AGT-050): settings matching
// the builder tabs, and a layout of widgets on a 12-column grid, each a semantic query.

export type WidgetSize = 'quarter' | 'third' | 'half' | 'full';

export interface ReportWidget {
  id: string;
  title: string;
  kind: 'kpi' | 'chart' | 'table' | 'text';
  /** Semantic metric names: one for a kpi or chart, up to four for a table. */
  metrics: string[];
  /** A dimension to group by (chart and table), such as "branch". */
  by?: string;
  chart?: 'line' | 'bar' | 'stacked_bar' | 'donut';
  /** Periods of history ending at the report period: a trend instead of one period. */
  trend?: number;
  /** KPIs: compare with the prior period. */
  compare?: boolean;
  text?: string;
  size: WidgetSize;
}

export interface ReportSettings {
  /** Configuration tab (spec 18.2). */
  app: string;
  controlClasses: string[];
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
];

export const REPORT_WRITE_TABLES = ['esp_report_templates', 'esp_report_schedules', 'esp_report_exports', 'esp_report_shares'];

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
        kpi('k1', 'Total loans', 'loan_balance'),
        kpi('k2', 'Total deposits', 'deposit_balance'),
        kpi('k3', 'Delinquency 60+', 'delinquency_ratio_60_plus'),
        kpi('k4', `New ${persons}`, 'new_members'),
        { id: 't1', title: 'By branch', kind: 'table', metrics: ['loan_balance', 'deposit_balance', 'new_loan_amount', 'delinquency_ratio_60_plus'], by: 'branch', size: 'full' },
        { id: 'c1', title: 'Loan balance, last 13 months', kind: 'chart', chart: 'line', metrics: ['loan_balance'], trend: 13, size: 'full' },
      ],
    },
    {
      templateId: 'alco_monthly_pack',
      name: 'ALCO monthly pack',
      description: 'Loan balances by category, deposit mix, loan-to-share and delinquency for the asset-liability committee.',
      folder: 'Periodic / Monthly',
      settings: { ...settings('month', ['Executive', 'Finance']), addHierarchyControls: false },
      layoutVersion: 1,
      pendingEdits: [],
      widgets: [
        { id: 'k1', title: 'Loan-to-share', kind: 'kpi', metrics: ['loan_to_share_ratio'], compare: true, size: 'third' },
        { id: 'k2', title: 'Delinquency 60+', kind: 'kpi', metrics: ['delinquency_ratio_60_plus'], compare: true, size: 'third' },
        { id: 'k3', title: 'Total deposits', kind: 'kpi', metrics: ['deposit_balance'], compare: true, size: 'third' },
        { id: 'c1', title: 'Loan balance by category, last 13 months', kind: 'chart', chart: 'stacked_bar', metrics: ['loan_balance'], by: 'loan_category', trend: 13, size: 'full' },
        { id: 'c2', title: 'Deposit mix', kind: 'chart', chart: 'donut', metrics: ['deposit_balance'], by: 'deposit_category', size: 'half' },
        { id: 't1', title: 'Deposits by product', kind: 'table', metrics: ['deposit_balance', 'deposit_account_count'], by: 'deposit_category', size: 'half' },
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
  ];
}

/** Stock templates as rows; the system owns them, and they are visible to every Report Viewer. */
export function reportSeed(institutionType: 'credit_union' | 'bank') {
  const now = '2026-10-01 00:00:00.000';
  return stockReports(institutionType).map((d) => [d.templateId, d.name, d.folder, 'stock', 'system', 'Kinective', JSON.stringify(d), null, 1, null, null, now, now]);
}
