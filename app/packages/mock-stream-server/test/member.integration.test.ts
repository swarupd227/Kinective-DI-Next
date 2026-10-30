// @vitest-environment node
// Member 360 end to end (spec 8.24): the live Experience server with the offline planner, against the
// seeded warehouse. Records are reached by opaque token, within purview, and every view is audited.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiClient, createStreamStore, StreamConnection, type ThreadState } from '@dinext/stream-client';
import { validateBlock, type ContextRef } from '@dinext/block-schemas';
import { memberToken } from '@dinext/di-core';
import { warehouseAvailable } from '@dinext/tenant-db';

const PORT = 18798;
const base = `http://localhost:${PORT}`;
const available = await warehouseAvailable('dinext_t_test_cu');
const dataDir = mkdtempSync(join(tmpdir(), 'dinext-member-'));
let server: { close: () => Promise<void> };
let live: { close: () => Promise<void> } | null = null;

const SUZANNE = memberToken('test_cu', 1);
const ROBERT = memberToken('test_cu', 19); // Northgate

beforeAll(async () => {
  if (!available) return;
  delete process.env.DI_ANTHROPIC_API_KEY;
  process.env.DI_DATA_DIR = dataDir;
  const { startMockServer, startLiveRuntime } = await import('../src/index.ts');
  live = await startLiveRuntime();
  server = startMockServer({ port: PORT, speed: 0.02, live: live as never });
}, 60_000);
afterAll(async () => {
  if (!available) return;
  await server.close();
  await live?.close();
}, 30_000);

const persona = (p: string) => fetch(`${base}/v1/session?persona=${p}`).then((r) => r.json());
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
  const send = (threadId: string, text: string, context: ContextRef[] = []) => {
    conn.subscribe(threadId);
    return api.sendMessage(threadId, { clientMessageId: `cm_${Math.random()}`, input: { kind: 'text', text }, inputChannel: 'text', context });
  };
  const blocks = (id: string) => Object.values(thread(id)?.blocks ?? {}).map((b) => b.envelope);
  const done = (id: string, n: number) => (thread(id)?.turns.filter((t) => t.kind === 'agent' && t.state !== 'running').length ?? 0) >= n;
  return { conn, api, send, blocks, done };
}

describe.skipIf(!available)('member records over HTTP', () => {
  it('searches by number within the purview, masked, with opaque links (BE-RM-002)', async () => {
    await persona('branch');
    const { results } = (await (await fetch(`${base}/v1/search?q=4521&kind=member`)).json()) as { results: { label: string; detail: string; link: string }[] };
    expect(results.length).toBeGreaterThan(1);
    expect(results.every((r) => /^…4521 · Westport/.test(r.detail) && /^\/members\/mbr_[A-Za-z0-9_-]{22}$/.test(r.link))).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(/10004521/);
  });

  it('opens a 360 by token, refuses one outside the purview the same way as a bad token, and audits views', async () => {
    await persona('branch');
    const ok = await fetch(`${base}/v1/members/${SUZANNE}`);
    expect(ok.status).toBe(200);
    const { block } = (await ok.json()) as { block: unknown };
    expect(validateBlock(block).ok).toBe(true);
    const outside = await fetch(`${base}/v1/members/${ROBERT}`);
    const bogus = await fetch(`${base}/v1/members/mbr_AAAAAAAAAAAAAAAAAAAAAA`);
    expect([outside.status, bogus.status]).toEqual([404, 404]);
    expect(await outside.json()).toEqual(await bogus.json());
    // The executive's purview covers Northgate.
    await persona('executive');
    expect((await fetch(`${base}/v1/members/${ROBERT}`)).status).toBe(200);
    // Audit writes do not hold up the response, so wait for both views to land.
    const read = () =>
      readdirSync(join(dataDir, 'audit'))
        .flatMap((f) => readFileSync(join(dataDir, 'audit', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>))
        .filter((e) => e.eventType === 'relationship.profile.viewed');
    await until(() => read().length >= 2);
    const views = read();
    expect(views).toContainEqual(expect.objectContaining({ userId: 'user:5120', partyId: 1, via: 'workspace' }));
    expect(views).toContainEqual(expect.objectContaining({ userId: 'user:9229', partyId: 19, via: 'workspace' }));
    expect(views.some((e) => e.userId === 'user:5120' && e.partyId === 19)).toBe(false);
  });
});

describe.skipIf(!available)('a member conversation', () => {
  it('pulls up the member, answers about them through the chip, and starts a referral already filled in (FE-RM-003, FE-RM-004)', async () => {
    await persona('branch');
    const c = await client();
    const t = 'thr_member_1';
    await c.send(t, 'Pull up Suzanne Jackson at Westport');
    await until(() => c.done(t, 1));
    const card = c.blocks(t).find((b) => b.type === 'member_card')!;
    expect(card.data).toMatchObject({ memberRef: SUZANNE, displayName: 'Suzanne Jackson', selected: true });

    const chip: ContextRef[] = [{ type: 'member', ref: SUZANNE, label: 'Suzanne Jackson' }];
    await c.send(t, 'Why is her attrition risk medium?', chip);
    await until(() => c.done(t, 2));
    expect(c.blocks(t).some((b) => b.type === 'list' && String(b.title).startsWith('Attrition risk: 6 of 10'))).toBe(true);

    await c.send(t, 'Open a Credit card referral for Suzanne Jackson', chip);
    await until(() => c.done(t, 3));
    const ask = c.blocks(t).findLast((b) => b.type === 'notice')!;
    expect(ask.data).toMatchObject({ message: 'How does the member prefer to be contacted?' });
    c.conn.stop();
  });

  it('refuses a chip for a member outside the purview', async () => {
    await persona('branch');
    const c = await client();
    await c.send('thr_member_2', 'Why is his attrition risk high?', [{ type: 'member', ref: ROBERT, label: 'Robert Jackson' }]);
    await until(() => c.done('thr_member_2', 1));
    expect(c.blocks('thr_member_2').find((b) => b.type === 'notice')?.data).toMatchObject({ kind: 'no_access', message: 'That record is outside your access in DI.' });
    expect(JSON.stringify(c.blocks('thr_member_2'))).not.toMatch(/Northgate/);
    c.conn.stop();
  });
});
