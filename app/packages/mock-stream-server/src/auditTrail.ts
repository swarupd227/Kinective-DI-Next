// Reads the Agent Audit Log (spec 26.10, AI-GRD-090) from the permanent audit store: every agent run
// with who asked, which agent answered and how it ended, and for one run its whole trace. The trace
// merges the run's own timeline with what happened to it afterwards, such as an approval decided an
// hour later and the change it made. Access is decided by the caller; this only reads.
import type { AuditLogPage, AuditRunSummary, AuditRunTrace, AuditTraceEntry } from '@dinext/block-schemas';
import { AUDIT_SCHEMA, createPool, type Pool } from '@dinext/tenant-db';

export interface AuditFilter {
  /** Only this person's runs. */
  userId?: string;
  agent?: string;
  outcome?: string;
  /** Runs from the last 1, 7, 30 or 90 days. */
  days?: number;
  q?: string;
  limit?: number;
  offset?: number;
}

interface Line {
  at: string;
  tenant: string;
  userId?: string;
  threadId?: string;
  runId?: string;
  question?: string;
  maskedIdentifiers?: number;
  route?: { intent?: string; agent?: string; confidence?: number | null; mode?: string; label?: string };
  outcome?: string;
  error?: string;
  modelVersion?: string;
  buildId?: string;
  usage?: { model: string; role: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }[];
  totalCostUsd?: number;
  toolCalls?: { name: string; input: unknown; ok: boolean; ms: number; error?: string; resultRef?: string }[];
  numericRemovals?: string[];
  startedAt?: string;
  durationMs?: number;
  agentName?: string;
  trace?: TraceLine[];
  traceTruncated?: boolean;
}

type TraceLine =
  | { t: number; kind: 'routing'; agent: string; reason?: string }
  | { t: number; kind: 'plan'; agent: string; title: string; steps: string[] }
  | { t: number; kind: 'step'; agent?: string; label?: string; state: string; operation?: string; result?: string }
  | { t: number; kind: 'text'; agent: string; chars: number; excerpt: string; sources: string[] }
  | { t: number; kind: 'block'; agent: string; type: string; title?: string; operations: string[]; sources: string[]; rows?: number }
  | { t: number; kind: 'suggestion'; text: string };

/** The friendly names of the Concierge's own routes, for runs that recorded only the route. */
const ROUTE_NAMES: Record<string, string> = { analytics_qa: 'Analytics Q&A', analytics: 'Analytics Q&A', report_builder: 'Report Builder', referral: 'Referrals', relationship: 'Relationship', goal: 'DI', dashboard_briefing: 'Briefing', dashboard: 'Briefing', none: 'DI Concierge' };
const agentOf = (l: Line) => l.agentName ?? l.route?.label ?? ROUTE_NAMES[l.route?.agent ?? ''] ?? l.route?.agent ?? 'DI Concierge';
const AGENT_SQL = "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.body, '$.agentName')), JSON_UNQUOTE(JSON_EXTRACT(e.body, '$.route.label')), JSON_UNQUOTE(JSON_EXTRACT(e.body, '$.route.agent')))";
const OUTCOME_SQL = "JSON_UNQUOTE(JSON_EXTRACT(e.body, '$.outcome'))";
const iso = (sql: string) => `${sql.replace(' ', 'T')}Z`;
const sqlTime = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
const STEP_STATUS: Record<string, AuditTraceEntry['status']> = { done: 'ok', failed: 'failed', skipped: 'skipped', running: 'started', needs_input: 'waiting' };
const OUTCOME_TEXT: Record<string, string> = { answer: 'Answered', unmatched: 'No defined measure answers this', clarify: 'Asked which was meant', not_supported: 'Outside what DI does', no_access: 'Refused: outside the person’s access', failed: 'Failed', cancelled: 'Stopped by the person', scripted: 'Answered by a sample scenario', approval_requested: 'Waiting on an approval', not_found: 'Not found' };

export class AuditTrail {
  private readonly pool: Pool;

  constructor(
    private readonly tenant: string,
    /** The tenant's schema, for people's names. */
    private readonly schema: string,
    pool?: Pool,
  ) {
    this.pool = pool ?? createPool(undefined, { connectionLimit: 2 });
  }

  /** False when the audit store isn't there yet. */
  async available() {
    return this.pool.query(`SELECT 1 FROM \`${AUDIT_SCHEMA}\`.ai_audit_event LIMIT 1`).then(
      () => true,
      () => false,
    );
  }

  private async names(ids: string[]) {
    const out = new Map<string, string>();
    const want = [...new Set(ids.filter(Boolean))];
    if (!want.length) return out;
    const [rows] = (await this.pool.query(`SELECT user_id, name FROM \`${this.schema}\`.iam_user WHERE user_id IN (?)`, [want]).catch(() => [[]])) as unknown as [{ user_id: string; name: string }[]];
    for (const r of rows) out.set(r.user_id, r.name);
    return out;
  }

  async runs(f: AuditFilter, everyone: boolean): Promise<AuditLogPage> {
    const where = ["e.tenant_id = ?", "e.event_type = 'ai.run'"];
    const args: unknown[] = [this.tenant];
    if (f.userId) {
      where.push('e.user_id = ?');
      args.push(f.userId);
    }
    if (f.days) {
      where.push('e.at >= ?');
      args.push(sqlTime(new Date(Date.now() - f.days * 86_400_000)));
    }
    // What the filters can choose from: everything in the period, before the agent, outcome and text filters.
    const base = { where: [...where], args: [...args] };
    if (f.agent) {
      // A run that recorded only its route (analytics_qa) is found by the name people know too.
      where.push(`${AGENT_SQL} IN (?)`);
      args.push([f.agent, ...Object.entries(ROUTE_NAMES).filter(([, name]) => name === f.agent).map(([key]) => key)]);
    }
    if (f.outcome === 'problems') where.push(`${OUTCOME_SQL} IN ('failed', 'no_access', 'unmatched', 'not_supported', 'cancelled')`);
    else if (f.outcome) {
      where.push(`${OUTCOME_SQL} = ?`);
      args.push(f.outcome);
    }
    if (f.q) {
      where.push("(LOWER(CONVERT(JSON_UNQUOTE(JSON_EXTRACT(e.body, '$.question')) USING utf8mb4)) LIKE ? OR e.run_id = ?)");
      args.push(`%${f.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`, f.q.trim());
    }
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const offset = Math.max(f.offset ?? 0, 0);
    const approvalsOf = `(SELECT COUNT(*) FROM \`${AUDIT_SCHEMA}\`.ai_audit_event a WHERE a.tenant_id = e.tenant_id AND a.run_id = e.run_id AND a.event_type = 'ai.approval.requested')`;
    const [[rows], [[totals]], [agents], [people], [[first]]] = (await Promise.all([
      this.pool.query(`SELECT e.run_id, e.at, e.user_id, e.thread_id, e.body, ${approvalsOf} AS approvals FROM \`${AUDIT_SCHEMA}\`.ai_audit_event e WHERE ${where.join(' AND ')} ORDER BY e.at DESC, e.event_id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]),
      this.pool.query(
        `SELECT COUNT(*) AS runs, SUM(${OUTCOME_SQL} = 'failed') AS failed, SUM(${OUTCOME_SQL} = 'no_access') AS refused, COALESCE(SUM(${approvalsOf}), 0) AS approvals, COALESCE(SUM(JSON_EXTRACT(e.body, '$.totalCostUsd')), 0) AS cost FROM \`${AUDIT_SCHEMA}\`.ai_audit_event e WHERE ${where.join(' AND ')}`,
        args,
      ),
      this.pool.query(`SELECT DISTINCT ${AGENT_SQL} AS agent FROM \`${AUDIT_SCHEMA}\`.ai_audit_event e WHERE ${base.where.join(' AND ')} ORDER BY agent`, base.args),
      this.pool.query(`SELECT DISTINCT e.user_id FROM \`${AUDIT_SCHEMA}\`.ai_audit_event e WHERE ${base.where.join(' AND ')}`, base.args),
      this.pool.query(`SELECT MIN(at) AS at FROM \`${AUDIT_SCHEMA}\`.ai_audit_event WHERE tenant_id = ?`, [this.tenant]),
    ])) as unknown as [
      [{ run_id: string; at: string; user_id: string; thread_id: string | null; body: string; approvals: number }[]],
      [[{ runs: number; failed: number | null; refused: number | null; approvals: number | string; cost: number | string }]],
      [{ agent: string | null }[]],
      [{ user_id: string }[]],
      [[{ at: string | null }]],
    ];
    const names = await this.names([...rows.map((r) => r.user_id), ...people.map((p) => p.user_id)]);
    const items: AuditRunSummary[] = rows.map((r) => {
      const l = JSON.parse(r.body) as Line;
      return {
        runId: r.run_id,
        at: iso(r.at),
        user: { id: r.user_id, name: names.get(r.user_id) ?? r.user_id },
        threadId: r.thread_id ?? '',
        agent: agentOf(l),
        question: l.question ?? '',
        outcome: l.outcome ?? 'answer',
        durationMs: l.durationMs ?? null,
        tokens: (l.usage ?? []).reduce((n, u) => n + u.inputTokens + u.outputTokens, 0),
        costUsd: l.totalCostUsd ?? 0,
        toolCalls: l.toolCalls?.length ?? 0,
        steps: l.trace?.length ?? 0,
        approvals: Number(r.approvals),
      };
    });
    return {
      everyone,
      items,
      total: Number(totals.runs),
      totals: { runs: Number(totals.runs), failed: Number(totals.failed ?? 0), refused: Number(totals.refused ?? 0), approvals: Number(totals.approvals), costUsd: Math.round(Number(totals.cost) * 1e6) / 1e6 },
      agents: agents.map((a) => (a.agent ? (ROUTE_NAMES[a.agent] ?? a.agent) : 'DI Concierge')).filter((a, i, all) => all.indexOf(a) === i),
      people: people.map((p) => ({ id: p.user_id, name: names.get(p.user_id) ?? p.user_id })).sort((a, b) => a.name.localeCompare(b.name)),
      since: first?.at ? iso(first.at) : null,
    };
  }

  /** One run's whole record, or null when it isn't in the audit store or the usage ledger. */
  async trace(runId: string): Promise<(AuditRunTrace & { ownerId: string }) | null> {
    const [lines] = (await this.pool.query(`SELECT event_type, at, user_id, body FROM \`${AUDIT_SCHEMA}\`.ai_audit_event WHERE tenant_id = ? AND run_id = ? ORDER BY at, event_id`, [this.tenant, runId])) as unknown as [{ event_type: string; at: string; user_id: string | null; body: string }[]];
    const runLine = lines.find((l) => l.event_type === 'ai.run');
    if (!runLine) return this.fromLedger(runId);
    const l = JSON.parse(runLine.body) as Line;
    const names = await this.names(lines.map((x) => x.user_id ?? ''));
    const name = (id: string | null | undefined) => (id ? (names.get(id) ?? id) : 'Someone');
    const started = l.startedAt ?? l.at;
    const t0 = Date.parse(started);
    const timeline: AuditTraceEntry[] = [{ at: started, offsetMs: 0, kind: 'question', title: `${name(l.userId)} asked`, detail: l.question, status: 'ok' }];
    for (const e of l.trace ?? []) timeline.push(fromTrace(e, t0));
    timeline.push({ at: l.at, offsetMs: l.durationMs ?? Date.parse(l.at) - t0, kind: 'outcome', title: OUTCOME_TEXT[l.outcome ?? 'answer'] ?? l.outcome ?? 'Answered', detail: l.error, status: l.outcome === 'failed' ? 'failed' : 'ok' });
    // What happened to the run afterwards: approvals, the changes they made, records opened.
    for (const x of lines) {
      if (x.event_type === 'ai.run' || x.event_type === 'ai.trace.viewed') continue;
      const e = fromEvent(x.event_type, JSON.parse(x.body) as Record<string, unknown>, name(x.user_id));
      if (e) timeline.push({ ...e, at: iso(x.at), offsetMs: Date.parse(iso(x.at)) - t0 });
    }
    timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return {
      ownerId: l.userId ?? '',
      runId,
      at: iso(runLine.at),
      durationMs: l.durationMs ?? null,
      user: { id: l.userId ?? '', name: name(l.userId) },
      threadId: l.threadId ?? '',
      question: l.question ?? '',
      maskedIdentifiers: l.maskedIdentifiers ?? 0,
      agent: agentOf(l),
      route: { intent: l.route?.intent ?? 'unclear', agent: l.route?.agent ?? 'none', confidence: l.route?.confidence ?? null, mode: l.route?.mode ?? 'live' },
      outcome: l.outcome ?? 'answer',
      error: l.error,
      modelVersion: l.modelVersion,
      buildId: l.buildId,
      usage: l.usage ?? [],
      costUsd: l.totalCostUsd ?? 0,
      toolCalls: (l.toolCalls ?? []).map((c) => ({ name: c.name, input: c.input, ok: c.ok, ms: c.ms, error: c.error, resultRef: c.resultRef })),
      numericRemovals: l.numericRemovals ?? [],
      timeline,
      partial: !l.trace,
      truncated: Boolean(l.traceTruncated),
    };
  }

  /** A run from before the audit store: the usage ledger's summary of it. */
  private async fromLedger(runId: string): Promise<(AuditRunTrace & { ownerId: string }) | null> {
    const [rows] = (await this.pool.query(`SELECT r.*, u.name AS user_name FROM \`${this.schema}\`.ai_run r LEFT JOIN \`${this.schema}\`.iam_user u ON u.user_id = r.user_id WHERE r.run_id = ?`, [runId]).catch(() => [[]])) as unknown as [Record<string, unknown>[]];
    const r = rows[0];
    if (!r) return null;
    const at = iso(String(r.at));
    const tools = (typeof r.tool_calls === 'string' ? JSON.parse(r.tool_calls) : (r.tool_calls ?? [])) as { name: string; input?: unknown; ok: boolean; ms?: number; error?: string }[];
    const userName = String(r.user_name ?? r.user_id);
    return {
      ownerId: String(r.user_id),
      runId,
      at,
      durationMs: null,
      user: { id: String(r.user_id), name: userName },
      threadId: String(r.thread_id ?? ''),
      question: String(r.question ?? ''),
      maskedIdentifiers: 0,
      agent: String(r.agent ?? 'DI Concierge'),
      route: { intent: String(r.intent ?? ''), agent: String(r.agent ?? ''), confidence: null, mode: String(r.mode ?? '') },
      outcome: String(r.outcome ?? 'answer'),
      usage: r.model ? [{ model: String(r.model), role: 'answer', inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), cacheReadTokens: Number(r.cache_read_tokens), costUsd: Number(r.cost_usd) }] : [],
      costUsd: Number(r.cost_usd ?? 0),
      toolCalls: tools.map((c) => ({ name: c.name, input: c.input ?? {}, ok: c.ok, ms: c.ms ?? 0, error: c.error })),
      numericRemovals: [],
      timeline: [
        { at, offsetMs: null, kind: 'question', title: `${userName} asked`, detail: String(r.question ?? ''), status: 'ok' },
        { at, offsetMs: null, kind: 'outcome', title: OUTCOME_TEXT[String(r.outcome)] ?? String(r.outcome), status: r.outcome === 'failed' ? 'failed' : 'ok' },
      ],
      partial: true,
      truncated: false,
    };
  }

  async close() {
    await this.pool.end().catch(() => {});
  }
}

function fromTrace(e: TraceLine, t0: number): AuditTraceEntry {
  const at = new Date(t0 + e.t).toISOString();
  const base = { at, offsetMs: e.t };
  switch (e.kind) {
    case 'routing':
      return { ...base, kind: 'routing', title: `Routed to ${e.agent}`, detail: e.reason, agent: e.agent, status: 'ok' };
    case 'plan':
      return { ...base, kind: 'plan', title: `Planned: ${e.title}`, detail: e.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), agent: e.agent, status: 'ok' };
    case 'step':
      return { ...base, kind: 'step', title: e.label ?? 'Step', detail: e.result, agent: e.agent, operation: e.operation, status: STEP_STATUS[e.state] ?? 'ok' };
    case 'text':
      return { ...base, kind: 'text', title: `${e.agent} wrote ${e.chars.toLocaleString('en-US')} characters`, detail: e.excerpt, agent: e.agent, sources: e.sources, status: 'ok' };
    case 'block':
      return { ...base, kind: 'block', title: `Showed ${e.title ? `“${e.title}”` : `a ${e.type.replaceAll('_', ' ')}`}${e.rows !== undefined ? `, ${e.rows.toLocaleString('en-US')} ${e.rows === 1 ? 'row' : 'rows'}` : ''}`, detail: e.type.replaceAll('_', ' '), agent: e.agent, operation: e.operations.join(', ') || undefined, sources: e.sources, status: 'ok' };
    case 'suggestion':
      return { ...base, kind: 'suggestion', title: 'Offered a follow-up', detail: e.text, status: 'ok' };
  }
}

function fromEvent(type: string, b: Record<string, unknown>, who: string): Omit<AuditTraceEntry, 'at' | 'offsetMs'> | null {
  const op = typeof b.operation === 'string' ? b.operation : undefined;
  if (type === 'ai.approval.requested') return { kind: 'approval', title: 'Approval requested', detail: `${String(b.riskTier ?? '')} risk`.trim(), operation: op, status: 'waiting' };
  if (type === 'ai.approval.superseded') return { kind: 'approval', title: 'Approval replaced by a newer draft', status: 'skipped' };
  if (type === 'ai.approval.rejected') return { kind: 'approval', title: `${who}’s decision was refused`, detail: String(b.error ?? ''), status: 'failed' };
  const decided = /^ai\.approval\.(approved|denied|returned|expired)$/.exec(type)?.[1];
  if (decided) return { kind: 'approval', title: decided === 'expired' ? 'Approval expired' : `${who} ${decided === 'returned' ? 'sent it back' : decided}`, detail: [b.channel ? `by ${String(b.channel)}` : '', b.note ? `note: ${String(b.note)}` : ''].filter(Boolean).join(', ') || undefined, status: decided === 'approved' ? 'ok' : 'skipped' };
  if (type === 'ai.action.executed') return { kind: 'action', title: 'Change made', detail: b.resultRef ? `Result ${String(b.resultRef)}` : undefined, operation: op, status: 'ok' };
  if (type === 'ai.action.failed') return { kind: 'action', title: 'Change failed; nothing was changed', detail: String(b.error ?? ''), status: 'failed' };
  if (type === 'relationship.profile.viewed') return { kind: 'record', title: 'Opened a member record', detail: `Internal party ${String(b.partyId)} (via ${String(b.via ?? 'agent')})`, status: 'ok' };
  return { kind: 'action', title: type, status: 'ok' };
}
