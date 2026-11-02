// Data Lineage (spec 24.10) and AI usage and governance (8.21) on the shared agent. Both are read
// only, and every figure and graph is written by code. The model chooses the tool and nothing else.
import { z } from 'zod';
import type { LineageGraphBlock } from '@dinext/block-schemas';
import { CoreError, type GovernanceService, type LineageService, type UsageGroup } from '@dinext/di-core';
import { newBlockId } from './answer.ts';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/’/g, "'");
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// ---- lineage ----------------------------------------------------------------------------------

export function lineageModule(lineage: LineageService): ModuleSpec {
  const noAccess = 'Data lineage isn’t part of your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('lineage')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const spec: ModuleSpec = {
    id: 'lineage',
    prefix: 'lin',
    agent: 'Data Lineage',
    request: /\bwhere does\b.*\bcome from\b|\blineage\b|\btrace\b.*\bsources?\b|\bwhat breaks if\b|\bwhat depends on\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Lineage catalog', ref: 'table:meta_lineage' }],
    prompt: ({ tenant, user, title }) => `You are the Data Lineage agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) wants to know where data comes from.

- "Where does 60+ delinquency come from?", "Trace total loan balance to its source": lin_trace with the measure in their words.
- "What breaks if we change cdm_loan.days_delinquent?": lin_impact.
- The graph comes from lineage metadata. Never work out lineage from table or column names. Connection secrets are never shown.`,
    plan: (text) => {
      const t = clean(text);
      if (/\bwhat breaks if\b|\bwhat depends on\b/i.test(t)) {
        const target = /\b([a-z]+_[a-z_]+(?:\.[a-z_0-9]+)?)\b/.exec(t)?.[1];
        return target ? { tool: 'lin_impact', args: { target } } : { say: 'Which table or column do you mean?' };
      }
      return { tool: 'lin_trace', args: { measure: t } };
    },
    tools: [
      {
        name: 'lin_trace',
        description: 'Trace a measure back to its tables, columns, load jobs, files and source system, with the last load and data quality result for each step.',
        input: z.object({ measure: z.string().min(2).max(200) }).strict(),
        run: async (a: { measure: string }, ctx) => {
          need(ctx);
          const metric = lineage.find(a.measure);
          const g = await lineage.trace(metric.name);
          const failed = g.checks.filter((c) => !c.passed);
          const graph: LineageGraphBlock = {
            id: newBlockId('lin'),
            type: 'lineage_graph',
            version: '1.0.0',
            title: `Where ${metric.label} comes from`,
            provenance: { agent: spec.agent, runId: ctx.runId, operations: ['catalog.lineage.get'], sources: spec.sources },
            freshness: { kind: 'nightly_build', asOf: `${g.asOf}T00:00:00Z` },
            a11y: { summary: `${metric.label} reads ${plural(g.lanes.length, 'table')}. ${g.lanes.map((l) => l.nodes.map((n) => n.label).join(', then ')).join('. ')}.`.slice(0, 600) },
            data: { metric: metric.label, definition: metric.description, lanes: g.lanes },
          };
          const gap = g.unknown.length ? ` I have no lineage recorded for ${g.unknown.join(', ')}, so that step shows as an unknown source.` : '';
          const dq = !g.checks.length ? 'No data quality checks cover these steps.' : failed.length ? `**${failed.length} of ${g.checks.length} data quality checks failed** on these steps: ${failed.map((c) => `${c.name} (${c.rowsFailed.toLocaleString('en-US')} rows)`).join(', ')}.` : `All ${g.checks.length} data quality checks passed.`;
          return { text: `**${metric.label}**: ${metric.description} It reads ${plural(g.lanes.length, 'table')}. ${dq}${gap}`, blocks: [graph, ...(g.checks.length ? [moduleTable(spec, 'Data quality checks', ctx.runId, 'dq.status_report', [{ field: 'domain', headerName: 'Domain', type: 'text' }, { field: 'dimension', headerName: 'Dimension', type: 'text' }, { field: 'name', headerName: 'Check', type: 'text' }, { field: 'result', headerName: 'Result', type: 'text' }], g.checks.map((c) => ({ domain: c.domain, dimension: c.dimension, name: c.name, result: c.passed ? 'Passed' : `Failed, ${c.rowsFailed} rows` })), g.asOf)] : [])], suggestions: failed.length ? ['Which checks failed?'] : [] };
        },
      },
      {
        name: 'lin_impact',
        description: 'What depends on a table or column: the measures that read it and the reports that use them.',
        input: z.object({ target: z.string().min(3).max(80).describe('A table, or table.column, such as cdm_loan.days_delinquent') }).strict(),
        run: async (a: { target: string }, ctx) => {
          need(ctx);
          const r = await lineage.impact(a.target);
          return { text: `Changing **${a.target}** would affect **${plural(r.metrics.length, 'measure')}** and **${plural(r.reports.length, 'report')}**.`, blocks: [moduleTable(spec, `What depends on ${a.target}`, ctx.runId, 'catalog.lineage.impact', [{ field: 'kind', headerName: 'Kind', type: 'text' }, { field: 'name', headerName: 'Name', type: 'text' }], [...r.metrics.map((m) => ({ kind: 'Measure', name: m.label })), ...r.reports.map((name) => ({ kind: 'Report', name }))])] };
        },
      },
    ],
  };
  return spec;
}

// ---- AI usage and governance --------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthLabel = (m: string) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-15T00:00:00Z`));
const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n < 0.01 ? 4 : 2 }).format(n);
const monthIn = (t: string) => {
  const i = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`, 'i').test(t));
  return i < 0 ? undefined : MONTHS[i];
};
const GROUP_LABEL: Record<UsageGroup, string> = { user: 'Person', class: 'Class', agent: 'Agent', model: 'Model' };

export function governanceModule(gov: GovernanceService, year: () => number): ModuleSpec {
  const noAccess = 'AI usage reports need the AI usage permission. You can ask about your own usage.';
  const admin = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('ai-admin')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const resolve = async (month: string | undefined, userId?: string) => {
    if (month) {
      const i = MONTHS.indexOf(month.toLowerCase());
      if (i < 0) throw new CoreError('INVALID', 'Which month?');
      return `${year()}-${String(i + 1).padStart(2, '0')}`;
    }
    const m = await gov.latestMonth(userId);
    if (!m) throw new CoreError('NOT_FOUND', 'There’s no AI usage recorded yet.');
    return m;
  };
  const spec: ModuleSpec = {
    id: 'governance',
    prefix: 'gov',
    agent: 'AI Governance',
    request: /\bAI (cost|usage|spend)\b|\btokens?\b|\b(run )?trace (for|of) (run )?R-|\bR-\d{8}-\w+\b|\bhigh[- ]risk approvals?\b|\bapprovals? (made )?through agents\b|\bhow much have I used\b|\bmy (AI )?usage\b|\b(answer|negative|user) feedback\b|\bthumbs[- ]down\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'AI usage ledger', ref: 'table:ai_run' }],
    prompt: ({ tenant, user, title }) => `You are the AI Governance agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) is asking what the AI has done.

- "Show AI cost by agent for October", "Who used the most tokens last month?": gov_usage.
- "How much have I used this month?": gov_my_usage.
- "Open the trace for run R-20261026-0042": gov_trace.
- "Show every high-risk approval made through agents this month": gov_approvals.
- "Show the negative feedback": gov_feedback.
- Everything here is read only.`,
    plan: (text) => {
      const t = clean(text);
      const month = monthIn(t);
      const when = month ? { month } : {};
      const run = /\bR-\d{8}-\w+\b/.exec(t)?.[0];
      if (run) return { tool: 'gov_trace', args: { run_id: run } };
      if (/\bapprovals?\b/i.test(t)) return { tool: 'gov_approvals', args: { ...when, ...(/\bhigh[- ]risk\b/i.test(t) ? { risk: 'high' } : {}) } };
      if (/\bfeedback\b|\bthumbs\b/i.test(t)) return { tool: 'gov_feedback', args: {} };
      if (/\bhow much have I\b|\bmy\b/i.test(t) && !/\bmy team\b/i.test(t)) return { tool: 'gov_my_usage', args: when };
      const by = /\bby class\b/i.test(t) ? 'class' : /\bby model\b/i.test(t) ? 'model' : /\bby (agent)\b/i.test(t) ? 'agent' : /\bby (user|person)\b|\bwho\b/i.test(t) ? 'user' : 'agent';
      return { tool: 'gov_usage', args: { group_by: by, ...when } };
    },
    tools: [
      {
        name: 'gov_usage',
        description: 'Tokens, cost, prompts, tool calls and approvals for a month, by person, class, agent or model. Needs the AI usage permission.',
        input: z.object({ group_by: z.enum(['user', 'class', 'agent', 'model']).default('agent'), month: z.string().max(12).optional().describe('A month name. Leave out for the latest month.') }).strict(),
        run: async (a: { group_by: UsageGroup; month?: string }, ctx) => {
          admin(ctx);
          const month = await resolve(a.month);
          const u = await gov.usage(month, a.group_by);
          if (!u.items.length) return { text: `There’s no AI usage recorded for ${monthLabel(month)}.` };
          const top = u.items[0]!;
          return { text: `In ${monthLabel(month)}, DI ran **${plural(u.totals.prompts, 'prompt')}** for **${usd(u.totals.cost)}**, using ${u.totals.tokens.toLocaleString('en-US')} tokens. **${top.name}** cost the most, at ${usd(top.cost)}. Tokens and cost cover the model only; voice isn’t included yet.`, blocks: [moduleTable(spec, `AI usage by ${GROUP_LABEL[a.group_by].toLowerCase()}, ${monthLabel(month)}`, ctx.runId, 'ai.usage.report', [{ field: 'name', headerName: GROUP_LABEL[a.group_by], type: 'text' }, { field: 'prompts', headerName: 'Prompts', type: 'count' }, { field: 'tokens', headerName: 'Tokens', type: 'count' }, { field: 'tools', headerName: 'Tool calls', type: 'count' }, { field: 'approvals', headerName: 'Approvals', type: 'count' }, { field: 'cost', headerName: 'Cost', type: 'text' }], u.items.map((i) => ({ name: i.name, prompts: i.prompts, tokens: i.tokens, tools: i.tools, approvals: i.approvals, cost: usd(i.cost) })))] };
        },
      },
      {
        name: 'gov_my_usage',
        description: 'The person’s own AI usage for a month. Anyone can ask.',
        input: z.object({ month: z.string().max(12).optional() }).strict(),
        run: async (a: { month?: string }, ctx) => {
          const month = await resolve(a.month, ctx.user.id);
          const u = await gov.own(ctx.user.id, month);
          return { text: u.prompts ? `In ${monthLabel(month)} you ran **${plural(u.prompts, 'prompt')}**, using ${u.tokens.toLocaleString('en-US')} tokens, for about ${usd(u.cost)}.` : `You have no AI usage recorded for ${monthLabel(month)}.` };
        },
      },
      {
        name: 'gov_trace',
        description: 'Every step of one run: prompt, tool calls with parameters, approvals with approver and channel, and cost. Your own runs, or any with the AI usage permission.',
        input: z.object({ run_id: z.string().regex(/^R-\d{8}-\w+$/).max(40) }).strict(),
        run: async (a: { run_id: string }, ctx) => {
          const t = await gov.trace(a.run_id, { userId: ctx.user.id, all: ctx.modules.includes('ai-admin') });
          const steps = [...t.tools.map((c) => ({ step: 'Tool call', operation: c.name, detail: JSON.stringify(c.input ?? {}).slice(0, 160), ms: c.ms ? `${c.ms} ms` : '—', result: c.ok ? 'OK' : `Failed${c.error ? `, ${c.error}` : ''}` })), ...t.approvals.map((p) => ({ step: 'Approval', operation: p.operation, detail: `${p.risk} risk`, ms: '—', result: `${p.status}, ${p.by} by ${p.channel}` }))];
          return { text: `Run **${t.runId}**, ${t.at}: **${t.user}** asked “${t.question}”. ${t.agent} handled it${t.model ? ` on ${t.model}` : ''}, using ${(t.inputTokens + t.outputTokens).toLocaleString('en-US')} tokens for ${usd(t.cost)}. The outcome was ${t.outcome.replaceAll('_', ' ')}.`, blocks: steps.length ? [moduleTable(spec, `Trace of ${t.runId}`, ctx.runId, 'ai.trace.get', [{ field: 'step', headerName: 'Step', type: 'text' }, { field: 'operation', headerName: 'Operation', type: 'text' }, { field: 'detail', headerName: 'Parameters', type: 'text' }, { field: 'ms', headerName: 'Duration', type: 'text' }, { field: 'result', headerName: 'Result', type: 'text' }], steps)] : [] };
        },
      },
      {
        name: 'gov_approvals',
        description: 'Decisions on agent changes in a month, with approver, channel and run. Needs the AI usage permission.',
        input: z.object({ risk: z.enum(['low', 'medium', 'high']).optional(), month: z.string().max(12).optional() }).strict(),
        run: async (a: { risk?: string; month?: string }, ctx) => {
          admin(ctx);
          const month = a.month ? await resolve(a.month) : new Date().toISOString().slice(0, 7);
          let list = await gov.approvals(month, a.risk);
          let shown = month;
          // Nothing yet this month: the last month with a decision is what the question is after.
          if (!list.length && !a.month) {
            const latest = await resolve(undefined);
            list = await gov.approvals(latest, a.risk);
            shown = latest;
          }
          const what = a.risk ? `${a.risk}-risk ` : '';
          if (!list.length) return { text: `No ${what}approvals were decided in ${monthLabel(shown)}.` };
          return { text: `**${plural(list.length, `${what}approval`)}** decided in ${monthLabel(shown)}.`, blocks: [moduleTable(spec, 'Approvals through agents', ctx.runId, 'audit.approvals.list', [{ field: 'summary', headerName: 'Change', type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }, { field: 'by', headerName: 'Decided by', type: 'text' }, { field: 'channel', headerName: 'Channel', type: 'text' }, { field: 'at', headerName: 'When', type: 'text' }, { field: 'runId', headerName: 'Run', type: 'text' }], list)], suggestions: [`Open the trace for run ${list[0]!.runId}`] };
        },
      },
      {
        name: 'gov_feedback',
        description: 'The review queue of ratings on DI’s answers, thumbs down first. Needs the AI usage permission.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          admin(ctx);
          const list = await gov.feedbackQueue();
          if (!list.length) return { text: 'Nobody has rated an answer yet.' };
          const down = list.filter((f) => f.rating === 'down').length;
          return { text: `**${plural(list.length, 'rating')}** on DI’s answers, ${down} thumbs down.`, blocks: [moduleTable(spec, 'Answer feedback', ctx.runId, 'ai.feedback.list', [{ field: 'rating', headerName: 'Rating', type: 'text' }, { field: 'question', headerName: 'Question', type: 'text' }, { field: 'comment', headerName: 'Comment', type: 'text' }, { field: 'agent', headerName: 'Agent', type: 'text' }, { field: 'by', headerName: 'From', type: 'text' }, { field: 'runId', headerName: 'Run', type: 'text' }], list.map((f) => ({ rating: f.rating === 'down' ? 'Thumbs down' : 'Thumbs up', question: f.question, comment: f.comment, agent: f.agent, by: f.by, runId: f.runId })))] };
        },
      },
    ],
  };
  return spec;
}
