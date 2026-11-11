// @vitest-environment node
// Onboarding beyond the touch points: the checklist read from a note, each new member's journey (what the
// scheduled process sent and whether it was opened), and the first 90 days by branch.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { OnboardingService, checklistFrom } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { onboardingModule } from '../src/index.ts';

describe('the onboarding checklist and questions', () => {
  it('reads the checklist from the person’s own words', () => {
    expect(checklistFrom('Card activated, set up e-statements and the mobile app; discussed an auto loan; referred her to lending')).toEqual({ debitCard: true, onlineBanking: false, mobileApp: true, estatements: true, billPay: false, directDeposit: false, perksReviewed: false, loansDiscussed: 'auto loan', referralMade: true });
    expect(checklistFrom('No direct deposit yet')?.directDeposit ?? false).toBe(false);
    expect(checklistFrom('Left a voicemail')).toBeNull();
    const spec = onboardingModule({} as OnboardingService);
    const plan = (q: string) => spec.plan(q, {} as never);
    expect(plan('Show the onboarding funnel')).toEqual({ tool: 'onb_funnel', args: {} });
    expect(plan('Show the onboarding messages for Suzanne Jackson')).toEqual({ tool: 'onb_journey', args: { member: 'Suzanne Jackson' } });
    // Sending stays with the scheduled process.
    expect(plan('Send the welcome email to Suzanne Jackson')).toMatchObject({ say: expect.stringContaining('scheduled process') });
  });
});

const up = await warehouseAvailable('dinext_t_test_cu').then((ok) => ok && tenantPool('dinext_t_test_cu').query('SELECT 1 FROM onb_message LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('the credit union’s new members', () => {
  it('shows a journey, records a checklist with a done touch point, and builds the funnel', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    const admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
    let taskId: number | null = null;
    try {
      const svc = new OnboardingService(pool);
      const [[someone]] = (await pool.query("SELECT p.first_name, p.last_name FROM onb_message m JOIN cdm_party p ON p.party_id = m.party_id JOIN onb_task t ON t.party_id = p.party_id AND t.status = 'Open' GROUP BY p.party_id HAVING COUNT(DISTINCT m.message_id) >= 2 LIMIT 1")) as unknown as [{ first_name: string; last_name: string }[]];
      const name = `${someone!.first_name} ${someone!.last_name}`;
      const j = await svc.journey(name, {});
      expect(j.messages[0]!.step).toBe('Welcome email');
      expect(j.messages.find((m) => m.channel === 'Letter')?.opened ?? null).toBeNull();

      const spec = onboardingModule(svc);
      const ctx = { user: { id: 'user:5120', name: 'Marcus Reed' }, modules: ['onboarding'], runId: 'r', threadId: 't', leads: true };
      const done = spec.tools.find((t) => t.name === 'onb_task_done')!;
      const prepared = (await done.run({ member: name, note: 'Card activated, set up e-statements; discussed a HELOC' } as never, ctx)) as { change: { apply: { taskId: number }; text: string } };
      expect(prepared.change.text).toContain('debit card activated, e-statements, discussed heloc');
      taskId = prepared.change.apply.taskId;
      await done.apply!(prepared.change.apply as never, { approvalId: 'apr_test_onb', userId: 'user:5120' }, ctx);
      const after = await svc.journey(name, {});
      expect(after.touches.some((t) => t.checklist?.loansDiscussed === 'heloc')).toBe(true);

      const f = await svc.funnel({});
      expect(f.branches.length).toBeGreaterThan(0);
      for (const b of f.branches) expect(b.welcomedPct).toBeLessThanOrEqual(100);
      for (const name2 of ['onb_journey', 'onb_funnel']) {
        const out = (await spec.tools.find((t) => t.name === name2)!.run((name2 === 'onb_journey' ? { member: name } : {}) as never, ctx)) as { text: string; blocks: unknown[] };
        for (const b of out.blocks) expect(blockSchema.safeParse(b).success, name2).toBe(true);
      }
    } finally {
      if (taskId) {
        await admin.query("UPDATE onb_task SET status = 'Open', done_on = NULL, note = NULL WHERE task_id = ?", [taskId]);
        await admin.query('DELETE FROM onb_checklist WHERE task_id = ?', [taskId]);
      }
      await Promise.all([pool.end(), admin.end()]);
    }
  });
});
