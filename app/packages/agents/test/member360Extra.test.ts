// @vitest-environment node
// The rest of DI's Member 360: 90-day use and fees, surveys, the core's comments and warning codes,
// rewards, open work about the person, and identity verification recorded on approval.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { InteractionService, RelationshipService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { INTERACTION_REQUEST, interactionModule, interactionPlan, member360 } from '../src/index.ts';

describe('asking DI to verify someone', () => {
  it('reads the person, channel and answers', () => {
    const q = 'Verify Kevin Banerjee on the phone: born 1985-03-02, card ending 9162';
    expect(INTERACTION_REQUEST.test(q)).toBe(true);
    expect(interactionPlan(q)).toEqual({ tool: 'rm_verify', args: { member: 'Kevin Banerjee', channel: 'Phone', birth_date: '1985-03-02', card_last4: '9162' } });
  });
});

const DB = 'dinext_t_test_cu';
const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM rwd_member LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('the fuller Member 360', () => {
  it('shows usage, survey, notes, rewards and open work, and the block is valid', async () => {
    const pool = tenantPool(DB);
    const [[row]] = (await pool.query(
      "SELECT r.party_id FROM rwd_member r JOIN cdm_survey s ON s.party_id = r.party_id JOIN cdm_account_comment c ON c.party_id = r.party_id AND c.kind = 'Warning' LIMIT 1",
    )) as unknown as [{ party_id: number }[]];
    expect(row, 'a member with rewards, a survey and a warning').toBeTruthy();
    const svc = new RelationshipService(pool, 'test_cu', 'credit_union');
    const p = await svc.profile(row!.party_id, {});
    expect(p.usage).not.toBeNull();
    expect(p.surveys.length).toBeGreaterThan(0);
    expect(p.notes.some((n) => n.kind === 'Warning')).toBe(true);
    expect(p.rewards).toMatchObject({ tier: expect.stringMatching(/Bronze|Silver|Gold/) });
    const block = member360(p, 'run_test');
    expect(blockSchema.safeParse(block).success).toBe(true);
    const kinds = block.data.sections.map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(['workflows', 'notes', 'rewards']));
    expect(block.data.alerts.some((a) => a.tone === 'danger' && /^W\d\d/.test(a.label))).toBe(true);
    const rewards = block.data.sections.find((s) => s.kind === 'rewards');
    expect(rewards).toMatchObject({ status: 'enrolled' });
  });

  it('checks answers against the file without reading it out, and records the result on approval', async () => {
    const pool = tenantPool(DB);
    const admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${DB}`);
    try {
      const [[m]] = (await pool.query(
        "SELECT p.party_id, p.first_name, p.last_name, p.birth_date, b.name AS branch, k.last4 FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id JOIN cdm_card k ON k.party_id = p.party_id AND k.status = 'Active' AND k.closed IS NULL WHERE NOT EXISTS (SELECT 1 FROM cdm_party q WHERE q.first_name = p.first_name AND q.last_name = p.last_name AND q.party_id <> p.party_id) AND NOT EXISTS (SELECT 1 FROM cdm_account_comment c WHERE c.party_id = p.party_id AND c.code = 'W07') LIMIT 1",
      )) as unknown as [{ party_id: number; first_name: string; last_name: string; birth_date: Date | string; branch: string; last4: string }[]];
      const born = String(m!.birth_date instanceof Date ? m!.birth_date.toISOString() : m!.birth_date).slice(0, 10);
      const spec = interactionModule(new InteractionService(pool));
      const verify = spec.tools.find((t) => t.name === 'rm_verify')!;
      const ctx = { user: { id: 'user:6004', name: 'Sofia Ruiz' }, modules: ['interactions'], purviewBranches: [m!.branch], employeeId: 4, runId: 'r', threadId: 't' };
      const name = `${m!.first_name} ${m!.last_name}`;

      const one = (await verify.run({ member: name, channel: 'Phone', birth_date: born } as never, ctx)) as { text?: string };
      expect(one.text).toMatch(/two of these/);

      const good = (await verify.run({ member: name, channel: 'Phone', birth_date: born, card_last4: m!.last4 } as never, ctx)) as { change: { apply: { result: string }; text: string } };
      expect(good.change.apply.result).toBe('Passed');
      expect(good.change.text).not.toContain(born);

      const bad = (await verify.run({ member: name, channel: 'Phone', birth_date: '1901-01-01', card_last4: m!.last4 } as never, ctx)) as { change: { apply: { result: string } } };
      expect(bad.change.apply.result).toBe('Failed');

      await admin.query('DELETE FROM rm_verification WHERE approval_id = ?', ['apr_test_verify_1']);
      await verify.apply!(good.change.apply as never, { approvalId: 'apr_test_verify_1', userId: 'user:6004' } as never, ctx as never);
      await verify.apply!(good.change.apply as never, { approvalId: 'apr_test_verify_1', userId: 'user:6004' } as never, ctx as never);
      const [rows] = (await pool.query('SELECT result, by_name FROM rm_verification WHERE approval_id = ?', ['apr_test_verify_1'])) as unknown as [{ result: string; by_name: string }[]];
      expect(rows).toEqual([{ result: 'Passed', by_name: 'Sofia Ruiz' }]);
      const p = await new RelationshipService(pool, 'test_cu', 'credit_union').profile(m!.party_id, {});
      expect(p.lastVerification).toMatchObject({ result: 'Passed', channel: 'Phone' });
      await admin.query('DELETE FROM rm_verification WHERE approval_id = ?', ['apr_test_verify_1']);
    } finally {
      await admin.end();
    }
  });
});
