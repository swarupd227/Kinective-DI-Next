// Referral Desk: DI Referral Manager's extras around the core referral flow. Refer a prospect who
// isn't a member yet, create referrals from an uploaded list, copy colleagues on a referral, change its
// priority, and save named views of the referral list. Making a referral for a member stays with the
// Referral agent; working one (stages, notes, reassigning) with the Inbox agent.
import { z } from 'zod';
import { CoreError, parseReferralCsv, ReferralDeskService, ReferralReportService, type BulkReady, type FileStore, type RefFilters } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const REFERRAL_DESK_REQUEST =
  /\b(?:prospect|non-?member|not (?:yet )?a (?:member|customer)|isn[’']?t a (?:member|customer)(?: yet)?|new member referral)\b[^.?!]*\brefer|\brefer\b[^.?!]*\b(?:prospect|non-?member|not (?:yet )?a (?:member|customer)|isn[’']?t a (?:member|customer))|\b(?:upload|bulk|import)\b[^.?!]*\breferrals?\b|\breferrals? from (?:the |my |this )?(?:file|upload|list|csv|spreadsheet)\b|\b(?:cc|copy)\b[^.?!]*\b(?:on|in)\b[^.?!]*\breferral\s*#?\d+|\breferral\s*#?\d+\b[^.?!]*\b(?:cc|copy)\b|\b(?:priority|urgent)\b[^.?!]*\breferral\s*#?\d+|\breferral\s*#?\d+\b[^.?!]*\bpriority\b|\b(?:saved?|my) referral views?\b|\breferral (?:list )?views?\b|\bsave\b[^.?!]*\breferrals?\b[^.?!]*\bview\b|\bview of [^.?!]*\breferrals\b/i;

const NO_ACCESS = 'The Referral Desk isn’t part of your DI access.';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;

export function referralDeskPlan(t: string) {
  const s = t.toLowerCase();
  const id = /referral\s*#?(\d+)/i.exec(t)?.[1];
  if (/\b(?:upload|bulk|import)\b|\breferrals? from (?:the |my |this )?(?:file|upload|list|csv|spreadsheet)\b/.test(s)) return { tool: 'refd_bulk', args: { file: /\b([\w.-]+\.csv)\b/i.exec(t)?.[1] ?? '' } };
  if (id && /\b(?:cc|copy)\b/.test(s)) {
    const names = /\b(?:cc|copy)\s+(.+?)\s+(?:on|in)\b/i.exec(t)?.[1] ?? '';
    return { tool: 'refd_cc', args: { referral_id: Number(id), people: names.split(/\s*(?:,|\band\b)\s*/).filter(Boolean) } };
  }
  if (id && /\bpriority|urgent\b/.test(s)) {
    const p = PRIORITIES.find((x) => s.includes(x.toLowerCase())) ?? 'High';
    return { tool: 'refd_priority', args: { referral_id: Number(id), priority: p } };
  }
  if (/\bsave\b[^.?!]*\bview\b/.test(s)) {
    const name = /\bview (?:called|named|as)\s+["“]?([^"”]+?)["”]?$/i.exec(t)?.[1] ?? 'My view';
    const f: Record<string, unknown> = {};
    const type = /\b(heloc|auto loan|mortgage|credit card|certificate|business account|personal loan|checking|wealth)\b/i.exec(t)?.[1];
    if (type) f.type = type;
    if (/\bopen\b/.test(s)) f.open = true;
    const branch = /\b(?:at|in|for) ([A-Z][a-z]+)\b/.exec(t)?.[1];
    if (branch) f.branch = branch;
    return { tool: 'refd_view_save', args: { name, filters: f } };
  }
  if (/\bviews?\b/.test(s)) {
    const name = /\b(?:view|show|open|run)\s+(?:my\s+)?(?:saved\s+)?(?:view\s+)?["“]([^"”]+)["”]/i.exec(t)?.[1];
    return name ? { tool: 'refd_view_run', args: { name } } : { tool: 'refd_views', args: {} };
  }
  const name = /\b(?:[Rr]efer|[Rr]eferral for)\s+([A-Z][a-z’'-]+ [A-Z][a-z’'-]+)/.exec(t)?.[1] ?? '';
  const type = /\b(?:for|about)\s+(?:an? )?(heloc|auto loan|mortgage|credit card|certificate|checking(?: account)?|personal loan|business (?:account|loan)|wealth management|insurance|savings)\b/i.exec(t)?.[1] ?? 'checking';
  const branch = /\b(?:at|to) (?:the )?([A-Z][a-z]+)(?: branch)?\b/.exec(t)?.[1] ?? '';
  const phone = /\b(\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4})\b/.exec(t)?.[1];
  const email = /\b([\w.+-]+@[\w-]+\.[\w.]+)\b/.exec(t)?.[1];
  return { tool: 'refd_prospect', args: { name, type, branch, ...(phone ? { phone } : {}), ...(email ? { email } : {}) } };
}

export function referralDeskModule(svc: ReferralDeskService, report: ReferralReportService, files: FileStore | null, person: 'member' | 'customer' = 'member'): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('refdesk')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const sources: ModuleSpec['sources'] = [{ kind: 'table', label: 'Referrals', ref: 'table:esp_com_items' }];
  const listTable = (spec: ModuleSpec, title: string, runId: string, items: Awaited<ReturnType<ReferralReportService['list']>>['items']) =>
    moduleTable(spec, title, runId, 'referral.desk.view', [text('id', 'Referral'), text('created', 'Made'), text('type', 'Type'), text('member', person === 'member' ? 'Member' : 'Customer'), text('branch', 'Branch'), text('stage', 'Stage'), text('sender', 'From')], items.slice(0, 200).map((r) => ({ id: `#${r.comId}`, created: r.created, type: r.type, member: r.member, branch: r.branch, stage: r.stage, sender: r.sender })));
  const spec: ModuleSpec = {
    id: 'refdesk',
    prefix: 'refd',
    agent: 'Referral Desk',
    request: REFERRAL_DESK_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the Referral Desk agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) handles referrals beyond making one for a ${person}: a referral for a prospect who isn't a ${person} yet, referrals from an uploaded list, copying colleagues, priority, and saved views of the referral list.

- refd_prospect (type, name, phone or email, branch, notes, priority): refers someone who isn't a ${person} yet to the branch's queue for that type. Needs approval.
- refd_bulk (file): checks an uploaded CSV (columns: ${person} or ${person} number, referral type, notes) and creates the referrals that check out, on approval. The file must be uploaded on the Files page first.
- refd_cc (referral_id, people): copies colleagues on a referral; it shows in their "copied to me" inbox. Needs approval.
- refd_priority (referral_id, priority Low, Normal, High or Urgent). Needs approval.
- refd_view_save (name, filters: type, stage, branch, sender, assignee, from, to, open): saves a named view of the referral list. Needs approval.
- refd_views: the user's saved views. refd_view_run (name): runs one.
A referral for an existing ${person} is the Referral agent's; moving a stage, a note or reassigning is the Inbox agent's.`,
    plan: (t) => referralDeskPlan(t),
    tools: [
      {
        name: 'refd_prospect',
        description: `Refer a prospect who isn't a ${person} yet: their name, a phone or email, the referral type and the branch whose queue takes it. Needs approval.`,
        input: z.object({ type: z.string().min(2).max(60), name: z.string().min(3).max(80), phone: z.string().max(30).optional(), email: z.string().max(120).optional(), branch: z.string().min(2).max(40), notes: z.string().max(300).optional(), priority: z.enum(PRIORITIES).optional() }).strict(),
        run: async (a: { type: string; name: string; phone?: string; email?: string; branch: string; notes?: string; priority?: (typeof PRIORITIES)[number] }, ctx) => {
          need(ctx);
          if (!/\s/.test(a.name.trim())) return { text: 'What’s the prospect’s full name?' };
          if (!a.phone && !a.email) return { text: `How can ${a.name} be reached? Give a phone number or an email.` };
          if (!a.branch.trim()) return { text: `Which branch should take ${a.name}’s referral?` };
          const type = await svc.typeNamed(a.type);
          if (!type || type.category === 'Task' || type.typeId === 'retention_follow_up') throw new CoreError('INVALID', `“${a.type}” isn’t a referral type for a prospect.`);
          const b = await svc.branchNamed(a.branch, ctx);
          const q = await svc.queueFor(type.typeId, b.branchId);
          return {
            change: {
              summary: `Refer ${a.name} (prospect) for ${type.label}`,
              changes: [
                { label: 'Prospect', before: '—', after: `${a.name}, not a ${person} yet` },
                { label: 'Contact', before: '—', after: [a.phone, a.email].filter(Boolean).join(', ') },
                { label: 'Referral', before: '—', after: `${type.label} · ${a.priority ?? 'Normal'} priority` },
                { label: 'Goes to', before: '—', after: q.name },
                ...(a.notes ? [{ label: 'Note', before: '—', after: a.notes }] : []),
              ],
              text: `I’ve prepared a **${type.label}** referral for **${a.name}**, who isn’t a ${person} yet. It goes to **${q.name}** once you approve.`,
              done: `Referred ${a.name} (prospect) for ${type.label}; it’s in ${q.name}.`,
              risk: 'medium',
              apply: { typeId: type.typeId, name: a.name, phone: a.phone, email: a.email, branch: b.name, branchId: b.branchId, queueId: q.queueId, notes: a.notes, priority: a.priority },
            },
          };
        },
        apply: async (p: Parameters<ReferralDeskService['prospect']>[0], meta, ctx) => {
          await svc.prospect(p, { approvalId: meta.approvalId, userId: ctx.user.id, userName: ctx.user.name, employeeId: ctx.employeeId, runId: ctx.runId });
        },
      },
      {
        name: 'refd_bulk',
        description: `Create referrals from an uploaded CSV: checks each row's ${person} (number or unique name) and type, says which rows won't load and why, and creates the rest on approval.`,
        input: z.object({ file: z.string().max(120) }).strict(),
        run: async (a: { file: string }, ctx) => {
          need(ctx);
          if (!files) return { text: 'Uploads aren’t set up for this institution.' };
          const staged = await files.stagedContent(ctx.user.id, a.file || undefined).catch((e: unknown) => {
            throw e instanceof CoreError ? e : new CoreError('NOT_FOUND', 'Upload the referral list on the Files page first.');
          });
          if (!/\.csv$/i.test(staged.name)) return { text: `${staged.name} isn’t a CSV. Save the list as CSV with a ${person} column, a referral type column and an optional notes column.` };
          const parsed = parseReferralCsv(staged.body.toString('utf8'));
          if (!parsed.rows.length) return { text: parsed.problems.join(' ') };
          const x = await svc.checkBulk(parsed.rows, ctx);
          const problems = [...parsed.problems.map((p) => ({ line: 0, problem: p })), ...x.problems];
          const problemTable = problems.length ? [moduleTable(spec, 'Rows that won’t load', ctx.runId, 'referral.desk.bulk.problems', [text('line', 'Row'), text('problem', 'Why')], problems.map((p) => ({ line: p.line ? String(p.line) : '—', problem: p.problem })))] : [];
          if (!x.ready.length) return { text: `None of the ${parsed.rows.length} rows in **${staged.name}** can be loaded.`, blocks: problemTable, sources };
          return {
            change: {
              summary: `Create ${x.ready.length} ${x.ready.length === 1 ? 'referral' : 'referrals'} from ${staged.name}`,
              changes: x.ready.slice(0, 20).map((r) => ({ label: `Row ${r.line}: ${r.name}`.slice(0, 80), before: '—', after: `${r.typeLabel} → ${r.queueName}` })),
              text: `**${staged.name}** has ${parsed.rows.length} rows: **${x.ready.length}** check out${problems.length ? ` and ${problems.length} won’t load (listed below)` : ''}. Each becomes a referral in its queue once you approve.`,
              done: `Created ${x.ready.length} ${x.ready.length === 1 ? 'referral' : 'referrals'} from ${staged.name}.`,
              risk: 'medium',
              apply: { ready: x.ready },
            },
            blocks: problemTable,
          };
        },
        apply: async (p: { ready: BulkReady[] }, meta, ctx) => {
          await svc.createBulk(p.ready, { approvalId: meta.approvalId, userId: ctx.user.id, userName: ctx.user.name, employeeId: ctx.employeeId, runId: ctx.runId });
        },
      },
      {
        name: 'refd_cc',
        description: 'Copy colleagues on a referral, by name. It then shows in their "copied to me" inbox. Needs approval.',
        input: z.object({ referral_id: z.number().int().positive(), people: z.array(z.string().min(2).max(80)).min(1).max(5) }).strict(),
        run: async (a: { referral_id: number; people: string[] }, ctx) => {
          need(ctx);
          const r = await svc.referral(a.referral_id, ctx);
          const who = await svc.employees(a.people);
          const all = [...new Set([...r.cc, ...who.map((w) => w.employeeId)])];
          return {
            change: {
              summary: `Copy ${who.map((w) => w.name).join(', ')} on referral #${r.comId}`,
              changes: [{ label: `#${r.comId} ${r.typeLabel}, ${r.who}`.slice(0, 80), before: r.cc.length ? `${r.cc.length} copied` : 'No one copied', after: `${all.length} copied` }],
              text: `I’ve prepared copying **${who.map((w) => w.name).join(', ')}** on referral **#${r.comId}** (${r.typeLabel}, ${r.who}).`,
              done: `Copied ${who.map((w) => w.name).join(', ')} on referral #${r.comId}.`,
              risk: 'low',
              apply: { comId: r.comId, employeeIds: all, names: who.map((w) => w.name) },
            },
          };
        },
        apply: async (p: { comId: number; employeeIds: number[]; names: string[] }, _meta, ctx) => {
          await svc.setCc(p.comId, p.employeeIds, { userId: ctx.user.id, userName: ctx.user.name }, p.names);
        },
      },
      {
        name: 'refd_priority',
        description: 'Change a referral’s priority (Low, Normal, High, Urgent), which sets when it’s due. Needs approval.',
        input: z.object({ referral_id: z.number().int().positive(), priority: z.enum(PRIORITIES) }).strict(),
        run: async (a: { referral_id: number; priority: (typeof PRIORITIES)[number] }, ctx) => {
          need(ctx);
          const r = await svc.referral(a.referral_id, ctx);
          if (!r.open) return { text: `Referral #${r.comId} is closed as ${r.stage}; its priority no longer matters.` };
          if (r.priority === a.priority) return { text: `Referral #${r.comId} is already ${a.priority} priority.` };
          return {
            change: {
              summary: `Make referral #${r.comId} ${a.priority} priority`,
              changes: [{ label: `#${r.comId} ${r.typeLabel}, ${r.who}`.slice(0, 80), before: r.priority, after: a.priority }],
              text: `I’ve prepared changing referral **#${r.comId}** from ${r.priority} to **${a.priority}** priority.`,
              done: `Referral #${r.comId} is now ${a.priority} priority.`,
              risk: 'low',
              apply: { comId: r.comId, priority: a.priority, from: r.priority },
            },
          };
        },
        apply: async (p: { comId: number; priority: string; from: string }, _meta, ctx) => {
          await svc.setPriority(p.comId, p.priority, { userId: ctx.user.id, userName: ctx.user.name }, p.from);
        },
      },
      {
        name: 'refd_view_save',
        description: 'Save a named view of the referral list with its filters (type, stage, branch, sender, assignee, from, to, open), for the user. Needs approval.',
        input: z.object({ name: z.string().min(2).max(60), filters: z.object({ type: z.string().max(40).optional(), stage: z.string().max(30).optional(), branch: z.string().max(40).optional(), sender: z.string().max(80).optional(), assignee: z.string().max(80).optional(), from: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional(), to: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional(), open: z.boolean().optional() }).strict() }).strict(),
        run: async (a: { name: string; filters: RefFilters }, ctx) => {
          need(ctx);
          const x = await report.list(a.filters, ctx, 1);
          const desc = Object.entries(a.filters).map(([k, v]) => (k === 'open' ? 'open only' : `${k} ${v}`)).join(', ') || 'all referrals';
          return {
            change: {
              summary: `Save the referral view “${a.name}”`,
              changes: [{ label: a.name, before: '—', after: `${desc}: ${x.total.toLocaleString('en-US')} referrals today` }],
              text: `I’ve prepared saving **${a.name}** (${desc}). Ask for it by name any time; it runs fresh each time.`,
              done: `Saved the view “${a.name}”.`,
              risk: 'low',
              apply: { name: a.name, filters: a.filters },
            },
          };
        },
        apply: async (p: { name: string; filters: RefFilters }, _meta, ctx) => {
          await svc.saveView(ctx.user.id, p.name, p.filters as Record<string, unknown>);
        },
      },
      {
        name: 'refd_views',
        description: 'The user’s saved views of the referral list.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const v = await svc.views(ctx.user.id);
          if (!v.length) return { text: 'You haven’t saved any referral views. Try “Save a view of open HELOC referrals at Westport called Westport HELOCs”.' };
          return {
            text: `You have ${v.length} saved ${v.length === 1 ? 'view' : 'views'}.`,
            blocks: [moduleTable(spec, 'Saved referral views', ctx.runId, 'referral.desk.views', [text('name', 'View'), text('filters', 'Filters')], v.map((x) => ({ name: x.name, filters: Object.entries(x.filters).map(([k, val]) => (k === 'open' ? 'open only' : `${k} ${val}`)).join(', ') || 'All referrals' })))],
            suggestions: v.slice(0, 3).map((x) => `Show my view “${x.name}”`),
          };
        },
      },
      {
        name: 'refd_view_run',
        description: 'Run one of the user’s saved views of the referral list, by name.',
        input: z.object({ name: z.string().min(1).max(60) }).strict(),
        run: async (a: { name: string }, ctx) => {
          need(ctx);
          const v = await svc.view(ctx.user.id, a.name);
          if (!v) return { text: `You have no saved view called “${a.name}”.` };
          const x = await report.list(v.filters as RefFilters, ctx);
          return {
            text: `**${v.name}**: ${x.total.toLocaleString('en-US')} referrals${x.total > x.items.length ? `; the latest ${x.items.length} are below, and the table exports` : ''}.`,
            blocks: [listTable(spec, v.name, ctx.runId, x.items)],
            sources,
          };
        },
      },
    ],
  };
  return spec;
}
