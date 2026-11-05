// Month-end member penetration: at each month-end, by branch and age band, how many members hold
// checking, a loan, direct deposit and digital banking, and how many products they hold between them.
// Former members count while they were members, with a thinner relationship than average: people who
// leave hold less, so penetration rises a little as they go, as it does in a real book.
import { AS_OF, monthEnds, type GeneratedTenant } from './generate.ts';

export const AGE_BANDS = ['18–24', '25–34', '35–49', '50–64', '65+'] as const;

const YEAR = 365.25 * 86_400_000;
/** Yearly change in each share (checking, loan, direct deposit, digital) and in products per member. */
const DRIFT = [0.004, 0.002, 0.006, 0.02, 0.03];
const ACTIVE_SINCE = new Date(Date.parse(`${AS_OF}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
const band = (birth: string, at: string) => {
  const age = (Date.parse(`${at}T00:00:00Z`) - Date.parse(`${birth}T00:00:00Z`)) / YEAR;
  return age < 25 ? AGE_BANDS[0] : age < 35 ? AGE_BANDS[1] : age < 50 ? AGE_BANDS[2] : age < 65 ? AGE_BANDS[3] : AGE_BANDS[4];
};
/** Open at the month-end: opened by then and not closed or charged off by then. */
const openAt = (open: unknown, close: unknown, at: string, chargeOff?: unknown) => (open as string) <= at && (!close || (close as string) > at) && (!chargeOff || (chargeOff as string) > at);

export function generateMemberHistory(t: GeneratedTenant, digital: unknown[][]): unknown[][] {
  const byParty = <R extends unknown[]>(rows: R[]) => {
    const m = new Map<number, R[]>();
    for (const row of rows) (m.get(row[1] as number) ?? m.set(row[1] as number, []).get(row[1] as number)!).push(row);
    return m;
  };
  const loans = byParty(t.loans);
  const deps = byParty(t.deposits);
  const dig = new Map(digital.map((d) => [d[0] as number, d]));
  const checking = t.profile.deposits.find((d) => d.category === 'Checking')?.category ?? 'Checking';
  const out = new Map<string, number[]>();
  const add = (me: string, branch: number, ageBand: string, v: number[]) => {
    const key = `${me}|${branch}|${ageBand}`;
    const agg = out.get(key) ?? [0, 0, 0, 0, 0, 0];
    v.forEach((x, i) => (agg[i]! += x));
    out.set(key, agg);
  };

  for (const me of monthEnds()) {
    for (const p of t.parties) {
      const [id, , , birth, join, branch, , , isMember] = p as [number, string, string, string, string, number, string, number, number];
      if (!isMember || join > me) continue;
      const ls = (loans.get(id) ?? []).filter((l) => openAt(l[6], l[7], me, l[8]));
      const ds = (deps.get(id) ?? []).filter((d) => openAt(d[4], d[5], me));
      const d = dig.get(id);
      // Stopped direct deposit was running until it stopped.
      const dd = d && ((d[6] === 'active' && (!d[7] || (d[7] as string) <= me)) || (d[6] === 'stopped' && d[7] && (d[7] as string) > me)) ? 1 : 0;
      // Active on digital banking: enrolled by then and logging in within 90 days, as the core shows today.
      const online = d && ((d[1] && (d[1] as string) <= me) || (d[2] && (d[2] as string) <= me)) && d[8] && (d[8] as string) >= ACTIVE_SINCE ? 1 : 0;
      const products = new Set([...ls.map((l) => l[4] as string), ...ds.map((x) => x[3] as string)]).size;
      add(me, branch, band(birth, me), [1, ds.some((x) => x[3] === checking) ? 1 : 0, ls.length ? 1 : 0, dd, online, Math.max(1, products)]);
    }
    for (const x of t.exits) {
      const [xid, branch, join, close, birth] = x as [number, number, string, string, string];
      if (join > me || close <= me) continue;
      // Thinner than average and the same every month: half had checking, a quarter a loan.
      const h = xid % 20;
      const checkingX = h < 10 ? 1 : 0;
      const loanX = h % 4 === 0 ? 1 : 0;
      add(me, branch, band(birth, me), [1, checkingX, loanX, h < 5 ? 1 : 0, h % 5 < 3 ? 1 : 0, 1 + checkingX + loanX]);
    }
  }
  // Accounts in the seed open steadily and seldom close, which on its own would lift checking five points
  // a year. As with balances, each month-end is anchored to today's level and drifts at realistic rates,
  // keeping the mix by branch and age band.
  const ends = monthEnds();
  const latest = ends[ends.length - 1]!;
  const totals = (me: string) => [...out].filter(([k]) => k.startsWith(`${me}|`)).reduce((t, [, v]) => v.map((x, i) => t[i]! + x), [0, 0, 0, 0, 0, 0]);
  const now = totals(latest);
  for (const me of ends) {
    if (me === latest) continue;
    const t = totals(me);
    const years = (Date.parse(`${latest}T00:00:00Z`) - Date.parse(`${me}T00:00:00Z`)) / YEAR;
    const factor = [1, ...DRIFT.map((d, i) => (t[i + 1] ? ((now[i + 1]! / now[0]! - d * years) * t[0]!) / t[i + 1]! : 1))];
    for (const [k, v] of out) if (k.startsWith(`${me}|`)) out.set(k, v.map((x, i) => (i === 0 ? x : Math.round(x * factor[i]!))));
  }
  return [...out].map(([k, v]) => {
    const [me, b, a] = k.split('|');
    return [me, Number(b), a, ...v];
  });
}
