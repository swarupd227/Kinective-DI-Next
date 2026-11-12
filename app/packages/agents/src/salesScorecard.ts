// Sales Scorecards: DI's Monthly Loan Score Card (production by channel against the year's minimum and
// stretch), sales contests and their standings, and the incentive scorecards rolled up by region.
// Each person's own scorecard and payouts stay with the Goals & Incentives agent.
import { z } from 'zod';
import { CoreError, GoalsService, SalesScorecardService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const SALES_SCORECARD_REQUEST =
  /\bloan score ?card\b|\b(?:loan|lending) (?:goals?|production) by channel\b|\bby channel\b[^.?!]*\b(?:goals?|minimum|stretch)\b|\bstretch goals?\b|\b(?:minimum|stretch) (?:goals?|targets?)\b|\b(?:sales )?contests?\b|\bsales (?:drive|competition|push)\b|\b(?:summer|fall|spring|winter) (?:drive|push)\b|\bleaderboard\b|\bregional score ?cards?\b|\bscore ?cards? by region\b|\bby region\b[^.?!]*\b(?:goals?|score ?cards?|incentives?)\b|\bwhich region\b|\bwho opened (?:the )?most\b|\baccounts? opened by\b|\bopened by (?:employee|staff|whom|who)\b|\b(?:originated|originating) (?:at|branch)\b/i;

const NO_ACCESS = 'Sales scorecards aren’t part of your DI access.';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const mm = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000).toLocaleString('en-US')}K`);
const monthName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function salesScorecardPlan(t: string) {
  if (/\bwho opened\b|\bopened by\b|\boriginat/i.test(t)) return { tool: 'sales_opened_by', args: {} };
  if (/\bcontests?\b|\bdrive\b|\bpush\b|\bcompetition\b|\bleaderboard\b/i.test(t)) return { tool: 'sales_contests', args: {} };
  if (/\bregion/i.test(t)) return { tool: 'sales_regions', args: {} };
  return { tool: 'sales_loan_scorecard', args: {} };
}

export function salesScorecardModule(svc: SalesScorecardService, goals: GoalsService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('salescard')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const sources: ModuleSpec['sources'] = [{ kind: 'table', label: 'Loans booked, from the core', ref: 'table:cdm_loan' }, { kind: 'table', label: 'Loan goals by channel', ref: 'table:fin_loan_goal' }, { kind: 'table', label: 'Goals & Incentives', ref: 'table:gi_scorecard' }];
  const spec: ModuleSpec = {
    id: 'salescard',
    prefix: 'sales',
    agent: 'Sales Scorecards',
    request: SALES_SCORECARD_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the Sales Scorecards agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) tracks sales against goals.

- sales_loan_scorecard (month): loan production by channel against the year's minimum and stretch, month to date and year to date. Leave month out for the latest month; don't ask which month. The score card is by channel, not by lender: say so in a line when asked by lender and show it by channel.
- sales_contests: sales contests, running and ended, with standings.
- sales_regions: the incentive scorecards rolled up by region.
- sales_opened_by (from, to; default this month to date): accounts opened by each employee, loans and deposits, the channel (branch, online, dealer) and how many were originated at a branch other than the one that services them.`,
    plan: (t) => salesScorecardPlan(t),
    tools: [
      {
        name: 'sales_opened_by',
        description: 'Accounts opened in a period by who opened them: each employee’s loans and deposits opened (count and dollars), accounts opened online or through dealers, and how many were originated at a branch other than the servicing one. Default this month to date.',
        input: z.object({ from: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional(), to: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional() }).strict(),
        run: async (a: { from?: string; to?: string }, ctx) => {
          need(ctx);
          const x = await svc.openedBy(ctx, a.from, a.to);
          if (!x) return { text: 'Who opened each account isn’t loaded for this institution yet.' };
          if (!x.total) return { text: `No accounts were opened from ${a.from ?? 'the start of the month'} to ${a.to ?? 'now'}.` };
          const top = x.people.find((p) => p.role !== '—');
          const ch = x.channels.map((c) => `${c.name.toLowerCase()} ${c.accounts}`).join(', ');
          return {
            text: `From ${x.from} to ${x.to}, **${x.total.toLocaleString('en-US')} accounts** were opened (${ch}).${top ? ` **${top.name}** (${top.role}, ${top.branch}) opened the most: ${top.loans} loans and ${top.deposits} deposit accounts.` : ''}`,
            blocks: [moduleTable(spec, 'Accounts opened, by who opened them', ctx.runId, 'sales.opened_by', [text('name', 'Opened by'), text('role', 'Role'), text('branch', 'Branch'), { field: 'loans', headerName: 'Loans', type: 'count' }, { field: 'loanDollars', headerName: 'Loan dollars', type: 'currency' }, { field: 'deposits', headerName: 'Deposit accounts', type: 'count' }, { field: 'depositDollars', headerName: 'Deposit balances', type: 'currency' }, { field: 'elsewhere', headerName: 'Originated at another branch', type: 'count' }], x.people.slice(0, 100))],
          };
        },
      },
      {
        name: 'sales_loan_scorecard',
        description: 'The Monthly Loan Score Card: loan production by channel for a month and the year to date, against the year’s minimum and stretch goals (prorated to the month), with percent to each.',
        input: z.object({ month: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional() }).strict(),
        run: async (a: { month?: string }, ctx) => {
          need(ctx);
          const x = await svc.loanScorecard(a.month, ctx);
          const behind = x.rows.filter((r) => r.pctToMin < 100).sort((p, q) => p.pctToMin - q.pctToMin);
          const ahead = x.rows.filter((r) => r.pctToStretch >= 100);
          const t = x.total;
          return {
            text: `Through ${monthName(x.month)}, loans booked are **${mm(t.ytd)}** against a year-to-date minimum of ${mm(t.minYtd)} (**${t.pctToMin}%**) and stretch of ${mm(t.stretchYtd)} (${t.pctToStretch}%)${x.scoped ? ', for your branches’ share of the goals' : ''}. ${behind.length ? `Behind the minimum: ${behind.map((r) => `${r.channel} (${r.pctToMin}%)`).join(', ')}.` : 'Every channel is at or above its minimum.'}${ahead.length ? ` Past stretch: ${ahead.map((r) => r.channel).join(', ')}.` : ''}`,
            blocks: [moduleTable(spec, `Loan score card, ${monthName(x.month)}`, ctx.runId, 'sales.loan_scorecard', [text('channel', 'Channel'), { field: 'mtd', headerName: 'Month to date', type: 'currency' }, { field: 'mtdGoal', headerName: 'Month minimum', type: 'currency' }, { field: 'ytd', headerName: 'Year to date', type: 'currency' }, { field: 'minYtd', headerName: 'YTD minimum', type: 'currency' }, { field: 'stretchYtd', headerName: 'YTD stretch', type: 'currency' }, text('toMin', '% to minimum'), text('toStretch', '% to stretch')], [...x.rows, x.total].map((r) => ({ channel: r.channel, mtd: Math.round(r.mtd), mtdGoal: Math.round(r.mtdGoal), ytd: Math.round(r.ytd), minYtd: Math.round(r.minYtd), stretchYtd: Math.round(r.stretchYtd), toMin: `${r.pctToMin}%`, toStretch: `${r.pctToStretch}%` })))],
            sources,
            suggestions: ['How are the sales contests going?', 'Show the scorecards by region'],
          };
        },
      },
      {
        name: 'sales_contests',
        description: 'Sales contests, running and ended: the product, how they are scored, the dates and prize, and the standings by loan officer or branch.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const x = await svc.contests(ctx);
          if (!x.contests.length) return { text: 'There are no sales contests set up.' };
          const line = (c: (typeof x.contests)[number]) => {
            const lead = c.standings[0];
            const score = (s: (typeof c.standings)[number]) => (c.metric === 'count' ? `${s.count} loans` : mm(s.dollars));
            return `**${c.name}** (${c.status.toLowerCase()}${c.status === 'Running' ? `, ${c.daysLeft} days left` : ''}): ${lead ? `${c.status === 'Ended' ? 'won by' : 'led by'} ${lead.name}${c.by === 'loan officer' ? ` (${lead.branch})` : ''} with ${score(lead)}` : 'no entries yet'}. Prize: ${c.prize.charAt(0).toLowerCase()}${c.prize.slice(1)}.`;
          };
          return {
            text: x.contests.map(line).join(' '),
            blocks: x.contests.map((c) => moduleTable(spec, `${c.name}, ${c.starts} to ${c.ends}`, ctx.runId, 'sales.contests', [{ field: 'rank', headerName: 'Rank', type: 'number' }, text('name', c.by === 'loan officer' ? 'Loan officer' : 'Branch'), ...(c.by === 'loan officer' ? [text('branch', 'Branch')] : []), { field: 'count', headerName: 'Loans', type: 'count' }, { field: 'dollars', headerName: 'Dollars', type: 'currency' }], c.standings.map((s) => ({ rank: s.rank, name: s.name, ...(c.by === 'loan officer' ? { branch: s.branch } : {}), count: s.count, dollars: Math.round(s.dollars) })))),
            sources,
            suggestions: ['Show the loan score card', 'Show the scorecards by region'],
          };
        },
      },
      {
        name: 'sales_regions',
        description: 'The incentive scorecards for the current period rolled up by region: each goal’s actual against target, how many people are behind, and payouts.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const regions = await svc.regions(goals, { employeeId: ctx.employeeId, leads: true, approves: true }, ctx);
          const pctOf = (r: (typeof regions)[number]) => Math.round(r.goals.reduce((s, g) => s + g.pct, 0) / Math.max(1, r.goals.length));
          const ranked = [...regions].sort((a, b) => pctOf(b) - pctOf(a));
          const goalNames = [...new Set(regions.flatMap((r) => r.goals.map((g) => g.name)))];
          return {
            text: `${ranked.length} ${ranked.length === 1 ? 'region' : 'regions'}: **${ranked[0]!.region}** leads at ${pctOf(ranked[0]!)}% of goal on average${ranked.length > 1 ? `, and ${ranked.at(-1)!.region} trails at ${pctOf(ranked.at(-1)!)}%` : ''}. ${regions.reduce((s, r) => s + r.behind, 0)} of ${regions.reduce((s, r) => s + r.people, 0)} people are behind on at least one goal.`,
            blocks: [moduleTable(spec, 'Scorecards by region', ctx.runId, 'sales.regions', [text('region', 'Region'), text('branches', 'Branches'), { field: 'people', headerName: 'People', type: 'count' }, { field: 'behind', headerName: 'Behind', type: 'count' }, ...goalNames.map((n, i) => text(`g${i}`, `${n}, % of goal`)), { field: 'payout', headerName: 'Payouts', type: 'currency' }], regions.map((r) => ({ region: r.region, branches: r.branches.join(', '), people: r.people, behind: r.behind, ...Object.fromEntries(goalNames.map((n, i) => [`g${i}`, (() => { const g = r.goals.find((x) => x.name === n); return g ? `${g.pct}%` : '—'; })()])), payout: r.payout })))],
            sources,
            suggestions: ['Show the loan score card', 'How are the sales contests going?'],
          };
        },
      },
    ],
  };
  return spec;
}
