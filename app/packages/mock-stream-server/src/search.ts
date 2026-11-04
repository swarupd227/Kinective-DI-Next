// Ctrl K ranking (spec 8.3, FE-SRCH-001). Every typed word has to match the start of a word, so
// "board" finds Board report and not Onboarding Manager. A few words people use for the same thing
// count as matches, and the best matches come first: the exact name, then names that start with
// the text, then names that hold every word, then the rest.
import type { SearchResult } from '@dinext/block-schemas';

/** Words people use for the same thing in DI. Each word also matches the words listed for it. */
const SAME: Record<string, string[]> = {
  dq: ['delinquency', 'delinquent'],
  delinquent: ['delinquency'],
  delinquency: ['delinquent'],
  late: ['delinquency', 'delinquent'],
  deposits: ['shares', 'share'],
  shares: ['deposits', 'deposit'],
  customers: ['members'],
  members: ['customers'],
  heloc: ['home equity'],
  pipeline: ['applications', 'lap'],
  applications: ['pipeline'],
  goals: ['incentives', 'scorecard'],
  incentives: ['goals'],
  kpi: ['dashboard', 'scorecard'],
  people: ['employees', 'users'],
  staff: ['employees', 'users'],
};

export const words = (q: string) => q.trim().toLowerCase().split(/\s+/).filter(Boolean);
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9$%]+/).filter(Boolean);

/** True when the word starts one of the tokens, directly or through a word meaning the same thing. */
export function wordMatches(w: string, toks: string[]): boolean {
  const alts = [w, ...(SAME[w] ?? [])];
  return alts.some((a) => {
    const parts = a.split(' ');
    return parts.length === 1 ? toks.some((t) => t.startsWith(a)) : toks.join(' ').includes(a);
  });
}

/** True when every typed word starts a word in the text. */
export const matchesAll = (q: string, text: string) => {
  const ws = words(q);
  const toks = tokens(text);
  return ws.length > 0 && ws.every((w) => wordMatches(w, toks));
};

/** Lower is better; null when it doesn't match at all. */
export function score(q: string, r: Pick<SearchResult, 'label' | 'detail'>): number | null {
  const needle = q.trim().toLowerCase();
  const label = r.label.toLowerCase();
  if (!needle) return null;
  if (label === needle) return 0;
  if (label.startsWith(needle)) return 1;
  if (matchesAll(needle, r.label)) return 2;
  if (matchesAll(needle, `${r.label} ${r.detail ?? ''}`)) return 3;
  return null;
}

/**
 * One ranked list from every source. Sources come in the order they should win a tie, a link that
 * appears twice keeps its first entry, and `trusted` results (a member found by phone or number)
 * stay in even when their words don't show in the label.
 */
export function rank(q: string, sources: SearchResult[][], opts: { trusted?: (r: SearchResult) => boolean; limit?: number } = {}): SearchResult[] {
  const seen = new Set<string>();
  const scored: { r: SearchResult; s: number; i: number }[] = [];
  let i = 0;
  for (const list of sources) {
    for (const r of list) {
      if (seen.has(r.link)) continue;
      const s = score(q, r) ?? (opts.trusted?.(r) ? 3 : null);
      if (s === null) continue;
      seen.add(r.link);
      scored.push({ r, s, i: i++ });
    }
  }
  return scored
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, opts.limit ?? 20)
    .map((x) => x.r);
}
