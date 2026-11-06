// API connections (spec Integrations > APIs [SCR 46–52]; backlog EP11-F06): DI calls an external REST
// service with saved sign-in details, keeps a request log with secrets removed, and runs saved
// requests that page through results and remember where the last pull stopped.
// - The secret is sealed here and never returned. Agents refer to sign-in details by number.
// - Only hosts on the institution's list can be called. A call to any other host is refused, and the
//   refusal is logged.
// - Request and response bodies with personal data are stored sealed and kept 30 days.
// - The marketing round trip: an approved audience goes to the platform under references, not member
//   numbers; the platform's results come back into DI, where clicks are matched to members.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { RELAY_HOST, type Pool } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';
import { relayPlatform, type HttpResponse } from './relaySim.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const nowSql = (d = new Date()) => d.toISOString().slice(0, 23).replace('T', ' ');
const ALGO = 'aes-256-gcm';
const SECRET_NAME = /authorization|api[-_]?key|token|cookie|secret|password|signature/i;
export const REDACTED = '[removed]';
/** Bodies with personal data are kept this long. */
export const PERSONAL_RETENTION_DAYS = 30;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "6 Nov 2026, 07:18 UTC" from an ISO time. */
export const stampUtc = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}, ${iso.slice(11, 16)} UTC`;

export type AuthKind = 'api_key' | 'basic' | 'session_token' | 'oauth';
export const AUTH_LABELS: Record<AuthKind, string> = { api_key: 'API key', basic: 'Basic credentials', session_token: 'Session token', oauth: 'OAuth' };

/** Platforms DI knows how to talk to, with the saved requests a connection starts with. */
export const PLATFORMS: Record<string, { label: string; ping: string; requests: { name: string; method: string; endpoint: string; purpose: 'pull' | 'push'; paging: string; rootPath?: string; watermarkParam?: string; target?: string; schedule?: string }[] }> = {
  relay: {
    label: 'Relay Marketing',
    ping: '/ping',
    requests: [
      { name: 'Campaign results', method: 'GET', endpoint: '/campaigns', purpose: 'pull', paging: 'cursor', rootPath: 'data', watermarkParam: 'updated_since', target: 'cmp_platform_metric', schedule: 'Nightly with the build' },
      { name: 'Send a contact list', method: 'POST', endpoint: '/lists', purpose: 'push', paging: 'none' },
      { name: 'Start a campaign', method: 'POST', endpoint: '/campaigns', purpose: 'push', paging: 'none' },
    ],
  },
};

export interface SavedApiLogin {
  credentialId: number;
  kind: AuthKind;
  label: string;
  placement: string | null;
  username: string | null;
}
export interface ApiConnection {
  connectionId: number;
  name: string;
  platform: string;
  baseUrl: string;
  auth: string;
  access: 'read' | 'read_write';
  status: string;
  createdBy: string;
  createdAt: string;
  requests: { requestId: number; name: string; method: string; endpoint: string; purpose: string; paging: string; watermark: string | null; schedule: string | null; lastRunAt: string | null; lastRows: number | null }[];
  lastCall: { at: string; status: number | null; error: boolean } | null;
  errors7d: number;
}
export interface LogEntry {
  logId: number;
  connection: string;
  requestAt: string;
  ms: number | null;
  method: string;
  endpoint: string;
  parameters: string;
  requestHeaders: string;
  body: string;
  statusCode: number | null;
  responseBody: string;
  error: boolean;
  errorMessage: string | null;
}

export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export interface ApiOptions {
  secretKey: Buffer;
  /** Hosts this institution lets DI call. */
  allowedHosts: string[];
  transport?: Transport;
}

/** Hosts DI may call: the simulated platform, plus any set in DI_API_HOSTS. */
export const apiHosts = (value = process.env.DI_API_HOSTS) => [RELAY_HOST, ...(value ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)];

const redactHeaders = (h: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SECRET_NAME.test(k) ? REDACTED : v])));
const redactParams = (p: URLSearchParams) => [...p.entries()].map(([k, v]) => `${k}=${SECRET_NAME.test(k) ? REDACTED : v}`).join('&');
const when = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '').replace(' ', 'T').slice(0, 19));

export class ApiService {
  private readonly tokens = new Map<number, string>();
  private readonly transport: Transport;

  constructor(
    private readonly pool: Pool,
    private readonly opts: ApiOptions,
  ) {
    const relay = relayPlatform(pool);
    // The default transport: the simulated platform in-process; anything else through fetch.
    this.transport =
      opts.transport ??
      (async (url, init) => {
        const u = new URL(url);
        if (u.hostname === RELAY_HOST) return relay({ method: init.method, path: u.pathname, query: u.searchParams, headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])), body: init.body });
        const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(20_000), redirect: 'error' });
        return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: await r.text() };
      });
  }

  private seal(secret: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.opts.secretKey, iv);
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
  }

  private unseal(sealed: string) {
    const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv(ALGO, this.opts.secretKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  private allowed(host: string) {
    return this.opts.allowedHosts.map((h) => h.toLowerCase()).includes(host.toLowerCase());
  }

  /** Saves sign-in details. The secret is sealed here and never leaves DI Core again. */
  async saveLogin(input: { kind: string; label: string; placement?: string; username?: string; secret: string; tokenUrl?: string }, owner: { userId: string }): Promise<SavedApiLogin> {
    const kind = input.kind as AuthKind;
    if (!AUTH_LABELS[kind]) throw new CoreError('INVALID', 'Choose how the API signs in: API key, basic credentials, session token or OAuth.');
    const label = input.label.trim();
    if (!label || label.length > 80) throw new CoreError('INVALID', 'Give the sign-in details a name, such as “Relay Marketing key”.');
    if (!input.secret || input.secret.length > 500) throw new CoreError('INVALID', kind === 'api_key' ? 'Enter the API key.' : 'Enter the password or client secret.');
    if ((kind === 'basic' || kind === 'session_token' || kind === 'oauth') && !input.username?.trim()) throw new CoreError('INVALID', kind === 'oauth' ? 'Enter the client ID.' : 'Enter the user name.');
    if (kind === 'session_token' && !/^https:\/\//.test(input.tokenUrl ?? '')) throw new CoreError('INVALID', 'Enter the https address DI gets a session token from.');
    const placement = kind === 'api_key' ? (input.placement?.trim() || 'X-Api-Key').slice(0, 60) : null;
    if (placement && !/^[A-Za-z0-9-]{1,60}$/.test(placement)) throw new CoreError('INVALID', 'The header name has letters, numbers and dashes only, such as X-Api-Key.');
    const [r] = (await this.pool.query('INSERT INTO api_credential (kind, label, placement, username, secret, token_url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [kind, label, placement, input.username?.trim() || null, this.seal(input.secret), input.tokenUrl ?? null, owner.userId, nowSql().slice(0, 19)])) as unknown as [{ insertId: number }];
    return { credentialId: r.insertId, kind, label, placement, username: input.username?.trim() || null };
  }

  /** Saved sign-in details, without the secret. Only the person who saved them can use them. */
  async login(credentialId: number, userId: string): Promise<SavedApiLogin> {
    const [r] = await rows<{ credential_id: number; kind: AuthKind; label: string; placement: string | null; username: string | null; created_by: string }>(this.pool, 'SELECT credential_id, kind, label, placement, username, created_by FROM api_credential WHERE credential_id = ?', [credentialId]);
    if (!r || r.created_by !== userId) throw new CoreError('NOT_FOUND', `There are no API sign-in details #${credentialId} saved by you. Enter them under “Connect a source”, Vendor API, on Integrations.`);
    return { credentialId: r.credential_id, kind: r.kind, label: r.label, placement: r.placement, username: r.username };
  }

  async latestLogin(userId: string) {
    const [r] = await rows<{ credential_id: number }>(this.pool, 'SELECT credential_id FROM api_credential WHERE created_by = ? ORDER BY credential_id DESC LIMIT 1', [userId]);
    return r?.credential_id ?? null;
  }

  /** The headers that sign a request in, from the sealed secret. */
  private async auth(credentialId: number, fresh = false): Promise<Record<string, string>> {
    const [c] = await rows<{ kind: AuthKind; placement: string | null; username: string | null; secret: string; token_url: string | null }>(this.pool, 'SELECT kind, placement, username, secret, token_url FROM api_credential WHERE credential_id = ?', [credentialId]);
    if (!c) throw new CoreError('NOT_FOUND', 'Those sign-in details are no longer saved.');
    if (c.kind === 'api_key') return { [c.placement ?? 'X-Api-Key']: this.unseal(c.secret) };
    if (c.kind === 'basic') return { Authorization: `Basic ${Buffer.from(`${c.username}:${this.unseal(c.secret)}`).toString('base64')}` };
    if (c.kind === 'session_token') {
      if (fresh || !this.tokens.has(credentialId)) {
        const host = new URL(c.token_url!).hostname;
        if (!this.allowed(host)) throw new CoreError('NO_ACCESS', `${host} isn’t on this institution’s list of API hosts.`);
        const r = await this.transport(c.token_url!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: c.username, password: this.unseal(c.secret) }) });
        const token = (JSON.parse(r.body || '{}') as { token?: string; access_token?: string }).token ?? (JSON.parse(r.body || '{}') as { access_token?: string }).access_token;
        if (r.status >= 400 || !token) throw new CoreError('INVALID', `The token address answered ${r.status} and gave no session token.`);
        this.tokens.set(credentialId, token);
      }
      return { Authorization: `Bearer ${this.tokens.get(credentialId)}` };
    }
    throw new CoreError('INVALID', 'OAuth sign-in starts in the browser, and that step isn’t built yet. Use an API key or basic credentials for now.');
  }

  /**
   * One call to the API, logged. Secrets are removed from the log; a body with personal data is sealed.
   * A session token that has expired is fetched again once.
   */
  async call(c: { connectionId: number; baseUrl: string; credentialId: number; logSuccess?: boolean }, method: string, endpoint: string, o: { query?: Record<string, string>; body?: unknown; personal?: boolean; runId?: string } = {}) {
    // Bodies with personal data are cleared once they pass their retention; the call's record stays.
    await this.pool.query(`UPDATE api_request_log SET body = IF(body_sealed = 1, NULL, body), response_body = IF(response_sealed = 1, NULL, response_body) WHERE (body_sealed = 1 OR response_sealed = 1) AND (body IS NOT NULL OR response_body IS NOT NULL) AND request_at < UTC_TIMESTAMP() - INTERVAL ${PERSONAL_RETENTION_DAYS} DAY`);
    const url = new URL(c.baseUrl.replace(/\/$/, '') + endpoint);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    const started = new Date();
    const log = async (r: { status: number | null; headers?: Record<string, string>; body?: string; error?: string; sent?: Record<string, string> }) => {
      const isError = Boolean(r.error) || (r.status ?? 0) >= 400;
      if (!isError && c.logSuccess === false) return;
      const responsePersonal = Boolean(o.personal) && Boolean(r.body);
      await this.pool.query(
        'INSERT INTO api_request_log (connection_id, request_at, response_at, method, endpoint, parameters, request_headers, body, body_sealed, response_headers, status_code, response_body, response_sealed, is_error, error_message, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [c.connectionId, nowSql(started), nowSql(), method, url.pathname, redactParams(url.searchParams), redactHeaders(r.sent ?? {}), body === undefined ? null : o.personal ? this.seal(body) : body.slice(0, 4000), o.personal ? 1 : 0, r.headers ? redactHeaders(r.headers) : null, r.status, r.body === undefined ? null : responsePersonal ? this.seal(r.body) : r.body.slice(0, 4000), responsePersonal ? 1 : 0, isError ? 1 : 0, r.error ?? (isError ? `HTTP ${r.status}` : null), o.runId ?? null],
      );
    };
    if (url.protocol !== 'https:' || !this.allowed(url.hostname)) {
      await log({ status: null, error: `Blocked: ${url.hostname} isn’t on this institution’s list of API hosts` });
      throw new CoreError('NO_ACCESS', `DI can only call API hosts this institution has approved. ${url.hostname} isn’t one of them; ask Kinective to add it.`);
    }
    const send = async (fresh: boolean) => {
      const headers = { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(await this.auth(c.credentialId, fresh)) };
      try {
        const r = await this.transport(url.toString(), { method, headers, body });
        return { r, headers };
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 200) : 'No answer';
        await log({ status: null, error: message, sent: headers });
        throw new CoreError('INVALID', `${url.hostname} didn’t answer: ${message}.`);
      }
    };
    let { r, headers } = await send(false);
    const [cred] = await rows<{ kind: string }>(this.pool, 'SELECT kind FROM api_credential WHERE credential_id = ?', [c.credentialId]);
    if (r.status === 401 && cred?.kind === 'session_token') {
      await log({ status: r.status, headers: r.headers, body: r.body, sent: headers, error: 'Session token expired; getting a new one' });
      ({ r, headers } = await send(true));
    }
    let message: string | undefined;
    if (r.status >= 400) message = ((JSON.parse(r.body || '{}') as { message?: string }).message ?? `HTTP ${r.status}`).slice(0, 200);
    await log({ status: r.status, headers: r.headers, body: r.body, sent: headers, error: message });
    return { status: r.status, json: (r.body ? JSON.parse(r.body) : {}) as Record<string, unknown>, message };
  }

  /** Tests sign-in details against a platform: one read-only call, logged like every other. */
  async test(p: { platform: string; baseUrl: string; credentialId: number }, userId: string, runId?: string) {
    const platform = PLATFORMS[p.platform];
    if (!platform) throw new CoreError('INVALID', 'DI doesn’t have a ready-made setup for that platform yet.');
    await this.login(p.credentialId, userId);
    const host = new URL(p.baseUrl).hostname;
    // Test calls are logged under connection 0 until the connection exists.
    const started = Date.now();
    const r = await this.call({ connectionId: 0, baseUrl: p.baseUrl, credentialId: p.credentialId }, 'GET', platform.ping, { runId });
    return { ok: r.status < 400, status: r.status, host, ms: Date.now() - started, account: String(r.json.account ?? ''), message: r.message ?? null, platform: platform.label };
  }

  /** Records the connection and its saved requests. The approval is the record of who allowed it. */
  async create(p: { name: string; platform: string; baseUrl: string; credentialId: number; access: 'read' | 'read_write' }, owner: { userId: string; name: string }, meta: { approvalId: string }) {
    const platform = PLATFORMS[p.platform];
    if (!platform) throw new CoreError('INVALID', 'Unknown platform.');
    const [r] = (await this.pool.query('INSERT INTO api_connection (name, platform, base_url, credential_id, access, log_success, status, created_by, created_by_name, approval_id, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)', [p.name.slice(0, 80), p.platform, p.baseUrl, p.credentialId, p.access, 'Active', owner.userId, owner.name, meta.approvalId, nowSql().slice(0, 19)])) as unknown as [{ insertId: number }];
    for (const q of platform.requests.filter((x) => p.access === 'read_write' || x.purpose === 'pull'))
      await this.pool.query('INSERT INTO api_request (connection_id, name, method, endpoint, purpose, paging, root_path, watermark_param, target, schedule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [r.insertId, q.name, q.method, q.endpoint, q.purpose, q.paging, q.rootPath ?? null, q.watermarkParam ?? null, q.target ?? null, q.schedule ?? null]);
    // The test call becomes part of this connection's history.
    await this.pool.query('UPDATE api_request_log SET connection_id = ? WHERE connection_id = 0', [r.insertId]);
    return r.insertId;
  }

  async connections(): Promise<ApiConnection[]> {
    const list = await rows<Record<string, unknown>>(this.pool, 'SELECT c.*, k.kind FROM api_connection c JOIN api_credential k ON k.credential_id = c.credential_id ORDER BY c.connection_id');
    const reqs = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM api_request ORDER BY request_id');
    const last = await rows<{ connection_id: number; request_at: unknown; status_code: number | null; is_error: number }>(this.pool, 'SELECT l.connection_id, l.request_at, l.status_code, l.is_error FROM api_request_log l JOIN (SELECT connection_id, MAX(log_id) AS id FROM api_request_log GROUP BY connection_id) m ON m.id = l.log_id');
    const errs = await rows<{ connection_id: number; n: number }>(this.pool, 'SELECT connection_id, COUNT(*) AS n FROM api_request_log WHERE is_error = 1 AND request_at > NOW() - INTERVAL 7 DAY GROUP BY connection_id');
    return list.map((c) => {
      const id = Number(c.connection_id);
      const l = last.find((x) => x.connection_id === id);
      return {
        connectionId: id,
        name: String(c.name),
        platform: String(c.platform),
        baseUrl: String(c.base_url),
        auth: AUTH_LABELS[c.kind as AuthKind] ?? String(c.kind),
        access: c.access as 'read' | 'read_write',
        status: String(c.status),
        createdBy: String(c.created_by_name),
        createdAt: when(c.created_at).slice(0, 10),
        requests: reqs.filter((q) => Number(q.connection_id) === id).map((q) => ({ requestId: Number(q.request_id), name: String(q.name), method: String(q.method), endpoint: String(q.endpoint), purpose: String(q.purpose), paging: String(q.paging), watermark: (q.watermark as string | null) ?? null, schedule: (q.schedule as string | null) ?? null, lastRunAt: q.last_run_at ? when(q.last_run_at) : null, lastRows: q.last_rows === null ? null : Number(q.last_rows) })),
        lastCall: l ? { at: when(l.request_at), status: l.status_code, error: l.is_error === 1 } : null,
        errors7d: Number(errs.find((e) => e.connection_id === id)?.n ?? 0),
      };
    });
  }

  /** A connection by number or by words of its name; the only one, when there is one. */
  async connection(ref?: string | number) {
    const all = await this.connections();
    if (typeof ref === 'number') return all.find((c) => c.connectionId === ref) ?? null;
    const words = (ref ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !['api', 'the', 'connection', 'platform'].includes(w));
    return (words.length ? all.find((c) => words.some((w) => `${c.name} ${c.platform}`.toLowerCase().includes(w))) : null) ?? (all.length === 1 ? all[0]! : null);
  }

  /** The active connection to a marketing platform that can take lists. */
  async marketing() {
    return (await this.connections()).find((c) => c.status === 'Active' && PLATFORMS[c.platform] && c.requests.some((q) => q.purpose === 'push')) ?? null;
  }

  private async target(c: ApiConnection) {
    const [r] = await rows<{ credential_id: number; log_success: number }>(this.pool, 'SELECT credential_id, log_success FROM api_connection WHERE connection_id = ?', [c.connectionId]);
    return { connectionId: c.connectionId, baseUrl: c.baseUrl, credentialId: r!.credential_id, logSuccess: r!.log_success === 1 };
  }

  /** The request log, newest first. Secrets were removed when written; sealed bodies stay sealed. */
  async log(p: { connectionId?: number; errorsOnly?: boolean; limit?: number } = {}): Promise<LogEntry[]> {
    const where = [p.connectionId ? 'l.connection_id = ?' : null, p.errorsOnly ? 'l.is_error = 1' : null].filter(Boolean);
    const list = await rows<Record<string, unknown>>(this.pool, `SELECT l.*, c.name FROM api_request_log l LEFT JOIN api_connection c ON c.connection_id = l.connection_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.log_id DESC LIMIT ?`, [...(p.connectionId ? [p.connectionId] : []), Math.min(p.limit ?? 20, 100)]);
    return list.map((l) => {
      const ms = (v: unknown) => Date.parse(`${String(v).replace(' ', 'T')}Z`);
      const start = ms(l.request_at);
      const end = l.response_at ? ms(l.response_at) : null;
      return {
        logId: Number(l.log_id),
        connection: (l.name as string | null) ?? 'Connection test',
        requestAt: when(l.request_at),
        ms: end === null ? null : Math.max(0, end - start),
        method: String(l.method),
        endpoint: String(l.endpoint),
        parameters: String(l.parameters ?? ''),
        requestHeaders: String(l.request_headers ?? ''),
        body: l.body_sealed ? (l.body === null ? `Personal data, cleared after ${PERSONAL_RETENTION_DAYS} days` : `Encrypted: personal data, kept ${PERSONAL_RETENTION_DAYS} days`) : String(l.body ?? ''),
        statusCode: l.status_code === null ? null : Number(l.status_code),
        responseBody: l.response_sealed ? (l.response_body === null ? `Personal data, cleared after ${PERSONAL_RETENTION_DAYS} days` : `Encrypted: personal data, kept ${PERSONAL_RETENTION_DAYS} days`) : String(l.response_body ?? ''),
        error: l.is_error === 1,
        errorMessage: (l.error_message as string | null) ?? null,
      };
    });
  }

  /** Runs a connection's pull requests: every page, from where the last pull stopped. */
  async pull(connectionId: number, runId?: string) {
    const c = (await this.connection(connectionId))!;
    if (!c) throw new CoreError('NOT_FOUND', 'That API connection no longer exists.');
    const t = await this.target(c);
    const out: { request: string; pages: number; rows: number; linked: number; since: string | null; watermark: string | null }[] = [];
    for (const q of c.requests.filter((x) => x.purpose === 'pull')) {
      const [saved] = await rows<{ root_path: string | null; watermark_param: string | null; watermark: string | null; target: string | null }>(this.pool, 'SELECT root_path, watermark_param, watermark, target FROM api_request WHERE request_id = ?', [q.requestId]);
      let cursor: string | null = null;
      let pages = 0;
      let count = 0;
      let linked = 0;
      let high = saved!.watermark;
      do {
        const query: Record<string, string> = { ...(saved!.watermark && saved!.watermark_param ? { [saved!.watermark_param]: saved!.watermark } : {}), ...(cursor ? { cursor } : {}) };
        const r = await this.call(t, q.method, q.endpoint, { query, runId });
        if (r.status >= 400) throw new CoreError('INVALID', `${c.name} answered ${r.status}: ${r.message}. Nothing was changed; the request log has the details.`);
        pages++;
        const items = ((saved!.root_path ? r.json[saved!.root_path] : r.json) ?? []) as Record<string, unknown>[];
        for (const item of items) {
          if (saved!.target === 'cmp_platform_metric') linked += await this.landCampaign(c.connectionId, item);
          count++;
          const u = String(item.updated_at ?? '');
          if (u && (!high || u > high)) high = u;
        }
        cursor = (r.json.next_cursor as string | null) ?? null;
      } while (cursor && pages < 50);
      await this.pool.query('UPDATE api_request SET watermark = ?, last_run_at = ?, last_rows = ? WHERE request_id = ?', [high, nowSql().slice(0, 19), count, q.requestId]);
      out.push({ request: q.name, pages, rows: count, linked, since: saved!.watermark, watermark: high });
    }
    return { connection: c.name, results: out };
  }

  /** One campaign from the platform into DI, linked by DI's tag or by the list DI sent. Returns 1 when linked. */
  private async landCampaign(connectionId: number, item: Record<string, unknown>) {
    const tag = String(item.tag ?? '');
    const campaignId = /^DI-CMP-(\d+)$/.exec(tag)?.[1];
    const [push] = await rows<{ push_id: number }>(this.pool, 'SELECT push_id FROM cmp_push WHERE external_campaign_id = ?', [String(item.id)]);
    const s = (item.stats ?? {}) as Record<string, number>;
    const sql = (v: unknown) => (v ? String(v).replace('T', ' ').replace('Z', '').slice(0, 19) : null);
    await this.pool.query(
      `INSERT INTO cmp_platform_metric (external_campaign_id, connection_id, campaign_id, push_id, name, channel, status, sent, delivered, opened, clicked, unsubscribed, clicked_refs, sent_at, updated_at, pulled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), sent = VALUES(sent), delivered = VALUES(delivered), opened = VALUES(opened), clicked = VALUES(clicked), unsubscribed = VALUES(unsubscribed), clicked_refs = VALUES(clicked_refs), updated_at = VALUES(updated_at), pulled_at = VALUES(pulled_at)`,
      [String(item.id), connectionId, campaignId ? Number(campaignId) : null, push?.push_id ?? null, String(item.name).slice(0, 80), String(item.channel ?? 'Email'), String(item.status ?? ''), s.sent ?? 0, s.delivered ?? 0, s.opened ?? 0, s.clicked ?? 0, s.unsubscribed ?? 0, JSON.stringify(item.clicked_contacts ?? []), sql(item.sent_at), sql(item.updated_at) ?? nowSql().slice(0, 19), nowSql().slice(0, 19)],
    );
    return campaignId || push ? 1 : 0;
  }

  /** A reference for a member that only DI can turn back: keyed with DI's secret, per send. */
  private ref(partyId: number, pushKey: string) {
    return `m_${createHmac('sha256', this.opts.secretKey).update(`${pushKey}:${partyId}`).digest('hex').slice(0, 16)}`;
  }

  /**
   * Sends an approved audience to the platform and starts its campaign. Members go as a reference,
   * first name and email only; DI keeps which reference is which member.
   */
  async pushAudience(p: { connectionId: number; audienceName: string; category: string; campaignName: string; members: { partyId: number; firstName: string; email: string }[] }, owner: { userId: string; name: string }, meta: { approvalId: string; runId?: string }) {
    const c = await this.connection(p.connectionId);
    if (!c || c.status !== 'Active') throw new CoreError('NOT_FOUND', 'That marketing connection is no longer active.');
    if (!c.requests.some((q) => q.purpose === 'push')) throw new CoreError('NO_ACCESS', `${c.name} is connected read-only, so DI can’t send it a list.`);
    const t = await this.target(c);
    const key = meta.approvalId;
    const contacts = p.members.map((m) => ({ ref: this.ref(m.partyId, key), first_name: m.firstName, email: m.email }));
    const list = await this.call(t, 'POST', '/lists', { body: { name: p.audienceName, contacts }, personal: true, runId: meta.runId });
    if (list.status >= 400) throw new CoreError('INVALID', `${c.name} refused the list: ${list.message}. Nothing was sent.`);
    const [pr] = (await this.pool.query('INSERT INTO cmp_push (audience_name, category, connection_id, external_list_id, external_campaign_id, campaign_name, contacts, fields, pushed_by, pushed_by_name, approval_id, pushed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [p.audienceName.slice(0, 80), p.category, c.connectionId, String(list.json.id), '', p.campaignName.slice(0, 80), Number(list.json.accepted ?? 0), 'Reference, first name, email', owner.userId, owner.name, meta.approvalId, nowSql().slice(0, 19)])) as unknown as [{ insertId: number }];
    const pairs = p.members.map((m, i) => [pr.insertId, contacts[i]!.ref, m.partyId]);
    for (let i = 0; i < pairs.length; i += 2000) await this.pool.query('INSERT INTO cmp_push_member (push_id, ref, party_id) VALUES ?', [pairs.slice(i, i + 2000)]);
    const campaign = await this.call(t, 'POST', '/campaigns', { body: { list_id: list.json.id, name: p.campaignName, channel: 'Email', tag: `DI-PUSH-${pr.insertId}` }, runId: meta.runId });
    if (campaign.status >= 400) throw new CoreError('INVALID', `${c.name} took the list but didn’t start the campaign: ${campaign.message}.`);
    await this.pool.query('UPDATE cmp_push SET external_campaign_id = ? WHERE push_id = ?', [String(campaign.json.id), pr.insertId]);
    return { pushId: pr.insertId, listId: String(list.json.id), campaignId: String(campaign.json.id), accepted: Number(list.json.accepted ?? 0), rejected: Number(list.json.rejected ?? 0), connection: c.name };
  }

  /** What came back from the platform: each campaign's reach, and for DI's own sends, the members who clicked. */
  async platformResults() {
    const list = await rows<Record<string, unknown>>(this.pool, 'SELECT m.*, c.name AS connection FROM cmp_platform_metric m JOIN api_connection c ON c.connection_id = m.connection_id ORDER BY m.sent_at DESC');
    const pushes = await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM cmp_push ORDER BY push_id DESC');
    return {
      metrics: list.map((m) => {
        const delivered = Number(m.delivered);
        const refs = m.clicked_refs ? (JSON.parse(String(m.clicked_refs)) as string[]) : [];
        return { externalId: String(m.external_campaign_id), campaignId: m.campaign_id === null ? null : Number(m.campaign_id), pushId: m.push_id === null ? null : Number(m.push_id), name: String(m.name), channel: String(m.channel), status: String(m.status), sent: Number(m.sent), delivered, opened: Number(m.opened), clicked: Number(m.clicked), unsubscribed: Number(m.unsubscribed), openPct: delivered ? (Number(m.opened) / delivered) * 100 : 0, clickPct: delivered ? (Number(m.clicked) / delivered) * 100 : 0, clickedRefs: refs.length, sentAt: m.sent_at ? when(m.sent_at).slice(0, 10) : null, pulledAt: when(m.pulled_at), connection: String(m.connection) };
      }),
      pushes: pushes.map((p) => ({ pushId: Number(p.push_id), audience: String(p.audience_name), category: String(p.category), campaign: String(p.campaign_name), contacts: Number(p.contacts), fields: String(p.fields), by: String(p.pushed_by_name), at: when(p.pushed_at), externalCampaignId: String(p.external_campaign_id) })),
    };
  }

  /** The members behind a send's clicks, matched inside DI from the references the platform returned. */
  async clickers(pushId: number) {
    const [m] = await rows<{ clicked_refs: string | null }>(this.pool, 'SELECT clicked_refs FROM cmp_platform_metric WHERE push_id = ?', [pushId]);
    const refs = m?.clicked_refs ? (JSON.parse(m.clicked_refs) as string[]) : [];
    if (!refs.length) return [];
    return rows<{ party_id: number }>(this.pool, 'SELECT party_id FROM cmp_push_member WHERE push_id = ? AND ref IN (?)', [pushId, refs]);
  }
}
