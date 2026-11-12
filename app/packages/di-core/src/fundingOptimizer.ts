// The funding optimizer: the cheapest way to fund loan growth that keeps every limit. The funding
// decision sets three or four plans side by side for a committee to argue over; this searches every
// mix of the sources, in steps of a tenth of the growth then a fortieth around the best, with every
// term for each, through the same funding model (FundingModel.evaluate). Each mix is priced (the
// rate on new money and the existing balances a special reprices) and checked against the EVE and
// NII limits, the wholesale and brokered caps, the FHLB reserve and contingent liquidity.
//
// A mix is acceptable when it breaches no limit, except one already breached today that it doesn't
// make worse. The answer is the cheapest acceptable mix; beside it, the cheapest that also brings an
// existing breach back inside its limit, if any can, and the cheapest of all ignoring the limits, so
// the cost of keeping each one is plain. Every figure comes from the funding model and its stated
// rates; nothing is changed until someone acts on it.
import type { Pool } from '@dinext/tenant-db';
import { CuFundingService } from './cuFunding.ts';
import { FundingChoiceService, type FundingFigures, type FundingLevers } from './fundingChoice.ts';

/** What the search needs from a funding model: the bank's (FundingModel) or a credit union's (CuFundingModel). */
export type SearchFigures = Pick<FundingFigures, 'levers' | 'fromCash' | 'cost' | 'costs' | 'allIn' | 'depositRate' | 'fhlbRate' | 'brokeredRate'> & {
  /** Raised beyond the growth and kept as liquid assets (a credit union's model). */
  held?: number;
  checks: { id: string; label: string; value: number; limit: number; kind: 'floor' | 'cap'; used: number; status: 'pass' | 'watch' | 'thin' | 'breach'; today: boolean; worseThanToday: boolean }[];
};
interface SearchModel {
  today: { growth: number; quarter: string };
  /** The model credits money raised beyond the growth to liquid assets (a credit union's does). */
  holdsExtra?: boolean;
  levers(over?: Partial<FundingLevers>): FundingLevers;
  evaluate(l: FundingLevers): SearchFigures;
  assumptions(): [string, string][];
}

const DEPOSIT_TERMS = [0, 24, 36] as const;
const FHLB_TERMS = [12, 24, 36, 60] as const;
const BROKERED_TERMS = [12, 36, 60] as const;
/** Sources: a deposit special, FHLB advances, brokered CDs, and cash on hand. */
type Shares = [number, number, number, number];

export interface OptimizedMix {
  levers: FundingLevers;
  fromCash: number;
  figures: SearchFigures;
  /** The highest share of any limit it uses, among those it keeps. */
  tightest: { label: string; used: number } | null;
}

const acceptable = (f: SearchFigures) => f.checks.every((c) => c.status !== 'breach' || (c.today && !c.worseThanToday));
const clean = (f: SearchFigures) => f.checks.every((c) => c.status !== 'breach');
const tightest = (f: SearchFigures) => {
  const kept = f.checks.filter((c) => c.status !== 'breach');
  const t = kept.reduce<(typeof kept)[number] | null>((m, c) => (!m || c.used > m.used ? c : m), null);
  return t ? { label: t.label, used: t.used } : null;
};

/** Every way to split 1 into four shares in steps of 1/n. */
function splits(n: number): Shares[] {
  const out: Shares[] = [];
  for (let a = 0; a <= n; a++) for (let b = 0; a + b <= n; b++) for (let c = 0; a + b + c <= n; c++) out.push([a / n, b / n, c / n, (n - a - b - c) / n]);
  return out;
}

export class FundingOptimizerService {
  constructor(
    private readonly pool: Pool,
    readonly institutionType: 'credit_union' | 'bank' = 'bank',
  ) {}

  /** The bank's funding model, or a credit union's: the same search runs over either. */
  async model(): Promise<SearchModel | null> {
    return this.institutionType === 'bank' ? new FundingChoiceService(this.pool).model() : new CuFundingService(this.pool).model();
  }

  /**
   * The cheapest acceptable mix, the cheapest clean one, and the cheapest ignoring limits, for the
   * capital plan's growth or an amount given. Options leave out sources the asker rules out.
   */
  async optimize(opts: { amount?: number; noBrokered?: boolean; noFhlb?: boolean; noDeposits?: boolean; noCash?: boolean } = {}) {
    const m = await this.model();
    if (!m) return null;
    // The model funds the capital plan's growth; an amount asked for replaces it for this search.
    if (opts.amount && opts.amount > 0) (m.today as { growth: number }).growth = Math.round(opts.amount);
    const g = m.today.growth;
    const allowed = (s: Shares) => !(opts.noDeposits && s[0]) && !(opts.noFhlb && s[1]) && !(opts.noBrokered && s[2]) && !(opts.noCash && s[3]);
    let evaluated = 0;
    // T is how much is raised: the growth, or more when the extra is held as liquidity.
    const run = (s: Shares, terms: [FundingLevers['depositTermMonths'], FundingLevers['fhlbTermMonths'], FundingLevers['brokeredTermMonths']], T = g) => {
      evaluated++;
      const levers = m.levers({ deposits: T * s[0], depositTermMonths: terms[0], fhlb: T * s[1], fhlbTermMonths: terms[1], brokered: T * s[2], brokeredTermMonths: terms[2] });
      return { s, terms, T, f: m.evaluate(levers) };
    };
    // A source not used has no term to choose.
    const termsFor = (s: Shares) => {
      const out: Parameters<typeof run>[1][] = [];
      for (const d of s[0] ? DEPOSIT_TERMS : [0 as const]) for (const f of s[1] ? FHLB_TERMS : [24 as const]) for (const b of s[2] ? BROKERED_TERMS : [12 as const]) out.push([d, f, b]);
      return out;
    };
    const search = (grid: Shares[], T = g) => grid.filter(allowed).flatMap((s) => termsFor(s).map((t) => run(s, t, T)));
    const pick = (all: ReturnType<typeof run>[], ok: (f: SearchFigures) => boolean) =>
      all.filter((x) => ok(x.f)).reduce<ReturnType<typeof run> | null>((best, x) => (!best || x.f.cost < best.f.cost - 1 || (Math.abs(x.f.cost - best.f.cost) <= 1 && (tightest(x.f)?.used ?? 0) < (tightest(best.f)?.used ?? 0)) ? x : best), null);

    // Coarse: tenths of the growth. Then a fortieth around each answer.
    const coarse = search(splits(10));
    const refine = (x: ReturnType<typeof run> | null) => {
      if (!x) return [];
      const near = splits(40).filter((s) => s.every((v, i) => Math.abs(v - x.s[i]!) <= 0.1 + 1e-9));
      return near.filter(allowed).filter((s) => x.T === g || !s[3]).map((s) => run(s, x.terms, x.T));
    };
    const best = (ok: (f: SearchFigures) => boolean, grid = coarse) => {
      const c = pick(grid, ok);
      return pick([...(c ? [c] : []), ...refine(c)], ok);
    };
    let chosen = best(acceptable);
    // When nothing fits because liquidity would fall below its floor, raise more than the growth and hold
    // the extra as liquid assets: 5% more, then 10%, up to half as much again.
    let extra = 0;
    if (!chosen && m.holdsExtra) {
      for (let x = 0.05; x <= 0.5 + 1e-9 && !chosen; x += 0.05) {
        const T = Math.round(g * (1 + x));
        chosen = best(acceptable, search(splits(10).filter((sp) => !sp[3]), T));
        if (chosen) extra = T - g;
      }
    }
    const cleanest = best(clean);
    const cheapest = best(() => true);
    const out = (x: ReturnType<typeof run> | null): OptimizedMix | null => (x ? { levers: x.f.levers, fromCash: x.f.fromCash, figures: x.f, tightest: tightest(x.f) } : null);
    // Today's breaches, before any funding.
    const before = m.evaluate(m.levers({ deposits: 0, fhlb: 0, brokered: 0 }));
    const breachedToday = before.checks.filter((c) => c.today).map((c) => c.label);
    // Each single source on its own, for comparison.
    const single = (['deposits', 'fhlb', 'brokered'] as const).map((k) => {
      const all = coarse.filter((x) => x.f.levers[k] === g);
      const ok = pick(all, acceptable) ?? pick(all, () => true);
      return { source: k, mix: out(ok), acceptable: ok ? acceptable(ok.f) : false };
    });
    const growthFrom = (m.today as { growthFrom?: string }).growthFrom ?? 'the capital plan’s pace for next year';
    return { growth: g, extra, growthFrom, fromPlan: !opts.amount, quarter: m.today.quarter, evaluated, chosen: out(chosen), clean: out(cleanest), cheapest: out(cheapest), single, breachedToday, ruledOut: Object.entries(opts).filter(([k, v]) => k.startsWith('no') && v).map(([k]) => k.slice(2).toLowerCase()), assumptions: this.assumptions(m) };
  }

  assumptions(m: SearchModel): [string, string][] {
    return [
      ['Search', 'Every split of the growth among a deposit special, FHLB advances, brokered CDs and cash on hand in tenths, with every term for each source used; then in fortieths around the best. Each split runs through the funding model the funding decision uses.'],
      ['Acceptable', 'Breaches no limit, except one already breached today that the mix doesn’t make worse. Among mixes within a dollar of the same cost, the one with more room under its tightest limit wins.'],
      ['Cash on hand', 'Growth not funded by a source is paid from cash, which gives up the market rate on it and leaves less available liquidity.'],
      ...m.assumptions(),
      ['What it is not', 'An instruction. It shows the cheapest mix under DI’s funding model and stated rates; ALCO decides, and the funding decision lays out the plans for the board.'],
    ];
  }
}
