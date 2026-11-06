// Relay Marketing, simulated: the API of an external marketing platform, as DI would meet it. It
// answers only at its reserved `.example` address, through DI Core's transport, so nothing leaves the
// demo. It checks its API key, takes lists of contacts, sends campaigns to them, and reports results
// a page at a time, filtered by when they last changed. It never sees a member number: DI sends a
// reference that only DI can turn back into a member.
import { createHash } from 'node:crypto';
import { relayDemoKey, type Pool } from '@dinext/tenant-db';

export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string | undefined;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 19) + 'Z' : v ? `${String(v).replace(' ', 'T').slice(0, 19)}Z` : null);
const reply = (status: number, body: unknown, extra: Record<string, string> = {}): HttpResponse => ({ status, headers: { 'content-type': 'application/json', 'x-request-id': `rly_${Math.random().toString(36).slice(2, 10)}`, ...extra }, body: JSON.stringify(body) });
/** A stable draw in [0, 1) per contact and event, independent across events. */
const hash = (s: string) => createHash('sha256').update(s).digest().readUInt32BE(0) / 4294967296;
const PAGE = 5;

export function relayPlatform(pool: Pool) {
  const q = async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
  return async (req: HttpRequest): Promise<HttpResponse> => {
    if ((req.headers['x-api-key'] ?? '') !== relayDemoKey()) return reply(401, { error: 'invalid_api_key', message: 'The API key is missing or not valid for this account.' });
    const path = req.path.replace(/^\/v1/, '');
    if (req.method === 'GET' && path === '/ping') return reply(200, { ok: true, account: 'Demo account', plan: 'Sandbox', rate_limit: '600 requests a minute' });

    if (req.method === 'POST' && path === '/lists') {
      const b = JSON.parse(req.body ?? '{}') as { name?: string; contacts?: { ref?: string; email?: string; first_name?: string }[] };
      if (!b.name || !Array.isArray(b.contacts)) return reply(422, { error: 'invalid_list', message: 'A list needs a name and contacts.' });
      const good = b.contacts.filter((c) => c.ref && c.email && EMAIL.test(c.email));
      const id = `rly_lst_${Date.now().toString(36)}`;
      await pool.query('INSERT INTO sim_relay_list (list_id, name, contacts, refs, created_at) VALUES (?, ?, ?, ?, ?)', [id, b.name.slice(0, 80), good.length, JSON.stringify(good.map((c) => c.ref)), nowSql()]);
      return reply(201, { id, name: b.name, accepted: good.length, rejected: b.contacts.length - good.length });
    }

    if (req.method === 'POST' && path === '/campaigns') {
      const b = JSON.parse(req.body ?? '{}') as { list_id?: string; name?: string; channel?: string; tag?: string };
      const [list] = await q<{ list_id: string; refs: string }>('SELECT list_id, refs FROM sim_relay_list WHERE list_id = ?', [b.list_id ?? '']);
      if (!list || !b.name) return reply(422, { error: 'invalid_campaign', message: 'A campaign needs a name and an existing list.' });
      const refs = JSON.parse(list.refs) as string[];
      // The platform sends at once and reports its first day: who it reached, opened and clicked.
      const delivered = refs.filter((r) => hash(`${r}:d`) > 0.018);
      const opened = delivered.filter((r) => hash(`${r}:o`) < 0.36);
      const clicked = opened.filter((r) => hash(`${r}:c`) < 0.17);
      const unsub = delivered.filter((r) => hash(`${r}:u`) < 0.003).length;
      const id = `rly_cmp_${Date.now().toString(36)}`;
      const at = nowSql();
      await pool.query('INSERT INTO sim_relay_campaign (campaign_id, list_id, name, channel, tag, status, sent, delivered, opened, clicked, unsubscribed, clicked_refs, sent_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, list.list_id, b.name.slice(0, 80), b.channel ?? 'Email', b.tag ?? null, 'Sent', refs.length, delivered.length, opened.length, clicked.length, unsub, JSON.stringify(clicked), at, at]);
      return reply(201, { id, status: 'Sent', sent: refs.length });
    }

    if (req.method === 'GET' && path === '/campaigns') {
      const since = req.query.get('updated_since');
      const cursor = Number(req.query.get('cursor') ?? 0) || 0;
      const where = since ? 'WHERE updated_at > ?' : '';
      const list = await q<Record<string, unknown>>(`SELECT * FROM sim_relay_campaign ${where} ORDER BY updated_at, campaign_id LIMIT ? OFFSET ?`, [...(since ? [since.replace('T', ' ').replace('Z', '').slice(0, 19)] : []), PAGE + 1, cursor]);
      const page = list.slice(0, PAGE);
      return reply(200, {
        data: page.map((c) => ({ id: c.campaign_id, name: c.name, channel: c.channel, tag: c.tag, status: c.status, stats: { sent: c.sent, delivered: c.delivered, opened: c.opened, clicked: c.clicked, unsubscribed: c.unsubscribed }, clicked_contacts: c.clicked_refs ? JSON.parse(String(c.clicked_refs)) : [], sent_at: iso(c.sent_at), updated_at: iso(c.updated_at) })),
        next_cursor: list.length > PAGE ? String(cursor + PAGE) : null,
      });
    }
    return reply(404, { error: 'not_found', message: `No ${req.method} ${req.path} on this API.` });
  };
}
