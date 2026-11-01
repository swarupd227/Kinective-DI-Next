// Mock Experience Layer for front-end work (spec 11.2 "testing/mock stream server").
// Implements the client contract in spec 12 with scripted scenarios; no real agents or data.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ListBlock, ReferralAction } from '@dinext/block-schemas';
import type {
  AppNotification,
  ApprovalCardBlock,
  ApprovalDecisionRequest,
  ClientMessage,
  SendMessageRequest,
  StreamEvent,
  ThreadSummary,
} from '@dinext/block-schemas';
import { pickScenario, scriptForAgent, type Script, type ScriptContext } from './scenarios.ts';
import { homeApprovals, homeFor, isPersona, searchFor, sessionFor, tableFor, usersToTell, type PersonaId } from './data.ts';
import type { LiveRuntime, Notice } from './live.ts';
import { createSpeechTap } from './speech.ts';
import type { VoiceGateway } from '@dinext/voice';
import { CoreError } from '@dinext/di-core';

/** Words the recogniser should expect without live data: banking terms and branch names (spec 7.8). */
const BASE_VOCABULARY = ['HELOC', 'HELOAN', 'SEG', 'NCUA 5300', 'call report', 'share draft', 'share certificate', 'IRA', 'money market', 'indirect', 'delinquency', 'charge-off', 'loan-to-share', 'cross-sell', 'attrition', 'purview', 'nightly build', 'referral', 'member 360', 'household', 'eStatements', 'direct deposit', 'Westport', 'Northgate', 'Riverside', 'Lakeshore', 'Downtown', 'Eastgate'];

type Emit = Omit<StreamEvent, 'threadId' | 'seq' | 'ts'>;

interface Thread {
  /** Tasks are personal: the user who started it, and nobody else, sees it. */
  owner: string;
  summary: ThreadSummary;
  events: StreamEvent[];
  seq: number;
  deleted: boolean;
}

interface Run {
  threadId: string;
  timers: NodeJS.Timeout[];
  completedSteps: string[];
  done: boolean;
  /** Live runs stop through this; scripted runs clear their timers. */
  abort?: AbortController;
}

const SETTLED = { approved: 'Approved', denied: 'Approval denied', returned: 'Sent back', expired: 'Approval expired' };

interface PendingApproval {
  threadId: string | null;
  runId: string | null;
  blockId: string;
  card: ApprovalCardBlock;
  decided?: { status: number; body: unknown };
  onResolved?: (decision: 'approved' | 'denied' | 'returned') => void;
  /** The bell's "Approval needed" for this card, updated once it is decided. */
  noticeId?: string;
  /** Cards from live agents are decided by the approval service, not here. */
  live?: boolean;
  expiryTimer?: NodeJS.Timeout;
}

export interface MockServerOptions {
  port: number;
  /** Multiplies every scripted delay; tests use a small value to run quickly. */
  speed?: number;
  /** Real agents over the tenant warehouse. Without it every turn plays a scripted scenario. */
  live?: LiveRuntime | null;
  /** The voice gateway; without it the session reports voice as unavailable. */
  voice?: VoiceGateway | null;
  /** The built shell (apps/shell/dist), served from the same origin in a deployed container. */
  staticDir?: string;
  /** When set, every request needs this demo access code first (a demo gate, not sign-in). */
  accessCode?: string;
}

const id = (prefix: string, n = 16) => `${prefix}${randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n).padEnd(n, '0')}`;

/** "Your work" with the real referral counts in place of the placeholder line. */
const yourReferrals = (block: ListBlock, r: { open: number; overdue: number }): ListBlock => ({
  ...block,
  data: { ...block.data, items: block.data.items.map(({ badge: _badge, ...item }) => (item.id === 'w1' ? { ...item, meta: `${r.open} open`, subtitle: r.overdue ? `${r.overdue} overdue` : 'Nothing overdue', ...(r.overdue ? { badge: { label: 'Overdue', tone: 'danger' as const } } : {}) } : { ...item, ...(_badge ? { badge: _badge } : {}) })) },
});

export function startMockServer({ port, speed = 1, live = null, voice = null, staticDir, accessCode }: MockServerOptions) {
  const startedAt = new Date().toISOString();
  const gate = accessCode ? demoGate(accessCode) : null;
  const files = staticDir ? staticFiles(staticDir) : null;
  const threads = new Map<string, Thread>();
  const runs = new Map<string, Run>();
  const approvals = new Map<string, PendingApproval>();
  const idempotency = new Map<string, { status: number; body: unknown }>();
  const tickets = new Set<string>();
  /** Each socket receives only the threads it subscribed to (spec 12.4 subscribe/unsubscribe). */
  const sockets = new Map<WebSocket, Set<string>>();

  // The mock serves one signed-in developer; the persona is switched through GET /v1/session.
  let persona: PersonaId = 'executive';
  const me = () => sessionFor(persona).user.id;
  /** Each for one person: these outlive the persona switch that shows them to that person. */
  let notifications: AppNotification[] = [];
  /** Read marks for the notices worked out from current work, as user and notice id. */
  const readNotices = new Set<string>();
  let homeCards = homeApprovals(persona, id);
  const registerHomeCards = () => {
    for (const card of homeCards) approvals.set(card.data.approvalId, { threadId: null, runId: null, blockId: card.id, card });
  };
  registerHomeCards();

  const setPersona = (p: PersonaId) => {
    if (p === persona) return;
    persona = p;
    homeCards = homeApprovals(p, id);
    registerHomeCards();
  };

  const thread = (threadId: string, title = 'New conversation') => {
    let t = threads.get(threadId);
    if (!t) {
      const now = new Date().toISOString();
      t = { owner: me(), summary: { threadId, title, createdAt: now, updatedAt: now, archived: false, turns: 0 }, events: [], seq: 0, deleted: false };
      threads.set(threadId, t);
    }
    return t;
  };

  /** Someone else's task answers as if it did not exist. */
  const foreign = (t: Thread | undefined) => t !== undefined && t.owner !== me();

  const broadcast = (threadId: string, json: string) => {
    for (const [ws, subs] of sockets) if (subs.has(threadId) && ws.readyState === ws.OPEN) ws.send(json);
  };

  // The session's own flags decide whether a spoken "confirm" may approve a medium card.
  const speech = voice ? createSpeechTap(voice, { mediumConfirm: () => sessionFor(persona).flags.voiceMediumConfirm, speed }) : null;

  const emit = (threadId: string, e: Emit) => {
    const t = thread(threadId);
    const event = { ...e, threadId, seq: ++t.seq, ts: new Date().toISOString() } as StreamEvent;
    t.events.push(event);
    t.summary.updatedAt = event.ts;
    broadcast(threadId, JSON.stringify(event));
    speech?.event(event);
    return event;
  };

  const notify = (userId: string, n: Omit<AppNotification, 'id' | 'at' | 'read' | 'userId'>) => {
    const full: AppNotification = { ...n, id: id('ntf_', 10), at: new Date().toISOString(), read: false, userId };
    notifications.unshift(full);
    pushNotice(full);
    return full;
  };

  const pushNotice = (n: AppNotification) => {
    if (n.userId !== me()) return;
    const json = JSON.stringify({ type: 'notification', notification: n });
    for (const ws of sockets.keys()) if (ws.readyState === ws.OPEN) ws.send(json);
  };

  /** A decided card asks nothing more of anyone, so its notice says how it ended and stops counting. */
  const settleNotice = (a: PendingApproval, outcome: keyof typeof SETTLED) => {
    const n = notifications.find((x) => x.id === a.noticeId);
    if (!n) return;
    const settled: AppNotification = { ...n, title: SETTLED[outcome], at: new Date().toISOString(), read: true };
    notifications = notifications.map((x) => (x === n ? settled : x));
    pushNotice(settled);
  };

  /** Tells the people concerned, never the person who just did it. */
  const tell = (notices: Notice[]) => {
    for (const n of notices) {
      for (const userId of new Set([...(n.userId ? [n.userId] : []), ...usersToTell(n.employeeId, n.branch)])) {
        if (userId !== me()) notify(userId, { group: 'workflow', title: n.title, detail: n.detail, link: `/workflows/referrals/inbox?id=${n.comId}` });
      }
    }
  };

  const runScript = (threadId: string, runId: string, script: Script) => {
    const run: Run = { threadId, timers: [], completedSteps: [], done: false };
    runs.set(runId, run);
    let at = 0;
    const ctx: ScriptContext = {
      threadId,
      runId,
      id,
      emit: (e) => emit(threadId, e),
      sendRaw: (e) => broadcast(threadId, JSON.stringify(e)),
      reserveSeq: () => ++thread(threadId).seq,
      stepDone: (stepId) => run.completedSteps.push(stepId),
      finish: () => {
        if (run.done) return;
        run.done = true;
        notify(thread(threadId).owner, { group: 'agent_runs', title: 'Answer ready', detail: thread(threadId).summary.title, link: `/c/${threadId}` });
      },
      awaitApproval: (card, blockId, onResolved) => {
        const notice = notify(thread(threadId).owner, { group: 'approvals', title: 'Approval needed', detail: card.data.summary, link: `/c/${threadId}` });
        approvals.set(card.data.approvalId, { threadId, runId, blockId, card, noticeId: notice.id, onResolved: (d) => onResolved(d, ctx) });
      },
    };
    for (const step of script(ctx)) {
      at += step.delay * speed;
      run.timers.push(setTimeout(() => !run.done && step.run(), at));
    }
  };

  const completeRun = (runId: string, threadId: string) => {
    const run = runs.get(runId);
    if (run?.done) return;
    if (run) run.done = true;
    emit(threadId, { type: 'run.completed', runId } as Emit);
  };

  /** A live card that can no longer be approved: replaced by a newer draft, or past its expiry. */
  const expireLive = (approvalId: string) => {
    const a = approvals.get(approvalId);
    if (!a?.live || a.decided) return;
    clearTimeout(a.expiryTimer);
    a.decided = { status: 410, body: { code: 'EXPIRED' } };
    settleNotice(a, 'expired');
    emit(a.threadId!, { type: 'approval.resolved', runId: a.runId, approvalId, blockId: a.blockId, decision: 'expired', by: 'DI' } as Emit);
    completeRun(a.runId!, a.threadId!);
  };

  /** A turn for the Concierge. Agents still on placeholders hand back to their scripted scenario. */
  const runLive = async (rt: LiveRuntime, threadId: string, runId: string, body: SendMessageRequest) => {
    const run: Run = { threadId, timers: [], completedSteps: [], done: false, abort: new AbortController() };
    runs.set(runId, run);
    const signal = run.abort!.signal;
    try {
      const result = await rt.run(persona, { threadId, runId, text: body.input.text, context: body.context ?? [] }, (ev) => !signal.aborted && emit(threadId, ev), signal, speed);
      if (signal.aborted) return;
      if (result.scripted) {
        runs.delete(runId);
        runScript(threadId, runId, scriptForAgent(result.scripted) ?? pickScenario(body.input.text, body.context));
        return;
      }
      result.superseded.forEach(expireLive);
      if (result.approval) {
        // The run stays open on its card until the user decides or the approval expires (spec 12.5).
        const { approvalId, card } = result.approval;
        const entry: PendingApproval = { threadId, runId, blockId: card.id, card, live: true };
        entry.expiryTimer = setTimeout(() => expireLive(approvalId), Math.max(0, new Date(card.data.expiresAt).getTime() - Date.now()));
        approvals.set(approvalId, entry);
        emit(threadId, { type: 'approval.requested', runId, approvalId, blockId: card.id, riskTier: card.data.riskTier, expiresAt: card.data.expiresAt } as Emit);
        entry.noticeId = notify(thread(threadId).owner, { group: 'approvals', title: 'Approval needed', detail: card.data.summary, link: `/c/${threadId}` }).id;
        return;
      }
      completeRun(runId, threadId);
      notify(thread(threadId).owner, { group: 'agent_runs', title: 'Answer ready', detail: thread(threadId).summary.title, link: `/c/${threadId}` });
    } catch (err) {
      if (signal.aborted) return;
      run.done = true;
      console.error(`[run ${runId}]`, err);
      emit(threadId, { type: 'run.failed', runId, error: { code: 'AGENT_FAILED', userMessage: 'Something went wrong answering that. Nothing was changed. Try again, or rephrase the question.', referenceId: runId } } as Emit);
    }
  };

  const cancelRun = (runId: string) => {
    const run = runs.get(runId);
    if (!run || run.done) return;
    run.abort?.abort();
    run.timers.forEach(clearTimeout);
    run.done = true;
    emit(run.threadId, { type: 'run.cancelled', runId, completedSteps: run.completedSteps } as Emit);
  };

  const json = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = async <T>(req: IncomingMessage): Promise<T> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    return (raw ? JSON.parse(raw) : {}) as T;
  };

  /** Live cards: the same confirmation rules, then the approval service decides and the write runs. */
  const decideLive = async (approvalId: string, a: PendingApproval, key: string, body: ApprovalDecisionRequest) => {
    const r = await live!.decide(
      persona,
      { approvalId, threadId: a.threadId!, runId: a.runId!, body },
      (ev) => emit(a.threadId!, ev),
      (result) => {
        completeRun(a.runId!, a.threadId!);
        const done = result as { comId?: number; queueName?: string; assignee?: string | null; notify?: Notice[] } | null;
        tell(done?.notify ?? []);
        const created = done?.comId ? (done as { comId: number; queueName: string; assignee: string | null }) : null;
        if (created) notify(me(), { group: 'workflow', title: `Referral #${created.comId} ${created.assignee ? `assigned to ${created.assignee}` : 'sent'}`, detail: created.queueName, link: '/workflows/referrals/inbox' });
      },
      speed,
    );
    // An edit keeps the card open; a refusal from the approval service leaves it undecided.
    if (r.status !== 200 || body.decision === 'edit') return { status: r.status, body: r.body };
    clearTimeout(a.expiryTimer);
    const result = { status: r.status, body: r.body };
    a.decided = result;
    idempotency.set(key, result);
    if (r.resolved) settleNotice(a, r.resolved);
    const by = sessionFor(persona).user.name;
    emit(a.threadId!, { type: 'approval.resolved', runId: a.runId, approvalId, blockId: a.blockId, decision: r.resolved, by, channel: body.channel } as Emit);
    return result;
  };

  const decide = async (approvalId: string, key: string, body: ApprovalDecisionRequest): Promise<{ status: number; body: unknown }> => {
    if (idempotency.has(key)) return idempotency.get(key)!;
    const a = approvals.get(approvalId);
    if (!a || (a.threadId && foreign(threads.get(a.threadId)))) return { status: 404, body: { code: 'NOT_FOUND' } };
    const c = a.card.data.confirmation;
    if (a.decided) return a.decided.status === 410 ? { status: 410, body: { code: 'EXPIRED' } } : { status: 409, body: { code: 'ALREADY_DECIDED' } };
    if (new Date(a.card.data.expiresAt).getTime() < Date.now()) return { status: 410, body: { code: 'EXPIRED' } };
    if (body.clientContext.previewHash !== a.card.data.previewHash) return { status: 409, body: { code: 'PREVIEW_CHANGED' } };
    if (body.decision === 'approve') {
      if (body.channel === 'voice' && (a.card.data.riskTier === 'high' || !c.methods.includes('voice'))) {
        return { status: 422, body: { code: 'CONFIRMATION_MISMATCH', message: 'Voice cannot confirm this approval.' } };
      }
      // A spoken medium approval counts only after its read-back played and if the tenant allows it
      // (FE-VOICE-041). Scripted cards have no read-back, so they keep the earlier rule.
      if (body.channel === 'voice' && a.card.data.riskTier === 'medium' && a.live && voice) {
        if (!sessionFor(persona).flags.voiceMediumConfirm) return { status: 422, body: { code: 'CONFIRMATION_MISMATCH', message: 'Press Approve to confirm this one.' } };
        if (!voice.readBackDone(approvalId)) return { status: 422, body: { code: 'CONFIRMATION_MISMATCH', message: 'Wait for the summary to finish, then say confirm.' } };
      }
      if (c.typedValue && (body.typedConfirmation ?? '').trim().toLowerCase() !== c.typedValue.expected.toLowerCase()) {
        return { status: 422, body: { code: 'CONFIRMATION_MISMATCH', message: `Type ${c.typedValue.expected} exactly to approve.` } };
      }
      if (c.stepUp && !body.stepUpToken?.startsWith('stp_')) return { status: 403, body: { code: 'STEP_UP_REQUIRED' } };
    }
    if (body.decision === 'return' && !body.note) return { status: 422, body: { code: 'CONFIRMATION_MISMATCH', message: 'A note is required.' } };
    if (a.live && live) return decideLive(approvalId, a, key, body);
    if (body.decision === 'edit') return { status: 200, body: { decision: 'returned', by: 'Dana Lee', at: new Date().toISOString() } };

    const decision = body.decision === 'approve' ? 'approved' : body.decision === 'deny' ? 'denied' : 'returned';
    const by = sessionFor(persona).user.name;
    const result = { status: 200, body: { decision, by, at: new Date().toISOString() } };
    a.decided = result;
    idempotency.set(key, result);
    settleNotice(a, decision);
    if (a.threadId) {
      emit(a.threadId, { type: 'approval.resolved', runId: a.runId, approvalId, blockId: a.blockId, decision, by, channel: body.channel } as Emit);
      setTimeout(() => a.onResolved?.(decision), 300 * speed);
    } else {
      homeCards = homeCards.filter((card) => card.data.approvalId !== approvalId);
    }
    if (decision === 'approved' && a.card.data.operation === 'workflow.item.create') {
      notify(me(), { group: 'workflow', title: 'Referral #88214 assigned to Ana Ruiz', detail: 'Westport lending queue', link: '/workflows/referrals/inbox' });
    }
    return result;
  };

  const visibleThreads = () => [...threads.values()].filter((t) => !t.deleted && !foreign(t));
  const pendingHomeCards = () => homeCards.filter((c) => !approvals.get(c.data.approvalId)?.decided);
  /** Cards waiting in this person's tasks, so they can be decided from Home too. */
  const waitingInTasks = () =>
    [...approvals.values()].filter((a) => {
      const t = a.threadId ? threads.get(a.threadId) : undefined;
      return t && !t.deleted && !foreign(t) && !a.decided && new Date(a.card.data.expiresAt).getTime() > Date.now();
    });

  /** The bell's view of work open right now, worked out on each read so it agrees with the screen. */
  const currentNotices = async (): Promise<AppNotification[]> => {
    const cards = pendingHomeCards();
    const failed = (err: unknown) => (console.error('[notifications]', err), null);
    const overdue = [...((await live?.overdueReferrals(persona).catch(failed)) ?? []), ...((await live?.stalledApplications(persona).catch(failed)) ?? [])];
    const open: Omit<AppNotification, 'read'>[] = cards.length ? [{ id: 'ntc_home_approvals', group: 'approvals', title: `${cards.length} ${cards.length === 1 ? 'approval' : 'approvals'} waiting`, detail: cards.map((c) => c.title).join(' · '), at: startedAt, link: '/home' }, ...overdue] : overdue;
    return open.map((n) => ({ ...n, read: readNotices.has(`${me()}:${n.id}`) }));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/healthz') return json(res, 200, { status: 'ok' });
    if (gate && (await gate.handle(req, res, path))) return;
    if (files && !path.startsWith('/v1/') && (method === 'GET' || method === 'HEAD')) return files(path, res);
    try {
      if (method === 'GET' && path === '/v1/session') {
        const p = url.searchParams.get('persona');
        if (isPersona(p)) setPersona(p);
        return json(res, 200, sessionFor(persona, voice?.status()));
      }
      if (method === 'GET' && path === '/v1/home') {
        const waiting = waitingInTasks();
        const home = homeFor(persona, [...waiting.map((a) => a.card), ...pendingHomeCards()]);
        const asked = home.sections.find((s) => s.id === 'approvals');
        if (asked && waiting.length) asked.tasks = Object.fromEntries(waiting.map((a) => [a.card.data.approvalId, a.threadId!]));
        // With the warehouse up, "What changed" and "Things to look at" come from real figures.
        const real = await live?.home(persona).catch((err) => (console.error('[home]', err), null));
        if (real) {
          home.narrative = real.narrative;
          for (const s of home.sections) {
            if (s.id === 'what_changed') s.blocks = [real.kpis];
            if (s.id === 'your_work' && real.referrals) s.blocks = [yourReferrals(s.blocks[0] as ListBlock, real.referrals)];
            if (s.id === 'look_at' && real.lookAt.data.items.length) s.blocks = [real.lookAt];
            if (s.id === 'scheduled_reports' && real.scheduled) s.blocks = [real.scheduled];
          }
        }
        // "Needs you" leads with the work DI ranked, ahead of the approvals waiting.
        const today = await live?.today(persona).catch((err) => (console.error('[home]', err), null));
        if (today) {
          const needs = home.sections.find((s) => s.id === 'approvals');
          if (needs) needs.blocks.unshift(today);
          else home.sections.unshift({ id: 'approvals', title: 'Needs you', blocks: [today] });
        }
        return json(res, 200, home);
      }
      if (method === 'GET' && path === '/v1/search') {
        const q = url.searchParams.get('q') ?? '';
        const results = searchFor(persona, q, visibleThreads().map((t) => t.summary));
        // With the warehouse up, members come from the Relationship service: name, number, phone or email.
        const members = await live?.searchMembers(persona, q).catch((err) => (console.error('[search]', err), null));
        if (!members) return json(res, 200, { results });
        const kind = url.searchParams.get('kind');
        return json(res, 200, { results: kind === 'member' ? members : [...members, ...results.filter((r) => r.kind !== 'member')].slice(0, 20) });
      }
      // ---- loan pipeline (spec 17.5) ----
      if (path.startsWith('/v1/lap/') && live) {
        const views = ['mine', 'location', 'team', 'institution'] as const;
        const view = views.find((v) => v === url.searchParams.get('view'));
        const one = /^\/v1\/lap\/applications\/(\d+)$/.exec(path);
        try {
          if (method === 'GET' && path === '/v1/lap/summary') {
            const r = await live.pipeline(persona, view);
            return r ? json(res, 200, r) : json(res, 404, { code: 'NOT_FOUND' });
          }
          if (method === 'GET' && path === '/v1/lap/applications' && view) {
            const r = await live.pipelineApplications(persona, { view, group: url.searchParams.get('group') ?? undefined, stalled: url.searchParams.get('stalled') === '1' });
            return r ? json(res, 200, r) : json(res, 404, { code: 'NOT_FOUND' });
          }
          if (method === 'GET' && one) {
            const r = await live.pipelineApplication(persona, Number(one[1]));
            return r ? json(res, 200, r) : json(res, 404, { code: 'NOT_FOUND' });
          }
        } catch (err) {
          if (err instanceof CoreError) return json(res, err.code === 'NO_ACCESS' ? 403 : err.code === 'INVALID' ? 422 : 404, { code: err.code, message: err.message });
          throw err;
        }
      }
      // ---- referrals (spec 17.3) ----
      if (method === 'GET' && path === '/v1/referrals') {
        const box = url.searchParams.get('box');
        const r = await live?.referrals(persona, box === 'team' || box === 'sent' ? box : 'mine');
        return r ? json(res, 200, r) : json(res, 404, { code: 'NOT_FOUND' });
      }
      const referral = /^\/v1\/referrals\/(\d+)(\/actions)?$/.exec(path);
      if (referral && live) {
        const comId = Number(referral[1]);
        try {
          if (method === 'GET' && !referral[2]) {
            const r = await live.referral(persona, comId);
            return r ? json(res, 200, r) : json(res, 404, { code: 'NOT_FOUND' });
          }
          if (method === 'POST' && referral[2]) {
            const r = await live.referralAction(persona, comId, await readBody<ReferralAction>(req));
            if (!r) return json(res, 404, { code: 'NOT_FOUND' });
            tell(r.notify);
            return json(res, 200, r.detail);
          }
        } catch (err) {
          if (err instanceof CoreError) return json(res, err.code === 'INVALID' ? 422 : 404, { code: err.code, message: err.message });
          throw err;
        }
      }
      // ---- reports (spec 8.5–8.9, 18) ----
      if (method === 'GET' && path === '/v1/reports') {
        const r = await live?.reports(persona);
        return r ? json(res, 200, r) : json(res, 404, { code: 'NOT_FOUND' });
      }
      if (method === 'POST' && path === '/v1/reports/run') {
        const body = await readBody<{ templateId: string; controls?: Record<string, string>; test?: boolean }>(req);
        try {
          const block = await live?.runReport(persona, body.templateId, body.controls ?? {}, body.test);
          return block ? json(res, 200, { block }) : json(res, 404, { code: 'NOT_FOUND' });
        } catch (err) {
          if (err instanceof CoreError) return json(res, 404, { code: 'NOT_FOUND', message: err.message });
          throw err;
        }
      }
      const reportEdit = /^\/v1\/reports\/([^/]+)\/edit$/.exec(path);
      if (method === 'POST' && reportEdit) {
        const body = await readBody<{ op: Parameters<LiveRuntime['editReport']>[2]; controls?: Record<string, string> }>(req);
        try {
          const block = await live?.editReport(persona, decodeURIComponent(reportEdit[1]!), body.op, body.controls ?? {});
          return block ? json(res, 200, { block }) : json(res, 404, { code: 'NOT_FOUND' });
        } catch (err) {
          if (err instanceof CoreError) return json(res, err.code === 'NO_ACCESS' ? 403 : 404, { code: err.code, message: err.message });
          throw err;
        }
      }
      if (method === 'POST' && path === '/v1/reports/schedules/run') {
        const r = await live?.runSchedules(persona);
        return r ? json(res, 200, { schedules: r }) : json(res, 404, { code: 'NOT_FOUND' });
      }
      const exportFile = /^\/v1\/exports\/([^/]+)$/.exec(path);
      if (method === 'GET' && exportFile) {
        try {
          const f = await live?.exportFile(persona, decodeURIComponent(exportFile[1]!));
          if (!f) return json(res, 404, { code: 'NOT_FOUND' });
          res.writeHead(200, { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${f.fileName}"`, 'cache-control': 'no-store' });
          res.end(f.body);
          return;
        } catch (err) {
          if (err instanceof CoreError) return json(res, 404, { code: 'NOT_FOUND', message: 'That export was not found.' });
          throw err;
        }
      }
      const member = /^\/v1\/members\/([^/]+)$/.exec(path);
      if (method === 'GET' && member) {
        try {
          const block = await live?.member(persona, decodeURIComponent(member[1]!));
          return block ? json(res, 200, { block }) : json(res, 404, { code: 'NOT_FOUND' });
        } catch (err) {
          // Outside the purview and not found give the same answer (spec 20.7).
          if (err instanceof CoreError) return json(res, 404, { code: 'NOT_FOUND', message: 'That record was not found, or it is outside your access.' });
          throw err;
        }
      }
      if (method === 'GET' && path === '/v1/notifications') {
        const all = [...notifications.filter((n) => n.userId === me()), ...(await currentNotices())];
        return json(res, 200, { notifications: all.sort((a, b) => b.at.localeCompare(a.at)) });
      }
      if (method === 'POST' && path === '/v1/notifications/read') {
        const { ids } = await readBody<{ ids: string[] }>(req);
        notifications = notifications.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n));
        for (const n of ids) readNotices.add(`${me()}:${n}`);
        return json(res, 204);
      }
      const table = /^\/v1\/tables\/([^/]+)$/.exec(path);
      if (method === 'GET' && table) {
        const tableId = decodeURIComponent(table[1]!);
        const data = (await live?.table(persona, tableId)) ?? tableFor(persona, tableId);
        return data ? json(res, 200, data) : json(res, 404, { code: 'NOT_FOUND' });
      }
      if (method === 'POST' && path === '/v1/stream/ticket') {
        const ticket = id('tkt_', 24);
        tickets.add(ticket);
        setTimeout(() => tickets.delete(ticket), 30_000);
        return json(res, 200, { ticket });
      }

      // ---- threads (spec 12.1) ----
      if (path === '/v1/threads') {
        if (method === 'GET') {
          const q = (url.searchParams.get('q') ?? '').toLowerCase();
          const archived = url.searchParams.get('archived') === 'true';
          const list = visibleThreads()
            .map((t) => t.summary)
            .filter((s) => s.archived === archived && s.title.toLowerCase().includes(q))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          return json(res, 200, { threads: list });
        }
        if (method === 'POST') {
          const body = await readBody<{ title?: string }>(req);
          return json(res, 201, thread(id('thr_', 12), body.title ?? 'New conversation').summary);
        }
      }
      const one = /^\/v1\/threads\/([^/]+)$/.exec(path);
      if (one) {
        const t = threads.get(decodeURIComponent(one[1]!));
        if (!t || t.deleted || foreign(t)) return json(res, 404, { code: 'NOT_FOUND' });
        if (method === 'GET') return json(res, 200, t.summary);
        if (method === 'PATCH') {
          const patch = await readBody<{ title?: string; archived?: boolean }>(req);
          if (patch.title !== undefined) t.summary.title = patch.title.slice(0, 120) || t.summary.title;
          if (patch.archived !== undefined) t.summary.archived = patch.archived;
          return json(res, 200, t.summary);
        }
        if (method === 'DELETE') {
          // Removed from the list only; the audit record of prompts and approvals is kept (spec 6.6).
          t.deleted = true;
          notifications = notifications.filter((n) => n.link !== `/c/${t.summary.threadId}`);
          return json(res, 204);
        }
      }
      const send = /^\/v1\/threads\/([^/]+)\/messages$/.exec(path);
      if (method === 'POST' && send) {
        const threadId = decodeURIComponent(send[1]!);
        if (foreign(threads.get(threadId))) return json(res, 404, { code: 'NOT_FOUND' });
        const body = await readBody<SendMessageRequest>(req);
        const t = thread(threadId);
        if (t.summary.turns === 0 && t.summary.title === 'New conversation') t.summary.title = titleFrom(body.input.text);
        t.summary.turns += 1;
        const messageId = id('msg_', 8);
        const runId = `R-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(2).toString('hex')}`;
        const accepted = emit(threadId, { type: 'message.accepted', messageId, clientMessageId: body.clientMessageId, text: body.input.text } as Emit);
        if (body.inputChannel === 'voice') speech?.begin(runId, threadId);
        // The resilience scenario stays scripted: it tests the protocol, not an agent.
        if (live && !/chaos|resilien|protocol/i.test(body.input.text)) void runLive(live, threadId, runId, body);
        else runScript(threadId, runId, pickScenario(body.input.text, body.context));
        return json(res, 202, { messageId, runId, threadId, seq: accepted.seq });
      }
      const cancel = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path);
      if (method === 'POST' && cancel) {
        cancelRun(decodeURIComponent(cancel[1]!));
        return json(res, 202, {});
      }
      const decision = /^\/v1\/approvals\/([^/]+)\/decision$/.exec(path);
      if (method === 'POST' && decision) {
        const body = await readBody<ApprovalDecisionRequest>(req);
        const key = req.headers['idempotency-key'];
        if (!key) return json(res, 400, { code: 'IDEMPOTENCY_KEY_REQUIRED' });
        const r = await decide(decodeURIComponent(decision[1]!), String(key), body);
        return json(res, r.status, r.body);
      }
      if (method === 'POST' && path === '/v1/auth/step-up') return json(res, 200, { stepUpToken: id('stp_', 20) });
      json(res, 404, { code: 'NOT_FOUND' });
    } catch (err) {
      json(res, 500, { code: 'INTERNAL', message: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const ticket = url.searchParams.get('ticket') ?? '';
    if (gate && !gate.allowed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // The voice socket uses the same one-time tickets as the stream (spec 12.7).
    if (url.pathname === '/v1/voice' && voice && tickets.delete(ticket)) {
      voice.handleUpgrade(req, socket, head, { vocabulary: [...BASE_VOCABULARY, ...(live?.vocabulary(persona) ?? [])] });
      return;
    }
    if (url.pathname !== '/v1/stream' || !tickets.delete(ticket)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  const replay = (ws: WebSocket, threadId: string, lastSeq: number) => {
    const t = threads.get(threadId);
    if (foreign(t)) return;
    for (const e of t?.events ?? []) if (e.seq > lastSeq) ws.send(JSON.stringify(e));
  };

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        ws.send(JSON.stringify({ type: 'welcome', sessionId: id('ses_', 12), serverTime: new Date().toISOString(), heartbeatSeconds: 20 }));
        const subs = new Set<string>();
        // Replay what the client missed (spec 11.6 resume), then join the live stream.
        for (const { threadId, lastSeq } of msg.resume) {
          subs.add(threadId);
          replay(ws, threadId, lastSeq);
        }
        sockets.set(ws, subs);
      } else if (msg.type === 'subscribe') {
        sockets.get(ws)?.add(msg.threadId);
        replay(ws, msg.threadId, msg.lastSeq);
      } else if (msg.type === 'unsubscribe') {
        sockets.get(ws)?.delete(msg.threadId);
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (msg.type === 'run.cancel') {
        cancelRun(msg.runId);
      }
    });
    ws.on('close', () => sockets.delete(ws));
  });

  server.listen(port);
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of runs.values()) {
          r.timers.forEach(clearTimeout);
          r.abort?.abort();
        }
        for (const a of approvals.values()) clearTimeout(a.expiryTimer);
        for (const ws of sockets.keys()) ws.terminate();
        wss.close();
        speech?.close();
        server.close(() => resolve());
      }),
  };
}

// ---- deployment: the built shell and a demo access gate --------------------------------------

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.webmanifest': 'application/manifest+json' };

/** Serves the built shell. Unknown paths get index.html, so deep links such as /c/thr_x work (spec 11.4). */
function staticFiles(dir: string) {
  const root = resolve(dir);
  return (path: string, res: ServerResponse) => {
    let decoded = '/';
    try {
      decoded = decodeURIComponent(path);
    } catch {
      // A malformed path is served the app, like any other unknown path.
    }
    const target = resolve(join(root, decoded));
    const inside = target.startsWith(root + sep) || target === root;
    const file = inside && existsSync(target) && statSync(target).isFile() ? target : join(root, 'index.html');
    const hashed = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // Hashed assets never change; the page itself is always revalidated.
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    createReadStream(file).pipe(res);
  };
}

/**
 * A shared access code for the demo deployment, so a public URL does not spend the Claude key for
 * anyone who finds it. It is not sign-in: Entra ID sign-in is on the backlog (spec 25.5).
 */
function demoGate(code: string) {
  const token = createHash('sha256').update(`dinext-demo:${code}`).digest('hex');
  const allowed = (req: IncomingMessage) => /(?:^|;\s*)di_demo=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')?.[1] === token;
  const page = (message = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DI Next demo</title>
<style>body{font:15px system-ui,sans-serif;background:#f5f7fa;color:#1f2937;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#fff;padding:32px;border-radius:12px;box-shadow:0 2px 12px #0001;display:grid;gap:12px;width:min(340px,90vw)}h1{font-size:20px;margin:0}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #6b7280}button{background:#057186;color:#fff;border:0;cursor:pointer}p{margin:0;color:#b42318}</style></head>
<body><form method="post" action="/demo-access"><h1>Kinective DI Next demo</h1><label for="c">Access code</label><input id="c" name="code" type="password" autocomplete="current-password" required autofocus>${message ? `<p role="alert">${message}</p>` : ''}<button type="submit">Continue</button></form></body></html>`;
  return {
    allowed,
    async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
      if (path === '/demo-access') {
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const given = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('code') ?? '';
          const a = createHash('sha256').update(given).digest();
          const b = createHash('sha256').update(code).digest();
          if (timingSafeEqual(a, b)) {
            const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
            res.writeHead(303, { location: '/', 'set-cookie': `di_demo=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}` });
            res.end();
            return true;
          }
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('That code is not right.'));
          return true;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page());
        return true;
      }
      if (allowed(req)) return false;
      if (path.startsWith('/v1/')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'DEMO_ACCESS_REQUIRED' }));
      } else {
        res.writeHead(303, { location: '/demo-access' });
        res.end();
      }
      return true;
    },
  };
}

/** Thread titles come from the first request (spec 6.6), trimmed to a readable length. */
function titleFrom(text: string): string {
  const clean = text.replace(/^\/\w+\s*/, '').trim();
  const t = clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
  return t ? t[0]!.toUpperCase() + t.slice(1) : 'New conversation';
}
