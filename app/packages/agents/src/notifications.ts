// Email notifications on the shared agent. DI emails a person about their own work: new work, updates,
// follow-up reminders, a morning digest, report schedule runs and approvals waiting. Delivery is
// simulated: every email lands in an outbox people can read. Changing your own preferences is low risk
// and approved on a card. DI never sends an email someone writes to someone else.
import { z } from 'zod';
import { CoreError, EMAIL_KINDS, SIMULATED, emailKindLabel, type EmailKind, type EmailOutbox } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const NOTIFICATIONS_AGENT = 'Notifications';

/** Requests that belong here. Kept narrow: "she prefers email" is still a referral. */
export const NOTIFICATIONS_REQUEST =
  /\bwhat e-?mails\b|\be-?mails? (did|has|have) (DI|you) sen[dt]\b|\be-?mails? (DI|you) sent\b|\bmy (e-?mail|notification) (preferences|settings)\b|\bmy e-?mails\b|\b(stop|start|quit|don[’']?t|never) (e-?mailing|sending) me\b|\b(no more|turn (off|on)) .{0,30}\be-?mails?\b|\be-?mail me\b|\bsend me (a |the )?(morning )?digest\b|\bmorning digest\b|\be-?mail (notifications?|preferences|outbox)\b|\boutbox\b|\be-?mails? went out\b|\be-?mails? (sent )?by kind\b|\be-?mail delivery\b|\bsend (an? )?e-?mail to\b/i;

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/’/g, "'");

/** Which kind of email the words mean, if any. */
export function kindNamed(text: string): EmailKind | null {
  const t = text.toLowerCase();
  if (/follow.?up|reminder|overdue/.test(t)) return 'follow_up';
  if (/digest|each morning|every morning|morning|inbox/.test(t)) return 'digest';
  if (/approval/.test(t)) return 'approvals';
  if (/report|schedule/.test(t)) return 'report_schedule';
  if (/new work|assign|new referral|new task|new items?/.test(t)) return 'new_work';
  if (/update|status|work i sent|referrals i sent/.test(t)) return 'updates';
  return null;
}

const time = (iso: string) => new Date(iso).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

export function notificationsModule(outbox: EmailOutbox, today: () => string): ModuleSpec {
  const spec: ModuleSpec = {
    id: 'notifications',
    prefix: 'ntf',
    agent: NOTIFICATIONS_AGENT,
    request: NOTIFICATIONS_REQUEST,
    noAccess: 'Email notifications aren’t part of your DI access.',
    sources: [{ kind: 'table', label: 'Email outbox', ref: 'table:ntf_email' }],
    prompt: ({ tenant, user, title }) => `You are the Notifications agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) is asking about the emails DI sends them.

- "What emails did DI send me today?": ntf_outbox with when "today". "Show my emails": ntf_outbox.
- "Which emails do I get?", "my email preferences": ntf_prefs.
- "Stop emailing me follow-up reminders", "Send me a morning digest": ntf_pref_set with the kind and on true or false.
- "How many emails went out by kind?": ntf_delivery (administrators only; counts, never what the emails say).
- DI only emails people about their own work. If asked to send an email to someone, say you can't, and suggest a referral, a task or sharing a report instead.
- Delivery is simulated in this demo: nothing leaves DI.`,
    plan: (text) => {
      const t = clean(text);
      const kind = kindNamed(t);
      if (/\bsend (an? )?e-?mail to\b|\be-?mail (him|her|them|everyone|the team)\b/i.test(t)) return { say: `I can’t send emails to other people. DI only emails you about your own work, and ${SIMULATED.charAt(0).toLowerCase()}${SIMULATED.slice(1)} To reach someone, refer the member, give them a task, or share a report.` };
      if (/\b(by kind|went out|delivery|across|everyone|all users)\b/i.test(t)) return { tool: 'ntf_delivery', args: {} };
      if (/\b(preferences|settings)\b|^(which|what) e-?mails do i (get|receive)\b/i.test(t)) return { tool: 'ntf_prefs', args: {} };
      // A question about what was sent reads the outbox, even with "send me" in it.
      if (/^(what|which|show|list|did|have|has|any)\b/i.test(t)) return { tool: 'ntf_outbox', args: /\btoday\b/i.test(t) ? { when: 'today' } : {} };
      const off = /\b(stop|quit|don't|never|no more|turn off|unsubscribe)\b/i.test(t);
      const on = /\b(start|send me|turn on|e-?mail me|i want|resume)\b/i.test(t);
      if (off || on) {
        if (!kind) return { say: `Which emails? You can turn each of these on or off: ${EMAIL_KINDS.map((k) => k.label.toLowerCase()).join(', ')}.` };
        return { tool: 'ntf_pref_set', args: { kind, on: !off } };
      }
      return { tool: 'ntf_outbox', args: /\btoday\b/i.test(t) ? { when: 'today' } : {} };
    },
    tools: [
      {
        name: 'ntf_outbox',
        description: 'The emails DI sent the user: today, or the latest 20. Subject, kind and when. Delivery is simulated.',
        input: z.object({ when: z.enum(['today', 'recent']).default('recent') }).strict(),
        run: async (a: { when: 'today' | 'recent' }, ctx: ModuleContext) => {
          const items = await outbox.recent(ctx.user.id, { limit: 20, ...(a.when === 'today' ? { since: `${today()} 00:00:00` } : {}) });
          const when = a.when === 'today' ? 'today' : 'lately';
          if (!items.length) return { text: `DI hasn’t emailed you ${when}. ${SIMULATED}`, suggestions: ['Which emails do I get?'] };
          const kinds = [...new Set(items.map((e) => e.kind))].map((k) => `${items.filter((e) => e.kind === k).length} ${emailKindLabel(k).toLowerCase()}`);
          return {
            text: `DI sent you **${items.length} ${items.length === 1 ? 'email' : 'emails'}** ${when === 'today' ? 'today' : 'recently'}: ${kinds.join(', ')}. ${SIMULATED} [Open your outbox](/settings/email).`,
            blocks: [moduleTable(spec, a.when === 'today' ? 'Emails today' : 'Recent emails', ctx.runId, 'ntf.outbox', [{ field: 'when', headerName: 'When', type: 'text' }, { field: 'kind', headerName: 'Kind', type: 'text' }, { field: 'subject', headerName: 'Subject', type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }], items.map((e) => ({ when: time(e.createdAt), kind: emailKindLabel(e.kind), subject: e.subject, status: e.status })))],
          };
        },
      },
      {
        name: 'ntf_prefs',
        description: 'Which kinds of email the user gets, on or off.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx: ModuleContext) => {
          const prefs = await outbox.prefs(ctx.user.id);
          const on = prefs.filter((p) => p.on);
          return {
            text: `You get **${on.length} of ${prefs.length}** kinds of email${on.length ? `: ${on.map((p) => p.label.toLowerCase()).join(', ')}` : ''}. ${SIMULATED}`,
            blocks: [moduleTable(spec, 'My email notifications', ctx.runId, 'ntf.prefs', [{ field: 'kind', headerName: 'Email', type: 'text' }, { field: 'on', headerName: 'On?', type: 'text' }, { field: 'set', headerName: 'Set by', type: 'text' }], prefs.map((p) => ({ kind: p.label, on: p.on ? 'On' : 'Off', set: p.changed ? 'You' : 'Default' })))],
            suggestions: [on.some((p) => p.kind === 'follow_up') ? 'Stop emailing me follow-up reminders' : 'Email me follow-up reminders', prefs.find((p) => p.kind === 'digest')?.on ? 'Stop the morning digest' : 'Send me a morning digest'],
          };
        },
      },
      {
        name: 'ntf_pref_set',
        description: 'Turn one kind of email on or off for the user. Returns approval_required (low risk).',
        input: z.object({ kind: z.enum(['new_work', 'updates', 'follow_up', 'digest', 'report_schedule', 'approvals']), on: z.boolean() }).strict(),
        run: async (a: { kind: EmailKind; on: boolean }, ctx: ModuleContext) => {
          const p = (await outbox.prefs(ctx.user.id)).find((x) => x.kind === a.kind)!;
          if (p.on === a.on) throw new CoreError('INVALID', `${p.label} emails are already ${a.on ? 'on' : 'off'} for you, so nothing changes.`);
          const label = p.label.toLowerCase();
          return {
            change: {
              summary: `${a.on ? 'Start' : 'Stop'} emails: ${p.label}`,
              changes: [{ label: p.label, before: p.on ? 'On' : 'Off', after: a.on ? 'On' : 'Off' }],
              text: `I’ve prepared ${a.on ? 'turning on' : 'turning off'} **${label}** emails for you.`,
              done: `${a.on ? 'Turned on' : 'Turned off'} **${label}** emails. ${a.on ? 'They go to your outbox from now on.' : 'You still see these in the bell.'} ${SIMULATED}`,
              risk: 'low',
              apply: { userId: ctx.user.id, kind: a.kind, on: a.on },
            },
          };
        },
        apply: async (p: { userId: string; kind: EmailKind; on: boolean }, meta) => {
          // Only the person who asked: the approval belongs to them.
          if (p.userId !== meta.userId) throw new CoreError('NO_ACCESS', 'Only you can change your own email notifications.');
          await outbox.setPref(p.userId, p.kind, p.on, { approvalId: meta.approvalId });
        },
      },
      {
        name: 'ntf_delivery',
        description: 'Administrators: how many emails of each kind went out, to how many people. Counts only, never what they say.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx: ModuleContext) => {
          if (!ctx.modules.includes('admin')) throw new CoreError('NO_ACCESS', 'That isn’t part of your access: delivery counts across people are for DI administrators. I can show your own emails instead: ask “what emails did DI send me?”.');
          const counts = await outbox.deliveryCounts();
          const total = counts.reduce((n, c) => n + c.emails, 0);
          const top = [...counts].sort((x, y) => y.emails - x.emails)[0];
          return {
            text: total ? `**${total} ${total === 1 ? 'email' : 'emails'}** in the outbox, most of them ${top!.label.toLowerCase()} (${top!.emails}). Counts only: what each email says stays with the person it was for. ${SIMULATED}` : `No emails have gone out yet. ${SIMULATED}`,
            blocks: [moduleTable(spec, 'Email delivery by kind', ctx.runId, 'ntf.delivery', [{ field: 'kind', headerName: 'Kind', type: 'text' }, { field: 'emails', headerName: 'Emails', type: 'count' }, { field: 'people', headerName: 'People', type: 'count' }, { field: 'latest', headerName: 'Latest', type: 'text' }], counts.map((c) => ({ kind: c.label, emails: c.emails, people: c.people, latest: c.latest ? time(c.latest) : '—' })))],
          };
        },
      },
    ],
  };
  return spec;
}
