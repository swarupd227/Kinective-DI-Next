// Experience Layer REST shapes used by the shell (spec 11.3, 12.1). Shared by the client and the
// mock server so both sides of the contract stay in step.
import type { Block } from './blocks.ts';

export type InstitutionType = 'credit_union' | 'bank';

/** Apps in the navigation rail (spec 6.2). Business modules appear only when licensed. */
export type AppId =
  | 'home'
  | 'conversations'
  | 'reports'
  | 'tables'
  | 'workflows'
  | 'calendar'
  | 'files'
  | 'datalogs'
  | 'queries'
  | 'users'
  | 'admin'
  | 'rm'
  | 'referrals'
  | 'lap'
  | 'gi'
  | 'seg'
  | 'callreport'
  | 'indirect'
  | 'prospecting'
  | 'campaigns'
  | 'onboarding'
  | 'compliance'
  | 'predictive'
  | 'dq'
  | 'tasks'
  | 'integrations'
  | 'classes'
  | 'wfbuilder';

export interface BuildStatus {
  state: 'completed' | 'running' | 'failed' | 'late';
  /** Time of the build the data comes from (the last successful one when this one failed). */
  asOf: string;
  buildId: string;
  expectedBy?: string;
  message?: string;
}

/** GET /v1/session (spec 11.3). Access is enforced by the server; the client only shows or hides. */
export interface Session {
  user: { id: string; name: string; firstName: string; initials: string; persona: string; title: string };
  tenant: { id: string; name: string; institutionType: InstitutionType };
  apps: AppId[];
  permissions: { queryBrowser: boolean; dashboardAdmin: boolean };
  slashCommands: string[];
  flags: { voiceMediumConfirm: boolean; handsFree: boolean };
  /**
   * Voice for this user (spec 7). `available` is false when the tenant has voice off or no speech
   * service is configured; the client then shows why instead of a working microphone.
   * `speakByDefault` is false for branch-floor classes (FE-VOICE-081).
   */
  voice: { available: boolean; reason?: string; speakByDefault: boolean };
  build: BuildStatus;
  timeouts: { idleMinutes: number; absoluteHours: number };
  /** Mock only: personas a developer can switch between. */
  personas?: { id: string; label: string }[];
}

export interface ThreadSummary {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  turns: number;
}

/** GET /v1/home: the per-user briefing assembled after each nightly build (spec 6.3). */
export interface HomeBriefing {
  greeting: string;
  /** What changed, written out in a few sentences from computed values. */
  narrative?: string;
  build: BuildStatus;
  sections: HomeSection[];
  tabs: { id: string; label: string; blocks: Block[] }[];
  suggestions: string[];
}

export type HomeSectionId = 'build_notice' | 'approvals' | 'what_changed' | 'look_at' | 'your_work' | 'scheduled_reports';

export interface HomeSection {
  id: HomeSectionId;
  title: string;
  blocks: Block[];
  /** For a card waiting in a task: its approval ID and the task it came from. */
  tasks?: Record<string, string>;
}

export type SearchResultKind = 'report' | 'table' | 'view' | 'member' | 'employee' | 'branch' | 'workflow' | 'thread' | 'dashboard';

/** GET /v1/search: typed results within the user's purview (spec 8.3). */
export interface SearchResult {
  kind: SearchResultKind;
  id: string;
  label: string;
  detail?: string;
  /** A DI Next deep link; member links use opaque tokens, never member numbers (FE-ARCH-011). */
  link: string;
}

export type NotificationGroup = 'approvals' | 'workflow' | 'system' | 'agent_runs';

export interface AppNotification {
  id: string;
  group: NotificationGroup;
  title: string;
  detail?: string;
  at: string;
  link?: string;
  read: boolean;
  /** Set when it is meant for one person; otherwise it belongs to whoever is signed in. */
  userId?: string;
}

/** New Referral, Active, Sold, Not Interested, Done, or a stage the published Referral workflow adds. */
export type ReferralStageName = string;

/** One line of GET /v1/referrals. Members appear by name and masked number, with an opaque token. */
export interface ReferralSummary {
  comId: number;
  typeLabel: string;
  category: string;
  memberRef: string;
  name: string;
  last4: string;
  branch: string;
  stage: ReferralStageName;
  priority: string;
  queueName: string;
  assignee: { employeeId: number; name: string } | null;
  senderName: string;
  createdAt: string;
  ageDays: number;
  dueAt: string;
  overdue: boolean;
  notes: string | null;
  fields: Record<string, string | number>;
}

export interface ReferralDetail extends ReferralSummary {
  history: { kind: string; text: string; at: string }[];
  team: { employeeId: number; name: string }[];
  /** Whether this user may change it: being the sender lets you read it, not work it. */
  canWork: boolean;
  /** The stage bar, from the published Referral workflow. */
  stages?: string[];
}

export interface ReferralsIndex {
  take: DiTake;
  items: ReferralSummary[];
  counts: { mine: number; team: number; overdue: number };
  /** False for leads and others who look after a team, whose view starts there. */
  hasOwnQueue: boolean;
}

/** A person's own action in the inbox. Actions an agent proposes go through an approval card instead. */
export type ReferralAction = { kind: 'start' } | { kind: 'note'; text: string } | { kind: 'close'; stage: 'Sold' | 'Not Interested' | 'Done'; note?: string } | { kind: 'assign'; employeeId: number };

/** DI's view of a page: one sentence, and the next step it would take. Code writes both. */
export type AppViewId = 'calendar' | 'files' | 'queries' | 'users' | 'admin' | 'datalogs' | 'seg' | 'callreport' | 'workflows' | 'rm' | 'indirect' | 'prospecting' | 'campaigns' | 'onboarding' | 'compliance' | 'predictive' | 'dq' | 'tasks' | 'integrations' | 'classes' | 'wfbuilder' | 'tables';

export interface AppTile {
  label: string;
  value: string;
  detail?: string;
  tone?: 'neutral' | 'warning' | 'danger';
  /** What to ask DI about this figure; the tile then starts that task when clicked. */
  ask?: string;
}

export interface AppEvent {
  date: string;
  kind: string;
  title: string;
  detail: string;
  late: boolean;
  ask: string;
}

export interface AppFile {
  name: string;
  folder: string;
  type: string;
  sizeKb: number;
  owner: string;
  modified: string;
  /** Where an upload downloads from. Sample documents have no content, so no link. */
  download?: string;
}

export interface SavedQueryView {
  name: string;
  folder: string;
  description: string;
  sql: string;
}

/** A workspace page: DI's view, then the figures and records to check. */
export interface AppView {
  title: string;
  lede: string;
  take: DiTake;
  tiles: AppTile[];
  prompts: string[];
  blocks: Block[];
  /** Plainly says what this page can't do yet. */
  notice?: string;
  links?: { label: string; to: string }[];
  events?: AppEvent[];
  today?: string;
  saved?: SavedQueryView[];
  /** The Files page: what the person can see, and the folders they can save to. */
  files?: AppFile[];
  folders?: string[];
}

export interface QueryRun {
  statementType: 'SELECT';
  tables: string[];
  rowCount: number;
  truncated: boolean;
  block: Block;
}

export interface DiTake {
  headline: string;
  action?: { label: string; ask: string };
}

export interface GoalCard {
  employeeId: number;
  name: string;
  role: string;
  branch: string;
  period: string;
  total: number;
  behind: boolean;
  qualified: boolean;
  goals: { goalId: string; name: string; unit: 'count' | 'currency' | 'score'; actual: number; target: number; pct: number; earned: number; pending: number; qualifier: boolean }[];
}

export interface PayoutSummary {
  branch: string;
  period: string;
  total: number;
  waiting: number;
  flagged: number;
  lines: { employeeId: number; name: string; amount: number; incentives: string; flags: string[]; own: boolean; status: string | null }[];
}

/** GET /v1/gi/summary. Null where the person's role doesn't reach (BE-GI-004). */
export interface GoalsIndex {
  take: DiTake;
  mine: GoalCard | null;
  team: GoalCard[] | null;
  batches: PayoutSummary[] | null;
}

export type PipelineViewId = 'mine' | 'location' | 'team' | 'institution';

/** Volume and dollars together, with percent and average days (spec 17.5). */
export interface PipelineCell {
  count: number;
  pct: number;
  dollars: number;
  avgDays: number;
}

/** GET /v1/lap/summary. Groups and their names are the tenant's (FE-LAP-002). */
export interface PipelineIndex {
  take: DiTake;
  view: PipelineViewId;
  views: PipelineViewId[];
  /** Application Details in the access matrix (FE-LAP-004). */
  details: boolean;
  asOf: string;
  stale: boolean;
  windowDays: number;
  groups: string[];
  funnel: (PipelineCell & { group: string })[];
  products: { product: string; total: PipelineCell; cells: Record<string, PipelineCell> }[];
  open: { count: number; dollars: number };
  stalled: { count: number; dollars: number; oldestDays: number };
}

export interface PipelineApplicationRow {
  applicationId: number;
  memberRef: string;
  name: string;
  lastName: string;
  last4: string;
  product: string;
  amount: number;
  statusCode: string;
  status: string;
  group: string;
  open: boolean;
  applied: string;
  decided: string | null;
  daysInStatus: number;
  threshold: number | null;
  stalled: boolean;
  owner: { employeeId: number; name: string } | null;
  branch: string;
  hold: { label: string; waitingOn: string; nextStep: string; days: number } | null;
}

/** GET /v1/lap/applications. Items are empty without Application Details. */
export interface PipelineList {
  count: number;
  dollars: number;
  oldestDays: number;
  byProduct: { product: string; count: number; dollars: number }[];
  items: PipelineApplicationRow[];
  detailsHidden: boolean;
}

export interface PipelineApplicationDetail extends PipelineApplicationRow {
  asOf: string;
  stale: boolean;
  history: { status: string; at: string }[];
}

/** GET /v1/tables/{id}: a workspace grid's rows for small tables (client-side row model). */
/** A saved view or snapshot in the Tables app, as its pages list it. */
export interface TableSavedItem {
  /** Opens at /tables/{id}. */
  id: string;
  name: string;
  kind: 'Saved view' | 'Snapshot';
  table: string;
  rows: string;
  owner: string;
  shared: string;
  made: string;
  mine: boolean;
}

/** The Tables page around a table's grid: its column stats, the tables it links to, and what's saved from it. */
export interface TableWorkbench {
  tableId: string;
  label: string;
  stats: { column: string; type: string; filled: string; distinct: number; range: string; average: string; top: string }[];
  /** Personal columns, left out of the stats and the grid. */
  personal: string[];
  relationships: { table: string; tableId: string; key: string; shape: string }[];
  saved: TableSavedItem[];
  /** Things to ask DI, as the toolbar's buttons. */
  actions: { label: string; ask: string | null; why?: string }[];
}

export interface TableData {
  tableId: string;
  label: string;
  columns: { field: string; headerName: string; type: 'text' | 'number' | 'currency' | 'percent' | 'count' | 'date' | 'days' }[];
  rows: Record<string, string | number | null>[];
  rowCount: number;
  freshnessAsOf: string;
}
