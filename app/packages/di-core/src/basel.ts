// Basel III capital for a bank: the standardized approach as US regulators apply it to community banks
// (12 CFR 3, 217 and 324). Regulatory capital is common equity tier 1 (CET1), additional tier 1 and
// tier 2; each asset and off-balance-sheet commitment is weighted by its risk; four ratios are held
// against their minimums, the 2.5% capital conservation buffer and prompt corrective action's "well
// capitalized" levels. A bank that elects the community bank leverage ratio (CBLR) files only RC-R Part
// I, but its CFO still tracks the risk-based ratios: they apply if the bank leaves the CBLR, and they
// say which framework leaves the bank more room.
//
// DI builds the ratios from the Call Report it already has (RC, RC-C, RC-N and RC-R Part I). Where the
// Call Report does not say what risk weight applies (the securities mix, construction loans that are
// high-volatility commercial real estate, unused commitments), DI assumes, and shows every assumption.
// The figures are DI's estimate, not a filed RC-R Part II.
import type { Pool } from '@dinext/tenant-db';
import { StressService, type ScenarioKey } from './stress.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

/** The four ratios: minimum, minimum plus the conservation buffer, and well capitalized (prompt corrective action). */
export const BASEL_THRESHOLDS = {
  cet1: { name: 'Common equity tier 1 capital ratio', short: 'CET1', minimum: 4.5, buffered: 7, well: 6.5 },
  tier1: { name: 'Tier 1 capital ratio', short: 'Tier 1', minimum: 6, buffered: 8.5, well: 8 },
  total: { name: 'Total capital ratio', short: 'Total capital', minimum: 8, buffered: 10.5, well: 10 },
  leverage: { name: 'Tier 1 leverage ratio', short: 'Leverage', minimum: 4, buffered: null, well: 5 },
} as const;
export type RatioKey = keyof typeof BASEL_THRESHOLDS;
export const CONSERVATION_BUFFER = 2.5;
/** The community bank leverage ratio's requirement (8% from July 1, 2026). */
export const CBLR_PCT = 8;
/** The allowance counts in tier 2 up to 1.25% of risk-weighted assets. */
const ACL_CAP = 0.0125;
/** CBLR eligibility: off-balance-sheet exposures at most 25% of total assets, total assets under $10 billion. */
const CBLR_OBS_MAX = 0.25;
const CBLR_ASSET_MAX = 10_000_000_000;

/** DI's assumptions where the Call Report does not give the risk weight. Each is shown with the result. */
export const BASEL_ASSUMPTIONS = {
  /** Cash and noninterest-bearing balances: currency and coin (0%) and balances due from US banks (20%). */
  cashVaultShare: 0.35,
  /** The securities portfolio at amortized cost (the bank has made the AOCI opt-out election). */
  securities: [
    { name: 'US Treasuries', share: 0.2, weight: 0 },
    { name: 'Ginnie Mae mortgage-backed securities', share: 0.1, weight: 0 },
    { name: 'Fannie Mae and Freddie Mac mortgage-backed securities and agency debt', share: 0.45, weight: 20 },
    { name: 'Municipal general obligation bonds', share: 0.2, weight: 20 },
    { name: 'Municipal revenue bonds', share: 0.05, weight: 50 },
  ],
  /** Construction and land loans that are high-volatility commercial real estate (150%). */
  hvcreShare: 0.35,
  /** Unused commitments, as a share of each type's balance, with the credit conversion factor that applies. */
  commitments: [
    { name: 'Construction loans, undrawn', code: 'RCONF159', share: 0.3, ccf: 50, weight: 100 },
    { name: 'Commercial lines over one year, unused', code: 'RCON1766', share: 0.15, ccf: 50, weight: 100 },
    { name: 'Commercial lines of one year or less, unused', code: 'RCON1766', share: 0.1, ccf: 20, weight: 100 },
    { name: 'Home equity lines, unused', code: 'RCON1797', share: 0.6, ccf: 50, weight: 100 },
    { name: 'Credit card lines, unused (unconditionally cancelable)', code: 'RCONB538', share: 2.5, ccf: 0, weight: 100 },
  ],
} as const;

export interface RwaLine {
  group: 'Cash and balances' | 'Securities' | 'Loans' | 'Other assets' | 'Off-balance-sheet';
  name: string;
  code: string | null;
  exposure: number;
  weightPct: number;
  rwa: number;
  basis: string;
}

export interface RatioLine {
  key: RatioKey;
  name: string;
  short: string;
  pct: number;
  minimum: number;
  buffered: number | null;
  well: number;
  /** Dollars of capital above the well-capitalized level. */
  aboveWell: number;
  base: number;
  capital: number;
}

const LOAN_LINES: [string, string, number, string][] = [
  ['RCON5367', 'First-lien 1–4 family residential mortgages', 50, 'Prudently underwritten, not past due 90 days: 50%.'],
  ['RCON1797', 'Home equity lines (1–4 family, revolving)', 100, 'Junior liens: 100%.'],
  ['RCON1460', 'Multifamily residential', 100, 'Counted at 100%; loans meeting the statutory multifamily test qualify for 50%.'],
  ['RCONF160', 'Owner-occupied commercial real estate', 100, '100%.'],
  ['RCONF161', 'Other nonfarm nonresidential (investor) real estate', 100, '100%.'],
  ['RCON1766', 'Commercial and industrial loans', 100, '100%.'],
  ['RCONB538', 'Credit cards', 100, 'Retail exposures: 100%.'],
  ['RCONK137', 'Automobile loans', 100, 'Retail exposures: 100%.'],
  ['RCONK207', 'Other consumer loans', 100, 'Retail exposures: 100%.'],
];

const quarterLabel = (end: string) => `Q${Math.floor((Number(end.slice(5, 7)) - 1) / 3) + 1} ${end.slice(0, 4)}`;

export class BaselService {
  constructor(
    private readonly pool: Pool,
    private readonly institutionType: 'credit_union' | 'bank' = 'bank',
  ) {}

  private async values() {
    const list = await rows<{ quarter_end: unknown; code: string; amount: number | null; text_value: string | null }>(this.pool, 'SELECT quarter_end, code, amount, text_value FROM cr_value WHERE code LIKE ? ORDER BY quarter_end', ['RCON%']);
    const by = new Map<string, Map<string, number>>();
    for (const r of list) {
      const end = r.quarter_end instanceof Date ? r.quarter_end.toISOString().slice(0, 10) : String(r.quarter_end).slice(0, 10);
      if (!by.has(end)) by.set(end, new Map());
      // The CBLR election is a Yes or No answer: 1 or 0.
      by.get(end)!.set(r.code, r.text_value !== null && r.amount === null ? (/^y/i.test(r.text_value) ? 1 : 0) : Number(r.amount ?? 0));
    }
    return by;
  }

  /** Risk-weighted assets, capital and the four ratios for one quarter's Call Report values. */
  compute(end: string, v: Map<string, number>) {
    const g = (c: string) => v.get(c) ?? 0;
    const A = BASEL_ASSUMPTIONS;
    const lines: RwaLine[] = [];
    const add = (l: Omit<RwaLine, 'rwa'>) => lines.push({ ...l, rwa: (l.exposure * l.weightPct) / 100 });
    add({ group: 'Cash and balances', name: 'Currency and coin', code: 'RCON0081', exposure: g('RCON0081') * A.cashVaultShare, weightPct: 0, basis: `Assumed ${A.cashVaultShare * 100}% of cash and noninterest-bearing balances.` });
    add({ group: 'Cash and balances', name: 'Balances due from US banks', code: 'RCON0081', exposure: g('RCON0081') * (1 - A.cashVaultShare), weightPct: 20, basis: 'US depository institutions: 20%.' });
    add({ group: 'Cash and balances', name: 'Balances at the Federal Reserve', code: 'RCON0071', exposure: g('RCON0071'), weightPct: 0, basis: 'Assumed all interest-bearing balances are at the Federal Reserve: 0%.' });
    const securities = g('RCON1754') + g('RCON1772');
    for (const s of A.securities) add({ group: 'Securities', name: s.name, code: 'RCON1754, RCON1772', exposure: securities * s.share, weightPct: s.weight, basis: `Assumed ${Math.round(s.share * 100)}% of securities at amortized cost (AOCI opt-out).` });
    for (const [code, name, w, basis] of LOAN_LINES) add({ group: 'Loans', name, code, exposure: g(code), weightPct: w, basis });
    add({ group: 'Loans', name: 'Construction and land: high-volatility CRE', code: 'RCONF159', exposure: g('RCONF159') * A.hvcreShare, weightPct: 150, basis: `Assumed ${A.hvcreShare * 100}% of construction and land loans are HVCRE: 150%.` });
    add({ group: 'Loans', name: 'Construction and land: other', code: 'RCONF159', exposure: g('RCONF159') * (1 - A.hvcreShare), weightPct: 100, basis: 'Not HVCRE (meets the exemptions): 100%.' });
    // Past due 90 days or more and nonaccrual loans are weighted 150% (residential mortgages 100%): 50 points more.
    add({ group: 'Loans', name: 'Past due 90+ days and nonaccrual: extra weight', code: 'RCON1407, RCON1403', exposure: g('RCON1407') + g('RCON1403'), weightPct: 50, basis: 'Past-due exposures rise to 150% (residential mortgages to 100%): 50 points on top of the loan’s weight.' });
    add({ group: 'Other assets', name: 'Premises and fixed assets', code: 'RCON2145', exposure: g('RCON2145'), weightPct: 100, basis: '100%.' });
    add({ group: 'Other assets', name: 'Goodwill and other intangibles', code: 'RCON3163, RCON0426', exposure: g('RCON3163') + g('RCON0426'), weightPct: 0, basis: 'Deducted from capital (RCONP841, RCONP842), so not risk weighted.' });
    add({ group: 'Other assets', name: 'Other assets', code: 'RCON2160', exposure: g('RCON2160'), weightPct: 100, basis: 'Counted at 100%; any deferred tax assets over the threshold would be 250%.' });
    let obsNotional = 0;
    for (const c of A.commitments) {
      const unused = g(c.code) * c.share;
      if (c.ccf > 0) obsNotional += unused;
      add({ group: 'Off-balance-sheet', name: c.name, code: c.code, exposure: (unused * c.ccf) / 100, weightPct: c.weight, basis: `Assumed unused ${Math.round(c.share * 100)}% of drawn balances; credit conversion factor ${c.ccf}%.` });
    }
    const rwa = lines.reduce((s, l) => s + l.rwa, 0);
    const cet1 = g('RCONP742');
    const additionalTier1 = 0;
    const tier1 = g('RCON8274') || cet1 + additionalTier1;
    const allowance = g('RCON3123');
    const allowanceInTier2 = Math.min(allowance, rwa * ACL_CAP);
    const tier2 = allowanceInTier2;
    const totalCapital = tier1 + tier2;
    const leverageAssets = g('RCONA224');
    const totalAssets = g('RCON2170');
    const ratio = (key: RatioKey, capital: number, base: number): RatioLine => {
      const t = BASEL_THRESHOLDS[key];
      return { key, name: t.name, short: t.short, pct: base ? (capital / base) * 100 : 0, minimum: t.minimum, buffered: t.buffered, well: t.well, aboveWell: capital - (t.well / 100) * base, base, capital };
    };
    const ratios = [ratio('cet1', cet1, rwa), ratio('tier1', tier1, rwa), ratio('total', totalCapital, rwa), ratio('leverage', tier1, leverageAssets)];
    // The buffer is the smallest of the three risk-based ratios' distance above its minimum.
    const bufferPct = Math.min(...ratios.filter((r) => r.key !== 'leverage').map((r) => r.pct - r.minimum));
    const binding = ratios.reduce((b, r) => (r.aboveWell < b.aboveWell ? r : b), ratios[0]!);
    const loans = g('RCON2122');
    const loanRwa = lines.filter((l) => l.group === 'Loans').reduce((s, l) => s + l.rwa, 0);
    return {
      end,
      quarter: quarterLabel(end),
      lines,
      rwa,
      totalAssets,
      leverageAssets,
      density: totalAssets ? (rwa / totalAssets) * 100 : 0,
      loanWeightPct: loans ? (loanRwa / loans) * 100 : 0,
      capital: { equity: g('RCON3210'), aoci: g('RCONB530'), deductions: g('RCONP841') + g('RCONP842'), cet1, additionalTier1, tier1, allowance, allowanceInTier2, allowanceExcluded: allowance - allowanceInTier2, tier2, totalCapital },
      ratios,
      bufferPct,
      distributionsLimited: bufferPct < CONSERVATION_BUFFER,
      binding,
      cblr: {
        elected: (v.get('RCONLE74') ?? 1) !== 0,
        leveragePct: ratios[3]!.pct,
        abovePct: ratios[3]!.pct - CBLR_PCT,
        above: tier1 - (CBLR_PCT / 100) * leverageAssets,
        obsNotional,
        obsPct: totalAssets ? (obsNotional / totalAssets) * 100 : 0,
        eligible: totalAssets < CBLR_ASSET_MAX && obsNotional <= totalAssets * CBLR_OBS_MAX && ratios[3]!.pct > CBLR_PCT,
      },
    };
  }

  /** The latest quarter, every quarter on file, and the risk-based ratios through the stress test. */
  async analysis() {
    if (this.institutionType !== 'bank') return null;
    const by = await this.values();
    const ends = [...by.keys()].sort();
    if (!ends.length) return null;
    const quarters = ends.map((e) => this.compute(e, by.get(e)!));
    const now = quarters.at(-1)!;
    return { now, quarters, stress: await this.stress(now), assumptions: this.assumptions() };
  }

  /** What adding (or running off) loans of one type does to the ratios, with capital unchanged. */
  whatIf(now: ReturnType<BaselService['compute']>, weightPct: number, amount: number) {
    const rwa = now.rwa + (amount * weightPct) / 100;
    const leverageAssets = now.leverageAssets + amount;
    const allowanceInTier2 = Math.min(now.capital.allowance, rwa * ACL_CAP);
    const c = now.capital;
    const pct = (capital: number, base: number) => (base ? (capital / base) * 100 : 0);
    return {
      rwa,
      ratios: [
        { key: 'cet1' as const, pct: pct(c.cet1, rwa) },
        { key: 'tier1' as const, pct: pct(c.tier1, rwa) },
        { key: 'total' as const, pct: pct(c.tier1 + allowanceInTier2, rwa) },
        { key: 'leverage' as const, pct: pct(c.tier1, leverageAssets) },
      ],
    };
  }

  /** The risk-based ratios over the stress test's nine quarters: risk-weighted assets move with total assets, less the loans charged off. */
  private async stress(now: ReturnType<BaselService['compute']>) {
    const st = await new StressService(this.pool, 'bank').analysis();
    if (!st) return null;
    const startAssets = st.start.assets;
    return st.runs.map((r) => {
      let charged = 0;
      const quarters = r.quarters.map((q) => {
        charged += q.chargeOffs;
        const rwa = now.rwa * (q.assets / startAssets) - charged * (now.loanWeightPct / 100);
        const tier1 = q.capital;
        const t2 = Math.min(q.allowance, rwa * ACL_CAP);
        return { quarter: q.quarter, rwa, cet1Pct: (tier1 / rwa) * 100, tier1Pct: (tier1 / rwa) * 100, totalPct: ((tier1 + t2) / rwa) * 100, leveragePct: q.ratioPct };
      });
      const low = (k: 'cet1Pct' | 'totalPct' | 'leveragePct') => quarters.reduce((m, q) => (q[k] < m[k] ? q : m), quarters[0]!);
      return { key: r.scenario.key as ScenarioKey, name: r.scenario.name, quarters, lowCet1: low('cet1Pct'), lowTotal: low('totalPct'), lowLeverage: low('leveragePct') };
    });
  }

  assumptions(): [string, string][] {
    const A = BASEL_ASSUMPTIONS;
    return [
      ['Basis', 'The standardized approach for community banks (12 CFR 3, 217 and 324), from the latest FFIEC 051 Call Report. DI’s estimate, not a filed RC-R Part II.'],
      ['Capital', 'CET1 is equity less accumulated other comprehensive income (the AOCI opt-out election) and less goodwill and other intangibles (RCONP841, RCONP842); there are no deferred tax assets to deduct. No additional tier 1 or subordinated debt. Tier 2 is the allowance, up to 1.25% of risk-weighted assets.'],
      ['Cash', `${A.cashVaultShare * 100}% of cash and noninterest-bearing balances is currency and coin (0%), the rest due from US banks (20%); interest-bearing balances are at the Federal Reserve (0%).`],
      ['Securities', `At amortized cost: ${A.securities.map((s) => `${s.name} ${Math.round(s.share * 100)}% at ${s.weight}%`).join('; ')}. The Call Report DI holds gives totals, not this mix.`],
      ['Construction loans', `${A.hvcreShare * 100}% are high-volatility commercial real estate (150%); the rest meet the exemptions (100%).`],
      ['Multifamily', 'All at 100%; loans meeting the statutory multifamily test would be 50%.'],
      ['Past due', 'Loans past due 90 days or more and nonaccrual loans are weighted 50 points higher (150%, residential mortgages 100%).'],
      ['Commitments', A.commitments.map((c) => `${c.name} ${Math.round(c.share * 100)}% of balance, conversion factor ${c.ccf}%`).join('; ') + '. The Call Report DI holds has no RC-L.'],
      ['Thresholds', 'Minimums CET1 4.5%, tier 1 6%, total 8%, leverage 4%; the 2.5% conservation buffer on the risk-based ratios; well capitalized at 6.5%, 8%, 10% and 5%. The community bank leverage ratio requires 8% from July 1, 2026.'],
      ['Stress test', 'Risk-weighted assets move with total assets in each scenario, less the loans charged off; tier 1 capital and the allowance come from the stress test.'],
    ];
  }
}
