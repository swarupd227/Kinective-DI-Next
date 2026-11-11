// Referral Reports: the referral list with filters and export, conversion by type, sender, branch or the
// person who worked it, whether each sale really opened the product in the core, and expiring referrals
// that went stale. Making and working a referral stay with the Referral and Inbox agents.
import { z } from 'zod';
import { CoreError, ReferralReportService, type RefFilters, type RefGroupBy } from '@dinext/di-core';
import { REFERRAL_EXPIRE_DAYS } from '@dinext/tenant-db';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const REFERRAL_REPORT_REQUEST =
  /\breferral (?:reports?|conversion|performance|history|list|funnel|stats|statistics)\b|\bconversion\b[^.?!]*\breferrals?\b|\breferrals?\b[^.?!]*\b(?:by (?:type|branch|staff|sender|employee|person|product|officer)|convert(?:ed|s)?|conversion|expired?|expiring|stale|history|export)\b|\bwho (?:sends|refers|made|makes) the most referrals\b|\ball (?:the )?referrals\b|\b(?:sold|closed) referrals\b|\ball (?:the )?(?:sold|closed|expired|declined)\b[^.?!]{0,30}\breferrals\b|\breferrals? (?:that|which) (?:sold|didn'?t open|never opened)\b|\bhow many referrals\b/i;

const NO_ACCESS = 'Referral reports aren’t part of your DI access.';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`);
const STAGES = ['New Referral', 'Active', 'Sold', 'Not Interested', 'Expired'];
type RefPeriod = '12m' | 'quarter' | 'year';
/** Where a reporting period starts, and how to say it. */
export function refPeriod(period: RefPeriod | undefined, today = new Date().toISOString().slice(0, 10)): { since?: string; label: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  if (period === 'quarter') {
    const q = `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
    return { since: q, label: `this quarter (since ${q})` };
  }
  if (period === 'year') return { since: `${y}-01-01`, label: `this year (since ${y}-01-01)` };
  return { label: 'the last 12 months' };
}

export function referralReportPlan(t: string) {
  const s = t.toLowerCase();
  if (/\b(?:expire|stale|old open|close out)\b/.test(s) && !/\bexpired (?:referrals )?(?:by|last|this)\b/.test(s)) return { tool: 'ref_expire', args: {} };
  const by: RefGroupBy | undefined = /\bby (?:branch|location)\b/.test(s) ? 'branch' : /\bby (?:staff|sender|employee|person|who)\b|\bwho (?:sends|refers|made|makes) the most\b/.test(s) ? 'sender' : /\bby (?:officer|assignee|who worked|lender)\b/.test(s) ? 'assignee' : /\bby (?:type|product)\b|\bconversion\b|\bconvert/.test(s) ? 'type' : undefined;
  const period: RefPeriod | undefined = /\bthis quarter|\bquarter to date|\bqtd\b/.test(s) ? 'quarter' : /\bthis year|\byear to date|\bytd\b/.test(s) ? 'year' : undefined;
  if (by && !/\b(?:list|show me (?:all|the) referrals|export)\b/.test(s)) return { tool: 'ref_performance', args: period ? { by, period } : { by } };
  const f: Record<string, unknown> = {};
  const stage = STAGES.find((x) => s.includes(x.toLowerCase()));
  if (stage) f.stage = stage;
  if (/\bsold\b/.test(s)) f.stage = 'Sold';
  if (/\bopen\b/.test(s) && !f.stage) f.open = true;
  const type = /\b(heloc|auto loan|first mortgage|mortgage|credit card|certificate|business account|retention)\b/.exec(s)?.[1];
  if (type) f.type = type === 'mortgage' ? 'First mortgage' : type === 'retention' ? 'Retention follow-up' : type.replace(/\b\w/, (c) => c.toUpperCase()).replace('Heloc', 'HELOC');
  const branch = /\b(?:at|in|for) ([A-Z][a-z]+)(?: branch)?\b/.exec(t)?.[1];
  if (branch && !['September', 'October', 'November', 'December', 'January'].includes(branch)) f.branch = branch;
  if (/\bthis year\b/.test(s)) f.from = '2026-01-01';
  if (/\bdidn'?t open|never opened|not opened\b/.test(s)) return { tool: 'ref_performance', args: { by: 'type' } };
  return Object.keys(f).length || /\blist|all (?:the )?referrals|history|export\b/.test(s) ? { tool: 'ref_list', args: f } : { tool: 'ref_performance', args: { by: 'type' } };
}

export function referralReportModule(svc: ReferralReportService, person: 'member' | 'customer' = 'member'): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('refreport')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const sources: ModuleSpec['sources'] = [{ kind: 'table', label: 'Referrals', ref: 'table:esp_com_items' }, { kind: 'table', label: 'Accounts opened, from the core', ref: 'table:cdm_loan' }];
  const spec: ModuleSpec = {
    id: 'refreport',
    prefix: 'ref',
    agent: 'Referral Reports',
    request: REFERRAL_REPORT_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the Referral Reports agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) looks at referrals across the ${person}s they can see: the full list with filters, conversion by type, sender, branch or the person who worked them, whether each sale really opened the product in the core, and open referrals that have gone ${REFERRAL_EXPIRE_DAYS} days with no activity.

- ref_list (type, stage, branch, sender, assignee, from, to, open): the referrals, newest first.
- ref_performance (by type, sender, branch or assignee; period 12m, quarter or year): conversion for the last 12 months, this quarter or this year.
- ref_expire: lists the stale referrals and puts up an approval card to expire them. Nothing changes until someone approves the card, so run it whenever stale referrals come up; don't ask first.`,
    plan: (t) => referralReportPlan(t),
    tools: [
      {
        name: 'ref_list',
        description: 'Referrals matching filters (type, stage, branch, sender, assignee, created from/to, open only), newest first, with whether each sale opened the product in the core.',
        input: z.object({ type: z.string().max(40).optional(), stage: z.string().max(30).optional(), branch: z.string().max(40).optional(), sender: z.string().max(80).optional(), assignee: z.string().max(80).optional(), from: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional(), to: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional(), open: z.boolean().optional() }).strict(),
        run: async (a: RefFilters, ctx) => {
          need(ctx);
          const x = await svc.list(a, ctx);
          const filters = Object.entries(a).map(([k, v]) => (k === 'open' ? 'open only' : `${k} ${v}`)).join(', ');
          if (!x.total) return { text: `No referrals match${filters ? ` ${filters}` : ''}.` };
          const sold = x.items.filter((r) => r.stage === 'Sold');
          const unmatched = sold.filter((r) => !r.opened && ['HELOC', 'Auto loan', 'First mortgage', 'Credit card', 'Certificate', 'Business account'].includes(r.type));
          return {
            text: `**${x.total.toLocaleString('en-US')} referrals**${filters ? ` (${filters})` : ''}${x.total > x.items.length ? `; the latest ${x.items.length} are below, and the table exports` : ''}.${sold.length ? ` Of ${sold.length} sold, ${sold.length - unmatched.length} show the product opened in the core${unmatched.length ? `; ${unmatched.length} don’t` : ''}.` : ''}`,
            blocks: [moduleTable(spec, 'Referrals', ctx.runId, 'referral.report.list', [text('id', 'Referral'), text('created', 'Made'), text('type', 'Type'), text('member', person === 'member' ? 'Member' : 'Customer'), text('branch', 'Branch'), text('stage', 'Stage'), text('sender', 'From'), text('assignee', 'Worked by'), text('closed', 'Closed'), text('opened', 'Product opened')], x.items.map((r) => ({ id: `#${r.comId}`, created: r.created, type: r.type, member: r.member, branch: r.branch, stage: r.stage, sender: r.sender, assignee: r.assignee ?? 'Queue', closed: r.closed ?? '', opened: r.stage !== 'Sold' ? '' : r.opened ? `${r.opened.product}, ${r.opened.date}` : 'Not found' })))],
            sources,
            suggestions: ['Show referral conversion by type', 'Who makes the most referrals?', 'Which referrals have gone stale?'],
          };
        },
      },
      {
        name: 'ref_performance',
        description: 'Referral conversion over the last 12 months (or this quarter or this year, by period) by type, sender, branch or the person who worked them: made, sold, not interested, expired, open, conversion, days to close, and the share of sales that opened the product.',
        input: z.object({ by: z.enum(['type', 'sender', 'branch', 'assignee']), period: z.enum(['12m', 'quarter', 'year']).optional() }).strict(),
        run: async (a: { by: RefGroupBy; period?: RefPeriod }, ctx) => {
          need(ctx);
          const per = refPeriod(a.period);
          const x = await svc.performance(a.by, ctx, 12, per.since);
          const t = x.total;
          const best = [...x.rows].filter((r) => r.referrals >= 10 && r.conversionPct !== null).sort((p, q) => q.conversionPct! - p.conversionPct!)[0];
          const label = { type: 'Type', sender: 'Made by', branch: 'Branch', assignee: 'Worked by' }[a.by];
          return {
            text: `${per.since ? per.label.replace(/^t/, 'T') : 'In the last 12 months'}, **${t.referrals.toLocaleString('en-US')} referrals**: ${t.sold} sold, ${t.notInterested} not interested, ${t.expired} expired and ${t.open} still open, so **${pct(t.conversionPct)}** of those closed sold, in ${t.avgDaysToClose ?? '—'} days on average.${best ? ` ${best.name} converts best, ${pct(best.conversionPct)}.` : ''}${x.notOpened.length ? ` **${x.notOpened.length} sales** have no matching account opened in the core: worth checking before incentive credit is paid.` : ''}`,
            blocks: [
              moduleTable(spec, `Referral conversion by ${label.toLowerCase()}, ${per.since ? per.label.replace(/ \(since .*\)$/, '') : 'last 12 months'}`, ctx.runId, 'referral.report.performance', [text('name', label), { field: 'referrals', headerName: 'Made', type: 'count' }, { field: 'sold', headerName: 'Sold', type: 'count' }, { field: 'notInterested', headerName: 'Not interested', type: 'count' }, { field: 'expired', headerName: 'Expired', type: 'count' }, { field: 'open', headerName: 'Open', type: 'count' }, text('conversion', 'Converted'), text('days', 'Days to close'), text('opened', 'Sales opened in core')], [...x.rows, t].map((r) => ({ name: r.name, referrals: r.referrals, sold: r.sold, notInterested: r.notInterested, expired: r.expired, open: r.open, conversion: pct(r.conversionPct), days: r.avgDaysToClose === null ? '—' : String(r.avgDaysToClose), opened: pct(r.openedPct) }))),
              ...(x.notOpened.length ? [moduleTable(spec, 'Sold, but no matching account opened', ctx.runId, 'referral.report.unopened', [text('id', 'Referral'), text('type', 'Type'), text('member', person === 'member' ? 'Member' : 'Customer'), text('sender', 'From'), text('closed', 'Sold on')], x.notOpened.slice(0, 50).map((r) => ({ id: `#${r.comId}`, type: r.type, member: r.member, sender: r.sender, closed: r.closed ?? '' })))] : []),
            ],
            sources,
            suggestions: [a.by === 'type' ? 'Who makes the most referrals?' : 'Show referral conversion by type', 'Show referral conversion by branch', 'Which referrals have gone stale?'],
          };
        },
      },
      {
        name: 'ref_expire',
        description: `Open referrals with no activity for ${REFERRAL_EXPIRE_DAYS} days, expired on approval (closed as Expired with a note on each).`,
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const x = await svc.stale(ctx);
          if (!x.items.length) return { text: `No open referral has gone ${x.days} days without activity.` };
          return {
            change: {
              summary: `Expire ${x.items.length} stale ${x.items.length === 1 ? 'referral' : 'referrals'}`,
              changes: x.items.slice(0, 20).map((r) => ({ label: `#${r.comId} ${r.type}, ${r.member}`.slice(0, 80), before: `${r.stage}, last activity ${r.lastActivity}`, after: 'Expired' })),
              text: `**${x.items.length} open ${x.items.length === 1 ? 'referral has' : 'referrals have'}** had no activity for ${x.days} days or more. I’ve prepared expiring them: each closes as Expired, with a note on its history, and drops off its queue.`,
              done: `Expired ${x.items.length} stale ${x.items.length === 1 ? 'referral' : 'referrals'}.`,
              risk: 'medium',
              apply: { comIds: x.items.map((r) => r.comId) },
            },
          };
        },
        apply: async (p: { comIds: number[] }, meta, ctx) => {
          await svc.expire(p.comIds, { userId: meta.userId, userName: ctx.user.name });
        },
      },
    ],
  };
  return spec;
}
