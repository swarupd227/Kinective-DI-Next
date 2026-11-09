// Noninterest income for a bank CFO: how much, from where, how it has grown, what share of revenue it
// is against plan and peers, and how much of it doesn't depend on rates. Mortgage banking does: gains on
// loans sold rise when rates fall and refinancing picks up, servicing fees fall as loans pay off early.
// From the FFIEC Call Report's income statement (RI), whose figures are year to date.
import type { Pool } from '@dinext/tenant-db';
import { IrrService } from './irr.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

export type FeeGroup = 'Deposit and card fees' | 'Wealth management' | 'Insurance' | 'Mortgage banking' | 'Trading' | 'Other';
/** The Call Report's noninterest income lines, the business each belongs to, and how it moves with rates. */
export const FEE_LINES: { code: string; name: string; group: FeeGroup; rates: 'steady' | 'falls' | 'rises' }[] = [
  { code: 'RIAD4080', name: 'Service charges on deposit accounts', group: 'Deposit and card fees', rates: 'steady' },
  { code: 'RIADF555', name: 'Card interchange', group: 'Deposit and card fees', rates: 'steady' },
  { code: 'RIAD4070', name: 'Trust and fiduciary', group: 'Wealth management', rates: 'steady' },
  { code: 'RIADC886', name: 'Securities brokerage', group: 'Wealth management', rates: 'steady' },
  { code: 'RIADC887', name: 'Annuity sales', group: 'Wealth management', rates: 'steady' },
  { code: 'RIADC387', name: 'Insurance commissions', group: 'Insurance', rates: 'steady' },
  // Gains on sale rise when rates fall (more refinancing); servicing fees fall (loans pay off sooner).
  { code: 'RIAD5416', name: 'Gains on loans sold', group: 'Mortgage banking', rates: 'rises' },
  { code: 'RIADB492', name: 'Loan servicing fees', group: 'Mortgage banking', rates: 'falls' },
  { code: 'RIADA220', name: 'Trading revenue', group: 'Trading', rates: 'steady' },
  { code: 'RIADB497', name: 'Other noninterest income', group: 'Other', rates: 'steady' },
];
export const FEE_GROUPS: FeeGroup[] = ['Deposit and card fees', 'Wealth management', 'Insurance', 'Mortgage banking', 'Trading', 'Other'];
/** DI's standard sensitivity of mortgage banking to a 100 bp fall in rates, until the bank's own replace it. */
export const MORTGAGE_SENSITIVITY = { gainsPer100Down: 0.35, servicingPer100Down: -0.08 };
const CODES = [...FEE_LINES.map((l) => l.code), 'RIAD4079', 'RIAD4074', 'RCON2170'];

export class FeeIncomeService {
  constructor(private readonly pool: Pool) {}

  async income() {
    const list = await rows<{ code: string; amount: number | null; q: unknown }>(this.pool, `SELECT code, amount, quarter_end AS q FROM cr_value WHERE code IN (${CODES.map(() => '?').join(', ')}) ORDER BY quarter_end`, CODES).catch(() => []);
    if (!list.length) return null;
    const byQuarter = new Map<string, Map<string, number>>();
    for (const r of list) {
      const end = (r.q instanceof Date ? r.q.toISOString() : String(r.q)).slice(0, 10);
      if (!byQuarter.has(end)) byQuarter.set(end, new Map());
      byQuarter.get(end)!.set(r.code, Number(r.amount ?? 0));
    }
    const quarters = [...byQuarter.entries()].map(([end, v]) => {
      const g = (c: string) => v.get(c) ?? 0;
      const months = Number(end.slice(5, 7));
      const lines = FEE_LINES.map((l) => ({ ...l, ytd: g(l.code) }));
      const total = g('RIAD4079') || lines.reduce((s, l) => s + l.ytd, 0);
      const nii = g('RIAD4074');
      const annual = (n: number) => (n * 12) / months;
      return { end, months, lines, total, nii, assets: g('RCON2170'), annualized: annual(total), niiAnnualized: annual(nii), sharePct: total + nii ? (total / (total + nii)) * 100 : 0 };
    });
    const trend = quarters.map((q, i) => {
      const prev = quarters[i - 1];
      const quarterly = q.months === 3 ? q.total : prev && prev.end.slice(0, 4) === q.end.slice(0, 4) && prev.months === q.months - 3 ? q.total - prev.total : null;
      return { ...q, quarterly };
    });
    const now = trend.at(-1)!;
    const before = trend.find((q) => q.end === `${Number(now.end.slice(0, 4)) - 1}${now.end.slice(4)}`) ?? null;
    const prior = trend.at(-2) ?? null;
    const pct = (a: number, b: number) => (b ? ((a - b) / Math.abs(b)) * 100 : null);

    const lines = now.lines.map((l, i) => {
      const b = before?.lines[i]?.ytd ?? null;
      return { code: l.code, name: l.name, group: l.group, rates: l.rates, ytd: l.ytd, before: b, change: b === null ? null : l.ytd - b, pct: b === null ? null : pct(l.ytd, b), sharePct: now.total ? (l.ytd / now.total) * 100 : 0 };
    });
    const groups = FEE_GROUPS.map((group) => {
      const ls = lines.filter((l) => l.group === group);
      const ytd = ls.reduce((s, l) => s + l.ytd, 0);
      const b = before ? ls.reduce((s, l) => s + (l.before ?? 0), 0) : null;
      return { group, ytd, before: b, change: b === null ? null : ytd - b, pct: b === null ? null : pct(ytd, b), sharePct: now.total ? (ytd / now.total) * 100 : 0, annualized: (ytd * 12) / now.months };
    });

    const revenue = now.annualized + now.niiAnnualized;
    const steady = lines.filter((l) => l.rates === 'steady').reduce((s, l) => s + l.ytd, 0);
    const mortgage = groups.find((g) => g.group === 'Mortgage banking')!;
    const annual = (n: number) => (n * 12) / now.months;
    const gains = annual(lines.find((l) => l.code === 'RIAD5416')!.ytd);
    const servicing = annual(lines.find((l) => l.code === 'RIADB492')!.ytd);

    const [bench] = (await this.pool.query("SELECT kind, value FROM fin_benchmark WHERE metric = 'non_interest_income_share'").catch(() => [[]])) as [{ kind: string; value: number }[]];
    const ref = (kind: string) => {
      const b = bench.find((x) => x.kind === kind);
      if (!b) return null;
      const share = Number(b.value);
      // Fee income that share would mean on today's net interest income: fees / (fees + NII) = share.
      const fees = (share / (100 - share)) * now.niiAnnualized;
      return { sharePct: share, fees, gap: now.annualized - fees };
    };

    // If rates move: net interest income from the rate-risk model, mortgage banking by DI's sensitivities,
    // the rest of fee income unchanged.
    const irr = await new IrrService(this.pool).analysis().catch(() => null);
    const rates = irr
      ? irr.scenarios
          .filter((s) => s.shockBp !== 0 && Math.abs(s.shockBp) <= 200)
          .map((s) => {
            const down = -s.shockBp / 100;
            const mortgageChange = gains * MORTGAGE_SENSITIVITY.gainsPer100Down * down + servicing * MORTGAGE_SENSITIVITY.servicingPer100Down * down;
            const niiPct = (s.niiChange / now.niiAnnualized) * 100;
            return { bp: s.shockBp, niiChange: s.niiChange, niiPct, mortgageChange, revenueChange: s.niiChange + mortgageChange, revenuePct: ((s.niiChange + mortgageChange) / revenue) * 100 };
          })
      : [];

    return {
      asOf: now.end,
      months: now.months,
      total: now.total,
      annualized: now.annualized,
      before: before?.total ?? null,
      change: before ? now.total - before.total : null,
      pct: before ? pct(now.total, before.total) : null,
      quarter: now.quarterly !== null ? { now: now.quarterly, prev: prior?.quarterly ?? null, change: prior?.quarterly != null ? now.quarterly - prior.quarterly : null } : null,
      sharePct: now.sharePct,
      shareBefore: before?.sharePct ?? null,
      toAssetsPct: now.assets ? (now.annualized / now.assets) * 100 : null,
      revenue,
      nii: now.niiAnnualized,
      /** Fee income that doesn't move with rates, as a share of revenue. */
      steadyPct: (annual(steady) / revenue) * 100,
      steady: annual(steady),
      mortgage: { annualized: mortgage.annualized, gains, servicing, sharePct: mortgage.sharePct },
      lines,
      groups,
      plan: ref('plan'),
      peer: ref('peer'),
      rates,
      trend: trend.map((q) => ({ end: q.end, ytd: q.total, quarterly: q.quarterly, annualized: q.annualized, sharePct: q.sharePct })),
    };
  }

  assumptions() {
    return [
      'Noninterest income is the Call Report’s (Schedule RI, item 5), year to date; growth is against the same months a year earlier.',
      'Share of revenue is noninterest income over net interest income plus noninterest income, as the efficiency ratio uses.',
      'Service charges, interchange, trust, brokerage, annuity and insurance income are treated as not moving with rates.',
      `Mortgage banking does: gains on loans sold rise ${Math.round(MORTGAGE_SENSITIVITY.gainsPer100Down * 100)}% for each 100 bp fall in rates (more refinancing), and servicing fees fall ${Math.round(-MORTGAGE_SENSITIVITY.servicingPer100Down * 100)}% (loans pay off sooner). These are DI’s standard sensitivities until your own replace them.`,
      'Net interest income under rate moves comes from the rate-risk model, on today’s balances.',
    ];
  }
}
