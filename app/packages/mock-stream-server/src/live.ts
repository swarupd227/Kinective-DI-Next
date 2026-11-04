// Live agents for the Experience Layer: the DI Concierge on Claude, answering from the semantic layer
// over the synthetic tenant warehouse. Starts only when the warehouse is reachable; without an API
// key the Concierge runs its deterministic offline planner (spec 23.6.4).
import { randomBytes } from 'node:crypto';
import type { ApprovalCardBlock, ApprovalDecisionRequest, Block, KpiGroupBlock, ListBlock, Member360Block, SearchResult, StreamEvent, StreamingEnvelope, TableData } from '@dinext/block-schemas';
import { AnthropicModelClient, AuditLog, Concierge, ReportGateway, ToolGateway, buildBriefing, buildToday, tasksModule, formLayoutModule, workflowBuilderModule, indirectModule, prospectingModule, calendarModule, callReportModule, filesModule, governanceModule, lineageModule, campaignModule, collectionsModule, complianceModule, dataLogsModule, goalsTake, ModuleGateway, onboardingModule, operationsModule, pipelineTake, segModule, referralTake, reportsTake, todayList, describeSchedule, hasClaudeCredentials, member360, memberTake, type ApprovalDecisionResult, type ConciergeTurn, type ReportControls, type RouteAgent, type RunSink, type TenantRuntime } from '@dinext/agents';
import { ApprovalStore, WorksheetService, CalendarStore, FileStore, foldersFor, TaskService, WorkflowDefService, IndirectService, ProspectService, QueryService, GovernanceService, LineageService, CallReportService, CampaignService, CollectionsService, CoreError, DataLogService, GoalsService, IssueService, OnboardingService, OperationsService, RetentionService, SegService, usd, PipelineService, ReferralService, RelationshipService, ReportStore, type CoreContext, type InboxItem, type Scorecard, type PipelineApplication, type PipelineView, type ScheduleRow, type TemplateRow } from '@dinext/di-core';
import type { JumpCard, AppNotification, AppView, AppViewId, QueryRun, DiTake, GoalsIndex, PipelineApplicationDetail, PipelineApplicationRow, PipelineIndex, PipelineList, PipelineViewId, ReferralAction, ReferralDetail, ReferralsIndex, ReferralSummary, ReportCanvasBlock } from '@dinext/block-schemas';
import { createAppViews } from './appViews.ts';
import { columnStatRows, dataLoadModule, tablesModule } from '@dinext/agents';
import { IngestService, TableService, type TableObject } from '@dinext/di-core';
import { readWorkbook } from './spreadsheet.ts';
import type { TableSavedItem, TableWorkbench } from '@dinext/block-schemas';
import { renderExport } from './exports.ts';
import type { AppId } from '@dinext/block-schemas';
import type { ModuleContext } from '@dinext/agents';
import { SemanticService } from '@dinext/semantic';
import { notificationsModule } from '@dinext/agents';
import { EmailOutbox, tenantDomain, type EmailKind } from '@dinext/di-core';
import type { ReportSettingsView } from '@dinext/block-schemas';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { PERSONAS, type PersonaId } from './data.ts';
import { rank } from './search.ts';

type Emit = Omit<StreamEvent, 'threadId' | 'seq' | 'ts'>;
const e = (x: unknown) => x as Emit;
const blockId = () => `blk_${randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 16).padEnd(16, '0')}`;
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Tenant id in the session → warehouse schema and semantic model. */
const TENANTS: Record<string, { key: string; schema: string }> = {
  tnt_harborview: { key: 'test_cu', schema: 'dinext_t_test_cu' },
  tnt_coastal: { key: 'test_bank', schema: 'dinext_t_test_bank' },
};

export interface ReportSummary {
  templateId: string;
  name: string;
  folder: string;
  status: TemplateRow['status'];
  periodType: 'month' | 'quarter';
  description: string;
  sections: number;
  owner: string;
  updatedAt: string;
  origin?: string;
  /** On this person's Home: pinned by them or published to their class. */
  onHome: boolean;
}

export interface ScheduleSummary {
  scheduleId: number;
  templateId: string;
  report: string;
  when: string;
  format: string;
  recipients: number;
  owner: string;
  lastRunAt: string | null;
  lastResult: ScheduleRow['lastResult'];
  lastDetail: string | null;
}

const scheduleSummary = (s: ScheduleRow): ScheduleSummary => ({ scheduleId: s.scheduleId, templateId: s.templateId, report: s.templateName, when: `${describeSchedule(s)}, after the nightly build`, format: s.format.toUpperCase(), recipients: s.recipientCount, owner: s.ownerName, lastRunAt: s.lastRunAt, lastResult: s.lastResult, lastDetail: s.lastDetail });

interface Tenant {
  runtime: TenantRuntime;
  pool: Pool;
  governance: GovernanceService | null;
  pipeline: PipelineService | null;
  goals: GoalsService | null;
  /** Words for the recogniser: branches, products and staff, never members (FE-VOICE-061). */
  vocabulary: string[];
  /** Uploaded files, once the tenant was seeded with Slice 23 or later. */
  files: FileStore | null;
  /** Saved views and snapshots, once the tenant has the Tables tables. */
  tables: TableService | null;
  /** The simulated email outbox, once the tenant has the notification tables. */
  outbox: EmailOutbox | null;
}

export interface LiveRunResult {
  /** Set when the turn belongs to an agent that is still a scripted placeholder. */
  scripted: RouteAgent | null;
  /** The card the run now waits on; the run completes when it is decided or expires. */
  approval?: { approvalId: string; card: ApprovalCardBlock };
  /** Older cards in the thread a new draft replaced. */
  superseded: string[];
}

export interface LiveRuntime {
  concierge: Concierge;
  mode: 'live' | 'offline';
  /** A workspace page, under the person's purview. Null when it isn't theirs to see. */
  appView(persona: PersonaId, id: AppViewId): Promise<AppView | null>;
  /** An administrator's Platform health for Home and the bell: build age, checks, late feeds, access. */
  platform(persona: PersonaId): Promise<ListBlock | null>;
  /** Runs one read-only query. Refuses anything else, and anyone without Query Browser. */
  runQuery(persona: PersonaId, sql: string): Promise<QueryRun | null>;
  /** A rating of one answer, kept with its run (spec 26, FE-EXP feedback). */
  feedback(persona: PersonaId, f: { runId: string; rating: 'up' | 'down'; comment?: string }): Promise<boolean>;
  /** Runs one turn of the Concierge. */
  run(persona: PersonaId, req: { threadId: string; runId: string; text: string; context: ConciergeTurn['context'] }, emit: (e: Emit) => void, signal: AbortSignal, speed: number): Promise<LiveRunResult>;
  /**
   * A decision on a live card. Resolves with the HTTP answer once the approval service has accepted
   * or refused it; `onDone` fires when any follow-on work (executing the write) has streamed.
   */
  decide(persona: PersonaId, req: { approvalId: string; threadId: string; runId: string; body: ApprovalDecisionRequest }, emit: (e: Emit) => void, onDone: (result: unknown) => void, speed: number): Promise<ApprovalDecisionResult>;
  home(persona: PersonaId): Promise<{ kpis: KpiGroupBlock; narrative: string; lookAt: ListBlock; scheduled: ListBlock | null; jump: JumpCard[]; pinned: { templateId: string; name: string; audience: string; pinnedBy: string; canvas: ReportCanvasBlock }[]; referrals: { open: number; overdue: number } | null } | null>;
  /**
   * A member's 360 for the workspace or the member page (GET /v1/members/{token}). Null when the
   * relationship data is not loaded; NO_ACCESS for a token outside the purview. Logged as an access.
   */
  member(persona: PersonaId, token: string): Promise<Member360Block | null>;
  /** Member search for Ctrl+K and the voice picker: masked results within the purview (BE-RM-002). */
  searchMembers(persona: PersonaId, q: string): Promise<SearchResult[] | null>;
  /** Saved and stock reports this person can open, by words in the name or folder. */
  searchReports(persona: PersonaId, q: string): Promise<SearchResult[]>;
  /** The Reports app: templates the user can open and their schedules (spec 8.5–8.9). */
  reports(persona: PersonaId): Promise<{ take: DiTake; templates: ReportSummary[]; schedules: ScheduleSummary[]; bin: { templateId: string; name: string; folder: string; deletedAt: string }[] } | null>;
  /** The Referrals app: a box of referrals with counts for the tabs (FE-REF-001). */
  referrals(persona: PersonaId, box: 'mine' | 'team' | 'sent'): Promise<ReferralsIndex | null>;
  /** For the bell: each of your own overdue referrals, or a count for a branch lead. */
  overdueReferrals(persona: PersonaId): Promise<Omit<AppNotification, 'read'>[]>;
  /** For the bell: payouts waiting for this approver, as one notice. */
  waitingPayouts(persona: PersonaId): Promise<Omit<AppNotification, 'read'>[]>;
  /** The Goals & Incentives page: the person's own month, their team and any payouts to approve. */
  goals(persona: PersonaId): Promise<GoalsIndex | null>;
  /** Home's "Needs you": the day's work, ranked, each item starting it. Null when nothing needs them. */
  today(persona: PersonaId): Promise<ListBlock | null>;
  /** For the bell: your stalled applications, or a count for a branch lead. */
  stalledApplications(persona: PersonaId): Promise<Omit<AppNotification, 'read'>[]>;
  /** The Loan Pipeline's summary and the views this user may use; null when it is not loaded. */
  pipeline(persona: PersonaId, view: PipelineViewId | undefined): Promise<PipelineIndex | null>;
  pipelineApplications(persona: PersonaId, q: { view: PipelineViewId; group?: string; stalled: boolean }): Promise<PipelineList | null>;
  pipelineApplication(persona: PersonaId, id: number): Promise<PipelineApplicationDetail | null>;
  referral(persona: PersonaId, comId: number): Promise<ReferralDetail | null>;
  /** The user's own action on a referral, and who should hear about it. */
  referralAction(persona: PersonaId, comId: number, action: ReferralAction): Promise<{ detail: ReferralDetail; notify: Notice[] } | null>;
  /** Runs a report for control values: the canvas re-runs without a new turn (spec 8.5). */
  runReport(persona: PersonaId, templateId: string, controls: ReportControls, test?: boolean): Promise<ReportCanvasBlock | null>;
  /** Accept, revert, move, resize or remove on a draft canvas (FE-BLD-002, FE-BLD-003). */
  editReport(persona: PersonaId, templateId: string, op: Parameters<ReportGateway['edit']>[1], controls: ReportControls): Promise<ReportCanvasBlock | null>;
  /** An approved export, rendered under the user's purview when downloaded (spec 18.6). */
  exportFile(persona: PersonaId, exportId: string): Promise<{ fileName: string; contentType: string; body: Buffer } | null>;
  /** Keeps an upload as Staged for its uploader; nothing is in a folder until a save is approved (spec 8.15). */
  stageFile(persona: PersonaId, f: { name: string; body: Buffer }): Promise<{ fileId: number; name: string; type: string; sizeKb: number } | null>;
  /** An uploaded file's content, under the same folder rules as the page. Null reads as not found. */
  fileContent(persona: PersonaId, fileId: number): Promise<{ name: string; mime: string; body: Buffer } | null>;
  /** Runs every active schedule as the nightly build would (local stand-in for the after-build trigger). */
  runSchedules(persona: PersonaId): Promise<ScheduleSummary[] | null>;
  /** The tenant's own words for speech recognition (spec 7.8). */
  vocabulary(persona: PersonaId): string[];
  table(persona: PersonaId, tableId: string): Promise<TableData | null>;
  /** The Tables page around a grid: column stats, linked tables and what's saved from it. Null without the Tables app. */
  tableWorkbench(persona: PersonaId, tableId: string): Promise<TableWorkbench | null>;
  /** A report's settings, read-only (today's DI Build Reports form). Null without Reports. */
  reportSettings?(persona: PersonaId, templateId: string): Promise<ReportSettingsView | null>;
  /** Writes an email to the simulated outbox for a user, if they want that kind. Never throws. */
  email?(userId: string, n: { kind: EmailKind; title: string; detail?: string; link: string; sourceRef: string }): Promise<void>;
  /** This morning's follow-up reminders and digests for everyone in the person's tenant (local stand-in for the morning job). */
  morningEmails?(persona: PersonaId): Promise<{ emails: number } | null>;
  close(): Promise<void>;
}

/** Someone to tell: a named user, or whoever works and leads a branch's queue. */
export interface Notice {
  userId?: string;
  employeeId?: number;
  branch?: string;
  title: string;
  detail?: string;
  comId?: number;
  /** Where it opens, when it isn't a referral. */
  link?: string;
}

/** Frontline staff work their own queue; a branch lead and everyone else look after the team's. */
const worksOwnQueue = (p: PersonaId) => PERSONAS[p].employeeId !== undefined && !PERSONAS[p].leadsBranch;

/** Loan Pipeline access from the persona's place in the module matrix (spec 20.7). */
const lapAccess = (p: PersonaId) => ({ details: Boolean(PERSONAS[p].lapDetails), leads: PERSONAS[p].leadsBranch, admin: PERSONAS[p].lendingAdmin });

/** Goals & Incentives access from the same matrix. */
const giAccess = (p: PersonaId) => ({ leads: PERSONAS[p].leadsBranch, approves: PERSONAS[p].approvesIncentives });

const personaContext = (p: PersonaId) => {
  const s = PERSONAS[p].session;
  return { purviewBranches: PERSONAS[p].purview, canViewSql: s.permissions.queryBrowser, employeeId: PERSONAS[p].employeeId, lap: lapAccess(p), gi: giAccess(p), retention: PERSONAS[p].retention, modules: PERSONAS[p].modules ?? [], userClass: PERSONAS[p].userClass };
};

/** Maps a run's sink calls to stream events (spec 12.4). Text is verified before it streams. */
function streamSink(emit: (e: Emit) => void, runId: string, signal: AbortSignal, speed: number): RunSink {
  const startBlock = (block: StreamingEnvelope) => emit(e({ type: 'block.start', runId, block }));
  return {
    signal,
    routing: (agent, reason) => emit(e({ type: 'routing', runId, agent, reason: reason ?? '' })),
    plan: (title, agent, steps, opts) => {
      const id = blockId();
      startBlock({
        id,
        type: 'plan_steps',
        version: '1.0.0',
        title,
        status: 'streaming',
        provenance: { agent, runId, sources: [] },
        freshness: { kind: 'none' },
        ...(opts?.task ? { output: { label: title } } : {}),
        data: { runId, cancellable: true, state: 'running', steps: steps.map((s) => ({ id: s.id, label: s.label ?? s.id, agent: s.agent ?? agent, state: s.state, operations: s.operation ? [{ name: s.operation }] : [] })) },
      } as StreamingEnvelope);
      emit(e({ type: 'block.end', runId, blockId: id }));
      return id;
    },
    step: (planBlockId, u) => emit(e({ type: 'tool.progress', runId, blockId: planBlockId, step: u })),
    text: async (markdown, agent, sources = []) => {
      const id = blockId();
      startBlock({ id, type: 'text', version: '1.0.0', status: 'streaming', provenance: { agent, runId, sources }, freshness: { kind: 'none' }, data: { markdown: '' } } as StreamingEnvelope);
      const chunks = markdown.match(/\S+\s*/g) ?? [];
      for (let i = 0; i < chunks.length && !signal.aborted; i += 3) {
        emit(e({ type: 'token.delta', runId, blockId: id, text: chunks.slice(i, i + 3).join('') }));
        await pause(30 * speed, signal);
      }
      emit(e({ type: 'block.end', runId, blockId: id }));
    },
    block: async (block: Block) => {
      // An undefined field would become an "add" with no value, which makes the client reject the
      // whole patch (FE-GEN-040); such fields are simply absent.
      const ops = Object.entries(block.data)
        .filter(([, value]) => value !== undefined)
        .map(([k, value]) => ({ op: 'add' as const, path: `/${k}`, value }));
      startBlock({ ...block, data: {}, status: 'streaming' } as StreamingEnvelope);
      await pause(60 * speed, signal);
      emit(e({ type: 'block.patch', runId, blockId: block.id, ops }));
      emit(e({ type: 'block.end', runId, blockId: block.id }));
    },
    suggestion: (text) => emit(e({ type: 'suggestion', runId, text })),
  };
}

const applicationView = ({ partyId, ...a }: PipelineApplication, rm: RelationshipService | null): PipelineApplicationRow => ({ ...a, memberRef: rm?.token(partyId) ?? '' });

const referralView = ({ partyId, senderUserId: _sender, ...i }: InboxItem, rm: RelationshipService | null): ReferralSummary => ({ ...i, memberRef: rm?.token(partyId) ?? '' });

/** Which app each workspace page belongs to. */
const APP_ACCESS: Record<AppViewId, AppId> = { calendar: 'calendar', files: 'files', queries: 'queries', users: 'users', admin: 'admin', datalogs: 'datalogs', seg: 'seg', callreport: 'callreport', workflows: 'workflows', rm: 'rm', indirect: 'indirect', prospecting: 'prospecting', campaigns: 'campaigns', onboarding: 'onboarding', compliance: 'compliance', predictive: 'predictive', dq: 'dq', tasks: 'tasks', integrations: 'integrations', classes: 'classes', wfbuilder: 'wfbuilder', tables: 'tables', emails: 'home' };

const viewDeps = (pool: Pool, institutionType: string, who: { purviewBranches?: string[]; employeeId?: number; modules: string[]; leads?: boolean; retention: boolean; user?: { id: string; name: string } }, workspace = false) => ({ pool, blockId, user: who.user ?? { id: '', name: '' }, person: institutionType === 'bank' ? ('customer' as const) : ('member' as const), ctx: { purviewBranches: who.purviewBranches } as CoreContext, employeeId: who.employeeId, leads: Boolean(who.leads), modules: who.modules, retention: who.retention, workspace });

const calendarFor = (pool: Pool, institutionType: string, ctx: ModuleContext, workspace: boolean) => createAppViews(viewDeps(pool, institutionType, { purviewBranches: ctx.purviewBranches, employeeId: ctx.employeeId, modules: ctx.modules, leads: ctx.leads, retention: ctx.modules.includes('calendar'), user: ctx.user }, workspace)).calendarEvents();

const AGENT_LABELS: Record<string, string> = { analytics: 'Analytics Q&A', report_builder: 'Report Builder', referral: 'Referrals', relationship: 'Relationship', goal: 'DI', dashboard: 'Briefing', none: 'DI Concierge' };

export async function startLiveRuntime(opts: { offline?: boolean } = {}): Promise<LiveRuntime | null> {
  const tenants = new Map<string, Tenant>();
  const audit = new AuditLog();
  for (const [tenantId, t] of Object.entries(TENANTS)) {
    if (!(await warehouseAvailable(t.schema))) continue;
    const persona = Object.values(PERSONAS).find((p) => p.session.tenant.id === tenantId)!;
    const { name, institutionType } = persona.session.tenant;
    const pool = tenantPool(t.schema);
    const semantic = await SemanticService.create(pool, t.key, institutionType);
    // The workflow store exists once the tenant was seeded with Slice 3 or later.
    const hasWorkflow = await pool.query('SELECT 1 FROM mod_ref_types LIMIT 1').then(
      () => true,
      () => false,
    );
    const referrals = hasWorkflow ? new ReferralService(pool, institutionType) : null;
    // Relationship Manager data exists once the tenant was seeded with Slice 5 or later.
    const hasRelationship = await pool.query('SELECT 1 FROM cdm_party_contact LIMIT 1').then(
      () => true,
      () => false,
    );
    const relationship = referrals && hasRelationship ? new RelationshipService(pool, t.key, institutionType) : null;
    const onProfileView = (partyId: number, ctx: { user: { id: string }; threadId: string; runId: string }) => void audit.access({ tenant: t.key, userId: ctx.user.id, partyId, via: 'agent', threadId: ctx.threadId, runId: ctx.runId }).catch(() => {});
    // The Loan Pipeline exists once the tenant was seeded with Slice 10 or later.
    const hasPipeline = await pool.query('SELECT 1 FROM mod_lap_status_map LIMIT 1').then(
      () => true,
      () => false,
    );
    const pipeline = hasPipeline ? new PipelineService(pool) : null;
    // The business modules exist once the tenant was seeded with Slice 17 or later.
    const hasModules = await pool.query('SELECT 1 FROM cpm_issue LIMIT 1').then(
      () => true,
      () => false,
    );
    // The usage ledger exists once the tenant was seeded with Slice 19 or later.
    const hasLedger = await pool.query('SELECT 1 FROM ai_run LIMIT 1').then(
      () => true,
      () => false,
    );
    const governance = hasLedger ? new GovernanceService(pool) : null;
    if (governance) audit.ledger(t.key, (r) => governance.record({ runId: r.runId, at: r.at, userId: r.userId, threadId: r.threadId, agent: r.route.label ?? AGENT_LABELS[r.route.agent] ?? r.route.agent, intent: r.route.intent, mode: r.route.mode, question: r.question, outcome: r.outcome, model: r.usage.at(-1)?.model ?? null, inputTokens: r.usage.reduce((n, u) => n + u.inputTokens, 0), outputTokens: r.usage.reduce((n, u) => n + u.outputTokens, 0), cacheReadTokens: r.usage.reduce((n, u) => n + u.cacheReadTokens, 0), costUsd: r.totalCostUsd, toolCalls: r.toolCalls }));
    const governanceModules = governance ? [lineageModule(new LineageService(pool, semantic.model)), governanceModule(governance, () => new Date().getFullYear())] : [];
    // Indirect Lending and Prospecting exist once the tenant was seeded with Slice 21 or later.
    const growth = await Promise.all([pool.query('SELECT name FROM ind_dealer ORDER BY dealer_id'), pool.query('SELECT company FROM prs_prospect ORDER BY prospect_id'), pool.query('SELECT name FROM prs_stage ORDER BY position')]).then(
      ([d, p, s]) => ({ dealers: (d[0] as { name: string }[]).map((x) => x.name), companies: (p[0] as { company: string }[]).map((x) => x.company), stages: (s[0] as { name: string }[]).map((x) => x.name) }),
      () => null,
    );
    const today = () => new Date().toISOString().slice(0, 10);
    const growthModulesExtra: ReturnType<typeof tasksModule>[] = [];
    // Tasks exist once the tenant was seeded with Slice 22 or later.
    const hasTasks = await pool.query('SELECT 1 FROM tsk_task LIMIT 1').then(
      () => true,
      () => false,
    );
    if (hasTasks) growthModulesExtra.push(tasksModule(new TaskService(pool), new OperationsService(pool), today));
    // Workflow definitions exist once the tenant was seeded with Slice 23 or later.
    const hasDefs = await pool.query('SELECT 1 FROM wf_definition LIMIT 1').then(
      () => true,
      () => false,
    );
    // Form Layout first: "add a field to the referral form" is a form change, not a workflow draft.
    if (hasDefs) growthModulesExtra.push(formLayoutModule(new WorkflowDefService(pool), today), workflowBuilderModule(new WorkflowDefService(pool), today, new WorksheetService(pool)));
    // Calendar events and uploads exist once the tenant was seeded with Slice 23 or later.
    const hasWorkspace = await pool.query('SELECT 1 FROM cal_event LIMIT 1').then(
      () => true,
      () => false,
    );
    const files = hasWorkspace ? new FileStore(pool) : null;
    // Colleagues by whole words of their name, so "Ana" never matches "Manager".
    const colleagues = async (name: string) => {
      const want = name.toLowerCase().split(/\s+/).filter(Boolean);
      return (await new OperationsService(pool).users()).filter((u) => u.status === 'Active' && want.every((w) => u.name.toLowerCase().split(/\s+/).includes(w))).map((u) => ({ userId: u.userId, name: u.name }));
    };
    // Saved views and snapshots exist once the tenant was seeded with the Tables slice or later.
    const hasTables = await pool.query('SELECT 1 FROM tbl_object LIMIT 1').then(
      () => true,
      () => false,
    );
    const tables = hasTables ? new TableService(pool, institutionType === 'bank' ? 'customer' : 'member') : null;
    // Data files load into the Tables store; the module goes first so "load x.csv into a table" is never read as Tables or Files.
    const tablesModules = tables ? [dataLoadModule(files, new IngestService(pool, readWorkbook), today), tablesModule(tables, today)] : [];
    // Email notifications exist once the tenant has the outbox tables; the module goes first so its
    // narrow phrases ("stop emailing me …") are never read as another module's request.
    const hasOutbox = await pool.query('SELECT 1 FROM ntf_pref LIMIT 1').then(
      () => true,
      () => false,
    );
    const outbox = hasOutbox ? new EmailOutbox(pool, tenantDomain(name)) : null;
    if (outbox) tablesModules.unshift(notificationsModule(outbox, today));
    const growthModules = growth ? [indirectModule(new IndirectService(pool), growth.dealers, today), prospectingModule(new ProspectService(pool), growth.companies, growth.stages, today)] : [];
    const modules = hasModules ? new ModuleGateway(new ApprovalStore(pool), [...tablesModules, ...governanceModules, ...growthModulesExtra, calendarModule((ctx) => calendarFor(pool, institutionType, ctx, hasWorkspace), hasWorkspace ? new CalendarStore(pool) : null, colleagues, today), filesModule(files, today), ...growthModules, complianceModule(new IssueService(pool), pool), onboardingModule(new OnboardingService(pool)), dataLogsModule(new DataLogService(pool)), operationsModule(new OperationsService(pool)), callReportModule(new CallReportService(pool)), collectionsModule(new CollectionsService(pool)), campaignModule(new CampaignService(pool)), segModule(new SegService(pool), () => new Date().toISOString().slice(0, 10))]) : null;
    // Goals & Incentives exists once the tenant was seeded with Slice 14 or later.
    const hasGoals = await pool.query('SELECT 1 FROM mod_gi_goal LIMIT 1').then(
      () => true,
      () => false,
    );
    const goals = hasGoals ? new GoalsService(pool) : null;
    const workflow = referrals ? { referrals, relationship, gateway: new ToolGateway({ referrals, relationship: relationship ?? undefined, pipeline: pipeline ?? undefined, goals: goals ?? undefined, retention: new RetentionService(pool), semantic, approvals: new ApprovalStore(pool), onProfileView }) } : null;
    // Report templates exist once the tenant was seeded with Slice 6 or later.
    const hasReports = await pool.query('SELECT 1 FROM esp_report_templates LIMIT 1').then(
      () => true,
      () => false,
    );
    // A report published to a class reaches its active members; the directory says how many.
    const classSize = async (userClass: string) => (await new OperationsService(pool).users().catch(() => [])).filter((u) => u.userClass === userClass && u.status === 'Active').length;
    const reports = hasReports ? { gateway: new ReportGateway({ store: new ReportStore(pool), semantic, approvals: new ApprovalStore(pool), classSize }) } : null;
    const [staff] = await pool.query('SELECT DISTINCT display_name FROM cdm_employee');
    const dims = semantic.dimensionValues;
    const vocabulary = [...new Set([...(dims.branch ?? []), ...(dims.region ?? []), ...(dims.loan_category ?? []), ...(dims.deposit_category ?? []), ...(staff as { display_name: string }[]).map((s) => s.display_name).filter((s) => !/^\w\. /.test(s))])];
    tenants.set(tenantId, { pool, pipeline, goals, vocabulary, governance, files, tables, outbox, runtime: { key: t.key, name, institutionType, semantic, workflow, reports, modules } });
  }
  if (!tenants.size) return null;

  const model = hasClaudeCredentials() && !opts.offline ? new AnthropicModelClient() : null;
  const concierge = new Concierge({ model, audit, beatMs: process.env.NODE_ENV === 'test' ? 0 : 1600 });
  const tenantFor = (p: PersonaId) => tenants.get(PERSONAS[p].session.tenant.id) ?? null;
  const lapFor = (p: PersonaId) => {
    const t = tenantFor(p);
    const s = PERSONAS[p];
    if (!t?.pipeline || !s.session.apps.includes('lap')) return null;
    return { service: t.pipeline, rm: t.runtime.workflow?.relationship ?? null, who: { employeeId: s.employeeId, leads: s.leadsBranch, details: Boolean(s.lapDetails) }, ctx: { purviewBranches: s.purview } };
  };
  const referralDetail = async (persona: PersonaId, comId: number): Promise<ReferralDetail | null> => {
    const wf = tenantFor(persona)?.runtime.workflow;
    const session = PERSONAS[persona].session;
    if (!wf || !session.apps.includes('referrals')) return null;
    const purview = PERSONAS[persona].purview;
    const d = await wf.referrals.item(comId, { userId: session.user.id }, { purviewBranches: purview });
    return { ...referralView(d, wf.relationship ?? null), history: d.history, team: d.team, stages: d.stages, canWork: !purview || purview.includes(d.branch) };
  };

  const rt: LiveRuntime = {
    concierge,
    mode: model ? 'live' : 'offline',
    async appView(persona, id) {
      const t = tenantFor(persona);
      const p = PERSONAS[persona];
      if (!t || !t.runtime.modules || !p.session.apps.includes(APP_ACCESS[id])) return null;
      return createAppViews(viewDeps(t.pool, t.runtime.institutionType, { purviewBranches: p.purview, employeeId: p.employeeId, modules: p.modules ?? [], leads: giAccess(persona).leads, retention: Boolean(p.retention), user: { id: p.session.user.id, name: p.session.user.name } }, Boolean(t.files))).views[id]();
    },

    async platform(persona) {
      const t = tenantFor(persona);
      const p = PERSONAS[persona];
      if (!t || !t.runtime.modules || !p.session.apps.includes('admin')) return null;
      return createAppViews(viewDeps(t.pool, t.runtime.institutionType, { purviewBranches: p.purview, employeeId: p.employeeId, modules: p.modules ?? [], leads: false, retention: Boolean(p.retention), user: { id: p.session.user.id, name: p.session.user.name } }, Boolean(t.files))).platform();
    },

    async stageFile(persona, f) {
      const t = tenantFor(persona);
      const p = PERSONAS[persona];
      if (!t?.files || !p.session.apps.includes('files') || !p.modules?.includes('files')) return null;
      return t.files.stage({ name: f.name, body: f.body, owner: { userId: p.session.user.id, name: p.session.user.name }, on: new Date().toISOString().slice(0, 10) });
    },

    async fileContent(persona, fileId) {
      const t = tenantFor(persona);
      const p = PERSONAS[persona];
      if (!t?.files || !p.session.apps.includes('files')) return null;
      return t.files.content(p.session.user.id, foldersFor(p.modules ?? []), fileId);
    },

    async runQuery(persona, sql) {
      const t = tenantFor(persona);
      const p = PERSONAS[persona];
      if (!t || !p.session.permissions.queryBrowser || p.purview) return null;
      const r = await new QueryService(t.pool).run(sql);
      void audit.event({ eventType: 'query.executed', tenant: t.runtime.key, userId: p.session.user.id, threadId: '', runId: '', approvalId: '', tables: r.tables, rows: r.rows.length });
      return {
        statementType: r.statementType,
        tables: r.tables,
        rowCount: r.rows.length,
        truncated: r.truncated,
        block: { id: blockId(), type: 'table', version: '1.0.0', title: 'Results', provenance: { agent: 'Queries', operations: ['query.execute'], sources: [] }, freshness: { kind: 'workflow_event' }, data: { columns: r.columns.map((c) => ({ field: c, headerName: c, type: r.rows.some((row) => typeof row[c] === 'string') ? ('text' as const) : ('number' as const) })), rows: r.rows, rowCount: r.rows.length } },
      };
    },

    async feedback(persona, f) {
      const g = tenantFor(persona)?.governance;
      if (!g) return false;
      await g.feedback({ ...f, userId: PERSONAS[persona].session.user.id });
      return true;
    },

    async run(persona, req, emit, signal, speed) {
      const tenant = tenantFor(persona);
      if (!tenant) return { scripted: 'none', superseded: [] };
      const s = PERSONAS[persona].session;
      emit(e({ type: 'run.started', runId: req.runId, agents: ['DI Concierge'] }));
      const decision = await concierge.handle(
        { ...req, user: { id: s.user.id, name: s.user.name, title: s.user.title }, tenant: tenant.runtime, apps: s.apps, ...personaContext(persona) },
        streamSink(emit, req.runId, signal, speed),
      );
      if (decision.kind === 'scripted') return { scripted: decision.agent, superseded: [] };
      return { scripted: null, approval: decision.approval, superseded: decision.superseded ?? [] };
    },

    async decide(persona, req, emit, onDone, speed) {
      const tenant = tenantFor(persona);
      if (!tenant) return { status: 404, body: { code: 'NOT_FOUND' } };
      const s = PERSONAS[persona].session;
      const sink = { ...streamSink(emit, req.runId, new AbortController().signal, speed), done: onDone };
      const r = await concierge.resolveApproval(
        {
          approvalId: req.approvalId,
          decision: req.body.decision,
          channel: req.body.channel,
          note: req.body.note,
          previewHash: req.body.clientContext.previewHash,
          threadId: req.threadId,
          runId: req.runId,
          user: { id: s.user.id, name: s.user.name },
          tenant: tenant.runtime,
          purviewBranches: PERSONAS[persona].purview,
          employeeId: PERSONAS[persona].employeeId,
          lap: lapAccess(persona),
          gi: giAccess(persona),
          modules: PERSONAS[persona].modules ?? [],
        },
        sink,
      );
      return r;
    },

    vocabulary(persona) {
      return tenantFor(persona)?.vocabulary ?? [];
    },

    async member(persona, token) {
      const rm = tenantFor(persona)?.runtime.workflow?.relationship;
      const s = PERSONAS[persona].session;
      if (!rm || !s.apps.includes('rm')) return null;
      const party = await rm.resolve(token, { purviewBranches: PERSONAS[persona].purview });
      const profile = await rm.profile(party.partyId, { purviewBranches: PERSONAS[persona].purview });
      void audit.access({ tenant: rm.tenant, userId: s.user.id, partyId: party.partyId, via: 'workspace' }).catch(() => {});
      return member360(profile, undefined, memberTake(profile, rm.nextBestConversation(profile)));
    },

    async reports(persona) {
      const gw = tenantFor(persona)?.runtime.reports?.gateway;
      const s = PERSONAS[persona].session;
      if (!gw || !s.apps.includes('reports')) return null;
      const templates = await gw.store.list(s.user.id);
      const schedules = (await gw.store.schedules(s.user.id)).map(scheduleSummary);
      const home = new Set((await gw.store.pins(s.user.id, PERSONAS[persona].userClass).catch(() => [])).map((p) => p.templateId));
      const bin = await gw.store.bin(s.user.id).catch(() => []);
      return {
        take: reportsTake(templates, schedules),
        templates: templates.map((t) => ({ templateId: t.templateId, name: t.name, folder: t.folder, status: t.status, periodType: t.definition.settings.periodType, description: t.definition.description, sections: t.definition.widgets.length, owner: t.ownerName, updatedAt: t.updatedAt, origin: t.origin ? `Created by ${t.origin.agent}, approved by ${t.origin.approvedBy}` : undefined, onHome: home.has(t.templateId) })),
        schedules,
        bin: bin.map((t) => ({ templateId: t.templateId, name: t.name, folder: t.folder, deletedAt: t.updatedAt })),
      };
    },

    async referrals(persona, box) {
      const tenant = tenantFor(persona);
      const wf = tenant?.runtime.workflow;
      const s = PERSONAS[persona].session;
      if (!wf || !s.apps.includes('referrals')) return null;
      const who = { userId: s.user.id, employeeId: PERSONAS[persona].employeeId };
      const ctx = { purviewBranches: PERSONAS[persona].purview };
      const [items, mine, team] = await Promise.all([wf.referrals.inbox(box, who, ctx), wf.referrals.inbox('mine', who, ctx), wf.referrals.inbox('team', who, ctx)]);
      const own = worksOwnQueue(persona);
      return { take: referralTake(own ? mine : team, own), items: items.map((i) => referralView(i, wf.relationship ?? null)), counts: { mine: mine.length, team: team.length, overdue: (own ? mine : team).filter((i) => i.overdue).length }, hasOwnQueue: own };
    },

    async overdueReferrals(persona) {
      const wf = tenantFor(persona)?.runtime.workflow;
      const p = PERSONAS[persona];
      const own = worksOwnQueue(persona);
      if (!wf || !p.session.apps.includes('referrals') || (!own && !p.leadsBranch)) return [];
      const items = await wf.referrals.inbox(own ? 'mine' : 'team', { userId: p.session.user.id, employeeId: p.employeeId }, { purviewBranches: p.purview });
      const overdue = items.filter((i) => i.overdue);
      if (own) return overdue.map((i) => ({ id: `ntc_overdue_${i.comId}`, group: 'workflow', title: `Referral #${i.comId} is overdue`, detail: `${i.name} · ${i.typeLabel}`, at: i.dueAt, link: `/workflows/referrals/inbox?id=${i.comId}` }));
      if (!overdue.length) return [];
      const latest = overdue.map((i) => i.dueAt).sort().at(-1)!;
      return [{ id: 'ntc_overdue_team', group: 'workflow', title: `${overdue.length} team ${overdue.length === 1 ? 'referral is' : 'referrals are'} overdue`, detail: overdue.map((i) => i.name).join(' · '), at: latest, link: '/workflows/referrals/inbox' }];
    },

    async waitingPayouts(persona) {
      const svc = tenantFor(persona)?.goals;
      const p = PERSONAS[persona];
      if (!svc || !p.approvesIncentives) return [];
      const open = (await svc.batches({ employeeId: p.employeeId, leads: p.leadsBranch, approves: true }, { purviewBranches: p.purview })).filter((b) => b.waiting);
      const [first] = open;
      if (!first) return [];
      const n = open.reduce((sum, b) => sum + b.waiting, 0);
      return [{ id: 'ntc_payouts', group: 'approvals', title: `${first.period.split(' ')[0]} payouts are waiting`, detail: `${n} ${n === 1 ? 'person' : 'people'}, ${usd(open.reduce((sum, b) => sum + b.total, 0))}`, at: `${first.periodEnd}T06:00:00.000Z`, link: '/m/gi' }];
    },

    async goals(persona) {
      const svc = tenantFor(persona)?.goals;
      const p = PERSONAS[persona];
      if (!svc || !p.session.apps.includes('gi')) return null;
      const who = { employeeId: p.employeeId, leads: p.leadsBranch, approves: p.approvesIncentives };
      const ctx = { purviewBranches: p.purview };
      const mine = p.employeeId !== undefined ? await svc.scorecard(undefined, who, ctx) : null;
      const team = p.leadsBranch || p.approvesIncentives ? await svc.team(undefined, who, ctx) : null;
      const batches = p.approvesIncentives ? await svc.batches(who, ctx) : null;
      return { take: goalsTake(mine, batches), mine, team, batches };
    },

    async today(persona) {
      const gateway = tenantFor(persona)?.runtime.workflow?.gateway;
      if (!gateway) return null;
      const s = PERSONAS[persona].session;
      const tenant = tenantFor(persona)!;
      const context = personaContext(persona);
      const moreWork = () => tenant.runtime.modules?.today({ user: s.user, purviewBranches: context.purviewBranches, employeeId: context.employeeId, modules: context.modules, leads: context.gi.leads, runId: 'R-today', threadId: 'today' }) ?? Promise.resolve([]);
      const plan = await buildToday({ user: s.user, apps: s.apps, ...context, moreWork }, gateway);
      return plan.items.length ? todayList(plan, 'R-today', { startsWork: true }) : null;
    },

    async stalledApplications(persona) {
      const lap = lapFor(persona);
      const p = PERSONAS[persona];
      if (!lap) return [];
      const views = await lap.service.views(lap.who, lap.ctx);
      const own = views.includes('mine');
      if (!own && !p.leadsBranch) return [];
      const { items, count, oldestDays, asOf } = await lap.service.find({ view: own ? 'mine' : 'team', stalledOnly: true }, lap.who, lap.ctx);
      if (!count) return [];
      return [{ id: `ntc_stalled_${own ? 'mine' : 'team'}`, group: 'workflow', title: `${count} ${own ? 'of your applications' : 'team applications'} ${count === 1 ? 'has' : 'have'} stalled`, detail: `Oldest ${oldestDays} days${items[0] ? `: ${items[0].name}` : ''}`, at: `${asOf}T06:00:00.000Z`, link: '/m/lap' }];
    },

    async pipeline(persona, view) {
      const lap = lapFor(persona);
      if (!lap) return null;
      const views = await lap.service.views(lap.who, lap.ctx);
      if (!views.length) return null;
      const chosen = (view ?? views[0]!) as PipelineView;
      const summary = await lap.service.summary(chosen, lap.who, lap.ctx);
      const stalled = await lap.service.find({ view: chosen, stalledOnly: true }, lap.who, lap.ctx);
      return { ...summary, views, details: lap.who.details, take: pipelineTake(stalled, chosen === 'mine') };
    },

    async pipelineApplications(persona, q) {
      const lap = lapFor(persona);
      if (!lap) return null;
      const f = await lap.service.find({ view: q.view, group: q.group, stalledOnly: q.stalled }, lap.who, lap.ctx);
      return { count: f.count, dollars: f.dollars, oldestDays: f.oldestDays, byProduct: f.byProduct, detailsHidden: f.detailsHidden, items: f.items.slice(0, 100).map((a) => applicationView(a, lap.rm)) };
    },

    async pipelineApplication(persona, id) {
      const lap = lapFor(persona);
      if (!lap) return null;
      const a = await lap.service.application(id, lap.who, lap.ctx);
      return { ...applicationView(a, lap.rm), asOf: a.asOf, stale: a.stale, history: a.history };
    },

    referral: referralDetail,

    async referralAction(persona, comId, action) {
      const tenant = tenantFor(persona);
      const wf = tenant?.runtime.workflow;
      const s = PERSONAS[persona].session;
      if (!wf || !s.apps.includes('referrals')) return null;
      const ctx = { purviewBranches: PERSONAS[persona].purview };
      const meta = { userId: s.user.id, userName: s.user.name, employeeId: PERSONAS[persona].employeeId };
      const notify: Notice[] = [];
      if (action.kind === 'note') await wf.referrals.addNote(comId, action.text, meta, ctx);
      else if (action.kind === 'start') await wf.referrals.transition(comId, 'Active', undefined, meta, ctx);
      else if (action.kind === 'assign') {
        const d = await wf.referrals.reassign(comId, action.employeeId, meta, ctx);
        notify.push({ employeeId: action.employeeId, branch: d.branch, title: `Referral #${comId} assigned to ${d.assignee?.name}`, detail: `${d.name} · ${d.typeLabel}`, comId });
      } else {
        const { item, changed } = await wf.referrals.transition(comId, action.stage, action.note, meta, ctx);
        if (changed) notify.push({ userId: item.senderUserId, title: `Referral #${comId} is ${item.stage}`, detail: `${item.name} · ${item.typeLabel}`, comId });
      }
      void audit.event({ eventType: 'referral.action', tenant: tenant!.runtime.key, userId: s.user.id, threadId: '', runId: '', approvalId: '', comId, action: action.kind });
      return { detail: (await referralDetail(persona, comId))!, notify };
    },

    async runReport(persona, templateId, controls, test) {
      const gw = tenantFor(persona)?.runtime.reports?.gateway;
      const s = PERSONAS[persona].session;
      if (!gw || !s.apps.includes('reports')) return null;
      const { canvas } = await gw.run(templateId, controls, { ...personaContext(persona), user: { id: s.user.id }, runId: `R-rpt-${randomBytes(3).toString('hex')}`, test });
      return canvas;
    },

    async editReport(persona, templateId, op, controls) {
      const gw = tenantFor(persona)?.runtime.reports?.gateway;
      const s = PERSONAS[persona].session;
      if (!gw || !s.apps.includes('reports')) return null;
      const { canvas } = await gw.edit(templateId, op, controls, { ...personaContext(persona), user: { id: s.user.id, name: s.user.name }, runId: `R-rpt-${randomBytes(3).toString('hex')}`, threadId: 'canvas' });
      return canvas;
    },

    async exportFile(persona, exportId) {
      const gw = tenantFor(persona)?.runtime.reports?.gateway;
      const s = PERSONAS[persona].session;
      if (!gw || !s.apps.includes('reports')) return null;
      // Only the user who approved the export can download it, rendered under their own purview.
      const e = await gw.store.export(exportId, s.user.id);
      const { canvas } = await gw.run(e.templateId, e.controls, { ...personaContext(persona), user: { id: s.user.id }, runId: `R-exp-${randomBytes(3).toString('hex')}` });
      await gw.store.countDownload(exportId);
      void audit.event({ eventType: 'report.export.downloaded', tenant: tenantFor(persona)!.runtime.key, userId: s.user.id, threadId: '', runId: '', approvalId: '', exportId, templateId: e.templateId, format: e.format, controls: e.controls });
      return renderExport(canvas, e.format, { tenant: tenantFor(persona)!.runtime.name, user: s.user.name });
    },

    async runSchedules(persona) {
      const gw = tenantFor(persona)?.runtime.reports?.gateway;
      const s = PERSONAS[persona].session;
      if (!gw || !s.apps.includes('reports')) return null;
      // Each schedule runs under its owner's access. Delivery to other recipients is simulated
      // locally; production runs per recipient under each one's purview (BE-RPT-020).
      for (const sch of await gw.store.activeSchedules()) {
        const owner = Object.values(PERSONAS).find((p) => p.session.user.id === sch.ownerUserId);
        if (!owner || tenantFor(Object.entries(PERSONAS).find(([, p]) => p === owner)![0] as PersonaId) !== tenantFor(persona)) continue;
        const ctx = { purviewBranches: owner.purview, canViewSql: owner.session.permissions.queryBrowser };
        try {
          const { canvas } = await gw.run(sch.templateId, sch.controls, { ...ctx, user: { id: sch.ownerUserId }, runId: `R-sch-${sch.scheduleId}` });
          const failed = canvas.data.widgets.filter((w) => w.view.type === 'notice' && w.view.data.kind !== 'no_data');
          const empty = canvas.data.widgets.every((w) => w.view.type === 'notice');
          if (failed.length) await gw.store.recordRun(sch.scheduleId, 'failed', `${failed.map((w) => w.title).join(', ')}: ${(failed[0]!.view as { data: { detail?: string; message: string } }).data.detail ?? (failed[0]!.view as { data: { message: string } }).data.message}`);
          else if (empty) await gw.store.recordRun(sch.scheduleId, sch.sendIfEmpty ? 'ok' : 'empty', sch.sendIfEmpty ? 'Sent with no data, as asked.' : 'No data for the period, so nothing was sent.');
          else await gw.store.recordRun(sch.scheduleId, 'ok', `Ran for ${canvas.data.periodLabel} after build ${gw.semantic.build.buildId}; ${canvas.data.widgets.length} sections, ${sch.format.toUpperCase()} to ${sch.recipientCount} ${sch.recipientCount === 1 ? 'recipient' : 'recipients'} (delivery simulated locally).`);
          // The owner's copy lands in their outbox, once per schedule and build: a name and a link only.
          if (!failed.length && (!empty || sch.sendIfEmpty)) await tenantFor(persona)?.outbox?.queue({ userId: sch.ownerUserId, toName: owner.session.user.name, kind: 'report_schedule', title: `${sch.templateName} for ${canvas.data.periodLabel} is ready`, detail: `Schedule #${sch.scheduleId}, ${describeSchedule(sch).toLowerCase()}.`, link: `/reports/${sch.templateId}`, sourceRef: `schedule:${sch.scheduleId}:${gw.semantic.build.buildId}` }).catch(() => null);
        } catch (err) {
          await gw.store.recordRun(sch.scheduleId, 'failed', err instanceof Error ? err.message : String(err));
        }
      }
      return (await gw.store.schedules(s.user.id)).map(scheduleSummary);
    },

    async searchReports(persona, q) {
      const gw = tenantFor(persona)?.runtime.reports?.gateway;
      const s = PERSONAS[persona].session;
      if (!gw || !s.apps.includes('reports') || q.trim().length < 2) return [];
      const all = await gw.store.list(s.user.id);
      // Every word starts a word in the name or folder; the route ranks them against everything else.
      return rank(q, [all.filter((t) => t.status !== 'draft').map((t) => ({ kind: 'report' as const, id: t.templateId, label: t.name, detail: `Reports / ${t.folder}`, link: `/reports/${t.templateId}` }))], { limit: 8 });
    },

    async searchMembers(persona, q) {
      const rm = tenantFor(persona)?.runtime.workflow?.relationship;
      const s = PERSONAS[persona].session;
      if (!rm) return null;
      if (!s.apps.includes('rm') || q.trim().length < 2) return [];
      const hits = await rm.search(q, { purviewBranches: PERSONAS[persona].purview }, 8).catch((err) => {
        if (err instanceof CoreError) return [];
        throw err;
      });
      const base = rm.institutionType === 'bank' ? '/customers' : '/members';
      // Name, masked number and branch only until a record is opened (FE-SRCH-002).
      return hits.map((h) => ({ kind: 'member' as const, id: rm.token(h.partyId), label: h.name, detail: `…${h.last4} · ${h.branch}${h.matchedOn === 'phone' ? ' · phone match' : h.matchedOn === 'email' ? ' · email match' : ''}`, link: `${base}/${rm.token(h.partyId)}` }));
    },

    async home(persona) {
      const tenant = tenantFor(persona);
      if (!tenant?.runtime.semantic) return null;
      const b = await buildBriefing(tenant.runtime.semantic, personaContext(persona));
      const purview = PERSONAS[persona].purview;
      const kpis: KpiGroupBlock = { ...b.kpis, title: undefined, provenance: { ...b.kpis.provenance, filters: purview ? [`Limited to your purview: ${purview.join(', ')}`] : b.kpis.provenance.filters } };
      const lookAt: ListBlock = {
        id: blockId(),
        type: 'list',
        version: '1.0.0',
        title: 'Things to look at',
        provenance: { agent: 'Dashboard/Briefing', sources: [] },
        freshness: b.kpis.freshness,
        data: {
          layout: 'list',
          // A move the figure strip already shows ("rose 5 bp") isn't said again here.
          items: b.lookAt.filter((l) => l.kind === 'outlier').map((l, i) => ({ id: `l${i + 1}`, icon: 'alert', title: l.title, subtitle: l.subtitle, why: l.why, link: `/c/new?q=${encodeURIComponent(l.question)}` })),
        },
      };
      // Scheduled reports with their last result; failures carry "Why?" (spec 8.8 acceptance).
      const gw = tenant.runtime.reports?.gateway;
      const mine = gw ? await gw.store.schedules(PERSONAS[persona].session.user.id) : [];
      const scheduled: ListBlock | null = mine.length
        ? {
            id: blockId(),
            type: 'list',
            version: '1.0.0',
            title: 'Scheduled reports',
            provenance: { agent: 'Report Builder', sources: [] },
            freshness: b.kpis.freshness,
            data: {
              layout: 'list',
              items: mine.slice(0, 6).map((s) => ({
                id: `s${s.scheduleId}`,
                icon: s.lastResult === 'failed' ? 'report_failed' : 'report',
                title: s.templateName,
                subtitle: s.lastResult ? `${describeSchedule(s)} · last run ${new Date(s.lastRunAt!).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}` : `${describeSchedule(s)} · first run after tonight’s build`,
                link: `/reports/${s.templateId}`,
                badge: s.lastResult === 'failed' ? { label: 'Failed', tone: 'danger' } : s.lastResult === 'ok' ? { label: 'Ran', tone: 'success' } : s.lastResult === 'empty' ? { label: 'No data', tone: 'neutral' } : { label: 'Scheduled', tone: 'info' },
                ...(s.lastResult === 'failed' && s.lastDetail ? { why: s.lastDetail } : {}),
              })),
            },
          }
        : null;
      // Real counts for "Your work": the user's own queue, or their team's if they have none.
      const who = { userId: PERSONAS[persona].session.user.id, employeeId: PERSONAS[persona].employeeId };
      const wf = tenant.runtime.workflow;
      const open = wf && PERSONAS[persona].session.apps.includes('referrals') ? await wf.referrals.inbox(worksOwnQueue(persona) ? 'mine' : 'team', who, { purviewBranches: purview }) : null;
      // Reports on Home: the person's own pins and those published to their class, each run under their purview.
      const pins = gw ? await gw.store.pins(who.userId, PERSONAS[persona].userClass).catch(() => []) : [];
      const pinned = (
        await Promise.all(
          pins.slice(0, 4).map(async (p) => {
            const r = await gw!.run(p.templateId, {}, { purviewBranches: purview, canViewSql: false, user: { id: who.userId }, runId: `R-home-${p.pinId}` }).catch(() => null);
            return r && { templateId: p.templateId, name: p.templateName, audience: p.audience, pinnedBy: p.pinnedBy, canvas: r.canvas };
          }),
        )
      ).filter((x) => x !== null);
      const referrals = open && { open: open.length, overdue: open.filter((i) => i.overdue).length };
      // Frontline staff (no Reports) see their own figures, not a smaller copy of the branch's.
      // Frontline staff have their own work to show; an administrator without Reports has neither
      // goals nor referrals, so their Home keeps the institution figures.
      const ownWork = PERSONAS[persona].session.apps.includes('gi') || PERSONAS[persona].session.apps.includes('referrals');
      if (!PERSONAS[persona].session.apps.includes('reports') && ownWork) {
        const mine = tenant.goals && PERSONAS[persona].session.apps.includes('gi') && who.employeeId !== undefined ? await tenant.goals.scorecard(undefined, { employeeId: who.employeeId }, { purviewBranches: purview }).catch(() => null) : null;
        const sent = wf && PERSONAS[persona].session.apps.includes('referrals') ? await wf.referrals.inbox('sent', who, { purviewBranches: purview }).catch(() => []) : [];
        const own = personalKpis(kpis, mine, sent, referrals);
        return { kpis: own.kpis, narrative: own.narrative, lookAt: { ...lookAt, data: { ...lookAt.data, items: [] } }, scheduled, pinned, referrals, jump: [] };
      }
      return { kpis, narrative: b.homeNarrative, lookAt, scheduled, pinned, referrals, jump: jumpCards(persona, { kpis: b.kpis, lookAt: b.lookAt.filter((l) => l.kind === 'outlier') }, pinned, referrals) };
    },

    async table(persona, tableId) {
      const tenant = tenantFor(persona);
      if (tenant && tableId !== 'loan_accounts') return tablesData(tenant, persona, tableId);
      if (!tenant || tableId !== 'loan_accounts') return null;
      const purview = PERSONAS[persona].purview;
      const bank = tenant.runtime.institutionType === 'bank';
      // Purview is applied in SQL, before any row leaves the warehouse (spec 20.7).
      const [rows] = await tenant.pool.query(
        `SELECT l.loan_id, CONCAT(p.first_name, ' ', p.last_name) AS member, b.name AS branch, l.loan_category AS product,
                l.balance, l.rate, l.open_date AS opened, l.days_delinquent AS daysPastDue
           FROM cdm_loan l JOIN cdm_party p ON p.party_id = l.party_id JOIN cdm_location b ON b.int_id = l.branch_id
          WHERE l.close_date IS NULL AND l.charge_off_date IS NULL ${purview ? 'AND b.name IN (?)' : ''}
          ORDER BY l.balance DESC LIMIT 500`,
        purview ? [purview] : [],
      );
      const data = (rows as Record<string, unknown>[]).map(({ loan_id, ...r }) => ({ account: `…${String(loan_id).slice(-4).padStart(4, '0')}`, ...r }) as TableData['rows'][number]);
      const asOf = tenant.runtime.semantic?.build.completedAt;
      return {
        tableId,
        label: 'Loan Accounts',
        columns: [
          { field: 'account', headerName: 'Account', type: 'text' },
          { field: 'member', headerName: bank ? 'Customer' : 'Member', type: 'text' },
          { field: 'branch', headerName: 'Branch', type: 'text' },
          { field: 'product', headerName: 'Product', type: 'text' },
          { field: 'balance', headerName: 'Balance', type: 'currency' },
          { field: 'rate', headerName: 'Rate', type: 'percent' },
          { field: 'opened', headerName: 'Opened', type: 'date' },
          { field: 'daysPastDue', headerName: 'Days past due', type: 'days' },
        ],
        rows: data,
        rowCount: data.length,
        freshnessAsOf: asOf ? `${asOf}-04:00` : new Date().toISOString(),
      };
    },

    async tableWorkbench(persona, tableId) {
      const tenant = tenantFor(persona);
      return tenant ? tablesWorkbench(tenant, persona, tableId) : null;
    },

    async reportSettings(persona, templateId) {
      const gw = tenantFor(persona)?.runtime.reports?.gateway;
      const s = PERSONAS[persona].session;
      if (!gw || !s.apps.includes('reports')) return null;
      return gw.settings(templateId, { user: { id: s.user.id }, canViewSql: s.permissions.queryBrowser, userClass: PERSONAS[persona].userClass });
    },

    async email(userId, n) {
      const entry = Object.entries(PERSONAS).find(([, p]) => p.session.user.id === userId);
      if (!entry) return;
      const outbox = tenantFor(entry[0] as PersonaId)?.outbox;
      await outbox?.queue({ userId, toName: entry[1].session.user.name, ...n }).catch((err: unknown) => console.error('[email]', err));
    },

    async morningEmails(persona) {
      const tenant = tenantFor(persona);
      if (!tenant?.outbox) return null;
      const day = new Date().toISOString().slice(0, 10);
      let emails = 0;
      // Everyone in this tenant: each person's overdue referrals as reminders, and their open work as one digest.
      for (const [id, p] of Object.entries(PERSONAS) as [PersonaId, (typeof PERSONAS)[PersonaId]][]) {
        if (tenantFor(id) !== tenant) continue;
        const who = { userId: p.session.user.id, toName: p.session.user.name };
        const overdue = await rt.overdueReferrals(id).catch(() => []);
        for (const o of overdue) if (await tenant.outbox.queue({ ...who, kind: 'follow_up', title: o.title, detail: o.detail, link: o.link ?? '/workflows/referrals/inbox', sourceRef: `followup:${o.id}:${day}` })) emails++;
        const plan = await rt.today(id).catch(() => null);
        const items = plan?.data.items ?? [];
        if (items.length && (await tenant.outbox.queue({ ...who, kind: 'digest', title: `${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} you today`, detail: items.slice(0, 5).map((i) => i.title).join(' · '), link: '/home', sourceRef: `digest:${day}` }))) emails++;
      }
      return { emails };
    },

    async close() {
      await Promise.all([...tenants.values()].map((t) => t.pool.end()));
    },
  };
  return rt;
}

// ---- Tables: curated tables beyond Loan Accounts, saved views, snapshots and the workbench ----------

const tablesWho = (persona: PersonaId) => {
  const p = PERSONAS[persona];
  return p.session.apps.includes('tables') && p.modules?.includes('tables') ? { userId: p.session.user.id, ctx: { purviewBranches: p.purview } } : null;
};

const savedItem = (t: TableService, o: TableObject, userId: string): TableSavedItem => ({ id: `${o.kind === 'View' ? 'view' : o.kind === 'Upload' ? 'upload' : 'snapshot'}-${o.objId}`, name: o.name, kind: o.kind === 'View' ? 'Saved view' : o.kind === 'Upload' ? 'Uploaded table' : 'Snapshot', table: o.kind === 'Upload' ? 'From a file' : (t.catalog.find((c) => c.id === o.tableId)?.label ?? o.tableId), rows: o.kind === 'View' ? 'Runs when opened' : o.rowCount.toLocaleString('en-US'), owner: o.ownerName, shared: !o.sharedClass ? 'Only you' : o.sharedClass === 'Everyone' ? 'Everyone' : `${o.sharedClass} class`, made: o.createdOn, mine: o.ownerUserId === userId });

/** A curated table other than Loan Accounts, or a saved view or snapshot ("view-12"), under the person's purview. */
async function tablesData(tenant: Tenant, persona: PersonaId, tableId: string): Promise<TableData | null> {
  const who = tablesWho(persona);
  const t = tenant.tables;
  if (!who || !t) return null;
  const asOf = tenant.runtime.semantic?.build.completedAt;
  const freshnessAsOf = asOf ? `${asOf}-04:00` : new Date().toISOString();
  const saved = /^(view|snapshot|upload)-(\d+)$/.exec(tableId);
  const data = saved ? await t.objectRows(who.userId, Number(saved[2]), who.ctx) : t.catalog.some((c) => c.id === tableId) ? await t.rows(tableId, who.ctx) : null;
  if (!data) return null;
  return { tableId, label: data.label, columns: data.columns, rows: data.rows, rowCount: data.rowCount, freshnessAsOf };
}

async function tablesWorkbench(tenant: Tenant, persona: PersonaId, tableId: string): Promise<TableWorkbench | null> {
  const who = tablesWho(persona);
  const t = tenant.tables;
  if (!who || !t) return null;
  const saved = /^(view|snapshot|upload)-(\d+)$/.exec(tableId);
  const object = saved ? (await t.objects(who.userId)).find((o) => o.objId === Number(saved[2])) : undefined;
  if (saved && !object) return null;
  // An uploaded table has no curated table behind it: its rows, and the asks that fit a file's data.
  if (object?.kind === 'Upload') {
    const item = savedItem(t, object, who.userId);
    return { tableId, label: object.name, stats: [], personal: [], relationships: [], saved: [item], actions: [{ label: 'Add rows from a file', ask: null, why: 'Upload the file on Integrations, then ask DI to add it to this table.' }, item.mine ? { label: 'Make public', ask: `Make ${object.name} public` } : { label: 'Make public', ask: null, why: `${object.ownerName} owns this table.` }] };
  }
  const base = t.catalog.find((c) => c.id === (object?.tableId ?? tableId));
  if (!base) return null;
  const st = object ? null : await t.stats(base.id, who.ctx);
  const items = (await t.objects(who.userId, { tableId: base.id })).map((o) => savedItem(t, o, who.userId));
  const links = t.relationships(base.id);
  const mine = items.filter((i) => i.mine);
  const target = object ? savedItem(t, object, who.userId) : mine[0];
  return {
    tableId,
    label: object?.name ?? base.label,
    stats: st ? columnStatRows(st.columns) : [],
    personal: base.personal,
    relationships: links,
    saved: items,
    actions: [
      { label: 'Column stats', ask: `Profile the ${base.label} table` },
      { label: 'Snapshot', ask: `Snapshot the ${base.label} table` },
      links[0] ? { label: 'Merge…', ask: `Merge ${base.label} with ${links[0].table} on ${links[0].key} as a saved view called ${base.label} with ${links[0].table}` } : { label: 'Merge…', ask: null, why: 'No other table links to this one.' },
      target?.mine ? { label: 'Make public', ask: target.kind !== 'Saved view' ? `Make ${target.name} public` : `Make the ${target.name} view public` } : { label: 'Make public', ask: null, why: 'Save a view or snapshot of your own first.' },
    ],
  };
}

// ---- Home: Jump back in --------------------------------------------------------------------------

type KpiItem = KpiGroupBlock['data']['items'][number];
const changeOf = (k: KpiItem | undefined): JumpCard['change'] => {
  const c = k?.comparison;
  // A change that rounds to nothing ("↓ 0 bp") says nothing, so it isn't shown.
  const v = Math.abs(c?.value ?? 0);
  if (!c || c.direction === 'flat' || v < 0.05) return undefined;
  const text = `${c.direction === 'up' ? '↑' : '↓'} ${c.unit === 'bp' ? `${Math.round(v)} bp` : c.unit === 'percent' ? `${Math.round(v * 10) / 10}%` : v.toLocaleString('en-US')} ${c.label}`;
  return { text, good: c.direction === c.goodWhen };
};
const figureOf = (k: KpiItem | undefined): JumpCard['figure'] =>
  k && typeof k.value === 'number' && (k.unit === 'currency' || k.unit === 'percent' || k.unit === 'count') ? { label: k.label, value: k.value, unit: k.unit, decimals: k.format?.decimals, compact: k.format?.compact } : undefined;

/** The report each role opens first: what they are measured on. */
const ROLE_REPORT: Partial<Record<PersonaId, { id: string; title: string; reason: string }>> = {
  executive: { id: 'executive_dashboard_monthly', title: 'Executive dashboard', reason: 'The month for leadership: members, balances, per-member averages and new lending by loan group.' },
  bank_cfo: { id: 'executive_dashboard_monthly', title: 'Executive dashboard', reason: 'The month for leadership: customers, balances, per-customer averages and new lending by loan group.' },
  analyst: { id: 'lending_portfolio_monthly', title: 'Lending portfolio', reason: 'The loan book by category: balances, counts, rate and delinquency.' },
  branch: { id: 'growth_my_branch_monthly', title: 'Growth report – My branch', reason: 'Your branch’s new relationships and lending this month.' },
};

/**
 * A few places worth opening today (today's DI lists every dashboard; DI Next says which ones matter
 * and why). Each card carries a figure from the build, DI's reason, and one action. At most four.
 */
export function jumpCards(persona: PersonaId, b: { kpis: KpiGroupBlock; lookAt: { title: string; subtitle: string; question: string }[] }, pinned: { templateId: string; name: string; audience: string; pinnedBy: string; canvas: ReportCanvasBlock }[], _referrals: { open: number; overdue: number } | null): JumpCard[] {
  const apps = PERSONAS[persona].session.apps;
  const items = b.kpis.data.items;
  // Every figure says whose it is: one branch is named, several are "your branches".
  const purview = PERSONAS[persona].purview;
  const scope = purview ? (purview.length === 1 ? `at ${purview[0]}` : 'across your branches') : 'across the institution';
  const cards: JumpCard[] = [];
  // One place per fact: the figure strip shows the numbers and Worth a look shows the outlier, so a
  // card carries neither again. It says where to go and why. A flagged delinquency is already in
  // Worth a look, with its own Why?, so it gets no second card.
  const flag = b.lookAt.find((l) => /delinquen/i.test(l.title));
  const onStrip = (k: KpiItem | undefined) => Boolean(k && items.some((i) => i.label === k.label && i.value === k.value));
  if (apps.includes('reports') && !flag) {
    cards.push({ id: 'dq', title: 'Loan delinquency', kind: 'report', reason: `Loans 60 or more days past due ${scope}, by category and branch.`, link: '/reports/loan_delinquency_monthly', action: { label: 'Ask why', ask: 'Where does delinquency come from?' } });
  }
  // Referrals live in Your work; a second card for them would say the same thing twice.
  for (const p of pinned.slice(0, 2)) {
    const first = p.canvas.data.widgets.find((w) => w.view.type === 'kpi')?.view;
    const k = first?.type === 'kpi' ? (first.data as unknown as KpiItem) : undefined;
    const fresh = onStrip(k) ? undefined : k;
    cards.push({ id: `pin-${p.templateId}`, title: p.name, kind: 'pinned', figure: figureOf(fresh), change: changeOf(fresh), reason: p.audience === 'me' ? 'Pinned to your Home.' : `Published to the ${p.audience} class by ${p.pinnedBy}.`, link: `/home/pin-${p.templateId}`, action: { label: 'Brief me', ask: `Brief me on the ${p.name} report` } });
  }
  const role = ROLE_REPORT[persona];
  if (role && apps.includes('reports') && !cards.some((c) => c.link.endsWith(role.id))) {
    cards.push({ id: 'role', title: role.title, kind: 'report', reason: role.reason, link: `/reports/${role.id}`, action: { label: 'Brief me', ask: `Brief me on the ${role.title} report` } });
  }
  return cards.slice(0, 4);
}

// ---- Home: frontline figures ---------------------------------------------------------------------

const DAY = 86_400_000;

/**
 * Frontline staff (tellers, member service, lenders without Reports) see their own month: goals,
 * incentive so far, the referrals they sent and the work waiting for them. Code writes every figure
 * and the sentence; nothing here is branch or institution money they don't manage.
 */
export function personalKpis(base: KpiGroupBlock, mine: Scorecard | null, sent: Pick<InboxItem, 'createdAt' | 'stage'>[], work: { open: number; overdue: number } | null, now = Date.now()) {
  const scored = mine?.goals.filter((g) => !g.qualifier && g.target > 0) ?? [];
  const attainment = scored.length ? Math.round((scored.reduce((n, g) => n + Math.min(g.actual / g.target, 2), 0) / scored.length) * 1000) / 10 : null;
  const behind = scored.filter((g) => g.actual < g.target).length;
  const recent = sent.filter((r) => now - Date.parse(r.createdAt) <= 30 * DAY);
  const sold = recent.filter((r) => r.stage === 'Sold').length;
  const items: KpiGroupBlock['data']['items'] = [];
  if (attainment !== null) items.push({ label: 'My goal attainment', value: attainment, unit: 'percent', format: { decimals: 1 }, comparison: { label: behind ? `${behind === 1 ? 'goal' : 'goals'} behind target` : 'every goal on target', value: behind, unit: 'count', direction: 'flat', goodWhen: 'down' }, metricRef: 'metric:goal_attainment' });
  if (mine) items.push({ label: `Incentive so far, ${mine.period}`, value: mine.total, unit: 'currency', format: { decimals: 0 }, metricRef: 'metric:incentive_earned' });
  items.push({ label: 'Referrals I sent', value: recent.length, unit: 'count', comparison: { label: 'sold, last 30 days', value: sold, unit: 'count', direction: 'flat', goodWhen: 'up' }, metricRef: 'metric:referrals_sent' });
  if (work) items.push({ label: 'My open work', value: work.open, unit: 'count', comparison: { label: 'overdue', value: work.overdue, unit: 'count', direction: 'flat', goodWhen: 'down' }, metricRef: 'metric:open_work' });
  const kpis: KpiGroupBlock = { ...base, provenance: { ...base.provenance, sources: [{ kind: 'table', label: 'Goals & Incentives', ref: 'table:gi_scorecard' }, { kind: 'table', label: 'Referrals', ref: 'table:esp_com_items' }], filters: ['Your own work'] }, data: { layout: 'row', items } };
  // The strip has the numbers; this says what they mean and where to start, without repeating them.
  const furthest = scored.filter((g) => g.actual < g.target).sort((a, b) => a.actual / a.target - b.actual / b.target)[0];
  const parts = [
    furthest ? `**${furthest.name}** is the goal furthest behind, so that’s where to focus this month.` : scored.length ? 'Every goal is on target this month.' : null,
    mine && !mine.qualified ? 'A qualifier is still missing, so the incentive isn’t paid yet.' : null,
    work ? (work.overdue ? 'Start with your overdue work.' : 'Nothing of yours is overdue.') : null,
  ];
  return { kpis, narrative: parts.filter(Boolean).join(' ') };
}
