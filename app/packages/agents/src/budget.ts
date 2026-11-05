// The budget agent: next year's targets for the board's headline measures. DI drafts each target from
// this year's actual, plan and peers and says why; the CFO changes any in a sentence; and the budget is
// approved by someone other than its preparer. Every save is an approval and every change is logged.
import { z } from 'zod';
import type { SemanticService } from '@dinext/semantic';
import type { Pool } from '@dinext/tenant-db';
import { CoreError, type BudgetService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';
import { boardScorecard, type ScorecardRow } from './scorecard.ts';

const NO_ACCESS = 'The budget isn’t part of your DI access. It is for finance and executives.';
const THIS_YEAR = 2026;
const NEXT_YEAR = 2027;

/** A modest stretch when a measure already beats its peers: what a board would expect next year. */
const STRETCH: Record<string, number> = { return_on_assets: 0.03, net_interest_margin: 0.05, efficiency_ratio: -0.5, net_worth_ratio: 0.1, loan_growth: 0.5, deposit_growth: 0.5, member_growth: 0.2, delinquency_ratio_60_plus: -0.02, net_charge_off_ratio: -0.02, loan_to_share_ratio: 0 };

/** Which measure a sentence names. */
const MEASURE_WORDS: [RegExp, string][] = [
  [/\broa\b|return on assets/, 'return_on_assets'],
  [/\bnim\b|net interest margin|\bmargin\b/, 'net_interest_margin'],
  [/efficiency/, 'efficiency_ratio'],
  [/net worth|leverage|tier 1|capital/, 'net_worth_ratio'],
  [/loan[- ]to[- ](share|deposit)|\blts\b|\bltd\b/, 'loan_to_share_ratio'],
  [/loan growth|grow(th)? (in )?loans/, 'loan_growth'],
  [/(deposit|share) growth|grow(th)? (in )?(deposits|shares)/, 'deposit_growth'],
  [/(member|customer) growth|grow(th)? (in )?(members|customers)/, 'member_growth'],
  [/charge[- ]?offs?|\bnco\b/, 'net_charge_off_ratio'],
  [/delinquen/, 'delinquency_ratio_60_plus'],
];

export function proposeTarget(r: ScorecardRow): { value: number; why: string } {
  const p = r.places;
  const round = (n: number) => Number(n.toFixed(p));
  const fmt = (n: number | null) => (n === null ? '—' : `${n.toFixed(p)}%`);
  const base = r.actual ?? r.plan ?? 0;
  if (r.good === 'target') return { value: round(r.plan ?? base), why: `Kept at this year’s ${fmt(r.plan)}: it is a range to hold, not a figure to push.` };
  const better = (a: number, b: number) => (r.good === 'up' ? a > b : a < b);
  // Halfway to peers when behind them; otherwise a modest stretch on this year's result.
  if (r.peer !== null && better(r.peer, base)) {
    const v = round(base + (r.peer - base) / 2);
    return { value: v, why: `Halfway from this year’s ${fmt(r.actual)} to the peer median of ${fmt(r.peer)}.` };
  }
  const v = round(base + (STRETCH[r.key] ?? 0));
  return { value: v, why: `This year’s ${fmt(r.actual)} with a modest stretch; already ${r.peer === null ? 'measured' : `level with or better than peers (${fmt(r.peer)})`}.` };
}

export function budgetModule(budget: BudgetService, svc: () => Promise<SemanticService>, pool: Pool, institutionType: 'credit_union' | 'bank'): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('budget')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const card = async () => (await boardScorecard(await svc(), pool, institutionType)).rows;
  const pct = (n: number | null | undefined, places = 2) => (n === null || n === undefined ? '—' : `${n.toFixed(places)}%`);
  const label = (rows: ScorecardRow[], key: string) => rows.find((r) => r.key === key)?.label ?? key;
  const spec: ModuleSpec = {
    id: 'budget',
    prefix: 'budget',
    agent: 'Budget',
    request: /\bbudget\b|\b20\d\d (plan|targets?)\b|\b(plan|targets?) for 20\d\d\b|\bnext year'?s (plan|targets?)\b/i,
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'Budget and plan', ref: 'table:fin_budget' }],
    prompt: ({ tenant, user, title }) => `You are the Budget agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) prepares next year's budget: targets for the board's headline measures. ${THIS_YEAR}'s plan is approved; ${NEXT_YEAR}'s is drafted here.

- "Show the ${NEXT_YEAR} budget", "where is the budget?": budget_view.
- "Draft the ${NEXT_YEAR} budget": budget_draft. DI proposes each target from this year's actual, plan and peers, with the reason; saving it needs approval.
- "Set the ${NEXT_YEAR} loan growth target to 5%": budget_set.
- "Submit the ${NEXT_YEAR} budget for approval": budget_submit. Someone other than the preparer approves it.`,
    plan: (text) => {
      const t = text.toLowerCase();
      if (/\b(submit|approve|send)\b/.test(t)) return { tool: 'budget_submit', args: {} };
      if (/\b(draft|prepare|propose|build|create|start)\b/.test(t)) return { tool: 'budget_draft', args: {} };
      const value = /\b(?:to|at|of)\s+(-?\d+(?:\.\d+)?)\s*%?/.exec(t);
      const metric = MEASURE_WORDS.find(([re]) => re.test(t))?.[1];
      if (/\b(set|change|make|raise|lower|move|update)\b/.test(t) && value && metric) return { tool: 'budget_set', args: { metric, value: Number(value[1]) } };
      if (/\b(set|change|raise|lower|update)\b/.test(t)) return { say: `Which measure, and to what? For example: “Set the ${NEXT_YEAR} loan growth target to 5%”.` };
      return { tool: 'budget_view', args: {} };
    },
    tools: [
      {
        name: 'budget_view',
        description: `The ${NEXT_YEAR} budget beside ${THIS_YEAR}'s plan, actual and peers, with each line's status and the latest changes.`,
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const [rows, next, events] = await Promise.all([card(), budget.lines(NEXT_YEAR), budget.events(NEXT_YEAR)]);
          const status = next.length ? (next.every((l) => l.status === 'Approved') ? 'approved' : 'a draft') : 'not started';
          const table = moduleTable(
            spec,
            `${NEXT_YEAR} budget`,
            ctx.runId,
            'budget.view',
            [{ field: 'measure', headerName: 'Measure', type: 'text' }, { field: 'plan', headerName: `${THIS_YEAR} plan`, type: 'text' }, { field: 'actual', headerName: `${THIS_YEAR} actual`, type: 'text' }, { field: 'peer', headerName: 'Peers', type: 'text' }, { field: 'next', headerName: `${NEXT_YEAR}`, type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }],
            rows.map((r) => {
              const l = next.find((x) => x.metric === r.key);
              return { measure: r.label, plan: pct(r.plan, r.places), actual: pct(r.actual, r.places), peer: pct(r.peer, r.places), next: l ? pct(l.value, r.places) : '—', status: l?.status ?? 'Not drafted' };
            }),
          );
          return {
            text: next.length ? `The ${NEXT_YEAR} budget is **${status}**: ${next.length} targets${events[0] ? `, last ${events[0].action.toLowerCase()} by ${events[0].by}` : ''}. ${THIS_YEAR}’s plan was approved by the board in December 2025.` : `The ${NEXT_YEAR} budget **isn’t started**. I can draft it from this year’s results, plan and peers, and you change anything before it goes for approval.`,
            blocks: [table],
            suggestions: next.length ? (status === 'approved' ? ['How are we doing against plan?'] : [`Submit the ${NEXT_YEAR} budget for approval`, `Set the ${NEXT_YEAR} loan growth target to 5%`]) : [`Draft the ${NEXT_YEAR} budget`],
          };
        },
      },
      {
        name: 'budget_draft',
        description: `Draft the ${NEXT_YEAR} targets from ${THIS_YEAR}'s actual, plan and peers, with the reason for each. Saving it needs approval.`,
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const existing = await budget.lines(NEXT_YEAR);
          if (existing.some((l) => l.status === 'Approved')) throw new CoreError('INVALID', `The ${NEXT_YEAR} budget is already approved.`);
          const rows = (await card()).filter((r) => r.actual !== null || r.plan !== null);
          const lines = rows.map((r) => ({ r, ...proposeTarget(r) }));
          return {
            change: {
              summary: `Save a draft of the ${NEXT_YEAR} budget: ${lines.length} targets`,
              changes: lines.map((l) => ({ label: l.r.label, before: existing.find((x) => x.metric === l.r.key) ? pct(existing.find((x) => x.metric === l.r.key)!.value, l.r.places) : `${THIS_YEAR} plan ${pct(l.r.plan, l.r.places)}`, after: pct(l.value, l.r.places) })),
              text: `Here is a draft of the **${NEXT_YEAR} budget**, from this year’s results, the plan and peers. Where we trail peers the target closes half the gap; where we lead, it is a modest stretch. Change any of it before you send it for approval.\n\n${lines.map((l) => `- **${l.r.label}** ${pct(l.value, l.r.places)}: ${l.why}`).join('\n')}`,
              done: `Saved the ${NEXT_YEAR} budget as a draft. Nothing is approved yet.`,
              risk: 'medium',
              apply: { year: NEXT_YEAR, lines: lines.map((l) => ({ metric: l.r.key, value: l.value, note: l.why })) },
            },
          };
        },
        apply: async (p: { year: number; lines: { metric: string; value: number; note: string }[] }, meta, ctx) => budget.saveDraft(p.year, p.lines, { ...meta, by: ctx.user.name }),
      },
      {
        name: 'budget_set',
        description: `Change one ${NEXT_YEAR} target. Saving it needs approval.`,
        input: z.object({ metric: z.string().min(3).max(60), value: z.number().min(-50).max(200) }).strict(),
        run: async (a: { metric: string; value: number }, ctx) => {
          need(ctx);
          const [rows, next] = await Promise.all([card(), budget.lines(NEXT_YEAR)]);
          const row = rows.find((r) => r.key === a.metric);
          if (!row) throw new CoreError('NOT_FOUND', `The budget has no measure called ${a.metric}.`);
          const line = next.find((l) => l.metric === a.metric);
          if (line?.status === 'Approved') throw new CoreError('INVALID', `The ${NEXT_YEAR} budget is approved; a change needs a new version.`);
          const note = `Set by hand; ${THIS_YEAR} actual ${pct(row.actual, row.places)}, peers ${pct(row.peer, row.places)}.`;
          return {
            change: {
              summary: `Set the ${NEXT_YEAR} ${label(rows, a.metric).toLowerCase()} target to ${pct(a.value, row.places)}`,
              changes: [{ label: row.label, before: line ? pct(line.value, row.places) : 'Not drafted', after: pct(a.value, row.places) }],
              text: `**${row.label}** for ${NEXT_YEAR}: ${line ? pct(line.value, row.places) : 'not drafted'} to **${pct(a.value, row.places)}**. This year it is ${pct(row.actual, row.places)} against a plan of ${pct(row.plan, row.places)}; peers are at ${pct(row.peer, row.places)}.`,
              done: `Changed the ${NEXT_YEAR} ${row.label.toLowerCase()} target to ${pct(a.value, row.places)}. The budget is still a draft.`,
              risk: 'low',
              apply: { metric: a.metric, value: a.value, note },
            },
          };
        },
        apply: async (p: { metric: string; value: number; note: string }, meta, ctx) => budget.setTarget(NEXT_YEAR, p.metric, p.value, p.note, { ...meta, by: ctx.user.name }),
      },
      {
        name: 'budget_submit',
        description: `Send the ${NEXT_YEAR} budget for approval. Someone other than its preparer approves it.`,
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const [rows, next] = await Promise.all([card(), budget.lines(NEXT_YEAR)]);
          if (!next.length) return { text: `There is no ${NEXT_YEAR} budget yet. Draft it first, then send it for approval.`, suggestions: [`Draft the ${NEXT_YEAR} budget`] };
          if (next.every((l) => l.status === 'Approved')) return { text: `The ${NEXT_YEAR} budget is already approved.` };
          return {
            change: {
              summary: `Approve the ${NEXT_YEAR} budget: ${next.length} targets`,
              changes: next.map((l) => {
                const r = rows.find((x) => x.key === l.metric);
                return { label: r?.label ?? l.metric, before: `${THIS_YEAR} plan ${pct(r?.plan, r?.places)}`, after: pct(l.value, r?.places) };
              }),
              text: `The **${NEXT_YEAR} budget** is ready for approval: ${next.length} targets. It needs someone other than you to approve it, such as the CEO or the board’s finance committee.`,
              done: `Approved the ${NEXT_YEAR} budget. The ${NEXT_YEAR} scorecard will measure against it.`,
              risk: 'high',
              secondApprover: { role: institutionType === 'bank' ? 'CEO or the board’s finance committee' : 'CEO or the board’s finance committee', policy: 'The budget is approved by someone other than its preparer.' },
              apply: { year: NEXT_YEAR },
            },
          };
        },
        apply: async (p: { year: number }, meta, ctx) => budget.approve(p.year, { ...meta, by: ctx.user.name }),
      },
    ],
  };
  return spec;
}
