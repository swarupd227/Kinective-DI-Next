// Live agents for the Experience Layer: the DI Concierge on Claude, answering from the semantic layer
// over the synthetic tenant warehouse. Starts only when the warehouse is reachable; without an API
// key the Concierge runs its deterministic offline planner (spec 23.6.4).
import { randomBytes } from 'node:crypto';
import type { ApprovalCardBlock, ApprovalDecisionRequest, Block, KpiGroupBlock, ListBlock, Member360Block, SearchResult, StreamEvent, StreamingEnvelope, TableData } from '@dinext/block-schemas';
import { AnthropicModelClient, AuditLog, Concierge, ReportGateway, ToolGateway, buildBriefing, buildToday, goalsTake, pipelineTake, referralTake, reportsTake, todayList, describeSchedule, hasClaudeCredentials, member360, memberTake, type ApprovalDecisionResult, type ConciergeTurn, type ReportControls, type RouteAgent, type RunSink, type TenantRuntime } from '@dinext/agents';
import { ApprovalStore, CoreError, GoalsService, usd, PipelineService, ReferralService, RelationshipService, ReportStore, type InboxItem, type PipelineApplication, type PipelineView, type ScheduleRow, type TemplateRow } from '@dinext/di-core';
import type { AppNotification, DiTake, GoalsIndex, PipelineApplicationDetail, PipelineApplicationRow, PipelineIndex, PipelineList, PipelineViewId, ReferralAction, ReferralDetail, ReferralsIndex, ReferralSummary, ReportCanvasBlock } from '@dinext/block-schemas';
import { renderExport } from './exports.ts';
import { SemanticService } from '@dinext/semantic';
import { tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { PERSONAS, type PersonaId } from './data.ts';

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
  pipeline: PipelineService | null;
  goals: GoalsService | null;
  /** Words for the recogniser: branches, products and staff, never members (FE-VOICE-061). */
  vocabulary: string[];
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
  /** Runs one turn of the Concierge. */
  run(persona: PersonaId, req: { threadId: string; runId: string; text: string; context: ConciergeTurn['context'] }, emit: (e: Emit) => void, signal: AbortSignal, speed: number): Promise<LiveRunResult>;
  /**
   * A decision on a live card. Resolves with the HTTP answer once the approval service has accepted
   * or refused it; `onDone` fires when any follow-on work (executing the write) has streamed.
   */
  decide(persona: PersonaId, req: { approvalId: string; threadId: string; runId: string; body: ApprovalDecisionRequest }, emit: (e: Emit) => void, onDone: (result: unknown) => void, speed: number): Promise<ApprovalDecisionResult>;
  home(persona: PersonaId): Promise<{ kpis: KpiGroupBlock; narrative: string; lookAt: ListBlock; scheduled: ListBlock | null; referrals: { open: number; overdue: number } | null } | null>;
  /**
   * A member's 360 for the workspace or the member page (GET /v1/members/{token}). Null when the
   * relationship data is not loaded; NO_ACCESS for a token outside the purview. Logged as an access.
   */
  member(persona: PersonaId, token: string): Promise<Member360Block | null>;
  /** Member search for Ctrl+K and the voice picker: masked results within the purview (BE-RM-002). */
  searchMembers(persona: PersonaId, q: string): Promise<SearchResult[] | null>;
  /** The Reports app: templates the user can open and their schedules (spec 8.5–8.9). */
  reports(persona: PersonaId): Promise<{ take: DiTake; templates: ReportSummary[]; schedules: ScheduleSummary[] } | null>;
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
  /** Runs every active schedule as the nightly build would (local stand-in for the after-build trigger). */
  runSchedules(persona: PersonaId): Promise<ScheduleSummary[] | null>;
  /** The tenant's own words for speech recognition (spec 7.8). */
  vocabulary(persona: PersonaId): string[];
  table(persona: PersonaId, tableId: string): Promise<TableData | null>;
  close(): Promise<void>;
}

/** Someone to tell: a named user, or whoever works and leads a branch's queue. */
export interface Notice {
  userId?: string;
  employeeId?: number;
  branch?: string;
  title: string;
  detail?: string;
  comId: number;
}

/** Frontline staff work their own queue; a branch lead and everyone else look after the team's. */
const worksOwnQueue = (p: PersonaId) => PERSONAS[p].employeeId !== undefined && !PERSONAS[p].leadsBranch;

/** Loan Pipeline access from the persona's place in the module matrix (spec 20.7). */
const lapAccess = (p: PersonaId) => ({ details: Boolean(PERSONAS[p].lapDetails), leads: PERSONAS[p].leadsBranch, admin: PERSONAS[p].lendingAdmin });

/** Goals & Incentives access from the same matrix. */
const giAccess = (p: PersonaId) => ({ leads: PERSONAS[p].leadsBranch, approves: PERSONAS[p].approvesIncentives });

const personaContext = (p: PersonaId) => {
  const s = PERSONAS[p].session;
  return { purviewBranches: PERSONAS[p].purview, canViewSql: s.permissions.queryBrowser, employeeId: PERSONAS[p].employeeId, lap: lapAccess(p), gi: giAccess(p) };
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
    // Goals & Incentives exists once the tenant was seeded with Slice 14 or later.
    const hasGoals = await pool.query('SELECT 1 FROM mod_gi_goal LIMIT 1').then(
      () => true,
      () => false,
    );
    const goals = hasGoals ? new GoalsService(pool) : null;
    const workflow = referrals ? { referrals, relationship, gateway: new ToolGateway({ referrals, relationship: relationship ?? undefined, pipeline: pipeline ?? undefined, goals: goals ?? undefined, semantic, approvals: new ApprovalStore(pool), onProfileView }) } : null;
    // Report templates exist once the tenant was seeded with Slice 6 or later.
    const hasReports = await pool.query('SELECT 1 FROM esp_report_templates LIMIT 1').then(
      () => true,
      () => false,
    );
    const reports = hasReports ? { gateway: new ReportGateway({ store: new ReportStore(pool), semantic, approvals: new ApprovalStore(pool) }) } : null;
    const [staff] = await pool.query('SELECT DISTINCT display_name FROM cdm_employee');
    const dims = semantic.dimensionValues;
    const vocabulary = [...new Set([...(dims.branch ?? []), ...(dims.region ?? []), ...(dims.loan_category ?? []), ...(dims.deposit_category ?? []), ...(staff as { display_name: string }[]).map((s) => s.display_name).filter((s) => !/^\w\. /.test(s))])];
    tenants.set(tenantId, { pool, pipeline, goals, vocabulary, runtime: { key: t.key, name, institutionType, semantic, workflow, reports } });
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
    return { ...referralView(d, wf.relationship ?? null), history: d.history, team: d.team, canWork: !purview || purview.includes(d.branch) };
  };

  return {
    concierge,
    mode: model ? 'live' : 'offline',

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
      return {
        take: reportsTake(templates, schedules),
        templates: templates.map((t) => ({ templateId: t.templateId, name: t.name, folder: t.folder, status: t.status, periodType: t.definition.settings.periodType, description: t.definition.description, sections: t.definition.widgets.length, owner: t.ownerName, updatedAt: t.updatedAt, origin: t.origin ? `Created by ${t.origin.agent}, approved by ${t.origin.approvedBy}` : undefined })),
        schedules,
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
      const plan = await buildToday({ user: s.user, apps: s.apps, ...personaContext(persona) }, gateway);
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
        } catch (err) {
          await gw.store.recordRun(sch.scheduleId, 'failed', err instanceof Error ? err.message : String(err));
        }
      }
      return (await gw.store.schedules(s.user.id)).map(scheduleSummary);
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
          items: b.lookAt.map((l, i) => ({ id: `l${i + 1}`, icon: 'alert', title: l.title, subtitle: l.subtitle, why: l.why, link: `/c/new?q=${encodeURIComponent(l.question)}` })),
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
      return { kpis, narrative: b.narrative, lookAt, scheduled, referrals: open && { open: open.length, overdue: open.filter((i) => i.overdue).length } };
    },

    async table(persona, tableId) {
      const tenant = tenantFor(persona);
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

    async close() {
      await Promise.all([...tenants.values()].map((t) => t.pool.end()));
    },
  };
}
