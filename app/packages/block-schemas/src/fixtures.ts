// Synthetic, valid sample blocks for the gallery, tests and the mock stream server.
// Institution, people and figures are fictional (a mid-size credit union, "member" terminology).
import type {
  ApprovalCardBlock,
  ChartBlock,
  KpiBlock,
  KpiGroupBlock,
  Member360Block,
  MemberCardBlock,
  MemberScore,
  NoticeBlock,
  PlanStepsBlock,
  ReportCanvasBlock,
  TableBlock,
  TextBlock,
} from './blocks.ts';
import type { Freshness, Provenance } from './envelope.ts';

export const BUILD_AS_OF = '2026-10-26T04:10:00-04:00';
export const nightly: Freshness = { kind: 'nightly_build', asOf: BUILD_AS_OF, buildId: 'bld_20261026' };

const analytics = (sources: Provenance['sources'], extra: Partial<Provenance> = {}): Provenance => ({
  agent: 'Analytics Q&A',
  runId: 'R-20261026-0042',
  operations: ['semantic.query'],
  sources,
  purviewApplied: true,
  ...extra,
});

export const textFixture: TextBlock = {
  id: 'blk_txtLoanGrowth01',
  type: 'text',
  version: '1.0.0',
  provenance: analytics([{ kind: 'metric', label: 'Loan balance growth', ref: 'metric:loan_balance_growth' }]),
  freshness: nightly,
  data: {
    markdown:
      'Loan balances grew **2.4%** in Q3, ahead of Q2 (**1.6%**). Most of the gain came from **auto** and **HELOC**:\n\n' +
      '- **Westport** led with $18.2M in new balances, driven by indirect auto.\n' +
      '- **Northgate** was the only branch to shrink (−0.8%), after two large commercial payoffs.\n\n' +
      'See the [branch breakdown](/c/thr_9xQ2/b/blk_tblBranchGrowth1) for every branch.',
  },
  speakable: 'Loan balances grew 2.4 percent in Q3, led by Westport. Northgate was the only branch to shrink.',
};

export const kpiFixture: KpiBlock = {
  id: 'blk_kpiTotalLoans01',
  type: 'kpi',
  version: '1.0.0',
  provenance: analytics([{ kind: 'metric', label: 'Total loans', ref: 'metric:total_loan_balance' }]),
  freshness: nightly,
  actions: [
    { id: 'a1', kind: 'explain', label: 'Explain' },
    { id: 'a2', kind: 'pin', label: 'Pin', riskTier: 'low' },
  ],
  data: {
    label: 'Total loans',
    value: 1_212_480_000,
    unit: 'currency',
    format: { compact: true, decimals: 2 },
    comparison: { label: 'vs prior build', value: 0.2, unit: 'percent', direction: 'up', goodWhen: 'up' },
    sparkline: [1.181, 1.184, 1.186, 1.19, 1.192, 1.195, 1.197, 1.199, 1.203, 1.206, 1.209, 1.2125],
    metricRef: 'metric:total_loan_balance',
  },
};

export const kpiGroupFixture: KpiGroupBlock = {
  id: 'blk_kpgChanged0001',
  type: 'kpi_group',
  version: '1.0.0',
  title: "What changed since yesterday's build",
  provenance: analytics([
    { kind: 'metric', label: 'Total loans', ref: 'metric:total_loan_balance' },
    { kind: 'metric', label: 'Total deposits', ref: 'metric:total_deposit_balance' },
    { kind: 'metric', label: 'Delinquency 60+', ref: 'metric:delinquency_60_plus_rate' },
    { kind: 'metric', label: 'New members', ref: 'metric:new_members' },
  ], { agent: 'Dashboard/Briefing' }),
  freshness: nightly,
  data: {
    layout: 'row',
    items: [
      kpiFixture.data,
      {
        label: 'Total deposits',
        value: 1_641_900_000,
        unit: 'currency',
        format: { compact: true, decimals: 2 },
        comparison: { label: 'vs prior build', value: -0.1, unit: 'percent', direction: 'down', goodWhen: 'up' },
        sparkline: [1.652, 1.649, 1.648, 1.646, 1.647, 1.645, 1.644, 1.643, 1.643, 1.642, 1.6425, 1.6419],
        metricRef: 'metric:total_deposit_balance',
      },
      {
        label: 'Delinquency 60+',
        value: 0.71,
        unit: 'percent',
        format: { decimals: 2 },
        comparison: { label: 'vs prior build', value: 4, unit: 'bp', direction: 'up', goodWhen: 'down' },
        sparkline: [0.64, 0.65, 0.65, 0.66, 0.67, 0.66, 0.68, 0.69, 0.68, 0.7, 0.67, 0.71],
        metricRef: 'metric:delinquency_60_plus_rate',
      },
      {
        label: 'New members',
        value: 38,
        unit: 'count',
        comparison: { label: 'month to date', value: 812, unit: 'count', direction: 'flat', goodWhen: 'up' },
        metricRef: 'metric:new_members',
      },
    ],
  },
};

const branches = ['Westport', 'Northgate', 'Riverside', 'Lakeshore', 'Downtown', 'Eastgate'];
const q2 = [182.4, 141.9, 120.3, 98.6, 210.2, 76.8].map((m) => m * 1e6);
const q3 = [200.6, 140.8, 124.9, 101.2, 214.7, 79.5].map((m) => m * 1e6);

export const chartFixture: ChartBlock = {
  id: 'blk_chtBranchLoans1',
  type: 'chart',
  version: '2.0.0',
  title: 'Loan balances by branch',
  subtitle: 'Q3 2026 vs Q2 2026',
  provenance: analytics([
    { kind: 'metric', label: 'Loan balance', ref: 'metric:total_loan_balance' },
    { kind: 'table', label: 'Loan Accounts', ref: 'table:loan_accounts' },
  ], { filters: ['Period: Q3 2026 vs Q2 2026', 'Limited to your purview: all branches'] }),
  freshness: nightly,
  actions: [
    { id: 'a1', kind: 'explain', label: 'Explain' },
    { id: 'a2', kind: 'pin', label: 'Pin', riskTier: 'low' },
    { id: 'a3', kind: 'open_workspace', label: 'Open grid' },
    { id: 'a4', kind: 'export', label: 'Export' },
  ],
  a11y: { summary: 'Bar chart of loan balances by branch. Downtown is largest at $214.7M. Westport grew most, from $182.4M to $200.6M. Northgate fell slightly.' },
  data: {
    chartType: 'bar',
    dataset: {
      dimensions: [{ name: 'branch', displayName: 'Branch', type: 'ordinal' }, { name: 'q2', displayName: 'Q2 2026' }, { name: 'q3', displayName: 'Q3 2026' }],
      source: branches.map((b, i) => [b, q2[i]!, q3[i]!]),
    },
    series: [
      { name: 'Q2 2026', encode: { x: 'branch', y: 'q2' }, comparison: true },
      { name: 'Q3 2026', encode: { x: 'branch', y: 'q3' } },
    ],
    axes: { y: [{ title: 'Balance', unit: 'currency' }] },
    legend: true,
  },
};

const weeks = ['Aug 3', 'Aug 10', 'Aug 17', 'Aug 24', 'Aug 31', 'Sep 7', 'Sep 14', 'Sep 21', 'Sep 28', 'Oct 5', 'Oct 12', 'Oct 19'];
export const lineChartFixture: ChartBlock = {
  id: 'blk_chtDelinqTrend',
  type: 'chart',
  version: '2.0.0',
  title: 'Delinquency 60+ trend',
  subtitle: 'Weekly, last 12 weeks',
  provenance: analytics([{ kind: 'metric', label: 'Delinquency 60+', ref: 'metric:delinquency_60_plus_rate' }]),
  freshness: nightly,
  a11y: { summary: 'Line chart. Delinquency 60+ rose from 0.64% to 0.71% over 12 weeks, crossing the 0.70% watch level in October.' },
  data: {
    chartType: 'line',
    dataset: {
      dimensions: [{ name: 'week', displayName: 'Week', type: 'ordinal' }, { name: 'rate', displayName: 'Delinquency 60+' }, { name: 'prior', displayName: 'Same weeks last year' }],
      source: weeks.map((w, i) => [w, [0.64, 0.65, 0.65, 0.66, 0.67, 0.66, 0.68, 0.69, 0.68, 0.7, 0.67, 0.71][i]!, [0.58, 0.59, 0.58, 0.6, 0.6, 0.61, 0.6, 0.62, 0.61, 0.62, 0.63, 0.62][i]!]),
    },
    series: [
      { name: 'Same weeks last year', encode: { x: 'week', y: 'prior' }, comparison: true },
      { name: 'Delinquency 60+', encode: { x: 'week', y: 'rate' } },
    ],
    axes: { y: [{ title: 'Rate', unit: 'percent' }] },
    markLines: [{ value: 0.7, label: 'Watch level 0.70%' }],
    legend: true,
  },
};

export const tableFixture: TableBlock = {
  id: 'blk_tblBranchGrowth1',
  type: 'table',
  version: '1.0.0',
  title: 'Branch loan growth, Q3 2026',
  provenance: analytics([{ kind: 'table', label: 'Loan Accounts', ref: 'table:loan_accounts' }, { kind: 'metric', label: 'Loan balance growth', ref: 'metric:loan_balance_growth' }]),
  freshness: nightly,
  actions: [
    { id: 'a1', kind: 'open_workspace', label: 'Open grid' },
    { id: 'a2', kind: 'export', label: 'Export' },
  ],
  data: {
    columns: [
      { field: 'branch', headerName: 'Branch', type: 'text', pinned: 'left' },
      { field: 'q3', headerName: 'Q3 balance', type: 'currency' },
      { field: 'change', headerName: 'Change', type: 'currency' },
      { field: 'growth', headerName: 'Growth', type: 'percent' },
      { field: 'newLoans', headerName: 'New loans', type: 'count' },
      { field: 'dq60', headerName: 'DQ 60+', type: 'percent' },
    ],
    rows: branches.map((branch, i) => ({
      branch,
      q3: q3[i]!,
      change: q3[i]! - q2[i]!,
      growth: ((q3[i]! - q2[i]!) / q2[i]!) * 100,
      newLoans: [412, 188, 236, 151, 344, 97][i]!,
      dq60: [0.58, 0.94, 0.66, 0.71, 0.62, 0.88][i]!,
    })),
    sort: [{ field: 'growth', dir: 'desc' }],
    rowCount: 6,
  },
};

export const planStepsFixture: PlanStepsBlock = {
  id: 'blk_plnRetention01',
  type: 'plan_steps',
  version: '1.0.0',
  title: 'Finding certificates at risk of leaving',
  provenance: { agent: 'Deposit/Certificate Retention', runId: 'R-20261026-0051', sources: [{ kind: 'table', label: 'Certificates', ref: 'table:certificates' }] },
  freshness: nightly,
  data: {
    runId: 'R-20261026-0051',
    cancellable: true,
    state: 'running',
    steps: [
      {
        id: 's1',
        label: 'Reading certificates maturing in the next 90 days',
        agent: 'Analytics Q&A',
        state: 'done',
        startedAt: '2026-10-26T14:03:02Z',
        endedAt: '2026-10-26T14:03:04Z',
        resultSummary: 'Found 1,284 certificates worth $96.4M',
        operations: [{ name: 'semantic.query', params: { metric: 'certificate_balance', window: '90 days' } }],
      },
      {
        id: 's2',
        label: 'Scoring each member for attrition risk',
        agent: 'Predictive',
        state: 'running',
        startedAt: '2026-10-26T14:03:04Z',
        operations: [{ name: 'predictive.scores.get', params: { model: 'attrition_v4' } }],
      },
      { id: 's3', label: 'Removing members who are delinquent or have opted out', agent: 'Analytics Q&A', state: 'waiting' },
      { id: 's4', label: 'Drafting a retention call list for branch managers', agent: 'Deposit/Certificate Retention', state: 'waiting', riskTier: 'medium' },
    ],
  },
};

const inFifteen = () => new Date(Date.now() + 15 * 60_000).toISOString();

export const approvalMediumFixture = (): ApprovalCardBlock => ({
  id: 'blk_aprReferral0001',
  type: 'approval_card',
  version: '1.2.0',
  title: 'Send referral',
  provenance: { agent: 'Referral', runId: 'R-20261026-0051', operations: ['workflow.item.create'], sources: [{ kind: 'workflow', label: 'Referrals', ref: 'workflow:referrals' }] },
  freshness: { kind: 'workflow_event' },
  data: {
    approvalId: 'apr_7Qm2kX9vLp3r',
    summary: 'Send 1 HELOC referral to the Westport lending queue',
    riskTier: 'medium',
    operation: 'workflow.item.create',
    requestedBy: { kind: 'agent_run', runId: 'R-20261026-0051', agent: 'Referral', onBehalfOf: 'user:9229', onBehalfOfName: 'Dana Lee' },
    preview: {
      kind: 'record',
      fields: [
        { label: 'Member', value: 'Suzanne Jackson (…4521)' },
        { label: 'Category / Type', value: 'Lending / HELOC' },
        { label: 'To', value: 'Westport Lending Queue' },
        { label: 'Notes', value: 'Prefers a call after 5 pm' },
      ],
    },
    affected: { records: 1, users: 3, external: 0 },
    confirmation: { methods: ['click', 'keyboard', 'voice'], typedValue: null, stepUp: false, secondApprover: null, noteRequired: false },
    editablePlan: true,
    expiresAt: inFifteen(),
    idempotencyKey: 'idem_2b9f7c1e-5a40-4c55-9d1a-0b6e3c1f2a77',
    previewHash: 'sha256:9e1c4b2a77f0',
  },
});

export const approvalHighFixture = (): ApprovalCardBlock => ({
  id: 'blk_aprPayoutsOct01',
  type: 'approval_card',
  version: '1.2.0',
  title: 'Approve incentive payouts',
  provenance: {
    agent: 'Goals & Incentives',
    runId: 'R-20261026-0042',
    operations: ['gi.payout.approve'],
    sources: [
      { kind: 'table', label: 'Goal Scores (Oct 2026)', ref: 'table:gi_goal_scores' },
      { kind: 'table', label: 'Tier table v3', ref: 'table:gi_tiers', accessible: false },
    ],
  },
  freshness: nightly,
  data: {
    approvalId: 'apr_Gi20261026Wp',
    summary: 'Approve October incentive payouts for Westport branch',
    riskTier: 'high',
    operation: 'gi.payout.approve',
    requestedBy: { kind: 'agent_run', runId: 'R-20261026-0042', agent: 'Goals & Incentives', onBehalfOf: 'user:9229', onBehalfOfName: 'Dana Lee' },
    preview: {
      kind: 'bulk',
      description: '14 payout records move from "Calculated" to "Approved". 3 adjustments included.',
      count: 14,
      columns: [
        { field: 'employee', headerName: 'Employee', type: 'text' },
        { field: 'incentive', headerName: 'Incentive', type: 'text' },
        { field: 'amount', headerName: 'Amount', type: 'currency' },
        { field: 'change', headerName: 'Change', type: 'text' },
      ],
      sample: [
        { employee: 'J. Ortiz', incentive: 'Booked Auto Loan', amount: 640, change: 'Calculated → Approved' },
        { employee: 'M. Chen', incentive: 'New Checking (tier 2)', amount: 410, change: 'Calculated → Approved' },
        { employee: 'A. Patel', incentive: 'HELOC referral credit', amount: 375, change: 'Calculated → Approved' },
      ],
      totals: [{ label: 'Total', value: '$9,720.00' }],
    },
    affected: { records: 14, users: 14, external: 0 },
    confirmation: {
      methods: ['click', 'keyboard'],
      typedValue: { prompt: 'Type the total to confirm', expected: '$9,720.00' },
      stepUp: true,
      secondApprover: { role: 'Regional Manager', policy: 'G&I-2' },
      noteRequired: true,
    },
    editablePlan: true,
    expiresAt: inFifteen(),
    idempotencyKey: 'idem_8f2d0c4a-1e7b-4a2f-9c3d-5b6e7f8a9b0c',
    previewHash: 'sha256:4d7a91c0be23',
  },
});

const noticeData: NoticeBlock['data'][] = [
  { kind: 'no_access', message: 'You do not have access to Northgate loan data.', permission: 'Report Viewer purview: Northgate' },
  {
    kind: 'no_data',
    message: 'No loans matched these filters.',
    detail: 'Filters: Branch is Eastgate · Product is RV · Period is Q3 2026. Try widening the period or removing the product filter.',
  },
  { kind: 'error', message: 'The semantic query timed out.', referenceId: 'err_4c1d', retryable: true },
  {
    kind: 'uncertain',
    message: 'Did you mean loan balances or loan applications?',
    options: [
      { id: 'o1', label: 'Loan balances' },
      { id: 'o2', label: 'Loan applications in the pipeline' },
    ],
  },
  { kind: 'build_status', message: "Last night's build has not completed. Showing data from the 24 Oct build." },
  { kind: 'beta', message: 'Profitability is in beta. Figures may change before general availability.' },
];

// ---- member records (spec 8.24): the demo member's 360 -----------------------------------------

const relationship: Provenance = { agent: 'Relationship', runId: 'R-20261026-0107', operations: ['relationship.profile.get'], sources: [{ kind: 'table', label: 'Relationship Manager', ref: 'table:cdm_party' }], purviewApplied: true };
const attrition: MemberScore = { id: 'attrition', label: 'Attrition risk', value: 6, scale: 10, band: 'Medium', tone: 'warning', modelDate: '2026-10-25' };
const nextBest: MemberScore = { id: 'next_best', label: 'Next best product', value: 10, scale: 10, band: 'Checking', tone: 'accent', modelDate: '2026-10-25' };
const header = {
  memberRef: 'mbr_q-LFkkQn1x8UPxgUqaaGUQ',
  person: 'member' as const,
  displayName: 'Suzanne Jackson',
  maskedNumber: '…4521',
  branch: 'Westport',
  since: '2024',
  badges: [
    { label: 'Primary', tone: 'neutral' as const },
    { label: 'Young Adult', tone: 'info' as const },
    { label: 'Westport', tone: 'neutral' as const },
  ],
};

export const memberCardFixture: MemberCardBlock = {
  id: 'blk_mbrCardSuzanne01',
  type: 'member_card',
  version: '1.0.0',
  provenance: relationship,
  freshness: nightly,
  data: {
    ...header,
    figures: [
      { label: 'Accounts', value: 1, unit: 'count' },
      { label: 'Deposits', value: 5389.94, unit: 'currency' },
      { label: 'Loans', value: 0, unit: 'currency' },
    ],
    scores: [attrition, nextBest],
    nextBest: ['Checking', 'Credit card'],
    selected: true,
  },
};

export const member360Fixture: Member360Block = {
  id: 'blk_mbr360Suzanne01',
  type: 'member_360',
  version: '1.0.0',
  title: 'Member 360',
  provenance: relationship,
  freshness: nightly,
  data: {
    ...header,
    alerts: [{ id: 'app_pending', label: 'Auto loan application pending', tone: 'info' }],
    sections: [
      {
        kind: 'overview',
        figures: [
          { label: 'Deposits', value: 5389.94, unit: 'currency', detail: '−18% in 30 days' },
          { label: 'Loans', value: 0, unit: 'currency' },
          { label: 'Products', value: 1, unit: 'count' },
        ],
        scores: [attrition, nextBest],
        facts: [
          { label: 'Segment', value: 'Young Adult' },
          { label: 'Member since', value: 'Feb 13, 2024' },
        ],
      },
      { kind: 'accounts', deposits: [{ name: 'Share Savings', suffix: '0001', relationship: 'Primary', balance: 5389.94, change30d: -1200.06, fees30d: 0, rate: 0.21 }], loans: [] },
      {
        kind: 'digital',
        services: [
          { id: 'online_banking', label: 'Online banking', enrolled: true, detail: 'Since Mar 2024' },
          { id: 'mobile', label: 'Mobile app', enrolled: true, detail: 'Last login Sep 8, 2026' },
          { id: 'mobile_deposit', label: 'Mobile deposit', enrolled: false },
          { id: 'estatements', label: 'eStatements', enrolled: false },
          { id: 'direct_deposit', label: 'Direct deposit', enrolled: false },
        ],
      },
      {
        kind: 'cross_sell',
        windows: [
          { days: 30, total: 0, services: 0, loan: 0, deposit: 0 },
          { days: 60, total: 0, services: 0, loan: 0, deposit: 0 },
          { days: 90, total: 0, services: 0, loan: 0, deposit: 0 },
        ],
        crossSell: 1,
        attrition,
      },
      { kind: 'loan_apps', approved: 0, denied: 0, pending: 1, items: [{ product: 'Auto loan', amount: 18500, status: 'Pending', detail: 'Waiting for a pay stub', applied: '2026-10-18' }] },
      {
        kind: 'engagement',
        attrition,
        factors: [
          { label: 'Deposit balances down 18% in 30 days', weight: 2 },
          { label: 'Holds only one product', weight: 2 },
        ],
        facts: [{ label: 'Direct deposit', value: 'Not set up' }],
      },
      {
        kind: 'opportunities',
        threshold: 6,
        items: [
          { suggestionId: 1, product: 'Checking', likelihood: 10, reason: 'No checking account; deposits are in Share Savings only', referralTypeId: null },
          { suggestionId: 2, product: 'Credit card', likelihood: 7, reason: 'No credit card with us', referralTypeId: 'credit_card' },
        ],
        declined: [],
      },
      { kind: 'interactions', total: 4, items: [{ at: '2026-10-18T10:42:00', channel: 'Branch', kind: 'Branch visit', summary: 'Applied for an auto loan', by: 'Ana Ruiz' }] },
      { kind: 'rewards', status: 'not_configured', detail: 'Rewards are not set up for this institution.' },
      { kind: 'contact', preferred: 'Text', email: 's•••@example.com', phone: '(•••) •••-7919' },
      { kind: 'household', members: [{ name: null, branch: null, maskedNumber: null, inPurview: false }] },
    ],
  },
};

// ---- report canvas (spec 8.9): a draft with one agent change waiting for review -------------------

export const reportCanvasFixture: ReportCanvasBlock = {
  id: 'blk_rptAlcoDraft0001',
  type: 'report_canvas',
  version: '1.0.0',
  title: 'ALCO pack',
  subtitle: 'Sep 2026',
  provenance: { agent: 'Report Builder', runId: 'R-20261026-0201', operations: ['report.run'], sources: [{ kind: 'template', label: 'ALCO pack', ref: 'report:draft_a1b2c3' }] },
  freshness: nightly,
  data: {
    templateRef: 'draft_a1b2c3',
    name: 'ALCO pack',
    description: 'Loan balances, deposit mix and delinquency for the asset-liability committee.',
    folder: 'Drafts',
    status: 'draft',
    mode: 'edit',
    version: 2,
    periodLabel: 'Sep 2026',
    controls: [
      { id: 'period', kind: 'period', label: 'Month', value: '2026-09', options: [{ value: '2026-09', label: 'Sep 2026' }, { value: '2026-08', label: 'Aug 2026' }] },
      { id: 'node', kind: 'hierarchy', label: 'Branch', value: 'all', options: [{ value: 'all', label: 'All branches' }, { value: 'Westport', label: 'Westport' }] },
    ],
    widgets: [
      { id: 'k1', title: 'Total loans', gridPos: { x: 0, y: 0, w: 6, h: 2 }, view: { ...kpiFixture, id: 'blk_rptKpiLoans0001' } },
      { id: 'c1', title: 'Loan growth by branch', gridPos: { x: 6, y: 0, w: 6, h: 4 }, view: { ...chartFixture, id: 'blk_rptChartBranch01' }, editId: 'e1' },
    ],
    pendingEdits: [{ id: 'e1', widgetId: 'c1', summary: 'Made “Loan growth by branch” a bar chart', kind: 'change' }],
  },
};

export const noticeFixtures: NoticeBlock[] = noticeData.map((data, i) => ({
  id: `blk_notice${String(i).padStart(8, '0')}`,
  type: 'notice',
  version: '1.0.0',
  provenance: { agent: 'DI Concierge', sources: [] },
  freshness: data.kind === 'build_status' ? { kind: 'nightly_build', asOf: '2026-10-24T04:12:00-04:00', stale: true } : { kind: 'none' },
  data,
}));
