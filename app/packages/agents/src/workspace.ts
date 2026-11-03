// Calendar (spec 8.14) and Files (8.15) on the shared agent. DI answers from the same records the
// pages show. Adding, moving or cancelling an event, and saving, moving or deleting a file, each wait
// on a card. Dates and times are read from the person's words in code, never by the model, and the
// card reads the result back. Your own calendar and My Files are low risk; involving a colleague or a
// shared folder is medium.
import { z } from 'zod';
import { CoreError, FILE_FOLDERS, MY_FILES, clock, findFiles, folderNamed, foldersFor, type CalendarEvent, type CalendarStore, type FileStore, type LibraryFile, type Meeting } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/’/g, "'");

// ---- dates and times ----------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH = `(${MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join('|')})\\.?`;
const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, half: 0.5 };
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

export interface When {
  date?: string;
  time?: string;
  minutes?: number;
  /** The words left once the day, time and length are taken out. */
  rest: string;
}

/**
 * The day, time and length in someone's words, relative to today. "Next Tuesday" is the first
 * Tuesday after today. A bare hour reads as working hours: 8 to 11 in the morning, 12 to 7 after noon.
 */
export function parseWhen(text: string, today: string): When {
  let rest = ` ${text.replace(/’/g, "'")} `;
  const take = (re: RegExp) => {
    const m = re.exec(rest);
    if (m) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return m;
  };
  const out: When = { rest: '' };
  const dated = (y: number, month: number, day: number) => {
    const d = `${y}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || iso(Date.parse(`${d}T00:00:00Z`)) !== d ? undefined : d;
  };
  const inYear = (month: number, day: number) => {
    const y = Number(today.slice(0, 4));
    const d = dated(y, month, day);
    return d && d < today ? dated(y + 1, month, day) : d;
  };
  const monthOf = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3)));
  let m: RegExpExecArray | null;
  if ((m = take(/\b(?:on )?(\d{4})-(\d{2})-(\d{2})\b/i))) out.date = dated(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  else if ((m = take(new RegExp(`\\b(?:on )?(?:(?:${DAYS.join('|')}),? )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH}\\b`, 'i')))) out.date = inYear(monthOf(m[2]!), Number(m[1]));
  else if ((m = take(new RegExp(`\\b(?:on )?(?:(?:${DAYS.join('|')}),? )?${MONTH} (\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i')))) out.date = inYear(monthOf(m[1]!), Number(m[2]));
  else if (take(/\b(?:the )?day after tomorrow\b/i)) out.date = plusDays(today, 2);
  else if (take(/\btomorrow\b/i)) out.date = plusDays(today, 1);
  else if (take(/\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i)) out.date = today;
  else if ((m = take(new RegExp(`\\b(?:(next|this|coming|on) )?(${DAYS.join('|')})\\b`, 'i')))) {
    const ahead = (DAYS.indexOf(m[2]!.toLowerCase()) - weekday(today) + 7) % 7 || 7;
    out.date = plusDays(today, ahead);
  } else if ((m = take(/\bin (\d+|an?|one|two|three|four|five|six|seven) (day|week)s?\b/i))) out.date = plusDays(today, (Number(m[1]) || NUMBERS[m[1]!.toLowerCase()]!) * (m[2]!.toLowerCase() === 'week' ? 7 : 1));
  if ((m = take(/\b(?:at |from |@ ?)?(\d{1,2})(?::(\d{2}))? ?([ap])\.?m\.?(?=\W)/i))) {
    const h = Number(m[1]) % 12 + (m[3]!.toLowerCase() === 'p' ? 12 : 0);
    if (Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2] ?? 0) < 60) out.time = hhmm(h, Number(m[2] ?? 0));
  } else if (take(/\b(?:at )?(?:noon|midday)\b/i)) out.time = '12:00';
  else if ((m = take(/\b(?:at|from|@) ?(\d{1,2})(?::(\d{2}))?(?: o'clock)?(?! ?(?:days?|weeks?|hours?|hrs?|minutes?|mins?|%))\b/i))) {
    const n = Number(m[1]);
    const h = n >= 1 && n <= 7 ? n + 12 : n;
    if (h <= 23 && Number(m[2] ?? 0) < 60) out.time = hhmm(h, Number(m[2] ?? 0));
  }
  if ((m = take(/\bfor (\d+) ?(?:minutes?|mins?)\b/i))) out.minutes = Number(m[1]);
  else if ((m = take(/\bfor (an?|one|two|three|\d+(?:\.\d+)?) ?(?:hours?|hrs?)\b/i))) out.minutes = Math.round((Number(m[1]) || NUMBERS[m[1]!.toLowerCase()]!) * 60);
  else if (take(/\bfor half an hour\b/i)) out.minutes = 30;
  out.rest = rest.replace(/\s+/g, ' ').trim();
  return out;
}

/** "Tuesday 3 November at 2 pm", with the year only when it isn't this year's. */
export function spokenWhen(startsAt: string, today: string) {
  const [d, t] = [startsAt.slice(0, 10), startsAt.slice(11, 16)];
  const [y, mo, day] = d.split('-').map(Number) as [number, number, number];
  const name = DAYS[weekday(d)]!;
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${day} ${MONTHS[mo - 1]![0]!.toUpperCase()}${MONTHS[mo - 1]!.slice(1)}${String(y) === today.slice(0, 4) ? '' : ` ${y}`}${t ? ` at ${clock(t)}` : ''}`;
}

const addMinutes = (startsAt: string, n: number) => new Date(Date.parse(`${startsAt.replace(' ', 'T')}:00Z`) + n * 60_000).toISOString().slice(0, 16).replace('T', ' ');
const minutesBetween = (a: string, b: string) => Math.round((Date.parse(`${b.replace(' ', 'T')}:00Z`) - Date.parse(`${a.replace(' ', 'T')}:00Z`)) / 60_000);
const length = (n: number) => (n % 60 === 0 ? `${n / 60} ${n === 60 ? 'hour' : 'hours'}` : n > 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} minutes`);
const sentence = (t: string) => `${t[0]!.toUpperCase()}${t.slice(1)}`;

/** "a follow-up with Suzanne Jackson next Tuesday at 2 pm about the HELOC referral", as tool arguments. */
function eventDraft(words: string) {
  const body = words.replace(/\b(?:in|on|to|into) (?:my|the) calendar\b|\bfor me\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const about = /\b(?:about|regarding|re:|to (?:discuss|review|go over|talk about))\s+(?:the |her |his |their |our |my )?(.+)$/i.exec(body);
  // The day and time come out first, so "with Ana Ruiz Tuesday" doesn't read Tuesday as a name.
  const before = parseWhen(about ? body.slice(0, about.index) : body, '2000-01-01').rest;
  const who = /\bwith ((?:[A-Z][\w'.-]*)(?: [A-Z][\w'.-]*){0,2})/.exec(before);
  const kind = (who ? before.slice(0, who.index) : before).replace(/^(?:an?|the|my|our)\s+/i, '').trim() || 'Meeting';
  const about2 = about ? parseWhen(about[1]!, '2000-01-01').rest : '';
  return { title: sentence(who ? `${kind} with ${who[1]}` : kind).slice(0, 160), when: body, ...(who ? { with: who[1]! } : {}), ...(about2 ? { about: about2 } : {}) };
}

// ---- calendar -----------------------------------------------------------------------------------

interface Staff {
  userId: string;
  name: string;
}

export function calendarModule(events: (ctx: ModuleContext) => Promise<{ today: string; items: CalendarEvent[] }>, store: CalendarStore | null, staff: (name: string) => Promise<Staff[]>, today: () => string): ModuleSpec {
  const noAccess = 'The calendar isn’t part of your DI access.';
  const NO_SYNC = 'I can’t sync with Outlook or Google Calendar: external calendar sync isn’t built. I can add, move or cancel events on your DI calendar.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('calendar')) throw new CoreError('NO_ACCESS', noAccess);
    if (!store) throw new CoreError('INVALID', 'Calendar events aren’t set up in this environment, so I can’t change them. I can show what’s coming up.');
    return store;
  };
  /** A colleague by name, or null for anyone else, such as a member. */
  const colleague = async (name: string | undefined, ctx: ModuleContext) => {
    if (!name || name.toLowerCase() === ctx.user.name.toLowerCase()) return null;
    const all = await staff(name);
    const exact = all.filter((u) => u.name.toLowerCase() === name.toLowerCase());
    const hits = exact.length ? exact : all;
    if (hits.length > 1) throw new CoreError('INVALID', `More than one colleague is called ${name}: ${hits.slice(0, 4).map((h) => h.name).join(', ')}. Which one?`);
    return hits[0]?.userId === ctx.user.id ? null : (hits[0] ?? null);
  };
  /** The day and time someone gave, read in code. Refuses rather than guessing either. */
  const resolve = (w: When, fallback?: { date: string; time: string }) => {
    const date = w.date ?? fallback?.date;
    const time = w.time ?? fallback?.time;
    if (!date) throw new CoreError('INVALID', 'Which day? I can’t schedule it without one.');
    if (!time) throw new CoreError('INVALID', `What time on ${spokenWhen(date, today())}? I can’t schedule it without one.`);
    if (date < today()) throw new CoreError('INVALID', `${spokenWhen(date, today())} has passed, so I can’t schedule it then.`);
    return `${date} ${time}`;
  };
  const tell = (m: Pick<Meeting, 'withUserId'>, title: string, detail: string) => (m.withUserId ? [{ userId: m.withUserId, title, detail, link: '/calendar' }] : []);
  const spec: ModuleSpec = {
    id: 'calendar',
    prefix: 'cal',
    agent: 'Calendar',
    // Files and reports have their own moves and schedules.
    request: /\bcalendar\b|\bmy schedule\b|\bwhat follow-ups\b|\bwhat'?s (due|coming up)\b|\bwhat’s (due|coming up)\b|^(?!.*\.(pdf|docx?|xlsx?|pptx?|csv|txt|png|jpe?g|gif|webp)\b)(?!.*\b(files?|folder|reports?|every|weekly|monthly|daily)\b).*\b(schedule|book|set up|arrange|move|reschedule|push|cancel|call off)\b.*(\b(follow[- ]?up|meeting|call|visit|appointment|lunch|review|huddle|check[- ]in|one[- ]on[- ]one)\b|\b\d{1,2}(:\d\d)? ?[ap]\.?m\b)/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Calendar', ref: 'table:cal_event' }],
    prompt: ({ tenant, user, title }) => `You are the Calendar agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) is planning their time.

- "What follow-ups do I have this week?", "Show the calendar for the next two weeks": cal_agenda with the number of days.
- "Schedule a follow-up with Suzanne Jackson next Tuesday at 2 pm about the HELOC referral": cal_create. Put the user's own words for the day, time and length in when, exactly as they said them; never work out a date yourself.
- "Move my 3 pm dealer visit to Thursday": cal_move with the user's words for the event and for the new time.
- "Cancel the branch huddle": cal_cancel.
- Syncing with Outlook or Google Calendar isn't built. Say so.`,
    plan: (text) => {
      const t = clean(text);
      if (/\b(sync|connect|link|import|export)\b/i.test(t)) return { say: NO_SYNC };
      const move = /\b(?:move|reschedule|push|shift)\s+(?:back\s+)?(?:my |the |our )?(.+?)\s+(?:to|until|till)\s+(.+)$/i.exec(t);
      if (move) return { tool: 'cal_move', args: { event: move[1]!, to: move[2]! } };
      const cancel = /\b(?:cancel|call off)\s+(?:my |the |our )?(.+?)(?:\s+(?:from|on|in) my calendar)?$/i.exec(t);
      if (cancel) return { tool: 'cal_cancel', args: { event: cancel[1]! } };
      const create = /\b(?:schedule|book|set up|arrange|add|put)\s+(.+)$/i.exec(t);
      if (create) return { tool: 'cal_create', args: eventDraft(create[1]!) };
      return { tool: 'cal_agenda', args: { days: /\btoday\b/i.test(t) ? 1 : /\b(two|2) weeks\b/i.test(t) ? 14 : /\bmonth\b/i.test(t) ? 30 : 7 } };
    },
    tools: [
      {
        name: 'cal_agenda',
        description: 'What’s overdue and what falls in the next number of days: the user’s events, touch points, issue deadlines and maturing certificates, within the user’s purview.',
        input: z.object({ days: z.number().int().min(1).max(45).default(7) }).strict(),
        run: async (a: { days: number }, ctx) => {
          if (!ctx.modules.includes('calendar')) throw new CoreError('NO_ACCESS', noAccess);
          const { today: asOf, items } = await events(ctx);
          const end = plusDays(asOf, a.days);
          const shown = items.filter((e) => e.late || (e.date >= asOf && e.date <= end));
          if (!shown.length) return { text: `Nothing is due in the next ${a.days} days.` };
          const late = shown.filter((e) => e.late).length;
          return { text: `**${shown.length} ${shown.length === 1 ? 'item' : 'items'}** through ${end}${late ? `, ${late} overdue` : ''}. Dates count from the last build, ${asOf}.`, blocks: [moduleTable(spec, 'What’s coming up', ctx.runId, 'calendar.agenda', [{ field: 'date', headerName: 'Date', type: 'text' }, { field: 'kind', headerName: 'Kind', type: 'text' }, { field: 'title', headerName: 'What', type: 'text' }, { field: 'detail', headerName: 'Detail', type: 'text' }, { field: 'state', headerName: 'State', type: 'text' }], shown.slice(0, 25).map((e) => ({ date: e.date, kind: e.kind, title: e.title, detail: e.detail, state: e.late ? 'Overdue' : 'Upcoming' })))] };
        },
      },
      {
        name: 'cal_create',
        description: 'Prepare an event on the user’s calendar. when is the user’s own words for the day, time and length, such as "next Tuesday at 2 pm"; code reads them. Inviting a colleague makes it medium risk. Returns approval_required.',
        input: z.object({ title: z.string().min(3).max(160), when: z.string().min(2).max(200).describe('The user’s words for the day, time and length, unchanged'), with: z.string().max(80).optional().describe('A colleague or member the user named'), about: z.string().max(160).optional().describe('What it is about, such as a referral') }).strict(),
        run: async (a: { title: string; when: string; with?: string; about?: string }, ctx) => {
          need(ctx);
          const w = parseWhen(a.when, today());
          const startsAt = resolve(w);
          const minutes = w.minutes ?? 30;
          const peer = await colleague(a.with, ctx);
          const when = spokenWhen(startsAt, today());
          const withWhom = peer?.name ?? a.with ?? null;
          return {
            change: {
              summary: `Add ${a.title}, ${when}`,
              changes: [{ label: 'Event', before: '—', after: a.title }, { label: 'When', before: '—', after: when }, { label: 'Length', before: '—', after: length(minutes) }, ...(withWhom ? [{ label: 'With', before: '—', after: peer ? `${peer.name}, invited to it` : withWhom }] : []), ...(a.about ? [{ label: 'About', before: '—', after: a.about }] : [])],
              text: `I’ve prepared **${a.title}** on your calendar for **${when}**${peer ? `, with **${peer.name}** invited` : ''}.`,
              done: `Added **${a.title}** to your calendar for ${when}.${peer ? ` ${peer.name} can see it on theirs.` : ''}`,
              risk: peer ? 'medium' : 'low',
              apply: { owner: { userId: ctx.user.id, name: ctx.user.name }, title: a.title, startsAt, endsAt: addMinutes(startsAt, minutes), withWhom, withUserId: peer?.userId ?? null, source: a.about ?? null, link: /\breferral\b/i.test(a.about ?? '') ? '/referrals' : null },
              notify: tell({ withUserId: peer?.userId ?? null }, `${ctx.user.name} invited you: ${a.title}`, when),
            },
          };
        },
        apply: async (p: Parameters<CalendarStore['create']>[0], meta) => store!.create(p, { approvalId: meta.approvalId, on: today() }),
      },
      {
        name: 'cal_move',
        description: 'Prepare moving one of the user’s own events. event is their words for it (it may include its current day or time); to is their words for the new day and/or time. Medium risk when a colleague is invited. Returns approval_required.',
        input: z.object({ event: z.string().min(2).max(160), to: z.string().min(2).max(120) }).strict(),
        run: async (a: { event: string; to: string }, ctx) => {
          const s = need(ctx);
          const which = parseWhen(a.event, today());
          const m = await s.own(ctx.user.id, { text: which.rest, date: which.date, time: which.time, today: today() });
          const to = parseWhen(a.to, today());
          if (!to.date && !to.time) throw new CoreError('INVALID', `When should ${m.title} move to?`);
          const startsAt = resolve(to, { date: m.startsAt.slice(0, 10), time: m.startsAt.slice(11) });
          if (startsAt === m.startsAt) throw new CoreError('INVALID', `${m.title} is already on ${spokenWhen(startsAt, today())}.`);
          const before = spokenWhen(m.startsAt, today());
          const after = spokenWhen(startsAt, today());
          return {
            change: {
              summary: `Move ${m.title} to ${after}`,
              changes: [{ label: m.title, before, after }, ...(m.withWhom ? [{ label: 'With', before: m.withWhom, after: m.withWhom }] : [])],
              text: `I’ve prepared moving **${m.title}** from ${before} to **${after}**${m.withUserId ? `. ${m.withWhom} is invited and will be told` : ''}.`,
              done: `Moved **${m.title}** to ${after}.`,
              risk: m.withUserId ? 'medium' : 'low',
              apply: { eventId: m.eventId, from: m.startsAt, startsAt, endsAt: addMinutes(startsAt, minutesBetween(m.startsAt, m.endsAt)) },
              notify: tell(m, `${ctx.user.name} moved ${m.title}`, after),
            },
          };
        },
        apply: async (p: Parameters<CalendarStore['move']>[0]) => store!.move(p),
      },
      {
        name: 'cal_cancel',
        description: 'Prepare cancelling one of the user’s own events, by their words for it. Medium risk when a colleague is invited. Returns approval_required.',
        input: z.object({ event: z.string().min(2).max(160) }).strict(),
        run: async (a: { event: string }, ctx) => {
          const s = need(ctx);
          const which = parseWhen(a.event, today());
          const m = await s.own(ctx.user.id, { text: which.rest, date: which.date, time: which.time, today: today() });
          const when = spokenWhen(m.startsAt, today());
          return {
            change: {
              summary: `Cancel ${m.title}, ${when}`,
              changes: [{ label: m.title, before: `Scheduled, ${when}`, after: 'Cancelled' }, ...(m.withWhom ? [{ label: 'With', before: m.withWhom, after: m.withWhom }] : [])],
              text: `I’ve prepared cancelling **${m.title}** on ${when}${m.withUserId ? `. ${m.withWhom} is invited and will be told` : ''}.`,
              done: `Cancelled **${m.title}**.`,
              risk: m.withUserId ? 'medium' : 'low',
              apply: { eventId: m.eventId },
              notify: tell(m, `${ctx.user.name} cancelled ${m.title}`, when),
            },
          };
        },
        apply: async (p: { eventId: number }) => store!.cancel(p.eventId),
      },
    ],
  };
  return spec;
}

// ---- files --------------------------------------------------------------------------------------

const EXT = '(?:pdf|docx?|xlsx?|pptx?|csv|txt|png|jpe?g|gif|webp)';

export function filesModule(store: FileStore | null, today: () => string): ModuleSpec {
  const noAccess = 'The File Manager isn’t part of your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('files')) throw new CoreError('NO_ACCESS', noAccess);
    return foldersFor(ctx.modules);
  };
  const writable = (ctx: ModuleContext) => {
    const folders = need(ctx);
    if (!store) throw new CoreError('INVALID', 'Uploads aren’t set up in this environment, so I can’t save, move or delete files. I can find one.');
    return { folders, store };
  };
  /** A folder by name, one this person can see. */
  const destination = (text: string, folders: string[]) => {
    const folder = folderNamed(text);
    if (!folder) throw new CoreError('INVALID', `Which folder? You can use ${folders.join(', ')}.`);
    if (!folders.includes(folder)) throw new CoreError('INVALID', `You can’t put files in ${folder}: it’s for ${FILE_FOLDERS[folder]!.toLowerCase()}. You can use ${folders.join(', ')}.`);
    return folder;
  };
  const row = (f: LibraryFile) => ({ name: f.name, folder: f.folder, owner: f.owner, modified: f.modified, content: f.fileId ? 'Download on the Files page' : 'Sample, no content' });
  const spec: ModuleSpec = {
    id: 'files',
    prefix: 'fil',
    agent: 'Files',
    // Reports have their own folders and saves.
    request: /\bfile manager\b|\bboard packs?\b|\bdealer (agreement|docs?)\b|\bwhich files\b|^(?!.*\breports?\b).*\brecycle bin\b|\bfind the\b.*\b(policy|agreement|minutes|checklist|procedure|file)\b|^(?!.*\breports?\b).*\b(save|move|delete|remove|download|upload|recycle|trash)\b.*(\b(this|the|that|my) file\b|\bfolder\b|\bmy files\b|\.(pdf|docx?|xlsx?|pptx?|csv|txt|png|jpe?g|gif|webp)\b)/i,
    noAccess,
    sources: [{ kind: 'table', label: 'File Manager', ref: 'table:fil_file' }],
    prompt: ({ tenant, user, title }) => `You are the Files agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) is working with documents.

- "Find the dealer agreement for Smith Ford": fil_find.
- "Who can see the Board Packs folder?": fil_access.
- "Save this file to the Lending > Dealer Docs folder": fil_save. It saves the file the user uploaded on the Files page; leave file out unless they named one.
- "Move Westport huddle notes.txt to the Marketing folder": fil_move. "Delete Westport huddle notes.txt": fil_delete, which moves it to the Recycle Bin.
- You can't receive files in chat: the user chooses one on the Files page. Files aren't virus scanned; say so if asked.`,
    plan: (text) => {
      const t = clean(text);
      // A name in quotes is taken whole, so its words never read as a folder.
      const quoted = /[“"]([^”"]+)[”"]/.exec(t)?.[1];
      const plain = t.replace(/[“"][^”"]*[”"]/g, ' ');
      if (/\bsave\b/i.test(t)) {
        const named = quoted ?? new RegExp(`\\bsave\\s+(?:the )?(.+?\\.${EXT})\\b`, 'i').exec(plain)?.[1];
        const into = /\b(?:to|into|in)\s+(?:the )?([^,]+?)(?:\s+folder)?$/i.exec(named && !quoted ? plain.slice(plain.indexOf(named) + named.length) : plain)?.[1];
        return { tool: 'fil_save', args: { folder: into ?? '', ...(named ? { file: named } : {}) } };
      }
      const move = /\bmove\s+(?:the )?(.+?)\s+(?:file\s+)?(?:to|into)\s+(?:the )?(.+?)(?:\s+folder)?$/i.exec(plain);
      if (move) return { tool: 'fil_move', args: { file: quoted ?? move[1]!, folder: move[2]! } };
      const drop = /\b(?:delete|remove|recycle|trash|bin)\s+(?:the )?(.+?)(?:\s+file)?(?:\s+from .+)?$/i.exec(plain);
      if (drop) return { tool: 'fil_delete', args: { file: quoted ?? drop[1]! } };
      if (/\bupload\b/i.test(t)) return { say: 'Choose the file on the Files page. Once it’s uploaded, I’ll prepare a card to save it to a folder. I can’t receive files in chat.' };
      const folder = folderNamed(t);
      if (/\bwho can\b/i.test(t) && folder) return { tool: 'fil_access', args: { folder } };
      return { tool: 'fil_find', args: { query: quoted ?? (t.replace(/^(?:please\s+)?(?:find|show|open|where(?:'s| is))\s+(?:me\s+)?(?:the\s+|my\s+)?/i, '') || t) } };
    },
    tools: [
      {
        name: 'fil_find',
        description: 'Find documents by name, folder or owner, in the folders the user can see: uploads and the sample library.',
        input: z.object({ query: z.string().min(2).max(120) }).strict(),
        run: async (a: { query: string }, ctx) => {
          const folders = need(ctx);
          const hits = store ? await store.find(ctx.user.id, folders, a.query) : findFiles(a.query, folders);
          if (!hits.length) return { text: `I couldn’t find a file matching “${a.query}” in your folders. Files outside your access don’t show.` };
          const uploads = hits.filter((f) => f.fileId).length;
          return { text: `**${hits.length} ${hits.length === 1 ? 'file' : 'files'}** found.${uploads < hits.length ? ` ${uploads ? 'Some are' : hits.length === 1 ? 'It’s a' : 'They’re'} sample${uploads || hits.length === 1 ? '' : 's'} with no content to open.` : ' Download from the Files page.'}`, blocks: [moduleTable(spec, 'Files', ctx.runId, 'files.search', [{ field: 'name', headerName: 'Name', type: 'text' }, { field: 'folder', headerName: 'Folder', type: 'text' }, { field: 'owner', headerName: 'Owner', type: 'text' }, { field: 'modified', headerName: 'Modified', type: 'text' }, { field: 'content', headerName: 'Content', type: 'text' }], hits.map(row))] };
        },
      },
      {
        name: 'fil_access',
        description: 'Who can see a folder.',
        input: z.object({ folder: z.string().min(2).max(60) }).strict(),
        run: async (a: { folder: string }, ctx) => {
          need(ctx);
          const folder = folderNamed(a.folder);
          if (!folder) throw new CoreError('NOT_FOUND', `There’s no folder called ${a.folder}. They are: ${Object.keys(FILE_FOLDERS).join(', ')}.`);
          return { text: `**${folder}**: ${FILE_FOLDERS[folder]}.` };
        },
      },
      {
        name: 'fil_save',
        description: 'Prepare saving the file the user uploaded on the Files page to a folder. My Files is low risk; a shared folder is medium. Returns approval_required.',
        input: z.object({ folder: z.string().max(60).describe('Such as "Lending > Dealer Docs" or "My Files"'), file: z.string().max(200).optional().describe('Only when the user named the file') }).strict(),
        run: async (a: { folder: string; file?: string }, ctx) => {
          const { folders, store: s } = writable(ctx);
          const f = await s.staged(ctx.user.id, a.file);
          const folder = destination(a.folder, folders);
          const shared = folder !== MY_FILES;
          return {
            change: {
              summary: `Save ${f.name} to ${folder}`,
              changes: [{ label: 'File', before: '—', after: `${f.name}, ${f.type}, ${f.sizeKb.toLocaleString('en-US')} KB` }, { label: 'Folder', before: 'Waiting to be saved', after: folder }, { label: 'Who can see it', before: 'Only you', after: FILE_FOLDERS[folder]! }, { label: 'Virus scan', before: '—', after: 'Not available. The file isn’t scanned.' }],
              text: `I’ve prepared saving **${f.name}** to **${folder}**${shared ? `, where ${FILE_FOLDERS[folder]!.toLowerCase()} can see it` : ''}. It hasn’t been virus scanned.`,
              done: `Saved **${f.name}** to ${folder}.`,
              risk: shared ? 'medium' : 'low',
              apply: { fileId: f.fileId, folder },
            },
          };
        },
        apply: async (p: { fileId: number; folder: string }, meta) => store!.save(p, { approvalId: meta.approvalId, on: today() }),
      },
      {
        name: 'fil_move',
        description: 'Prepare moving an uploaded file to another folder the user can see. Returns approval_required.',
        input: z.object({ file: z.string().min(2).max(200), folder: z.string().min(2).max(60) }).strict(),
        run: async (a: { file: string; folder: string }, ctx) => {
          const { folders, store: s } = writable(ctx);
          const f = await s.one(ctx.user.id, folders, a.file);
          const folder = destination(a.folder, folders);
          if (folder === f.folder) throw new CoreError('INVALID', `${f.name} is already in ${folder}.`);
          return {
            change: { summary: `Move ${f.name} to ${folder}`, changes: [{ label: f.name, before: f.folder, after: folder }, { label: 'Who can see it', before: FILE_FOLDERS[f.folder] ?? f.folder, after: FILE_FOLDERS[folder]! }], text: `I’ve prepared moving **${f.name}** from ${f.folder} to **${folder}**.`, done: `Moved **${f.name}** to ${folder}.`, risk: 'medium', apply: { fileId: f.fileId, from: f.folder, to: folder } },
          };
        },
        apply: async (p: { fileId: number; from: string; to: string }) => store!.move(p, { on: today() }),
      },
      {
        name: 'fil_delete',
        description: 'Prepare deleting an uploaded file. It goes to the Recycle Bin; nothing is deleted for good. Returns approval_required.',
        input: z.object({ file: z.string().min(2).max(200) }).strict(),
        run: async (a: { file: string }, ctx) => {
          const { folders, store: s } = writable(ctx);
          const f = await s.one(ctx.user.id, folders, a.file);
          return {
            change: { summary: `Delete ${f.name}`, changes: [{ label: f.name, before: f.folder, after: 'Recycle Bin' }], text: `I’ve prepared moving **${f.name}** from ${f.folder} to the Recycle Bin. It isn’t deleted for good.`, done: `Moved **${f.name}** to the Recycle Bin.`, risk: 'medium', apply: { fileId: f.fileId, from: f.folder } },
          };
        },
        apply: async (p: { fileId: number; from: string }) => store!.recycle(p),
      },
    ],
  };
  return spec;
}
