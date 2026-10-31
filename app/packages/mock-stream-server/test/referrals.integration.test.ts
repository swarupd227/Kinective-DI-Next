// @vitest-environment node
// The Referrals app end to end: the live Experience server against the seeded warehouse. Sofia works
// her queue, Marcus sees the branch, and the sender hears when a referral closes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppNotification, ReferralDetail, ReferralsIndex } from '@dinext/block-schemas';
import { createPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';

const PORT = 18802;
const base = `http://localhost:${PORT}`;
const available = await warehouseAvailable('dinext_t_test_cu');
let server: { close: () => Promise<void> };
let live: { close: () => Promise<void> } | null = null;
let admin: Pool;
const made: number[] = [];

const persona = (p: string) => fetch(`${base}/v1/session?persona=${p}`).then((r) => r.json());
const box = (b: string) => fetch(`${base}/v1/referrals?box=${b}`).then((r) => r.json() as Promise<ReferralsIndex>);
const act = (id: number, body: unknown) => fetch(`${base}/v1/referrals/${id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A referral of Sofia's that Marcus sent, so the test owns what it changes. */
async function fresh() {
  const [p] = await admin.query('SELECT party_id FROM cdm_party WHERE primary_branch_id = 1 AND party_id > 200 LIMIT 1');
  const [r] = await admin.query("INSERT INTO esp_com_items (definition, type_id, party_id, fields, stage, priority, sender_user_id, sender_name, to_queue_id, assignee_employee_id, routing, created_at) VALUES ('referral', 'certificate', ?, '{}', 'New Referral', 'Normal', 'user:5120', 'Marcus Reed', 'q_service_westport', 4, '{}', NOW(3))", [(p as { party_id: number }[])[0]!.party_id]);
  const id = (r as { insertId: number }).insertId;
  made.push(id);
  return id;
}

beforeAll(async () => {
  if (!available) return;
  delete process.env.DI_ANTHROPIC_API_KEY;
  process.env.DI_DATA_DIR = mkdtempSync(join(tmpdir(), 'dinext-referrals-'));
  const { startMockServer, startLiveRuntime } = await import('../src/index.ts');
  live = await startLiveRuntime();
  server = startMockServer({ port: PORT, speed: 0.02, live: live as never });
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
}, 90_000);
afterAll(async () => {
  if (!available) return;
  if (made.length) {
    await admin.query('DELETE FROM esp_com_lines WHERE com_id IN (?)', [made]);
    await admin.query('DELETE FROM esp_com_items WHERE com_id IN (?)', [made]);
  }
  await server.close();
  await live?.close();
  await admin.end();
}, 30_000);

describe.skipIf(!available)('Referrals app', () => {
  it('starts frontline staff on their own queue and a branch lead on the team', async () => {
    await persona('msr');
    expect((await box('mine')).hasOwnQueue).toBe(true);
    await persona('branch');
    const r = await box('team');
    expect(r.hasOwnQueue).toBe(false);
    expect(r.items.every((i) => i.branch === 'Westport')).toBe(true);
    expect(r.items.every((i) => i.memberRef.startsWith('mbr_'))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('partyId');
  });

  it('applies a person’s own actions at once, records them, and tells the sender when it closes', async () => {
    const id = await fresh();
    await persona('msr');
    expect((await act(id, { kind: 'start' })).status).toBe(200);
    expect((await act(id, { kind: 'note', text: 'Left voicemail' })).status).toBe(200);
    const closed = (await (await act(id, { kind: 'close', stage: 'Sold' })).json()) as ReferralDetail;
    expect(closed.stage).toBe('Sold');
    expect(closed.history.map((h) => h.kind)).toEqual(['stage', 'note', 'stage']);
    const again = await act(id, { kind: 'close', stage: 'Not Interested' });
    expect(again.status).toBe(422);

    // Sofia did it, so she is not told; Marcus sent it, so he is, and only he.
    const seen = async () => ((await (await fetch(`${base}/v1/notifications`)).json()) as { notifications: AppNotification[] }).notifications.filter((n) => n.userId);
    expect(await seen()).toEqual([]);
    await persona('branch');
    expect((await seen()).map((n) => n.title)).toContain(`Referral #${id} is Sold`);
  });

  it('hides a referral outside the purview, and answers the same as one that does not exist', async () => {
    const id = await fresh();
    const [p] = await admin.query('SELECT party_id FROM cdm_party WHERE primary_branch_id = 2 LIMIT 1');
    await admin.query("UPDATE esp_com_items SET sender_user_id = 'user:other', party_id = ? WHERE com_id = ?", [(p as { party_id: number }[])[0]!.party_id, id]);
    await persona('branch');
    expect((await fetch(`${base}/v1/referrals/${id}`)).status).toBe(404);
    expect((await fetch(`${base}/v1/referrals/999999`)).status).toBe(404);
    expect((await act(id, { kind: 'note', text: 'Not mine' })).status).toBe(404);
    await persona('admin');
    expect((await fetch(`${base}/v1/referrals`)).status).toBe(404);
  });
});
