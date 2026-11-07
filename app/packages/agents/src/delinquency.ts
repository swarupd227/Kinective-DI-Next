// Delinquency in depth on the shared module agent: aging buckets, roll rates, vintages, the worst
// segments, the largest delinquent loans and losses. The ratio itself, its trend and "where does it
// come from" stay with Analytics; this agent answers the collections and credit-risk questions.
import { z } from 'zod';
import { CoreError, DQ_BUCKETS, type DelinquencyService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const NO_ACCESS = 'Delinquency detail isn’t part of your DI access.';
const guard = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('delinquency')) throw new CoreError('NO_ACCESS', NO_ACCESS);
};
const m = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3).toLocaleString('en-US')}K`);
const p2 = (n: number) => `${n.toFixed(2)}%`;
const p1 = (n: number) => `${n.toFixed(1)}%`;
const CATEGORY = /\b(auto|mortgage|heloc|home equity|credit cards?|personal|business|consumer|commercial)\b/i;
const toCategory = (t: string) => {
  const c = CATEGORY.exec(t)?.[1]?.toLowerCase();
  return c ? ({ auto: 'Auto', mortgage: 'Mortgage', heloc: 'HELOC', 'home equity': 'HELOC', 'credit card': 'Credit Card', 'credit cards': 'Credit Card', personal: 'Personal', business: 'Business', consumer: 'Consumer', commercial: 'Commercial & Industrial' } as Record<string, string>)[c] : undefined;
};

export function delinquencyModule(dq: DelinquencyService): ModuleSpec {
  const scope = (ctx: ModuleContext) => ({ purviewBranches: ctx.purviewBranches });
  const spec: ModuleSpec = {
    id: 'delinquency',
    prefix: 'dq',
    agent: 'Delinquency',
    request: /\broll ?rates?\b|\brolled\b|\bvintages?\b|\bcohorts?\b|\baging\b|\bdays past due\b|\bdelinquency buckets?\b|\b30\+|\b30[-–]59\b|\b30 (day|plus)\b|\bcure rate|\bcured\b|\b(largest|biggest|top|most) delinquent\b|\bdelinquent loans to work\b|\bworst (segments?|branches and products)\b|\b(drives?|driving) (our |the )?delinquency\b|\bdelinquency drivers?\b|\bnet charge-?off|\bcharge-?off ratio|\ballowance coverage|^(?![\s\S]*\b(?:chart|graph|plot)\b)[\s\S]*?(?:\bnpl\b|\bnon-?performing loans?\b)|\bcollections (list|queue)\b/i,
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'Delinquency history (month-end)', ref: 'table:hist_loan_dq_month' }],
    prompt: ({ tenant, user, title }) => `You are the Delinquency agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) manages credit quality. Buckets are the 5300's: Current, 30–59, 60–89, 90–179, 180–359 and 360+ days; 60+ is reportable delinquency. Roll rates are the share of last month's balance in a status that moved to each status this month.

- "Show delinquency by aging bucket", "how much is 30 to 59 days?": dq_aging, optionally for one loan category.
- "What are our roll rates?", "how much rolled from 30 to 60?", "what's the cure rate?": dq_rolls.
- "How are recent vintages performing?": dq_vintages.
- "Which branches and products are worst?": dq_segments.
- "Show the largest delinquent loans", "which auto loans are 90+ days?": dq_loans with min_days and category.
- "What's our net charge-off ratio?", "allowance coverage?", "what's our NPL ratio?": dq_losses.
- You only read. Working a loan is the collector's action; offer the early-warning list for outreach.`,
    plan: (text) => {
      const t = text.toLowerCase();
      const category = toCategory(t);
      if (/charge-?off|allowance|coverage|\bnco\b|loss|\bnpl\b|non-?performing/.test(t)) return { tool: 'dq_losses', args: {} };
      if (/roll|cure|migrat/.test(t)) return { tool: 'dq_rolls', args: {} };
      if (/vintage|cohort|year (opened|booked|made)|origination year/.test(t)) return { tool: 'dq_vintages', args: {} };
      if (/worst|segments?|hot ?spots?|drive|driving|drivers?/.test(t)) return { tool: 'dq_segments', args: {} };
      if (/\bloans\b.*(largest|biggest|top|work|list|which|show)|(largest|biggest|top|most) delinquent/.test(t)) {
        const days = /\b(30|60|90|180|360)\s*\+|\b(30|60|90|180|360) days/.exec(t);
        return { tool: 'dq_loans', args: { min_days: days ? Number(days[1] ?? days[2]) : 60, ...(category ? { category } : {}) } };
      }
      return { tool: 'dq_aging', args: category ? { category } : {} };
    },
    tools: [
      {
        name: 'dq_aging',
        description: 'The latest month-end by aging bucket (Current to 360+ days) with the 30+ and 60+ ratios, and each loan category by bucket. Optionally one category.',
        input: z.object({ category: z.string().max(40).optional() }).strict(),
        run: async (a: { category?: string }, ctx) => {
          guard(ctx);
          const g = await dq.aging(scope(ctx));
          const cat = a.category ? g.categories.find((c) => c.category.toLowerCase() === a.category!.toLowerCase()) : null;
          if (a.category && !cat) return { text: `There are no ${a.category} loans in your view.` };
          const lead = cat
            ? `${cat.category} loans at ${g.label}: **${p2(cat.ratio30)}** 30+ and **${p2(cat.ratio60)}** 60+ days past due, of ${m(cat.balance)}.`
            : `At ${g.label}, **${p2(g.ratio30)}** of loans are 30+ days past due (${m(g.delinquent30)}) and **${p2(g.ratio60)}** are 60+ (${m(g.delinquent60)}), the 5300’s reportable delinquency.`;
          const worst = [...g.categories].sort((x, y) => y.ratio60 - x.ratio60)[0];
          return {
            text: `${lead}${!cat && worst ? ` **${worst.category}** has the highest 60+ ratio, ${p2(worst.ratio60)}.` : ''}`,
            blocks: [
              moduleTable(spec, `Aging at ${g.label}`, ctx.runId, 'dq.aging', [{ field: 'bucket', headerName: 'Days past due', type: 'text' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'count', headerName: 'Loans', type: 'number' }, { field: 'pct', headerName: 'Share of loans', type: 'text' }], (cat ? DQ_BUCKETS.map((b) => ({ bucket: b, balance: Math.round(cat.by[b] ?? 0), count: 0, pct: p2(((cat.by[b] ?? 0) / (cat.balance || 1)) * 100) })) : g.buckets.map((b) => ({ bucket: b.bucket, balance: Math.round(b.balance), count: b.count, pct: p2(b.pct) })))),
              ...(cat ? [] : [moduleTable(spec, 'Loan categories by days past due', ctx.runId, 'dq.aging.category', [{ field: 'category', headerName: 'Category', type: 'text' }, ...DQ_BUCKETS.slice(1).map((b) => ({ field: b, headerName: b, type: 'currency' as const })), { field: 'r30', headerName: '30+', type: 'text' }, { field: 'r60', headerName: '60+', type: 'text' }], g.categories.map((c) => ({ category: c.category, ...Object.fromEntries(DQ_BUCKETS.slice(1).map((b) => [b, Math.round(c.by[b] ?? 0)])), r30: p2(c.ratio30), r60: p2(c.ratio60) })))]),
            ],
            suggestions: ['What are our roll rates?', 'Show the largest delinquent loans'],
          };
        },
      },
      {
        name: 'dq_rolls',
        description: 'Roll rates: of last month’s balance in each status, the share in each status this month (the matrix), and the key forward rolls and the 30-day cure rate over six months.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const r = await dq.rolls(scope(ctx));
          const key = (name: string) => r.series.find((s) => s.name === name)!;
          const now = (name: string) => key(name).rates[key(name).rates.length - 1]!.rate;
          const avg = (name: string) => key(name).rates.slice(0, -1).reduce((s, x) => s + x.rate, 0) / Math.max(1, key(name).rates.length - 1);
          const c30 = now('Current to 30');
          const r3060 = now('30 to 60');
          const cure = r.cure[r.cure.length - 1]!.rate;
          return {
            text: `In ${r.label}, **${p2(c30)}** of current balances rolled to 30 days (${c30 > avg('Current to 30') ? 'up' : 'down'} from a ${p2(avg('Current to 30'))} average), **${p1(r3060)}** of 30-day balances rolled to 60 and **${p1(now('60 to 90'))}** of 60-day to 90. **${p1(cure)}** of 30-day balances cured. ${r3060 > avg('30 to 60') + 2 ? 'The 30-to-60 roll is above its recent average, which leads the 60+ ratio by a month or two.' : 'Forward rolls are near their recent averages.'}`,
            blocks: [
              moduleTable(spec, `Roll rates, ${r.label}`, ctx.runId, 'dq.rolls.matrix', [{ field: 'from', headerName: 'Last month', type: 'text' }, ...[...DQ_BUCKETS, 'Charged off'].map((b) => ({ field: b, headerName: b, type: 'text' as const }))], r.matrix.map((row) => ({ from: row.from, ...Object.fromEntries(Object.entries(row.to).map(([k, v]) => [k, v ? p1(v) : '–'])) }))),
              moduleTable(spec, 'Forward rolls by month', ctx.runId, 'dq.rolls.series', [{ field: 'name', headerName: 'Roll', type: 'text' }, ...key('Current to 30').rates.map((x) => ({ field: x.month, headerName: x.label, type: 'text' as const }))], r.series.map((s) => ({ name: s.name, ...Object.fromEntries(s.rates.map((x) => [x.month, p2(x.rate)])) }))),
            ],
            suggestions: ['Which branches and products are worst?'],
          };
        },
      },
      {
        name: 'dq_vintages',
        description: 'Delinquency by the year loans were made: balance, loans, 30+ and 60+ ratios per vintage.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const v = (await dq.vintages(scope(ctx))).filter((x) => x.balance > 0);
          const recent = v.slice(-3);
          const older = v.slice(0, -3);
          const avgOld = older.reduce((s, x) => s + x.ratio60 * x.balance, 0) / Math.max(1, older.reduce((s, x) => s + x.balance, 0));
          const avgNew = recent.reduce((s, x) => s + x.ratio60 * x.balance, 0) / Math.max(1, recent.reduce((s, x) => s + x.balance, 0));
          return {
            text: `Loans made in ${recent.map((x) => x.vintage).join(', ')} run **${p2(avgNew)}** 60+ delinquent, against **${p2(avgOld)}** for older vintages. ${avgNew > avgOld ? 'Newer lending is performing worse, worth a look at recent underwriting.' : 'Newer lending is performing no worse than older loans.'} Young loans are still seasoning, so their ratios usually rise for a year or two.`,
            blocks: [moduleTable(spec, 'Delinquency by vintage', ctx.runId, 'dq.vintages', [{ field: 'vintage', headerName: 'Year opened', type: 'text' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'loans', headerName: 'Loans', type: 'number' }, { field: 'r30', headerName: '30+', type: 'text' }, { field: 'r60', headerName: '60+', type: 'text' }], [...v].reverse().slice(0, 15).map((x) => ({ vintage: String(x.vintage), balance: Math.round(x.balance), loans: x.loans, r30: p2(x.ratio30), r60: p2(x.ratio60) })))],
          };
        },
      },
      {
        name: 'dq_segments',
        description: 'Branch and loan category pairs with the highest 60+ ratio (at least $1M outstanding), with the change over three months.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const s = await dq.segments(scope(ctx));
          if (!s.length) return { text: 'No branch and product pair has enough balance to compare.' };
          const rising = s.filter((x) => x.changeBp > 0).sort((a, b) => b.changeBp - a.changeBp)[0];
          return {
            text: `The highest 60+ ratio is **${s[0]!.category} at ${s[0]!.branch}**, ${p2(s[0]!.ratio60)} of ${m(s[0]!.balance)}.${rising ? ` The fastest rise over three months is ${rising.category} at ${rising.branch}, up ${rising.changeBp} bp.` : ''}`,
            blocks: [moduleTable(spec, 'Highest 60+ by branch and product', ctx.runId, 'dq.segments', [{ field: 'branch', headerName: 'Branch', type: 'text' }, { field: 'category', headerName: 'Category', type: 'text' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'r60', headerName: '60+', type: 'text' }, { field: 'change', headerName: 'Change, 3 months', type: 'text' }], s.map((x) => ({ branch: x.branch, category: x.category, balance: Math.round(x.balance), r60: p2(x.ratio60), change: `${x.changeBp > 0 ? '+' : x.changeBp < 0 ? '−' : ''}${Math.abs(x.changeBp)} bp` })))],
            suggestions: [`Show the largest delinquent ${s[0]!.category.toLowerCase()} loans`],
          };
        },
      },
      {
        name: 'dq_loans',
        description: 'The largest open loans at least min_days past due, optionally one category: borrower, product, branch, balance, days and bucket.',
        input: z.object({ min_days: z.number().int().min(1).max(720).default(60), category: z.string().max(40).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict(),
        run: async (a: { min_days: number; category?: string; limit: number }, ctx) => {
          guard(ctx);
          const list = await dq.loans({ ...scope(ctx), minDays: a.min_days, category: a.category, limit: a.limit });
          if (!list.length) return { text: `No ${a.category ? `${a.category} ` : ''}loans are ${a.min_days}+ days past due in your view.` };
          const total = list.reduce((s, l) => s + l.balance, 0);
          return {
            text: `The ${list.length} largest ${a.category ? `${a.category.toLowerCase()} ` : ''}loans ${a.min_days}+ days past due total **${m(total)}**. The largest is ${list[0]!.name}’s ${list[0]!.category.toLowerCase()} at ${list[0]!.branch}, ${m(list[0]!.balance)}, ${list[0]!.days} days past due. Working them is the collector’s step; DI can queue outreach from the early-warning list.`,
            blocks: [moduleTable(spec, `Largest loans ${a.min_days}+ days past due`, ctx.runId, 'dq.loans', [{ field: 'name', headerName: 'Borrower', type: 'text' }, { field: 'member', headerName: 'Member', type: 'text' }, { field: 'category', headerName: 'Category', type: 'text' }, { field: 'branch', headerName: 'Branch', type: 'text' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'days', headerName: 'Days past due', type: 'number' }, { field: 'bucket', headerName: 'Bucket', type: 'text' }, { field: 'channel', headerName: 'Channel', type: 'text' }], list.map((l) => ({ name: l.name, member: `…${l.last4}`, category: l.category, branch: l.branch, balance: Math.round(l.balance), days: l.days, bucket: l.bucket, channel: l.channel })))],
            suggestions: ['Queue outreach tasks for the early-warning list'],
          };
        },
      },
      {
        name: 'dq_losses',
        description: 'Net charge-offs year to date and the annualized net charge-off ratio, the allowance for credit losses and its coverage of problem loans; for a bank, the nonperforming loans ratio (nonaccrual plus 90+ days past due) too. From the latest 5300 or FFIEC Call Report.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const l = await dq.losses();
          if (!l) return { text: 'Charge-offs and the allowance come from the Call Report, which isn’t loaded for this institution.' };
          // A bank reads its nonperforming loans (RC-N nonaccrual plus 90+ days past due); a credit union, 60+ delinquency.
          const npl = l.bank && l.nplRatio !== null ? ` Nonperforming loans are **${m(l.nonperforming ?? 0)}**, an NPL ratio of **${p2(l.nplRatio)}** of loans.` : '';
          return { text: `Net charge-offs are **${m(l.netChargeOffs)}** year to date, an annualized **${p2(l.ncoRatio)}** of average loans (${m(l.averageLoans)}, the mean of this quarter’s and last year-end’s).${npl} The allowance is ${m(l.allowance)}, ${p2(l.allowanceToLoans)} of loans${l.coverage !== null ? `, covering ${l.bank ? 'nonperforming loans' : '60+ delinquency'} **${l.coverage.toFixed(2)} times**` : ''}.` };
        },
      },
    ],
  };
  return spec;
}
