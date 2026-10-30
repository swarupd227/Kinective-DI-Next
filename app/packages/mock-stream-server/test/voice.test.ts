// @vitest-environment node
// Voice socket end to end (spec 7, 12.7) with a fake speech provider: capture to a normalised final
// transcript, spoken answers for voice-initiated turns with captions, barge-in, and the rule that
// voice never approves a high-risk card.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { VoiceServerMessage } from '@dinext/block-schemas';
import { createApiClient, createStreamStore, StreamConnection, type ThreadState } from '@dinext/stream-client';
import { FakeSpeechProvider, VoiceGateway } from '@dinext/voice';
import { startMockServer } from '../src/index.ts';

const PORT = 18807;
const base = `http://localhost:${PORT}`;
const provider = new FakeSpeechProvider();
const voice = new VoiceGateway({ provider });
let server: ReturnType<typeof startMockServer>;

beforeAll(() => {
  server = startMockServer({ port: PORT, speed: 0.02, voice });
});
afterAll(async () => {
  voice.close();
  await server.close();
});

const until = async (fn: () => boolean, ms = 6000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

async function voiceSocket() {
  const { ticket } = (await (await fetch(`${base}/v1/stream/ticket`, { method: 'POST' })).json()) as { ticket: string };
  const ws = new WebSocket(`ws://localhost:${PORT}/v1/voice?ticket=${ticket}`);
  const messages: VoiceServerMessage[] = [];
  let audioBytes = 0;
  ws.on('message', (data, binary) => (binary ? (audioBytes += (data as Buffer).byteLength) : messages.push(JSON.parse(String(data)) as VoiceServerMessage)));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, messages, audio: () => audioBytes, send: (m: unknown) => ws.send(JSON.stringify(m)), of: <T extends VoiceServerMessage['type']>(t: T) => messages.filter((m) => m.type === t) as Extract<VoiceServerMessage, { type: T }>[] };
}

const start = { type: 'session.start', mode: 'push_to_talk', language: 'en-US', audio: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 100 }, tts: { enabled: true, rate: 1 } };

async function streamClient() {
  const stream = createStreamStore();
  let state = 'closed';
  const conn = new StreamConnection({
    store: stream,
    clientVersion: 'test',
    onState: (s) => (state = s),
    url: async () => {
      const { ticket } = (await (await fetch(`${base}/v1/stream/ticket`, { method: 'POST' })).json()) as { ticket: string };
      return `ws://localhost:${PORT}/v1/stream?ticket=${ticket}`;
    },
  });
  conn.start();
  await until(() => state === 'open');
  return { conn, stream, api: createApiClient({ baseUrl: base }), thread: (id: string) => stream.store.getState().threads[id] as ThreadState | undefined };
}

describe('voice gateway', () => {
  it('reports voice as available in the session', async () => {
    const s = (await (await fetch(`${base}/v1/session`)).json()) as { voice: { available: boolean; speakByDefault: boolean } };
    expect(s.voice).toEqual({ available: true, speakByDefault: true });
  });

  it('refuses a voice socket without a ticket', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/v1/voice?ticket=nope`);
    expect(await new Promise((r) => (ws.once('open', () => r('open')), ws.once('error', () => r('refused'))))).toBe('refused');
  });

  it('streams partials, then a normalised final transcript, biased by the tenant vocabulary', async () => {
    const v = await voiceSocket();
    provider.transcripts.push({ text: 'show loan growth for q three versus q two over two point five million dollars', confidence: 0.94 });
    v.send(start);
    await until(() => v.of('session.ready').length === 1);
    for (let i = 0; i < 6; i++) v.ws.send(Buffer.alloc(3200));
    v.send({ type: 'utterance.end' });
    await until(() => v.of('transcript.final').length === 1);
    expect(v.of('transcript.partial').map((m) => m.text)).toEqual(['show', 'show loan', 'show loan growth', 'show loan growth for', 'show loan growth for q', 'show loan growth for q three']);
    expect(v.of('transcript.final')[0]).toMatchObject({ normalised: 'Show loan growth for Q3 versus Q2 over $2,500,000', confidence: 0.94, identifiers: [] });
    expect(provider.phrases).toEqual(expect.arrayContaining(['HELOC', 'Westport', 'NCUA 5300']));
    v.ws.close();
  });

  it('speaks a voice-initiated answer with captions and the build date, and stops on barge-in', async () => {
    const c = await streamClient();
    const v = await voiceSocket();
    const threadId = 'thr_voice1';
    v.send({ type: 'tts.subscribe', threadId, enabled: true, rate: 1 });
    c.conn.subscribe(threadId);
    provider.msPerChar = 2;
    await c.api.sendMessage(threadId, { clientMessageId: 'cm_v1', input: { kind: 'text', text: 'Show loan growth by branch for Q3 vs Q2' }, inputChannel: 'voice', context: [] });
    await until(() => v.of('tts.end').length >= 1);
    const spoken = v.of('tts.start')[0]!.text;
    expect(spoken).toMatch(/^Loan balances grew 2\.4 percent in Q3/);
    expect(spoken).toContain('18.2 million dollars');
    expect(spoken).toMatch(/Based on last night’s build\.$/);
    expect(v.of('tts.sentence').map((m) => m.text)[0]).toMatch(/^Loan balances grew 2\.4 percent in Q3, ahead of Q2/);
    expect(v.audio()).toBeGreaterThan(0);

    // A typed turn in the same thread is not spoken.
    const before = v.of('tts.start').length;
    await c.api.sendMessage(threadId, { clientMessageId: 'cm_v2', input: { kind: 'text', text: 'What can you do?' }, inputChannel: 'text', context: [] });
    await until(() => c.thread(threadId)!.turns.filter((t) => t.kind === 'agent' && t.state === 'completed').length === 2);
    expect(v.of('tts.start')).toHaveLength(before);

    // Barge-in: speech stops and the server acknowledges.
    provider.msPerChar = 400;
    await c.api.sendMessage(threadId, { clientMessageId: 'cm_v3', input: { kind: 'text', text: 'Brief me' }, inputChannel: 'voice', context: [] });
    await until(() => v.of('tts.start').length === before + 1);
    v.send({ type: 'tts.cancel' });
    await until(() => v.of('barge_in.ack').length === 1);
    expect(v.of('tts.end').at(-1)).toMatchObject({ cancelled: true });
    provider.msPerChar = 4;
    c.conn.stop();
    v.ws.close();
  });

  it('never lets voice approve a high-risk card, and says so', async () => {
    const c = await streamClient();
    const v = await voiceSocket();
    const threadId = 'thr_voice2';
    v.send({ type: 'tts.subscribe', threadId, enabled: true, rate: 1 });
    c.conn.subscribe(threadId);
    await c.api.sendMessage(threadId, { clientMessageId: 'cm_v4', input: { kind: 'text', text: 'Approve October incentive payouts for Westport' }, inputChannel: 'voice', context: [] });
    await until(() => (c.thread(threadId)?.pendingApprovals.length ?? 0) === 1);
    await until(() => v.of('tts.start').some((m) => m.text === 'This needs your approval on screen.'));
    const blockId = c.thread(threadId)!.pendingApprovals[0]!;
    const card = c.thread(threadId)!.blocks[blockId]!.envelope.data as { approvalId: string; previewHash: string; idempotencyKey: string };
    const r = await c.api.decide(card.approvalId, { decision: 'approve', channel: 'voice', typedConfirmation: null, note: null, editedPlan: null, stepUpToken: null, clientContext: { blockVersionSeen: '1.2.0', previewHash: card.previewHash } }, card.idempotencyKey);
    expect(r).toMatchObject({ ok: false, code: 'CONFIRMATION_MISMATCH' });
    c.conn.stop();
    v.ws.close();
  });

  it('speaks fixed phrases only', async () => {
    const v = await voiceSocket();
    v.send({ type: 'say', phrase: 'say_confirm' });
    v.send({ type: 'say', phrase: 'anything I like' });
    await until(() => v.of('tts.end').length === 1);
    expect(v.of('tts.start').map((m) => m.text)).toEqual(['I didn’t catch a clear yes. Say confirm, or press Approve.']);
    v.ws.close();
  });
});
