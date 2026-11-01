// "What should I do today?" One ranking, in code, across referrals and the loan pipeline, used by the
// conversation, Home and the pages, so they cannot disagree. The agent notices the work and prepares
// what it can: follow-ups for someone who looks after others, and the next question for everyone.
import type { ApprovalCardBlock, DiTake, ListBlock } from '@dinext/block-schemas';
import { usd, type ApprovalRecord as Approval, type InboxItem, type PayoutBatch, type PipelineApplication, type PipelineFound, type Scorecard } from '@dinext/di-core';
import { newBlockId } from './answer.ts';
import type { ToolCallRecord } from './audit.ts';
import { inStatus, midSentence as lower, type GatewayContext, type ToolGateway } from './gateway.ts';
import { GOAL_AGENT, type GoalThread } from './goal.ts';
import { mostWaitOn, money, taskCard } from './pipelineAgent.ts';
import type { RunSink } from './sink.ts';

export const TODAY_REQUEST = /\bwhat should (i|we) (do|work on|focus on|start with|tackle)\b|\bplan (my|our) day\b|\bwhat needs (me|my attention)\b|\bwhere should i start\b|\bget (me|us) ready for (the|my|our) (day|week)\b/i;

const MAX_ITEMS = 5;
const FOLLOW_UPS = 3;
const DAY = 86_400_000;

export interface TodayWho {
  user: { id: string; name: string };
  apps: string[];
  purviewBranches?: string[];
  employeeId?: number;
  lap?: GatewayContext['lap'];
  gi?: GatewayContext['gi'];
}

export interface TodayItem {
  id: string;
  kind: 'referral' | 'application' | 'totals' | 'payouts';
  title: string;
  why: string;
  badge: string;
  link: string;
  /** What to ask DI to act on this item. */
  ask: string;
  weight: number;
  amount?: number;
  /** Days past the threshold, or past the due date. */
  past?: number;
}

export interface TodayPlan {
  items: TodayItem[];
  overdue: number;
  stalled: { count: number; dollars: number };
  /** Applications to chase through their owners, for someone who looks after others. */
  followUps: number[];
}

/** Frontline staff work their own list; leads and everyone else look after the team's. */
export const worksOwnList = (who: Pick<TodayWho, 'employeeId' | 'lap'>) => who.employeeId !== undefined && !who.lap?.leads;

/** Dollars and time past the threshold both count, so neither a big new stall nor a small old one hides. */
export const applicationWeight = (a: PipelineApplication) => 30 + Math.min(a.amount / 10_000, 30) + (a.daysInStatus - (a.threshold ?? 0)) * 3;

const overdueDays = (i: InboxItem, now: number) => Math.max(1, Math.ceil((now - Date.parse(i.dueAt)) / DAY));
const referralWeight = (i: InboxItem, now: number) => 40 + overdueDays(i, now) * 6 + (i.priority === 'Urgent' ? 25 : i.priority === 'High' ? 15 : 0);
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

function applicationItem(a: PipelineApplication, own: boolean): TodayItem {
  const over = a.daysInStatus - (a.threshold ?? 0);
  return {
    id: `a${a.applicationId}`,
    kind: 'application',
    title: `${a.name}: ${money(a.amount)} ${lower(a.product)}`,
    why: `${days(a.daysInStatus)} ${inStatus(a.status)}, ${over} over the ${a.threshold}-day threshold.${a.hold ? ` ${a.hold.label}.` : ''}${own || !a.owner ? '' : ` With ${a.owner.name}.`}`,
    badge: 'Stalled',
    link: `/m/lap?id=${a.applicationId}`,
    ask: own ? `Why is application #${a.applicationId} stuck?` : `Create a follow-up task for application #${a.applicationId}`,
    weight: applicationWeight(a),
    amount: a.amount,
    past: over,
  };
}

function referralItem(i: InboxItem, own: boolean, now: number): TodayItem {
  const late = overdueDays(i, now);
  return {
    id: `r${i.comId}`,
    kind: 'referral',
    title: `${i.name}: ${lower(i.typeLabel)}`,
    why: `Overdue by ${days(late)}.${own || !i.assignee ? '' : ` With ${i.assignee.name}.`}${i.notes ? ` ${i.notes}` : ''}`.slice(0, 240),
    badge: 'Overdue',
    link: `/workflows/referrals/inbox?id=${i.comId}`,
    ask: `Prepare me for my meeting with ${i.name}`,
    weight: referralWeight(i, now),
    past: late,
  };
}

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** Payouts waiting for this approver: one line, because money waits on nobody else. */
function payoutSummary(all: PayoutBatch[]) {
  const open = all.filter((b) => b.waiting);
  const [first] = open;
  if (!first) return null;
  const month = first.period.split(' ')[0]!;
  const one = open.length === 1;
  const flagged = open.reduce((n, b) => n + b.flagged, 0);
  const facts = `${people(open.reduce((n, b) => n + b.waiting, 0))}, ${usd(open.reduce((n, b) => n + b.total, 0))}${flagged ? `, ${flagged} flagged` : ''}`;
  const where = one ? first.branch : `${open.length} branches`;
  return { month, where, title: `${month} payouts: ${where}`, facts, ask:one ? `Show the ${month} payouts for ${first.branch} for approval` : `Show the ${month} payouts` };
}

function payoutItem(all: PayoutBatch[]): TodayItem | null {
  const p = payoutSummary(all);
  return p && { id: 'payouts', kind: 'payouts', title: p.title, why: `${p.facts}. Waiting for your approval.`, badge: 'To approve', link: '/m/gi', ask: p.ask, weight: 200 };
}

/** What needs this person now. Each read goes through the gateway, so access is the tools' access. */
export async function buildToday(who: TodayWho, gateway: ToolGateway, now = Date.now()): Promise<TodayPlan> {
  const ctx: GatewayContext = { ...who, runId: 'today', threadId: 'today', members: new Map() };
  const own = worksOwnList(who);
  const referrals = await gateway.call('referral_inbox_list', { box: own ? 'mine' : 'team', overdue_only: true }, ctx, 'inbox');
  const pipeline = await gateway.call('lap_applications_list', { stalled_only: true }, ctx, 'pipeline');
  const overdue = (referrals.ok && referrals.inbox) || [];
  const found = pipeline.ok ? pipeline.found : undefined;
  const apps = found?.items ?? [];
  const items = [...overdue.map((i) => referralItem(i, own, now)), ...apps.map((a) => applicationItem(a, found?.view === 'mine'))];
  // Totals-only access: the work is real, but there is nobody to name.
  if (found?.detailsHidden && found.count) items.push({ id: 'totals', kind: 'totals', title: `${found.count} applications have stalled`, why: `Worth ${money(found.dollars)}, mostly ${lower(found.byProduct[0]!.product)}s.`, badge: 'Stalled', link: '/m/lap', ask: 'Show the pipeline by product', weight: 60 });
  const payouts = who.gi?.approves ? await gateway.call('gi_payouts_list', {}, ctx, 'incentives') : null;
  const owed = payouts?.ok && payouts.batches ? payoutItem(payouts.batches) : null;
  if (owed) items.push(owed);
  items.sort((a, b) => b.weight - a.weight);
  // Each kind of work keeps a place, so big loans can't hide an overdue referral.
  const top = items.slice(0, MAX_ITEMS);
  for (const missing of items.filter((i, n) => n >= MAX_ITEMS && i.kind !== 'totals' && !top.some((t) => t.kind === i.kind)).slice(0, 1)) top[top.length - 1] = missing;
  const chase = found?.view === 'mine' ? [] : [...apps].sort((a, b) => applicationWeight(b) - applicationWeight(a)).filter((a) => a.owner && a.owner.employeeId !== who.employeeId);
  return { items: top, overdue: overdue.length, stalled: { count: found?.count ?? 0, dollars: found?.dollars ?? 0 }, followUps: chase.slice(0, FOLLOW_UPS).map((a) => a.applicationId) };
}

/** Why the first item leads, compared in code against its own kind of work, so it is always true. */
export function whyFirst(items: TodayItem[]) {
  const [first, ...rest] = items;
  const peers = rest.filter((i) => i.kind === first?.kind);
  if (!first || !peers.length) return '';
  const beats = (key: 'amount' | 'past') => peers.every((i) => (first[key] ?? 0) > (i[key] ?? 0));
  if (first.kind === 'referral') return beats('past') ? 'It leads because it is the most overdue here.' : 'It leads on days overdue and priority taken together.';
  if (beats('amount') && beats('past')) return 'It leads because it is both the largest application here and the furthest past its threshold.';
  if (beats('amount')) return 'It leads because it is the largest application here.';
  if (beats('past')) return 'It leads because it is the furthest past its threshold.';
  return 'It leads on dollars and days past the threshold taken together.';
}

export function todayText(p: TodayPlan) {
  const [first] = p.items;
  if (!first) return 'Nothing is overdue or stalled, so you’re clear to get on with your day.';
  const n = p.overdue + p.stalled.count;
  const rest = n > p.items.length ? ` In all, ${p.overdue ? `${p.overdue} overdue ${p.overdue === 1 ? 'referral' : 'referrals'}` : ''}${p.overdue && p.stalled.count ? ' and ' : ''}${p.stalled.count ? `${p.stalled.count} stalled ${p.stalled.count === 1 ? 'application' : 'applications'}` : ''}.` : '';
  return `Start with **${first.title}**. ${first.why}${whyFirst(p.items) ? ` ${whyFirst(p.items)}` : ''}${rest}`;
}

/** The ranked list. On Home, each item starts the work; in a conversation it opens the record. */
export function todayList(p: TodayPlan, runId: string, opts: { startsWork?: boolean; label?: string } = {}): ListBlock {
  return {
    id: newBlockId('tdy'),
    type: 'list',
    version: '1.0.0',
    title: 'Your day',
    provenance: { agent: GOAL_AGENT, runId, operations: ['today.rank'], sources: [{ kind: 'workflow', label: 'Referrals and Loan Pipeline', ref: 'workflow:today' }] },
    freshness: { kind: 'workflow_event' },
    ...(opts.label ? { output: { label: opts.label } } : {}),
    data: {
      layout: 'list',
      items: p.items.map((i) => ({ id: i.id, title: i.title, subtitle: i.why, link: opts.startsWork ? `/c/new?q=${encodeURIComponent(i.ask)}` : i.link, badge: { label: i.badge, tone: i.kind === 'payouts' ? ('warning' as const) : ('danger' as const) } })),
    },
  };
}

/** The Goals & Incentives page: payouts first for whoever approves them, then the person's own month. */
export function goalsTake(mine: Scorecard | null, batches: PayoutBatch[] | null): DiTake {
  const p = batches && payoutSummary(batches);
  if (p) return { headline: `${p.month} payouts are waiting for you at ${p.where}: ${p.facts}.`, action: { label: 'Review payouts', ask: p.ask } };
  if (mine) return { headline: `${mine.period}: you’ve earned ${usd(mine.total)} so far.`, action: { label: 'How am I doing?', ask: 'How am I doing on my goals this month?' } };
  return { headline: 'Nothing is waiting for you here.' };
}

export function pipelineTake(f: PipelineFound, own: boolean): DiTake {
  if (!f.count) return { headline: 'Nothing has stalled. The pipeline is moving.' };
  if (f.detailsHidden) return { headline: `${f.count} applications have stalled, worth ${money(f.dollars)}. ${f.byProduct[0]!.product} is the largest group, with ${f.byProduct[0]!.count}.${mostWaitOn(f)}`, action: { label: 'Ask about the funnel', ask: 'Show the pipeline by product' } };
  const ranked = [...f.items].sort((a, b) => applicationWeight(b) - applicationWeight(a));
  const top = ranked[0]!;
  const n = Math.min(FOLLOW_UPS, ranked.length);
  const headline = `${f.count} ${f.count === 1 ? 'has' : 'have'} stalled. ${top.name}’s ${money(top.amount)} ${lower(top.product)} matters most: ${days(top.daysInStatus)} ${inStatus(top.status)}, over the ${top.threshold}-day threshold.${top.hold ? ` ${top.hold.label}.` : ''}${mostWaitOn(f)}`;
  if (own) return { headline, action: { label: 'Why is it stuck?', ask: `Why is application #${top.applicationId} stuck?` } };
  return { headline, action: { label: `Create follow-ups for the top ${n}`, ask: `Create follow-up tasks for applications ${ranked.slice(0, n).map((a) => `#${a.applicationId}`).join(', ')}` } };
}

export function referralTake(items: InboxItem[], own: boolean, now = Date.now()): DiTake {
  const late = items.filter((i) => i.overdue).sort((a, b) => referralWeight(b, now) - referralWeight(a, now));
  const top = late[0];
  if (!top) return { headline: items.length ? 'Nothing is overdue. Oldest work is first.' : 'Nothing is waiting.' };
  const who = own || !top.assignee ? '' : ` with ${top.assignee.name}`;
  const more = late.length > 1 ? ` ${late.length} are overdue in all.` : '';
  return { headline: `${top.name}’s ${lower(top.typeLabel)}${who} comes first: overdue by ${days(overdueDays(top, now))}.${more}`, action: own ? { label: 'Prepare me', ask: `Prepare me for my meeting with ${top.name}` } : { label: 'Show what’s overdue', ask: 'Show my team’s overdue referrals' } };
}

export interface TodayOutcome {
  outcome: 'answer' | 'approval';
  toolCalls: ToolCallRecord[];
  approval?: { record: Approval; card: ApprovalCardBlock };
  superseded: string[];
}

export async function runToday(input: TodayWho & { runId: string; threadId: string; user: { id: string; name: string; title: string } }, deps: { gateway: ToolGateway; beatMs?: number }, state: GoalThread, sink: RunSink): Promise<TodayOutcome> {
  const beat = () => (deps.beatMs ? new Promise((r) => setTimeout(r, deps.beatMs)) : Promise.resolve());
  const toolCalls: ToolCallRecord[] = [];
  const has = (app: string) => input.apps.includes(app);
  sink.routing(GOAL_AGENT, 'Planning your day');
  const steps = [...(has('referrals') ? [{ id: 'referrals', label: 'Check your referrals' }] : []), ...(has('lap') ? [{ id: 'pipeline', label: 'Check the loan pipeline' }] : []), { id: 'rank', label: 'Rank what matters most' }];
  const plan = await buildToday(input, deps.gateway);
  const chase = plan.followUps.length > 0;
  const all = chase ? [...steps, { id: 'followups', label: 'Prepare follow-ups for you to approve' }] : steps;
  state.planId = sink.plan('Plan', GOAL_AGENT, all.map((s) => ({ ...s, agent: GOAL_AGENT, state: 'waiting' as const })), { task: true });
  state.stepIds = all.map((s) => s.id);
  for (const s of steps) {
    sink.step(state.planId, { id: s.id, state: 'running' });
    await beat();
    sink.step(state.planId, { id: s.id, state: 'done', resultSummary: s.id === 'referrals' ? `${plan.overdue} overdue` : s.id === 'pipeline' ? `${plan.stalled.count} stalled` : undefined });
  }
  await sink.text(todayText(plan), GOAL_AGENT);
  if (plan.items.length) await sink.block(todayList(plan, input.runId, { label: 'Your day' }));
  if (chase) {
    state.approvalStep = 'followups';
    sink.step(state.planId, { id: 'followups', state: 'running' });
    const ctx: GatewayContext = { ...input, members: new Map() };
    const r = await deps.gateway.call('lap_follow_ups_create', { application_ids: plan.followUps }, ctx, 'pipeline');
    toolCalls.push({ name: 'lap_follow_ups_create', input: { application_ids: plan.followUps }, ok: r.ok, ms: 0, error: r.ok ? undefined : r.code });
    if (r.ok && r.tasks) {
      const card = taskCard(r.tasks, input);
      sink.step(state.planId, { id: 'followups', state: 'needs_input', resultSummary: 'Waiting for your approval' });
      await sink.text('I’ve prepared follow-ups for the owners of the top stalled applications. Nothing goes out until you approve it.', GOAL_AGENT);
      await sink.block(card);
      return { outcome: 'approval', toolCalls, approval: { record: r.tasks.approval, card }, superseded: r.tasks.superseded };
    }
    sink.step(state.planId, { id: 'followups', state: 'skipped', resultSummary: 'They already have open tasks' });
  }
  for (const i of plan.items.slice(0, 2)) sink.suggestion(i.ask);
  return { outcome: 'answer', toolCalls, superseded: [] };
}
