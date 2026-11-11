// @vitest-environment node
// SEG detail: contacts and follow-ups, scheduling a follow-up on approval, and the BD scorecard.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { SegService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { segModule } from '../src/index.ts';

const TODAY = '2026-10-25';

describe('SEG detail questions', () => {
  it('route to the right tool', () => {
    const spec = segModule({} as SegService, () => TODAY);
    const plan = (q: string) => spec.plan(q, {} as never);
    expect(plan('Which SEG follow-ups are due?')).toEqual({ tool: 'seg_follow_ups', args: {} });
    expect(plan('Show the BD scorecard')).toEqual({ tool: 'seg_bd_scorecard', args: {} });
    expect(plan('Schedule a SEG follow-up with Acme HR on November 20: lunch-and-learn dates')).toEqual({ tool: 'seg_follow_up_set', args: { company: 'Acme HR', date: '2026-11-20', note: 'lunch-and-learn dates' } });
    expect(spec.request.test('Show the BD scorecard')).toBe(true);
  });
});

const up = await warehouseAvailable('dinext_t_test_cu').then((ok) => ok && tenantPool('dinext_t_test_cu').query('SELECT 1 FROM seg_contact LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('the credit union’s SEGs', () => {
  it('briefs with the contact and events, lists follow-ups, schedules one, and scores business development', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    const admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
    const [[before]] = (await admin.query("SELECT next_follow_up, follow_up_note FROM seg_contact WHERE company_id = 2")) as unknown as [{ next_follow_up: unknown; follow_up_note: string | null }[]];
    try {
      const svc = new SegService(pool);
      const albany = await svc.company('Albany Medical');
      expect(albany.contact?.bdManager).toBe('Marcus Reed');
      expect(albany.interactions[0]!.at >= albany.interactions[1]!.at).toBe(true);
      const due = await svc.followUps(14, TODAY);
      expect(due.length).toBeGreaterThan(0);
      expect(due.every((f, i) => i === 0 || due[i - 1]!.due <= f.due)).toBe(true);
      const bd = await svc.bdScorecard('2026-10-25');
      expect(bd.people.length).toBeGreaterThan(0);
      expect(bd.goals.map((g) => g.metric)).toContain('new_members');

      const spec = segModule(svc, () => TODAY);
      const ctx = { user: { id: 'user:5120', name: 'Marcus Reed' }, modules: ['seg'], runId: 'r', threadId: 't' };
      for (const name of ['seg_follow_ups', 'seg_bd_scorecard']) {
        const out = (await spec.tools.find((t) => t.name === name)!.run({} as never, ctx)) as { text: string; blocks: unknown[] };
        expect(out.text.length, name).toBeGreaterThan(40);
        for (const b of out.blocks) expect(blockSchema.safeParse(b).success, name).toBe(true);
      }
      const set = spec.tools.find((t) => t.name === 'seg_follow_up_set')!;
      const prepared = (await set.run({ company: 'Acme HR', date: '2026-11-20', note: 'Lunch-and-learn dates' } as never, ctx)) as { change: { apply: unknown; risk: string } };
      expect(prepared.change.risk).toBe('low');
      await set.apply!(prepared.change.apply as never, { approvalId: 'apr_test_seg_fu', userId: 'user:5120' }, ctx);
      expect((await svc.company('Acme HR')).contact?.nextFollowUp).toBe('2026-11-20');
    } finally {
      await admin.query('UPDATE seg_contact SET next_follow_up = ?, follow_up_note = ? WHERE company_id = 2', [before!.next_follow_up, before!.follow_up_note]);
      await Promise.all([pool.end(), admin.end()]);
    }
  });
});
