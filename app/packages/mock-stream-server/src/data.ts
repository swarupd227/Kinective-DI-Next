// Synthetic tenant data for the mock Experience Layer. Institutions, people and figures are
// fictional. Personas follow spec 6.16 so the shell can be reviewed through different roles.
import type {
  AppId,
  ApprovalCardBlock,
  BuildStatus,
  HomeBriefing,
  KpiGroupBlock,
  ListBlock,
  SearchResult,
  Session,
  TableData,
} from '@dinext/block-schemas';
import { approvalHighFixture, chartFixture, kpiGroupFixture, lineChartFixture, nightly, tableFixture } from '@dinext/block-schemas/fixtures';

export type PersonaId = 'executive' | 'analyst' | 'branch' | 'lender' | 'msr' | 'bank_cfo' | 'admin';

interface Persona {
  session: Omit<Session, 'build' | 'timeouts' | 'flags' | 'slashCommands' | 'personas' | 'voice'>;
  /** Branch-floor classes (MSR, teller) do not hear answers spoken aloud by default (FE-VOICE-081). */
  floor?: boolean;
  /** Branches whose rows this persona may see; undefined means every branch (spec 20.7 purview). */
  purview?: string[];
  /** The staff record behind this user, when they work queues themselves. */
  employeeId?: number;
  /** Told about everything new in their purview's queues, not only their own. */
  leadsBranch?: boolean;
  /** Application Details in the Loan Pipeline access matrix; without it, totals only (FE-LAP-004). */
  lapDetails?: boolean;
  /** May change stall thresholds (AI-AGT-180). */
  lendingAdmin?: boolean;
  suggestions: string[];
}

const ALL_BRANCHES = ['Westport', 'Northgate', 'Riverside', 'Lakeshore', 'Downtown', 'Eastgate'];
const CU = { id: 'tnt_harborview', name: 'Harborview Federal Credit Union', institutionType: 'credit_union' as const };
const BANK = { id: 'tnt_coastal', name: 'Coastal Community Bank', institutionType: 'bank' as const };

const user = (id: string, name: string, title: string, persona: string) => ({
  id,
  name,
  firstName: name.split(' ')[0]!,
  initials: name
    .split(' ')
    .map((p) => p[0])
    .join(''),
  title,
  persona,
});

export const PERSONAS: Record<PersonaId, Persona> = {
  executive: {
    session: {
      user: user('user:9229', 'Dana Lee', 'President and CEO', 'Executive'),
      tenant: CU,
      apps: ['home', 'conversations', 'reports', 'tables', 'workflows', 'calendar', 'files', 'rm', 'referrals', 'lap', 'gi', 'seg', 'callreport'],
      permissions: { queryBrowser: false, dashboardAdmin: true },
    },
    lapDetails: true,
    lendingAdmin: true,
    suggestions: ['Get me ready for Thursday’s ALCO meeting', 'Find members at risk of leaving and draft follow-ups', 'Prepare me for my meeting with Suzanne Jackson', 'Brief me'],
  },
  analyst: {
    session: {
      user: user('user:4410', 'Priya Shah', 'BI Manager', 'Analyst'),
      tenant: CU,
      apps: ['home', 'conversations', 'reports', 'tables', 'queries', 'datalogs', 'workflows', 'files', 'rm', 'referrals', 'lap'],
      permissions: { queryBrowser: true, dashboardAdmin: false },
    },
    suggestions: ['/query loans opened last week by branch', 'Build a table summary of fees by product', 'Show loan growth by branch for Q3 vs Q2', 'Find certificates at risk of leaving'],
  },
  branch: {
    session: {
      user: user('user:5120', 'Marcus Reed', 'Branch Manager, Westport', 'Retail leader'),
      tenant: CU,
      apps: ['home', 'conversations', 'reports', 'workflows', 'calendar', 'rm', 'referrals', 'lap', 'gi'],
      permissions: { queryBrowser: false, dashboardAdmin: false },
    },
    purview: ['Westport'],
    employeeId: 6,
    leadsBranch: true,
    lapDetails: true,
    suggestions: ['What’s on my team’s plate?', 'Show the pipeline by product for my branch', 'Prepare me for my meeting with Suzanne Jackson', 'Find members at risk of leaving and draft follow-ups', 'Refer Suzanne Jackson for a HELOC, she prefers a call after 5 pm', 'Show my overdue onboarding touch points', 'Show Northgate loan detail'],
  },
  lender: {
    session: {
      user: user('user:6101', 'Ana Ruiz', 'Loan Officer, Westport', 'Lender'),
      tenant: CU,
      apps: ['home', 'conversations', 'workflows', 'rm', 'referrals', 'lap'],
      permissions: { queryBrowser: false, dashboardAdmin: false },
    },
    purview: ['Westport'],
    employeeId: 1,
    lapDetails: true,
    suggestions: ['Which of my apps have sat in underwriting more than five days?', 'Show my stalled applications', 'Create follow-up tasks for my stalled applications', 'What’s on my plate today?'],
  },
  msr: {
    session: {
      user: user('user:6004', 'Sofia Ruiz', 'Member Services, Westport', 'Frontline'),
      tenant: CU,
      apps: ['home', 'conversations', 'workflows', 'rm', 'referrals'],
      permissions: { queryBrowser: false, dashboardAdmin: false },
    },
    floor: true,
    purview: ['Westport'],
    employeeId: 4,
    suggestions: ['What’s on my plate today?', 'Show my overdue referrals', 'Prepare me for my meeting with Suzanne Jackson'],
  },
  bank_cfo: {
    session: {
      user: user('user:7001', 'Elena Ortiz', 'Chief Financial Officer', 'Finance leader'),
      tenant: BANK,
      // Bank tenants never see 5300 Call Report or SEG Management (FE-EXP-003).
      apps: ['home', 'conversations', 'reports', 'tables', 'workflows', 'files', 'rm', 'lap', 'gi'],
      permissions: { queryBrowser: false, dashboardAdmin: false },
    },
    suggestions: ['Get me ready for Thursday’s ALCO meeting', 'Brief me', 'Show loan growth by branch for Q3 vs Q2', 'Approve October incentive payouts for Westport'],
  },
  admin: {
    session: {
      user: user('user:1002', 'Sam Taylor', 'DI Administrator', 'Administrator'),
      tenant: CU,
      apps: ['home', 'conversations', 'tables', 'queries', 'datalogs', 'users', 'admin', 'files'],
      permissions: { queryBrowser: true, dashboardAdmin: true },
    },
    suggestions: ['Did last night\'s build finish?', 'Create a user for Maria Gomez as a Westport MSR', 'Which uploaders missed their late-file time?', 'Run the protocol resilience test'],
  },
};

/** Slash commands and the app each needs (spec 6.15, FE-EXP-131). */
const SLASH: [string, AppId | null][] = [
  ['/ask', null],
  ['/brief', null],
  ['/help', null],
  ['/report', 'reports'],
  ['/table', 'tables'],
  ['/query', 'queries'],
  ['/member', 'rm'],
  ['/refer', 'referrals'],
  ['/workflow', 'workflows'],
  ['/log', 'datalogs'],
  ['/user', 'users'],
];

/** Whether a speech service is configured; set by the server at start. */
export type VoiceStatus = { available: boolean; reason?: string };
const NO_VOICE: VoiceStatus = { available: false, reason: 'Voice isn’t set up in this environment.' };

export function sessionFor(id: PersonaId, voice: VoiceStatus = NO_VOICE): Session {
  const p = PERSONAS[id];
  const apps = new Set(p.session.apps);
  const slash = SLASH.filter(([, app]) => !app || apps.has(app)).map(([c]) => (c === '/member' && p.session.tenant.institutionType === 'bank' ? '/customer' : c));
  return {
    ...p.session,
    slashCommands: slash,
    flags: { voiceMediumConfirm: true, handsFree: false },
    voice: { ...voice, speakByDefault: !p.floor },
    build: buildFor(id),
    timeouts: { idleMinutes: 15, absoluteHours: 12 },
    personas: (Object.keys(PERSONAS) as PersonaId[]).map((k) => ({ id: k, label: `${PERSONAS[k].session.user.name} · ${PERSONAS[k].session.user.persona}${PERSONAS[k].session.tenant.institutionType === 'bank' ? ' (bank)' : ''}` })),
  };
}

export function buildFor(id: PersonaId): BuildStatus {
  // The bank tenant's build is late, to show the stale-build notice (FE-EXP-010).
  return id === 'bank_cfo'
    ? { state: 'late', asOf: '2026-10-25T04:06:00-04:00', buildId: 'bld_20261025', expectedBy: '2026-10-26T05:00:00-04:00', message: "Last night's build has not finished. It was expected by 05:00." }
    : { state: 'completed', asOf: '2026-10-26T04:10:00-04:00', buildId: 'bld_20261026' };
}

// ---- Home ---------------------------------------------------------------------------------------

let seq = 0;
const bid = (prefix: string) => `blk_${prefix}${String(++seq).padStart(10, '0')}`.slice(0, 32);

const list = (title: string, agent: string, items: ListBlock['data']['items'], layout: 'list' | 'columns' = 'list', stale = false): ListBlock => ({
  id: bid('lst'),
  type: 'list',
  version: '1.0.0',
  title,
  provenance: { agent, sources: [] },
  freshness: stale ? { ...nightly, asOf: '2026-10-25T04:06:00-04:00', stale: true } : nightly,
  data: { items, layout },
});

const kpis = (id: PersonaId): KpiGroupBlock => {
  const base = { ...kpiGroupFixture, id: bid('kpg'), title: undefined };
  if (id === 'branch') {
    return {
      ...base,
      provenance: { ...base.provenance, filters: ['Limited to your purview: Westport'] },
      data: {
        layout: 'row',
        items: [
          { label: 'New members', value: 9, unit: 'count', comparison: { label: 'month to date', value: 186, unit: 'count', direction: 'flat', goodWhen: 'up' }, metricRef: 'metric:new_members' },
          { label: 'New loans', value: 2_410_000, unit: 'currency', format: { compact: true, decimals: 2 }, comparison: { label: 'vs prior build', value: 1.8, unit: 'percent', direction: 'up', goodWhen: 'up' }, sparkline: [1.9, 2.0, 2.1, 2.0, 2.2, 2.3, 2.41], metricRef: 'metric:new_loan_dollars' },
          { label: 'Referrals open', value: 23, unit: 'count', comparison: { label: 'sold this month', value: 41, unit: 'count', direction: 'flat', goodWhen: 'up' }, metricRef: 'metric:referrals_open' },
          { label: 'Goal attainment', value: 87.5, unit: 'percent', comparison: { label: 'vs last month', value: -3.1, unit: 'percent', direction: 'down', goodWhen: 'up' }, metricRef: 'metric:goal_attainment' },
        ],
      },
    };
  }
  if (id === 'bank_cfo') {
    return {
      ...base,
      freshness: { ...nightly, asOf: '2026-10-25T04:06:00-04:00', stale: true },
      data: {
        layout: 'row',
        items: [
          { ...kpiGroupFixture.data.items[0]!, value: 842_300_000 },
          { ...kpiGroupFixture.data.items[1]!, value: 1_104_800_000 },
          { label: 'Net interest margin', value: 3.42, unit: 'percent', format: { decimals: 2 }, comparison: { label: 'vs last quarter', value: -6, unit: 'bp', direction: 'down', goodWhen: 'up' }, metricRef: 'metric:nim' },
          { ...kpiGroupFixture.data.items[2]!, value: 0.48 },
        ],
      },
    };
  }
  return base;
};

const lookAt = (id: PersonaId): ListBlock =>
  list(
    'Things to look at',
    'Dashboard/Briefing',
    id === 'branch'
      ? [
          { id: 'l1', icon: 'referral', title: '2 HELOC referrals have waited more than 3 days', subtitle: 'Both are assigned to the Westport lending queue', link: '/workflows/referrals/inbox', badge: { label: 'Due', tone: 'warning' }, why: 'Referrals are flagged when they pass 3 business days without a follow-up, the response time in your referral type settings.' },
          { id: 'l2', icon: 'trend_down', title: 'Goal attainment fell 3.1 points this month', subtitle: 'Checking openings are 22 behind pace', why: 'Attainment is compared with the same day last month. The gap comes mostly from the New Checking goal.' },
        ]
      : [
          { id: 'l1', icon: 'trend_down', title: 'Northgate: new auto loans 41% below its 12-week range', subtitle: 'Indirect volume from two dealers stopped last week', link: '/c/new?q=Why%20did%20Northgate%20auto%20loans%20drop', badge: { label: 'Anomaly', tone: 'warning' }, why: 'The Briefing agent compares each branch with its own 12-week range. Northgate fell outside the range on 3 of the last 5 builds.' },
          { id: 'l2', icon: 'certificate', title: '3 certificates over $250k mature in the next 14 days', subtitle: '$1.12M in total, all at Downtown', link: '/c/new?q=Find%20certificates%20at%20risk%20of%20leaving', why: 'Large maturities are listed when they fall within 14 days and the member has no renewal instruction on file.' },
          { id: 'l3', icon: 'alert', title: 'Delinquency 60+ crossed the 0.70% watch level', subtitle: 'Up 4 bp since yesterday, led by Eastgate', badge: { label: 'Watch', tone: 'danger' }, why: 'The watch level is set in your tenant settings. This is the first time it has been crossed since June.' },
        ],
  );

const yourWork = (id: PersonaId): ListBlock =>
  list(
    'Your work',
    'DI Concierge',
    [
      { id: 'w1', icon: 'inbox', title: 'Referrals inbox', meta: '6 open', subtitle: '2 due today', link: '/workflows/referrals/inbox', badge: { label: '2 due', tone: 'warning' } },
      { id: 'w2', icon: 'task', title: 'Tasks', meta: '1 overdue', subtitle: 'Follow-ups 4', link: '/calendar' },
      { id: 'w3', icon: 'calendar', title: id === 'branch' ? 'Team huddle' : 'ALCO committee', meta: id === 'branch' ? '09:30' : '14:00', subtitle: 'Today', link: '/calendar' },
    ],
    'list',
  );

const scheduled = (id: PersonaId): ListBlock =>
  list('Scheduled reports', 'Report Builder', [
    { id: 's1', icon: 'report', title: id === 'bank_cfo' ? 'Board finance pack' : 'ALCO monthly pack', subtitle: 'Ran 04:40', link: '/reports/alco_monthly_pack', badge: { label: 'Ran', tone: 'success' } },
    { id: 's2', icon: 'report_failed', title: 'Branch scorecard', subtitle: 'Failed: no data for Eastgate', link: '/reports/branch_scorecard_monthly', badge: { label: 'Failed', tone: 'danger' }, why: 'The report needs the Eastgate goal scores, which the nightly build did not load. The Goals & Incentives upload arrived after the build started.' },
  ]);

export function homeFor(id: PersonaId, approvals: ApprovalCardBlock[]): HomeBriefing {
  const p = PERSONAS[id];
  const build = buildFor(id);
  const sections: HomeBriefing['sections'] = [];
  if (build.state !== 'completed') {
    sections.push({
      id: 'build_notice',
      title: 'Nightly build',
      blocks: [
        {
          id: bid('ntc'),
          type: 'notice',
          version: '1.0.0',
          provenance: { agent: 'DI Concierge', sources: [] },
          freshness: { kind: 'nightly_build', asOf: build.asOf, buildId: build.buildId, stale: true },
          data: { kind: 'build_status', message: build.message ?? 'Last night’s build has not completed.', detail: 'Figures below come from the last successful build. They will refresh when the build finishes.' },
        },
      ],
    });
  }
  if (approvals.length) sections.push({ id: 'approvals', title: 'Needs your approval', blocks: approvals });
  sections.push({ id: 'what_changed', title: build.state === 'completed' ? "What changed since yesterday's build" : 'What changed in the last completed build', blocks: [kpis(id)] });
  sections.push({ id: 'look_at', title: 'Things to look at', blocks: [lookAt(id)] });
  sections.push({ id: 'your_work', title: 'Your work', blocks: [yourWork(id)] });
  sections.push({ id: 'scheduled_reports', title: 'Scheduled reports', blocks: [scheduled(id)] });
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(new Date()));
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return {
    greeting: `Good ${part}, ${p.session.user.firstName}`,
    build,
    sections,
    tabs: [
      { id: 'my-home', label: 'My Home', blocks: [{ ...lineChartFixture, id: bid('chl') }, { ...tableFixture, id: bid('tbl') }] },
      { id: 'metrics', label: 'Metrics', blocks: [{ ...chartFixture, id: bid('chb') }] },
    ],
    suggestions: p.suggestions,
  };
}

/** Home approval cards for personas that have pending work (spec 6.3 FE-EXP-011). */
/** Who hears about work landing in a queue: the person it went to, and whoever leads that branch. */
export function usersToTell(employeeId: number | undefined, branch: string | undefined) {
  return Object.values(PERSONAS)
    .filter((p) => (employeeId !== undefined && p.employeeId === employeeId) || (p.leadsBranch && branch !== undefined && p.purview?.includes(branch)))
    .map((p) => p.session.user.id);
}

export function homeApprovals(id: PersonaId, mkId: (p: string, n?: number) => string): ApprovalCardBlock[] {
  if (id !== 'executive' && id !== 'bank_cfo') return [];
  const expires = new Date(Date.now() + 8 * 3600_000).toISOString();
  const dataLog: ApprovalCardBlock = {
    id: mkId('blk_', 16),
    type: 'approval_card',
    version: '1.2.0',
    title: 'Data log',
    provenance: { agent: 'Data Logs', operations: ['datalog.entry.approve'], sources: [{ kind: 'workflow', label: 'Data Logs', ref: 'datalog:4471' }] },
    freshness: { kind: 'workflow_event' },
    data: {
      approvalId: mkId('apr_', 14),
      summary: 'Approve data log #4471 "Branch cash count adjustment"',
      riskTier: 'medium',
      operation: 'datalog.entry.approve',
      requestedBy: { kind: 'user', onBehalfOf: 'user:3310', onBehalfOfName: 'J. Ortiz' },
      preview: {
        kind: 'diff',
        changes: [
          { label: 'Westport vault cash', before: '$412,300.00', after: '$411,950.00' },
          { label: 'Reason', before: '—', after: 'Recount after armoured car delivery' },
        ],
      },
      affected: { records: 1, users: 1, external: 0 },
      confirmation: { methods: ['click', 'keyboard', 'voice'], typedValue: null, stepUp: false, secondApprover: null, noteRequired: false },
      editablePlan: false,
      expiresAt: expires,
      idempotencyKey: `idem_${mkId('', 24)}`,
      previewHash: 'sha256:7b1e4a90cc21',
    },
  };
  const payout = approvalHighFixture();
  return [dataLog, { ...payout, id: mkId('blk_', 16), data: { ...payout.data, approvalId: mkId('apr_', 14), requestedBy: { ...payout.data.requestedBy, kind: 'agent_run' }, expiresAt: expires } }];
}

// ---- Search ---------------------------------------------------------------------------------------

const memberLink = (token: string, bank: boolean) => (bank ? `/customers/${token}` : `/members/${token}`);

export function searchFor(id: PersonaId, q: string, threads: { threadId: string; title: string }[]): SearchResult[] {
  const p = PERSONAS[id];
  const bank = p.session.tenant.institutionType === 'bank';
  const purview = p.purview ?? ALL_BRANCHES;
  const apps = new Set(p.session.apps);
  const catalog: (SearchResult & { branch?: string; app?: AppId })[] = [
    { kind: 'report', id: 'alco', label: 'ALCO monthly pack', detail: 'Reports / Finance', link: '/reports/alco_monthly_pack', app: 'reports' },
    { kind: 'report', id: 'exec-summary', label: 'Executive summary', detail: 'Reports / Executive', link: '/reports/executive_summary_quarterly', app: 'reports' },
    { kind: 'report', id: 'branch-scorecard', label: 'Branch scorecard', detail: 'Reports / Retail', link: '/reports/branch_scorecard_monthly', app: 'reports' },
    { kind: 'report', id: 'lap-summary', label: 'Current loan app pipeline summary', detail: 'Reports / Lending', link: '/reports/summary/lap-summary', app: 'reports' },
    { kind: 'table', id: 'loan_accounts', label: 'Loan Accounts', detail: 'Tables / Curated', link: '/tables/loan_accounts', app: 'tables' },
    { kind: 'table', id: 'deposit_accounts', label: 'Deposit Accounts', detail: 'Tables / Curated', link: '/tables/deposit_accounts', app: 'tables' },
    { kind: 'table', id: 'certificates', label: 'Certificates', detail: 'Tables / Curated', link: '/tables/certificates', app: 'tables' },
    { kind: 'view', id: 'my-delinquent-auto', label: 'My delinquent auto', detail: 'Saved view on Loan Accounts', link: '/tables/loan_accounts?view=my-delinquent-auto', app: 'tables' },
    { kind: 'dashboard', id: 'exec-dash', label: 'Executive dashboard', detail: 'Dashboards', link: '/home/metrics' },
    { kind: 'workflow', id: 'referrals', label: 'Referrals inbox', detail: 'Workflows', link: '/workflows/referrals/inbox', app: 'workflows' },
    // Members show name, masked number and branch only until opened (FE-SRCH-002).
    { kind: 'member', id: 'mbr_tok_5f2a9c', label: 'Suzanne Jackson', detail: '…4521 · Westport', link: memberLink('mbr_tok_5f2a9c', bank), branch: 'Westport', app: 'rm' },
    { kind: 'member', id: 'mbr_tok_88c01e', label: 'Robert Jackson', detail: '…8830 · Northgate', link: memberLink('mbr_tok_88c01e', bank), branch: 'Northgate', app: 'rm' },
    { kind: 'member', id: 'mbr_tok_1d7b42', label: 'Ana Jacobs', detail: '…1176 · Downtown', link: memberLink('mbr_tok_1d7b42', bank), branch: 'Downtown', app: 'rm' },
    { kind: 'employee', id: 'emp_ortiz', label: 'J. Ortiz', detail: 'MSR · Westport', link: '/m/gi/scorecard/emp_ortiz', branch: 'Westport', app: 'gi' },
    { kind: 'employee', id: 'emp_ruiz', label: 'Ana Ruiz', detail: 'Loan officer · Westport', link: '/m/gi/scorecard/emp_ruiz', branch: 'Westport', app: 'gi' },
    ...ALL_BRANCHES.map((b) => ({ kind: 'branch' as const, id: `loc:${b.toLowerCase()}`, label: b, detail: 'Branch', link: `/c/new?q=${encodeURIComponent(`Brief me on ${b}`)}`, branch: b })),
  ];
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const words = needle.split(/\s+/);
  const matches = (s: string) => words.every((w) => s.toLowerCase().includes(w));
  return [
    ...catalog.filter((r) => (!r.app || apps.has(r.app)) && (!r.branch || purview.includes(r.branch)) && matches(`${r.label} ${r.detail ?? ''}`)),
    ...threads.filter((t) => matches(t.title)).map((t) => ({ kind: 'thread' as const, id: t.threadId, label: t.title, detail: 'Conversation', link: `/c/${t.threadId}` })),
  ]
    .slice(0, 20)
    .map(({ kind, id: rid, label, detail, link }) => ({ kind, id: rid, label, detail, link }));
}

// ---- Tables ---------------------------------------------------------------------------------------

/** Small deterministic PRNG so the synthetic table is the same on every run. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const FIRST = ['Suzanne', 'Robert', 'Ana', 'James', 'Maria', 'David', 'Grace', 'Omar', 'Lena', 'Victor', 'Hannah', 'Kofi', 'Mei', 'Paul', 'Rosa'];
const LAST = ['Jackson', 'Nguyen', 'Patel', 'Garcia', 'Okafor', 'Kim', 'Brown', 'Silva', 'Novak', 'Haddad', 'Lopez', 'Murphy'];
const PRODUCTS: [string, number, number][] = [
  ['Auto', 8_000, 45_000],
  ['HELOC', 20_000, 180_000],
  ['Mortgage', 120_000, 520_000],
  ['Personal', 2_000, 25_000],
  ['Credit card', 500, 15_000],
];

export function tableFor(id: PersonaId, tableId: string): TableData | null {
  if (tableId !== 'loan_accounts') return null;
  const purview = PERSONAS[id].purview ?? ALL_BRANCHES;
  const r = rng(42);
  const rows: TableData['rows'] = [];
  for (let i = 0; i < 240; i++) {
    const [product, lo, hi] = PRODUCTS[Math.floor(r() * PRODUCTS.length)]!;
    const branch = ALL_BRANCHES[Math.floor(r() * ALL_BRANCHES.length)]!;
    const opened = new Date(Date.UTC(2019 + Math.floor(r() * 7), Math.floor(r() * 12), 1 + Math.floor(r() * 27)));
    const dpd = r() < 0.9 ? 0 : [12, 34, 61, 95][Math.floor(r() * 4)]!;
    rows.push({
      account: `…${String(1000 + Math.floor(r() * 9000))}`,
      member: `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`,
      branch,
      product,
      balance: Math.round(lo + r() * (hi - lo)),
      rate: Math.round((3 + r() * 9) * 100) / 100,
      opened: opened.toISOString().slice(0, 10),
      daysPastDue: dpd,
    });
  }
  const visible = rows.filter((row) => purview.includes(String(row.branch)));
  return {
    tableId,
    label: 'Loan Accounts',
    columns: [
      { field: 'account', headerName: 'Account', type: 'text' },
      { field: 'member', headerName: PERSONAS[id].session.tenant.institutionType === 'bank' ? 'Customer' : 'Member', type: 'text' },
      { field: 'branch', headerName: 'Branch', type: 'text' },
      { field: 'product', headerName: 'Product', type: 'text' },
      { field: 'balance', headerName: 'Balance', type: 'currency' },
      { field: 'rate', headerName: 'Rate', type: 'percent' },
      { field: 'opened', headerName: 'Opened', type: 'date' },
      { field: 'daysPastDue', headerName: 'Days past due', type: 'days' },
    ],
    rows: visible,
    rowCount: visible.length,
    freshnessAsOf: buildFor(id).asOf,
  };
}

export const isPersona = (p: string | null): p is PersonaId => !!p && p in PERSONAS;
