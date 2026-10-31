// @vitest-environment node
// End-to-end write through an approval card (spec 6.9–6.10, 25.3): the live Experience server with
// the Concierge's offline planner, against the seeded warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiClient, createStreamStore, StreamConnection, type ThreadState } from '@dinext/stream-client';
import { createPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import type { VoiceServerMessage } from '@dinext/block-schemas';
import { FakeSpeechProvider, VoiceGateway } from '@dinext/voice';
import { WebSocket } from 'ws';

const PORT = 18797;
const speech = new FakeSpeechProvider();
const voice = new VoiceGateway({ provider: speech });
const base = `http://localhost:${PORT}`;
const available = await warehouseAvailable('dinext_t_test_cu');
let server: { close: () => Promise<void> };
let live: { close: () => Promise<void> } | null = null;
let admin: Pool;
const approvalIds: string[] = [];

beforeAll(async () => {
  if (!available) return;
  delete process.env.DI_ANTHROPIC_API_KEY;
  process.env.DI_DATA_DIR = mkdtempSync(join(tmpdir(), 'dinext-live-'));
  const { startMockServer, startLiveRuntime } = await import('../src/index.ts');
  live = await startLiveRuntime();
  server = startMockServer({ port: PORT, speed: 0.02, live: live as never, voice });
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
}, 60_000);
afterAll(async () => {
  if (!available) return;
  if (approvalIds.length) {
    await admin.query('DELETE FROM esp_com_lines WHERE com_id IN (SELECT com_id FROM esp_com_items WHERE approval_id IN (?))', [approvalIds]);
    await admin.query('DELETE FROM esp_com_items WHERE approval_id IN (?)', [approvalIds]);
  }
  await admin.query("DELETE FROM ai_approvals WHERE requested_by IN ('user:5120', 'user:9229')");
  await admin.query('UPDATE esp_com_queues SET rr_pointer = 0');
  voice.close();
  await server.close();
  await live?.close();
  await admin.end();
}, 30_000);

const until = async (fn: () => boolean, ms = 8000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function client() {
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
  const api = createApiClient({ baseUrl: base });
  const thread = (id: string) => stream.store.getState().threads[id] as ThreadState | undefined;
  const send = (threadId: string, text: string) => {
    conn.subscribe(threadId);
    return api.sendMessage(threadId, { clientMessageId: `cm_${Math.random()}`, input: { kind: 'text', text }, inputChannel: 'text', context: [] });
  };
  const texts = (id: string) =>
    Object.values(thread(id)?.blocks ?? {})
      .map((b) => b.envelope as { type: string; data: { markdown?: string; message?: string } })
      .map((b) => (b.type === 'text' ? (b.data.markdown ?? '') : b.type === 'notice' ? (b.data.message ?? '') : ''))
      .join('\n');
  const pendingCard = (id: string) => {
    const blockId = thread(id)?.pendingApprovals.at(-1);
    if (!blockId) return null;
    const d = thread(id)!.blocks[blockId]!.envelope.data as { approvalId: string; previewHash: string; idempotencyKey: string; preview: { fields: { label: string; value: string }[] } };
    return { blockId, ...d };
  };
  const completedTurns = (id: string) => thread(id)?.turns.filter((t) => t.kind === 'agent' && t.state === 'completed').length ?? 0;
  return { conn, api, thread, send, texts, pendingCard, completedTurns };
}

const approve = (previewHash: string) => ({ decision: 'approve' as const, channel: 'click' as const, typedConfirmation: null, note: null, editedPlan: null, stepUpToken: null, clientContext: { blockVersionSeen: '1.2.0', previewHash } });
const persona = (p: string) => fetch(`${base}/v1/session?persona=${p}`).then((r) => r.json());
const approvalNotices = async (detail: string) => ((await (await fetch(`${base}/v1/notifications`)).json()) as { notifications: { title: string; detail: string; read: boolean }[] }).notifications.filter((n) => n.detail === detail);

describe.skipIf(!available)('a referral end to end through an approval card', () => {
  it('drafts, replaces the draft on a follow-up, and creates exactly what was approved, once', async () => {
    await persona('branch');
    const c = await client();
    const t = 'thr_live_ref1';
    await c.send(t, 'Refer Suzanne Jackson for a HELOC, she prefers email after 5 pm');
    await until(() => c.pendingCard(t) !== null);
    const first = c.pendingCard(t)!;
    approvalIds.push(first.approvalId);
    const fields = Object.fromEntries(first.preview.fields.map((f) => [f.label, f.value]));
    expect(fields).toMatchObject({ Member: 'Suzanne Jackson (…4521) · Westport', 'Category / Type': 'Lending / HELOC', 'Preferred contact method': 'Email', 'Best time to contact': 'Evening' });
    expect(fields.To).toMatch(/^Westport Lending Queue \(next: (Ana Ruiz|Tom Walsh)\)$/);
    expect(c.texts(t)).toMatch(/HELOC\*\* referral for \*\*Suzanne Jackson\*\*, going to the \*\*Westport Lending Queue\*\*/);
    expect(c.texts(t)).toContain('Nothing goes out until you approve');

    // A follow-up edits the draft: a new card, and the old one can no longer be approved.
    await c.send(t, 'make it a phone call instead');
    await until(() => (c.pendingCard(t)?.approvalId ?? first.approvalId) !== first.approvalId);
    const second = c.pendingCard(t)!;
    approvalIds.push(second.approvalId);
    expect(Object.fromEntries(second.preview.fields.map((f) => [f.label, f.value]))['Preferred contact method']).toBe('Phone');
    await until(() => (c.thread(t)!.blocks[first.blockId]!.envelope.data as { resolution?: { decision: string } }).resolution?.decision === 'expired');
    expect(await c.api.decide(first.approvalId, approve(first.previewHash), first.idempotencyKey)).toMatchObject({ ok: false, code: 'EXPIRED' });

    const ok = await c.api.decide(second.approvalId, approve(second.previewHash), second.idempotencyKey);
    expect(ok).toMatchObject({ ok: true, decision: 'approved' });
    expect(await c.api.decide(second.approvalId, approve(second.previewHash), second.idempotencyKey)).toEqual(ok);
    expect(await c.api.decide(second.approvalId, approve(second.previewHash), 'idem_other_key_1')).toMatchObject({ ok: false, code: 'ALREADY_DECIDED' });
    // The confirmation streams word by word; wait for the whole sentence.
    await until(() => /Referral \*\*#\d+\*\*[^\n]*in the evening\./.test(c.texts(t)));
    expect(c.texts(t)).toMatch(/Referral \*\*#\d+\*\* \(HELOC\) is in the \*\*Westport Lending Queue\*\*\. \*\*(Ana Ruiz|Tom Walsh)\*\* has it and will contact Suzanne by phone in the evening\./);

    const [rows] = await admin.query('SELECT com_id, approval_id, fields, sender_user_id, stage FROM esp_com_items WHERE approval_id IN (?)', [[first.approvalId, second.approvalId]]);
    const created = rows as { approval_id: string; fields: Record<string, string>; sender_user_id: string; stage: string }[];
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ approval_id: second.approvalId, sender_user_id: 'user:5120', stage: 'New Referral', fields: { preferred_contact: 'Phone', best_time: 'Evening' } });
    c.conn.stop();
  });

  it('does not find members outside the purview, and says so the same way as for nobody', async () => {
    await persona('branch');
    const c = await client();
    await c.send('thr_live_ref2', 'Refer Robert Jackson for a mortgage, he prefers email');
    await c.send('thr_live_ref3', 'Refer Zebedee Quinterro for a mortgage, he prefers email');
    await until(() => c.completedTurns('thr_live_ref2') === 1 && c.completedTurns('thr_live_ref3') === 1);
    expect(c.texts('thr_live_ref2')).toBe('I couldn’t find a member named “Robert Jackson” that you can refer. Check the spelling, or search with **Ctrl+K**.');
    expect(c.texts('thr_live_ref3')).toMatch(/^I couldn’t find a member named “Zebedee Quinterro” that you can refer\./);
    c.conn.stop();
  });

  it('asks for a missing required field, then drafts; another user cannot approve it', async () => {
    await persona('executive');
    const c = await client();
    const t = 'thr_live_ref4';
    await c.send(t, 'Refer Maria Gomez for a mortgage');
    await until(() => c.texts(t).includes('How does the member prefer to be contacted?'));
    await c.send(t, 'By email');
    await until(() => c.pendingCard(t) !== null);
    const card = c.pendingCard(t)!;
    approvalIds.push(card.approvalId);
    expect(Object.fromEntries(card.preview.fields.map((f) => [f.label, f.value])).To).toBe('Mortgage Center (a team member claims it)');
    const { summary } = c.thread(t)!.blocks[c.thread(t)!.pendingApprovals.at(-1)!]!.envelope.data as { summary: string };
    expect(await approvalNotices(summary)).toMatchObject([{ title: 'Approval needed', read: false }]);

    await persona('analyst');
    expect(await c.api.decide(card.approvalId, approve(card.previewHash), card.idempotencyKey)).toMatchObject({ ok: false });
    await persona('executive');
    const deny = await c.api.decide(card.approvalId, { ...approve(card.previewHash), decision: 'deny' }, card.idempotencyKey);
    expect(deny).toMatchObject({ ok: true, decision: 'denied' });
    await until(() => c.texts(t).includes('Nothing was sent.'));
    expect(await approvalNotices(summary)).toMatchObject([{ title: 'Approval denied', read: true }]);
    const [rows] = await admin.query('SELECT COUNT(*) AS n FROM esp_com_items WHERE approval_id = ?', [card.approvalId]);
    expect((rows as { n: number }[])[0]!.n).toBe(0);
    c.conn.stop();
  });

  it('accepts a spoken confirmation of a medium card only after its read-back (FE-VOICE-041)', async () => {
    await persona('branch');
    const c = await client();
    const t = 'thr_live_voice1';
    const { ticket } = (await (await fetch(`${base}/v1/stream/ticket`, { method: 'POST' })).json()) as { ticket: string };
    const ws = new WebSocket(`ws://localhost:${PORT}/v1/voice?ticket=${ticket}`);
    const heard: VoiceServerMessage[] = [];
    ws.on('message', (d, binary) => !binary && heard.push(JSON.parse(String(d)) as VoiceServerMessage));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'tts.subscribe', threadId: t, enabled: true, rate: 1 }));
    // Slow synthesis, so the read-back is still playing when the first "confirm" arrives.
    speech.msPerChar = 40;
    c.conn.subscribe(t);
    await c.api.sendMessage(t, { clientMessageId: 'cm_lv1', input: { kind: 'text', text: 'Refer Suzanne Jackson for a HELOC, she prefers email' }, inputChannel: 'voice', context: [] });
    await until(() => c.pendingCard(t) !== null);
    const card = c.pendingCard(t)!;
    approvalIds.push(card.approvalId);
    await until(() => heard.some((m) => m.type === 'tts.start' && m.approvalId === card.approvalId));
    expect(heard.find((m) => m.type === 'tts.start' && m.approvalId === card.approvalId)).toMatchObject({ text: 'This will send 1 HELOC referral to the Westport Lending Queue. Say confirm, or press Approve.' });

    const byVoice = { ...approve(card.previewHash), channel: 'voice' as const };
    expect(await c.api.decide(card.approvalId, byVoice, card.idempotencyKey)).toMatchObject({ ok: false, code: 'CONFIRMATION_MISMATCH', message: 'Wait for the summary to finish, then say confirm.' });
    await until(() => heard.some((m) => m.type === 'tts.end' && m.approvalId === card.approvalId && !m.cancelled), 20_000);
    expect(await c.api.decide(card.approvalId, byVoice, card.idempotencyKey)).toMatchObject({ ok: true, decision: 'approved' });
    await until(() => (c.thread(t)!.blocks[card.blockId]!.envelope.data as { resolution?: { channel?: string } }).resolution?.channel === 'voice');
    speech.msPerChar = 4;
    ws.close();
    c.conn.stop();
  }, 30_000);
});
