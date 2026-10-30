// @vitest-environment node
// Reports end to end (spec 8.5–8.9, 18): the live Experience server with the offline planner,
// against the seeded warehouse. A report is opened, re-run, exported through an approval and
// downloaded; the download belongs to the user who approved it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiClient, createStreamStore, StreamConnection, type ThreadState } from '@dinext/stream-client';
import { validateBlock } from '@dinext/block-schemas';
import { createPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';

const PORT = 18799;
const base = `http://localhost:${PORT}`;
const available = await warehouseAvailable('dinext_t_test_cu');
let server: { close: () => Promise<void> };
let live: { close: () => Promise<void> } | null = null;
let admin: Pool;

beforeAll(async () => {
  if (!available) return;
  delete process.env.DI_ANTHROPIC_API_KEY;
  process.env.DI_DATA_DIR = mkdtempSync(join(tmpdir(), 'dinext-report-'));
  const { startMockServer, startLiveRuntime } = await import('../src/index.ts');
  live = await startLiveRuntime();
  server = startMockServer({ port: PORT, speed: 0.02, live: live as never });
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
}, 90_000);
afterAll(async () => {
  if (!available) return;
  await admin.query("DELETE FROM esp_report_exports WHERE approval_id IN (SELECT approval_id FROM ai_approvals WHERE thread_id LIKE 'thr_rptint%')");
  await admin.query("DELETE FROM ai_approvals WHERE thread_id LIKE 'thr_rptint%'");
  await server.close();
  await live?.close();
  await admin.end();
}, 30_000);

const persona = (p: string) => fetch(`${base}/v1/session?persona=${p}`).then((r) => r.json());
const until = async (fn: () => boolean, ms = 10_000) => {
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
  const blocks = (id: string) => Object.values(thread(id)?.blocks ?? {}).map((b) => b.envelope);
  const texts = (id: string) => blocks(id).filter((b) => b.type === 'text').map((b) => String(b.data.markdown ?? '')).join('\n');
  const done = (id: string, n: number) => (thread(id)?.turns.filter((t) => t.kind === 'agent' && t.state !== 'running').length ?? 0) >= n;
  const card = (id: string) => {
    const blockId = thread(id)?.pendingApprovals.at(-1);
    return blockId ? (thread(id)!.blocks[blockId]!.envelope.data as { approvalId: string; previewHash: string; idempotencyKey: string }) : null;
  };
  return { conn, api, send, blocks, texts, done, card };
}

describe.skipIf(!available)('reports over HTTP', () => {
  it('lists reports, runs one for new controls, and refuses canvas edits to a standard report', async () => {
    await persona('executive');
    const api = createApiClient({ baseUrl: base });
    const index = await api.reports();
    expect(index.templates.filter((t) => t.status === 'stock').map((t) => t.templateId).sort()).toEqual(['alco_monthly_pack', 'branch_scorecard_monthly', 'executive_summary_quarterly']);
    const block = await api.runReport('branch_scorecard_monthly', { period: '2026-07', node: 'Downtown' });
    expect(validateBlock(block).ok).toBe(true);
    expect(block.data.controls.map((c) => c.value)).toEqual(['2026-07', 'Downtown']);
    const edit = await fetch(`${base}/v1/reports/branch_scorecard_monthly/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: { kind: 'remove', widgetId: 'k1' }, controls: {} }) });
    expect(edit.status).toBe(403);
  });

  it('keeps the branch manager inside Westport whatever branch is asked for (spec 20.7)', async () => {
    await persona('branch');
    const block = await createApiClient({ baseUrl: base }).runReport('branch_scorecard_monthly', { node: 'Northgate' });
    expect(block.data.controls.find((c) => c.id === 'node')!.options.map((o) => o.value)).toEqual(['Westport']);
    expect(JSON.stringify(block)).not.toMatch(/Northgate/);
  });
});

describe.skipIf(!available)('a report conversation', () => {
  it('opens a report, exports it through an approval, and only its approver can download it', async () => {
    await persona('executive');
    const c = await client();
    const t = 'thr_rptint_1';
    await c.send(t, 'Open the August branch scorecard for Riverside');
    await until(() => c.done(t, 1));
    const canvas = c.blocks(t).find((b) => b.type === 'report_canvas')!;
    expect(canvas.data).toMatchObject({ templateRef: 'branch_scorecard_monthly', periodLabel: 'Aug 2026' });

    await c.send(t, 'Export it to CSV');
    await until(() => c.card(t) !== null);
    const card = c.card(t)!;
    expect(await c.api.decide(card.approvalId, { decision: 'approve', channel: 'click', typedConfirmation: null, note: null, editedPlan: null, stepUpToken: null, clientContext: { blockVersionSeen: '1.2.0', previewHash: card.previewHash } }, card.idempotencyKey)).toMatchObject({ ok: true });
    await until(() => /\/v1\/exports\/exp_[A-Za-z0-9]+/.test(c.texts(t)));
    const href = /\/v1\/exports\/exp_[A-Za-z0-9]+/.exec(c.texts(t))![0];
    const file = await fetch(`${base}${href}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="Branch scorecard Aug 2026.csv"');
    const csv = await file.text();
    expect(csv).toContain('Branch scorecard: Aug 2026 · Riverside');
    expect(csv).toContain('Exported by Dana Lee. Limited to their access.');
    expect(csv).toMatch(/Total loans,\d+(\.\d+)?,currency/);
    await persona('analyst');
    expect((await fetch(`${base}${href}`)).status).toBe(404);
    c.conn.stop();
  });
});
