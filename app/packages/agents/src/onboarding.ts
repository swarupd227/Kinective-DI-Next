// Onboarding agent (spec 24.21): today's calls with talking points, what's overdue, working a person's
// own touch points with the interview checklist, each new member's journey (what the scheduled process
// sent and whether it was opened) and the 90-day funnel by branch. Member letters and emails stay in the scheduled process, so this agent
// never sends one.
import { z } from 'zod';
import { CoreError, checklistFrom, type OnbChecklist, type OnboardingService, type TouchPoint } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const need = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('onboarding')) throw new CoreError('NO_ACCESS', 'Onboarding isn’t part of your DI access.');
};

const NO_LETTERS = 'Member letters and emails stay in the scheduled process, so I don’t send those. I can show who’s due a touch point, or update a task.';

/** What to raise, from the touch point and what's set up. */
export function talkingPoint(t: Pick<TouchPoint, 'touch' | 'directDeposit'>) {
  if (t.touch === 'Welcome call') return 'Welcome them, and check their card and online access arrived.';
  if (t.touch === 'Digital set-up check') return t.directDeposit ? 'Check mobile and bill pay are working.' : 'Offer help setting up direct deposit.';
  return t.directDeposit ? 'Ask how things are going and what else they need.' : 'Direct deposit isn’t set up yet, so offer help with it.';
}

const nameOf = (text: string) => /\b(?:mark|complete|finish|snooze|reassign|move)\s+(?:the\s+)?((?:[A-Z][\w'-]*\s?){1,3}?)(?:[’']s)?\s+(?:\d+-day\s+|welcome\s+|touch\s+|task|call|onboarding)/i.exec(text)?.[1]?.trim();

export function onboardingModule(onboarding: OnboardingService): ModuleSpec {
  const list = (ctx: ModuleContext, title: string, items: TouchPoint[], asOf: string) =>
    moduleTable(spec, title, ctx.runId, 'onboarding.task.list', [{ field: 'member', headerName: 'Member', type: 'text' }, { field: 'touch', headerName: 'Touch point', type: 'text' }, { field: 'due', headerName: 'Due', type: 'date' }, { field: 'state', headerName: 'State', type: 'text' }, { field: 'assignee', headerName: 'With', type: 'text' }, { field: 'point', headerName: 'Talking point', type: 'text' }], items.slice(0, 25).map((t) => ({ member: `${t.member} (…${t.last4})`, touch: t.touch, due: t.due, state: t.state, assignee: t.assignee ?? 'Branch queue', point: talkingPoint(t) })), asOf);
  const reach = (ctx: ModuleContext) => (ctx.leads || ctx.employeeId === undefined ? undefined : ctx.employeeId);

  const spec: ModuleSpec = {
    id: 'onboarding',
    prefix: 'onb',
    agent: 'Onboarding',
    request: /\bonboarding\b|\btouch ?points?\b|\bnew members?\b.*\b(direct deposit|calls?)\b|\bwelcome (?:calls?|emails?|letters?|kit|messages?)\b|\bfirst 90 days\b/i,
    noAccess: 'Onboarding isn’t part of your DI access.',
    sources: [{ kind: 'table', label: 'Onboarding tasks', ref: 'table:onb_task' }],
    prompt: ({ tenant, user, title }) => `You are the Onboarding agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) works new members' touch points.

- "What onboarding calls do I have today?": onb_tasks_list. "Which touch points are overdue?": onb_tasks_list with overdue_only.
- "Which new members haven't set up direct deposit after 30 days?": onb_no_direct_deposit.
- "Mark the Jackson 14-day call done; she set up direct deposit": onb_task_done with their words as note.
- onb_task_snooze and onb_task_reassign change a task.
- "Show the onboarding messages for Suzanne Jackson", "her journey": onb_journey, what the scheduled process sent and whether it was opened.
- "Show the onboarding funnel", "early attrition in the first 90 days": onb_funnel.
- You never send a letter or email to a member: those stay in the scheduled process. Say so.`,
    today: async (ctx) => {
      const f = await onboarding.list({ employeeId: reach(ctx), overdueOnly: true }, ctx);
      if (!f.count) return null;
      return { id: 'onboarding', title: `${f.count} onboarding ${f.count === 1 ? 'touch point' : 'touch points'} overdue`, why: `${f.missed ? `${f.missed} missed. ` : ''}Start with ${f.items[0]!.member}.`, badge: 'Overdue', ask: 'Show my overdue onboarding touch points', weight: 65 };
    },
    plan: (text) => {
      const t = text.trim().replace(/[.!?]+$/, '');
      if (/\b(send|email|mail)\b.*\b(letter|email|member|welcome)\b/i.test(t)) return { say: NO_LETTERS };
      if (/\bdirect deposit\b/i.test(t) && !/\b(mark|done)\b/i.test(t)) return { tool: 'onb_no_direct_deposit', args: {} };
      const member = nameOf(t);
      if (/\b(mark|complete|finish)\b.*\b(done|complete)\b|^complete\b/i.test(t)) return member ? { tool: 'onb_task_done', args: { member, ...(/;\s*(.+)$/.exec(t)?.[1] ? { note: /;\s*(.+)$/.exec(t)![1] } : {}) } } : { say: 'Whose touch point is it?' };
      if (/\bsnooze\b/i.test(t)) return member ? { tool: 'onb_task_snooze', args: { member, days: Number(/\b(\d+) days?\b/i.exec(t)?.[1] ?? 2) } } : { say: 'Whose touch point should I snooze?' };
      const to = /\bto ((?:[A-Z][\w.'-]*\s?){1,3})/.exec(t)?.[1]?.trim();
      if (/\b(reassign|move)\b/i.test(t)) return member && to ? { tool: 'onb_task_reassign', args: { member, to } } : { say: 'Whose touch point should move, and to whom?' };
      if (/\bfunnel\b|\bfirst 90 days\b|\bearly (?:attrition|churn|closures?)\b|\bproduct adoption\b/i.test(t)) return { tool: 'onb_funnel', args: {} };
      const journeyOf = /\b(?:journey|messages?|emails?|letters?)\b[^.?!]*\b(?:for|to|with)\s+((?:[A-Z][\w'-]*\s?){1,3})/.exec(t)?.[1]?.trim();
      if (journeyOf && !/\bsend\b/i.test(t)) return { tool: 'onb_journey', args: { member: journeyOf } };
      return { tool: 'onb_tasks_list', args: { overdue_only: /\boverdue\b|\blate\b|\bmissed\b/i.test(t) } };
    },
    tools: [
      {
        name: 'onb_journey',
        description: 'One new member’s journey: the messages the scheduled process sent (welcome email, letter, secure message, reminders, survey) and whether each was opened, the touch points, and the checklist recorded with each.',
        input: z.object({ member: z.string().min(2).max(80) }).strict(),
        run: async (a: { member: string }, ctx) => {
          need(ctx);
          const j = await onboarding.journey(a.member, ctx);
          const opened = j.messages.filter((m) => m.opened).length;
          const trackable = j.messages.filter((m) => m.opened !== null).length;
          return {
            text: `**${j.name}** joined ${j.joined}. The scheduled process has sent **${j.messages.length} messages**${trackable ? `, ${opened} of ${trackable} opened` : ''}; ${j.touches.filter((t) => t.status === 'Done').length} of ${j.touches.length} touch points are done. DI shows these; the scheduled process sends them.`,
            blocks: [
              moduleTable(spec, `Messages sent to ${j.name}`, ctx.runId, 'onboarding.journey.messages', [{ field: 'day', headerName: 'Day', type: 'number' }, { field: 'step', headerName: 'Message', type: 'text' }, { field: 'channel', headerName: 'Channel', type: 'text' }, { field: 'sent', headerName: 'Sent', type: 'text' }, { field: 'opened', headerName: 'Opened', type: 'text' }], j.messages.map((m) => ({ day: m.day, step: m.step, channel: m.channel, sent: m.sent, opened: m.opened === null ? 'Not tracked' : m.opened ? (m.clicked ? 'Opened, clicked' : 'Opened') : 'Not opened' }))),
              moduleTable(spec, `${j.name}’s touch points`, ctx.runId, 'onboarding.journey.touches', [{ field: 'touch', headerName: 'Touch point', type: 'text' }, { field: 'due', headerName: 'Due', type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }, { field: 'checklist', headerName: 'Checklist', type: 'text' }, { field: 'note', headerName: 'Note', type: 'text' }], j.touches.map((t) => ({ touch: t.touch, due: t.due, status: t.doneOn ? `Done ${t.doneOn}` : t.status, checklist: t.checklist ? [t.checklist.debitCard && 'card', t.checklist.onlineBanking && 'online', t.checklist.mobileApp && 'mobile', t.checklist.estatements && 'e-statements', t.checklist.billPay && 'bill pay', t.checklist.directDeposit && 'direct deposit', t.checklist.perksReviewed && 'perks', t.checklist.loansDiscussed, t.checklist.referralMade && 'referral'].filter(Boolean).join(', ') : '', note: t.note ?? '' }))),
            ],
          };
        },
      },
      {
        name: 'onb_funnel',
        description: 'The first 90 days by branch, for members who joined in the last 90: welcome call made, digital banking, direct deposit, debit card activated, two or more products, and closed early; and how many journey messages were opened.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const f = await onboarding.funnel(ctx);
          if (!f.branches.length) return { text: 'No one has joined in the last 90 days.' };
          const total = f.branches.reduce((s, b) => s + b.members, 0);
          const weakest = [...f.branches].sort((a, b) => a.directDepositPct - b.directDepositPct)[0]!;
          return {
            text: `**${total} new members** joined in the last 90 days. ${weakest.branch} has the lowest direct deposit take-up, ${weakest.directDepositPct}%. ${f.branches.reduce((s, b) => s + b.closedEarly, 0)} closed within 90 days of joining. ${f.openRatePct}% of journey messages were opened.`,
            blocks: [moduleTable(spec, 'First 90 days, by branch', ctx.runId, 'onboarding.funnel', [{ field: 'branch', headerName: 'Branch', type: 'text' }, { field: 'members', headerName: 'New members', type: 'count' }, { field: 'welcomed', headerName: 'Welcome call', type: 'text' }, { field: 'digital', headerName: 'Digital banking', type: 'text' }, { field: 'dd', headerName: 'Direct deposit', type: 'text' }, { field: 'card', headerName: 'Debit card active', type: 'text' }, { field: 'two', headerName: '2+ products', type: 'text' }, { field: 'early', headerName: 'Closed early', type: 'count' }], f.branches.map((b) => ({ branch: b.branch, members: b.members, welcomed: `${b.welcomedPct}%`, digital: `${b.digitalPct}%`, dd: `${b.directDepositPct}%`, card: `${b.debitCardPct}%`, two: `${b.twoProductsPct}%`, early: b.closedEarly })))],
          };
        },
      },
      {
        name: 'onb_tasks_list',
        description: 'Open touch points due now or within a week, longest overdue first, with a talking point for each. Covers the user’s own, or their branch if they lead one.',
        input: z.object({ overdue_only: z.boolean().default(false) }).strict(),
        run: async (a: { overdue_only: boolean }, ctx) => {
          need(ctx);
          const f = await onboarding.list({ employeeId: reach(ctx), overdueOnly: a.overdue_only }, ctx);
          if (!f.count) return { text: a.overdue_only ? 'No touch points are overdue.' : 'Nothing is due in the next week.' };
          const missed = !f.missed ? '' : f.missed === f.overdue ? `${f.overdue === 1 ? 'It’s' : 'All are'} past the 7-day mark, so ${f.overdue === 1 ? 'it counts' : 'they count'} as missed. ` : `${f.missed} of the overdue ${f.missed === 1 ? 'is' : 'are'} past the 7-day mark and counted as missed. `;
          const first = f.items[0]!;
          return { text: `**${f.count} ${f.count === 1 ? 'touch point' : 'touch points'}** ${a.overdue_only ? (f.count === 1 ? 'is overdue' : 'are overdue') : `to work, ${f.overdue} overdue`}. ${missed}Start with **${first.member}**, ${first.touch.toLowerCase()}. ${talkingPoint(first)}`, blocks: [list(ctx, a.overdue_only ? 'Overdue touch points' : 'Touch points', f.items, f.asOf)], suggestions: [`Mark the ${first.member} ${first.touch.toLowerCase()} done`] };
        },
      },
      {
        name: 'onb_no_direct_deposit',
        description: 'New members past 30 days with no active direct deposit, within the user’s purview.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const f = await onboarding.noDirectDeposit(ctx);
          if (!f.items.length) return { text: 'Every new member past 30 days has direct deposit set up.' };
          return { text: `**${f.items.length} new ${f.items.length === 1 ? 'member hasn’t' : 'members haven’t'}** set up direct deposit after 30 days, as of the last build.`, blocks: [list(ctx, 'No direct deposit', f.items, f.asOf)] };
        },
      },
      {
        name: 'onb_task_done',
        description: 'Prepare marking someone’s next open touch point done, with a note. Returns approval_required.',
        input: z.object({ member: z.string().min(2).max(80), note: z.string().max(200).optional() }).strict(),
        run: async (a: { member: string; note?: string }, ctx) => {
          need(ctx);
          const t = await onboarding.next(a.member, ctx);
          // The interview checklist, from the person's own words: what was set up, discussed and referred.
          const list = checklistFrom(a.note);
          const ticked = list ? [list.debitCard && 'debit card activated', list.onlineBanking && 'online banking', list.mobileApp && 'mobile app', list.estatements && 'e-statements', list.billPay && 'bill pay', list.directDeposit && 'direct deposit', list.perksReviewed && 'perks reviewed', list.loansDiscussed && `discussed ${list.loansDiscussed}`, list.referralMade && 'referral made'].filter(Boolean).join(', ') : '';
          return { change: { summary: `Mark ${t.member}’s ${t.touch.toLowerCase()} done`, changes: [{ label: `${t.member}, ${t.touch}`, before: t.state, after: 'Done' }, ...(a.note ? [{ label: 'Note', before: '—', after: a.note }] : []), ...(ticked ? [{ label: 'Checklist', before: '—', after: ticked }] : [])], text: `I’ve prepared **${t.member}**’s ${t.touch.toLowerCase()} as done${ticked ? `, with the checklist: ${ticked}` : ''}.`, done: `Marked **${t.member}**’s ${t.touch.toLowerCase()} done.`, risk: 'low', apply: { taskId: t.taskId, note: a.note ?? null, checklist: list } } };
        },
        apply: async (p: { taskId: number; note: string | null; checklist?: OnbChecklist | null }, _meta, ctx) => onboarding.complete(p.taskId, p.note, p.checklist ?? null, ctx.user.name),
      },
      {
        name: 'onb_task_snooze',
        description: 'Prepare moving someone’s next open touch point back by some days. Returns approval_required.',
        input: z.object({ member: z.string().min(2).max(80), days: z.number().int().min(1).max(30) }).strict(),
        run: async (a: { member: string; days: number }, ctx) => {
          need(ctx);
          const t = await onboarding.next(a.member, ctx);
          return { change: { summary: `Snooze ${t.member}’s ${t.touch.toLowerCase()} by ${a.days} ${a.days === 1 ? 'day' : 'days'}`, changes: [{ label: `${t.member}, ${t.touch}`, before: `Due ${t.due}`, after: `${a.days} ${a.days === 1 ? 'day' : 'days'} later` }], text: `I’ve prepared the snooze for **${t.member}**.`, done: `Snoozed **${t.member}**’s ${t.touch.toLowerCase()}.`, risk: 'low', apply: { taskId: t.taskId, days: a.days } } };
        },
        apply: async (p: { taskId: number; days: number }) => onboarding.snooze(p.taskId, p.days),
      },
      {
        name: 'onb_task_reassign',
        description: 'Prepare giving someone’s next open touch point to a colleague at the same branch. Returns approval_required.',
        input: z.object({ member: z.string().min(2).max(80), to: z.string().min(2).max(80) }).strict(),
        run: async (a: { member: string; to: string }, ctx) => {
          need(ctx);
          const t = await onboarding.next(a.member, ctx);
          const person = await onboarding.colleague(a.to, t.branch);
          return { change: { summary: `Give ${t.member}’s ${t.touch.toLowerCase()} to ${person.name}`, changes: [{ label: `${t.member}, ${t.touch}`, before: t.assignee ?? 'Branch queue', after: person.name }], text: `I’ve prepared moving **${t.member}**’s touch point to ${person.name}.`, done: `**${person.name}** now has ${t.member}’s ${t.touch.toLowerCase()}.`, risk: 'medium', apply: { taskId: t.taskId, employeeId: person.employeeId }, notify: [{ employeeId: person.employeeId, title: 'A touch point for you', detail: `${t.member}: ${t.touch}`, link: '/home' }] } };
        },
        apply: async (p: { taskId: number; employeeId: number }) => onboarding.reassign(p.taskId, p.employeeId),
      },
    ],
  };
  return spec;
}
