// @vitest-environment node
// The Goal agent: the work against the seeded warehouse, the offline planner end to end, the live
// loop with a scripted model, and the Concierge routing around it. No real model calls are made.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlock, type Block } from '@dinext/block-schemas';
import { ApprovalStore, ReportStore } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { createPool, tenantPool, warehouseAvailable, type Pool } from '@dinext/tenant-db';
import { AuditLog, Concierge, GOAL_REQUEST, newGoalThread, newReportThread, ReportGateway, reviseNote, runGoal, runGoalOffline, type GoalInput, type ModelClient, type RunSink, type StepUpdate, type TenantRuntime } from '../src/index.ts';

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA);

const ALL_APPS = ['home', 'reports', 'rm', 'referrals'];

function recorder(signal = new AbortController().signal) {
  const blocks: Block[] = [];
  const texts: string[] = [];
  const steps: StepUpdate[] = [];
  const plans: { steps: StepUpdate[]; task?: boolean }[] = [];
  const sink: RunSink = {
    signal,
    routing: () => {},
    plan: (_t, _a, s, opts) => {
      plans.push({ steps: s, task: opts?.task });
      return 'blk_plan00000000';
    },
    step: (_id, u) => void steps.push(u),
    text: async (m) => void texts.push(m),
    block: async (b) => void blocks.push(b),
    suggestion: () => {},
  };
  return { sink, blocks, texts, steps, plans };
}

describe('recognising a goal', () => {
  it('tells an outcome from a question', () => {
    expect(GOAL_REQUEST.test('Get me ready for Thursday’s ALCO meeting')).toBe(true);
    expect(GOAL_REQUEST.test('prepare for the board meeting')).toBe(true);
    expect(GOAL_REQUEST.test('Show delinquency by branch')).toBe(false);
    expect(GOAL_REQUEST.test('Open the ALCO monthly pack')).toBe(false);
  });
});

describe('changing the note by talking', () => {
  const note = { recipients: ['ALCO group'], subject: 'ALCO pack', body: 'Team,\n\nFocus on:\n\n- First.\n- Second.\n- Third.\n\nPlease come ready to talk through these.\n\nDana' };
  it('shortens, adds a line and changes who it goes to', () => {
    expect(reviseNote(note, 'make it shorter').body).toBe('Team,\n\nFocus on:\n\n- First.\n\nDana');
    expect(reviseNote(note, 'mention the Westport review on Friday').body).toContain('- The Westport review on Friday.\n\nPlease');
    expect(reviseNote(note, 'send it to the Finance team').recipients).toEqual(['Finance team']);
    expect(reviseNote(note, 'also send to Executive team').recipients).toEqual(['ALCO group', 'Executive team']);
  });
});

describe.skipIf(!up)('goal work against the warehouse', () => {
  let pool: Pool;
  let admin: Pool;
  let semantic: SemanticService;
  let gateway: ReportGateway;
  let approvals: ApprovalStore;
  const user = { id: 'user:goaltest', name: 'Dana Lee', title: 'President and CEO' };
  const input = (text: string, threadId: string, over: Partial<GoalInput> = {}): GoalInput => ({ runId: `R-${threadId}`, threadId, text, user, tenant: { name: 'Harborview', institutionType: 'credit_union' }, apps: ALL_APPS, canViewSql: false, ...over });
  const clean = () => admin.query("DELETE FROM ai_approvals WHERE thread_id LIKE 'thr_goal%'");

  beforeAll(async () => {
    pool = tenantPool(SCHEMA);
    admin = createPool(`${process.env.DI_DB_ADMIN_URL ?? 'mysql://root:dinext_local_root@127.0.0.1:3307'}/${SCHEMA}`);
    semantic = await SemanticService.create(pool, 'test_cu', 'credit_union');
    approvals = new ApprovalStore(pool);
    gateway = new ReportGateway({ store: new ReportStore(pool), semantic, approvals });
    await clean();
  });
  afterAll(async () => {
    await admin.query('DELETE FROM esp_report_shares WHERE user_id = ?', [user.id]);
    await clean();
    await pool.end();
    await admin.end();
  });

  it('plans, reviews, investigates, runs the pack and stops at the note', async () => {
    const r = recorder();
    const state = newGoalThread('Get me ready for Thursday’s ALCO meeting', newReportThread());
    const out = await runGoalOffline(input(state.goal, 'thr_goal1'), { gateway }, state, r.sink);

    expect(r.plans[0]!.task).toBe(true);
    expect(r.plans[0]!.steps.map((s) => s.id)).toEqual(['review', 'why', 'pack', 'note', 'send']);
    // Every block validates, and the work is marked as outputs.
    for (const b of r.blocks) expect(validateBlock(b).ok).toBe(true);
    expect(r.blocks.filter((b) => b.output).map((b) => b.type)).toEqual(expect.arrayContaining(['kpi_group', 'chart', 'report_canvas']));
    expect(r.blocks.find((b) => b.type === 'report_canvas')).toMatchObject({ data: { templateRef: 'alco_monthly_pack' } });

    // It stops for approval, with the note shown in full, and nothing has been recorded as sent.
    expect(out.outcome).toBe('approval');
    expect(state.status).toBe('awaiting_approval');
    const card = out.approval!.card;
    expect(card.data.operation).toBe('report.share');
    expect(card.data.preview).toMatchObject({ kind: 'message', to: ['ALCO group (7)'], subject: 'ALCO pack for Sep 2026' });
    expect(r.steps.at(-1)).toMatchObject({ id: 'send', state: 'needs_input' });
    const [sent] = await pool.query('SELECT COUNT(*) AS n FROM esp_report_shares WHERE user_id = ?', [user.id]);
    expect((sent as { n: number }[])[0]!.n).toBe(0);

    // Sending runs the approved payload once.
    const approval = await approvals.decide(out.approval!.record.approvalId, { decision: 'approved', userId: user.id, payloadHash: out.approval!.record.payloadHash });
    const first = await gateway.execute(approval, { user });
    expect(first).toMatchObject({ operation: 'report.share', recipientCount: 7 });
  });

  it('asks which meeting when it cannot tell, and carries on from the answer', async () => {
    const r = recorder();
    const state = newGoalThread('Get me ready for the meeting', newReportThread());
    const out = await runGoalOffline(input(state.goal, 'thr_goal2'), { gateway }, state, r.sink);
    expect(out.outcome).toBe('clarify');
    expect(r.blocks[0]).toMatchObject({ type: 'notice', data: { kind: 'uncertain' } });

    const next = recorder();
    state.status = 'running';
    const done = await runGoalOffline(input('The ALCO meeting', 'thr_goal2'), { gateway }, state, next.sink);
    expect(done.outcome).toBe('approval');
  });

  it('takes an instruction added while it works', async () => {
    const r = recorder();
    const state = newGoalThread('Get me ready for the ALCO meeting', newReportThread());
    state.steers.push('Keep it to the credit picture.', 'Look at Westport too');
    const out = await runGoalOffline(input(state.goal, 'thr_goal3'), { gateway }, state, r.sink);
    expect(out.outcome).toBe('approval');
    expect(r.steps.some((s) => s.label === 'Look at Westport, as you asked' && s.before === 'pack')).toBe(true);
    expect(out.approval!.card.data.preview).toMatchObject({ body: expect.stringContaining('Keep it to the credit picture.') });
  });

  it('keeps a branch manager to their own purview', async () => {
    const r = recorder();
    const state = newGoalThread('Get me ready for the ALCO meeting', newReportThread());
    await runGoalOffline(input(state.goal, 'thr_goal4', { purviewBranches: ['Westport'] }), { gateway }, state, r.sink);
    const chart = r.blocks.find((b) => b.type === 'chart');
    if (chart?.type === 'chart') expect(chart.data.dataset.source.map((row) => row[0])).toEqual(['Westport']);
    expect(r.blocks.find((b) => b.type === 'kpi_group')?.provenance.purviewApplied).toBe(true);
  });

  it('stops at once when the user stops it', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = recorder(ctrl.signal);
    const state = newGoalThread('Get me ready for the ALCO meeting', newReportThread());
    const out = await runGoalOffline(input(state.goal, 'thr_goal5'), { gateway }, state, r.sink);
    expect(out.outcome).toBe('cancelled');
    expect(r.blocks.some((b) => b.type === 'report_canvas')).toBe(false);
  });

  describe('live loop with a scripted model', () => {
    const scripted = (turns: { text?: string; tools: [string, Record<string, unknown>][] }[]): ModelClient & { seen: unknown[] } => {
      let i = 0;
      const seen: unknown[] = [];
      return {
        seen,
        structured: async () => {
          throw new Error('not used');
        },
        turn: async (req) => {
          seen.push(structuredClone(req.messages.at(-1)));
          const t = turns[i++]!;
          const content = [...(t.text ? [{ type: 'text', text: t.text }] : []), ...t.tools.map(([name, input], n) => ({ type: 'tool_use', id: `tu_${i}_${n}`, name, input }))];
          return { message: { content, stop_reason: 'tool_use' } as never, usage: { model: 'm', role: req.role, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        },
      };
    };

    it('follows the model’s plan, removes figures it did not compute, and stops at approval', async () => {
      const model = scripted([
        { tools: [['set_plan', { steps: ['Review the numbers', 'Run the pack', 'Send the note'] }]] },
        { text: 'First, what moved.', tools: [['review_changes', { step: 1 }]] },
        { text: 'Delinquency hit 9.99% this month.', tools: [['run_report', { step: 2, template_id: 'alco_monthly_pack' }]] },
        { tools: [['request_send', { step: 3, recipients: ['ALCO group'], subject: 'ALCO pack', body: 'Team,\nDelinquency reached 9.99% last month.\nSee the pack.' }]] },
      ]);
      const r = recorder();
      const state = newGoalThread('Get me ready for ALCO', newReportThread());
      const out = await runGoal(input(state.goal, 'thr_goal6'), { model, gateway }, state, r.sink);
      expect(out.outcome).toBe('approval');
      expect(r.plans[0]!.steps.map((s) => s.label)).toEqual(['Review the numbers', 'Run the pack', 'Send the note']);
      expect(r.texts).toContain('First, what moved.');
      expect(r.texts.join(' ')).not.toContain('9.99');
      const preview = out.approval!.card.data.preview as { body: string };
      expect(preview.body).not.toContain('9.99');
      expect(preview.body).toContain('See the pack.');
    });

    it('hands the model an instruction added during the work', async () => {
      const model = scripted([
        { tools: [['set_plan', { steps: ['Review', 'Wrap up'] }]] },
        { tools: [['review_changes', { step: 1 }]] },
        { tools: [['finish', { message: 'Done.' }]] },
      ]);
      const r = recorder();
      const state = newGoalThread('Check the numbers', newReportThread());
      const sink: RunSink = {
        ...r.sink,
        plan: (...args) => {
          state.steers.push('Focus on deposits');
          return r.sink.plan(...args);
        },
      };
      const out = await runGoal(input(state.goal, 'thr_goal7'), { model, gateway }, state, sink);
      expect(out.outcome).toBe('answer');
      expect(JSON.stringify(model.seen)).toContain('The user just added: Focus on deposits');
    });

    it('asks for the plan first', async () => {
      const model = scripted([{ tools: [['review_changes', { step: 1 }]] }, { tools: [['set_plan', { steps: ['One', 'Two'] }]] }, { tools: [['finish', { message: 'Done.' }]] }]);
      const r = recorder();
      const state = newGoalThread('Check', newReportThread());
      await runGoal(input(state.goal, 'thr_goal8'), { model, gateway }, state, r.sink);
      expect(JSON.stringify(model.seen[1])).toContain('Call set_plan first');
    });
  });

  describe('through the Concierge', () => {
    const turn = (text: string, threadId: string) => ({ threadId, runId: `R-${threadId}-${text.length}`, text, context: [], user, tenant: { key: 'test_cu', name: 'Harborview', institutionType: 'credit_union', semantic, reports: { gateway } } as unknown as TenantRuntime, apps: ALL_APPS, canViewSql: false });

    it('routes a goal to the agent, an instruction during the work to the steer queue, and a note edit back to it', async () => {
      const concierge = new Concierge({ model: null, audit: new AuditLog() });
      const r = recorder();
      const first = await concierge.handle(turn('Get me ready for Thursday’s ALCO meeting', 'thr_goal9'), r.sink);
      expect(first).toMatchObject({ kind: 'handled', approval: expect.anything() });

      const edit = recorder();
      const second = await concierge.handle(turn('make it shorter', 'thr_goal9'), edit.sink);
      expect(second).toMatchObject({ kind: 'handled', approval: expect.anything() });
      if (second.kind === 'handled') expect(second.superseded?.length).toBe(1);
      expect(edit.texts.join(' ')).toContain('Changed');
      // The figures from the first run still pass the check, so the note keeps its content.
      if (second.kind === 'handled') {
        const body = (second.approval!.card.data.preview as { body: string }).body;
        expect(body).toMatch(/- .*\d/);
        expect(body).toContain('Sep 2026');
      }
    });
  });
});
