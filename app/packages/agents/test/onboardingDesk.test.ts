// @vitest-environment node
// The rest of DI's Onboarding Manager: the record list's columns, follow-up rules (create, copy, run),
// adding someone to onboarding, and the Employment, Leisure and Life Events tab on the Member 360.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { OnboardingDeskService, OnboardingService, RelationshipService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { member360, onboardingDeskPlan, onboardingModule, ruleFrom } from '../src/index.ts';

describe('reading onboarding requests', () => {
  it('plans records, rules and adding people', () => {
    expect(onboardingDeskPlan('Show everyone in onboarding with whether they are subscribed')?.tool).toBe('onb_records');
    expect(onboardingDeskPlan('Show the onboarding follow-up rules')?.tool).toBe('onb_rules');
    expect(onboardingDeskPlan('Create a follow-up rule: after day 21 with no direct deposit, call them, high priority')).toEqual({ tool: 'onb_rule_create', args: { name: '', group: 'Standard', condition: 'no_direct_deposit', after_day: 21, touch: '', touch_type: 'Call', priority: 'High' } });
    expect(onboardingDeskPlan('Copy rule #1 for day 45')?.tool).toBe('onb_rule_copy');
    expect(onboardingDeskPlan('Who does rule #2 catch today?')).toEqual({ tool: 'onb_rule_run', args: { rule: '2' } });
    expect(onboardingDeskPlan('Add Suzanne Jackson to onboarding')).toEqual({ tool: 'onb_add', args: { member: 'Suzanne Jackson' } });
    expect(ruleFrom('after 10 days with the debit card not activated, send a secure message').condition).toBe('card_not_activated');
  });
});

const DB = 'dinext_t_test_cu';
const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM onb_rule LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('onboarding records, rules and adding people', () => {
  it('lists records with DI’s columns, runs a rule once per person, and adds someone', async () => {
    const pool = tenantPool(DB);
    const admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${DB}`);
    try {
      const desk = new OnboardingDeskService(pool);
      const spec = onboardingModule(new OnboardingService(pool), desk, null);
      const tool = (n: string) => spec.tools.find((t) => t.name === n)!;
      const ctx = { user: { id: 'user:6000', name: 'Dana Lee' }, modules: ['onboarding'], employeeId: 1, leads: true, runId: 'r', threadId: 't' };

      const rec = await desk.records({});
      expect(rec.total).toBeGreaterThan(50);
      expect(rec.items[0]).toEqual(expect.objectContaining({ touchType: expect.any(String), priority: expect.any(String), subscribed: expect.any(Boolean), accountOpened: expect.any(String) }));
      expect(rec.items.some((i) => i.subscribed === false)).toBe(true);

      const rule = await desk.rule('Direct deposit by day 30');
      const caught = await desk.matches(rule, {});
      expect(caught.length).toBeGreaterThan(0);
      const out = (await tool('onb_rule_run').run({ rule: String(rule.ruleId) } as never, ctx)) as { change: { apply: unknown } };
      await tool('onb_rule_run').apply!(out.change.apply as never, { approvalId: 'a' } as never, ctx as never);
      await tool('onb_rule_run').apply!(out.change.apply as never, { approvalId: 'a' } as never, ctx as never);
      const [[made]] = (await pool.query('SELECT COUNT(*) AS n FROM onb_task WHERE rule_id = ?', [rule.ruleId])) as unknown as [{ n: number }[]];
      expect(Number(made?.n)).toBe(caught.length);
      expect(await desk.matches(rule, {})).toHaveLength(0);

      const create = (await tool('onb_rule_create').run({ name: '', group: 'Test', condition: 'no_estatements', after_day: 20, touch: '', touch_type: 'Email', priority: 'Low' } as never, ctx)) as { change: { apply: unknown } };
      await tool('onb_rule_create').apply!(create.change.apply as never, { approvalId: 'apr_test_onbrule' } as never, ctx as never);
      expect((await desk.rules()).some((r) => r.group === 'Test' && r.condition === 'no_estatements')).toBe(true);

      const [[p]] = (await pool.query('SELECT p.party_id, p.first_name, p.last_name FROM cdm_party p WHERE NOT EXISTS (SELECT 1 FROM onb_task t WHERE t.party_id = p.party_id) AND NOT EXISTS (SELECT 1 FROM cdm_party q WHERE q.first_name = p.first_name AND q.last_name = p.last_name AND q.party_id <> p.party_id) LIMIT 1')) as unknown as [{ party_id: number; first_name: string; last_name: string }[]];
      const add = (await tool('onb_add').run({ member: `${p!.first_name} ${p!.last_name}` } as never, ctx)) as { change: { apply: unknown } };
      await tool('onb_add').apply!(add.change.apply as never, { approvalId: 'b' } as never, ctx as never);
      expect(await desk.inOnboarding(p!.party_id)).toBe(true);
      await admin.query('DELETE FROM onb_task WHERE party_id = ? OR rule_id = ?', [p!.party_id, rule.ruleId]);
      await admin.query("DELETE FROM onb_rule WHERE approval_id = 'apr_test_onbrule'");
    } finally {
      await admin.end();
    }
  });

  it('shows employment, leisure and life events on the Member 360', async () => {
    const pool = tenantPool(DB);
    const [[row]] = (await pool.query('SELECT party_id FROM cdm_party_profile WHERE employer IS NOT NULL LIMIT 1')) as unknown as [{ party_id: number }[]];
    const p = await new RelationshipService(pool, 'test_cu', 'credit_union').profile(row!.party_id, {});
    expect(p.about?.interests.length).toBeGreaterThan(0);
    const block = member360(p, 'r');
    expect(blockSchema.safeParse(block).success).toBe(true);
    expect(block.data.sections.find((s) => s.kind === 'about')).toMatchObject({ employment: expect.arrayContaining([expect.objectContaining({ label: 'Employer' })]) });
  });
});
