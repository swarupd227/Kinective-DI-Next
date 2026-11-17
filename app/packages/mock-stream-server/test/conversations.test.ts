// @vitest-environment node
// Tasks outlive the server: one server writes to the conversation store, the next one reads it back.
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient, createStreamStore, StreamConnection, type ThreadState } from '@dinext/stream-client';
import type { ThreadSummary } from '@dinext/block-schemas';
import { memoryConversationStore, startMockServer, type ConversationStore } from '../src/index.ts';

let port = 18830;
const running: ReturnType<typeof startMockServer>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

const until = async (fn: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function boot(store: ConversationStore, speed = 0.02) {
  const p = port++;
  const server = startMockServer({ port: p, speed, store });
  running.push(server);
  await server.ready;
  const base = `http://localhost:${p}`;
  const stream = createStreamStore();
  let state = 'closed';
  const conn = new StreamConnection({
    store: stream,
    clientVersion: 'test',
    onState: (s) => (state = s),
    url: async () => {
      const { ticket } = (await (await fetch(`${base}/v1/stream/ticket`, { method: 'POST' })).json()) as { ticket: string };
      return `ws://localhost:${p}/v1/stream?ticket=${ticket}`;
    },
  });
  conn.start();
  await until(() => state === 'open');
  const api = createApiClient({ baseUrl: base });
  const thread = (id: string) => stream.store.getState().threads[id] as ThreadState | undefined;
  const send = (threadId: string, text: string) => {
    conn.subscribe(threadId);
    return api.sendMessage(threadId, { clientMessageId: `cm_${Math.random()}`, input: { kind: 'text', text }, inputChannel: 'text', context: [] });
  };
  const stop = async () => {
    conn.stop();
    running.splice(running.indexOf(server), 1);
    await server.close();
  };
  return { base, api, conn, thread, send, stop };
}

const completed = (t: ThreadState | undefined) => t?.turns.filter((x) => x.kind === 'agent' && x.state === 'completed').length ?? 0;

describe('conversation store', () => {
  it('keeps a finished task, its title and its answer across a restart, and the task carries on', async () => {
    const store = memoryConversationStore();
    const a = await boot(store);
    await a.send('thr_keep1', 'What can you do?');
    await until(() => completed(a.thread('thr_keep1')) === 1);
    const turnsBefore = a.thread('thr_keep1')!.turns.length;
    await a.stop();

    const b = await boot(store);
    const list = (await (await fetch(`${b.base}/v1/threads`)).json()) as { threads: ThreadSummary[] };
    expect(list.threads.map((t) => t.threadId)).toContain('thr_keep1');
    expect(list.threads.find((t) => t.threadId === 'thr_keep1')!.title).toBe('What can you do?');
    expect((await fetch(`${b.base}/v1/threads/thr_keep1`)).status).toBe(200);
    b.conn.subscribe('thr_keep1');
    await until(() => (b.thread('thr_keep1')?.turns.length ?? 0) === turnsBefore);
    expect(completed(b.thread('thr_keep1'))).toBe(1);
    // A follow-up continues the same sequence rather than starting over.
    await b.send('thr_keep1', 'What can you do?');
    await until(() => completed(b.thread('thr_keep1')) === 2);
  });

  it('lets a card that was waiting at the restart be approved', async () => {
    const store = memoryConversationStore();
    const a = await boot(store);
    await a.send('thr_keep2', 'Refer Suzanne for a HELOC');
    await until(() => (a.thread('thr_keep2')?.pendingApprovals.length ?? 0) === 1);
    await a.stop();

    const b = await boot(store);
    b.conn.subscribe('thr_keep2');
    await until(() => (b.thread('thr_keep2')?.pendingApprovals.length ?? 0) === 1);
    const blockId = b.thread('thr_keep2')!.pendingApprovals[0]!;
    const card = b.thread('thr_keep2')!.blocks[blockId]!.envelope.data as { approvalId: string; previewHash: string; idempotencyKey: string };
    const body = { decision: 'approve' as const, channel: 'click' as const, typedConfirmation: null, note: null, editedPlan: null, stepUpToken: null, clientContext: { blockVersionSeen: '1.2.0', previewHash: card.previewHash } };
    expect(await b.api.decide(card.approvalId, body, card.idempotencyKey)).toMatchObject({ ok: true, decision: 'approved' });
    await until(() => completed(b.thread('thr_keep2')) === 1);
  });

  it('says so when a restart cut an answer off, instead of spinning forever', async () => {
    const store = memoryConversationStore();
    // At full speed the scripted answer takes a few seconds, long enough to stop the server mid-answer.
    const a = await boot(store, 1);
    await a.send('thr_keep3', 'What can you do?');
    await until(() => a.thread('thr_keep3')?.turns.some((t) => t.kind === 'agent') ?? false, 2000);
    await a.stop();

    const b = await boot(store);
    b.conn.subscribe('thr_keep3');
    await until(() => b.thread('thr_keep3')?.turns.some((t) => t.kind === 'agent' && t.state !== 'running') ?? false);
    const agent = b.thread('thr_keep3')!.turns.find((t) => t.kind === 'agent')!;
    expect(agent.state).toBe('failed');
  });

  it('still hides a task from everyone but the person who started it', async () => {
    const store = memoryConversationStore();
    const a = await boot(store);
    await a.send('thr_keep4', 'What can you do?');
    await until(() => completed(a.thread('thr_keep4')) === 1);
    await a.stop();

    const b = await boot(store);
    // Switch the server's person: the task is someone else's now.
    await fetch(`${b.base}/v1/session?persona=branch`);
    expect((await fetch(`${b.base}/v1/threads/thr_keep4`)).status).toBe(404);
    await fetch(`${b.base}/v1/session?persona=executive`);
    expect((await fetch(`${b.base}/v1/threads/thr_keep4`)).status).toBe(200);
  });
});
