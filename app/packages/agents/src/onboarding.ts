// Onboarding agent (spec 24.21): today's calls with talking points, what's overdue, and working a
// person's own touch points. Member letters and emails stay in the scheduled process, so this agent
// never sends one.
import { z } from 'zod';
import { CoreError, type OnboardingService, type TouchPoint } from '@dinext/di-core';
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
    request: /\bonboarding\b|\btouch ?points?\b|\bnew members?\b.*\b(direct deposit|calls?)\b|\bwelcome calls?\b/i,
    noAccess: 'Onboarding isn’t part of your DI access.',
    sources: [{ kind: 'table', label: 'Onboarding tasks', ref: 'table:onb_task' }],
    prompt: ({ tenant, user, title }) => `You are the Onboarding agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) works new members' touch points.

- "What onboarding calls do I have today?": onb_tasks_list. "Which touch points are overdue?": onb_tasks_list with overdue_only.
- "Which new members haven't set up direct deposit after 30 days?": onb_no_direct_deposit.
- "Mark the Jackson 14-day call done; she set up direct deposit": onb_task_done with their words as note.
- onb_task_snooze and onb_task_reassign change a task.
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
      return { tool: 'onb_tasks_list', args: { overdue_only: /\boverdue\b|\blate\b|\bmissed\b/i.test(t) } };
    },
    tools: [
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
          return { change: { summary: `Mark ${t.member}’s ${t.touch.toLowerCase()} done`, changes: [{ label: `${t.member}, ${t.touch}`, before: t.state, after: 'Done' }, ...(a.note ? [{ label: 'Note', before: '—', after: a.note }] : [])], text: `I’ve prepared **${t.member}**’s ${t.touch.toLowerCase()} as done.`, done: `Marked **${t.member}**’s ${t.touch.toLowerCase()} done.`, risk: 'low', apply: { taskId: t.taskId, note: a.note ?? null } } };
        },
        apply: async (p: { taskId: number; note: string | null }) => onboarding.complete(p.taskId, p.note),
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
