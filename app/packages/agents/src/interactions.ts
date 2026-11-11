// Interaction Log: record a call, visit or message with a member or customer ("Spoke with Member"), with
// what was discussed and an optional follow-up, which becomes a task linked to that person. Written on
// approval, and shown on the Member 360 beside the core's own contact history.
import { z } from 'zod';
import { CoreError, InteractionService, LOG_CHANNELS, LOG_KINDS, type LogChannel, type LogKind } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const INTERACTION_REQUEST =
  // Case-sensitive so a name reads as a name; the verbs allow a capital at the start of a sentence.
  /\b(?:[Ll]og|[Rr]ecord|[Nn]ote down|[Aa]dd a note (?:that|about))\b[^.?!]*\b(?:call|visit|conversation|meeting|chat|message|email|interaction|spoke|talked)\b|\b(?:[Ss]poke|[Tt]alked|[Mm]et) (?:with|to) [A-Z][a-z]+ [A-Z][a-z]+\b|\b[Ll]eft (?:a )?(?:voice ?mail|message) for [A-Z][a-z]+\b|\b[Mm]y logged (?:calls|interactions)\b|\b[Ii]nteraction log\b|\b[Vv]erif(?:y|ied|ication)\b[^.?!]*\b(?:identity|ID|caller|member|customer|[A-Z][a-z]+ [A-Z][a-z]+)\b|\b(?:[Ll]ogged|[Rr]ecent) interactions\b|\b[Ww]hat (?:calls|interactions) (?:did|have) (?:I|we) log/;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** A follow-up date in a request: "follow up on November 20", "follow up Friday", "in 3 days", "next week". */
export function followUpIn(t: string, today = new Date()): string | undefined {
  const s = t.toLowerCase();
  if (!/follow[- ]?up|call (?:her|him|them|back)|check (?:in|back)|remind me/.test(s)) return undefined;
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const inDays = /\bin (\d{1,2}) days?\b/.exec(s);
  if (inDays) return ymd(new Date(base.getTime() + Number(inDays[1]) * 86_400_000));
  if (/\bnext week\b/.test(s)) return ymd(new Date(base.getTime() + 7 * 86_400_000));
  if (/\btomorrow\b/.test(s)) return ymd(new Date(base.getTime() + 86_400_000));
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(s));
  if (wd >= 0) return ymd(new Date(base.getTime() + (((wd - base.getUTCDay() + 7) % 7) || 7) * 86_400_000));
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})\b/.exec(s);
  if (md) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(md[1]!);
    let d = new Date(Date.UTC(base.getUTCFullYear(), month, Number(md[2])));
    if (d < base) d = new Date(Date.UTC(base.getUTCFullYear() + 1, month, Number(md[2])));
    return ymd(d);
  }
  return undefined;
}

export function interactionPlan(text: string, today = new Date()) {
  if (/\bmy logged (?:calls|interactions)\b|\binteraction log\b|\b(?:logged|recent) interactions\b|\bwhat (?:calls|interactions) (?:did|have) (?:i|we) log/i.test(text)) return { tool: 'rm_log_list', args: {} };
  const name = /\b(?:with|to|for|from)\s+([A-Z][a-z’'-]+ [A-Z][a-z’'-]+)/.exec(text)?.[1] ?? /\b([A-Z][a-z’'-]+ [A-Z][a-z’'-]+)\b/.exec(text.replace(/^[A-Z][a-z]+ /, ''))?.[1];
  const s = text.toLowerCase();
  if (/\bverif(?:y|ied|ication)\b/.test(s)) {
    const born = /\b((?:19|20)\d\d-\d\d-\d\d)\b/.exec(text)?.[1];
    const card = /\bcard(?: ending| last four| last 4)?(?: in| is)?\s+(\d{4})\b/i.exec(text)?.[1];
    const phone = /\bphone(?: ending| last four| last 4)?(?: in| is)?\s+(\d{4})\b/i.exec(text)?.[1];
    const email = /\b([\w.+-]+@[\w-]+\.[\w.]+)\b/.exec(text)?.[1];
    const via = /\b(?:in the branch|at the branch|in person|came in)\b/.test(s) ? 'Branch' : /\bvideo\b/.test(s) ? 'Video' : /\bchat\b/.test(s) ? 'Chat' : 'Phone';
    const who = /\bverify\s+([A-Z][a-z’'-]+ [A-Z][a-z’'-]+)/.exec(text)?.[1] ?? name ?? '';
    return { tool: 'rm_verify', args: { member: who, channel: via, ...(born ? { birth_date: born } : {}), ...(card ? { card_last4: card } : {}), ...(phone ? { phone_last4: phone } : {}), ...(email ? { email } : {}) } };
  }
  const channel: LogChannel = /\bemail(?:ed)?\b/.test(s) ? 'Email' : /secure message/.test(s) ? 'Secure message' : /\bvideo|zoom|teams\b/.test(s) ? 'Video' : /\btext(?:ed)?\b/.test(s) ? 'Text' : /\b(?:visit|in the branch|came in|stopped by|met)\b/.test(s) ? 'Branch' : 'Phone';
  const kind: LogKind = /left (?:a )?(?:voice ?mail|message)/.test(s) ? 'Left message' : /complain/.test(s) ? 'Complaint' : /\b(?:visit|came in|stopped by)\b/.test(s) ? 'Branch visit' : /\b(?:interested in|asked about|wants? (?:a|an|to))\b/.test(s) ? 'Sales conversation' : /\b(?:reset|dispute|replace|update|change (?:her|his|their) address)\b/.test(s) ? 'Service request' : 'Spoke with member';
  const summary = (/:\s*(.{5,400})$/.exec(text)?.[1] ?? /\b(?:about|re|regarding)\s+(.{5,400})$/i.exec(text)?.[1] ?? text).replace(/[,;]?\s*(?:and )?(?:remind me to )?(?:follow[- ]?up|call (?:her|him|them) back|check (?:in|back))\b.*$/i, '').trim();
  const followUp = followUpIn(text, today);
  return { tool: 'rm_log', args: { member: name ?? '', channel, kind, summary: summary.slice(0, 400) || 'Spoke with the member.', ...(followUp ? { follow_up: followUp } : {}) } };
}

export function interactionModule(svc: InteractionService, person: 'member' | 'customer' = 'member'): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('interactions')) throw new CoreError('NO_ACCESS', 'Logging interactions isn’t part of your DI access.');
  };
  const sources: ModuleSpec['sources'] = [{ kind: 'table', label: 'Interactions logged in DI', ref: 'table:rm_interaction_log' }];
  const spec: ModuleSpec = {
    id: 'interactions',
    prefix: 'rmlog',
    agent: 'Interaction Log',
    request: INTERACTION_REQUEST,
    noAccess: 'Logging interactions isn’t part of your DI access.',
    sources,
    prompt: ({ tenant, user, title }) => `You are the Interaction Log agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) records conversations with ${person}s: a call, branch visit, email or message, what was discussed, and an optional follow-up that becomes a task linked to the ${person}.

- rm_log (member name, channel ${LOG_CHANNELS.join(', ')}, kind ${LOG_KINDS.join(', ')}, summary in the user's words, follow_up date): needs approval.
- rm_log_list: what the user logged lately.
- rm_verify (member, channel, birth_date, phone_last4, card_last4, email): checks what the ${person} told the user against the file and records the result on approval. Pass only what the ${person} actually said; never say the values on file. Two or more answers are needed.`,
    plan: (t) => interactionPlan(t),
    tools: [
      {
        name: 'rm_log',
        description: `Log an interaction with a ${person}: channel, kind, a short summary in the user's words, and an optional follow-up date that creates a task linked to them. Needs approval.`,
        input: z.object({ member: z.string().min(2).max(80), channel: z.enum(LOG_CHANNELS), kind: z.enum(LOG_KINDS), summary: z.string().min(3).max(400), follow_up: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional() }).strict(),
        run: async (a: { member: string; channel: LogChannel; kind: LogKind; summary: string; follow_up?: string }, ctx) => {
          need(ctx);
          if (!a.member.trim()) return { text: `Who was the ${person}? Say their name, for example “Log a call with Suzanne Jackson: …”.` };
          const found = await svc.find(a.member, ctx);
          if (!found.length) throw new CoreError('NOT_FOUND', `I can’t find a ${person} named ${a.member} you can see.`);
          if (found.length > 1) return { text: `More than one ${person} is named ${a.member}: ${found.map((f) => `${f.name} at ${f.branch} (…${f.last4})`).join(', ')}. Which one? Add their branch or last four digits.` };
          const who = found[0]!;
          const due = a.follow_up ? new Date(`${a.follow_up}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) : null;
          return {
            change: {
              summary: `Log a ${a.channel.toLowerCase()} ${a.kind.toLowerCase()} with ${who.name}`,
              changes: [
                { label: person === 'member' ? 'Member' : 'Customer', before: '—', after: `${who.name}, ${who.branch} (…${who.last4})` },
                { label: 'Interaction', before: '—', after: `${a.kind} · ${a.channel}` },
                { label: 'Summary', before: '—', after: a.summary },
                ...(due ? [{ label: 'Follow-up task', before: '—', after: `${due}, for you` }] : []),
              ],
              text: `I’ve prepared logging this ${a.channel.toLowerCase()} with **${who.name}**${due ? `, with a follow-up task for ${due}` : ''}. It shows on their record once you approve.`,
              done: `Logged on **${who.name}**’s record${due ? `, with a follow-up task for ${due} in your Tasks` : ''}.`,
              risk: 'low',
              apply: { partyId: who.partyId, name: who.name, channel: a.channel, kind: a.kind, summary: a.summary, followUp: a.follow_up ?? null },
            },
          };
        },
        apply: async (p: { partyId: number; name: string; channel: LogChannel; kind: LogKind; summary: string; followUp: string | null }, meta, ctx) => {
          await svc.log(p, { approvalId: meta.approvalId, userId: ctx.user.id, userName: ctx.user.name, employeeId: ctx.employeeId });
        },
      },
      {
        name: 'rm_verify',
        description: `Verify a ${person}'s identity before discussing their accounts: compare what they said (birth date, last four of the phone on file, last four of an active card, email on file) with the file. Shows which answers matched, never the values on file, and records Passed or Failed on approval. A fraud alert on file means verifying in person.`,
        input: z.object({ member: z.string().min(2).max(80), channel: z.enum(['Phone', 'Branch', 'Video', 'Chat']), birth_date: z.string().regex(/^(19|20)\d\d-\d\d-\d\d$/).optional(), phone_last4: z.string().regex(/^\d{4}$/).optional(), card_last4: z.string().regex(/^\d{4}$/).optional(), email: z.string().max(120).optional() }).strict(),
        run: async (a: { member: string; channel: 'Phone' | 'Branch' | 'Video' | 'Chat'; birth_date?: string; phone_last4?: string; card_last4?: string; email?: string }, ctx) => {
          need(ctx);
          const found = await svc.find(a.member, ctx);
          if (!found.length) throw new CoreError('NOT_FOUND', `I can’t find a ${person} named ${a.member} you can see.`);
          if (found.length > 1) return { text: `More than one ${person} is named ${a.member}: ${found.map((f) => `${f.name} at ${f.branch} (…${f.last4})`).join(', ')}. Which one? Add their branch or last four digits.` };
          const who = found[0]!;
          const x = await svc.verifyChecks(who.partyId, { birthDate: a.birth_date, phoneLast4: a.phone_last4, cardLast4: a.card_last4, email: a.email });
          if (x.checks.length < 2) return { text: `Ask **${who.name}** for two of these, then tell me what they said: birth date, the last four digits of the phone on file, the last four of an active card, or the email on file. I compare their answers with the file; I won’t read the file out.` };
          const matched = x.checks.filter((c) => c.matched).length;
          const inPerson = x.fraudAlert && a.channel !== 'Branch';
          const result: 'Passed' | 'Failed' = matched === x.checks.length && matched >= 2 && !inPerson ? 'Passed' : 'Failed';
          const summary = x.checks.map((c) => `${c.label}: ${c.matched ? 'matched' : 'did not match'}`).join('; ');
          return {
            change: {
              summary: `Record ${who.name}’s identity check: ${result.toLowerCase()}`,
              changes: [
                { label: person === 'member' ? 'Member' : 'Customer', before: '—', after: `${who.name}, ${who.branch} (…${who.last4})` },
                ...x.checks.map((c) => ({ label: c.label, before: '—', after: c.matched ? 'Matched' : 'Did not match' })),
                { label: 'Result', before: '—', after: inPerson ? 'Failed: fraud alert on file, verify in person' : result },
              ],
              text: `${result === 'Passed' ? `**${who.name}** answered ${matched} of ${x.checks.length} correctly: verified.` : inPerson ? `**${who.name}** has a fraud alert on file (W07): identity has to be verified in person at a branch, not by ${a.channel.toLowerCase()}. Don’t discuss or change the accounts.` : `**${who.name}** answered ${matched} of ${x.checks.length} correctly: not verified. Don’t discuss or change the accounts.`} Approve to record the check on their record.`,
              done: `Recorded: ${who.name}’s identity check ${result.toLowerCase()} by ${a.channel.toLowerCase()}.`,
              risk: 'low',
              apply: { partyId: who.partyId, channel: a.channel, result, checks: inPerson ? `${summary}; fraud alert on file` : summary },
            },
          };
        },
        apply: async (p: { partyId: number; channel: string; result: 'Passed' | 'Failed'; checks: string }, meta, ctx) => {
          await svc.recordVerification(p, { approvalId: meta.approvalId, userName: ctx.user.name });
        },
      },
      {
        name: 'rm_log_list',
        description: 'The interactions the user logged in DI lately, newest first, with any follow-up date.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const list = await svc.recent(ctx, ctx.user.name);
          if (!list.length) return { text: `You haven’t logged any interactions in DI yet. Try “Log a call with Suzanne Jackson: she asked about a HELOC”.` };
          return {
            text: `You’ve logged **${list.length}** interactions lately; the latest was with ${list[0]!.name} (${list[0]!.kind.toLowerCase()}).`,
            blocks: [moduleTable(spec, 'Interactions you logged', ctx.runId, 'rm.log.list', [{ field: 'at', headerName: 'When', type: 'text' }, { field: 'name', headerName: person === 'member' ? 'Member' : 'Customer', type: 'text' }, { field: 'kind', headerName: 'Interaction', type: 'text' }, { field: 'summary', headerName: 'Summary', type: 'text' }, { field: 'followUp', headerName: 'Follow up', type: 'text' }], list.map((l) => ({ at: l.at, name: l.name, kind: `${l.kind} · ${l.channel}`, summary: l.summary, followUp: l.followUp ?? '' })))],
          };
        },
      },
    ],
  };
  return spec;
}
