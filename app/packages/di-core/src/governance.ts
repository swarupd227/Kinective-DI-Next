// Trust and governance in DI Core: where a number comes from (spec 24.10) and what the AI did (8.21,
// 26.10). Lineage comes only from this catalog and the semantic model, never from a model's reading of
// names, so a table the catalog doesn't know shows as an unknown source (AI-AGT-100).
import type { Pool } from '@dinext/tenant-db';
import { CHECK_NAMES } from './modules2.ts';
import { CoreError } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

export interface CatalogEntry {
  label: string;
  /** A month-end table is built from a current one. */
  rollupOf?: string;
  load?: string;
  /** The uploader that delivers it, in ops_upload. */
  upload?: string;
  file?: string;
  system?: string;
  /** Data quality domains that check it. */
  domains: string[];
}

export const LINEAGE_CATALOG: Record<string, CatalogEntry> = {
  cdm_loan: { label: 'Loan accounts', load: 'Nightly core load', upload: 'Core extract', file: 'core_extract', system: 'Core processor', domains: ['Core Integration', 'Lending'] },
  cdm_deposit_account: { label: 'Deposit accounts', load: 'Nightly core load', upload: 'Core extract', file: 'core_extract', system: 'Core processor', domains: ['Core Integration', 'Deposits'] },
  cdm_party: { label: 'Members and customers', load: 'Nightly core load', upload: 'Core extract', file: 'core_extract', system: 'Core processor', domains: ['Core Integration'] },
  cdm_loan_application: { label: 'Loan applications', load: 'Nightly LOS load', upload: 'LOS feed', file: 'los_feed', system: 'Loan origination system', domains: ['Lending'] },
  hist_loan_month: { label: 'Loan history, month-end', rollupOf: 'cdm_loan', domains: ['Lending'] },
  hist_deposit_month: { label: 'Deposit history, month-end', rollupOf: 'cdm_deposit_account', domains: ['Deposits'] },
  hist_party_month: { label: 'Member history, month-end', rollupOf: 'cdm_party', domains: ['Core Integration'] },
  hist_lap_month: { label: 'Application history, month-end', rollupOf: 'cdm_loan_application', domains: ['Lending'] },
};

/** What lineage needs from the semantic model. */
export interface LineageModel {
  sources: Record<string, { table: string; alias: string }>;
  measures: Record<string, { exprs: Record<string, string> }>;
  metrics: Record<string, { name: string; label: string; description: string; regulatoryBasis?: string; synonyms: string[]; measures: string[] }>;
}

export type DqState = { state: 'passed' | 'failed' | 'unknown'; passed: number; failed: number };

export interface LineageNode {
  kind: 'table' | 'rollup' | 'load' | 'file' | 'source' | 'unknown';
  label: string;
  detail?: string;
  lastLoad?: string;
  dq?: DqState;
}

/** Columns a measure reads from one source, taken from its SQL. */
const columnsIn = (expr: string, alias: string) => [...expr.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))].map((m) => m[1]!);

export class LineageService {
  constructor(
    private readonly pool: Pool,
    private readonly model: LineageModel,
    private readonly catalog = LINEAGE_CATALOG,
    /** Curated tables a direct core connection feeds, in place of the extract file. */
    private readonly feeds?: () => Promise<Map<string, { name: string; system: string; theirTables: string[]; lastPull: string | null; since: string | null; schedule: string }>>,
  ) {}

  /** The metric a question names, by its longest matching name or synonym. */
  find(text: string) {
    const t = text.toLowerCase();
    let best: { name: string; length: number } | null = null;
    for (const m of Object.values(this.model.metrics)) {
      for (const term of [m.label, m.name, ...m.synonyms]) {
        const hit = new RegExp(`\\b${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\W)`).test(t);
        if (hit && term.length > (best?.length ?? 0)) best = { name: m.name, length: term.length };
      }
    }
    if (!best) throw new CoreError('INVALID', 'Which number do you mean? Name the measure, such as total loan balance or delinquency.');
    return this.model.metrics[best.name]!;
  }

  private columnsFor(measures: string[]) {
    const found = new Map<string, Set<string>>();
    for (const name of measures) {
      for (const [source, expr] of Object.entries(this.model.measures[name]?.exprs ?? {})) {
        const s = this.model.sources[source];
        if (!s) continue;
        const columns = found.get(s.table) ?? new Set<string>();
        for (const c of columnsIn(expr, s.alias)) columns.add(c);
        found.set(s.table, columns);
      }
    }
    return found;
  }

  private async health() {
    const [build] = await rows<{ as_of_date: unknown }>(this.pool, 'SELECT as_of_date FROM meta_build ORDER BY as_of_date DESC LIMIT 1');
    const asOf = String(build?.as_of_date instanceof Date ? build.as_of_date.toISOString() : build?.as_of_date).slice(0, 10);
    const uploads = await rows<{ source: string; arrived: string }>(this.pool, 'SELECT source, arrived FROM ops_upload');
    const checks = await rows<{ domain: string; dimension: string; name: string; status: string; rows_failed: number }>(this.pool, 'SELECT domain, dimension, name, status, rows_failed FROM ops_dq_check ORDER BY domain, name');
    // People read what a check means, not its rule ("loan.branch_id not null").
    return { asOf, uploads, checks: checks.map((c) => ({ ...c, name: CHECK_NAMES[c.name] ?? c.name })) };
  }

  /** A metric traced to its sources, one lane per table it reads. */
  async trace(name: string) {
    const metric = this.model.metrics[name];
    if (!metric) throw new CoreError('NOT_FOUND', `There’s no measure called ${name}.`);
    const { asOf, uploads, checks } = await this.health();
    const dqFor = (domains: string[]): DqState => {
      const own = checks.filter((c) => domains.includes(c.domain));
      const failed = own.filter((c) => c.status !== 'Pass').length;
      return { state: !own.length ? 'unknown' : failed ? 'failed' : 'passed', passed: own.length - failed, failed };
    };
    const lastLoad = (upload: string | undefined) => {
      const u = uploads.find((x) => x.source === upload);
      return u ? `${asOf} ${u.arrived}` : undefined;
    };
    const stamp = asOf.replaceAll('-', '');
    const lanes: { nodes: LineageNode[] }[] = [];
    const unknown: string[] = [];
    const domains = new Set<string>();
    const columns = this.columnsFor(metric.measures);
    const fed = (await this.feeds?.().catch(() => null)) ?? new Map();
    for (const [table, cols] of columns) {
      const entry = this.catalog[table];
      const detail = cols.size ? [...cols].join(', ') : undefined;
      if (!entry) {
        unknown.push(table);
        lanes.push({ nodes: [{ kind: 'table', label: table, detail, dq: { state: 'unknown', passed: 0, failed: 0 } }, { kind: 'unknown', label: 'Unknown source', detail: 'No lineage recorded' }] });
        continue;
      }
      const base = entry.rollupOf ? this.catalog[entry.rollupOf] : entry;
      for (const d of [...entry.domains, ...(base?.domains ?? [])]) domains.add(d);
      const feed = fed.get(entry.rollupOf ?? table);
      if (feed) {
        // A direct connection replaced the extract file for this table.
        // Today's figures still came from the last build; the switch takes effect with the next one.
        const nodes: LineageNode[] = [{ kind: 'table', label: entry.label, detail: `${table}${detail ? `: ${detail}` : ''}`, dq: dqFor(entry.domains), lastLoad: lastLoad(base?.upload) }];
        if (entry.rollupOf) nodes.push({ kind: 'rollup', label: 'Month-end rollup', detail: `From ${entry.rollupOf}` });
        nodes.push({ kind: 'load', label: `${feed.name} sync`, detail: `Read-only, ${feed.schedule.toLowerCase()}. Replaces the core extract file from the next build${feed.lastPull ? `; last pulled ${feed.lastPull} UTC` : ''}` });
        nodes.push({ kind: 'source', label: `${feed.system} replica`, detail: feed.theirTables.join(' + ') });
        lanes.push({ nodes });
        continue;
      }
      const nodes: LineageNode[] = [{ kind: 'table', label: entry.label, detail: `${table}${detail ? `: ${detail}` : ''}`, dq: dqFor(entry.domains), lastLoad: lastLoad(base?.upload) }];
      if (entry.rollupOf) nodes.push({ kind: 'rollup', label: 'Month-end rollup', detail: `From ${entry.rollupOf}` });
      if (base?.load) nodes.push({ kind: 'load', label: base.load, lastLoad: lastLoad(base.upload), dq: dqFor(base.domains) });
      if (base?.file) nodes.push({ kind: 'file', label: `${base.file}_${stamp}.txt` });
      if (base?.system) nodes.push({ kind: 'source', label: base.system });
      else nodes.push({ kind: 'unknown', label: 'Unknown source', detail: 'No lineage recorded' });
      lanes.push({ nodes });
    }
    const own = checks.filter((c) => domains.has(c.domain)).map((c) => ({ domain: c.domain, dimension: c.dimension, name: c.name, passed: c.status === 'Pass', rowsFailed: c.rows_failed }));
    return { metric, lanes, unknown, checks: own, asOf };
  }

  /** What depends on a table or column. Metrics from the model, reports from their stored definitions. */
  async impact(target: string) {
    const t = target.toLowerCase().trim();
    const [table, column] = t.includes('.') ? (t.split('.') as [string, string]) : [t, undefined];
    const metrics = Object.values(this.model.metrics).filter((m) => {
      for (const [tbl, cols] of this.columnsFor(m.measures)) {
        if (column ? tbl === table && cols.has(column) : tbl === table || cols.has(table)) return true;
      }
      return false;
    });
    if (!metrics.length) throw new CoreError('NOT_FOUND', `Nothing in the catalog reads ${target}. That doesn’t prove nothing else does.`);
    const templates = await rows<{ name: string; definition: unknown }>(this.pool, 'SELECT name, definition FROM esp_report_templates');
    const reports = templates.filter((r) => metrics.some((m) => JSON.stringify(r.definition).includes(`"${m.name}"`))).map((r) => r.name);
    return { metrics, reports };
  }
}

// ---- AI usage -----------------------------------------------------------------------------------

export interface RunEntry {
  runId: string;
  at: string;
  userId: string;
  threadId: string;
  agent: string;
  intent: string;
  mode: string;
  question: string;
  outcome: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  toolCalls: unknown[];
}

export type UsageGroup = 'user' | 'class' | 'agent' | 'model';

const GROUPS: Record<UsageGroup, string> = { user: "COALESCE(u.name, r.user_id)", class: "COALESCE(u.user_class, 'Unknown')", agent: 'r.agent', model: "COALESCE(r.model, 'No model')" };

const stamp = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).replace('T', ' ').slice(0, 16);

export class GovernanceService {
  constructor(private readonly pool: Pool) {}

  /** Add-only: the application account has no UPDATE on these tables. */
  async record(r: RunEntry) {
    await this.pool.query('INSERT IGNORE INTO ai_run (run_id, at, user_id, thread_id, agent, intent, mode, question, outcome, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, tool_calls, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [r.runId, r.at.replace('T', ' ').replace('Z', ''), r.userId, r.threadId, r.agent.slice(0, 60), r.intent.slice(0, 40), r.mode, r.question.slice(0, 500), r.outcome, r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.costUsd, JSON.stringify(r.toolCalls), 'live']);
  }

  /** A person's rating of an answer. A later rating of the same run replaces it in reports. */
  async feedback(f: { runId: string; userId: string; rating: 'up' | 'down'; comment?: string }) {
    await this.pool.query('INSERT INTO ai_feedback (run_id, user_id, at, rating, comment) VALUES (?, ?, UTC_TIMESTAMP(3), ?, ?)', [f.runId, f.userId, f.rating, f.comment?.trim().slice(0, 500) || null]);
  }

  /** The newest month with activity, for one person or everyone. */
  async latestMonth(userId?: string) {
    const [r] = await rows<{ m: string | null }>(this.pool, `SELECT DATE_FORMAT(MAX(at), '%Y-%m') AS m FROM ai_run${userId ? ' WHERE user_id = ?' : ''}`, userId ? [userId] : []);
    return r?.m ?? null;
  }

  async usage(month: string, group: UsageGroup) {
    const list = await rows<Record<string, unknown>>(this.pool, `SELECT ${GROUPS[group]} AS grp, COUNT(*) AS prompts, SUM(r.input_tokens + r.output_tokens) AS tokens, SUM(r.cost_usd) AS cost, SUM(JSON_LENGTH(r.tool_calls)) AS tools, SUM(COALESCE(a.n, 0)) AS approvals FROM ai_run r LEFT JOIN iam_user u ON u.user_id = r.user_id LEFT JOIN (SELECT run_id, COUNT(*) AS n FROM ai_approvals GROUP BY run_id) a ON a.run_id = r.run_id WHERE DATE_FORMAT(r.at, '%Y-%m') = ? GROUP BY grp ORDER BY cost DESC`, [month]);
    const items = list.map((r) => ({ name: r.grp as string, prompts: Number(r.prompts), tokens: Number(r.tokens), cost: Number(r.cost), tools: Number(r.tools), approvals: Number(r.approvals) }));
    const sum = (k: 'prompts' | 'tokens' | 'cost' | 'tools' | 'approvals') => items.reduce((n, i) => n + i[k], 0);
    return { items, totals: { prompts: sum('prompts'), tokens: sum('tokens'), cost: sum('cost'), tools: sum('tools'), approvals: sum('approvals') } };
  }

  async own(userId: string, month: string) {
    const [r] = await rows<Record<string, unknown>>(this.pool, "SELECT COUNT(*) AS prompts, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost FROM ai_run WHERE user_id = ? AND DATE_FORMAT(at, '%Y-%m') = ?", [userId, month]);
    return { prompts: Number(r?.prompts), tokens: Number(r?.tokens), cost: Number(r?.cost) };
  }

  /** One run, every step of it. Purview: your own, unless you hold the admin permission. */
  async trace(runId: string, viewer: { userId: string; all: boolean }) {
    const [r] = await rows<Record<string, unknown>>(this.pool, 'SELECT r.*, u.name AS user_name FROM ai_run r LEFT JOIN iam_user u ON u.user_id = r.user_id WHERE r.run_id = ?', [runId]);
    if (!r || (!viewer.all && r.user_id !== viewer.userId)) throw new CoreError('NOT_FOUND', `There’s no run ${runId} that you can see.`);
    const approvals = await rows<Record<string, unknown>>(this.pool, 'SELECT a.operation, a.risk_tier, a.status, a.channel, COALESCE(u.name, a.decided_by) AS decided_by FROM ai_approvals a LEFT JOIN iam_user u ON u.user_id = a.decided_by WHERE a.run_id = ? ORDER BY a.created_at', [runId]);
    const tools = (typeof r.tool_calls === 'string' ? JSON.parse(r.tool_calls) : r.tool_calls) as { name: string; input?: unknown; ok: boolean; ms?: number; error?: string }[];
    return { runId, at: stamp(r.at), user: (r.user_name ?? r.user_id) as string, agent: r.agent as string, model: r.model as string | null, question: r.question as string, outcome: r.outcome as string, inputTokens: r.input_tokens as number, outputTokens: r.output_tokens as number, cost: Number(r.cost_usd), tools, approvals: approvals.map((a) => ({ operation: a.operation as string, risk: a.risk_tier as string, status: a.status as string, by: (a.decided_by as string | null) ?? 'Undecided', channel: (a.channel as string | null) ?? '—' })) };
  }

  async approvals(month: string, risk?: string) {
    const list = await rows<Record<string, unknown>>(this.pool, `SELECT a.approval_id, a.operation, a.payload, a.risk_tier, a.status, a.run_id, a.decided_at, a.channel, COALESCE(u.name, a.decided_by) AS decided_by FROM ai_approvals a LEFT JOIN iam_user u ON u.user_id = a.decided_by WHERE a.decided_by IS NOT NULL AND DATE_FORMAT(a.decided_at, '%Y-%m') = ?${risk ? ' AND a.risk_tier = ?' : ''} ORDER BY a.decided_at DESC LIMIT 50`, risk ? [month, risk] : [month]);
    return list.map((a) => {
      const payload = (typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload) as { summary?: string };
      return { summary: payload.summary ?? (a.operation as string), risk: a.risk_tier as string, status: a.status as string, by: a.decided_by as string, at: stamp(a.decided_at), channel: (a.channel as string | null) ?? '—', runId: a.run_id as string };
    });
  }

  /** Each person's latest rating per run. Thumbs down lead the queue. */
  async feedbackQueue() {
    const list = await rows<Record<string, unknown>>(this.pool, 'SELECT f.run_id, f.rating, f.comment, f.at, COALESCE(u.name, f.user_id) AS name, r.agent, r.question FROM ai_feedback f JOIN (SELECT run_id, user_id, MAX(feedback_id) AS id FROM ai_feedback GROUP BY run_id, user_id) l ON l.id = f.feedback_id LEFT JOIN iam_user u ON u.user_id = f.user_id LEFT JOIN ai_run r ON r.run_id = f.run_id ORDER BY f.rating = \'down\' DESC, f.at DESC LIMIT 50');
    return list.map((f) => ({ runId: f.run_id as string, rating: f.rating as string, comment: (f.comment as string | null) ?? '', at: stamp(f.at), by: f.name as string, agent: (f.agent as string | null) ?? '—', question: (f.question as string | null) ?? '—' }));
  }
}
