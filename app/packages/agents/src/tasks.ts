// Tasks and My Time (spec 8.17) on the shared agent. Creating or completing your own task is low
// risk; giving a task to someone else is medium. My Time shows only where the tenant has it
// (FE-TASK-003).
import { z } from 'zod';
import { CoreError, type OperationsService, type TaskService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/’/g, "'");
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function tasksModule(tasks: TaskService, people: OperationsService, today: () => string): ModuleSpec {
  const noAccess = 'Tasks aren’t part of your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('tasks')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const time = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('mytime')) throw new CoreError('NO_ACCESS', 'My Time isn’t turned on for you.');
  };
  const who = (ctx: ModuleContext) => ({ userId: ctx.user.id, name: ctx.user.name, employeeId: ctx.employeeId });
  const due = (t: string) => (/\btomorrow\b/i.test(t) ? plusDays(today(), 1) : /\btoday\b/i.test(t) ? today() : undefined);
  const spec: ModuleSpec = {
    id: 'tasks',
    prefix: 'tsk',
    agent: 'Tasks',
    request: /\bmy tasks\b|\btasks? (for )?(today|this week)\b|\bcreate a task\b|\bmark (the |my )?.+ task (as )?done\b|\blog \d+(\.\d+)? hours?\b|\bmy hours\b|\bhours (this|last) month\b|\bmy time\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Tasks', ref: 'table:tsk_task' }],
    prompt: ({ tenant, user, title }) => `You are the Tasks agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) is managing their work.

- "What are my tasks today?": tsk_list. It includes referrals, touch points and the person's own tasks.
- "Create a task for Maria to call the three Northgate members": tsk_create with owner Maria.
- "Mark the board pack task done: sent to Dana": tsk_complete.
- "Log 2 hours to the Q4 board pack project for today": time_log. "Show my hours this month": time_summary.`,
    plan: (text) => {
      const t = clean(text);
      const log = /\blog (\d+(?:\.\d+)?) hours? (?:to|on|for) (?:the )?(.+?)(?: project)?(?: for today| today| yesterday)?$/i.exec(t);
      if (log) return { tool: 'time_log', args: { hours: Number(log[1]), project: log[2]!.trim(), ...(/\byesterday\b/i.test(t) ? { date: plusDays(today(), -1) } : {}) } };
      if (/\b(my hours|hours (this|last) month|my time)\b/i.test(t)) return { tool: 'time_summary', args: {} };
      const create = /\bcreate a task (?:for ([A-Z][a-z]+(?: [A-Z][a-z]+)?) )?to (.+)$/i.exec(t);
      if (create) return { tool: 'tsk_create', args: { title: create[2]!.replace(/\b(today|tomorrow)$/i, '').trim(), ...(create[1] && !/^me$/i.test(create[1]) ? { owner: create[1] } : {}), ...(due(t) ? { due: due(t) } : {}) } };
      const done = /\bmark (?:the |my )?(.+?) task (?:as )?done(?:[:;—]\s*(.+))?$/i.exec(t);
      if (done) return { tool: 'tsk_complete', args: { task: done[1]!, ...(done[2] ? { note: done[2] } : {}) } };
      return { tool: 'tsk_list', args: {} };
    },
    tools: [
      {
        name: 'tsk_list',
        description: 'Everything open for the user: their own tasks, referrals assigned to them and onboarding touch points, with the source of each.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const m = await tasks.mine(who(ctx), ctx);
          if (!m.items.length) return { text: 'You have nothing open.' };
          return { text: `**${m.items.length} open**${m.late ? `, ${m.late} past due` : ''}: ${m.bySource.map((s) => `${s.count} ${s.source.toLowerCase()}${s.count === 1 ? '' : 's'}`).join(', ')}. Dates count from the last build, ${m.asOf}.`, blocks: [moduleTable(spec, 'My tasks', ctx.runId, 'task.list', [{ field: 'title', headerName: 'Task', type: 'text' }, { field: 'source', headerName: 'Source', type: 'text' }, { field: 'due', headerName: 'Due', type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }], m.items.slice(0, 30).map((i) => ({ title: i.title, source: i.source, due: i.due ?? '—', status: i.due && i.due < m.asOf ? 'Past due' : i.status })))] };
        },
      },
      {
        name: 'tsk_create',
        description: 'Prepare a task for the user, or for a colleague by name. Your own is low risk; someone else’s is medium. Returns approval_required.',
        input: z.object({ title: z.string().min(3).max(160), owner: z.string().max(80).optional(), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), notes: z.string().max(500).optional() }).strict(),
        run: async (a: { title: string; owner?: string; due?: string; notes?: string }, ctx) => {
          need(ctx);
          const owner = a.owner ? await people.user(a.owner) : null;
          const mine = !owner || owner.userId === ctx.user.id;
          const ownerName = mine ? ctx.user.name : owner!.name;
          return { change: { summary: mine ? `Add a task: ${a.title}` : `Give ${ownerName} a task: ${a.title}`, changes: [{ label: 'Task', before: '—', after: a.title }, { label: 'For', before: '—', after: ownerName }, { label: 'Due', before: '—', after: a.due ?? 'No date' }], text: `I’ve prepared the task${mine ? '' : ` for **${ownerName}**`}.`, done: `Added the task${mine ? '' : ` for **${ownerName}**`}: ${a.title}.`, risk: mine ? 'low' : 'medium', apply: { title: a.title, notes: a.notes ?? null, owner: { userId: mine ? ctx.user.id : owner!.userId, name: ownerName }, due: a.due ?? null } } };
        },
        apply: async (p: Parameters<TaskService['create']>[0], meta, ctx) => tasks.create(p, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }),
      },
      {
        name: 'tsk_complete',
        description: 'Prepare marking one of the user’s own open tasks done, with a note. Returns approval_required.',
        input: z.object({ task: z.string().min(3).max(160), note: z.string().max(300).optional() }).strict(),
        run: async (a: { task: string; note?: string }, ctx) => {
          need(ctx);
          const t = await tasks.own(who(ctx), a.task);
          return { change: { summary: `Mark “${t.title}” done`, changes: [{ label: t.title, before: 'Open', after: 'Done' }, ...(a.note ? [{ label: 'Note', before: '—', after: a.note }] : [])], text: `I’ve prepared marking **${t.title}** done.`, done: `Marked **${t.title}** done.`, risk: 'low', apply: { taskId: t.taskId, note: a.note ?? null } } };
        },
        apply: async (p: { taskId: number; note: string | null }) => tasks.complete(p.taskId, p.note),
      },
      {
        name: 'time_log',
        description: 'Prepare logging hours to a project for a day (today unless given). Returns approval_required.',
        input: z.object({ hours: z.number().min(0.25).max(16), project: z.string().min(2).max(80), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(200).optional() }).strict(),
        run: async (a: { hours: number; project: string; date?: string; note?: string }, ctx) => {
          need(ctx);
          time(ctx);
          const known = await tasks.projects(ctx.user.id);
          const project = known.find((p) => p.toLowerCase() === a.project.toLowerCase()) ?? known.find((p) => p.toLowerCase().includes(a.project.toLowerCase()) || a.project.toLowerCase().includes(p.toLowerCase())) ?? a.project;
          const on = a.date ?? today();
          return { change: { summary: `Log ${a.hours} ${a.hours === 1 ? 'hour' : 'hours'} to ${project} on ${on}`, changes: [{ label: project, before: '—', after: `${a.hours} h on ${on}` }], text: `I’ve prepared ${a.hours} ${a.hours === 1 ? 'hour' : 'hours'} on **${project}**${known.includes(project) ? '' : ', a new project for you'}.`, done: `Logged ${a.hours} ${a.hours === 1 ? 'hour' : 'hours'} to **${project}**.`, risk: 'low', apply: { userId: ctx.user.id, on, hours: a.hours, project, note: a.note ?? null } } };
        },
        apply: async (p: Parameters<TaskService['logTime']>[0], meta) => tasks.logTime(p, meta),
      },
      {
        name: 'time_summary',
        description: 'The user’s hours for the month by project.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          time(ctx);
          const h = await tasks.hours(ctx.user.id);
          if (!h.month) return { text: 'You haven’t logged any time yet.' };
          const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${h.month}-15T00:00:00Z`));
          return { text: `**${h.total} hours** in ${label}${h.byProject[0] ? `, most on ${h.byProject[0].project} (${h.byProject[0].hours})` : ''}.`, blocks: [moduleTable(spec, `My hours, ${label}`, ctx.runId, 'time.summary', [{ field: 'project', headerName: 'Project', type: 'text' }, { field: 'hours', headerName: 'Hours', type: 'number' }], h.byProject)] };
        },
      },
    ],
  };
  return spec;
}
