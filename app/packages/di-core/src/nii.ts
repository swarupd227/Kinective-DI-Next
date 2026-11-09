// Net interest income in dollars, not just the margin: how much it grew, year to date and quarter on
// quarter; how much came from a bigger balance sheet and how much from the margin (a rate/volume
// split on earning assets, the same base NIM uses); which income and expense lines moved; the gap to
// plan and peers in dollars; and what the rate-risk model expects over the next 12 months. A bank's,
// from the FFIEC Call Report, whose income figures are year to date.
import type { Pool } from '@dinext/tenant-db';
import { IrrService } from './irr.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

/** Income statement lines (RI) and the balances (RC) each is earned or paid on. */
export const NII_LINES = [
  { code: 'RIAD4010', side: 'income' as const, name: 'Loans', balance: ['RCON2122'] },
  { code: 'RIADB488', side: 'income' as const, name: 'Securities', balance: ['RCON1754', 'RCON1773'] },
  { code: 'RIAD4115', side: 'income' as const, name: 'Balances at other banks', balance: ['RCON0071'] },
  { code: 'RIAD4508', side: 'expense' as const, name: 'Transaction accounts', balance: [] },
  { code: 'RIAD0093', side: 'expense' as const, name: 'Savings and money market', balance: [] },
  { code: 'RIADHK03', side: 'expense' as const, name: 'Time deposits of $250,000 or less', balance: [] },
  { code: 'RIADHK04', side: 'expense' as const, name: 'Time deposits over $250,000', balance: [] },
  { code: 'RIAD4180', side: 'expense' as const, name: 'Borrowed money', balance: ['RCON3190'] },
];
/** Earning assets as NIM measures them (the UBPR's): interest-bearing balances, securities and loans. */
const EARNING = ['RCON0071', 'RCON1754', 'RCON1773', 'RCON2122'];
const CODES = [...new Set([...NII_LINES.map((l) => l.code), ...NII_LINES.flatMap((l) => l.balance), ...EARNING, 'RCON2200', 'RIAD4074', 'RIAD4107', 'RIAD4073'])];
/** DI's guide for the scorecard: growth below this is watched, a fall is a concern. */
export const NII_GROWTH_WATCH = 3;

export class NiiService {
  constructor(private readonly pool: Pool) {}

  async growth() {
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
      const income = g('RIAD4107') || NII_LINES.filter((l) => l.side === 'income').reduce((s, l) => s + g(l.code), 0);
      const expense = g('RIAD4073') || NII_LINES.filter((l) => l.side === 'expense').reduce((s, l) => s + g(l.code), 0);
      const ytd = g('RIAD4074') || income - expense;
      const earning = EARNING.reduce((s, c) => s + g(c), 0);
      const annual = (n: number) => (n * 12) / months;
      return {
        end,
        months,
        ytd,
        income,
        expense,
        annualized: annual(ytd),
        earning,
        deposits: g('RCON2200'),
        nimPct: earning ? (annual(ytd) / earning) * 100 : 0,
        yieldPct: earning ? (annual(income) / earning) * 100 : 0,
        costPct: earning ? (annual(expense) / earning) * 100 : 0,
        lines: NII_LINES.map((l) => {
          const balance = l.balance.reduce((s, c) => s + g(c), 0);
          return { code: l.code, name: l.name, side: l.side, ytd: g(l.code), ratePct: balance ? (annual(g(l.code)) / balance) * 100 : null };
        }),
      };
    });
    // Income is year to date, so a quarter's own figure is this year-to-date less the last one in the same year.
    const trend = quarters.map((q, i) => {
      const prev = quarters[i - 1];
      const quarterly = q.months === 3 ? q.ytd : prev && prev.end.slice(0, 4) === q.end.slice(0, 4) && prev.months === q.months - 3 ? q.ytd - prev.ytd : null;
      return { ...q, quarterly };
    });
    const now = trend.at(-1)!;
    const before = trend.find((q) => q.end === `${Number(now.end.slice(0, 4)) - 1}${now.end.slice(4)}`) ?? null;
    const prior = trend.at(-2) ?? null;
    const share = now.months / 12;
    const pct = (a: number, b: number) => (b ? ((a - b) / Math.abs(b)) * 100 : null);

    // Year to date against the same months a year earlier, split into volume and rate on earning assets:
    // annualized NII = earning assets x NIM, so the change is (growth in earning assets x last year's NIM)
    // plus (change in NIM x this year's earning assets), and the rate part splits into yield and funding cost.
    const ytd = before
      ? (() => {
          const change = now.ytd - before.ytd;
          const volume = (((now.earning - before.earning) * before.nimPct) / 100) * share;
          const yieldEffect = (((now.yieldPct - before.yieldPct) * now.earning) / 100) * share;
          const costEffect = (-((now.costPct - before.costPct) * now.earning) / 100) * share;
          return {
            now: now.ytd,
            before: before.ytd,
            change,
            pct: pct(now.ytd, before.ytd),
            months: now.months,
            earningNow: now.earning,
            earningBefore: before.earning,
            earningGrowth: now.earning - before.earning,
            earningGrowthPct: pct(now.earning, before.earning),
            nimNow: now.nimPct,
            nimBefore: before.nimPct,
            volume,
            rate: yieldEffect + costEffect,
            yieldEffect,
            costEffect,
            yieldNow: now.yieldPct,
            yieldBefore: before.yieldPct,
            costNow: now.costPct,
            costBefore: before.costPct,
            incomeChange: now.income - before.income,
            expenseChange: now.expense - before.expense,
            lines: now.lines.map((l, i) => {
              const b = before.lines[i]!;
              return { ...l, before: b.ytd, change: l.ytd - b.ytd, rateBefore: b.ratePct };
            }),
          };
        })()
      : null;
    const quarter =
      now.quarterly !== null
        ? {
            now: now.quarterly,
            prev: prior?.quarterly ?? null,
            change: prior?.quarterly !== null && prior?.quarterly !== undefined ? now.quarterly - prior.quarterly : null,
            pct: prior?.quarterly !== null && prior?.quarterly !== undefined ? pct(now.quarterly, prior.quarterly) : null,
          }
        : null;

    // Plan and peers set NIM; in dollars that is the NIM on today's earning assets.
    const [bench] = (await this.pool.query("SELECT kind, value FROM fin_benchmark WHERE metric = 'net_interest_margin'").catch(() => [[]])) as [{ kind: string; value: number }[]];
    const ref = (kind: string) => {
      const b = bench.find((x) => x.kind === kind);
      if (!b) return null;
      const nim = Number(b.value);
      const nii = (nim / 100) * now.earning;
      return { nim, nii, gap: now.annualized - nii };
    };

    // The rate-risk model's next 12 months on today's balances, and if rates move.
    const irr = await new IrrService(this.pool).analysis().catch(() => null);
    const forward = irr
      ? {
          next12: irr.base.nii,
          vsNow: irr.base.nii - now.annualized,
          pct: pct(irr.base.nii, now.annualized),
          shocks: irr.scenarios.filter((s) => s.shockBp !== 0 && Math.abs(s.shockBp) <= 200).map((s) => ({ bp: s.shockBp, nii: s.nii, change: s.niiChange, pct: s.niiPct })),
        }
      : null;

    return {
      asOf: now.end,
      months: now.months,
      ytd,
      quarter,
      runRate: now.annualized,
      earning: now.earning,
      nim: now.nimPct,
      plan: ref('plan'),
      peer: ref('peer'),
      forward,
      trend: trend.map((q) => ({ end: q.end, ytd: q.ytd, quarterly: q.quarterly, annualized: q.annualized, earning: q.earning, nim: q.nimPct, yield: q.yieldPct, cost: q.costPct })),
      lines: now.lines,
    };
  }

  assumptions() {
    return [
      'Net interest income is the Call Report’s (RI line 3, RIAD4074), year to date; a quarter’s own figure is its year to date less the last quarter’s in the same year.',
      'Growth is year to date against the same months a year earlier, so seasonality and day counts mostly cancel.',
      'The rate/volume split uses earning assets as NIM does: interest-bearing balances, securities and loans at each quarter-end. Volume is the growth in earning assets at last year’s NIM; rate is the change in NIM on this year’s earning assets, split into yield and funding cost.',
      'Plan and peers set NIM; in dollars, that NIM on today’s earning assets.',
      'The next 12 months come from the rate-risk model on today’s balances, with no growth assumed.',
    ];
  }
}
