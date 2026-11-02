// Calendar (spec 8.14) and Files (8.15) on the shared agent. Both read only for now: DI answers from
// the same records the pages show, and says so when asked to change something.
import { z } from 'zod';
import { CoreError, FILE_FOLDERS, findFiles, type CalendarEvent } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/’/g, "'");

export function calendarModule(events: (ctx: ModuleContext) => Promise<{ today: string; items: CalendarEvent[] }>): ModuleSpec {
  const noAccess = 'The calendar isn’t part of your DI access.';
  const NOT_YET = 'I can’t create or move calendar events yet. I can show what’s coming up.';
  const spec: ModuleSpec = {
    id: 'calendar',
    prefix: 'cal',
    agent: 'Calendar',
    request: /\bcalendar\b|\bmy schedule\b|\bwhat follow-ups\b|\bwhat'?s (due|coming up)\b|\bwhat’s (due|coming up)\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Dated work', ref: 'table:onb_task' }],
    prompt: ({ tenant, user, title }) => `You are the Calendar agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) is asking what's coming up.

- "What follow-ups do I have this week?", "Show the calendar for the next two weeks": cal_agenda with the number of days.
- Creating or moving events isn't available yet. Say so.`,
    plan: (text) => {
      const t = clean(text);
      if (/\b(schedule|book|create|move|cancel|sync)\b/i.test(t)) return { say: NOT_YET };
      return { tool: 'cal_agenda', args: { days: /\btoday\b/i.test(t) ? 1 : /\b(two|2) weeks\b/i.test(t) ? 14 : /\bmonth\b/i.test(t) ? 30 : 7 } };
    },
    tools: [
      {
        name: 'cal_agenda',
        description: 'What’s overdue and what falls in the next number of days: touch points, issue deadlines and maturing certificates, within the user’s purview.',
        input: z.object({ days: z.number().int().min(1).max(45).default(7) }).strict(),
        run: async (a: { days: number }, ctx) => {
          if (!ctx.modules.includes('calendar')) throw new CoreError('NO_ACCESS', noAccess);
          const { today, items } = await events(ctx);
          const end = new Date(Date.parse(`${today}T00:00:00Z`) + a.days * 86_400_000).toISOString().slice(0, 10);
          const shown = items.filter((e) => e.late || (e.date >= today && e.date <= end));
          if (!shown.length) return { text: `Nothing is due in the next ${a.days} days.` };
          const late = shown.filter((e) => e.late).length;
          return { text: `**${shown.length} ${shown.length === 1 ? 'item' : 'items'}** through ${end}${late ? `, ${late} overdue` : ''}. Dates count from the last build, ${today}.`, blocks: [moduleTable(spec, 'What’s coming up', ctx.runId, 'calendar.agenda', [{ field: 'date', headerName: 'Date', type: 'text' }, { field: 'kind', headerName: 'Kind', type: 'text' }, { field: 'title', headerName: 'What', type: 'text' }, { field: 'detail', headerName: 'Detail', type: 'text' }, { field: 'state', headerName: 'State', type: 'text' }], shown.slice(0, 25).map((e) => ({ date: e.date, kind: e.kind, title: e.title, detail: e.detail, state: e.late ? 'Overdue' : 'Upcoming' })))] };
        },
      },
    ],
  };
  return spec;
}

export function filesModule(): ModuleSpec {
  const noAccess = 'The File Manager isn’t part of your DI access.';
  const NOT_YET = 'I can’t upload, move or delete files yet. I can find one, or tell you who can see a folder.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('files')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const folderIn = (t: string) => Object.keys(FILE_FOLDERS).find((f) => t.toLowerCase().includes((f.split('/').at(-1) ?? f).toLowerCase()));
  const spec: ModuleSpec = {
    id: 'files',
    prefix: 'fil',
    agent: 'Files',
    request: /\bfile manager\b|\bboard packs?\b|\bdealer (agreement|docs?)\b|\bwhich files\b|\bfind the\b.*\b(policy|agreement|minutes|checklist|procedure|file)\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'File Manager', ref: 'table:esp_files' }],
    prompt: ({ tenant, user, title }) => `You are the Files agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) is looking for a document.

- "Find the dealer agreement for Smith Ford": fil_find.
- "Who can see the Board Packs folder?": fil_access.
- Uploading, moving and deleting aren't available yet. Say so.`,
    plan: (text) => {
      const t = clean(text);
      if (/\b(upload|save|move|delete|rename|attach)\b/i.test(t)) return { say: NOT_YET };
      const folder = folderIn(t);
      if (/\bwho can\b/i.test(t) && folder) return { tool: 'fil_access', args: { folder } };
      return { tool: 'fil_find', args: { query: t } };
    },
    tools: [
      {
        name: 'fil_find',
        description: 'Find documents by name, folder or owner.',
        input: z.object({ query: z.string().min(2).max(120) }).strict(),
        run: async (a: { query: string }, ctx) => {
          need(ctx);
          const hits = findFiles(a.query);
          if (!hits.length) return { text: `I couldn’t find a file matching “${a.query}”.` };
          return { text: `**${hits.length} ${hits.length === 1 ? 'file' : 'files'}** found.`, blocks: [moduleTable(spec, 'Files', ctx.runId, 'files.search', [{ field: 'name', headerName: 'Name', type: 'text' }, { field: 'folder', headerName: 'Folder', type: 'text' }, { field: 'owner', headerName: 'Owner', type: 'text' }, { field: 'modified', headerName: 'Modified', type: 'text' }], hits.map(({ name, folder, owner, modified }) => ({ name, folder, owner, modified })))] };
        },
      },
      {
        name: 'fil_access',
        description: 'Who can see a folder.',
        input: z.object({ folder: z.string().min(2).max(60) }).strict(),
        run: async (a: { folder: string }, ctx) => {
          need(ctx);
          const folder = folderIn(a.folder);
          if (!folder) throw new CoreError('NOT_FOUND', `There’s no folder called ${a.folder}. They are: ${Object.keys(FILE_FOLDERS).join(', ')}.`);
          return { text: `**${folder}**: ${FILE_FOLDERS[folder]}.` };
        },
      },
    ],
  };
  return spec;
}
