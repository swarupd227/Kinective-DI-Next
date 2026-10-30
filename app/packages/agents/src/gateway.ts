// Tool registry and gateway for write-capable agents (spec 25). Every call is looked up, validated,
// stripped of reserved keys, resolved from reference tokens, authorised and tiered in code. A write
// never runs from a model call: it returns approval_required, and only an approved, unchanged
// payload is executed, once, with the approval ID as its idempotency key.
import { z } from 'zod';
import { ApprovalStore, CoreError, type ApprovalRecord, type AtRiskMember, type MemberProfile, type PartyHit, type ReferralService, type RelationshipService, type RiskTier, type RouteResult, type Topic } from '@dinext/di-core';

export type AgentId = 'referral' | 'relationship' | 'goal';

export interface ToolDef<I extends z.ZodType = z.ZodType> {
  name: string;
  operation: string;
  description: string;
  input: I;
  sideEffect: 'read' | 'write';
  /** Default tier from the operation's metadata; argument rules may raise it, never lower it. */
  riskTier: 'none' | RiskTier;
  /** The user needs one of these apps to see the tool (AI-ARC-021). */
  requiredApp: string | string[];
  purviewScope: 'com' | 'report_viewer' | 'none';
  maxResultRowsToModel: number;
  /** Agents whose tool list includes this tool; defaults to the Referral agent. */
  agents?: AgentId[];
}

/** One approval covers at most this many people, so the list can be read before it is approved. */
export const FOLLOW_UP_CAP = 5;
export const FOLLOW_UP_TYPE = 'retention_follow_up';

const memberRef = z.string().regex(/^MBR_\d{1,4}$/).describe('A member_ref from relationship_party_search, such as MBR_1');
const fieldValues = z.record(z.string(), z.union([z.string().max(200), z.number()])).describe('Values for the type’s form fields, keyed by field id');

export const PartySearchInput = z.object({ name: z.string().min(2).max(80).describe('The person’s name as the user said it, optionally with "at <branch>"; or a member number, its last four digits, a phone number or an email') }).strict();
export const RouteInput = z.object({ referral_type: z.string(), member_ref: memberRef }).strict();
export const CreateInput = z
  .object({
    referral_type: z.string(),
    member_ref: memberRef,
    fields: fieldValues.default({}),
    notes: z.string().max(200).optional().describe('Short note for the recipient in the user’s words, without account numbers'),
    priority: z.enum(['Low', 'Normal', 'High', 'Urgent']).optional(),
  })
  .strict();

export const REFERRAL_TOOLS = [
  {
    name: 'relationship_party_search',
    operation: 'relationship.party.search',
    description: 'Find a member or customer by name, member number, phone or email. Returns up to five matches within the user’s purview, each with a member_ref to use in other tools. People outside the purview are never returned.',
    input: PartySearchInput,
    sideEffect: 'read',
    riskTier: 'none',
    requiredApp: ['referrals', 'rm'],
    purviewScope: 'com',
    maxResultRowsToModel: 5,
    agents: ['referral', 'relationship', 'goal'],
  },
  {
    name: 'referral_route',
    operation: 'referral.route',
    description: 'Show where a referral of this type for this member would go, as computed by the DI Core routing rules. Read only.',
    input: RouteInput,
    sideEffect: 'read',
    riskTier: 'none',
    requiredApp: 'referrals',
    purviewScope: 'com',
    maxResultRowsToModel: 1,
  },
  {
    name: 'referral_create',
    operation: 'referral.create',
    description:
      'Prepare a referral for the user’s approval. Nothing is sent: the platform checks the fields against the type’s form, computes routing and returns approval_required, or the missing and invalid fields. Use only fields the type’s form has. Call it again with corrections to replace the draft.',
    input: CreateInput,
    sideEffect: 'write',
    riskTier: 'medium',
    requiredApp: 'referrals',
    purviewScope: 'com',
    maxResultRowsToModel: 1,
  },
] satisfies ToolDef[];

export const ProfileInput = z.object({ member_ref: memberRef }).strict();
export const ExplainInput = z.object({ member_ref: memberRef, score: z.enum(['attrition', 'next_best']) }).strict();
export const DeclineInput = z.object({ member_ref: memberRef, product: z.string().min(2).max(60).describe('The suggested product the member declined, as listed in the profile’s opportunities') }).strict();

/** Relationship agent tools (spec 24.15). Viewing a record is a read and is logged (spec 8.24). */
export const AtRiskInput = z.object({ limit: z.number().int().min(1).max(25).default(25) }).strict();
export const BatchInput = z.object({ member_refs: z.array(memberRef).min(1).max(FOLLOW_UP_CAP), notes: z.string().max(300).optional() }).strict();

export const RELATIONSHIP_TOOLS = [
  {
    name: 'relationship_at_risk',
    operation: 'relationship.attrition.list',
    description: 'List people with a high attrition score that the user may see, highest first, with the reasons the model gives.',
    input: AtRiskInput,
    sideEffect: 'read',
    riskTier: 'none',
    requiredApp: 'rm',
    purviewScope: 'report_viewer',
    maxResultRowsToModel: 25,
    agents: ['goal'],
  },
  {
    name: 'retention_follow_ups_create',
    operation: 'referral.create.batch',
    description: 'Prepare a retention follow-up for each person, sent to their branch to work. Returns approval_required with the list shown in full; nothing is sent until the user approves.',
    input: BatchInput,
    sideEffect: 'write',
    riskTier: 'medium',
    requiredApp: 'referrals',
    purviewScope: 'com',
    maxResultRowsToModel: 1,
    agents: ['goal'],
  },
  {
    name: 'relationship_profile_get',
    operation: 'relationship.profile.get',
    description: 'Open a member’s 360 profile: accounts, digital use, scores, opportunities, loan applications, interactions and household. Opening it shows the record to the user and logs the access.',
    input: ProfileInput,
    sideEffect: 'read',
    riskTier: 'none',
    requiredApp: 'rm',
    purviewScope: 'report_viewer',
    maxResultRowsToModel: 1,
    agents: ['relationship', 'goal'],
  },
  {
    name: 'relationship_next_best_conversation',
    operation: 'relationship.next_best_conversation',
    description: 'Topics to raise with the member today, ranked by the platform: pending applications, retention risk, product opportunities, then digital gaps. Each has a topic_id and the reason to cite.',
    input: ProfileInput,
    sideEffect: 'read',
    riskTier: 'none',
    requiredApp: 'rm',
    purviewScope: 'report_viewer',
    maxResultRowsToModel: 5,
    agents: ['relationship', 'goal'],
  },
  {
    name: 'predictive_scores_explain',
    operation: 'predictive.scores.explain',
    description: 'The main factors behind a member’s attrition or next-best-product score, and the model’s last run date.',
    input: ExplainInput,
    sideEffect: 'read',
    riskTier: 'none',
    requiredApp: 'rm',
    purviewScope: 'report_viewer',
    maxResultRowsToModel: 10,
    agents: ['relationship'],
  },
  {
    name: 'relationship_suggestion_decline',
    operation: 'relationship.suggestion.decline',
    description: 'Record that the member declined a suggested product, which hides it for 90 days. Nothing is saved: the platform returns approval_required and the user approves on screen.',
    input: DeclineInput,
    sideEffect: 'write',
    riskTier: 'low',
    requiredApp: 'rm',
    purviewScope: 'report_viewer',
    maxResultRowsToModel: 1,
    agents: ['relationship'],
  },
] satisfies ToolDef[];

/** Keys that must never come from a model (AI-TRG-002); identity and scope are set by the gateway. */
const RESERVED = new Set(['tenant', 'tenant_id', 'user_id', 'as_user', 'purview', 'class_id', 'db', 'schema', 'link', 'party_id', 'queue_id', 'approval_id']);
export function reservedKeys(value: unknown, path = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [...(RESERVED.has(k.toLowerCase()) ? [`${path}${k}`] : []), ...reservedKeys(v, `${path}${k}.`)]);
}

/** Tenant policy may raise a tool's tier, never lower it below the platform default (AI-GRD-073). */
const TIERS: ('none' | RiskTier)[] = ['none', 'low', 'medium', 'high'];
export function effectiveTier(def: ToolDef, tenantRaise: Partial<Record<string, RiskTier>> = {}): 'none' | RiskTier {
  const raised = tenantRaise[def.operation];
  return raised && TIERS.indexOf(raised) > TIERS.indexOf(def.riskTier) ? raised : def.riskTier;
}

export interface GatewayContext {
  user: { id: string; name: string };
  apps: string[];
  purviewBranches?: string[];
  runId: string;
  threadId: string;
  /** Reference tokens for this thread: MBR_n → party ID. The model never sees real identifiers. */
  members: Map<string, number>;
}

export interface ReferralPayload {
  typeId: string;
  partyId: number;
  fields: Record<string, string | number>;
  notes?: string;
  priority?: 'Low' | 'Normal' | 'High' | 'Urgent';
  toQueueId: string;
}

export interface DraftResult {
  approval: ApprovalRecord;
  payload: ReferralPayload;
  route: RouteResult;
  party: PartyHit;
  superseded: string[];
}

export interface BatchPayload {
  items: (ReferralPayload & { name: string; branch: string; to: string; reason: string })[];
}

export interface BatchDraft {
  approval: ApprovalRecord;
  payload: BatchPayload;
  /** Asked for, but already holding an open follow-up. */
  skipped: string[];
  superseded: string[];
}

export interface DeclinePayload {
  partyId: number;
  suggestionId: number;
  product: string;
}

export interface DeclineDraft {
  approval: ApprovalRecord;
  payload: DeclinePayload;
  party: PartyHit;
  superseded: string[];
}

export type GatewayResult =
  | { ok: true; content: unknown; draft?: DraftResult; decline?: DeclineDraft; batch?: BatchDraft; atRisk?: { total: number; items: (AtRiskMember & { ref: string; followedUp: boolean })[] }; hits?: (PartyHit & { matchedOn?: string })[]; profile?: MemberProfile; topics?: Topic[]; explained?: ReturnType<RelationshipService['explain']> }
  | { ok: false; code: 'UNKNOWN_TOOL' | 'NOT_ALLOWED' | 'INVALID_INPUT' | 'RESERVED_KEY' | 'UNKNOWN_REF' | 'NO_ACCESS' | 'NOT_FOUND' | 'FORM_INCOMPLETE'; content: unknown };

export type Executed = { operation: 'referral.create'; created: Awaited<ReturnType<ReferralService['create']>> } | { operation: 'referral.create.batch'; created: { comId: number; name: string; queueName: string; assignee: string | null }[]; failed: string[] } | { operation: 'relationship.suggestion.decline'; declined: { product: string; until: string }; partyId: number };

const round = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n / 100) * 100 : Math.round(n));

/** What the model sees of a profile: enough to write talking points, with identifiers masked. */
function profileForModel(p: MemberProfile, ref: string) {
  return {
    member_ref: ref,
    name: p.name,
    branch: p.branch,
    member_since: p.joined.slice(0, 7),
    segment: p.segment,
    alerts: p.alerts.map((a) => a.label),
    accounts: [...p.deposits, ...p.loans].slice(0, 12).map((a) => ({ name: a.name, ends: a.suffix, balance: round(a.balance), change_30d: round(a.balance - a.balance30d), fees_30d: a.fees30d })),
    totals: { deposits: round(p.totals.deposits), loans: round(p.totals.loans), products: p.totals.products },
    digital: Object.fromEntries(p.digital.map((d) => [d.id, d.enrolled])),
    direct_deposit: p.directDeposit,
    last_login: p.lastLogin,
    attrition: { score: p.attrition.score, scale: 10, band: p.attrition.band, factors: p.attrition.factors.map((f) => f.label) },
    opportunities: p.opportunities.map((o) => ({ product: o.product, likelihood: o.likelihood, reason: o.reason, can_refer: Boolean(o.referralTypeId) })),
    declined_recently: p.declined.map((d) => d.product),
    loan_applications_365d: p.applications.items.map((a) => ({ product: a.product, amount: a.amount, status: a.status, detail: a.detail, applied: a.applied })),
    recent_interactions: p.interactions.items.slice(0, 5).map((i) => ({ date: i.at.slice(0, 10), channel: i.channel, summary: i.summary })),
    household_size: p.household.length + 1,
  };
}

export class ToolGateway {
  constructor(
    private readonly deps: {
      referrals: ReferralService;
      approvals: ApprovalStore;
      relationship?: RelationshipService;
      tenantRaise?: Partial<Record<string, RiskTier>>;
      /** Called for every member record opened through a tool; the access is audited (FE-RM-003). */
      onProfileView?: (partyId: number, ctx: GatewayContext) => void;
    },
    private readonly tools: ToolDef[] = [...REFERRAL_TOOLS, ...RELATIONSHIP_TOOLS],
  ) {}

  get relationship() {
    return this.deps.relationship ?? null;
  }

  /** Tools the model may see for this user and agent (AI-ARC-021). */
  visible(ctx: GatewayContext, agent: AgentId = 'referral') {
    const apps = (t: ToolDef) => (Array.isArray(t.requiredApp) ? t.requiredApp : [t.requiredApp]);
    return this.tools.filter((t) => (t.agents ?? ['referral']).includes(agent) && apps(t).some((a) => ctx.apps.includes(a)) && (t.operation.startsWith('referral.') || t.operation === 'relationship.party.search' || this.deps.relationship));
  }

  private async party(ref: string, ctx: GatewayContext) {
    const id = ctx.members.get(ref);
    if (id === undefined) return null;
    return this.deps.referrals.party(id, ctx);
  }

  /** A stable reference token for a party in this thread, so "the first one" means the same person next turn. */
  refFor(partyId: number, ctx: Pick<GatewayContext, 'members'>) {
    let ref = [...ctx.members].find(([, id]) => id === partyId)?.[0];
    if (!ref) ctx.members.set((ref = `MBR_${ctx.members.size + 1}`), partyId);
    return ref;
  }

  async call(name: string, input: unknown, ctx: GatewayContext, agent: AgentId = 'referral'): Promise<GatewayResult> {
    const def = this.visible(ctx, agent).find((t) => t.name === name);
    if (!def) return { ok: false, code: 'UNKNOWN_TOOL', content: { error: 'UNKNOWN_TOOL', message: `No tool ${name} for this user.` } };
    const reserved = reservedKeys(input);
    if (reserved.length) return { ok: false, code: 'RESERVED_KEY', content: { error: 'RESERVED_KEY', message: `These keys are set by the platform and must not be sent: ${reserved.join(', ')}.` } };
    const parsed = def.input.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT', content: { error: 'INVALID_INPUT', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } };
    const args = parsed.data as Record<string, unknown>;

    try {
      switch (def.operation) {
        case 'relationship.party.search': {
          const rm = this.deps.relationship;
          const hits = rm ? await rm.search(String(args.name), ctx, def.maxResultRowsToModel) : await this.deps.referrals.searchParties(String(args.name), ctx, def.maxResultRowsToModel);
          const out = hits.map((h) => ({ member_ref: this.refFor(h.partyId, ctx), name: h.name, branch: h.branch, member_since: h.memberSince, number_ends: h.last4, products: h.products }));
          return { ok: true, content: { matches: out, count: out.length }, hits };
        }
        case 'relationship.attrition.list': {
          const found = await this.deps.relationship!.atRisk(ctx, Number(args.limit));
          const open = await this.deps.referrals.openFor(FOLLOW_UP_TYPE, found.items.map((m) => m.partyId));
          const items = found.items.map((m) => ({ ...m, ref: this.refFor(m.partyId, ctx), followedUp: open.has(m.partyId) }));
          for (const m of items) this.deps.onProfileView?.(m.partyId, ctx);
          return { ok: true, content: { total: found.total, members: items.map((m) => ({ member_ref: m.ref, name: m.name, branch: m.branch, score: m.score, reasons: m.reasons, has_open_follow_up: m.followedUp })) }, atRisk: { total: found.total, items } };
        }
        case 'referral.create.batch': {
          const rm = this.deps.relationship!;
          const a = args as z.infer<typeof BatchInput>;
          const ids = a.member_refs.map((ref) => ctx.members.get(ref));
          if (ids.some((id) => id === undefined)) return { ok: false, code: 'UNKNOWN_REF', content: { error: 'UNKNOWN_REF', message: 'Use member_refs returned by relationship_at_risk or relationship_party_search.' } };
          const open = await this.deps.referrals.openFor(FOLLOW_UP_TYPE, ids as number[]);
          const items: BatchPayload['items'] = [];
          const skipped: string[] = [];
          for (const id of ids as number[]) {
            const p = await rm.profile(id, ctx);
            if (open.has(id)) {
              skipped.push(p.name);
              continue;
            }
            // The form takes the contact method on file; "Mail" has no follow-up channel, so it becomes a call.
            const preferred = ['Phone', 'Email', 'Text'].includes(p.contact.preferred) ? p.contact.preferred : 'Phone';
            const check = await this.deps.referrals.check({ typeId: FOLLOW_UP_TYPE, fields: { preferred_contact: preferred } });
            const route = await this.deps.referrals.route(FOLLOW_UP_TYPE, id);
            const reason = p.attrition.factors.find((f) => f.weight > 0)?.label ?? 'High attrition score';
            items.push({ typeId: FOLLOW_UP_TYPE, partyId: id, fields: check.fields, notes: (a.notes ?? `Attrition score ${p.attrition.score} of 10: ${reason}.`).slice(0, 300), priority: 'High', toQueueId: route.queueId, name: `${p.name} (…${p.last4})`, branch: p.branch, to: route.queueName, reason });
          }
          if (!items.length) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: 'Everyone on that list already has an open follow-up.', skipped } };
          const payload: BatchPayload = { items };
          const tier = effectiveTier(def, this.deps.tenantRaise);
          const approval = await this.deps.approvals.request({ operation: def.operation, payload, riskTier: tier === 'none' ? 'low' : tier, requestedBy: ctx.user.id, runId: ctx.runId, threadId: ctx.threadId });
          const superseded = await this.deps.approvals.supersede(ctx.threadId, approval.approvalId);
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, follow_ups: items.length, already_open: skipped, note: 'Nothing has been sent. The user approves on screen.' }, batch: { approval, payload, skipped, superseded } };
        }
        case 'relationship.profile.get':
        case 'relationship.next_best_conversation':
        case 'predictive.scores.explain':
        case 'relationship.suggestion.decline': {
          const rm = this.deps.relationship!;
          const ref = String(args.member_ref);
          const partyId = ctx.members.get(ref);
          if (partyId === undefined) return { ok: false, code: 'UNKNOWN_REF', content: { error: 'UNKNOWN_REF', message: 'Use a member_ref returned by relationship_party_search.' } };
          const profile = await rm.profile(partyId, ctx);
          this.deps.onProfileView?.(partyId, ctx);
          if (def.operation === 'relationship.profile.get') return { ok: true, content: profileForModel(profile, ref), profile };
          if (def.operation === 'relationship.next_best_conversation') {
            const topics = rm.nextBestConversation(profile);
            return { ok: true, content: { topics: topics.map((t) => ({ topic_id: t.id, kind: t.kind, headline: t.headline, reason: t.reason, can_refer: Boolean(t.refer) })) }, profile, topics };
          }
          if (def.operation === 'predictive.scores.explain') {
            const explained = rm.explain(profile, args.score as 'attrition' | 'next_best');
            return { ok: true, content: explained, profile, explained };
          }
          const product = String(args.product);
          const s = profile.opportunities.find((o) => o.product.toLowerCase() === product.toLowerCase()) ?? profile.opportunities.find((o) => o.product.toLowerCase().includes(product.toLowerCase()));
          if (!s) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: `No active suggestion "${product}". Active: ${profile.opportunities.map((o) => o.product).join(', ') || 'none'}.` } };
          const payload: DeclinePayload = { partyId, suggestionId: s.suggestionId, product: s.product };
          const tier = effectiveTier(def, this.deps.tenantRaise);
          const approval = await this.deps.approvals.request({ operation: def.operation, payload, riskTier: tier === 'none' ? 'low' : tier, requestedBy: ctx.user.id, runId: ctx.runId, threadId: ctx.threadId });
          const superseded = await this.deps.approvals.supersede(ctx.threadId, approval.approvalId);
          const party = { partyId, name: profile.name, firstName: profile.firstName, branch: profile.branch, memberSince: profile.joined.slice(0, 4), last4: profile.last4, products: [] };
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, risk_tier: approval.riskTier, product: s.product, note: 'Nothing has been saved. The user approves on screen.' }, profile, decline: { approval, payload, party, superseded } };
        }
        case 'referral.route': {
          const p = await this.party(String(args.member_ref), ctx);
          if (!p) return { ok: false, code: 'UNKNOWN_REF', content: { error: 'UNKNOWN_REF', message: 'Use a member_ref returned by relationship_party_search.' } };
          const r = await this.deps.referrals.route(String(args.referral_type), p.partyId);
          return { ok: true, content: { to: r.queueName, next_in_rotation: r.assignee?.name ?? null, reason: r.reason } };
        }
        case 'referral.create': {
          const a = args as z.infer<typeof CreateInput>;
          const p = await this.party(a.member_ref, ctx);
          if (!p) return { ok: false, code: 'UNKNOWN_REF', content: { error: 'UNKNOWN_REF', message: 'Use a member_ref returned by relationship_party_search.' } };
          const type = await this.deps.referrals.type(a.referral_type);
          const check = await this.deps.referrals.check({ typeId: type.typeId, fields: a.fields });
          if (!check.ok) {
            return {
              ok: false,
              code: 'FORM_INCOMPLETE',
              content: { error: 'FORM_INCOMPLETE', errors: check.errors, missing: check.missing.map((f) => ({ field: f.id, label: f.label, options: f.options })) },
            };
          }
          const route = await this.deps.referrals.route(type.typeId, p.partyId);
          const payload: ReferralPayload = { typeId: type.typeId, partyId: p.partyId, fields: check.fields, notes: a.notes?.trim() || undefined, priority: a.priority, toQueueId: route.queueId };
          const tier = effectiveTier(def, this.deps.tenantRaise);
          const approval = await this.deps.approvals.request({ operation: def.operation, payload, riskTier: tier === 'none' ? 'low' : tier, requestedBy: ctx.user.id, runId: ctx.runId, threadId: ctx.threadId });
          const superseded = await this.deps.approvals.supersede(ctx.threadId, approval.approvalId);
          return {
            ok: true,
            content: { status: 'approval_required', approval_id: approval.approvalId, risk_tier: approval.riskTier, type: `${type.category} / ${type.label}`, member: p.name, to: route.queueName, next_in_rotation: route.assignee?.name ?? null, note: 'Nothing has been sent. The user approves on screen.' },
            draft: { approval, payload, route, party: p, superseded },
          };
        }
      }
      return { ok: false, code: 'UNKNOWN_TOOL', content: { error: 'UNKNOWN_TOOL' } };
    } catch (e) {
      if (e instanceof CoreError) return { ok: false, code: e.code === 'INVALID' ? 'FORM_INCOMPLETE' : e.code, content: { error: e.code, message: e.message } };
      throw e;
    }
  }

  /** Withdraws every pending draft in a thread, for "cancel" and "never mind". */
  withdraw(threadId: string) {
    return this.deps.approvals.supersede(threadId, '');
  }

  /** Records the user's decision; the approval service checks user, payload hash and expiry. */
  decide(approvalId: string, d: Parameters<ApprovalStore['decide']>[1]) {
    return this.deps.approvals.decide(approvalId, d);
  }

  /**
   * Runs an approved write. The stored payload is executed as approved; there is no model between
   * the approval and the action (spec 25.3, "no AI sits between the approval and the action").
   */
  async execute(approval: ApprovalRecord, ctx: Pick<GatewayContext, 'user' | 'purviewBranches'>): Promise<Executed> {
    if (approval.status !== 'approved') throw new Error(`Approval ${approval.approvalId} is ${approval.status}`);
    try {
      if (approval.operation === 'referral.create') {
        const created = await this.deps.referrals.create(approval.payload as ReferralPayload, { approvalId: approval.approvalId, runId: approval.runId, userId: ctx.user.id, userName: ctx.user.name }, ctx);
        await this.deps.approvals.markExecuted(approval.approvalId, `com:${created.comId}`);
        return { operation: 'referral.create', created };
      }
      if (approval.operation === 'referral.create.batch') {
        // One approval, several records: each has its own key, so a retry resumes rather than repeats.
        const created: Extract<Executed, { operation: 'referral.create.batch' }>['created'] = [];
        const failed: string[] = [];
        const { items } = approval.payload as BatchPayload;
        for (const [i, item] of items.entries()) {
          try {
            const c = await this.deps.referrals.create(item, { approvalId: `${approval.approvalId}.${i}`, runId: approval.runId, userId: ctx.user.id, userName: ctx.user.name }, ctx);
            created.push({ comId: c.comId, name: item.name, queueName: c.queueName, assignee: c.assignee?.name ?? null });
          } catch (e) {
            if (!(e instanceof CoreError)) throw e;
            failed.push(item.name);
          }
        }
        if (!created.length) throw new Error('No follow-up could be created.');
        await this.deps.approvals.markExecuted(approval.approvalId, `com:${created.map((c) => c.comId).join(',')}`.slice(0, 60));
        return { operation: 'referral.create.batch', created, failed };
      }
      if (approval.operation === 'relationship.suggestion.decline' && this.deps.relationship) {
        const p = approval.payload as DeclinePayload;
        const declined = await this.deps.relationship.decline(p, { approvalId: approval.approvalId, userId: ctx.user.id, userName: ctx.user.name }, ctx);
        await this.deps.approvals.markExecuted(approval.approvalId, `decline:${p.partyId}:${p.suggestionId}`);
        return { operation: 'relationship.suggestion.decline', declined, partyId: p.partyId };
      }
      throw new Error(`No executor for ${approval.operation}`);
    } catch (e) {
      await this.deps.approvals.markFailed(approval.approvalId);
      throw e;
    }
  }
}
