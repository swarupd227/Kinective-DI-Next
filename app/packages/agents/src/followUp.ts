// What each turn put in front of the person, so the next message can point at it: "the first one",
// "her", "that list". Every agent's output passes through the run sink, so recording there covers
// them all without each agent keeping its own memory. Only labels and opaque record tokens are
// kept, the same things the person already sees; no figures or identifiers beyond those.
import type { Block } from '@dinext/block-schemas';
import type { RunSink } from './sink.ts';

export interface Shown {
  question: string;
  agent: string;
  /** The opening of what DI said, to give the router the gist. */
  said: string;
  /** Titles of the results shown: tables, charts, lists and records. */
  shown: string[];
  /** People listed, in the order shown, by the token their record opens with. */
  people: { token: string; label: string }[];
  /** Everything listed, people or not (applications, referrals, staff, table rows), in the order shown. */
  items?: string[];
}

const RECORD_LINK = /\/(?:members|customers|m)\/([A-Za-z0-9_-]{8,60})(?:[?#]|$)/;

/** Wraps a sink so everything the turn shows is noted in `into`. */
export function recordShown(sink: RunSink, into: Shown): RunSink {
  const out = Object.create(sink) as RunSink;
  out.routing = (agent, reason) => {
    if (!into.agent || agent !== 'DI Concierge') into.agent = agent;
    sink.routing(agent, reason);
  };
  out.text = (m, ...rest) => {
    if (into.said.length < 300) into.said = `${into.said} ${m.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ')}`.trim().slice(0, 300);
    return sink.text(m, ...rest);
  };
  out.block = (b) => {
    note(b, into);
    return sink.block(b);
  };
  return out;
}

function note(b: Block, into: Shown) {
  if (b.type === 'plan_steps' || b.type === 'notice') return;
  const title = b.output?.label ?? b.title;
  if (title && !into.shown.includes(title) && into.shown.length < 6) into.shown.push(title);
  const data = b.data as Record<string, unknown>;
  const add = (token: unknown, label: unknown) => {
    if (typeof token !== 'string' || typeof label !== 'string' || into.people.some((p) => p.token === token) || into.people.length >= 25) return;
    into.people.push({ token, label });
  };
  if ((b.type === 'member_card' || b.type === 'member_360') && data.memberRef) add(data.memberRef, data.displayName);
  // Only the latest list counts as "the list": a later one replaces what an earlier block listed.
  const listed: string[] = [];
  if (Array.isArray(data.items)) {
    for (const it of data.items as { title?: unknown; link?: unknown; meta?: unknown }[]) {
      const m = typeof it.link === 'string' ? RECORD_LINK.exec(it.link) : null;
      if (m) add(m[1], typeof it.meta === 'string' && it.meta.startsWith('…') ? `${String(it.title)} (${it.meta})` : it.title);
      // "#2689 · 17 days" names the record, so "it" can be found again by number.
      const id = typeof it.meta === 'string' ? /#\d{3,7}/.exec(it.meta)?.[0] : undefined;
      if (typeof it.title === 'string') listed.push(id ? `${it.title} (${id})` : it.title);
    }
  }
  if (b.type === 'table' && Array.isArray(data.rows) && Array.isArray(data.columns)) {
    const first = (data.columns as { field: string; hidden?: boolean }[]).find((c) => !c.hidden)?.field;
    if (first) for (const r of (data.rows as Record<string, unknown>[]).slice(0, 25)) if (r[first] !== null && r[first] !== undefined) listed.push(String(r[first]));
  }
  if (listed.length) into.items = listed.slice(0, 25);
}

const ORDINAL: Record<string, number> = { first: 0, top: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4, last: -1 };
const ORDINAL_REF = /\b(?:the\s+)?(first|top|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\s+(?:one|member|customer|person|name|people\s+on\s+the\s+list|on\s+(?:the|that|this|your)\s+list)\b/i;
const NUMBER_REF = /\b(?:number|no\.)\s?([1-9]|1\d|2[0-5])\b|#([1-9]|1\d|2[0-5])\b(?!\d)/i;
/** One person, by pronoun: only safe when the last answer was about exactly one. */
const SINGLE_REF = /\b(her|him|this (?:member|customer|person)|that (?:member|customer|person))\b/i;

/**
 * "Tell me more about the first one" after a list of people: who is meant, and the message with
 * the reference replaced by their name. Null when nothing earlier settles it.
 */
export function resolvePerson(text: string, recent: Shown[]): { token: string; label: string; text: string } | null {
  const last = recent.findLast((r) => r.people.length);
  if (!last) return null;
  // Only the most recent answer is pointed at; a list from three questions ago is not "the first one".
  if (recent.at(-1) !== last && recent.at(-1)?.shown.length) return null;
  const name = (p: { label: string }) => p.label.replace(/\s*\(…\d{4}\)$/, '');
  const ord = ORDINAL_REF.exec(text);
  const num = ord ? null : NUMBER_REF.exec(text);
  if (ord || num) {
    const i = ord ? ORDINAL[ord[1]!.toLowerCase()]! : Number(num![1] ?? num![2]) - 1;
    const p = i < 0 ? last.people.at(-1) : last.people[i];
    if (!p) return null;
    return { ...p, text: text.replace((ord ?? num)![0], name(p)) };
  }
  if (last.people.length === 1) {
    const s = SINGLE_REF.exec(text);
    if (s) return { ...last.people[0]!, text: text.replace(s[0], name(last.people[0]!)) };
  }
  return null;
}

/** The last few turns in plain words, for a model that has to work out what "that" means. */
export function describeRecent(recent: Shown[]): string {
  const lines = recent.slice(-3).map((r) => {
    const parts = [`- The user asked "${r.question}".`];
    if (r.shown.length) parts.push(`DI showed: ${r.shown.join('; ')}.`);
    if (r.said) parts.push(`DI said: "${r.said.slice(0, 200)}".`);
    if (r.people.length) parts.push(`People listed, in order: ${r.people.slice(0, 8).map((p) => p.label).join(', ')}${r.people.length > 8 ? `, and ${r.people.length - 8} more` : ''}.`);
    return parts.join(' ');
  });
  return lines.length ? `Earlier in this conversation:\n${lines.join('\n')}\n\n` : '';
}

const ONE_THING = /\b(it|that one|this one|that application|this application|that referral|this referral|that loan|this loan)\b/i;
const SEVERAL = /\b(those|these|them)\b/i;

/**
 * "What is it waiting on?" after one application, "follow-ups for those" after a list, "the first one"
 * after rows of staff: the message with the reference spelt out, so whichever agent takes it knows what
 * was meant. People are left to resolvePerson, which also puts them in context. Answers from analytics
 * are left alone: it keeps its own memory of the figures it showed.
 */
export function spellOut(text: string, recent: Shown[], analyticsAgent: string): string | null {
  const last = recent.at(-1);
  const items = last?.items ?? [];
  if (!last || !items.length || last.agent === analyticsAgent) return null;
  const ord = ORDINAL_REF.exec(text);
  if (ord) {
    const i = ORDINAL[ord[1]!.toLowerCase()]!;
    const item = i < 0 ? items.at(-1) : items[i];
    // The list it came from goes with it: "J. Ortiz" on a goals list is staff, not a member to look up.
    const from = last.shown.at(-1);
    return item ? text.replace(ord[0], from ? `${item} (from “${from}”)` : item) : null;
  }
  if (items.length === 1 && ONE_THING.test(text)) return text.replace(ONE_THING, items[0]!);
  const many = SEVERAL.exec(text);
  if (many) {
    const named = items.length <= 8 ? ` (${items.join('; ')})` : '';
    const title = last.shown.at(-1);
    return text.replace(many[0], `${many[0]}${title ? ` in “${title}”` : ''}${named}`);
  }
  return null;
}