// Capital plan for a bank CFO: how much capital the bank can return to shareholders over the next four
// quarters, as dividends and buybacks, without its ratios falling below the floor the board sets. The
// floor for each ratio is the higher of the board's internal target and the regulatory minimum plus a
// stress buffer: how far the ratio falls in DI's severely adverse stress test, as the Federal Reserve's
// stress capital buffer works for larger banks. A bank in the community bank leverage ratio framework is
// held to the leverage ratio; CET1 is shown beside it.
//
// Capacity is what capital the bank would have after a year of earnings, less what the floor needs on the
// balance sheet a year from now (loans and assets growing at plan). A buyback is valued at today's share
// price: shares retired, EPS accretion after the cash's forgone earnings, tangible book value dilution
// when the price is above tangible book, and how long the accretion takes to earn the dilution back.
import type { Pool } from '@dinext/tenant-db';
import { BaselService } from './basel.ts';
import { PerShareService } from './perShare.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const TAX = 0.21;
/** What cash used for a buyback would have earned: overnight and short investments. */
const CASH_YIELD = 0.0425;
/** The regulatory minimums the stress buffer sits on. */
export const CAPITAL_MINIMUMS = { cet1: 4.5, cet1Buffer: 2.5, cblr: 8, wellCapitalizedCet1: 6.5 };

export interface CapitalPlanSettings {
  cet1Target: number;
  leverageTarget: number;
  rwaGrowth: number;
  assetGrowth: number;
  dividendPerShareQ: number;
  buybackPlanned: number;
  notes: Record<string, string>;
  by: string | null;
}
export const CAPITAL_PLAN_DEFAULTS: Omit<CapitalPlanSettings, 'notes' | 'by'> = { cet1Target: 10, leverageTarget: 9, rwaGrowth: 5, assetGrowth: 4, dividendPerShareQ: 0.22, buybackPlanned: 0 };
const KEYS: Record<string, keyof Omit<CapitalPlanSettings, 'notes' | 'by'>> = { cet1_target: 'cet1Target', leverage_target: 'leverageTarget', rwa_growth: 'rwaGrowth', asset_growth: 'assetGrowth', dividend_per_share_q: 'dividendPerShareQ', buyback_planned: 'buybackPlanned' };

export class CapitalPlanService {
  constructor(private readonly pool: Pool) {}

  async settings(): Promise<CapitalPlanSettings> {
    const list = await rows<{ setting: string; value: number; note: string | null; updated_by: string | null }>(this.pool, 'SELECT setting, value, note, updated_by FROM fin_capital_plan').catch(() => []);
    const s: CapitalPlanSettings = { ...CAPITAL_PLAN_DEFAULTS, notes: {}, by: null };
    for (const r of list) {
      const k = KEYS[r.setting];
      if (k) s[k] = Number(r.value);
      if (r.note) s.notes[r.setting] = r.note;
      s.by = r.updated_by ?? s.by;
    }
    return s;
  }

  /** Saves changed targets or plans. Called once the change is approved. */
  async record(change: Partial<Omit<CapitalPlanSettings, 'notes' | 'by'>>, meta: { approvalId: string; by: string }) {
    for (const [setting, key] of Object.entries(KEYS)) {
      const v = change[key];
      if (v === undefined) continue;
      await this.pool.query('INSERT INTO fin_capital_plan (setting, value, note, updated_by, approval_id) VALUES (?, ?, NULL, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by), approval_id = VALUES(approval_id)', [setting, v, meta.by, meta.approvalId]);
    }
  }

  async analysis(override?: Partial<Omit<CapitalPlanSettings, 'notes' | 'by'>>) {
    const basel = await new BaselService(this.pool, 'bank').analysis().catch(() => null);
    if (!basel) return null;
    const ps = await new PerShareService(this.pool).figures().catch(() => null);
    const s = { ...(await this.settings()), ...(override ?? {}) };
    const n = basel.now;
    const cet1 = n.capital.cet1;
    const tier1 = n.capital.tier1;
    const severe = basel.stress?.find((x) => x.key === 'severe');
    const cet1Now = n.ratios[0]!.pct;
    const levNow = n.ratios[3]!.pct;
    const cet1Low = severe?.lowCet1.cet1Pct ?? cet1Now;
    const levLow = severe?.lowLeverage.leveragePct ?? levNow;
    // The stress buffer: the severely adverse decline, at least the conservation buffer for CET1.
    const cet1Stress = Math.max(0, cet1Now - cet1Low);
    const levStress = Math.max(0, levNow - levLow);
    const cet1Floor = Math.max(s.cet1Target, CAPITAL_MINIMUMS.cet1 + Math.max(CAPITAL_MINIMUMS.cet1Buffer, cet1Stress));
    const levFloor = Math.max(s.leverageTarget, (n.cblr.elected ? CAPITAL_MINIMUMS.cblr : 4) + levStress);

    // A year ahead: earnings at the trailing twelve months' pace, risk-weighted assets and total assets at plan.
    const niYear = ps?.niTtm ?? (n.capital.equity * 0.1);
    const rwaEnd = n.rwa * (1 + s.rwaGrowth / 100);
    const assetsEnd = n.leverageAssets * (1 + s.assetGrowth / 100);
    // Capacity P: capital after earnings and payouts holds the floor. Paying out cash also shrinks the assets the leverage ratio counts.
    const cet1Capacity = cet1 + niYear - (cet1Floor / 100) * rwaEnd;
    const levCapacity = (tier1 + niYear - (levFloor / 100) * assetsEnd) / (1 - levFloor / 100);
    const binding = n.cblr.elected ? (levCapacity <= cet1Capacity ? 'leverage' : 'cet1') : cet1Capacity <= levCapacity ? 'cet1' : 'leverage';
    const capacity = Math.max(0, Math.min(cet1Capacity, levCapacity));
    const shares = ps?.now.shares ?? null;
    const weighted = ps?.now.weighted ?? shares;
    const price = ps?.now.price ?? null;
    const dividends = shares ? s.dividendPerShareQ * 4 * shares : 0;
    const buybackRoom = Math.max(0, capacity - dividends);
    const payoutPct = niYear ? (dividends / niYear) * 100 : null;

    // Ratios a year ahead at a given payout, and the stressed low from there.
    const ahead = (payout: number) => {
      const c = cet1 + niYear - payout;
      const t = tier1 + niYear - payout;
      const cet1Pct = (c / rwaEnd) * 100;
      const levPct = (t / (assetsEnd - payout)) * 100;
      return { payout, cet1Pct, levPct, cet1Stressed: cet1Pct - cet1Stress, levStressed: levPct - levStress, cet1Ok: cet1Pct >= cet1Floor - 1e-9, levOk: levPct >= levFloor - 1e-9 };
    };

    // A buyback: what it retires and what it does to EPS and tangible book value per share.
    const buyback = (amount: number) => {
      if (!shares || !weighted || !price || !ps) return null;
      const retired = amount / price;
      const forgone = amount * CASH_YIELD * (1 - TAX);
      const epsBefore = niYear / weighted;
      const epsAfter = (niYear - forgone) / (weighted - retired);
      const tbvBefore = ps.now.tce / shares;
      const tbvAfter = (ps.now.tce - amount) / (shares - retired);
      const accretion = epsAfter - epsBefore;
      const dilution = tbvBefore - tbvAfter;
      return { amount, retired, pctOfShares: (retired / shares) * 100, epsBefore, epsAfter, accretionPct: (accretion / epsBefore) * 100, tbvBefore, tbvAfter, dilutionPct: (dilution / tbvBefore) * 100, earnbackYears: accretion > 0 && dilution > 0 ? dilution / accretion : null, priceToTbv: price / tbvBefore, ...ahead(dividends + amount) };
    };

    // Dividends a bank can declare without approval: this year's net income plus the last two years' retained (12 CFR 5.64; Regulation H 208.5).
    const ni = await rows<{ q: unknown; code: string; amount: number }>(this.pool, "SELECT quarter_end AS q, code, amount FROM cr_value WHERE code IN ('RIAD4340', 'RIAD4460') ORDER BY quarter_end").catch(() => []);
    const ye = (y: number, code: string) => Number(ni.find((r) => String(r.q instanceof Date ? r.q.toISOString() : r.q).startsWith(`${y}-12-31`) && r.code === code)?.amount ?? NaN);
    const latest = ni.at(-1);
    const year = latest ? Number(String(latest.q instanceof Date ? latest.q.toISOString() : latest.q).slice(0, 4)) : new Date().getUTCFullYear();
    const ytd = (code: string) => Number([...ni].reverse().find((r) => r.code === code)?.amount ?? 0);
    const retainedPrior = [year - 1, year - 2].map((y) => ({ year: y, retained: ye(y, 'RIAD4340') - ye(y, 'RIAD4460') }));
    const known = retainedPrior.filter((r) => Number.isFinite(r.retained));
    const dividendLimit = ytd('RIAD4340') + known.reduce((t, r) => t + r.retained, 0);
    const declaredYtd = ytd('RIAD4460');

    return {
      quarter: n.quarter,
      settings: s,
      cblr: n.cblr.elected,
      now: { cet1Pct: cet1Now, levPct: levNow, cet1, tier1, rwa: n.rwa, leverageAssets: n.leverageAssets },
      stress: { cet1Low, levLow, cet1Stress, levStress, quarterCet1: severe?.lowCet1.quarter ?? null, quarterLev: severe?.lowLeverage.quarter ?? null },
      floors: { cet1: cet1Floor, leverage: levFloor, cet1FromTarget: cet1Floor === s.cet1Target, levFromTarget: levFloor === s.leverageTarget },
      year: { ni: niYear, rwaEnd, assetsEnd },
      capacity: { cet1: cet1Capacity, leverage: levCapacity, binding, total: capacity, dividends, buybackRoom, payoutPct, excessNowCet1: cet1 - (cet1Floor / 100) * n.rwa, excessNowLev: tier1 - (levFloor / 100) * n.leverageAssets },
      plan: ahead(dividends + s.buybackPlanned),
      noPayout: ahead(0),
      atCapacity: ahead(capacity),
      buyback,
      perShare: ps ? { shares, weighted, price, tbvps: ps.now.tbvps, epsTtm: ps.epsTtm, dpsTtm: ps.dpsTtm, ptbv: ps.now.ptbv } : null,
      dividendRule: { year, ytdNi: ytd('RIAD4340'), declaredYtd, retainedPrior, limit: dividendLimit, missingYears: retainedPrior.filter((r) => !Number.isFinite(r.retained)).map((r) => r.year), room: dividendLimit - declaredYtd },
    };
  }

  assumptions(): [string, string][] {
    return [
      ['Capital and ratios', 'DI’s Basel III estimate from the FFIEC 051 Call Report: CET1 and tier 1 capital, risk-weighted assets, and the leverage ratio on average assets.'],
      ['Floors', `For each ratio, the higher of the board’s internal target and the regulatory minimum plus a stress buffer. The stress buffer is how far the ratio falls in DI’s severely adverse stress test (at least the ${CAPITAL_MINIMUMS.cet1Buffer}% conservation buffer for CET1 on its ${CAPITAL_MINIMUMS.cet1}% minimum; the leverage ratio on the community bank leverage ratio’s ${CAPITAL_MINIMUMS.cblr}%), the way the Federal Reserve’s stress capital buffer works for larger banks. A bank in the CBLR framework is held to the leverage ratio.`],
      ['A year ahead', 'Net income at the last twelve months’ pace; risk-weighted assets and total assets growing at the CFO’s plan. Capacity is the capital left after earnings above what the floor needs then; paying out cash also shrinks the assets the leverage ratio counts.'],
      ['Buybacks', `At today’s share price. EPS accretion counts what the cash would have earned (${(CASH_YIELD * 100).toFixed(2)}% before ${TAX * 100}% tax). Buying above tangible book dilutes it; the earn-back is the dilution over the yearly EPS accretion.`],
      ['Approvals', 'A bank may declare dividends up to this year’s net income plus the last two years’ retained net income without its regulator’s approval (12 CFR 5.64 for national banks; Regulation H 208.5 for state member banks). Most banks buy back stock at the holding company; a bank buying back its own stock reduces capital and needs approval. The board declares dividends and authorizes buybacks.'],
    ];
  }
}
