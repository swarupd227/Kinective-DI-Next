// Data Logs agent (spec 14.11): manual entries with a controlled lifecycle. Entered, Submitted, then
// Approved or Returned, every step in the history. Nobody approves their own, a return needs a note,
// and a financial log is high risk with its number typed (FE-DLOG-004).
import { z } from 'zod';
import { CoreError, usd, type DataLog, type DataLogService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const need = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('datalogs')) throw new CoreError('NO_ACCESS', 'Data Logs aren’t part of your DI access.');
};
const mine = (ctx: ModuleContext) => [ctx.user.id, ...(ctx.employeeId !== undefined ? [`emp:${ctx.employeeId}`] : [])];
const approver = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('datalogs-approve')) throw new CoreError('NO_ACCESS', 'Approving data logs isn’t part of your access.');
};
const describe = (l: DataLog) => `#${l.logId} ${l.title}${l.amount !== null ? ` (${usd(l.amount)})` : ''}`;

export function dataLogsModule(logs: DataLogService): ModuleSpec {
  /** The card for approving or returning. A financial log needs its number typed. */
  const decide = async (a: { log_id: number; note?: string }, to: 'Approved' | 'Returned', ctx: ModuleContext) => {
    need(ctx);
    approver(ctx);
    const l = await logs.get(a.log_id, ctx);
    if (l.status !== 'Submitted') throw new CoreError('INVALID', `Log #${l.logId} is ${l.status}, so it can’t be decided.`);
    if (mine(ctx).includes(l.createdBy)) throw new CoreError('NO_ACCESS', 'You entered this log, so someone else has to decide it.');
    if (to === 'Returned' && !a.note?.trim()) throw new CoreError('INVALID', `What should the note on log #${l.logId} say, so ${l.createdName} knows what to fix?`);
    const verb = to === 'Approved' ? 'Approve' : 'Return';
    return {
      change: {
        summary: `${verb} data log ${describe(l)}`,
        changes: [{ label: `${l.branch}, ${l.type}`, before: 'Submitted', after: to }, ...(a.note ? [{ label: 'Note', before: '—', after: a.note }] : [])],
        text: `I’ve prepared your decision on log **${describe(l)}**.`,
        done: to === 'Approved' ? `Approved log **#${l.logId}**. ${l.createdName} will see that.` : `Returned log **#${l.logId}** with your note.`,
        risk: l.financial ? ('high' as const) : ('medium' as const),
        ...(l.financial ? { typed: { prompt: `Type ${l.logId} to ${verb.toLowerCase()} this financial log`, expected: String(l.logId) } } : {}),
        apply: { logId: l.logId, to, note: a.note ?? null },
      },
    };
  };

  const spec: ModuleSpec = {
    id: 'datalogs',
    prefix: 'dlg',
    agent: 'Data Logs',
    request: /\bdata ?logs?\b|\blogs? #?\d{4}\b|\b(cash count|manual) (logs?|adjustment)\b|\bmy (returned|submitted) logs?\b|\bwhy was my log\b/i,
    noAccess: 'Data Logs aren’t part of your DI access.',
    sources: [{ kind: 'table', label: 'Data Logs', ref: 'table:esp_datalog' }],
    prompt: ({ tenant, user, title }) => `You are the Data Logs agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) works manual data entries.

- "Show my returned data logs", "what's waiting for approval?": dlg_logs_list.
- "Why was my log returned?", "history of log 4471": dlg_log_get.
- "Log a cash count adjustment of -$350 for Westport": dlg_log_create. Use a type_id from dlg_log_types.
- "Submit log 4471": dlg_log_submit. "Approve log 4471": dlg_log_approve. "Return log 4471: add the recount sheet": dlg_log_return.`,
    today: async (ctx) => {
      if (!ctx.modules.includes('datalogs-approve')) return null;
      const waiting = (await logs.list({ status: 'Submitted' }, ctx)).items.filter((l) => !mine(ctx).includes(l.createdBy));
      if (!waiting.length) return null;
      const financial = waiting.filter((l) => l.financial).length;
      return { id: 'datalogs', title: `${waiting.length} data ${waiting.length === 1 ? 'log' : 'logs'} to approve`, why: financial ? `${financial} financial.` : 'None financial.', badge: 'To approve', ask: 'Show the data logs waiting for approval', weight: financial ? 100 : 60 };
    },
    plan: (text, ctx) => {
      const t = text.trim().replace(/[.!?]+$/, '');
      const id = Number(/\blog #?(\d{4})\b/i.exec(t)?.[1] ?? NaN);
      if (/\bsubmit\b/i.test(t) && id) return { tool: 'dlg_log_submit', args: { log_id: id } };
      if (/\bapprove\b/i.test(t) && id) return { tool: 'dlg_log_approve', args: { log_id: id } };
      if (/\breturn\b/i.test(t) && id) return { tool: 'dlg_log_return', args: { log_id: id, ...(/[:—]\s*(.+)$/.exec(t)?.[1] ? { note: /[:—]\s*(.+)$/.exec(t)![1] } : {}) } };
      if (id) return { tool: 'dlg_log_get', args: { log_id: id } };
      if (/^\s*log (a|an)\b|\bcreate (a )?(data )?log\b/i.test(t)) {
        const amount = /(-|−|minus )?\$([\d,]+(?:\.\d+)?)/i.exec(t);
        const branch = /\bfor ([A-Z][a-z]+)\b/.exec(t)?.[1] ?? ctx.purviewBranches?.[0];
        const type = /\bcash count\b/i.test(t) ? 'CASH_COUNT' : /\bincentive\b/i.test(t) ? 'INCENTIVE' : /\bsurvey\b/i.test(t) ? 'SURVEY' : 'EVENT';
        return { tool: 'dlg_log_create', args: { type_id: type, title: t.replace(/^\s*log (a|an)\s+/i, '').slice(0, 120), ...(amount ? { amount: Number(amount[2]!.replace(/,/g, '')) * (amount[1] ? -1 : 1) } : {}), ...(branch ? { branch } : {}) } };
      }
      const status = /\b(entered|submitted|approved|returned)\b/i.exec(t)?.[1];
      return { tool: 'dlg_logs_list', args: { ...(status ? { status } : /\bwaiting|\bto approve\b/i.test(t) ? { status: 'Submitted' } : {}), mine_only: /\bmy\b/i.test(t) } };
    },
    tools: [
      {
        name: 'dlg_log_types',
        description: 'The kinds of data log, and which are financial.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const types = await logs.types();
          return { text: `Log types: ${types.map((t) => `${t.label} (${t.type_id})`).join(', ')}.` };
        },
      },
      {
        name: 'dlg_logs_list',
        description: 'Data logs within the user’s purview, by status, or only their own.',
        input: z.object({ status: z.string().max(12).optional(), mine_only: z.boolean().default(false) }).strict(),
        run: async (a: { status?: string; mine_only: boolean }, ctx) => {
          need(ctx);
          const f = await logs.list({ status: a.status, ...(a.mine_only ? { createdBy: mine(ctx) } : {}) }, ctx);
          if (!f.count) return { text: 'No data logs match that.' };
          return { text: `**${f.count} data ${f.count === 1 ? 'log' : 'logs'}**${a.status ? ` ${a.status.toLowerCase()}` : ''}.`, blocks: [moduleTable(spec, 'Data logs', ctx.runId, 'datalog.list', [{ field: 'id', headerName: 'Log', type: 'text' }, { field: 'title', headerName: 'Title', type: 'text' }, { field: 'type', headerName: 'Type', type: 'text' }, { field: 'branch', headerName: 'Branch', type: 'text' }, { field: 'by', headerName: 'Entered by', type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }], f.items.slice(0, 25).map((l) => ({ id: `#${l.logId}`, title: l.amount !== null ? `${l.title} (${usd(l.amount)})` : l.title, type: l.type, branch: l.branch, by: l.createdName, status: l.status })))], suggestions: f.items.filter((l) => l.status === 'Submitted').slice(0, 1).map((l) => `Approve log ${l.logId}`) };
        },
      },
      {
        name: 'dlg_log_get',
        description: 'One log with its full history, including any note from whoever returned it.',
        input: z.object({ log_id: z.number().int().positive() }).strict(),
        run: async (a: { log_id: number }, ctx) => {
          need(ctx);
          const l = await logs.get(a.log_id, ctx);
          const back = l.history.findLast((h) => h.to === 'Returned');
          return { text: `Log **${describe(l)}** is **${l.status}**, entered by ${l.createdName}.${l.status === 'Returned' && back?.note ? ` ${back.actor} returned it: “${back.note}”` : ''}\n\n${l.history.map((h) => `- ${h.at}: ${h.to}, ${h.actor}${h.note ? `. ${h.note}` : ''}`).join('\n')}` };
        },
      },
      {
        name: 'dlg_log_create',
        description: 'Prepare a new log, saved as Entered. Returns approval_required.',
        input: z.object({ type_id: z.enum(['CASH_COUNT', 'INCENTIVE', 'EVENT', 'SURVEY']), title: z.string().min(3).max(120), amount: z.number().optional(), branch: z.string().max(40).optional() }).strict(),
        run: async (a: { type_id: string; title: string; amount?: number; branch?: string }, ctx) => {
          need(ctx);
          const branch = a.branch ?? ctx.purviewBranches?.[0];
          if (!branch) throw new CoreError('INVALID', 'Which branch is this log for?');
          if (ctx.purviewBranches && !ctx.purviewBranches.includes(branch)) throw new CoreError('NOT_FOUND', `There’s no branch called ${branch} that you can log for.`);
          const type = (await logs.types()).find((t) => t.type_id === a.type_id)!;
          if (type.financial && a.amount === undefined) throw new CoreError('INVALID', `What’s the amount for this ${type.label.toLowerCase()}?`);
          return { change: { summary: `Save a ${type.label.toLowerCase()} for ${branch}`, changes: [{ label: 'Title', before: '—', after: a.title }, { label: 'Type', before: '—', after: type.label }, ...(a.amount !== undefined ? [{ label: 'Amount', before: '—', after: usd(a.amount) }] : [])], text: `I’ve prepared a **${type.label.toLowerCase()}** for ${branch}. It’s saved as Entered, and you submit it separately.`, done: 'Saved the log as Entered. Say “submit log” with its number when it’s ready.', risk: 'low', apply: { typeId: a.type_id, title: a.title, amount: a.amount ?? null, branch } } };
        },
        apply: async (p: Parameters<DataLogService['create']>[0], meta, ctx) => void (await logs.create(p, { approvalId: meta.approvalId, userId: ctx.user.id, actor: ctx.user.name })),
      },
      {
        name: 'dlg_log_submit',
        description: 'Prepare submitting an Entered or Returned log. A type that needs no approval goes straight to Approved. Returns approval_required.',
        input: z.object({ log_id: z.number().int().positive() }).strict(),
        run: async (a: { log_id: number }, ctx) => {
          need(ctx);
          const l = await logs.get(a.log_id, ctx);
          if (l.status !== 'Entered' && l.status !== 'Returned') throw new CoreError('INVALID', `Log #${l.logId} is ${l.status}, so it can’t be submitted.`);
          const to = l.requiresApproval ? 'Submitted' : 'Approved';
          return { change: { summary: `Submit data log ${describe(l)}`, changes: [{ label: `${l.branch}, ${l.type}`, before: l.status, after: to }], text: `I’ve prepared log **${describe(l)}** for submission.`, done: to === 'Approved' ? `Log **#${l.logId}** needs no approval, so it’s Approved.` : `Submitted log **#${l.logId}** for approval.`, risk: 'medium', apply: { logId: l.logId, from: l.status, to } } };
        },
        apply: async (p: { logId: number; from: string; to: string }, _m, ctx) => logs.move(p.logId, p.from, p.to, null, ctx.user.name),
      },
      { name: 'dlg_log_approve', description: 'Prepare approving a Submitted log. Not the person who entered it. Returns approval_required.', input: z.object({ log_id: z.number().int().positive() }).strict(), run: (a: { log_id: number }, ctx) => decide(a, 'Approved', ctx), apply: async (p: { logId: number; to: string; note: string | null }, _m, ctx) => logs.move(p.logId, 'Submitted', p.to, p.note, ctx.user.name) },
      { name: 'dlg_log_return', description: 'Prepare returning a Submitted log with a note saying what to fix. Returns approval_required.', input: z.object({ log_id: z.number().int().positive(), note: z.string().max(300).optional() }).strict(), run: (a: { log_id: number; note?: string }, ctx) => decide(a, 'Returned', ctx), apply: async (p: { logId: number; to: string; note: string | null }, _m, ctx) => logs.move(p.logId, 'Submitted', p.to, p.note, ctx.user.name) },
    ],
  };
  return spec;
}
