// Scripted agent runs. Each scenario exercises one part of the protocol and the block library.
import type { ApprovalCardBlock, Block, ContextRef, StreamEvent, StreamingEnvelope } from '@dinext/block-schemas';
import {
  approvalHighFixture,
  approvalMediumFixture,
  chartFixture,
  kpiGroupFixture,
  lineChartFixture,
  nightly,
  planStepsFixture,
  tableFixture,
} from '@dinext/block-schemas/fixtures';

type Emit = Omit<StreamEvent, 'threadId' | 'seq' | 'ts'>;

export interface ScriptContext {
  threadId: string;
  runId: string;
  id: (prefix: string, n?: number) => string;
  emit: (e: Emit) => StreamEvent;
  sendRaw: (e: unknown) => void;
  reserveSeq: () => number;
  stepDone: (stepId: string) => void;
  finish: () => void;
  awaitApproval: (card: ApprovalCardBlock, blockId: string, onResolved: (d: 'approved' | 'denied' | 'returned', ctx: ScriptContext) => void) => void;
}

export interface Step {
  delay: number;
  run: () => void;
}

export type Script = (ctx: ScriptContext) => Step[];

const e = (x: unknown) => x as Emit;

/** Starts a block with empty data, then fills it with patches and ends it (spec 9.8). */
function streamBlock(ctx: ScriptContext, block: Block, delay = 120): Step[] {
  const blockId = ctx.id('blk_', 16);
  const envelope: StreamingEnvelope = { ...block, id: blockId, data: {}, status: 'streaming', provenance: { ...block.provenance, runId: ctx.runId } };
  const ops = Object.entries(block.data).map(([k, value]) => ({ op: 'add' as const, path: `/${k}`, value }));
  return [
    { delay, run: () => ctx.emit(e({ type: 'block.start', runId: ctx.runId, block: envelope })) },
    { delay: 180, run: () => ctx.emit(e({ type: 'block.patch', runId: ctx.runId, blockId, ops })) },
    { delay: 60, run: () => ctx.emit(e({ type: 'block.end', runId: ctx.runId, blockId })) },
  ];
}

/** Streams markdown as token deltas a few words at a time. */
function streamText(ctx: ScriptContext, agent: string, markdown: string, sources: Block['provenance']['sources'] = []): Step[] {
  const blockId = ctx.id('blk_', 16);
  const chunks = markdown.match(/\S+\s*/g) ?? [];
  const steps: Step[] = [
    {
      delay: 150,
      run: () =>
        ctx.emit(
          e({
            type: 'block.start',
            runId: ctx.runId,
            block: { id: blockId, type: 'text', version: '1.0.0', status: 'streaming', provenance: { agent, runId: ctx.runId, sources }, freshness: sources.length ? nightly : { kind: 'none' }, data: { markdown: '' } },
          }),
        ),
    },
  ];
  for (let i = 0; i < chunks.length; i += 3) {
    const text = chunks.slice(i, i + 3).join('');
    steps.push({ delay: 45, run: () => ctx.emit(e({ type: 'token.delta', runId: ctx.runId, blockId, text })) });
  }
  steps.push({ delay: 40, run: () => ctx.emit(e({ type: 'block.end', runId: ctx.runId, blockId })) });
  return steps;
}

function plan(ctx: ScriptContext, title: string, agent: string, steps: { id: string; label: string; agent: string; ms: number; result: string; op: string; riskTier?: 'medium' }[]): { blockId: string; steps: Step[] } {
  const blockId = ctx.id('blk_', 16);
  const out: Step[] = [
    {
      delay: 120,
      run: () =>
        ctx.emit(
          e({
            type: 'block.start',
            runId: ctx.runId,
            block: {
              id: blockId,
              type: 'plan_steps',
              version: '1.0.0',
              title,
              status: 'streaming',
              provenance: { agent, runId: ctx.runId, sources: [] },
              freshness: { kind: 'none' },
              data: {
                runId: ctx.runId,
                cancellable: true,
                state: 'running',
                steps: steps.map((s) => ({ id: s.id, label: s.label, agent: s.agent, state: 'waiting', riskTier: s.riskTier, operations: [{ name: s.op }] })),
              },
            },
          }),
        ),
    },
    { delay: 20, run: () => ctx.emit(e({ type: 'block.end', runId: ctx.runId, blockId })) },
  ];
  for (const s of steps) {
    out.push({ delay: 150, run: () => ctx.emit(e({ type: 'tool.progress', runId: ctx.runId, blockId, step: { id: s.id, state: 'running', operation: s.op } })) });
    out.push({
      delay: s.ms,
      run: () => {
        ctx.emit(e({ type: 'tool.progress', runId: ctx.runId, blockId, step: { id: s.id, state: 'done', resultSummary: s.result } }));
        ctx.stepDone(s.id);
      },
    });
  }
  return { blockId, steps: out };
}

const start = (ctx: ScriptContext, agent: string, reason: string): Step[] => [
  { delay: 80, run: () => ctx.emit(e({ type: 'run.started', runId: ctx.runId, agents: ['DI Concierge'] })) },
  { delay: 260, run: () => ctx.emit(e({ type: 'routing', runId: ctx.runId, agent, reason })) },
];

const complete = (ctx: ScriptContext, suggestion?: string): Step[] => [
  ...(suggestion ? [{ delay: 200, run: () => ctx.emit(e({ type: 'suggestion', runId: ctx.runId, text: suggestion })) }] : []),
  {
    delay: 80,
    run: () => {
      ctx.emit(e({ type: 'run.completed', runId: ctx.runId }));
      ctx.finish();
    },
  },
];

// ---- scenarios -------------------------------------------------------------------------------

const analytics: Script = (ctx) => {
  const p = plan(ctx, 'Answering from governed data', 'Analytics Q&A', [
    { id: 's1', label: 'Matching your question to banking definitions', agent: 'Analytics Q&A', ms: 500, result: 'Loan balance, by branch, Q3 vs Q2 2026', op: 'semantic.catalog.search' },
    { id: 's2', label: 'Running the semantic query on Loan Accounts', agent: 'Analytics Q&A', ms: 900, result: '6 branches, 48,210 loans', op: 'semantic.query' },
  ]);
  return [
    ...start(ctx, 'Analytics Q&A', 'Data question about loan balances'),
    ...p.steps,
    ...streamText(
      ctx,
      'Analytics Q&A',
      'Loan balances grew **2.4%** in Q3, ahead of Q2 (**1.6%**). **Westport** led with **$18.2M** in new balances, mostly indirect auto. **Northgate** was the only branch to shrink (−0.8%) after two large commercial payoffs.',
      [{ kind: 'metric', label: 'Loan balance growth', ref: 'metric:loan_balance_growth' }],
    ),
    ...streamBlock(ctx, chartFixture),
    ...streamBlock(ctx, tableFixture),
    ...complete(ctx, 'Compare the same view for Q3 last year?'),
  ];
};

const briefing: Script = (ctx) => [
  ...start(ctx, 'Dashboard/Briefing', 'Briefing request'),
  ...streamText(ctx, 'Dashboard/Briefing', "Good morning, Dana. Last night's build finished at **04:10**. Here is what changed:", [
    { kind: 'report', label: 'Daily build', ref: 'build:bld_20261026' },
  ]),
  ...streamBlock(ctx, kpiGroupFixture),
  ...streamBlock(ctx, lineChartFixture),
  ...streamText(ctx, 'Dashboard/Briefing', 'Delinquency 60+ crossed the **0.70%** watch level this week. Northgate and Eastgate account for most of the rise.', [
    { kind: 'metric', label: 'Delinquency 60+', ref: 'metric:delinquency_60_plus_rate' },
  ]),
  ...complete(ctx, 'Show the loans behind the Northgate increase?'),
];

const approvalScript =
  (agent: string, intro: string, cardOf: () => ApprovalCardBlock, after: Record<'approved' | 'denied' | 'returned', string>): Script =>
  (ctx) => {
    const card = cardOf();
    const blockId = ctx.id('blk_', 16);
    const withIds: ApprovalCardBlock = { ...card, id: blockId, data: { ...card.data, approvalId: ctx.id('apr_', 14), requestedBy: { ...card.data.requestedBy, runId: ctx.runId } } };
    const p = plan(ctx, 'Preparing the change', agent, [
      { id: 's1', label: 'Reading the records involved', agent, ms: 500, result: 'Found everything needed', op: 'semantic.query' },
      { id: 's2', label: 'Checking routing and policy rules', agent, ms: 600, result: 'Rules found, nothing blocks this', op: 'workflow.definition.simulate_route' },
      { id: 's3', label: 'Drafting the change for your approval', agent, ms: 300, result: 'Ready for review', op: withIds.data.operation, riskTier: 'medium' },
    ]);
    return [
      ...start(ctx, agent, 'Write request'),
      ...p.steps,
      ...streamText(ctx, agent, intro),
      { delay: 150, run: () => ctx.emit(e({ type: 'block.start', runId: ctx.runId, block: { ...withIds, data: {}, status: 'streaming' } })) },
      { delay: 200, run: () => ctx.emit(e({ type: 'block.patch', runId: ctx.runId, blockId, ops: Object.entries(withIds.data).map(([k, value]) => ({ op: 'add', path: `/${k}`, value })) })) },
      { delay: 40, run: () => ctx.emit(e({ type: 'block.end', runId: ctx.runId, blockId })) },
      {
        delay: 20,
        run: () => {
          ctx.emit(e({ type: 'approval.requested', runId: ctx.runId, approvalId: withIds.data.approvalId, blockId, riskTier: withIds.data.riskTier, expiresAt: withIds.data.expiresAt }));
          ctx.awaitApproval(withIds, blockId, (decision, c) => {
            let at = 0;
            for (const s of [...streamText(c, agent, after[decision]), ...complete(c)]) setTimeout(s.run, (at += s.delay));
          });
        },
      },
    ];
  };

const referral = approvalScript(
  'Referral',
  'The referral will go to the **Westport lending queue**, which round-robins to three loan officers. Review it below.',
  approvalMediumFixture,
  {
    approved: 'Referral **#88214** is in the Westport lending queue. Ana Ruiz has it and is due to call Suzanne after 5 pm today.',
    denied: 'Nothing was sent.',
    returned: 'Returned with your note. Nothing was sent.',
  },
);

const payouts = approvalScript(
  'Goals & Incentives',
  'October payouts for Westport are calculated. **14 employees, $9,720.00**, including 3 adjustments. A regional manager must approve after you.',
  approvalHighFixture,
  {
    approved: 'Approved. The payouts now wait for the **Regional Manager** as second approver; they will see the card in their Home approvals.',
    denied: 'Payouts stay in **Calculated**. Nothing was changed.',
    returned: 'Returned to the incentive administrator with your note.',
  },
);

const retention: Script = (ctx) => {
  const blockId = ctx.id('blk_', 16);
  const base = planStepsFixture;
  const steps = base.data.steps.map((s) => ({ ...s, state: 'waiting' as const, startedAt: undefined, endedAt: undefined, resultSummary: undefined }));
  const results = ['Found 1,284 certificates worth $96.4M', 'Scored 1,284 members with attrition_v4', 'Removed 61 delinquent and 12 opted-out members', 'Draft call list ready: 214 members across 6 branches'];
  const out: Step[] = [
    ...start(ctx, 'Deposit/Certificate Retention', 'Retention analysis'),
    {
      delay: 120,
      run: () => ctx.emit(e({ type: 'block.start', runId: ctx.runId, block: { ...base, id: blockId, status: 'streaming', provenance: { ...base.provenance, runId: ctx.runId }, data: { ...base.data, runId: ctx.runId, steps } } })),
    },
    { delay: 20, run: () => ctx.emit(e({ type: 'block.end', runId: ctx.runId, blockId })) },
  ];
  steps.forEach((s, i) => {
    out.push({ delay: 300, run: () => ctx.emit(e({ type: 'tool.progress', runId: ctx.runId, blockId, step: { id: s.id, state: 'running' } })) });
    out.push({
      delay: 2200,
      run: () => {
        ctx.emit(e({ type: 'tool.progress', runId: ctx.runId, blockId, step: { id: s.id, state: 'done', resultSummary: results[i] } }));
        ctx.stepDone(s.id);
      },
    });
  });
  return [...out, ...streamText(ctx, 'Deposit/Certificate Retention', '**214 members** hold certificates worth **$31.8M** that mature in 90 days and score high for attrition. The list is ready for branch managers when you want to send it.'), ...complete(ctx)];
};

const noAccess: Script = (ctx) => [
  ...start(ctx, 'Analytics Q&A', 'Data question'),
  {
    delay: 700,
    run: () => {
      ctx.emit(e({ type: 'run.failed', runId: ctx.runId, error: { code: 'PERMISSION_DENIED', userMessage: 'You do not have access to Northgate loan data.', permission: 'Report Viewer purview: Northgate', referenceId: 'err_4c1d' } }));
      ctx.finish();
    },
  },
];

/** Out-of-order delivery, an unknown block type and an invalid block: the client must stay calm. */
const resilience: Script = (ctx) => {
  const textId = ctx.id('blk_', 16);
  const unknownId = ctx.id('blk_', 16);
  const badId = ctx.id('blk_', 16);
  return [
    ...start(ctx, 'DI Concierge', 'Protocol test'),
    {
      delay: 200,
      run: () => {
        const s1 = ctx.reserveSeq();
        const s2 = ctx.reserveSeq();
        const s3 = ctx.reserveSeq();
        const mk = (seq: number, body: object) => ({ threadId: ctx.threadId, runId: ctx.runId, seq, ts: new Date().toISOString(), ...body });
        // Sent as 3, 1, 2: the client buffers 3 until 1 and 2 arrive.
        ctx.sendRaw(mk(s3, { type: 'block.end', blockId: textId }));
        ctx.sendRaw(mk(s1, { type: 'block.start', block: { id: textId, type: 'text', version: '1.0.0', provenance: { agent: 'DI Concierge', runId: ctx.runId, sources: [] }, freshness: { kind: 'none' }, data: { markdown: '' } } }));
        setTimeout(() => ctx.sendRaw(mk(s2, { type: 'token.delta', blockId: textId, text: 'These events arrived **out of order** and were put back in sequence.' })), 400);
      },
    },
    { delay: 900, run: () => ctx.emit(e({ type: 'block.start', runId: ctx.runId, block: { id: unknownId, type: 'hologram', version: '1.0.0', provenance: { agent: 'DI Concierge', runId: ctx.runId, sources: [] }, freshness: { kind: 'none' }, data: { html: '<script>alert(1)</script>' } } })) },
    { delay: 50, run: () => ctx.emit(e({ type: 'block.end', runId: ctx.runId, blockId: unknownId })) },
    {
      delay: 200,
      run: () =>
        ctx.emit(
          e({ type: 'block.start', runId: ctx.runId, block: { ...chartFixture, id: badId, provenance: { ...chartFixture.provenance, runId: ctx.runId }, data: { ...chartFixture.data, tooltip: { formatter: 'function(p){return p}' } } } }),
        ),
    },
    { delay: 50, run: () => ctx.emit(e({ type: 'block.end', runId: ctx.runId, blockId: badId })) },
    ...complete(ctx),
  ];
};

/** "Explain this" (spec 6.12): the definition, filters, period, build and sources behind a number. */
const explain =
  (subject: string): Script =>
  (ctx) => {
    const p = plan(ctx, 'Explaining the number', 'Data Lineage', [
      { id: 's1', label: 'Reading the metric definition from the semantic layer', agent: 'Analytics Q&A', ms: 400, result: 'Definition v3, effective 1 Jan 2026', op: 'semantic.metric.get' },
      { id: 's2', label: 'Collecting filters, purview and the build used', agent: 'Analytics Q&A', ms: 300, result: 'Build bld_20261026', op: 'semantic.query.explain' },
    ]);
    return [
      ...start(ctx, 'Analytics Q&A', 'Explain request'),
      ...p.steps,
      ...streamText(
        ctx,
        'Analytics Q&A',
        `**How ${subject} is calculated**\n\n` +
          '- **Definition:** sum of the current balance of every open loan account, excluding charged-off loans and participations sold.\n' +
          '- **Formula:** Σ balance where status = open and charge_off = false\n' +
          '- **Filters applied:** Period Q3 2026 · Limited to your purview\n' +
          '- **Data:** nightly build 26 Oct 2026 04:10 (bld_20261026)\n' +
          '- **Owner:** Finance data team · definition version 3\n\n' +
          'Ask "trace this to source" to see the tables and core fields it comes from.',
        [
          { kind: 'metric', label: 'Total loans (definition)', ref: 'metric:total_loan_balance' },
          { kind: 'table', label: 'Loan Accounts', ref: 'table:loan_accounts' },
        ],
      ),
      ...complete(ctx, 'Trace this to source?'),
    ];
  };

/** DI reads the core and never writes to it (FE-EXP-151). */
const notSupported: Script = (ctx) => [
  ...start(ctx, 'DI Concierge', 'Core write request'),
  ...streamBlock(ctx, {
    id: 'blk_placeholder0000',
    type: 'notice',
    version: '1.0.0',
    provenance: { agent: 'DI Concierge', sources: [] },
    freshness: { kind: 'none' },
    data: {
      kind: 'not_supported',
      message: 'DI reads core data and does not write to it.',
      detail: 'Change member records, rates or account details in your core system or through Kinective Digital Connectivity. I can show you the current record or start a referral instead.',
    },
  }),
  ...complete(ctx, 'Show me the current record?'),
];

const help: Script = (ctx) => [
  ...start(ctx, 'DI Concierge', 'Help'),
  ...streamText(
    ctx,
    'DI Concierge',
    'Here is what I can do for you today:\n\n' +
      '- **Answer questions** from governed data: "Show loan growth by branch for Q3 vs Q2"\n' +
      '- **Brief you** on what changed overnight: "Brief me"\n' +
      '- **Prepare work for your approval**: "Refer Suzanne Jackson for a HELOC"\n' +
      '- **Explain any number**: use Explain on a block, or ask "how is total loans calculated?"\n\n' +
      'Press **Ctrl+K** to jump to any report, table or member. Type **/** for shortcuts.',
  ),
  ...complete(ctx),
];

export const SCENARIOS: { match: RegExp; script: Script; sample: string }[] = [
  { match: /^\/?help\b|what can you do/i, script: help, sample: 'What can you do?' },
  { match: /\b(update|change|edit|correct)\b.*\b(address|rate|record|account|core|phone)\b|write (it )?back/i, script: notSupported, sample: "Update Suzanne Jackson's address in the core" },
  { match: /northgate|no access|permission/i, script: noAccess, sample: 'Show Northgate loan detail' },
  { match: /refer/i, script: referral, sample: 'Refer Suzanne Jackson for a HELOC, she prefers a call after 5 pm' },
  { match: /payout|incentive/i, script: payouts, sample: 'Approve October incentive payouts for Westport' },
  { match: /retention|certificate|matur/i, script: retention, sample: 'Find certificates at risk of leaving' },
  { match: /brief|morning|what changed/i, script: briefing, sample: 'Brief me' },
  { match: /chaos|resilien|protocol/i, script: resilience, sample: 'Run the protocol resilience test' },
];

/** Placeholder scripts for agents whose slices have not landed; the live Concierge routes to these. */
const AGENT_SCRIPTS: Record<string, Script> = { referral, goals_incentives: payouts, deposit_retention: retention };
export const scriptForAgent = (agent: string): Script | undefined => AGENT_SCRIPTS[agent];

export function pickScenario(text: string, context: ContextRef[] = []): Script {
  const explained = /^explain\b\s*(.*)$/i.exec(text.trim());
  if (explained) return explain(explained[1]?.replace(/^["“]|["”]$/g, '') || context.find((c) => c.type === 'block')?.label || 'this number');
  return SCENARIOS.find((s) => s.match.test(text))?.script ?? analytics;
}
