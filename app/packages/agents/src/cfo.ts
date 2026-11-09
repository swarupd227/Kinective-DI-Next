// CFO Scorecard (a bank's finance page): capital, earnings and credit quality on one screen, each
// measure with its five-quarter path, plan and peers where the institution has set them, regulatory
// minimums for capital, and DI's read of what needs attention. Every figure comes from the semantic
// catalog, so the page and an answer in a conversation always agree.
import type { SemanticService } from '@dinext/semantic';
import type { Pool } from '@dinext/tenant-db';

export type CfoRead = 'Strong' | 'Watch' | 'Concern';
export type CfoGroup = 'Capital' | 'Earnings' | 'Funding' | 'Credit quality';

interface Line {
  metric: string;
  label: string;
  group: CfoGroup;
  good: 'up' | 'down';
  places: number;
  /** A regulatory floor (capital) the measure must stay above, and how it's named. */
  floor?: { value: number; name: string; tile: string };
  /** A range the measure should sit in, and what each side of it means. */
  band?: { low: number; high: number; below: string; above: string };
  /** Levels a lower-is-better measure is watched at and is a concern at. */
  levels?: { watch: number; concern: number; note: string };
}

const LINES: Line[] = [
  { metric: 'cet1_ratio', label: 'CET1 ratio', group: 'Capital', good: 'up', places: 2, floor: { value: 6.5, name: 'well capitalized', tile: 'Well capitalized' } },
  { metric: 'net_worth_ratio', label: 'Tier 1 leverage ratio', group: 'Capital', good: 'up', places: 2, floor: { value: 8, name: 'the CBLR’s 8%', tile: 'CBLR minimum' } },
  { metric: 'unrealized_loss_to_tier1', label: 'Unrealized losses to tier 1', group: 'Capital', good: 'down', places: 1, levels: { watch: 25, concern: 50, note: 'counted in capital only when realized' } },
  { metric: 'net_interest_margin', label: 'Net interest margin', group: 'Earnings', good: 'up', places: 2 },
  { metric: 'return_on_equity', label: 'Return on equity', group: 'Earnings', good: 'up', places: 2 },
  { metric: 'return_on_assets', label: 'Return on assets', group: 'Earnings', good: 'up', places: 2 },
  { metric: 'efficiency_ratio', label: 'Efficiency ratio', group: 'Earnings', good: 'down', places: 1 },
  { metric: 'loan_to_share_ratio', label: 'Loan-to-deposit ratio', group: 'Funding', good: 'up', places: 1, band: { low: 80, high: 100, below: 'deposits sitting idle', above: 'loans funded with wholesale borrowing' } },
  { metric: 'uninsured_deposit_ratio', label: 'Uninsured deposits', group: 'Funding', good: 'down', places: 1, levels: { watch: 40, concern: 60, note: 'SVB’s was about 90%' } },
  { metric: 'npl_ratio', label: 'NPL ratio', group: 'Credit quality', good: 'down', places: 2 },
  { metric: 'net_charge_off_ratio', label: 'Net charge-offs', group: 'Credit quality', good: 'down', places: 2 },
  { metric: 'allowance_coverage', label: 'Allowance to nonperforming loans', group: 'Credit quality', good: 'up', places: 0 },
];

export interface CfoLine {
  metric: string;
  label: string;
  group: CfoGroup;
  good: 'up' | 'down';
  places: number;
  now: number | null;
  yearAgo: number | null;
  /** Quarter labels and values, oldest first. */
  trend: { period: string; value: number | null }[];
  plan: number | null;
  peer: number | null;
  floor?: { value: number; name: string; tile: string };
  band?: { low: number; high: number; below: string; above: string };
  levels?: { watch: number; concern: number; note: string };
  read: CfoRead;
  why: string;
}

const pct = (n: number | null, places: number) => (n === null ? '—' : `${n.toFixed(places)}%`);
const quarterStart = (monthEnd: string, back: number) => {
  const d = new Date(`${monthEnd.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 3 * back - 2);
  return d.toISOString().slice(0, 7);
};

/** Worse than a reference by more than a rounding hair, in the direction that matters. */
const worse = (now: number, ref: number, good: 'up' | 'down', places: number) => {
  const hair = 0.5 * 10 ** -places;
  return good === 'up' ? now < ref - hair : now > ref + hair;
};

function judge(l: Line, now: number | null, plan: number | null, peer: number | null): { read: CfoRead; why: string } {
  if (now === null) return { read: 'Watch', why: 'Not available from the latest build.' };
  const f = (n: number) => pct(n, l.places);
  if (l.floor) {
    if (now < l.floor.value) return { read: 'Concern', why: `Below ${l.floor.name} (${f(l.floor.value)}).` };
    const room = now - l.floor.value;
    if (room < 1) return { read: 'Watch', why: `${room.toFixed(2)} points above ${l.floor.name}.` };
  }
  if (l.levels) {
    if (now >= l.levels.concern) return { read: 'Concern', why: `At or above ${l.levels.concern}% of deposits; ${l.levels.note}.` };
    if (now >= l.levels.watch) return { read: 'Watch', why: `Above DI’s ${l.levels.watch}% watch level; ${l.levels.note}.` };
    return { read: 'Strong', why: `Below DI’s ${l.levels.watch}% watch level; ${l.levels.note}.` };
  }
  if (l.band) {
    const refs = [plan !== null ? `plan ${f(plan)}` : '', peer !== null ? `peers ${f(peer)}` : ''].filter(Boolean).join(', ');
    const tail = refs ? `; ${refs}.` : '.';
    if (now > l.band.high) return { read: 'Concern', why: `Above ${l.band.high}%: ${l.band.above}${tail}` };
    if (now < l.band.low) return { read: 'Watch', why: `Below ${l.band.low}%: ${l.band.below}${tail}` };
    return { read: 'Strong', why: `Within the ${l.band.low}% to ${l.band.high}% band${tail}` };
  }
  const vsPlan = plan !== null && worse(now, plan, l.good, l.places);
  const vsPeer = peer !== null && worse(now, peer, l.good, l.places);
  const word = l.good === 'up' ? 'below' : 'above';
  if (vsPlan && vsPeer) return { read: 'Concern', why: `${title(word)} plan (${f(plan!)}) and peers (${f(peer!)}).` };
  if (vsPlan) return { read: 'Watch', why: `${title(word)} plan (${f(plan!)})${peer !== null ? `; peers ${f(peer)}` : ''}.` };
  if (vsPeer) return { read: 'Watch', why: `${title(word)} peers (${f(peer!)})${plan !== null ? `; plan ${f(plan)}` : ''}.` };
  if (l.floor) return { read: 'Strong', why: `${(now - l.floor.value).toFixed(2)} points above ${l.floor.name}.` };
  if (plan !== null || peer !== null) return { read: 'Strong', why: [plan !== null ? `plan ${f(plan)}` : '', peer !== null ? `peers ${f(peer)}` : ''].filter(Boolean).join(', ').replace(/^./, (c) => `On or better than ${c}`) + '.' };
  return { read: 'Strong', why: 'No plan or peer figure is set for it yet.' };
}
const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** The scorecard: one line per measure, and DI's read of the whole. Banks only. */
export async function cfoScorecard(svc: SemanticService, pool: Pool) {
  const [bench] = (await pool.query('SELECT kind, metric, value FROM fin_benchmark').catch(() => [[]])) as [{ kind: string; metric: string; value: number }[]];
  const ref = (kind: string, key: string) => {
    const b = bench.find((x) => x.kind === kind && x.metric === key);
    return b ? Number(b.value) : null;
  };
  const end = svc.build.latestMonthEnd;
  const time = { grain: 'quarter' as const, from: quarterStart(end, 4), to: end.slice(0, 7) };
  const lines: CfoLine[] = [];
  for (const l of LINES.filter((x) => svc.model.metrics[x.metric])) {
    let trend: CfoLine['trend'] = [];
    try {
      const r = await svc.query({ metrics: [l.metric], time }, { canViewSql: false });
      trend = r.rows.map((x) => ({ period: String(x.period ?? ''), value: x[l.metric] === null || x[l.metric] === undefined ? null : Number(x[l.metric]) }));
    } catch {
      trend = [];
    }
    const now = trend.at(-1)?.value ?? null;
    const yearAgo = trend.length >= 5 ? (trend[0]?.value ?? null) : null;
    const plan = ref('plan', l.metric);
    const peer = ref('peer', l.metric);
    lines.push({ ...l, now, yearAgo, trend, plan, peer, ...judge(l, now, plan, peer) });
  }
  const concerns = lines.filter((l) => l.read === 'Concern');
  const watch = lines.filter((l) => l.read === 'Watch');
  const name = (l: CfoLine) => `${l.label === 'NPL ratio' ? 'the NPL ratio' : l.label.charAt(0).toLowerCase() + l.label.slice(1)} at ${pct(l.now, l.places)}, ${l.why.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}`;
  const capital = lines.filter((l) => l.group === 'Capital' && l.now !== null);
  const capitalLine = capital.length ? ` Capital: ${capital.map((l) => `${l.label} ${pct(l.now, l.places)}`).join(', ')}.` : '';
  const headline = concerns.length
    ? `${concerns.length === 1 ? 'One concern' : `${concerns.length} concerns`}: ${concerns.map(name).join('; ')}${watch.length ? `. To watch: ${watch.map(name).join('; ')}` : ''}.${capitalLine}`
    : watch.length
      ? `Nothing is a concern. To watch: ${watch.map(name).join('; ')}.${capitalLine}`
      : `Every measure is on or better than plan and peers.${capitalLine}`;
  return { lines, headline, asOf: end, quarter: lines[0]?.trend.at(-1)?.period ?? '' };
}
