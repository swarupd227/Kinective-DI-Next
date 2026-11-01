// Tool registry and gateway for write-capable agents (spec 25). Every call is looked up, validated,
// stripped of reserved keys, resolved from reference tokens, authorised and tiered in code. A write
// never runs from a model call: it returns approval_required, and only an approved, unchanged
// payload is executed, once, with the approval ID as its idempotency key.
import { z } from 'zod';
import type { SemanticService } from '@dinext/semantic';
import { ApprovalStore, CoreError, PIPELINE_VIEWS, usd, type GoalsService, type GoalsWho, type PayoutBatch, type ScoreExplanation, type Scorecard, type ApprovalRecord, type AtRiskMember, type ChangeMeta, type InboxBox, type InboxDetail, type InboxItem, type MemberProfile, type ReferralStage, type PartyHit, type PipelineApplication, type PipelineFound, type PipelineService, type PipelineStatus, type PipelineSummary, type PipelineView, type PipelineWho, type ReferralService, type RelationshipService, type RiskTier, type RouteResult, type Topic } from '@dinext/di-core';

export type AgentId = 'referral' | 'relationship' | 'goal' | 'inbox' | 'pipeline' | 'incentives';

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
/** One card lists every task, so it stays short enough to read before approving. */
export const LAP_TASK_CAP = 10;
export const LAP_TASK_TYPE = 'loan_follow_up';

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

const referralId = z.number().int().positive().describe('The number of the referral, from referral_inbox_list');

export const INBOX_TOOLS = [
  { name: 'referral_inbox_list', operation: 'referral.inbox.list', description: 'List referrals. mine: open work assigned to the user. team: open work in their purview. sent: what they created. Overdue first.', input: z.object({ box: z.enum(['mine', 'team', 'sent']).default('mine'), older_than_days: z.number().int().min(0).max(365).optional(), overdue_only: z.boolean().default(false) }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'referrals', purviewScope: 'com', maxResultRowsToModel: 25, agents: ['inbox'] },
  { name: 'referral_get', operation: 'referral.get', description: 'One referral with its history and the people who can take it.', input: z.object({ referral_id: referralId }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'referrals', purviewScope: 'com', maxResultRowsToModel: 1, agents: ['inbox'] },
  { name: 'referral_stage_update', operation: 'referral.stage.update', description: 'Move a referral to Active, Sold or Not Interested. Sold can drive incentives. Returns approval_required.', input: z.object({ referral_id: referralId, stage: z.enum(['Active', 'Sold', 'Not Interested']), note: z.string().max(300).optional() }).strict(), sideEffect: 'write', riskTier: 'medium', requiredApp: 'referrals', purviewScope: 'com', maxResultRowsToModel: 1, agents: ['inbox'] },
  { name: 'referral_note_add', operation: 'referral.note.add', description: 'Add a note to a referral, such as "left voicemail". Returns approval_required.', input: z.object({ referral_id: referralId, note: z.string().min(2).max(300) }).strict(), sideEffect: 'write', riskTier: 'low', requiredApp: 'referrals', purviewScope: 'com', maxResultRowsToModel: 1, agents: ['inbox'] },
  { name: 'referral_reassign', operation: 'referral.reassign', description: 'Give a referral to someone else in its queue. Returns approval_required.', input: z.object({ referral_id: referralId, to: z.string().min(2).max(80).describe('The person\u2019s name, from referral_get') }).strict(), sideEffect: 'write', riskTier: 'medium', requiredApp: 'referrals', purviewScope: 'com', maxResultRowsToModel: 1, agents: ['inbox'] },
] satisfies ToolDef[];

const lapView = z.enum(PIPELINE_VIEWS).optional().describe('mine: their own. location: their branches. team: their lenders. institution: everyone. Omit for their default.');
const applicationId = z.number().int().positive().describe('The application number, from lap_applications_list');

/** Loan Pipeline agent tools (spec 24.18). Reading needs no approval; tasks and thresholds do. */
export const PIPELINE_TOOLS = [
  { name: 'lap_summary_get', operation: 'lap.summary.get', description: 'The funnel and pipeline by product: count, percent, dollars and average days per reporting group, with open and stalled totals.', input: z.object({ view: lapView }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'lap', purviewScope: 'report_viewer', maxResultRowsToModel: 20, agents: ['pipeline'] },
  { name: 'lap_applications_list', operation: 'lap.application.list', description: 'Find applications, stalled first, then longest in status. Open applications unless a finished group is named. Without Application Details access it returns counts and dollars only.', input: z.object({ view: lapView, status: z.string().max(40).optional().describe('Part of a status name, such as underwriting or counter offer'), group: z.string().max(40).optional().describe('A reporting group, such as Pending or Approved'), product: z.string().max(40).optional(), stalled_only: z.boolean().default(false), min_days: z.number().int().min(0).max(365).optional().describe('More than this many days in the current status'), min_amount: z.number().min(0).optional().describe('Over this amount'), waiting_on: z.string().max(40).optional().describe('Part of a hold reason or of who it is waiting on, such as appraisal, title, applicant or underwriter') }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'lap', purviewScope: 'report_viewer', maxResultRowsToModel: 25, agents: ['pipeline'] },
  { name: 'lap_application_get', operation: 'lap.application.get', description: 'One application with its path through the statuses and what it is waiting on, if the LOS records that. Needs Application Details access.', input: z.object({ application_id: applicationId }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'lap', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: ['pipeline'] },
  { name: 'lap_status_config_get', operation: 'lap.status_config.get', description: 'The institution’s statuses, reporting groups and stall thresholds.', input: z.object({}).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'lap', purviewScope: 'none', maxResultRowsToModel: 20, agents: ['pipeline'] },
  { name: 'lap_approval_rate_get', operation: 'lap.approval_rate.get', description: 'The approval rate from the semantic layer for the last two complete months, for one product or all.', input: z.object({ product: z.string().max(40).optional().describe('A loan category, such as Auto') }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'lap', purviewScope: 'report_viewer', maxResultRowsToModel: 2, agents: ['pipeline'] },
  { name: 'lap_follow_ups_create', operation: 'lap.task.create.batch', description: 'Prepare a follow-up task for each application’s owner. Staff tasks only: nobody outside the institution is contacted. Returns approval_required.', input: z.object({ application_ids: z.array(applicationId).min(1).max(LAP_TASK_CAP) }).strict(), sideEffect: 'write', riskTier: 'medium', requiredApp: 'lap', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: ['pipeline'] },
  { name: 'lap_threshold_set', operation: 'lap.threshold.set', description: 'Change a stall threshold for a status, or for one product in that status. Lending administrators only. Returns approval_required.', input: z.object({ status: z.string().min(2).max(40).describe('Part of a status name, such as underwriting'), product: z.string().max(40).optional(), days: z.number().int().min(1).max(90) }).strict(), sideEffect: 'write', riskTier: 'medium', requiredApp: 'lap', purviewScope: 'none', maxResultRowsToModel: 1, agents: ['pipeline'] },
] satisfies ToolDef[];

const giEmployee = z.string().min(2).max(80).optional().describe('A person’s name. Omit for the user’s own.');
const giBranch = z.string().min(2).max(40);

/** Goals & Incentives agent tools (spec 24.17). Reading needs no approval; payouts are high risk. */
export const GI_TOOLS = [
  { name: 'gi_scorecard_get', operation: 'gi.scorecard.get', description: 'A person’s goals for the period: actual, target, percent of goal, what they have earned and what the next tier takes. Shows only goals they are eligible for.', input: z.object({ employee: giEmployee }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'gi', purviewScope: 'report_viewer', maxResultRowsToModel: 8, agents: ['incentives'] },
  { name: 'gi_team_get', operation: 'gi.team.get', description: 'Scorecards for a branch team, those behind first. Managers only.', input: z.object({ branch: giBranch.optional() }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'gi', purviewScope: 'report_viewer', maxResultRowsToModel: 25, agents: ['incentives'] },
  { name: 'gi_score_explain', operation: 'gi.score.explain', description: 'How an incentive was worked out: its rule, the records that counted, those still active, and where the target came from.', input: z.object({ goal: z.string().max(40).optional().describe('Part of a goal or incentive name, such as referrals'), employee: giEmployee }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'gi', purviewScope: 'report_viewer', maxResultRowsToModel: 25, agents: ['incentives'] },
  { name: 'gi_payouts_list', operation: 'gi.incentive.list_pending', description: 'Payouts waiting for approval: each person in a branch, or each branch. Needs Approve Incentives.', input: z.object({ branch: giBranch.optional() }).strict(), sideEffect: 'read', riskTier: 'none', requiredApp: 'gi', purviewScope: 'report_viewer', maxResultRowsToModel: 25, agents: ['incentives'] },
  { name: 'gi_adjustment_prepare', operation: 'gi.adjustment.create', description: 'Prepare an adjustment to someone’s payout, up or down. It needs a reason code, and a different person reviews it before it counts. Returns approval_required.', input: z.object({ employee: z.string().min(2).max(80), amount: z.number().min(-5000).max(5000).describe('Dollars, negative to reduce'), reason_code: z.string().max(24).optional().describe('MISSED-CREDIT, LATE-FUNDING, CORRECTION or MANAGER-DISCRETION. Leave it out if the user gave none; never pick one for them.'), note: z.string().max(160).optional() }).strict(), sideEffect: 'write', riskTier: 'high', requiredApp: 'gi', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: ['incentives'] },
  { name: 'gi_adjustment_review_prepare', operation: 'gi.adjustment.review', description: 'Prepare a decision on someone’s adjustment that is waiting for review. Its creator can’t review it. Returns approval_required.', input: z.object({ employee: z.string().min(2).max(80), decision: z.enum(['approve', 'reject']) }).strict(), sideEffect: 'write', riskTier: 'high', requiredApp: 'gi', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: ['incentives'] },
  { name: 'gi_payout_decision_prepare', operation: 'gi.incentive.decide', description: 'Prepare a denial of one person’s payout, or send it back to be fixed. A note is required. A denial is final for the period; a returned payout can be approved later. Returns approval_required.', input: z.object({ employee: z.string().min(2).max(80), decision: z.enum(['deny', 'return']), note: z.string().max(200).optional().describe('Why, in the user’s words. Leave it out if they gave none.') }).strict(), sideEffect: 'write', riskTier: 'high', requiredApp: 'gi', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: ['incentives'] },
  { name: 'gi_team_note_prepare', operation: 'gi.team.note', description: 'Prepare a short note to each person behind on goals, written from their scorecard. Delivery is simulated in this demo. Returns approval_required.', input: z.object({ branch: giBranch.optional() }).strict(), sideEffect: 'write', riskTier: 'medium', requiredApp: 'gi', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: ['incentives'] },
  { name: 'gi_payouts_prepare', operation: 'gi.incentive.approve', description: 'Prepare a branch’s waiting payouts for approval as one batch, leaving out anyone named. The user’s own payout is always left out. Returns approval_required.', input: z.object({ branch: giBranch, exclude: z.array(z.string().min(2).max(80)).max(10).optional().describe('Names to leave out of this batch') }).strict(), sideEffect: 'write', riskTier: 'high', requiredApp: 'gi', purviewScope: 'report_viewer', maxResultRowsToModel: 1, agents: ['incentives'] },
] satisfies ToolDef[];

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
  /** The staff record behind the user, when they work a queue themselves. */
  employeeId?: number;
  /** Loan Pipeline access from the module matrix; absent means totals only. */
  lap?: { details: boolean; leads?: boolean; admin?: boolean };
  /** Goals & Incentives access from the module matrix. */
  gi?: { leads?: boolean; approves?: boolean };
}

export interface ReferralPayload {
  typeId: string;
  assigneeEmployeeId?: number;
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

export interface ChangePayload {
  comId: number;
  stage?: ReferralStage;
  note?: string;
  employeeId?: number;
  to?: string;
}

export interface ChangeDraft {
  approval: ApprovalRecord;
  payload: ChangePayload;
  item: InboxDetail;
  superseded: string[];
}

export interface LapRate {
  product?: string;
  definition: string;
  periods: { period: string; rate: number | null }[];
}

export interface LapTaskPayload {
  items: (ReferralPayload & { applicationId: number; label: string; to: string; reason: string; branch: string })[];
}

export interface LapTaskDraft {
  approval: ApprovalRecord;
  payload: LapTaskPayload;
  /** Asked for, but already holding an open task. */
  skipped: string[];
  superseded: string[];
}

export interface ThresholdPayload {
  code: string;
  label: string;
  product?: string;
  days: number;
  before: number | null;
}

export interface ThresholdDraft {
  approval: ApprovalRecord;
  payload: ThresholdPayload;
  superseded: string[];
}

export interface GiPayoutPayload {
  periodEnd: string;
  period: string;
  branch: string;
  total: number;
  lines: { employeeId: number; name: string; amount: number; incentives: string; adjustments: string; flags: string }[];
  excluded: { name: string; why: string }[];
}

export interface GiPayoutDraft {
  approval: ApprovalRecord;
  payload: GiPayoutPayload;
  /** What the card covers and leaves out, written by code. */
  text: string;
  superseded: string[];
}

/** A single change on a card: what it does, and code's own sentence for when it's done. */
export interface GiChange {
  operation: string;
  summary: string;
  changes: { label: string; before: string; after: string }[];
  /** The card's first line, and what's said once it's done. */
  text: string;
  done: string;
  apply: Record<string, unknown>;
  /** Notes to people, with who each goes to. */
  notes?: { employeeId: number; name: string; text: string }[];
}

export interface GiChangeDraft {
  approval: ApprovalRecord;
  payload: GiChange;
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
  | { ok: true; content: unknown; draft?: DraftResult; decline?: DeclineDraft; batch?: BatchDraft; inbox?: InboxItem[]; item?: InboxDetail; change?: ChangeDraft; summary?: PipelineSummary; found?: PipelineFound; application?: PipelineApplication & { history: { status: string; at: string }[]; asOf: string; stale: boolean }; statuses?: PipelineStatus[]; rate?: LapRate; tasks?: LapTaskDraft; threshold?: ThresholdDraft; atRisk?: { total: number; items: (AtRiskMember & { ref: string; followedUp: boolean })[] }; hits?: (PartyHit & { matchedOn?: string })[]; profile?: MemberProfile; topics?: Topic[]; explained?: ReturnType<RelationshipService['explain']>; scorecard?: Scorecard; team?: Scorecard[]; explanation?: ScoreExplanation; batch2?: PayoutBatch; batches?: PayoutBatch[]; payouts?: GiPayoutDraft; giChange?: GiChangeDraft }
  | { ok: false; code: 'UNKNOWN_TOOL' | 'NOT_ALLOWED' | 'INVALID_INPUT' | 'RESERVED_KEY' | 'UNKNOWN_REF' | 'NO_ACCESS' | 'NOT_FOUND' | 'FORM_INCOMPLETE'; content: unknown };

interface BatchDone {
  created: { comId: number; name: string; queueName: string; assignee: string | null; assigneeId?: number; branch: string }[];
  failed: string[];
}

export type Executed = { operation: 'referral.create'; created: Awaited<ReturnType<ReferralService['create']>> } | { operation: 'referral.change'; item: InboxDetail; kind: 'stage' | 'note' | 'assign'; changed: boolean } | ({ operation: 'referral.create.batch' } & BatchDone) | ({ operation: 'lap.task.create.batch' } & BatchDone) | { operation: 'lap.threshold.set'; label: string; product?: string; days: number } | { operation: 'relationship.suggestion.decline'; declined: { product: string; until: string }; partyId: number } | { operation: 'gi.incentive.approve'; payload: GiPayoutPayload; replayed: boolean } | { operation: 'gi.change'; payload: GiChange };

const round = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n / 100) * 100 : Math.round(n));

/** What the model sees of a profile: enough to write talking points, with identifiers masked. */
/** Lowercases a label for mid-sentence, leaving acronyms such as HELOC alone. */
export const midSentence = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** A status as it reads after "12 days": "in underwriting", "at counter offer". */
export const inStatus = (status: string) => (/^(In|Waiting)\b/.test(status) ? midSentence(status) : `at ${midSentence(status)}`);

const giWho = (ctx: Pick<GatewayContext, 'employeeId' | 'gi'>): GoalsWho => ({ employeeId: ctx.employeeId, leads: ctx.gi?.leads, approves: ctx.gi?.approves });

const lapWho = (ctx: Pick<GatewayContext, 'employeeId' | 'lap'>): PipelineWho => ({ employeeId: ctx.employeeId, leads: ctx.lap?.leads, details: Boolean(ctx.lap?.details) });

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
      pipeline?: PipelineService;
      goals?: GoalsService;
      semantic?: SemanticService | null;
      tenantRaise?: Partial<Record<string, RiskTier>>;
      /** Called for every member record opened through a tool; the access is audited (FE-RM-003). */
      onProfileView?: (partyId: number, ctx: GatewayContext) => void;
    },
    private readonly tools: ToolDef[] = [...REFERRAL_TOOLS, ...RELATIONSHIP_TOOLS, ...INBOX_TOOLS, ...PIPELINE_TOOLS, ...GI_TOOLS],
  ) {}

  get relationship() {
    return this.deps.relationship ?? null;
  }

  /** Tools the model may see for this user and agent (AI-ARC-021). */
  visible(ctx: GatewayContext, agent: AgentId = 'referral') {
    const apps = (t: ToolDef) => (Array.isArray(t.requiredApp) ? t.requiredApp : [t.requiredApp]);
    return this.tools.filter((t) => (t.agents ?? ['referral']).includes(agent) && apps(t).some((a) => ctx.apps.includes(a)) && (t.operation.startsWith('gi.') ? this.deps.goals : t.operation.startsWith('lap.') ? this.deps.pipeline : t.operation.startsWith('referral.') || t.operation === 'relationship.party.search' || this.deps.relationship));
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

  /** Stores a change for approval. Nothing happens until it's approved on screen. */
  private async giDraft(def: ToolDef, ctx: GatewayContext, payload: GiChange): Promise<GatewayResult> {
    const tier = effectiveTier(def, this.deps.tenantRaise);
    const approval = await this.deps.approvals.request({ operation: def.operation, payload, riskTier: tier === 'none' ? 'low' : tier, requestedBy: ctx.user.id, runId: ctx.runId, threadId: ctx.threadId });
    const superseded = await this.deps.approvals.supersede(ctx.threadId, approval.approvalId);
    return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, note: 'Nothing has changed. The user approves on screen.' }, giChange: { approval, payload, superseded } };
  }

  /** The view asked for. "My" from someone with no applications of their own means their default. */
  private async lapView(view: unknown, ctx: GatewayContext): Promise<PipelineView> {
    const offered = await this.deps.pipeline!.views(lapWho(ctx), ctx);
    if (!offered.length) throw new CoreError('NO_ACCESS', 'No pipeline view is available to you.');
    return view && (view !== 'mine' || offered.includes('mine')) ? (view as PipelineView) : offered[0]!;
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
        case 'gi.scorecard.get': {
          const scorecard = await this.deps.goals!.scorecard(args.employee as string | undefined, giWho(ctx), ctx);
          return { ok: true, content: { employee: scorecard.name, period: scorecard.period, total_earned: scorecard.total, qualified: scorecard.qualified, goals: scorecard.goals.map((g) => ({ goal: g.name, actual: g.actual, target: g.target, percent: g.pct, earned: g.earned, active: g.pending, next_tier: g.next })) }, scorecard };
        }
        case 'gi.team.get': {
          const team = await this.deps.goals!.team(args.branch as string | undefined, giWho(ctx), ctx);
          return { ok: true, content: { period: team[0]?.period, people: team.map((c) => ({ name: c.name, role: c.role, behind: c.behind, earned: c.total, goals: c.goals.map((g) => ({ goal: g.name, percent: g.pct })) })) }, team };
        }
        case 'gi.score.explain': {
          const explanation = await this.deps.goals!.explain(args.goal as string | undefined, args.employee as string | undefined, giWho(ctx), ctx);
          return { ok: true, content: { incentive: explanation.score.rule?.name, rule: explanation.rule, actual: explanation.score.actual, target: explanation.score.target, earned: explanation.score.earned, target_from: explanation.score.targetFrom, records: explanation.records.length }, explanation };
        }
        case 'gi.incentive.list_pending': {
          if (args.branch) {
            const b = await this.deps.goals!.batch(String(args.branch), giWho(ctx), ctx);
            return { ok: true, content: { period: b.period, branch: b.branch, waiting: b.waiting, total: b.total, people: b.lines.map((l) => ({ name: l.name, amount: l.amount, status: l.status, flags: l.flags })) }, batch2: b };
          }
          const batches = await this.deps.goals!.batches(giWho(ctx), ctx);
          return { ok: true, content: { period: batches[0]?.period, branches: batches.map((b) => ({ branch: b.branch, waiting: b.waiting, total: b.total, flagged: b.flagged })) }, batches };
        }
        case 'gi.adjustment.create': {
          const a = await this.deps.goals!.prepareAdjustment(String(args.employee), Number(args.amount), args.reason_code as string | undefined, args.note as string | undefined, giWho(ctx), ctx);
          const sign = a.amount < 0 ? `−${usd(-a.amount)}` : `+${usd(a.amount)}`;
          return this.giDraft(def, ctx, { operation: def.operation, summary: `Adjust ${a.name}’s ${a.period} payout by ${sign} (${a.reasonCode})`, changes: [{ label: `${a.name}, ${a.branch}`, before: usd(a.before), after: `${usd(a.before + a.amount)} once reviewed` }, { label: 'Reason', before: '—', after: `${a.reasonCode}: ${a.note}` }], text: `I’ve prepared a ${sign} adjustment for **${a.name}** with reason code ${a.reasonCode}. Someone else has to review it before it counts.`, done: `Created the ${sign} adjustment for **${a.name}**. It’s waiting for review by someone other than you, and doesn’t count until then.`, apply: a });
        }
        case 'gi.adjustment.review': {
          const decision = args.decision === 'approve' ? 'Approved' : 'Rejected';
          const r = await this.deps.goals!.prepareReview(String(args.employee), decision, ctx.user.id, giWho(ctx), ctx);
          const verb = decision === 'Approved' ? 'Approve' : 'Reject';
          return this.giDraft(def, ctx, { operation: def.operation, summary: `${verb} the ${usd(r.amount)} adjustment for ${r.name} (${r.reasonCode})`, changes: [{ label: `${r.name}’s ${r.period} payout`, before: usd(r.before), after: usd(decision === 'Approved' ? r.before + r.amount : r.before) }, { label: 'Reason', before: '—', after: `${r.reasonCode}: ${r.note}` }], text: `I’ve prepared your review of **${r.name}**’s ${usd(r.amount)} adjustment.`, done: decision === 'Approved' ? `Approved the adjustment. **${r.name}**’s payout is now ${usd(r.before + r.amount)}.` : `Rejected the adjustment. **${r.name}**’s payout stays at ${usd(r.before)}.`, apply: r });
        }
        case 'gi.incentive.decide': {
          const decision = args.decision === 'deny' ? 'Denied' : 'Returned';
          const d = await this.deps.goals!.prepareDecision(String(args.employee), decision, args.note as string | undefined, giWho(ctx), ctx);
          const label = decision === 'Denied' ? 'Deny' : 'Send back';
          return this.giDraft(def, ctx, { operation: def.operation, summary: `${label} ${d.name}’s ${d.period} payout of ${usd(d.amount)}`, changes: [{ label: `${d.name}, ${d.branch}`, before: `${usd(d.amount)} waiting`, after: decision === 'Denied' ? 'Denied for the period' : 'Sent back to be fixed' }, { label: 'Note', before: '—', after: d.note }], text: `I’ve prepared ${decision === 'Denied' ? 'a denial of' : 'a return of'} **${d.name}**’s payout.`, done: decision === 'Denied' ? `Denied **${d.name}**’s ${d.period} payout. It’s recorded with your note.` : `Sent **${d.name}**’s payout back with your note. It stays waiting and can be approved once it’s fixed.`, apply: d });
        }
        case 'gi.team.note': {
          const team = await this.deps.goals!.team(args.branch as string | undefined, giWho(ctx), ctx);
          const notes = team.filter((c) => c.behind && c.employeeId !== ctx.employeeId).map((c) => {
            const g = c.goals.filter((x) => !x.qualifier).sort((a, b) => a.pct - b.pct)[0];
            return { employeeId: c.employeeId, name: c.name, text: g && g.pct < 100 ? `${c.period}: ${g.name} is at ${g.pct}% of goal. Let’s talk about what would help.` : `${c.period}: your member survey score is under the level that incentives need. Let’s talk about it.` };
          });
          if (!notes.length) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: 'Nobody on the team is behind, so there’s nothing to send.' } };
          return this.giDraft(def, ctx, { operation: def.operation, summary: `Send a note to ${notes.length} ${notes.length === 1 ? 'person' : 'people'} behind on goals`, changes: notes.slice(0, 8).map((n) => ({ label: n.name, before: '—', after: n.text })), text: `I’ve drafted a note to ${notes.length === 1 ? 'one person' : `${notes.length} people`} behind on goals.`, done: `Sent ${notes.length === 1 ? 'the note' : `${notes.length} notes`}. They appear in each person’s bell. Delivery is simulated in this demo.`, apply: {}, notes });
        }
        case 'gi.incentive.approve': {
          const b = await this.deps.goals!.batch(String(args.branch), giWho(ctx), ctx);
          const names = ((args.exclude as string[] | undefined) ?? []).map((n) => n.toLowerCase());
          const named = (name: string) => names.some((n) => n.split(/\s+/).every((w) => name.toLowerCase().replace(/\./g, '').includes(w.replace(/\./g, ''))));
          const missed = ((args.exclude as string[] | undefined) ?? []).filter((n) => !b.lines.some((l) => named(l.name) && n.toLowerCase().split(/\s+/).every((w) => l.name.toLowerCase().replace(/\./g, '').includes(w.replace(/\./g, '')))));
          if (missed.length) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: `There’s nobody called ${missed.join(' or ')} in ${b.branch}’s payouts, so I haven’t prepared anything.` } };
          const open = b.lines.filter((l) => !l.status);
          const excluded = [...open.filter((l) => l.own).map((l) => ({ name: l.name, why: 'your own payout' })), ...open.filter((l) => !l.own && named(l.name)).map((l) => ({ name: l.name, why: 'you asked to leave them out' }))];
          const going = open.filter((l) => !l.own && !named(l.name) && l.amount > 0);
          const nil = open.filter((l) => !l.own && !named(l.name) && l.amount <= 0);
          if (!going.length) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: `Nothing is waiting for you to approve in ${b.branch}.` } };
          const total = Math.round(going.reduce((n, l) => n + l.amount, 0) * 100) / 100;
          const payload: GiPayoutPayload = { periodEnd: b.periodEnd, period: b.period, branch: b.branch, total, lines: going.map((l) => ({ employeeId: l.employeeId, name: l.name, amount: l.amount, incentives: l.incentives.slice(0, 120), adjustments: l.adjustments.map((a) => `${usd(a.amount)} ${a.reasonCode}`).join(', '), flags: l.flags.join('; ').slice(0, 160) })), excluded: [...excluded, ...nil.map((l) => ({ name: l.name, why: l.flags[0] ?? 'nothing earned' }))] };
          const tier = effectiveTier(def, this.deps.tenantRaise);
          const approval = await this.deps.approvals.request({ operation: def.operation, payload, riskTier: tier === 'none' ? 'low' : tier, requestedBy: ctx.user.id, runId: ctx.runId, threadId: ctx.threadId });
          const superseded = await this.deps.approvals.supersede(ctx.threadId, approval.approvalId);
          const text = `I’ve prepared the ${b.period} payouts for **${b.branch}**: ${going.length} ${going.length === 1 ? 'person' : 'people'}, **${usd(total)}**.${payload.excluded.length ? ` Left out: ${payload.excluded.map((x) => `${x.name} (${x.why})`).join('; ')}.` : ''}`;
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, people: going.length, total, left_out: payload.excluded, note: 'Nothing is approved. The user types the total on screen.' }, payouts: { approval, payload, text, superseded } };
        }
        case 'lap.summary.get': {
          const summary = await this.deps.pipeline!.summary(await this.lapView(args.view, ctx), lapWho(ctx), ctx);
          return { ok: true, content: { view: summary.view, as_of_los_load: summary.asOf, los_feed_missing_from_last_build: summary.stale, open: summary.open, stalled: summary.stalled, funnel: summary.funnel, products: summary.products.map((p) => ({ product: p.product, ...p.total })) }, summary };
        }
        case 'lap.application.list': {
          const found = await this.deps.pipeline!.find({ view: await this.lapView(args.view, ctx), status: args.status as string | undefined, group: args.group as string | undefined, product: args.product as string | undefined, stalledOnly: Boolean(args.stalled_only), minDays: args.min_days as number | undefined, minAmount: args.min_amount as number | undefined, waitingOn: args.waiting_on as string | undefined }, lapWho(ctx), ctx);
          return { ok: true, content: { as_of_los_load: found.asOf, los_feed_missing_from_last_build: found.stale, count: found.count, dollars: found.dollars, oldest_days: found.oldestDays, by_product: found.byProduct, waiting_on: found.holds, details_hidden: found.detailsHidden, applications: found.items.slice(0, 25).map((a) => ({ application_id: a.applicationId, applicant: a.lastName, product: a.product, amount: a.amount, status: a.status, days_in_status: a.daysInStatus, threshold_days: a.threshold, stalled: a.stalled, owner: a.owner?.name ?? null, branch: a.branch, hold: a.hold?.label ?? null })) }, found };
        }
        case 'lap.application.get': {
          const a = await this.deps.pipeline!.application(Number(args.application_id), lapWho(ctx), ctx);
          return { ok: true, content: { application_id: a.applicationId, applicant: a.lastName, product: a.product, amount: a.amount, status: a.status, days_in_status: a.daysInStatus, threshold_days: a.threshold, stalled: a.stalled, owner: a.owner?.name ?? null, branch: a.branch, applied: a.applied, history: a.history, hold: a.hold, as_of_los_load: a.asOf }, application: a };
        }
        case 'lap.status_config.get': {
          const statuses = await this.deps.pipeline!.statuses();
          return { ok: true, content: { statuses: statuses.filter((s) => s.visible).map((s) => ({ status: s.label, group: s.group, in_progress: s.inProgress, stall_days: s.stallDays, by_product: s.products })) }, statuses };
        }
        case 'lap.approval_rate.get': {
          const semantic = this.deps.semantic;
          if (!semantic) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: 'The approval rate isn’t available here.' } };
          const asked = args.product ? String(args.product).toLowerCase() : undefined;
          const category = asked ? (semantic.dimensionValues.loan_category ?? []).find((c) => c.toLowerCase().includes(asked) || asked.includes(c.toLowerCase())) : undefined;
          if (asked && !category) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: `There is no loan category called “${String(args.product)}”.` } };
          const result = await semantic.query({ metrics: ['approval_rate'], filters: category ? [{ dimension: 'loan_category', op: 'in', values: [category] }] : [], time: { grain: 'month', last: 2 } }, { purviewBranches: ctx.purviewBranches, canViewSql: false });
          const rate: LapRate = { product: category, definition: semantic.definition('approval_rate').description, periods: result.rows.map((r) => ({ period: String(r.period), rate: (r.approval_rate as number | null) ?? null })) };
          return { ok: true, content: { product: category ?? 'All', periods: rate.periods, definition: rate.definition }, rate };
        }
        case 'lap.task.create.batch': {
          const pipeline = this.deps.pipeline!;
          const a = args as { application_ids: number[] };
          if (!ctx.lap?.details) return { ok: false, code: 'NOT_ALLOWED', content: { error: 'NOT_ALLOWED', message: 'Your access shows pipeline totals, so you can’t create tasks for individual applications.' } };
          const apps = await Promise.all(a.application_ids.map((id) => pipeline.application(id, lapWho(ctx), ctx)));
          const open = await this.deps.referrals.openFor(LAP_TASK_TYPE, apps.map((x) => x.partyId));
          const items: LapTaskPayload['items'] = [];
          const skipped: string[] = [];
          for (const x of apps) {
            if (open.has(x.partyId) || !x.owner) {
              skipped.push(`#${x.applicationId}`);
              continue;
            }
            const route = await this.deps.referrals.route(LAP_TASK_TYPE, x.partyId);
            const reason = `${x.hold ? `${x.hold.label}. ` : ''}${x.daysInStatus} days ${inStatus(x.status)}${x.threshold !== null ? `, threshold ${x.threshold}` : ''}`;
            items.push({ typeId: LAP_TASK_TYPE, partyId: x.partyId, assigneeEmployeeId: x.owner.employeeId, fields: { application_id: String(x.applicationId) }, notes: `Application #${x.applicationId}, ${x.product}: ${reason}, as of the last LOS load. ${x.hold?.nextStep ?? 'Check what’s holding it.'}`, priority: x.stalled ? 'High' : 'Normal', toQueueId: route.queueId, applicationId: x.applicationId, label: `#${x.applicationId} ${x.lastName}, ${x.product}`, to: x.owner.name, reason, branch: x.branch });
          }
          if (!items.length) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: 'Those applications already have an open follow-up task.', skipped } };
          const payload: LapTaskPayload = { items };
          const tier = effectiveTier(def, this.deps.tenantRaise);
          const approval = await this.deps.approvals.request({ operation: def.operation, payload, riskTier: tier === 'none' ? 'low' : tier, requestedBy: ctx.user.id, runId: ctx.runId, threadId: ctx.threadId });
          const superseded = await this.deps.approvals.supersede(ctx.threadId, approval.approvalId);
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, tasks: items.length, already_open: skipped, note: 'Nothing has been created. The user approves on screen.' }, tasks: { approval, payload, skipped, superseded } };
        }
        case 'lap.threshold.set': {
          const pipeline = this.deps.pipeline!;
          if (!ctx.lap?.admin) return { ok: false, code: 'NOT_ALLOWED', content: { error: 'NOT_ALLOWED', message: 'Only a lending administrator can change a stall threshold.' } };
          const asked = String(args.status).toLowerCase();
          const statuses = (await pipeline.statuses()).filter((s) => s.inProgress);
          const status = statuses.find((s) => s.label.toLowerCase().includes(asked));
          if (!status) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: `Stall thresholds apply to: ${statuses.map((s) => s.label).join(', ')}.` } };
          const named = args.product ? String(args.product).toLowerCase() : undefined;
          const product = named ? (await pipeline.products()).find((p) => p.toLowerCase().includes(named)) : undefined;
          if (named && !product) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: `There is no product called “${String(args.product)}”.` } };
          const payload: ThresholdPayload = { code: status.code, label: status.label, product, days: Number(args.days), before: status.products.find((p) => p.product === product)?.days ?? status.stallDays };
          const tier = effectiveTier(def, this.deps.tenantRaise);
          const approval = await this.deps.approvals.request({ operation: def.operation, payload, riskTier: tier === 'none' ? 'low' : tier, requestedBy: ctx.user.id, runId: ctx.runId, threadId: ctx.threadId });
          const superseded = await this.deps.approvals.supersede(ctx.threadId, approval.approvalId);
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, note: 'Nothing has changed. The user approves on screen.' }, threshold: { approval, payload, superseded } };
        }
        case 'referral.inbox.list': {
          const who = { userId: ctx.user.id, employeeId: ctx.employeeId };
          let items = await this.deps.referrals.inbox(args.box as InboxBox, who, ctx);
          if (args.older_than_days !== undefined) items = items.filter((i) => i.ageDays > Number(args.older_than_days));
          if (args.overdue_only) items = items.filter((i) => i.overdue);
          return { ok: true, content: { count: items.length, overdue: items.filter((i) => i.overdue).length, referrals: items.slice(0, 25).map((i) => ({ referral_id: i.comId, member: i.name, type: i.typeLabel, branch: i.branch, stage: i.stage, priority: i.priority, age_days: i.ageDays, overdue: i.overdue, assignee: i.assignee?.name ?? null })) }, inbox: items };
        }
        case 'referral.get': {
          const item = await this.deps.referrals.item(Number(args.referral_id), { userId: ctx.user.id }, ctx);
          return { ok: true, content: { referral_id: item.comId, member: item.name, type: item.typeLabel, stage: item.stage, priority: item.priority, age_days: item.ageDays, overdue: item.overdue, assignee: item.assignee?.name ?? null, notes: item.notes, history: item.history.slice(-8).map((h) => h.text), team: item.team.map((m) => m.name) }, item };
        }
        case 'referral.stage.update':
        case 'referral.note.add':
        case 'referral.reassign': {
          const item = await this.deps.referrals.item(Number(args.referral_id), { userId: ctx.user.id }, ctx);
          if (ctx.purviewBranches && !ctx.purviewBranches.includes(item.branch)) return { ok: false, code: 'NO_ACCESS', content: { error: 'NO_ACCESS', message: `Referral #${item.comId} is outside your purview.` } };
          const payload: ChangePayload = { comId: item.comId };
          if (def.operation === 'referral.stage.update') {
            payload.stage = args.stage as ReferralStage;
            if (args.note) payload.note = String(args.note);
            if (item.stage === payload.stage || (item.stage !== 'New Referral' && item.stage !== 'Active')) return { ok: false, code: 'NOT_ALLOWED', content: { error: 'NOT_ALLOWED', message: `Referral #${item.comId} is already ${item.stage}.` } };
          } else if (def.operation === 'referral.note.add') {
            payload.note = String(args.note);
          } else {
            const name = String(args.to).toLowerCase();
            const to = item.team.find((m) => m.name.toLowerCase().includes(name) || name.includes(m.name.toLowerCase()));
            if (!to) return { ok: false, code: 'NOT_FOUND', content: { error: 'NOT_FOUND', message: `${item.queueName} is worked by ${item.team.map((m) => m.name).join(', ') || 'nobody yet'}.` } };
            payload.employeeId = to.employeeId;
            payload.to = to.name;
          }
          const tier = effectiveTier(def, this.deps.tenantRaise);
          const approval = await this.deps.approvals.request({ operation: def.operation, payload, riskTier: tier === 'none' ? 'low' : tier, requestedBy: ctx.user.id, runId: ctx.runId, threadId: ctx.threadId });
          const superseded = await this.deps.approvals.supersede(ctx.threadId, approval.approvalId);
          return { ok: true, content: { status: 'approval_required', approval_id: approval.approvalId, note: 'Nothing has changed. The user approves on screen.' }, change: { approval, payload, item, superseded } };
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
  async execute(approval: ApprovalRecord, ctx: Pick<GatewayContext, 'user' | 'purviewBranches' | 'employeeId' | 'lap' | 'gi'>): Promise<Executed> {
    if (approval.status !== 'approved') throw new Error(`Approval ${approval.approvalId} is ${approval.status}`);
    try {
      if (approval.operation === 'gi.incentive.approve') {
        const payload = approval.payload as GiPayoutPayload;
        const { replayed } = await this.deps.goals!.approve(payload, { approvalId: approval.approvalId, userId: ctx.user.id }, giWho(ctx), ctx);
        await this.deps.approvals.markExecuted(approval.approvalId, `gi:${payload.periodEnd}:${payload.branch}`.slice(0, 40));
        return { operation: 'gi.incentive.approve', payload, replayed };
      }
      if (approval.operation.startsWith('gi.')) {
        const payload = approval.payload as GiChange;
        const meta = { approvalId: approval.approvalId, userId: ctx.user.id };
        const goals = this.deps.goals!;
        if (approval.operation === 'gi.adjustment.create') await goals.createAdjustment(payload.apply as never, meta);
        if (approval.operation === 'gi.adjustment.review') await goals.reviewAdjustment(payload.apply as never, meta);
        if (approval.operation === 'gi.incentive.decide') await goals.recordDecision(payload.apply as never, meta, giWho(ctx), ctx);
        await this.deps.approvals.markExecuted(approval.approvalId, approval.operation.slice(0, 40));
        return { operation: 'gi.change', payload };
      }
      if (approval.operation === 'referral.create') {
        const created = await this.deps.referrals.create(approval.payload as ReferralPayload, { approvalId: approval.approvalId, runId: approval.runId, userId: ctx.user.id, userName: ctx.user.name }, ctx);
        await this.deps.approvals.markExecuted(approval.approvalId, `com:${created.comId}`);
        return { operation: 'referral.create', created };
      }
      if (approval.operation.startsWith('referral.') && approval.operation !== 'referral.create.batch') {
        const p = approval.payload as ChangePayload;
        const meta: ChangeMeta = { userId: ctx.user.id, userName: ctx.user.name, employeeId: ctx.employeeId };
        let out: Extract<Executed, { operation: 'referral.change' }>;
        if (approval.operation === 'referral.stage.update') {
          const r = await this.deps.referrals.transition(p.comId, p.stage!, p.note, meta, ctx);
          out = { operation: 'referral.change', item: r.item, kind: 'stage', changed: r.changed };
        } else if (approval.operation === 'referral.note.add') {
          out = { operation: 'referral.change', item: await this.deps.referrals.addNote(p.comId, p.note!, meta, ctx), kind: 'note', changed: true };
        } else {
          out = { operation: 'referral.change', item: await this.deps.referrals.reassign(p.comId, p.employeeId!, meta, ctx), kind: 'assign', changed: true };
        }
        await this.deps.approvals.markExecuted(approval.approvalId, `com:${p.comId}`);
        return out;
      }
      if (approval.operation === 'lap.threshold.set' && this.deps.pipeline) {
        const p = approval.payload as ThresholdPayload;
        if (!ctx.lap?.admin) throw new CoreError('NO_ACCESS', 'Only a lending administrator can change a stall threshold.');
        await this.deps.pipeline.setThreshold(p, { userId: ctx.user.id });
        await this.deps.approvals.markExecuted(approval.approvalId, `threshold:${p.code}`.slice(0, 40));
        return { operation: 'lap.threshold.set', label: p.label, product: p.product, days: p.days };
      }
      if (approval.operation === 'referral.create.batch' || approval.operation === 'lap.task.create.batch') {
        // One approval, several records: each has its own key, so a retry resumes rather than repeats.
        const created: BatchDone['created'] = [];
        const failed: string[] = [];
        const items = (approval.payload as BatchPayload | LapTaskPayload).items.map((i) => ({ ...i, name: 'label' in i ? i.label : i.name }));
        for (const [i, item] of items.entries()) {
          try {
            const c = await this.deps.referrals.create(item, { approvalId: `${approval.approvalId}.${i}`, runId: approval.runId, userId: ctx.user.id, userName: ctx.user.name }, ctx);
            created.push({ comId: c.comId, name: item.name, queueName: c.queueName, assignee: c.assignee?.name ?? null, assigneeId: c.assignee?.employeeId, branch: item.branch });
          } catch (e) {
            if (!(e instanceof CoreError)) throw e;
            failed.push(item.name);
          }
        }
        if (!created.length) throw new Error('No follow-up could be created.');
        await this.deps.approvals.markExecuted(approval.approvalId, `com:${created.map((c) => c.comId).join(',')}`.slice(0, 40));
        return { operation: approval.operation === 'referral.create.batch' ? 'referral.create.batch' : 'lap.task.create.batch', created, failed };
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
