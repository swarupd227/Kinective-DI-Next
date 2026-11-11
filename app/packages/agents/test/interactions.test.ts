// @vitest-environment node
// Interaction Log and the fuller Member 360: a logged call with a follow-up task linked to the member,
// and the record's cards, recent transactions, credit score, charge-offs and age.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { InteractionService, RelationshipService, generationOf } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { INTERACTION_REQUEST, followUpIn, interactionModule, interactionPlan, member360 } from '../src/index.ts';

const TODAY = new Date('2026-11-11T12:00:00Z');

describe('logging an interaction', () => {
  it('reads the member, channel, summary and follow-up from what the user says', () => {
    const q = 'Log a call with Suzanne Jackson: she asked about a HELOC for a kitchen remodel, follow up on Friday';
    expect(INTERACTION_REQUEST.test(q)).toBe(true);
    expect(interactionPlan(q, TODAY)).toEqual({ tool: 'rm_log', args: { member: 'Suzanne Jackson', channel: 'Phone', kind: 'Sales conversation', summary: 'she asked about a HELOC for a kitchen remodel', follow_up: '2026-11-13' } });
    expect(interactionPlan('I just spoke with Robert Jackson in the branch about updating his address', TODAY).args).toMatchObject({ member: 'Robert Jackson', channel: 'Branch' });
    expect(interactionPlan('Left a voicemail for Suzanne Jackson about her certificate', TODAY).args).toMatchObject({ kind: 'Left message' });
    expect(followUpIn('follow up in 3 days', TODAY)).toBe('2026-11-14');
    expect(followUpIn('call her back Nov 20', TODAY)).toBe('2026-11-20');
    expect(followUpIn('she asked about a HELOC', TODAY)).toBeUndefined();
    expect(INTERACTION_REQUEST.test('Show me Suzanne Jackson')).toBe(false);
    expect(generationOf('1988-04-02')).toBe('Millennial');
  });
});

const up = await warehouseAvailable('dinext_t_test_cu').then((ok) => ok && tenantPool('dinext_t_test_cu').query('SELECT 1 FROM rm_interaction_log LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('the member record and logged interactions', () => {
  it('logs a call with a follow-up task on the member, and the 360 shows it with cards and transactions', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    const admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/dinext_t_test_cu`);
    try {
      const svc = new InteractionService(pool);
      const spec = interactionModule(svc);
      const ctx = { user: { id: 'user:6004', name: 'Sofia Ruiz' }, modules: ['interactions'], purviewBranches: ['Westport'], employeeId: 4, runId: 'r', threadId: 't' };
      const out = (await spec.tools[0]!.run({ member: 'Suzanne Jackson', channel: 'Phone', kind: 'Sales conversation', summary: 'Asked about a HELOC for a kitchen remodel.', follow_up: '2026-11-13' } as never, ctx)) as { change: { apply: Record<string, unknown>; risk: string } };
      expect(out.change).toMatchObject({ risk: 'low', apply: { partyId: 1, followUp: '2026-11-13' } });
      await spec.tools[0]!.apply!(out.change.apply as never, { approvalId: 'apr_test_rmlog_1', userId: 'user:6004' }, ctx);
      // Approving twice writes once.
      await spec.tools[0]!.apply!(out.change.apply as never, { approvalId: 'apr_test_rmlog_1', userId: 'user:6004' }, ctx);
      const [tasks] = await pool.query("SELECT party_id, due FROM tsk_task WHERE approval_id = 'apr_test_rmlog_1.task'");
      expect(tasks).toHaveLength(1);
      expect((tasks as { party_id: number }[])[0]!.party_id).toBe(1);

      const rel = new RelationshipService(pool, 'test_cu', 'credit_union');
      const p = await rel.profile(1, {});
      expect(p.interactions.items[0]).toMatchObject({ kind: 'Sales conversation', by: 'Sofia Ruiz' });
      expect(p.identity.age).toBeGreaterThan(17);
      // Someone with checking: a debit card and recent transactions.
      const [[withCard]] = (await pool.query("SELECT c.party_id FROM cdm_card c JOIN cdm_transaction t ON t.party_id = c.party_id WHERE c.kind = 'Debit' AND c.status = 'Active' LIMIT 1")) as unknown as [{ party_id: number }[]];
      const q = await rel.profile(withCard!.party_id, {});
      expect(q.cards.some((k) => k.kind === 'Debit')).toBe(true);
      expect(q.transactions!.total90d).toBeGreaterThan(0);
      const block = member360(q, 'R-test');
      expect(blockSchema.safeParse(block).success).toBe(true);
      // Outside the purview, no one is found.
      expect(await svc.find('Robert Jackson', { purviewBranches: ['Westport'] })).toEqual([]);
    } finally {
      await admin.query("DELETE FROM tsk_task WHERE approval_id LIKE 'apr_test_rmlog_%'");
      await admin.query("DELETE FROM rm_interaction_log WHERE approval_id LIKE 'apr_test_rmlog_%'");
      await Promise.all([pool.end(), admin.end()]);
    }
  });
});
