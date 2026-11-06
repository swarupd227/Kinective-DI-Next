// API Connections (spec Integrations > APIs; backlog EP11-F06): an administrator connects DI to an
// external REST platform. The person enters the key on Integrations; the agent sees only its number.
// DI tests it with one read-only call, shows the saved requests it would set up, and connects on
// approval. A connection that can send data out is high risk. Every call is in the request log, with
// secrets removed.
import { z } from 'zod';
import { CoreError, PLATFORMS, type ApiConnection, type ApiService, type LogEntry } from '@dinext/di-core';
import { RELAY_BASE_URL } from '@dinext/tenant-db';
import { moduleTable, type ModuleContext, type ModuleSpec, type ModuleView } from './moduleAgent.ts';

const n = (x: number) => x.toLocaleString('en-US');
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const at = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(11, 16)} UTC`;
const DETAILS = /\bAPI (?:sign-in )?details #?(\d+)\b/i;
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });

export const API_REQUEST =
  /\bAPI (?:sign-in )?details #?\d+|\bAPI connections?\b|\brequest log\b|\bsaved requests?\b|\b(?:test|connect|hook up)\b[^.?!]*\b(?:API|Relay|marketing platform)\b|\b(?:Relay|marketing platform) (?:connection|API)\b|\bAPI (?:errors?|calls?)\b|\b(?:pull|sync)\b[^.?!]*\bfrom Relay\b/i;

export function logRows(list: LogEntry[]) {
  return list.map((l) => ({ at: at(l.requestAt), call: `${l.method} ${l.endpoint}${l.parameters ? `?${l.parameters}` : ''}`, status: l.statusCode === null ? '—' : String(l.statusCode), ms: l.ms === null ? '—' : `${n(l.ms)} ms`, headers: l.requestHeaders, body: l.body || '—', result: l.error ? (l.errorMessage ?? 'Error') : 'OK' }));
}
export const LOG_COLUMNS = [text('at', 'Requested'), text('call', 'Call'), text('status', 'Status'), text('ms', 'Took'), text('headers', 'Request headers'), text('body', 'Body'), text('result', 'Result')];

export function connectionRows(list: ApiConnection[]) {
  return list.map((c) => ({ name: c.name, platform: `${PLATFORMS[c.platform]?.label ?? c.platform} · ${c.baseUrl}`, auth: c.auth, access: c.access === 'read_write' ? 'Reads results, sends lists' : 'Reads only', requests: c.requests.map((q) => q.name).join(', '), last: c.lastCall ? `${at(c.lastCall.at)}, ${c.lastCall.error ? `failed (${c.lastCall.status ?? 'no answer'})` : `${c.lastCall.status}`}` : '—', errors: String(c.errors7d) }));
}
export const CONNECTION_COLUMNS = [text('name', 'Connection'), text('platform', 'Platform'), text('auth', 'Signs in with'), text('access', 'Access'), text('requests', 'Saved requests'), text('last', 'Last call'), text('errors', 'Errors, 7 days')];

export function apisModule(api: ApiService | null): ModuleSpec {
  const noAccess = 'API connections are part of the Integrations administrator’s access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('apis')) throw new CoreError('NO_ACCESS', noAccess);
    if (!api) throw new CoreError('INVALID', 'API connections aren’t set up in this environment.');
    return api;
  };
  const details = async (ctx: ModuleContext, id?: number) => {
    const s = need(ctx);
    if (id) return id;
    const last = await s.latestLogin(ctx.user.id);
    if (!last) throw new CoreError('NOT_FOUND', 'There are no API sign-in details saved by you yet. Enter the key under “Connect a source”, Vendor API, on Integrations; I can’t take keys in chat.');
    return last;
  };
  const connection = async (ctx: ModuleContext, ref?: string) => {
    const c = await need(ctx).connection(ref);
    if (!c) throw new CoreError('NOT_FOUND', ref ? `There’s no API connection called ${ref}.` : 'There’s no API connection yet. Enter the platform’s key on Integrations, then ask me to test it.');
    return c;
  };

  const spec: ModuleSpec = {
    id: 'apis',
    prefix: 'api',
    agent: 'API Connections',
    request: API_REQUEST,
    noAccess,
    sources: [
      { kind: 'table', label: 'API connections', ref: 'table:api_connection' },
      { kind: 'table', label: 'Request log', ref: 'table:api_request_log' },
    ],
    prompt: ({ tenant, user, title }) => `You are the API Connections agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) connects DI to external platforms over their APIs, such as a marketing platform DI sends audiences to and pulls campaign results from.

- "Test the Relay Marketing API (API details #2)": api_test. "Connect it": api_connect; "read only" sets read_only true.
- "Show the API connections", "what does the Relay connection pull?": api_status.
- "Show the last five errors from the request log": api_log with errors_only true and limit 5. "Show the request log": api_log.
- "Pull from Relay now": api_pull.
- Sign-in details are a number; the person enters the key on Integrations. Never ask for a key, password or token in chat.`,
    plan: (t) => {
      const id = DETAILS.exec(t)?.[1];
      const limit = /\blast (\d{1,2}|five|ten|three)\b/i.exec(t)?.[1];
      const words: Record<string, number> = { three: 3, five: 5, ten: 10 };
      if (/\brequest log\b|\bAPI (?:errors?|calls?)\b|\berrors?\b/i.test(t)) return { tool: 'api_log', args: { ...(/\berrors?\b|\bfail/i.test(t) ? { errors_only: true } : {}), ...(limit ? { limit: words[limit.toLowerCase()] ?? Number(limit) } : {}) } };
      if (/\b(?:pull|sync)\b/i.test(t)) return { tool: 'api_pull', args: {} };
      if (/\btest\b/i.test(t) && !/\bconnect (?:it|the)\b/i.test(t)) return { tool: 'api_test', args: id ? { details: Number(id) } : {} };
      if (/\bconnect\b|\bhook up\b/i.test(t)) return { tool: 'api_connect', args: { ...(id ? { details: Number(id) } : {}), ...(/\bread[- ]only\b/i.test(t) ? { read_only: true } : {}) } };
      return { tool: 'api_status', args: {} };
    },
    tools: [
      {
        name: 'api_test',
        description: 'Call the platform once, read-only, with saved API sign-in details, and report whether it signed in. Changes nothing; the call is in the request log.',
        input: z.object({ details: z.number().int().positive().optional() }).strict(),
        run: async (a: { details?: number }, ctx): Promise<ModuleView> => {
          const s = need(ctx);
          const id = await details(ctx, a.details);
          const login = await s.login(id, ctx.user.id);
          const r = await s.test({ platform: 'relay', baseUrl: RELAY_BASE_URL, credentialId: id }, ctx.user.id, ctx.runId);
          const plan = PLATFORMS.relay!.requests;
          return {
            text: r.ok
              ? `**${r.platform} signed in.** ${r.host} answered in ${n(r.ms)} ms${r.account ? `, as the ${r.account.toLowerCase()}` : ''}, with the ${login.label} (${login.placement ?? 'API key'} header). Connecting it sets up ${plural(plan.length, 'saved request')}: one pulls campaign results each night, a page at a time, from where the last pull stopped; two send a contact list and start a campaign, and only run when someone approves a send. The key isn’t in the request log.`
              : `**${r.platform} refused the sign-in**: ${r.status} ${r.message ?? ''}. Check the key on Integrations and enter it again; nothing was connected.`,
            blocks: [moduleTable(spec, 'What connecting would set up', ctx.runId, 'api.request.plan', [text('name', 'Saved request'), text('call', 'Call'), text('when', 'Runs'), text('paging', 'Paging')], plan.map((q) => ({ name: q.name, call: `${q.method} ${q.endpoint}`, when: q.purpose === 'pull' ? (q.schedule ?? 'On request') : 'Only on an approved send', paging: q.paging === 'none' ? '—' : `By ${q.paging}, from ${q.watermarkParam}` })))],
            suggestions: r.ok ? [`Connect Relay Marketing (API details #${id})`, `Connect Relay Marketing read only (API details #${id})`, 'Show the request log'] : ['Show the request log'],
          };
        },
      },
      {
        name: 'api_connect',
        description: 'Prepare connecting DI to the platform with saved API sign-in details, with its saved requests, then pull once. Sending lists is included unless read_only is true. Returns approval_required.',
        input: z.object({ details: z.number().int().positive().optional(), read_only: z.boolean().optional(), name: z.string().min(2).max(60).optional() }).strict(),
        run: async (a: { details?: number; read_only?: boolean; name?: string }, ctx) => {
          const s = need(ctx);
          const id = await details(ctx, a.details);
          const login = await s.login(id, ctx.user.id);
          const r = await s.test({ platform: 'relay', baseUrl: RELAY_BASE_URL, credentialId: id }, ctx.user.id, ctx.runId);
          if (!r.ok) throw new CoreError('INVALID', `${r.platform} refused the sign-in (${r.status}${r.message ? `: ${r.message}` : ''}), so I can’t connect it. Enter the key again on Integrations.`);
          const name = (a.name ?? 'Relay Marketing').trim();
          if ((await s.connections()).some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new CoreError('INVALID', `There’s already a connection called ${name}. Ask me to pull from it or show its request log.`);
          const write = !a.read_only;
          const requests = PLATFORMS.relay!.requests.filter((q) => write || q.purpose === 'pull');
          return {
            change: {
              summary: `Connect ${name}${write ? ', able to send contact lists' : ', read only'}`,
              changes: [
                { label: 'Connection', before: '—', after: `${name} (new)` },
                { label: 'Address', before: '—', after: RELAY_BASE_URL },
                { label: 'Signs in with', before: '—', after: `${login.label}, sealed in DI` },
                { label: 'Access', before: '—', after: write ? 'Reads campaign results; sends contact lists, each send approved on its own' : 'Reads campaign results only' },
                { label: 'Saved requests', before: '—', after: requests.map((q) => `${q.name} (${q.method} ${q.endpoint})`).join('; ') },
                { label: 'First pull', before: '—', after: 'Campaign results, right after you approve' },
              ],
              text: `I’ll connect **${name}** with the ${login.label}.${write ? ' It can send data out of DI, so this is high risk: once connected, DI can send a contact list to it, but every send still needs its own approval showing who and which fields.' : ' It will only read.'} Campaign results are pulled right after you approve, and then each night with the build.`,
              done: `Connected **${name}**.`,
              risk: write ? 'high' : 'medium',
              apply: { credentialId: id, name, access: write ? 'read_write' : 'read' },
            },
          };
        },
        apply: async (p: { credentialId: number; name: string; access: 'read' | 'read_write' }, meta, ctx): Promise<ModuleView> => {
          const s = need(ctx);
          const connectionId = await s.create({ name: p.name, platform: 'relay', baseUrl: RELAY_BASE_URL, credentialId: p.credentialId, access: p.access }, { userId: ctx.user.id, name: ctx.user.name }, { approvalId: meta.approvalId });
          const pulled = await s.pull(connectionId, ctx.runId);
          const r = pulled.results[0];
          return {
            text: `Connected **${p.name}**. The first pull brought back ${plural(r?.rows ?? 0, 'campaign')} in ${plural(r?.pages ?? 0, 'page')}; ${plural(r?.linked ?? 0, 'campaign')} matched DI’s own. The next pull starts from there.`,
            blocks: [moduleTable(spec, 'API connections', ctx.runId, 'api.connection.list', CONNECTION_COLUMNS, connectionRows(await s.connections()))],
            suggestions: ['Show the request log', 'How did our email campaigns do on Relay?'],
          };
        },
      },
      {
        name: 'api_status',
        description: 'The API connections: platform, sign-in type, access, saved requests, the last call and errors in the last 7 days.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          const list = await need(ctx).connections();
          if (!list.length) return { text: 'There are no API connections yet. Enter the platform’s key under “Connect a source”, Vendor API, on Integrations, then ask me to test it.', suggestions: [] };
          const c = list[0]!;
          const pull = c.requests.find((q) => q.purpose === 'pull');
          return {
            text: `${plural(list.length, 'API connection')}. **${c.name}** ${c.access === 'read_write' ? 'reads campaign results and can send contact lists' : 'reads campaign results'}; ${pull?.lastRunAt ? `the last pull ran ${at(pull.lastRunAt)} and brought ${plural(pull.lastRows ?? 0, 'campaign')}` : 'it hasn’t pulled yet'}. ${c.errors7d ? `${plural(c.errors7d, 'call')} failed in the last 7 days.` : 'No call failed in the last 7 days.'}`,
            blocks: [
              moduleTable(spec, 'API connections', ctx.runId, 'api.connection.list', CONNECTION_COLUMNS, connectionRows(list)),
              moduleTable(spec, 'Saved requests', ctx.runId, 'api.request.list', [text('connection', 'Connection'), text('name', 'Saved request'), text('call', 'Call'), text('when', 'Runs'), text('from', 'Next pull from'), text('last', 'Last run')], list.flatMap((x) => x.requests.map((q) => ({ connection: x.name, name: q.name, call: `${q.method} ${q.endpoint}`, when: q.purpose === 'pull' ? (q.schedule ?? 'On request') : 'Only on an approved send', from: q.watermark ? at(q.watermark) : '—', last: q.lastRunAt ? `${at(q.lastRunAt)}, ${plural(q.lastRows ?? 0, 'row')}` : '—' })))),
            ],
            suggestions: ['Show the last five errors from the request log', 'Pull from Relay now'],
          };
        },
      },
      {
        name: 'api_log',
        description: 'The request log, newest first: every call with its status, time taken and headers with secrets removed. errors_only for failed calls; limit up to 50.',
        input: z.object({ errors_only: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
        run: async (a: { errors_only?: boolean; limit?: number }, ctx): Promise<ModuleView> => {
          const list = await need(ctx).log({ errorsOnly: a.errors_only, limit: a.limit ?? 10 });
          if (!list.length) return { text: a.errors_only ? 'No API call has failed. The request log keeps every call DI makes, with keys and tokens removed.' : 'No API calls yet.', suggestions: [] };
          const failed = list.filter((l) => l.error).length;
          return {
            text: a.errors_only
              ? `The last ${plural(list.length, 'failed call')}. The latest: **${list[0]!.method} ${list[0]!.endpoint}**, ${list[0]!.errorMessage ?? 'an error'}, at ${at(list[0]!.requestAt)}. Keys and tokens are removed before a call is logged; bodies with personal data are encrypted and kept 30 days.`
              : `The last ${plural(list.length, 'call')}, ${failed ? `${n(failed)} failed` : 'none failed'}. Keys and tokens are removed before a call is logged; bodies with personal data are encrypted and kept 30 days.`,
            blocks: [moduleTable(spec, a.errors_only ? 'Failed API calls' : 'Request log', ctx.runId, 'api.log.list', LOG_COLUMNS, logRows(list))],
            suggestions: a.errors_only ? ['Show the request log'] : ['Show the last five errors from the request log'],
          };
        },
      },
      {
        name: 'api_pull',
        description: 'Prepare running a connection’s pull requests now, from where the last pull stopped. Returns approval_required.',
        input: z.object({ connection: z.string().max(80).optional() }).strict(),
        run: async (a: { connection?: string }, ctx) => {
          const c = await connection(ctx, a.connection);
          const pull = c.requests.filter((q) => q.purpose === 'pull');
          return {
            change: {
              summary: `Pull ${pull.map((q) => q.name.toLowerCase()).join(' and ')} from ${c.name} now`,
              changes: pull.map((q) => ({ label: q.name, before: q.lastRunAt ? `Last pulled ${at(q.lastRunAt)}` : 'Never pulled', after: q.watermark ? `What changed since ${at(q.watermark)}` : 'Everything' })),
              text: `I’ll pull from **${c.name}** now, from where the last pull stopped, into DI’s campaign results.`,
              done: `Pulled from ${c.name}.`,
              risk: 'low',
              apply: { connectionId: c.connectionId },
            },
          };
        },
        apply: async (p: { connectionId: number }, _meta, ctx): Promise<ModuleView> => {
          const r = await need(ctx).pull(p.connectionId, ctx.runId);
          const x = r.results[0];
          return { text: `Pulled from **${r.connection}**: ${plural(x?.rows ?? 0, 'campaign')} ${x?.since ? `changed since ${at(x.since)}` : 'in all'}, in ${plural(x?.pages ?? 0, 'page')}.`, suggestions: ['How did our email campaigns do on Relay?'] };
        },
      },
    ],
  };
  return spec;
}
