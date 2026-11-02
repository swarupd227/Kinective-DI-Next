// @vitest-environment node
// The business modules on their shared agent: compliance issues, onboarding and data logs, against
// the seeded warehouse. No model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, DataLogService, IssueService, OnboardingService } from '@dinext/di-core';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { ModuleGateway, complianceModule, dataLogsModule, onboardingModule, proposeCategory, runModuleOffline, talkingPoint, type ModuleSpec, type ModuleTurn, type RunSink } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

function recorder() {
  const blocks: Block[] = [];
  const texts: string[] = [];
  const sink: RunSink = { signal: new AbortController().signal, routing: () => {}, plan: () => 'blk_plan00000000', step: () => {}, text: async (m) => void texts.push(m), block: async (b) => void blocks.push(b), suggestion: () => {} };
  return { sink, blocks, texts };
}

describe('small rules', () => {
  it('proposes a category without deciding anything', () => {
    expect(proposeCategory('a double fee on his account')).toBe('Fees');
    expect(proposeCategory('rude staff')).toBe('Service');
  });

  it('suggests what to raise from what’s set up', () => {
    expect(talkingPoint({ touch: '30-day check-in', directDeposit: false })).toContain('Direct deposit');
    expect(talkingPoint({ touch: 'Welcome call', directDeposit: false })).toContain('Welcome');
  });
});

describe.skipIf(!up)('modules against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let approvals: ApprovalStore;
  let gateway: ModuleGateway;
  let compliance: ModuleSpec;
  let onboarding: ModuleSpec;
  let logs: ModuleSpec;
  const turn = (text: string, threadId: string, over: Partial<ModuleTurn> = {}): ModuleTurn => ({ runId: `R-${threadId}`, threadId, text, user: { id: 'user:5120', name: 'Marcus Reed', title: 'Branch Manager' }, tenant: { name: 'Harborview' }, purviewBranches: ['Westport'], employeeId: 6, leads: true, modules: ['compliance', 'onboarding', 'datalogs', 'datalogs-approve'], ...over });
  const ctxOf = (t: ModuleTurn) => ({ user: t.user, purviewBranches: t.purviewBranches, employeeId: t.employeeId, leads: t.leads, modules: t.modules, runId: t.runId, threadId: t.threadId });
  const run = async (spec: ModuleSpec, t: ModuleTurn) => {
    const r = recorder();
    return { r, out: await runModuleOffline(spec, t, { gateway }, r.sink) };
  };
  const approve = async (o: { approval?: { record: { approvalId: string; payloadHash: string } } }, t: ModuleTurn) => gateway.execute(await approvals.decide(o.approval!.record.approvalId, { decision: 'approved', userId: t.user.id, payloadHash: o.approval!.record.payloadHash }), ctxOf(t));

  beforeAll(() => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    approvals = new ApprovalStore(pool);
    compliance = complianceModule(new IssueService(pool), pool);
    onboarding = onboardingModule(new OnboardingService(pool));
    logs = dataLogsModule(new DataLogService(pool));
    gateway = new ModuleGateway(approvals, [compliance, onboarding, logs]);
  });
  afterAll(async () => {
    await admin.query('DELETE FROM cpm_issue_history WHERE issue_id > 3341');
    await admin.query('DELETE FROM cpm_issue WHERE issue_id > 3341');
    await admin.query('DELETE FROM esp_datalog_history WHERE log_id > 4494');
    await admin.query('DELETE FROM esp_datalog WHERE log_id > 4494');
    await pool.end();
    await admin.end();
  });

  describe('compliance', () => {
    it('recognises its work', () => {
      for (const t of ['Which regulatory issues are open more than 3 weeks?', 'Log a complaint from James Lee about a double fee', 'Summarise case 3301', 'Escalate issue 3307 to the compliance officer']) expect(gateway.match(t)?.id, t).toBe('compliance');
      for (const t of ['Show loan growth by branch', 'Show my overdue referrals']) expect(gateway.match(t), t).toBeNull();
    });

    it('lists issues by source and age, within the purview', async () => {
      const { r } = await run(compliance, turn('Which regulatory issues are open more than 1 week?', 'thr_c1'));
      expect(r.texts[0]).toMatch(/issues?\*\*: .* The oldest is \*\*\d+ days/);
      expect(validateBlock(r.blocks[0]!).ok).toBe(true);
      expect(JSON.stringify(r.blocks[0])).not.toContain('Northgate');
    });

    it('labels a case summary as an AI draft and quotes the record', async () => {
      const service = new IssueService(pool);
      const [i] = (await service.list({}, { purviewBranches: ['Westport'] })).items;
      const { r } = await run(compliance, turn(`Summarise case ${i!.issueId}`, 'thr_c2'));
      expect(r.texts[0]).toContain('AI draft – verify before use');
      expect(r.texts[0]).toContain(i!.summary);
    });

    it('reads an issue outside the purview as not found', async () => {
      const service = new IssueService(pool);
      const away = (await service.list({}, {})).items.find((i) => i.branch !== 'Westport')!;
      const { r } = await run(compliance, turn(`Summarise case ${away.issueId}`, 'thr_c3'));
      expect(r.texts[0]).toContain('was not found');
    });

    it('proposes a source and category on a medium card, and logs it once', async () => {
      const [rows] = await pool.query('SELECT first_name, last_name FROM cdm_party WHERE primary_branch_id = 1 AND is_member = 1 GROUP BY first_name, last_name HAVING COUNT(*) = 1 LIMIT 1');
      const p = (rows as { first_name: string; last_name: string }[])[0]!;
      const t = turn(`Log a complaint from ${p.first_name} ${p.last_name} about a double fee`, 'thr_c4');
      const { out } = await run(compliance, t);
      expect(out.approval!.card.data.riskTier).toBe('medium');
      expect(JSON.stringify(out.approval!.card.data.preview)).toContain('Fees');
      await approve(out, t);
      const [n] = await pool.query('SELECT COUNT(*) AS n FROM cpm_issue WHERE approval_id = ?', [out.approval!.record.approvalId]);
      expect((n as { n: number }[])[0]!.n).toBe(1);
    });

    it('makes closing a regulator’s issue high risk with its number typed, and needs a root cause', async () => {
      const service = new IssueService(pool);
      const reg = (await service.list({ kind: 'regulatory' }, { purviewBranches: ['Westport'] })).items.find((i) => ['CFPB', 'NCUA'].includes(i.source))!;
      const missing = await run(compliance, turn(`Close issue ${reg.issueId} with resolution: refund sent`, 'thr_c5'));
      expect(missing.out.approval).toBeUndefined();
      expect(missing.r.texts[0]).toContain('root cause');
      expect(missing.out.asked).toBe(true);
      const { out } = await run(compliance, turn(`Close issue ${reg.issueId} with resolution: refund sent, root cause Process`, 'thr_c6'));
      expect(out.approval!.card.data).toMatchObject({ riskTier: 'high', confirmation: { typedValue: { expected: String(reg.issueId) } } });
      expect(out.approval!.card.data.confirmation.methods).not.toContain('voice');
    });

    it('keeps it from anyone without the access', async () => {
      const { r } = await run(compliance, turn('Show open complaints', 'thr_c7', { modules: [] }));
      expect(r.texts[0]).toContain('aren’t part of your DI access');
    });
  });

  describe('onboarding', () => {
    it('lists a lead’s branch, overdue first, with talking points', async () => {
      const { r } = await run(onboarding, turn('Show my overdue onboarding touch points', 'thr_o1'));
      expect(r.texts[0]).toMatch(/touch points?\*\* (is|are) overdue/);
      expect(validateBlock(r.blocks[0]!).ok).toBe(true);
    });

    it('never sends a member a letter', async () => {
      const { r, out } = await run(onboarding, turn('Send the welcome letter to my new members about onboarding', 'thr_o2'));
      expect(out.approval).toBeUndefined();
      expect(r.texts[0]).toContain('scheduled process');
    });

    it('finds new members without direct deposit', async () => {
      const { r } = await run(onboarding, turn('Which new members haven’t set up direct deposit after 30 days?', 'thr_o3'));
      expect(r.texts[0]).toMatch(/direct deposit/);
    });
  });

  describe('data logs', () => {
    const danaIs = { user: { id: 'user:9229', name: 'Dana Lee', title: 'CEO' }, employeeId: undefined, purviewBranches: undefined };

    it('needs someone other than the creator, and a note to return', async () => {
      const service = new DataLogService(pool);
      const [l] = (await service.list({ status: 'Submitted' }, { purviewBranches: ['Westport'] })).items;
      const self = await run(logs, turn(`Approve log ${l!.logId}`, 'thr_d1', { user: { id: l!.createdBy, name: l!.createdName, title: 'MSR' } }));
      expect(self.r.texts[0]).toContain('someone else');
      const note = await run(logs, turn(`Return log ${l!.logId}`, 'thr_d2'));
      expect(note.out.approval).toBeUndefined();
      expect(note.out.asked).toBe(true);
    });

    it('makes a financial log high risk with its number typed', async () => {
      const service = new DataLogService(pool);
      const l = (await service.list({ status: 'Submitted' }, { purviewBranches: ['Westport'] })).items.find((x) => x.financial)!;
      const { out } = await run(logs, turn(`Approve log ${l.logId}`, 'thr_d3'));
      expect(out.approval!.card.data).toMatchObject({ riskTier: 'high', confirmation: { typedValue: { expected: String(l.logId) } } });
    });

    it('follows the lifecycle from Entered through a return, keeping every step', async () => {
      const t = turn('Log a cash count adjustment of $75 for Westport', 'thr_d4');
      await approve((await run(logs, t)).out, t);
      const service = new DataLogService(pool);
      const made = (await service.list({ status: 'Entered', createdBy: ['user:5120'] }, { purviewBranches: ['Westport'] })).items.at(-1)!;
      const s = turn(`Submit log ${made.logId}`, 'thr_d5');
      await approve((await run(logs, s)).out, s);
      const back = turn(`Return log ${made.logId}: add the recount sheet`, 'thr_d6', danaIs);
      await approve((await run(logs, back)).out, back);
      const asked = await run(logs, turn(`Why was my log ${made.logId} returned?`, 'thr_d7'));
      expect(asked.r.texts[0]).toContain('add the recount sheet');
      const h = await service.get(made.logId, {});
      expect(h.history.map((x) => x.to)).toEqual(['Entered', 'Submitted', 'Returned']);
    });
  });
});
