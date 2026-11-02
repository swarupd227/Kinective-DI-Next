// Compliance & Problem Management agent (spec 24.24). It logs and finds issues, escalates them and
// drafts case summaries from the record. It proposes a source and category for a person to confirm,
// and never decides whether something is a regulatory complaint under a rule. Closing an issue from
// a regulator is high risk, with the issue number typed (AI-AGT-241).
import { z } from 'zod';
import { CoreError, findPerson, ISSUE_REGULATORS, ISSUE_ROOT_CAUSES, type IssueService } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const need = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('compliance')) throw new CoreError('NO_ACCESS', 'Compliance issues aren’t part of your DI access.');
};

const CATEGORY_WORDS: [RegExp, string][] = [[/\bfees?\b|\bcharge/i, 'Fees'], [/\boverdraft/i, 'Overdraft'], [/\bcard\b|\bdispute|\bfraud/i, 'Card dispute'], [/\bloan\b|\bpayment\b|\bpayoff/i, 'Loan servicing'], [/\blocked\b|\blogin\b|\baccess\b|\bfrozen/i, 'Account access']];
/** A first suggestion for a person to confirm on the card, never a classification. */
export const proposeCategory = (text: string) => CATEGORY_WORDS.find(([w]) => w.test(text))?.[1] ?? 'Service';

const SOURCES = ['Call In', 'Branch', 'Email', 'BBB', ...ISSUE_REGULATORS];
const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const label = (id: number) => `issue #${id}`;

export function complianceModule(issues: IssueService, pool: Pool): ModuleSpec {
  const spec: ModuleSpec = {
    id: 'compliance',
    prefix: 'cpm',
    agent: 'Compliance & Problem Management',
    request: /\b(complaints?|CFPB|NCUA|OCC|FDIC|BBB|root causes?)\b|\bregulatory issues?\b|\bopen issues\b|\b(?:issue|case) #?\d{3,}\b/i,
    noAccess: 'Compliance issues aren’t part of your DI access.',
    sources: [{ kind: 'table', label: 'Issues', ref: 'table:cpm_issue' }],
    prompt: ({ tenant, user, title }) => `You are the Compliance & Problem Management agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) works member and regulatory issues.

- "Which regulatory issues are open more than 3 weeks?": cpm_issues_list. Three weeks is older_than_days 21.
- "Summarise case 4471": cpm_issue_get.
- "What are the top root causes?": cpm_root_causes.
- "Log a complaint from James Lee about a double fee": cpm_issue_create. Don't decide if it's a regulatory complaint under any rule: a person confirms the source on the card.
- "Escalate issue 3307": cpm_issue_escalate. "Close issue 3307 with resolution: ...": cpm_issue_close, with a root cause only if the user gave one.`,
    today: async (ctx) => {
      const f = await issues.list({ overdueOnly: true }, ctx);
      if (!f.count) return null;
      const reg = f.items.filter((i) => i.kind === 'regulatory').length;
      return { id: 'issues', title: `${f.count} ${f.count === 1 ? 'issue' : 'issues'} past due`, why: `${reg ? `${reg} regulatory. ` : ''}The oldest is ${f.oldestDays} days.`, badge: 'Past due', ask: 'Show my overdue open issues', weight: reg ? 110 : 70 };
    },
    plan: (text) => {
      const t = text.trim().replace(/[.!?]+$/, '');
      const id = Number(/\b(?:issue|case) #?(\d{3,})\b/i.exec(t)?.[1] ?? NaN);
      if (/^\s*log\b|\b(log|record|open) (a |an )?(complaint|issue)\b/i.test(t)) {
        const who = /\bfrom ((?:[A-Z][\w'-]*\s?){1,3})/.exec(t)?.[1]?.trim();
        if (!who) return { say: 'Who is the complaint from?' };
        return { tool: 'cpm_issue_create', args: { member: who, summary: /\babout (.+)$/i.exec(t)?.[1] ?? t, ...(SOURCES.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(t)) ? { source: SOURCES.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(t)) } : {}) } };
      }
      if (/\bescalate\b/i.test(t) && id) return { tool: 'cpm_issue_escalate', args: { issue_id: id } };
      if (/\bclose\b/i.test(t) && id) {
        const cause = ISSUE_ROOT_CAUSES.find((c) => new RegExp(`\\broot cause:?\\s*${c}\\b`, 'i').test(t));
        return { tool: 'cpm_issue_close', args: { issue_id: id, resolution: /\bresolution:?\s*(.+?)(?:,?\s*root cause.*)?$/i.exec(t)?.[1] ?? '', ...(cause ? { root_cause: cause } : {}) } };
      }
      if (id) return { tool: 'cpm_issue_get', args: { issue_id: id } };
      if (/\broot causes?\b/i.test(t)) return { tool: 'cpm_root_causes', args: {} };
      const weeks = /\b(?:more than|over|older than) (\d+) weeks?\b/i.exec(t);
      const days = /\b(?:more than|over|older than) (\d+) days?\b/i.exec(t);
      return { tool: 'cpm_issues_list', args: { ...(/\bregulatory\b/i.test(t) ? { kind: 'regulatory' } : {}), ...(SOURCES.find((s) => new RegExp(`\\b${s}\\b`).test(t)) ? { source: SOURCES.find((s) => new RegExp(`\\b${s}\\b`).test(t)) } : {}), ...(weeks ? { older_than_days: Number(weeks[1]) * 7 } : days ? { older_than_days: Number(days[1]) } : {}), ...(/\boverdue\b/i.test(t) ? { overdue_only: true } : {}) } };
    },
    tools: [
      {
        name: 'cpm_issues_list',
        description: 'Open issues, oldest first, with owner and status. Filter by kind, source or age.',
        input: z.object({ kind: z.enum(['customer', 'regulatory']).optional(), source: z.string().max(24).optional(), older_than_days: z.number().int().min(0).max(365).optional(), overdue_only: z.boolean().optional() }).strict(),
        run: async (a: { kind?: string; source?: string; older_than_days?: number; overdue_only?: boolean }, ctx) => {
          need(ctx);
          const f = await issues.list({ kind: a.kind, source: a.source, olderThan: a.older_than_days, overdueOnly: a.overdue_only }, ctx);
          if (!f.count) return { text: 'No open issues match that.' };
          const by = f.bySource.map((s) => `${s.count} ${s.source}`).join(', ');
          return {
            text: `**${f.count} ${f.count === 1 ? 'issue' : 'issues'}**: ${by}. The oldest is **${f.oldestDays} days**.`,
            blocks: [moduleTable(spec, 'Issues', ctx.runId, 'cpm.issue.list', [{ field: 'id', headerName: 'Issue', type: 'text' }, { field: 'member', headerName: 'Member', type: 'text' }, { field: 'source', headerName: 'Source', type: 'text' }, { field: 'opened', headerName: 'Opened', type: 'date' }, { field: 'age', headerName: 'Age', type: 'days' }, { field: 'owner', headerName: 'Owner', type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }], f.items.slice(0, 25).map((i) => ({ id: `#${i.issueId}`, member: `${i.member} (…${i.last4})`, source: i.source, opened: i.opened, age: i.ageDays, owner: i.owner ?? 'Unassigned', status: i.overdue ? `${i.status}, past due` : i.status })), f.asOf)],
            suggestions: f.items.slice(0, 1).map((i) => `Summarise case ${i.issueId}`),
          };
        },
      },
      {
        name: 'cpm_issue_get',
        description: 'One issue with its full history, as a draft summary quoting dates and actions from the record.',
        input: z.object({ issue_id: z.number().int().positive() }).strict(),
        run: async (a: { issue_id: number }, ctx) => {
          need(ctx);
          const i = await issues.get(a.issue_id, ctx);
          const steps = i.history.map((h) => `${longDate(h.at)}: ${h.action}${h.note ? `. ${h.note}` : ''}`);
          return {
            text: `**AI draft – verify before use.** Issue #${i.issueId} is a ${i.kind} ${i.category.toLowerCase()} issue from ${i.source}, for ${i.member}: ${i.summary}. It opened on ${longDate(i.opened)}, is **${i.status}**, and is with ${i.owner ?? 'nobody yet'}.${i.resolution ? ` Resolution: ${i.resolution}${i.rootCause ? ` Root cause: ${i.rootCause}.` : ''}` : ` It’s due by ${longDate(i.resolveBy)}.`}\n\n${steps.map((s) => `- ${s}`).join('\n')}`,
            suggestions: i.closed ? [] : [`Escalate issue ${i.issueId} to the compliance officer`],
          };
        },
      },
      {
        name: 'cpm_root_causes',
        description: 'Root causes of issues closed in the last 90 days, largest first.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const r = await issues.rootCauses(ctx);
          if (!r.causes.length) return { text: 'No issues with a root cause closed in the last 90 days.' };
          const [top] = r.causes;
          return { text: `**${top!.cause}** is the top root cause, with ${top!.count} of the ${r.causes.reduce((n, c) => n + c.count, 0)} issues closed in the last 90 days.`, blocks: [moduleTable(spec, 'Root causes', ctx.runId, 'cpm.issue.list', [{ field: 'cause', headerName: 'Root cause', type: 'text' }, { field: 'count', headerName: 'Issues', type: 'count' }], r.causes, r.asOf)] };
        },
      },
      {
        name: 'cpm_issue_create',
        description: 'Prepare a new issue for a member. Source and category are proposals a person confirms on the card. Returns approval_required.',
        input: z.object({ member: z.string().min(2).max(80), summary: z.string().min(3).max(200), source: z.string().max(24).optional(), category: z.string().max(40).optional() }).strict(),
        run: async (a: { member: string; summary: string; source?: string; category?: string }, ctx) => {
          need(ctx);
          const who = await findPerson(pool, a.member, ctx);
          const source = SOURCES.find((s) => s.toLowerCase() === a.source?.toLowerCase()) ?? 'Call In';
          const category = a.category ?? proposeCategory(a.summary);
          return { change: { summary: `Log a ${category.toLowerCase()} issue for ${who.name}`, changes: [{ label: 'Member', before: '—', after: `${who.name}, ${who.branch}` }, { label: 'Source (proposed)', before: '—', after: source }, { label: 'Category (proposed)', before: '—', after: category }, { label: 'Summary', before: '—', after: a.summary }], text: `I’ve prepared an issue for **${who.name}**. The source and category are my proposal, so please check them.`, done: `Logged the issue for **${who.name}**. Its due dates come from the ${source} service level.`, risk: 'medium', apply: { partyId: who.partyId, branchId: who.branchId, source, category, summary: a.summary, ownerId: ctx.employeeId ?? null } } };
        },
        apply: async (p: Parameters<IssueService['create']>[0], meta, ctx) => void (await issues.create(p, { approvalId: meta.approvalId, actor: ctx.user.name })),
      },
      {
        name: 'cpm_issue_escalate',
        description: 'Prepare an escalation of an issue to the compliance officer. Returns approval_required.',
        input: z.object({ issue_id: z.number().int().positive(), note: z.string().max(300).optional() }).strict(),
        run: async (a: { issue_id: number; note?: string }, ctx) => {
          need(ctx);
          const i = await issues.get(a.issue_id, ctx);
          if (i.closed) throw new CoreError('INVALID', `${label(i.issueId)} is already closed.`);
          return { change: { summary: `Escalate ${label(i.issueId)} to the compliance officer`, changes: [{ label: `#${i.issueId}, ${i.member}`, before: i.status, after: 'Escalated' }], text: `I’ve prepared the escalation of ${label(i.issueId)}.`, done: `Escalated ${label(i.issueId)} to the compliance officer.`, risk: 'medium', apply: { issueId: i.issueId, note: a.note ?? null } } };
        },
        apply: async (p: { issueId: number; note: string | null }, _m, ctx) => issues.escalate(p.issueId, p.note, { actor: ctx.user.name }),
      },
      {
        name: 'cpm_issue_close',
        description: 'Prepare closing an issue. A resolution is required, and a regulatory issue also needs a root cause. Closing one from a regulator is high risk. Returns approval_required.',
        input: z.object({ issue_id: z.number().int().positive(), resolution: z.string().max(300).optional(), root_cause: z.string().max(40).optional() }).strict(),
        run: async (a: { issue_id: number; resolution?: string; root_cause?: string }, ctx) => {
          need(ctx);
          const i = await issues.get(a.issue_id, ctx);
          if (i.closed) throw new CoreError('INVALID', `${label(i.issueId)} is already closed.`);
          if (!a.resolution?.trim()) throw new CoreError('INVALID', `What was the resolution for ${label(i.issueId)}?`);
          const cause = ISSUE_ROOT_CAUSES.find((c) => c.toLowerCase() === a.root_cause?.toLowerCase()) ?? null;
          if (i.kind === 'regulatory' && !cause) throw new CoreError('INVALID', `Closing a regulatory issue needs a root cause: ${ISSUE_ROOT_CAUSES.join(', ')}. Which one is it?`);
          const regulator = ISSUE_REGULATORS.includes(i.source);
          return { change: { summary: `Close ${label(i.issueId)} from ${i.source}`, changes: [{ label: `#${i.issueId}, ${i.member}`, before: i.status, after: 'Closed' }, { label: 'Resolution', before: '—', after: a.resolution }, ...(cause ? [{ label: 'Root cause', before: '—', after: cause }] : [])], text: `I’ve prepared the close of ${label(i.issueId)}.${regulator ? ' It’s from a regulator, so it has to be confirmed on screen.' : ''}`, done: `Closed ${label(i.issueId)}. It stays on the record for examiners.`, risk: regulator ? 'high' : 'medium', ...(regulator ? { typed: { prompt: `Type ${i.issueId} to close this ${i.source} issue`, expected: String(i.issueId) } } : {}), apply: { issueId: i.issueId, resolution: a.resolution, rootCause: cause } } };
        },
        apply: async (p: { issueId: number; resolution: string; rootCause: string | null }, _m, ctx) => issues.close(p.issueId, p.resolution, p.rootCause, { actor: ctx.user.name }),
      },
    ],
  };
  return spec;
}
