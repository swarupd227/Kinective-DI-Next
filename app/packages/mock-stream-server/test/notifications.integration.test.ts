// @vitest-environment node
// Report settings and email notifications through the live Experience server, offline planner, against
// the seeded warehouse: the Settings view, the Email notifications page, an email for a notice, and the
// local stand-in for the morning job.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';

const PORT = 18813;
const base = `http://localhost:${PORT}`;
const available = await warehouseAvailable('dinext_t_test_cu');
let server: { close: () => Promise<void> };
let live: { close: () => Promise<void>; email?: (userId: string, n: never) => Promise<void> } | null = null;
let admin: Pool;
const started = new Date().toISOString().slice(0, 23).replace('T', ' ');

beforeAll(async () => {
  if (!available) return;
  delete process.env.DI_ANTHROPIC_API_KEY;
  process.env.DI_DATA_DIR = mkdtempSync(join(tmpdir(), 'dinext-ntf-'));
  const { startMockServer, startLiveRuntime } = await import('../src/index.ts');
  live = (await startLiveRuntime()) as never;
  server = startMockServer({ port: PORT, speed: 0.02, live: live as never });
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
}, 90_000);
afterAll(async () => {
  if (!available) return;
  // Only what this test wrote: its own notice, and this morning's run.
  await admin.query("DELETE FROM ntf_email WHERE source_ref LIKE 'ntfint:%' OR ((source_ref LIKE 'followup:%' OR source_ref LIKE 'digest:%') AND created_at >= ?)", [started]);
  await server.close();
  await live?.close();
  await admin.end();
}, 30_000);

const persona = (p: string) => fetch(`${base}/v1/session?persona=${p}`).then((r) => r.json());

describe.skipIf(!available)('report settings view', () => {
  it('shows a stock report’s settings read-only, with what DI Next doesn’t use', async () => {
    await persona('analyst');
    const r = await fetch(`${base}/v1/reports/branch_scorecard_monthly/settings`);
    expect(r.status).toBe(200);
    const v = await r.json();
    expect(v).toMatchObject({ name: 'Branch scorecard', status: 'stock', canChange: false });
    expect(v.groups.find((g: { id: string }) => g.id === 'period').fields).toContainEqual({ label: 'Period type', value: 'Monthly', used: true });
    expect((await fetch(`${base}/v1/reports/nope_report/settings`)).status).toBe(404);
    // Without Reports, it isn't there at all.
    await persona('msr');
    expect((await fetch(`${base}/v1/reports/branch_scorecard_monthly/settings`)).status).toBe(404);
  });
});

describe.skipIf(!available)('email notifications', () => {
  it('writes a notice to the outbox and shows it on the person’s page only', async () => {
    await live!.email!('user:5120', { kind: 'new_work', title: 'New HELOC referral: Ntfint Member', detail: 'Account …4521 · Westport lending queue', link: '/workflows/referrals/inbox?id=1', sourceRef: 'ntfint:1' } as never);
    await persona('branch');
    const v = await (await fetch(`${base}/v1/apps/emails`)).json();
    expect(v.title).toBe('Email notifications');
    expect(v.notice).toMatch(/Delivery is simulated/);
    const outbox = v.blocks.find((b: { title: string }) => b.title === 'My outbox, latest 50');
    expect(JSON.stringify(outbox)).toContain('DI: New HELOC referral: Ntfint Member');
    expect(JSON.stringify(outbox)).toContain('marcus.reed@harborview.example');
    // Not an admin: no counts across people.
    expect(v.blocks.some((b: { title: string }) => b.title.startsWith('Delivery by kind'))).toBe(false);
    const [rows] = await admin.query("SELECT body FROM ntf_email WHERE source_ref = 'ntfint:1'");
    expect((rows as { body: string }[])[0]!.body).not.toContain('4521');
    await persona('admin');
    const a = await (await fetch(`${base}/v1/apps/emails`)).json();
    expect(JSON.stringify(a.blocks)).not.toContain('Ntfint Member');
    expect(a.blocks.some((b: { title: string }) => b.title === 'Delivery by kind, everyone')).toBe(true);
  });

  it('runs this morning’s reminders once', async () => {
    await persona('msr');
    const first = await (await fetch(`${base}/v1/emails/morning/run`, { method: 'POST' })).json();
    expect(first.emails).toBeGreaterThanOrEqual(0);
    const again = await (await fetch(`${base}/v1/emails/morning/run`, { method: 'POST' })).json();
    expect(again.emails).toBe(0);
  });
});
