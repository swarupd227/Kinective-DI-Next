// Repeating calendar events (spec 8.14). A series keeps one rule; its dates are always worked out
// here, never by a model. A series ends on a date or after a number of times, and never runs past
// MAX_OCCURRENCES, so "every Monday" with no end means the next 12 Mondays.
export interface Recurrence {
  freq: 'weekly' | 'monthly';
  /** Every week (1) or every other week (2). Monthly is always 1. */
  interval: number;
  /** 0 Sunday to 6 Saturday, for weekly. */
  weekday?: number;
  /** 1 to 31, for monthly. A shorter month uses its last day. */
  monthDay?: number;
  /** The last day it can fall on, inclusive. */
  until?: string | null;
  /** How many times, at most. */
  count?: number | null;
}

/** With no end given. */
export const DEFAULT_OCCURRENCES = 12;
/** Never more than this, whatever the end. */
export const MAX_OCCURRENCES = 52;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const at = (d: string) => Date.parse(`${d}T00:00:00Z`);
const plus = (d: string, n: number) => iso(at(d) + n * 86_400_000);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

/** The day in a month, or that month's last day when it's shorter. m counts from 0 and may run past 11. */
export function dayInMonth(y: number, m: number, day: number) {
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${pad(mm + 1)}-${pad(Math.min(day, lastDay(yy, mm)))}`;
}

export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** The first date on or after `from` that fits the rule. */
export function firstOccurrence(rule: Recurrence, from: string) {
  if (rule.freq === 'weekly') {
    const wd = rule.weekday ?? new Date(at(from)).getUTCDay();
    return plus(from, (wd - new Date(at(from)).getUTCDay() + 7) % 7);
  }
  const [y, m] = from.split('-').map(Number) as [number, number];
  const day = rule.monthDay ?? Number(from.slice(8, 10));
  const here = dayInMonth(y, m - 1, day);
  return here >= from ? here : dayInMonth(y, m, day);
}

/** Every date of a series that starts on `first`, in order. */
export function occurrences(rule: Recurrence, first: string) {
  const cap = Math.min(rule.count ?? (rule.until ? MAX_OCCURRENCES : DEFAULT_OCCURRENCES), MAX_OCCURRENCES);
  const out: string[] = [];
  const [y, m] = first.split('-').map(Number) as [number, number];
  const day = rule.monthDay ?? Number(first.slice(8, 10));
  for (let k = 0; out.length < cap && k < MAX_OCCURRENCES * 2; k++) {
    const d = rule.freq === 'weekly' ? plus(first, k * 7 * Math.max(1, rule.interval)) : dayInMonth(y, m - 1 + k, day);
    if (rule.until && d > rule.until) break;
    out.push(d);
  }
  return out;
}

/** "Tuesday 3 November", with the year only when it isn't `today`'s. */
export function spokenDate(d: string, today: string) {
  const [y, mo, day] = d.split('-').map(Number) as [number, number, number];
  return `${DAY_NAMES[new Date(at(d)).getUTCDay()]} ${day} ${MONTH_NAMES[mo - 1]}${String(y) === today.slice(0, 4) ? '' : ` ${y}`}`;
}

/** The rule in words: "Every Monday", "Every other Tuesday", "Monthly on the 1st". */
export function describeRule(rule: Recurrence) {
  if (rule.freq === 'monthly') return `Monthly on the ${ordinal(rule.monthDay ?? 1)}`;
  const day = DAY_NAMES[rule.weekday ?? 1]!;
  return rule.interval === 2 ? `Every other ${day}` : `Every ${day}`;
}

/** How a series ends, in words, given its dates. */
export function describeEnd(rule: Recurrence, dates: string[], today: string) {
  const last = dates.at(-1);
  if (!last) return 'No dates';
  if (rule.until && !rule.count) return `Until ${spokenDate(rule.until, today)}, ${dates.length} ${dates.length === 1 ? 'time' : 'times'}`;
  return `After ${dates.length} ${dates.length === 1 ? 'time' : 'times'}, last on ${spokenDate(last, today)}`;
}

/** Stored as text on the series, and read back the same way. */
export const ruleJson = (rule: Recurrence) => JSON.stringify({ freq: rule.freq, interval: rule.interval, weekday: rule.weekday ?? null, monthDay: rule.monthDay ?? null, until: rule.until ?? null, count: rule.count ?? null });

export function parseRule(json: string): Recurrence {
  const r = JSON.parse(json) as { freq: 'weekly' | 'monthly'; interval: number; weekday: number | null; monthDay: number | null; until: string | null; count: number | null };
  return { freq: r.freq, interval: r.interval, ...(r.weekday === null ? {} : { weekday: r.weekday }), ...(r.monthDay === null ? {} : { monthDay: r.monthDay }), until: r.until, count: r.count };
}
