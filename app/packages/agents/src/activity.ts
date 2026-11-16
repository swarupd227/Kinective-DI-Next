// Account Activity: fee income by type, product and branch, and the channel mix, from the last 30 days
// of loan and share transactions. Listed last among the agents, so questions other agents answer stay theirs.
import { z } from 'zod';
import { CoreError, type ActivityService, type EngagementService, type MemberProfitService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

/** Events on accounts and people (ESP phase 7): large deposits, overdrafts, late loans, direct deposit stopped. */
export const ALERT_REQUEST = /\b(?:member|customer|account) alerts?\b|\balerts? (?:this|last|in the last) (?:week|month|\d+ days)\b|\b(?:any|show|which) alerts?\b|\balerts? on (?:my |our )?(?:members|customers|accounts)\b|\bwhich (?:members|customers) had (?:a )?large (?:deposits?|withdrawals?)\b|\blarge (?:deposits?|withdrawals?) (?:this|last) (?:week|month)\b|\bwhose direct deposit stopped\b/i;

export const ACTIVITY_REQUEST = /\bfees? by (?:type|fee type|branch|product)\b|\boverdraft fees?\b|\bmaintenance fees?\b|\bfees? (?:we )?charged\b|\bchannel (?:mix|usage|use)\b|\btransactions? by channel\b|\bhow (?:do )?(?:members|customers|people) (?:transact|bank)\b|\b(?:teller|atm|mobile|card) (?:transactions|usage|volume)\b|\btransaction costs?\b|\bcost (?:to serve|per transaction|by channel)\b|\bchannel costs?\b|\bwhat (?:do|does) (?:our |a )?(?:transactions?|tellers?) cost\b/i;
const NO_ACCESS = 'Account activity isn’t part of your DI access.';
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const FEE_TYPES = ['Overdraft', 'Maintenance', 'ATM', 'Late payment'] as const;
const feeType = (t: string): (typeof FEE_TYPES)[number] | undefined =>
  /\b(?:overdraft|nsf)\b/i.test(t) ? 'Overdraft' : /\bmaintenance\b/i.test(t) ? 'Maintenance' : /\batm fees?\b/i.test(t) ? 'ATM' : /\blate (?:payment )?fees?\b/i.test(t) ? 'Late payment' : undefined;
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });

/** costs: what each kind of transaction costs to handle (ESP phase 6); alerts: events on accounts and people (ESP phase 7); where loaded. */
export function activityModule(svc: ActivityService, costs: MemberProfitService | null = null, alerts: EngagementService | null = null): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('activity')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const sources: ModuleSpec['sources'] = [{ kind: 'table', label: 'Share and loan transactions, from the core', ref: 'table:cdm_share_transaction' }];
  const spec: ModuleSpec = {
    id: 'activity',
    prefix: 'act',
    agent: 'Account Activity',
    request: new RegExp(`${ALERT_REQUEST.source}|${ACTIVITY_REQUEST.source}`, 'i'),
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the Account Activity agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) looks at how accounts are used, from the last 30 days of loan and share transactions.

- act_fees (type): fees charged, by fee type (overdraft, maintenance, ATM, late payment), product and branch. Pass type for one fee type, such as overdraft fees by branch.
- act_channels: transactions by channel (teller, ATM, card, mobile, online, ACH): how many, how many people, and dollars.
- act_alerts (days): events on accounts and people: large deposits and withdrawals, overdraft fees, loans 30 days late, certificates maturing, shares closed, direct deposit stopped, new members, birthdays. days 7 for this week, 30 for the month.`,
    plan: (t) => (ALERT_REQUEST.test(t) ? { tool: 'act_alerts', args: { days: /\bmonth|30 days\b/i.test(t) ? 30 : 7 } } : /\bfees?\b/i.test(t) ? { tool: 'act_fees', args: feeType(t) ? { type: feeType(t) } : {} } : { tool: 'act_channels', args: {} }),
    tools: [
      {
        name: 'act_alerts',
        description: 'Events on accounts and people over the last 7 or 30 days, under the viewer’s purview: how many of each kind, and the latest, with whose they are.',
        input: z.object({ days: z.union([z.literal(7), z.literal(30)]).default(7) }).strict(),
        run: async (a: { days?: 7 | 30 }, ctx: ModuleContext) => {
          need(ctx);
          const x = alerts ? await alerts.alerts(a.days ?? 7, ctx.purviewBranches ?? undefined) : null;
          if (!x) return { text: 'Alerts on accounts and people aren’t loaded for this institution yet.' };
          if (!x.total) return { text: `No alerts in the last ${x.days} days.` };
          // What needs acting on first; birthdays and new members are in the table.
          const kinds = x.byType.filter((k) => k.code !== 'BIRTHDAY' && k.code !== 'NEW_MEMBER').slice(0, 4).map((k) => `${k.count.toLocaleString('en-US')} ${k.type.toLowerCase()}`).join(', ');
          const large = x.items.find((i) => i.code === 'LARGE_DEPOSIT' || i.code === 'LARGE_WITHDRAWAL');
          const stopped = x.items.filter((i) => i.code === 'DD_STOPPED').length;
          return {
            text: `**${x.total.toLocaleString('en-US')} alerts** in the last ${x.days} days: ${kinds}.${large ? ` The latest large one: ${large.name} at ${large.branch}, ${large.description.charAt(0).toLowerCase()}${large.description.slice(1)}.` : ''}${stopped ? ` ${stopped} ${stopped === 1 ? 'person’s' : 'people’s'} direct deposit stopped: worth a call before the money follows.` : ''}`,
            blocks: [
              moduleTable(spec, `Alerts by kind, last ${x.days} days`, ctx.runId, 'activity.alerts.kind', [text('type', 'Alert'), { field: 'count', headerName: 'Alerts', type: 'count' }, { field: 'people', headerName: 'People', type: 'count' }], x.byType),
              moduleTable(spec, 'Latest alerts', ctx.runId, 'activity.alerts.items', [text('date', 'Date'), text('name', 'Name'), text('branch', 'Branch'), text('type', 'Alert'), text('description', 'What happened')], x.items.slice(0, 50).map((i) => ({ date: i.date, name: i.name, branch: i.branch, type: i.type, description: i.description }))),
            ],
            sources: [{ kind: 'table', label: 'Alerts on accounts and people', ref: 'table:cdm_account_alert' }],
          };
        },
      },
      {
        name: 'act_fees',
        description: 'Fees charged in the last 30 days: by fee type (overdraft, maintenance, out-of-network ATM, late payment), by product and by branch, with how many accounts paid one. Pass type for one fee type only.',
        input: z.object({ type: z.enum(FEE_TYPES).optional() }).strict(),
        run: async (a: { type?: (typeof FEE_TYPES)[number] }, ctx) => {
          need(ctx);
          const x = await svc.fees(ctx, a.type);
          if (!x) return { text: 'Loan and share transactions aren’t loaded for this institution yet.' };
          if (!x.byType.length) return { text: `No ${a.type ? `${a.type === 'ATM' ? 'ATM' : a.type.toLowerCase()} ` : ''}fees were charged in the last 30 days.` };
          const top = x.byType[0]!;
          const cols = (label: string) => [text('name', label), { field: 'fees', headerName: 'Fees', type: 'count' as const }, { field: 'accounts', headerName: 'Accounts', type: 'count' as const }, { field: 'amount', headerName: 'Amount', type: 'currency' as const }];
          if (a.type) {
            const b = x.byBranch[0];
            const name = a.type === 'ATM' ? 'ATM' : a.type.toLowerCase();
            return {
              text: `From ${x.from} to ${x.to}, **${usd(x.total)}** in ${name} fees from ${top.accounts.toLocaleString('en-US')} accounts.${b ? ` ${b.name} charged the most, ${usd(b.amount)}.` : ''}`,
              blocks: [moduleTable(spec, `${a.type} fees by branch`, ctx.runId, 'activity.fees.branch', cols('Branch'), x.byBranch), moduleTable(spec, `${a.type} fees by product`, ctx.runId, 'activity.fees.product', cols('Product'), x.byProduct)],
              sources,
            };
          }
          return {
            text: `From ${x.from} to ${x.to}, **${usd(x.total)}** in fees. ${top.name} fees were the largest, ${usd(top.amount)} from ${top.accounts.toLocaleString('en-US')} accounts.`,
            blocks: [moduleTable(spec, 'Fees by type', ctx.runId, 'activity.fees.type', cols('Fee type'), x.byType), moduleTable(spec, 'Fees by product', ctx.runId, 'activity.fees.product', cols('Product'), x.byProduct), moduleTable(spec, 'Fees by branch', ctx.runId, 'activity.fees.branch', cols('Branch'), x.byBranch)],
            sources,
          };
        },
      },
      {
        name: 'act_channels',
        description: 'Transactions in the last 30 days by channel (teller, ATM, card, mobile, online, ACH): count, people and dollars, each channel’s share, and what they cost to handle, with what moving a quarter of teller transactions to mobile and online would save.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const list = await svc.channels(ctx);
          if (!list) return { text: 'Loan and share transactions aren’t loaded for this institution yet.' };
          if (!list.length) return { text: 'No transactions in the last 30 days.' };
          const teller = list.find((c) => c.channel === 'Teller');
          // What they cost to handle (ESP phase 6), where the cost of each kind is loaded.
          const cost = costs ? await costs.channels().catch(() => null) : null;
          const costOf = new Map((cost?.list ?? []).map((c) => [c.channel, c]));
          const costText = cost ? ` They cost about ${usd(cost.total)} to handle, ${usd(cost.total * 12)} a year${cost.teller ? `; tellers handle ${cost.teller.share}% of them but ${cost.teller.costShare}% of the cost` : ''}.${cost.quarterToDigital > 0 ? ` Moving a quarter of teller transactions to mobile and online would save about ${usd(cost.quarterToDigital)} a year.` : ''}` : '';
          return {
            text: `**${list[0]!.channel}** is the busiest channel, ${list[0]!.sharePct}% of transactions in the last 30 days.${teller ? ` Tellers handled ${teller.sharePct}%.` : ''}${costText}`,
            blocks: [moduleTable(spec, 'Transactions by channel, last 30 days', ctx.runId, 'activity.channels', [text('channel', 'Channel'), { field: 'transactions', headerName: 'Transactions', type: 'count' }, { field: 'people', headerName: 'People', type: 'count' }, { field: 'amount', headerName: 'Dollars', type: 'currency' }, text('share', 'Share'), ...(cost ? [text('each', 'Cost each'), { field: 'cost', headerName: 'Cost to handle', type: 'currency' as const }] : [])], list.map((c) => ({ ...c, share: `${c.sharePct}%`, ...(cost ? { each: costOf.has(c.channel) ? `$${costOf.get(c.channel)!.each.toFixed(2)}` : '—', cost: costOf.get(c.channel)?.cost ?? 0 } : {}) })))],
            sources,
          };
        },
      },
    ],
  };
  return spec;
}
