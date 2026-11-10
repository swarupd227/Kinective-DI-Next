// Concentration risk for a bank: commercial real estate against the 2006 interagency guidance (from the
// Call Report), then what the guidance asks a bank to watch beyond it: property types (office above all
// now), geography, industry and single relationships, each against the board's limits, with the office
// loans that balloon soon and what a fall in property values would leave uncovered. Limits are expressed
// as a share of tier 1 capital plus the allowance, the guidance's own base.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/** The board's concentration limits for the demo bank, percent of tier 1 capital plus the allowance; a bank sets its own. */
export const CONCENTRATION_LIMITS = {
  /** The interagency guidance's thresholds. */
  creGuidancePct: 300,
  constructionGuidancePct: 100,
  growthGuidancePct: 50,
  property: { Office: 50, Retail: 40, Hotel: 20, Multifamily: 75, 'Industrial and warehouse': 40, 'Construction and land': 75 } as Record<string, number>,
  industryPct: 40,
  outOfMarketPctOfLoans: 5,
  largestCountyPctOfLoans: 60,
  /** The legal lending limit to one borrower: 15% of capital and surplus, here tier 1 plus the allowance. */
  legalLendingPct: 15,
  /** The bank's house limit, below the legal one. */
  houseLimitPct: 10,
};
/** A limit is close at this share of it. */
export const CONCENTRATION_WATCH = 0.85;
/** Property value falls in the stress: office has fallen furthest since 2022. */
export const CONCENTRATION_STRESS: Record<string, number> = { Office: 35, Retail: 20, Hotel: 25, Multifamily: 15, 'Industrial and warehouse': 10, 'Construction and land': 25 };
const HOME_STATE = 'WA';

export type ConcentrationStatus = 'Within' | 'Watch' | 'Over';
const status = (value: number, limit: number): ConcentrationStatus => (value > limit ? 'Over' : value >= limit * CONCENTRATION_WATCH ? 'Watch' : 'Within');

export class ConcentrationService {
  constructor(private readonly pool: Pool) {}

  async analysis() {
    const codes = ['RCONF158', 'RCONF159', 'RCON1460', 'RCONF160', 'RCONF161', 'RCON8274', 'RCON3123', 'RCON2122'];
    const cr = await rows<{ code: string; q: unknown; amount: number }>(this.pool, `SELECT code, quarter_end AS q, amount FROM cr_value WHERE code IN (${codes.map(() => '?').join(', ')}) ORDER BY quarter_end`, codes).catch(() => []);
    if (!cr.length) return null;
    const quarters = [...new Set(cr.map((r) => day(r.q)))];
    const at = (q: string, c: string) => Number(cr.find((r) => day(r.q) === q && r.code === c)?.amount ?? 0);
    const now = quarters.at(-1)!;
    const capital = at(now, 'RCON8274') + at(now, 'RCON3123');
    const nonOwner = (q: string) => at(q, 'RCONF158') + at(q, 'RCONF159') + at(q, 'RCON1460') + at(q, 'RCONF161');
    const construction = (q: string) => at(q, 'RCONF158') + at(q, 'RCONF159');
    const first = quarters[0]!;
    const regulatory = {
      asOf: now,
      capital,
      nonOwnerCre: nonOwner(now),
      ownerOccupied: at(now, 'RCONF160'),
      multifamily: at(now, 'RCON1460'),
      otherNonres: at(now, 'RCONF161'),
      construction: construction(now),
      crePct: (nonOwner(now) / capital) * 100,
      constructionPct: (construction(now) / capital) * 100,
      /** Growth over the history on file (a year): the guidance's test is 36 months. */
      growthPct: nonOwner(first) ? ((nonOwner(now) - nonOwner(first)) / nonOwner(first)) * 100 : null,
      growthMonths: Math.round((Date.parse(now) - Date.parse(first)) / (30.44 * 86_400_000)),
      trend: quarters.map((q) => ({ quarter: q, crePct: (nonOwner(q) / (at(q, 'RCON8274') + at(q, 'RCON3123'))) * 100, constructionPct: (construction(q) / (at(q, 'RCON8274') + at(q, 'RCON3123'))) * 100 })),
    };

    const [build] = await rows<{ d: unknown }>(this.pool, 'SELECT MAX(as_of_date) AS d FROM meta_build');
    const asOf = day(build?.d ?? now);
    const loans = await rows<{ loan_id: number; party_id: number; category: string; balance: number; branch: string; property_type: string | null; owner_occupied: number | null; county: string | null; state: string | null; industry: string | null; naics_sector: string | null; maturity_date: unknown; dscr: number | null; appraised_value: number | null; relationship_id: number | null }>(
      this.pool,
      `SELECT l.loan_id, l.party_id, l.loan_category AS category, l.balance, b.name AS branch, d.property_type, d.owner_occupied, d.county, d.state, d.industry, d.naics_sector, d.maturity_date, d.dscr, d.appraised_value, d.relationship_id
         FROM cdm_loan l JOIN cdm_location b ON b.int_id = l.branch_id LEFT JOIN cdm_loan_detail d ON d.loan_id = l.loan_id
        WHERE l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0`,
    );
    const hasDetail = loans.some((l) => l.property_type !== null || l.industry !== null);
    const totalLoans = loans.reduce((t, l) => t + Number(l.balance), 0);
    const pctCap = (n: number) => (n / capital) * 100;
    const in24 = new Date(`${asOf}T00:00:00Z`);
    in24.setUTCMonth(in24.getUTCMonth() + 24);
    const soon = in24.toISOString().slice(0, 10);

    // Property types: balance, share of capital against the board's limit, loan-to-value on the latest appraisal, coverage, and what balloons in two years.
    const cre = loans.filter((l) => l.category === 'Commercial Real Estate' && l.property_type);
    const types = [...new Set(cre.map((l) => l.property_type!))];
    const property = types
      .map((t) => {
        const ls = cre.filter((l) => l.property_type === t);
        const balance = ls.reduce((s, l) => s + Number(l.balance), 0);
        const valued = ls.filter((l) => l.appraised_value);
        const value = valued.reduce((s, l) => s + Number(l.appraised_value), 0);
        const withDscr = ls.filter((l) => l.dscr !== null);
        const dscr = withDscr.length ? withDscr.reduce((s, l) => s + Number(l.dscr) * Number(l.balance), 0) / withDscr.reduce((s, l) => s + Number(l.balance), 0) : null;
        const maturing = ls.filter((l) => l.maturity_date && day(l.maturity_date) <= soon);
        const limit = CONCENTRATION_LIMITS.property[t] ?? null;
        const pct = pctCap(balance);
        // The stress: values fall by the type's shock; a loan above 100% of the stressed value is short by the difference.
        const fall = (CONCENTRATION_STRESS[t] ?? 10) / 100;
        const short = valued.reduce((s, l) => s + Math.max(0, Number(l.balance) - Number(l.appraised_value) * (1 - fall)), 0);
        const underwater = valued.filter((l) => Number(l.balance) > Number(l.appraised_value) * (1 - fall));
        return {
          type: t,
          ownerOccupied: Boolean(ls[0]?.owner_occupied),
          loans: ls.length,
          balance,
          pctOfCre: 0,
          pctOfCapital: pct,
          limit,
          status: limit === null ? ('Within' as ConcentrationStatus) : status(pct, limit),
          ltvPct: value ? (valued.reduce((s, l) => s + Number(l.balance), 0) / value) * 100 : null,
          dscr,
          thinDscr: withDscr.filter((l) => Number(l.dscr) < 1.15).reduce((s, l) => s + Number(l.balance), 0),
          maturing24: maturing.reduce((s, l) => s + Number(l.balance), 0),
          maturingLoans: maturing.length,
          stressFallPct: fall * 100,
          stressShortfall: short,
          stressLoans: underwater.length,
        };
      })
      .sort((a, b) => b.balance - a.balance);
    const creTotal = property.reduce((s, p) => s + p.balance, 0);
    for (const p of property) p.pctOfCre = creTotal ? (p.balance / creTotal) * 100 : 0;
    const office = property.filter((p) => /office/i.test(p.type));
    const officeLoans = cre.filter((l) => /office/i.test(l.property_type ?? ''));
    const officeMaturities = [0, 1, 2, 3].map((y) => {
      const from = new Date(`${asOf}T00:00:00Z`);
      from.setUTCFullYear(from.getUTCFullYear() + y);
      const to = new Date(from);
      to.setUTCFullYear(to.getUTCFullYear() + 1);
      const ls = officeLoans.filter((l) => l.maturity_date && day(l.maturity_date) > from.toISOString().slice(0, 10) && day(l.maturity_date) <= to.toISOString().slice(0, 10));
      return { year: y + 1, from: from.toISOString().slice(0, 10), loans: ls.length, balance: ls.reduce((s, l) => s + Number(l.balance), 0), thinDscr: ls.filter((l) => l.dscr !== null && Number(l.dscr) < 1.15).reduce((s, l) => s + Number(l.balance), 0) };
    });

    // Geography: every loan's county (the branch's for consumer loans), and loans outside the bank's state.
    const countyOf = (l: (typeof loans)[number]) => (l.county ? `${l.county}, ${l.state}` : l.branch === 'Midtown' || l.branch === 'Westfield' ? `Metro County, ${HOME_STATE}` : l.branch === 'Pinecrest' ? `Pine County, ${HOME_STATE}` : `Harbor County, ${HOME_STATE}`);
    const byCounty = new Map<string, { balance: number; commercial: number }>();
    for (const l of loans) {
      const k = countyOf(l);
      const v = byCounty.get(k) ?? { balance: 0, commercial: 0 };
      v.balance += Number(l.balance);
      if (l.category === 'Commercial Real Estate' || l.category === 'Commercial & Industrial') v.commercial += Number(l.balance);
      byCounty.set(k, v);
    }
    const geography = [...byCounty]
      .map(([county, v]) => ({ county, inMarket: county.endsWith(`, ${HOME_STATE}`), balance: v.balance, commercial: v.commercial, pctOfLoans: (v.balance / totalLoans) * 100, pctOfCapital: pctCap(v.commercial) }))
      .sort((a, b) => b.balance - a.balance);
    const outOfMarket = geography.filter((g) => !g.inMarket).reduce((s, g) => s + g.balance, 0);

    // Industry: commercial loans to businesses (C&I and owner-occupied real estate) by NAICS sector.
    const biz = loans.filter((l) => l.industry);
    const sectors = [...new Set(biz.map((l) => l.industry!))];
    const industry = sectors
      .map((s) => {
        const ls = biz.filter((l) => l.industry === s);
        const balance = ls.reduce((t, l) => t + Number(l.balance), 0);
        const pct = pctCap(balance);
        return { industry: s, naics: ls[0]!.naics_sector, loans: ls.length, balance, pctOfCapital: pct, limit: CONCENTRATION_LIMITS.industryPct, status: status(pct, CONCENTRATION_LIMITS.industryPct) };
      })
      .sort((a, b) => b.balance - a.balance);

    // Relationships: a borrower and the loans tied to it, against the house and legal lending limits.
    const rel = new Map<number, { balance: number; loans: number; types: Set<string> }>();
    for (const l of loans.filter((x) => x.relationship_id !== null)) {
      const r = rel.get(l.relationship_id!) ?? { balance: 0, loans: 0, types: new Set<string>() };
      r.balance += Number(l.balance);
      r.loans += 1;
      r.types.add(l.property_type ?? l.industry ?? l.category);
      rel.set(l.relationship_id!, r);
    }
    const legal = (capital * CONCENTRATION_LIMITS.legalLendingPct) / 100;
    const house = (capital * CONCENTRATION_LIMITS.houseLimitPct) / 100;
    const relationships = [...rel]
      .map(([id, r]) => ({ id, balance: r.balance, loans: r.loans, what: [...r.types].slice(0, 2).join(', '), pctOfCapital: pctCap(r.balance), pctOfLegal: (r.balance / legal) * 100, status: status(r.balance, house) }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 15);
    const top20 = [...rel.values()].map((r) => r.balance).sort((a, b) => b - a).slice(0, 20).reduce((s, b) => s + b, 0);

    // Policy: every limit, actual and status.
    const lines: { area: string; measure: string; actual: string; limit: string; status: ConcentrationStatus; closeness: number }[] = [];
    const line = (area: string, measure: string, value: number, limit: number, unit = '%') => lines.push({ area, measure, actual: `${value.toFixed(value >= 100 ? 0 : 1)}${unit}`, limit: `${limit}${unit}`, status: status(value, limit), closeness: value / limit });
    line('Guidance', 'Non-owner-occupied CRE to capital', regulatory.crePct, CONCENTRATION_LIMITS.creGuidancePct);
    line('Guidance', 'Construction and land to capital', regulatory.constructionPct, CONCENTRATION_LIMITS.constructionGuidancePct);
    for (const p of property.filter((x) => x.limit !== null)) line('Property type', `${p.type} to capital`, p.pctOfCapital, p.limit!);
    if (industry[0]) line('Industry', `${industry[0].industry} (largest) to capital`, industry[0].pctOfCapital, CONCENTRATION_LIMITS.industryPct);
    if (geography[0]) line('Geography', `${geography[0].county} (largest) share of loans`, geography[0].pctOfLoans, CONCENTRATION_LIMITS.largestCountyPctOfLoans);
    line('Geography', 'Loans outside Washington, share of loans', (outOfMarket / totalLoans) * 100, CONCENTRATION_LIMITS.outOfMarketPctOfLoans);
    if (relationships[0]) line('Relationship', 'Largest relationship to capital', relationships[0].pctOfCapital, CONCENTRATION_LIMITS.houseLimitPct);
    const order = { Over: 0, Watch: 1, Within: 2 } as const;
    lines.sort((a, b) => order[a.status] - order[b.status] || b.closeness - a.closeness);

    return { asOf, regulatory, hasDetail, totalLoans, creTotal, property, office, officeMaturities, geography, outOfMarket, industry, relationships, top20, legal, house, lines, limits: CONCENTRATION_LIMITS };
  }

  assumptions(): [string, string][] {
    return [
      ['Regulatory ratios', 'From the FFIEC 051 Call Report (RC-C): construction and land (RCONF158, RCONF159), multifamily (RCON1460) and other nonfarm nonresidential (RCONF161) over tier 1 capital (RCON8274) plus the allowance (RCON3123), against the 2006 interagency guidance’s 300%, and construction against 100%. Owner-occupied CRE (RCONF160) is left out, as the guidance does. Its other test, growth of 50% or more over 36 months, needs three years of Call Reports; DI shows growth over the history on file.'],
      ['Property type, county, industry', 'From the commercial loan detail beside each loan: the property type and whether the owner occupies it, the county, the borrower’s NAICS sector, the balloon maturity, the debt service coverage and the latest appraisal. Consumer and residential loans take their branch’s county.'],
      ['Board limits', `Percent of tier 1 capital plus the allowance: office ${CONCENTRATION_LIMITS.property.Office}%, retail ${CONCENTRATION_LIMITS.property.Retail}%, hotels ${CONCENTRATION_LIMITS.property.Hotel}%, multifamily ${CONCENTRATION_LIMITS.property.Multifamily}%, industrial ${CONCENTRATION_LIMITS.property['Industrial and warehouse']}%, construction ${CONCENTRATION_LIMITS.property['Construction and land']}%; any one industry ${CONCENTRATION_LIMITS.industryPct}%; one relationship ${CONCENTRATION_LIMITS.houseLimitPct}% (the house limit; the legal lending limit is ${CONCENTRATION_LIMITS.legalLendingPct}%). The largest county may hold ${CONCENTRATION_LIMITS.largestCountyPctOfLoans}% of loans and out-of-state lending ${CONCENTRATION_LIMITS.outOfMarketPctOfLoans}%. A measure is watched at ${CONCENTRATION_WATCH * 100}% of its limit. These are the demo bank’s; a bank sets its own in its credit policy.`],
      ['Stress', `Property values fall from the latest appraisal: office ${CONCENTRATION_STRESS.Office}%, hotels ${CONCENTRATION_STRESS.Hotel}%, construction ${CONCENTRATION_STRESS['Construction and land']}%, retail ${CONCENTRATION_STRESS.Retail}%, multifamily ${CONCENTRATION_STRESS.Multifamily}% and industrial ${CONCENTRATION_STRESS['Industrial and warehouse']}%. The shortfall is the balance above the stressed value, before any guarantor or other collateral.`],
      ['Thin coverage', 'Debt service coverage under 1.15 times: the property’s income barely covers the payment, and a refinance at today’s rates may not.'],
    ];
  }
}
