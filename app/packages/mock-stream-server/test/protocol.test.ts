// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient, createStreamStore, StreamConnection, type ThreadState } from '@dinext/stream-client';
import { startMockServer } from '../src/index.ts';

const PORT = 18787;
const base = `http://localhost:${PORT}`;
let server: ReturnType<typeof startMockServer>;

beforeAll(() => {
  server = startMockServer({ port: PORT, speed: 0.02 });
});
afterAll(() => server.close());

const until = async (fn: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function client() {
  const stream = createStreamStore();
  let sockets = 0;
  let state = 'closed';
  const conn = new StreamConnection({
    store: stream,
    clientVersion: 'test',
    onState: (s) => (state = s),
    url: async () => {
      const { ticket } = (await (await fetch(`${base}/v1/stream/ticket`, { method: 'POST' })).json()) as { ticket: string };
      sockets += 1;
      return `ws://localhost:${PORT}/v1/stream?ticket=${ticket}`;
    },
  });
  return { stream, conn, api: createApiClient({ baseUrl: base }), state: () => state, sockets: () => sockets };
}

const send = (api: ReturnType<typeof createApiClient>, threadId: string, text: string, conn?: StreamConnection) => {
  conn?.subscribe(threadId);
  return api.sendMessage(threadId, { clientMessageId: `cm_${Math.random()}`, input: { kind: 'text', text }, inputChannel: 'text', context: [] });
};

describe('mock stream server and client protocol', () => {
  it('rejects a socket without a valid one-time ticket', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/v1/stream?ticket=nope`);
    const closed = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(false);
      ws.onerror = () => resolve(true);
      ws.onclose = () => resolve(true);
    });
    expect(closed).toBe(true);
  });

  it('streams a referral run to an approval, then applies the decision once per idempotency key', async () => {
    const { stream, conn, api, state } = client();
    conn.start();
    await until(() => state() === 'open');
    const threadId = 'thr_proto1';
    await send(api, threadId, 'Refer Suzanne for a HELOC', conn);
    const thread = () => stream.store.getState().threads[threadId] as ThreadState | undefined;
    await until(() => (thread()?.pendingApprovals.length ?? 0) === 1);

    const blockId = thread()!.pendingApprovals[0]!;
    const card = thread()!.blocks[blockId]!.envelope.data as { approvalId: string; previewHash: string; idempotencyKey: string };
    const body = { decision: 'approve' as const, channel: 'click' as const, typedConfirmation: null, note: null, editedPlan: null, stepUpToken: null, clientContext: { blockVersionSeen: '1.2.0', previewHash: card.previewHash } };

    const first = await api.decide(card.approvalId, body, card.idempotencyKey);
    const retry = await api.decide(card.approvalId, body, card.idempotencyKey);
    expect(first).toMatchObject({ ok: true, decision: 'approved' });
    expect(retry).toEqual(first);
    const other = await api.decide(card.approvalId, body, 'idem_different_key');
    expect(other).toMatchObject({ ok: false, code: 'ALREADY_DECIDED' });

    await until(() => thread()!.turns.some((t) => t.kind === 'agent' && t.state === 'completed'));
    expect(thread()!.blocks[blockId]!.envelope.data).toMatchObject({ resolution: { decision: 'approved' } });
    conn.stop();
  });

  it('enforces step-up, typed confirmation and the preview hash on high-risk approvals', async () => {
    const { stream, conn, api, state } = client();
    conn.start();
    await until(() => state() === 'open');
    const threadId = 'thr_proto2';
    await send(api, threadId, 'Approve October incentive payouts', conn);
    const thread = () => stream.store.getState().threads[threadId];
    await until(() => (thread()?.pendingApprovals.length ?? 0) === 1);
    const blockId = thread()!.pendingApprovals[0]!;
    const card = thread()!.blocks[blockId]!.envelope.data as { approvalId: string; previewHash: string };
    const body = (over: object) => ({ decision: 'approve' as const, channel: 'click' as const, typedConfirmation: '$9,720.00', note: 'ok', editedPlan: null, stepUpToken: null, clientContext: { blockVersionSeen: '1.2.0', previewHash: card.previewHash }, ...over });

    expect(await api.decide(card.approvalId, body({ channel: 'voice' }), 'k1')).toMatchObject({ ok: false, code: 'CONFIRMATION_MISMATCH' });
    expect(await api.decide(card.approvalId, body({ typedConfirmation: '$9,000' }), 'k2')).toMatchObject({ ok: false, code: 'CONFIRMATION_MISMATCH' });
    expect(await api.decide(card.approvalId, body({ clientContext: { blockVersionSeen: '1.2.0', previewHash: 'sha256:00000000' } }), 'k3')).toMatchObject({ ok: false, code: 'PREVIEW_CHANGED' });
    expect(await api.decide(card.approvalId, body({}), 'k4')).toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED' });
    const token = await api.stepUp();
    expect(await api.decide(card.approvalId, body({ stepUpToken: token }), 'k5')).toMatchObject({ ok: true, decision: 'approved' });
    conn.stop();
  });

  it('delivers only subscribed threads, and replays a thread from the start on subscribe', async () => {
    const a = client();
    const b = client();
    a.conn.start();
    b.conn.start();
    await until(() => a.state() === 'open' && b.state() === 'open');
    await send(a.api, 'thr_isoA', 'What can you do?', a.conn);
    await until(() => a.stream.store.getState().threads.thr_isoA?.turns.some((t) => t.kind === 'agent' && t.state === 'completed') ?? false);
    expect(b.stream.store.getState().threads.thr_isoA).toBeUndefined();
    b.conn.subscribe('thr_isoA');
    await until(() => b.stream.store.getState().threads.thr_isoA?.lastSeq === a.stream.store.getState().threads.thr_isoA!.lastSeq);
    expect(b.stream.store.getState().threads.thr_isoA!.turns).toHaveLength(2);
    a.conn.stop();
    b.conn.stop();
  });

  it('scopes apps, slash commands, search and table rows to the persona (FE-EXP-003, FE-SRCH-002)', async () => {
    const api = createApiClient({ baseUrl: base });
    const bank = await api.session('bank_cfo');
    expect(bank.tenant.institutionType).toBe('bank');
    expect(bank.apps).not.toContain('seg');
    expect(bank.apps).not.toContain('callreport');
    expect(bank.slashCommands).toContain('/customer');

    const branch = await api.session('branch');
    expect(branch.slashCommands).not.toContain('/query');
    const hits = await api.search('jackson');
    expect(hits.map((h) => h.label)).toEqual(['Suzanne Jackson']);
    expect(hits[0]!.link).not.toMatch(/4521/);
    const loans = await api.table('loan_accounts');
    expect(new Set(loans.rows.map((r) => r.branch))).toEqual(new Set(['Westport']));

    await api.session('executive');
    const home = await api.home();
    expect(home.sections[0]!.id).toBe('approvals');
    expect((await api.search('jackson')).length).toBe(2);
  });

  it('replays missed events after a reconnect so the thread ends complete and in order (spec 11.6)', async () => {
    const { stream, conn, api, state, sockets } = client();
    conn.start();
    await until(() => state() === 'open');
    const threadId = 'thr_proto3';
    await send(api, threadId, 'Show loan growth by branch', conn);
    await until(() => (stream.store.getState().threads[threadId]?.lastSeq ?? 0) > 3);
    conn.requestReplay(); // drops the socket mid-run; the client reconnects with resume
    await until(() => sockets() >= 2, 6000);
    await until(() => stream.store.getState().threads[threadId]?.turns.some((t) => t.kind === 'agent' && t.state === 'completed') ?? false, 8000);
    const t = stream.store.getState().threads[threadId]!;
    const types = Object.values(t.blocks).map((b) => [b.envelope.type, b.status]);
    expect(types).toEqual(expect.arrayContaining([['plan_steps', 'complete'], ['text', 'complete'], ['chart', 'complete'], ['table', 'complete']]));
    conn.stop();
  }, 15000);
});
