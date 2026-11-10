// Earnings per share and tangible book value per share for a bank CFO: what analysts value a bank on.
// Net income, dividends, equity, AOCI, goodwill and intangibles come from the FFIEC Call Report; shares
// outstanding and the share price aren't on it, so the CFO enters them each quarter (fin_share) from the
// transfer agent's report and the market close. Tangible book value per share is tangible common equity
// (equity less goodwill and other intangibles; the bank has no preferred stock) over shares outstanding.
import type { Pool } from '@dinext/tenant-db';
import { FundingRiskService } from './fundingRisk.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const CODES = ['RCON3210', 'RCON3163', 'RCON0426', 'RCONB530', 'RCON1754', 'RCON1771', 'RIAD4340', 'RIAD4460'];
const TAX = 0.21;
const day = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const pct = (a: number, b: number) => (b ? ((a - b) / Math.abs(b)) * 100 : null);

export interface ShareEntry {
  end: string;
  shares: number;
  weighted: number;
  price: number | null;
  source: string;
  by: string;
}

export class PerShareService {
  constructor(private readonly pool: Pool) {}

  /** The share register as entered, oldest first. Empty when the bank hasn't entered any. */
  async register(): Promise<ShareEntry[]> {
    const list = await rows<{ quarter_end: unknown; shares_outstanding: number; weighted_shares: number; price: number | null; source: string; entered_by: string }>(this.pool, 'SELECT quarter_end, shares_outstanding, weighted_shares, price, source, entered_by FROM fin_share ORDER BY quarter_end').catch(() => []);
    return list.map((r) => ({ end: day(r.quarter_end), shares: Number(r.shares_outstanding), weighted: Number(r.weighted_shares), price: r.price === null ? null : Number(r.price), source: r.source, by: r.entered_by }));
  }

  /** The latest Call Report quarter, the one the CFO enters shares for. */
  async latestQuarter() {
    const [r] = await rows<{ q: unknown }>(this.pool, 'SELECT MAX(quarter_end) AS q FROM cr_value');
    return r?.q ? day(r.q) : null;
  }

  /** Records a quarter's shares (and price, if listed). Called once the change is approved. */
  async record(e: { end: string; shares: number; weighted?: number; price?: number | null }, meta: { approvalId: string; by: string }) {
    await this.pool.query(
      'INSERT INTO fin_share (quarter_end, shares_outstanding, weighted_shares, price, source, entered_by, approval_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE shares_outstanding = VALUES(shares_outstanding), weighted_shares = VALUES(weighted_shares), price = COALESCE(VALUES(price), price), source = VALUES(source), entered_by = VALUES(entered_by), approval_id = VALUES(approval_id)',
      [e.end, Math.round(e.shares), Math.round(e.weighted ?? e.shares), e.price ?? null, 'Entered in DI', meta.by, meta.approvalId],
    );
  }

  async figures() {
    const list = await rows<{ code: string; amount: number | null; q: unknown }>(this.pool, `SELECT code, amount, quarter_end AS q FROM cr_value WHERE code IN (${CODES.map(() => '?').join(', ')}) ORDER BY quarter_end`, CODES).catch(() => []);
    if (!list.length) return null;
    const register = await this.register();
    const byQuarter = new Map<string, Map<string, number>>();
    for (const r of list) {
      const end = day(r.q);
      if (!byQuarter.has(end)) byQuarter.set(end, new Map());
      byQuarter.get(end)!.set(r.code, Number(r.amount ?? 0));
    }
    const base = [...byQuarter.entries()].map(([end, v]) => {
      const g = (c: string) => v.get(c) ?? 0;
      const equity = g('RCON3210');
      const goodwill = g('RCON3163');
      const intangibles = g('RCON0426');
      const tce = equity - goodwill - intangibles;
      const reg = register.find((x) => x.end === end) ?? null;
      return { end, months: Number(end.slice(5, 7)), equity, goodwill, intangibles, tce, aoci: g('RCONB530'), htmLoss: g('RCON1754') - (g('RCON1771') || g('RCON1754')), niYtd: g('RIAD4340'), divYtd: g('RIAD4460'), shares: reg?.shares ?? null, weighted: reg?.weighted ?? null, price: reg?.price ?? null };
    });
    // A quarter's own figures are its year to date less the quarter before's in the same year.
    const own = (i: number, key: 'niYtd' | 'divYtd') => {
      const q = base[i]!;
      if (q.months === 3) return q[key];
      const p = base[i - 1];
      return p && p.end.slice(0, 4) === q.end.slice(0, 4) && p.months === q.months - 3 ? q[key] - p[key] : null;
    };
    const trend = base.map((q, i) => {
      const ni = own(i, 'niYtd');
      const div = own(i, 'divYtd');
      const per = (n: number | null, s: number | null) => (n === null || !s ? null : n / s);
      const tbv = per(q.tce, q.shares);
      return {
        ...q,
        niQuarter: ni,
        divQuarter: div,
        bvps: per(q.equity, q.shares),
        tbvps: tbv,
        epsQuarter: per(ni, q.weighted),
        epsAnnualized: per((q.niYtd * 12) / q.months, q.weighted),
        dpsQuarter: per(div, q.shares),
        ptbv: q.price !== null && tbv ? q.price / tbv : null,
      };
    });
    const now = trend.at(-1)!;
    const yearAgo = trend.find((q) => q.end === `${Number(now.end.slice(0, 4)) - 1}${now.end.slice(4)}`) ?? null;
    const prior = trend.at(-2) ?? null;
    const yearEnd = trend.find((q) => q.end === `${Number(now.end.slice(0, 4)) - 1}-12-31`) ?? null;
    // Trailing twelve months: this year to date plus last year's remaining quarters.
    const ttm = (key: 'niYtd' | 'divYtd') => (yearAgo && yearEnd ? now[key] + (yearEnd[key] - yearAgo[key]) : null);
    const niTtm = ttm('niYtd');
    const divTtm = ttm('divYtd');
    const missing = now.shares === null;
    const epsTtm = niTtm !== null && now.weighted ? niTtm / now.weighted : null;
    const epsTtmBefore = (() => {
      // The same twelve months a year earlier needs the quarter before last year end; use last year's annualized EPS instead when it's missing.
      return yearAgo?.epsAnnualized ?? null;
    })();

    // What moved tangible book value per share over the year, per share at today's count.
    const bridge = yearAgo && now.shares && yearAgo.shares && niTtm !== null && divTtm !== null
      ? (() => {
          const s = now.shares!;
          const aoci = now.aoci - yearAgo.aoci;
          const intangibles = -(now.goodwill + now.intangibles - yearAgo.goodwill - yearAgo.intangibles);
          const other = now.equity - yearAgo.equity - niTtm + divTtm - aoci;
          return {
            start: yearAgo.tbvps!,
            earnings: niTtm / s,
            dividends: -divTtm / s,
            aoci: aoci / s,
            intangibles: intangibles / s,
            other: other / s,
            shares: yearAgo.tce / s - yearAgo.tce / yearAgo.shares!,
            end: now.tbvps!,
          };
        })()
      : null;

    // Rate rises: the available-for-sale loss moves AOCI after tax, and with it tangible book value.
    const sec = await new FundingRiskService(this.pool).securities().catch(() => null);
    const rates = sec && now.shares
      ? sec.shocks.map((s) => {
          const aociChange = s.aociAfter - sec.aoci;
          const tbvps = (now.tce + aociChange) / now.shares!;
          return { bp: s.bp, aociChange, tbvps, change: tbvps - now.tbvps!, pct: pct(tbvps, now.tbvps!)! };
        })
      : [];
    // Analysts often mark held-to-maturity securities too: their loss after tax, as if sold.
    const htmMarked = now.shares ? (now.tce - Math.max(0, now.htmLoss) * (1 - TAX)) / now.shares : null;

    const [bench] = (await this.pool.query("SELECT kind, metric, value FROM fin_benchmark WHERE metric IN ('tbv_per_share_growth', 'price_to_tangible_book', 'price_to_earnings')").catch(() => [[]])) as [{ kind: string; metric: string; value: number }[]];
    const ref = (kind: string, metric: string) => {
      const b = bench.find((x) => x.kind === kind && x.metric === metric);
      return b ? Number(b.value) : null;
    };
    const tbvGrowth = yearAgo?.tbvps && now.tbvps ? pct(now.tbvps, yearAgo.tbvps) : null;
    return {
      asOf: now.end,
      missing,
      now,
      prior,
      yearAgo,
      niTtm,
      divTtm,
      epsTtm,
      epsTtmBefore,
      epsGrowth: epsTtm !== null && epsTtmBefore ? pct(epsTtm, epsTtmBefore) : null,
      dpsTtm: divTtm !== null && now.shares ? divTtm / now.shares : null,
      payoutPct: niTtm && divTtm !== null ? (divTtm / niTtm) * 100 : null,
      rotcePct: niTtm !== null && now.tce ? (niTtm / ((now.tce + (yearAgo?.tce ?? now.tce)) / 2)) * 100 : null,
      tbvGrowth,
      tbvChangeQuarter: prior?.tbvps && now.tbvps ? now.tbvps - prior.tbvps : null,
      tbvChangeYear: yearAgo?.tbvps && now.tbvps ? now.tbvps - yearAgo.tbvps : null,
      pe: now.price !== null && epsTtm ? now.price / epsTtm : null,
      bridge,
      rates,
      htmMarked,
      plan: { tbvGrowth: ref('plan', 'tbv_per_share_growth') },
      peer: { tbvGrowth: ref('peer', 'tbv_per_share_growth'), ptbv: ref('peer', 'price_to_tangible_book'), pe: ref('peer', 'price_to_earnings') },
      trend,
    };
  }

  assumptions(): [string, string][] {
    return [
      ['Earnings and equity', 'From the FFIEC 051 Call Report: net income (RIAD4340) and common dividends (RIAD4460), which are year to date, and equity (RCON3210), AOCI (RCONB530), goodwill (RCON3163) and other intangibles (RCON0426) at quarter end. A quarter’s own figure is its year to date less the quarter before’s.'],
      ['Shares and price', 'Not on the Call Report. The CFO enters shares outstanding, weighted average shares for the quarter and the closing price each quarter, from the transfer agent’s report and the market; each entry is approved and kept.'],
      ['EPS', 'Basic: net income over weighted average shares. Trailing twelve months is this year to date plus last year’s remaining quarters, over this quarter’s weighted shares. No dilutive securities are assumed.'],
      ['Tangible book value per share', 'Tangible common equity (equity less goodwill and other intangibles; there is no preferred stock) over shares outstanding at quarter end. The bridge splits the year’s change into earnings, dividends, AOCI, intangibles, other equity changes and the share count, per share at today’s count.'],
      ['If rates rise', `The available-for-sale securities revalued on the rate-risk model’s cash flows, as the Liquidity agent does; the loss moves AOCI after ${TAX * 100}% tax, and tangible book value with it. Held-to-maturity losses don’t touch book value unless securities are sold; the marked figure shows them after tax, as some analysts do.`],
      ['Bank or holding company', 'The bank’s own stock is what is counted here. Where a holding company owns the bank and has the shareholders, its equity, goodwill and shares are the ones that count; they come from the FR Y-9C or its own books rather than the bank’s Call Report.'],
    ];
  }
}
