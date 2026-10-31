// @vitest-environment node
// The Loan Pipeline end to end: the live Experience server against the seeded warehouse, as a lender,
// a branch manager, a totals-only analyst and someone without the module.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppNotification, PipelineApplicationDetail, PipelineIndex, PipelineList } from '@dinext/block-schemas';
import { warehouseAvailable } from '@dinext/tenant-db';

const PORT = 18803;
const base = `http://localhost:${PORT}`;
const available = await warehouseAvailable('dinext_t_test_cu');
let server: { close: () => Promise<void> };
let live: { close: () => Promise<void> } | null = null;

const persona = (p: string) => fetch(`${base}/v1/session?persona=${p}`).then((r) => r.json());
const summary = (view = '') => fetch(`${base}/v1/lap/summary${view ? `?view=${view}` : ''}`);
const list = (q: string) => fetch(`${base}/v1/lap/applications?${q}`);

beforeAll(async () => {
  if (!available) return;
  delete process.env.DI_ANTHROPIC_API_KEY;
  process.env.DI_DATA_DIR = mkdtempSync(join(tmpdir(), 'dinext-lap-'));
  const { startMockServer, startLiveRuntime } = await import('../src/index.ts');
  live = await startLiveRuntime();
  server = startMockServer({ port: PORT, speed: 0.02, live: live as never });
}, 90_000);
afterAll(async () => {
  if (!available) return;
  await server.close();
  await live?.close();
}, 30_000);

describe.skipIf(!available)('Loan Pipeline', () => {
  it('starts a lender on their own applications, and shows them only theirs', async () => {
    await persona('lender');
    const s = (await (await summary()).json()) as PipelineIndex;
    expect(s).toMatchObject({ view: 'mine', views: ['mine', 'location'], details: true, asOf: '2026-10-25', stale: false });
    const mine = (await (await list('view=mine')).json()) as PipelineList;
    expect(mine.items.every((a) => a.owner?.name === 'Ana Ruiz')).toBe(true);
    expect(JSON.stringify(mine)).not.toContain('partyId');
    expect((await summary('institution')).status).toBe(403);
  });

  it('opens an application with its path, and keeps another branch’s from the lender', async () => {
    await persona('lender');
    const mine = (await (await list('view=mine')).json()) as PipelineList;
    const id = mine.items[0]!.applicationId;
    const d = (await (await fetch(`${base}/v1/lap/applications/${id}`)).json()) as PipelineApplicationDetail;
    expect(d.memberRef.startsWith('mbr_')).toBe(true);
    expect(d.history[0]!.status).toBe('Application received');
    await persona('executive');
    const all = (await (await list('view=institution')).json()) as PipelineList;
    const away = all.items.find((a) => a.branch !== 'Westport')!;
    await persona('lender');
    expect((await fetch(`${base}/v1/lap/applications/${away.applicationId}`)).status).toBe(404);
  });

  it('gives a totals-only role counts by product and no applicants', async () => {
    await persona('analyst');
    const s = (await (await summary()).json()) as PipelineIndex;
    expect(s).toMatchObject({ view: 'institution', details: false });
    const f = (await (await list('view=institution&stalled=1')).json()) as PipelineList;
    expect(f.detailsHidden).toBe(true);
    expect(f.items).toEqual([]);
    expect(f.byProduct.length).toBeGreaterThan(0);
    expect((await fetch(`${base}/v1/lap/applications/1`)).status).toBe(403);
  });

  it('refuses someone without the module', async () => {
    await persona('msr');
    expect((await summary()).status).toBe(404);
  });

  it('puts stalled work in the bell, each person’s own', async () => {
    const bell = async () => ((await (await fetch(`${base}/v1/notifications`)).json()) as { notifications: AppNotification[] }).notifications.map((n) => n.title);
    await persona('lender');
    expect((await bell()).some((t) => /of your applications (has|have) stalled/.test(t))).toBe(true);
    await persona('branch');
    expect((await bell()).some((t) => /team applications (has|have) stalled/.test(t))).toBe(true);
    await persona('msr');
    expect((await bell()).some((t) => /stalled/.test(t))).toBe(false);
  });
});
