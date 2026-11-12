// Account Activity: fee income by type, product and branch, and the channel mix, from the last 30 days
// of loan and share transactions. Listed last among the agents, so questions other agents answer stay theirs.
import { z } from 'zod';
import { CoreError, type ActivityService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const ACTIVITY_REQUEST = /\bfees? by (?:type|fee type|branch|product)\b|\boverdraft fees?\b|\bmaintenance fees?\b|\bfees? (?:we )?charged\b|\bchannel (?:mix|usage|use)\b|\btransactions? by channel\b|\bhow (?:do )?(?:members|customers|people) (?:transact|bank)\b|\b(?:teller|atm|mobile|card) (?:transactions|usage|volume)\b/i;
const NO_ACCESS = 'Account activity isn’t part of your DI access.';
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const FEE_TYPES = ['Overdraft', 'Maintenance', 'ATM', 'Late payment'] as const;
const feeType = (t: string): (typeof FEE_TYPES)[number] | undefined =>
  /\b(?:overdraft|nsf)\b/i.test(t) ? 'Overdraft' : /\bmaintenance\b/i.test(t) ? 'Maintenance' : /\batm fees?\b/i.test(t) ? 'ATM' : /\blate (?:payment )?fees?\b/i.test(t) ? 'Late payment' : undefined;
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });

export function activityModule(svc: ActivityService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('activity')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const sources: ModuleSpec['sources'] = [{ kind: 'table', label: 'Share and loan transactions, from the core', ref: 'table:cdm_share_transaction' }];
  const spec: ModuleSpec = {
    id: 'activity',
    prefix: 'act',
    agent: 'Account Activity',
    request: ACTIVITY_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the Account Activity agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) looks at how accounts are used, from the last 30 days of loan and share transactions.

- act_fees (type): fees charged, by fee type (overdraft, maintenance, ATM, late payment), product and branch. Pass type for one fee type, such as overdraft fees by branch.
- act_channels: transactions by channel (teller, ATM, card, mobile, online, ACH): how many, how many people, and dollars.`,
    plan: (t) => (/\bfees?\b/i.test(t) ? { tool: 'act_fees', args: feeType(t) ? { type: feeType(t) } : {} } : { tool: 'act_channels', args: {} }),
    tools: [
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
        description: 'Transactions in the last 30 days by channel (teller, ATM, card, mobile, online, ACH): count, people and dollars, and each channel’s share.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const list = await svc.channels(ctx);
          if (!list) return { text: 'Loan and share transactions aren’t loaded for this institution yet.' };
          if (!list.length) return { text: 'No transactions in the last 30 days.' };
          const teller = list.find((c) => c.channel === 'Teller');
          return {
            text: `**${list[0]!.channel}** is the busiest channel, ${list[0]!.sharePct}% of transactions in the last 30 days.${teller ? ` Tellers handled ${teller.sharePct}%.` : ''}`,
            blocks: [moduleTable(spec, 'Transactions by channel, last 30 days', ctx.runId, 'activity.channels', [text('channel', 'Channel'), { field: 'transactions', headerName: 'Transactions', type: 'count' }, { field: 'people', headerName: 'People', type: 'count' }, { field: 'amount', headerName: 'Dollars', type: 'currency' }, text('share', 'Share')], list.map((c) => ({ ...c, share: `${c.sharePct}%` })))],
            sources,
          };
        },
      },
    ],
  };
  return spec;
}
