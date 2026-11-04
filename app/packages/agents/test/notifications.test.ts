// @vitest-environment node
// Email notifications: the simulated outbox, preferences changed on a card, and what an email may say,
// against the seeded warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '@dinext/block-schemas';
import { ApprovalStore, EmailOutbox, composeEmail, emailAddress, scrub, tenantDomain } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, notificationsModule, NOTIFICATIONS_REQUEST, runModuleOffline, type ModuleSpec, type RunSink } from '../src/index.ts';

describe('what an email says', () => {
  it('names the person and links to DI, never an account number', () => {
    const { subject, body } = composeEmail({ toName: 'Dana Lee', kind: 'new_work', title: 'New HELOC referral: Suzanne Jackson', detail: 'Account …4521, member 1234567 · Westport lending queue', link: '/workflows/referrals/inbox?id=88213' });
    expect(subject).toBe('DI: New HELOC referral: Suzanne Jackson');
    expect(body).toContain('Hi Dana,');
    expect(body).toContain('Open it in DI: /workflows/referrals/inbox?id=88213');
    expect(body).toContain('Delivery is simulated in this demo');
    expect(body).not.toMatch(/4521|1234567/);
    expect(scrub('SSN 123-45-6789')).toBe('SSN [number removed]');
    expect(emailAddress('Dana Lee', tenantDomain('Harborview Federal Credit Union'))).toBe('dana.lee@harborview.example');
  });

  it('recognises its own requests and leaves referrals alone', () => {
    for (const q of ['What emails did DI send me today?', 'Stop emailing me follow-up reminders', 'Send me a morning digest', 'How many emails went out by kind?', 'Show my email preferences', 'Send an email to Ana Ruiz saying the huddle moved']) expect(NOTIFICATIONS_REQUEST.test(q), q).toBe(true);
    for (const q of ['Refer Suzanne Jackson for a HELOC, she prefers email', 'Make it email instead', 'Send this to me every Monday']) expect(NOTIFICATIONS_REQUEST.test(q), q).toBe(false);
  });
});

const available = await warehouseAvailable('dinext_t_test_cu');
let pool: Pool;
let admin: Pool;
let outbox: EmailOutbox;
let gateway: ModuleGateway;
let spec: ModuleSpec;
const DANA = { id: 'user:ntftest1', name: 'Dana Ntftest', title: 'CEO' };
const SAM = { id: 'user:ntftest2', name: 'Sam Ntftest', title: 'DI Administrator' };
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  if (!available) return;
  pool = tenantPool('dinext_t_test_cu');
  admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
  outbox = new EmailOutbox(pool, 'harborview');
  spec = notificationsModule(outbox, today);
  gateway = new ModuleGateway(new ApprovalStore(pool), [spec]);
});
afterAll(async () => {
  if (!available) return;
  await admin.query("DELETE FROM ntf_email WHERE user_id LIKE 'user:ntftest%'");
  await admin.query("DELETE FROM ntf_pref WHERE user_id LIKE 'user:ntftest%'");
  await admin.query("DELETE FROM ai_approvals WHERE requested_by LIKE 'user:ntftest%'");
  await Promise.all([pool.end(), admin.end()]);
});

function sink() {
  const texts: string[] = [];
  const blocks: Block[] = [];
  const s: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan0000000001', step: () => {}, text: async (md) => void texts.push(md), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { s, texts, blocks };
}
const ask = async (text: string, user = DANA, modules = ['notifications']) => {
  const out = sink();
  const r = await runModuleOffline(spec, { runId: `R-ntftest-${Math.random().toString(36).slice(2, 7)}`, threadId: `thr_ntftest_${Math.random().toString(36).slice(2, 7)}`, text, user, tenant: { name: 'Harborview Federal Credit Union' }, modules }, { gateway }, out.s);
  return { r, out, said: out.texts.join(' ') };
};
const ctx = (user = DANA, modules = ['notifications']) => ({ user, modules, runId: 'R-ntftest-x', threadId: 'thr_ntftest_x' });

describe.skipIf(!available)('the simulated outbox', () => {
  it('writes an email only for kinds that are on, and never the same one twice', async () => {
    const draft = { userId: DANA.id, toName: DANA.name, kind: 'new_work' as const, title: 'New HELOC referral: Suzanne Jackson', link: '/workflows/referrals/inbox?id=1', sourceRef: 'com:1:new' };
    const sent = await outbox.queue(draft);
    expect(sent).toMatchObject({ status: 'sent (simulated)', toAddress: 'dana.ntftest@harborview.example', subject: 'DI: New HELOC referral: Suzanne Jackson' });
    expect(await outbox.queue(draft)).toBeNull();
    // The digest is off until someone asks for it.
    expect(await outbox.queue({ ...draft, kind: 'digest', sourceRef: `digest:${today()}` })).toBeNull();
    expect((await outbox.recent(DANA.id)).length).toBe(1);
    // Nobody else reads it.
    expect(await outbox.recent(SAM.id)).toEqual([]);
  });

  it('lists what DI sent today', async () => {
    const { r, out, said } = await ask('What emails did DI send me today?');
    expect(r.outcome).toBe('answer');
    expect(said).toContain('DI sent you **1 email** today: 1 new work assigned to me.');
    expect(out.blocks.find((b) => b.type === 'table')).toMatchObject({ title: 'Emails today' });
  });
});

describe.skipIf(!available)('email preferences', () => {
  it('turns follow-up reminders off on a low card, once, for the person who asked', async () => {
    const { r } = await ask('Stop emailing me follow-up reminders');
    expect(r.outcome).toBe('approval');
    expect(r.approval!.card.data).toMatchObject({ riskTier: 'low', operation: 'ntf.ntf_pref_set', preview: { kind: 'diff', changes: [{ label: 'Follow-up reminders', before: 'On', after: 'Off' }] } });
    expect(await outbox.isOn(DANA.id, 'follow_up')).toBe(true);
    const approved = await new ApprovalStore(pool).decide(r.approval!.record.approvalId, { decision: 'approved', userId: DANA.id });
    await gateway.execute(approved, ctx());
    expect(await outbox.isOn(DANA.id, 'follow_up')).toBe(false);
    // Applying the same approval again changes nothing more.
    await spec.tools.find((t) => t.name === 'ntf_pref_set')!.apply!({ userId: DANA.id, kind: 'follow_up', on: false } as never, { approvalId: approved.approvalId, userId: DANA.id }, ctx());
    const [rows] = await admin.query('SELECT COUNT(*) AS n FROM ntf_pref WHERE user_id = ?', [DANA.id]);
    expect((rows as { n: number }[])[0]!.n).toBe(1);
    expect(await outbox.queue({ userId: DANA.id, toName: DANA.name, kind: 'follow_up', title: 'Referral #9 is overdue', link: '/x', sourceRef: 'followup:9' })).toBeNull();
    // Asking again says so instead of raising a card.
    const again = await ask('Stop emailing me follow-up reminders');
    expect(again.r.approval).toBeUndefined();
    expect(again.said).toContain('already off');
  });

  it('turns the morning digest on, and shows the preferences', async () => {
    const { r } = await ask('Send me a morning digest');
    expect(r.approval!.card.data).toMatchObject({ riskTier: 'low', summary: 'Start emails: My inbox each morning (digest)' });
    // Someone else can't apply your approval.
    await expect(spec.tools.find((t) => t.name === 'ntf_pref_set')!.apply!({ userId: DANA.id, kind: 'digest', on: true } as never, { approvalId: 'apr_x', userId: SAM.id }, ctx(SAM))).rejects.toMatchObject({ code: 'NO_ACCESS' });
    const prefs = await ask('Show my email preferences');
    expect(prefs.said).toContain('You get **4 of 6** kinds of email');
  });
});

describe.skipIf(!available)('what DI won’t do', () => {
  it('never sends an email to someone else', async () => {
    const { r, said } = await ask('Send an email to Ana Ruiz saying the huddle moved');
    expect(r.approval).toBeUndefined();
    expect(said).toMatch(/I can’t send emails to other people/);
  });

  it('shows delivery counts to administrators only, never bodies', async () => {
    const denied = await ask('How many emails went out by kind?');
    expect(denied.r.outcome).toBe('not_found');
    expect(denied.said).toMatch(/for DI administrators/);
    const { said, out } = await ask('How many emails went out by kind?', SAM, ['notifications', 'admin']);
    expect(said).toMatch(/Counts only/);
    const json = JSON.stringify(out.blocks);
    expect(json).toContain('New work assigned to me');
    expect(json).not.toContain('Suzanne Jackson');
  });
});
