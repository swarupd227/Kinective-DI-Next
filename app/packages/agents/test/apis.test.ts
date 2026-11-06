// @vitest-environment node
// The third way data reaches DI: an API connection. Sign-in details are sealed, every call is logged
// with secrets removed, hosts outside the list are refused, and the marketing round trip sends an
// approved audience under references and pulls the results back a page at a time, from where the
// last pull stopped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '@dinext/block-schemas';
import { ApiService, ApprovalStore, CampaignService, secretKeyFrom } from '@dinext/di-core';
import { RELAY_BASE_URL, createPool, relayDemoKey, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { apisModule, campaignModule, ModuleGateway, runModuleOffline, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM sim_relay_campaign LIMIT 1').then(() => true, () => false));

describe.skipIf(!up)('API connections and the marketing round trip', () => {
  let pool: Pool;
  let admin: Pool;
  let api: ApiService;
  let gateway: ModuleGateway;
  let specs: ModuleSpec[];
  const SAM = { id: 'user:1002', name: 'Sam Taylor', title: 'DI Administrator' };
  const turn = (text: string): ModuleTurn => ({ runId: 'R-apis', threadId: `thr_${Math.random().toString(36).slice(2, 10)}`, text, user: SAM, tenant: { name: 'Harborview Federal Credit Union' }, modules: ['apis', 'campaigns'] });
  const run = async (t: ModuleTurn, spec: ModuleSpec) => {
    const texts: string[] = [];
    const blocks: Block[] = [];
    const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
    const out = await runModuleOffline(spec, t, { gateway }, sink);
    return { text: texts.join(' '), blocks, out, t };
  };
  const approve = async (o: Awaited<ReturnType<typeof run>>) => {
    const a = await new ApprovalStore(pool).decide(o.out.approval!.record.approvalId, { decision: 'approved', userId: SAM.id, payloadHash: o.out.approval!.record.payloadHash });
    return gateway.execute(a, { user: SAM, modules: o.t.modules, runId: o.t.runId, threadId: o.t.threadId });
  };
  const clear = async () => {
    for (const t of ['api_credential', 'api_connection', 'api_request', 'api_request_log', 'cmp_push', 'cmp_push_member', 'cmp_platform_metric', 'sim_relay_list']) await admin.query(`DELETE FROM ${t}`);
    await admin.query('DELETE FROM sim_relay_campaign WHERE list_id IS NOT NULL');
  };

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    await clear();
    api = new ApiService(pool, { secretKey: secretKeyFrom(), allowedHosts: ['api.relay-marketing.example'] });
    specs = [apisModule(api), campaignModule(new CampaignService(pool), api)];
    gateway = new ModuleGateway(new ApprovalStore(pool), specs);
  });
  afterAll(async () => {
    await clear();
    await Promise.all([pool.end(), admin.end()]);
  });

  it('refuses a wrong key, and never writes a key into the log', async () => {
    const wrong = await api.saveLogin({ kind: 'api_key', label: 'Wrong key', secret: 'rly_test_not_this_one' }, { userId: SAM.id });
    const r = await api.test({ platform: 'relay', baseUrl: RELAY_BASE_URL, credentialId: wrong.credentialId }, SAM.id);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    const [log] = (await admin.query('SELECT request_headers FROM api_request_log ORDER BY log_id DESC LIMIT 1')) as unknown as [{ request_headers: string }[]];
    expect(log[0]!.request_headers).toContain('[removed]');
    expect(log[0]!.request_headers).not.toContain('rly_test_not_this_one');
    // Nobody else can use someone's saved details.
    await expect(api.login(wrong.credentialId, 'user:9229')).rejects.toThrow(/no API sign-in details/);
  });

  it('refuses a host outside the list, and logs the refusal', async () => {
    const key = await api.saveLogin({ kind: 'api_key', label: 'Elsewhere', secret: relayDemoKey() }, { userId: SAM.id });
    await expect(api.call({ connectionId: 0, baseUrl: 'https://collect.elsewhere.example/v1', credentialId: key.credentialId }, 'GET', '/ping')).rejects.toThrow(/isn’t one of them/);
    const [log] = (await admin.query('SELECT error_message, status_code FROM api_request_log ORDER BY log_id DESC LIMIT 1')) as unknown as [{ error_message: string; status_code: number | null }[]];
    expect(log[0]!.error_message).toMatch(/^Blocked/);
    expect(log[0]!.status_code).toBeNull();
  });

  it('tests, connects on a high-risk approval, and pulls every page', async () => {
    const key = await api.saveLogin({ kind: 'api_key', label: 'Relay Marketing key', secret: relayDemoKey() }, { userId: SAM.id });
    const tested = await run(turn(`Test the Relay Marketing API (API details #${key.credentialId})`), specs[0]!);
    expect(tested.text).toMatch(/Relay Marketing signed in/);
    const connect = await run(turn(`Connect it (API details #${key.credentialId})`), specs[0]!);
    expect(connect.out.approval?.record.riskTier).toBe('high');
    await approve(connect);
    const [c] = await api.connections();
    expect(c!.access).toBe('read_write');
    expect(c!.requests.map((q) => q.name)).toEqual(['Campaign results', 'Send a contact list', 'Start a campaign']);
    const pull = c!.requests[0]!;
    // Eight email and digital campaigns, five to a page.
    expect(pull.lastRows).toBe(8);
    expect(pull.watermark).toBeTruthy();
    const calls = await api.log({ limit: 50 });
    expect(calls.filter((l) => l.endpoint === '/v1/campaigns' && l.method === 'GET').length).toBe(2);
    const results = await api.platformResults();
    expect(results.metrics.filter((m) => m.campaignId !== null).length).toBe(8);
    expect((await run(turn('Show the last five errors from the request log'), specs[0]!)).text).toMatch(/failed call/);
  }, 60_000);

  it('sends an approved audience under references, and pulls only what changed', async () => {
    const send = await run(turn('Send members with no auto loan to Relay'), specs[1]!);
    expect(send.out.approval?.record.riskTier).toBe('high');
    expect(send.text).toMatch(/reference only DI can match back/);
    await approve(send);
    const [push] = (await api.platformResults()).pushes;
    expect(push!.contacts).toBeGreaterThan(1000);
    const [[members], [lists]] = (await Promise.all([admin.query('SELECT COUNT(*) AS n FROM cmp_push_member'), admin.query('SELECT refs FROM sim_relay_list')])) as unknown as [[{ n: number }[]], [{ refs: string }[]]];
    expect(Number(members[0]!.n)).toBe(push!.contacts);
    // The platform holds references, never member numbers or names.
    expect(lists[0]!.refs).toMatch(/^\["m_[0-9a-f]{16}"/);
    // The list's body is sealed in the log: no email address is readable there.
    const [bodies] = (await admin.query("SELECT body, body_sealed FROM api_request_log WHERE endpoint = '/v1/lists'")) as unknown as [{ body: string; body_sealed: number }[]];
    expect(bodies[0]!.body_sealed).toBe(1);
    expect(bodies[0]!.body).not.toContain('@');

    const pull = await run(turn('Pull back the campaign results'), specs[1]!);
    expect(pull.out.approval?.record.riskTier).toBe('low');
    await approve(pull);
    const [c] = await api.connections();
    expect(c!.requests[0]!.lastRows).toBe(1);
    const shown = await run(turn('How did the email do?'), specs[1]!);
    expect(shown.text).toMatch(/DI’s own send/);
    expect(shown.text).toMatch(/matched [\d,]+ clicks to members/);
    const own = (await api.platformResults()).metrics.find((m) => m.pushId !== null)!;
    expect((await api.clickers(own.pushId!)).length).toBe(own.clicked);
    // Past 30 days, the list's encrypted body is cleared; the record of the call stays.
    await admin.query("UPDATE api_request_log SET request_at = UTC_TIMESTAMP() - INTERVAL 31 DAY WHERE endpoint = '/v1/lists'");
    await api.pull(c!.connectionId);
    const listCall = (await api.log({ limit: 50 })).find((l) => l.endpoint === '/v1/lists')!;
    expect(listCall.body).toBe('Personal data, cleared after 30 days');
    expect(listCall.statusCode).toBe(201);
  }, 60_000);

  it('says what it can do when nothing is connected, and still refuses a file export', async () => {
    await clear();
    expect((await run(turn('Send members with no auto loan to Relay'), specs[1]!)).text).toMatch(/No marketing platform is connected/);
    expect((await run(turn('Export the audience of members with no auto loan'), specs[1]!)).text).toMatch(/can’t export an audience as a file/);
  });
});
