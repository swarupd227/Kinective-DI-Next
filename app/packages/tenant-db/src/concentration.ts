// The detail a concentration review needs that the core's loan table doesn't carry: for each commercial
// loan, the property type and whether the owner occupies it, the county, the borrower's industry (NAICS
// sector), the balloon maturity, the debt service coverage and the latest appraisal. A bank's loan system
// or credit file holds these; DI loads them beside the loan. Property types are assigned so they add up
// to the Call Report's RC-C lines (construction, multifamily, owner-occupied and other nonfarm
// nonresidential).
import type { GeneratedTenant } from './generate.ts';

export const CONCENTRATION_DDL = [
  `CREATE TABLE cdm_loan_detail (
     loan_id INT PRIMARY KEY,
     property_type VARCHAR(30) NULL,
     owner_occupied TINYINT NULL,
     county VARCHAR(40) NOT NULL,
     state CHAR(2) NOT NULL,
     naics_sector VARCHAR(4) NULL,
     industry VARCHAR(60) NULL,
     maturity_date DATE NULL,
     dscr DECIMAL(5,2) NULL,
     appraised_value DECIMAL(14,2) NULL,
     appraisal_date DATE NULL,
     relationship_id INT NOT NULL,
     KEY ix_detail_county (county),
     KEY ix_detail_type (property_type)
   )`,
];

const unit = (id: number, salt: number) => {
  let h = (id * 2654435761 + salt * 40503) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const weighted = <T>(xs: readonly (readonly [T, number])[], u: number) => {
  let t = 0;
  for (const [x, w] of xs) {
    t += w;
    if (u < t) return x;
  }
  return xs.at(-1)![0];
};

/** Each branch's home county; a few commercial loans sit outside the bank's markets. */
const COUNTY_BY_BRANCH: Record<number, [string, string]> = { 1: ['Harbor County', 'WA'], 2: ['Harbor County', 'WA'], 3: ['Metro County', 'WA'], 4: ['Metro County', 'WA'], 5: ['Pine County', 'WA'] };
const OUT_OF_MARKET: [string, string][] = [['Maricopa County', 'AZ'], ['Clark County', 'NV'], ['Multnomah County', 'OR']];
/** Property types by share of CRE balances; the four RC-C groups match the Call Report's split. */
const PROPERTY: readonly (readonly [[string, number], number])[] = [
  [['Construction and land', 0], 0.18],
  [['Multifamily', 0], 0.22],
  [['Owner-occupied office', 1], 0.05],
  [['Owner-occupied industrial', 1], 0.06],
  [['Owner-occupied retail', 1], 0.04],
  [['Office', 0], 0.17],
  [['Retail', 0], 0.12],
  [['Industrial and warehouse', 0], 0.09],
  [['Hotel', 0], 0.05],
  [['Other nonresidential', 0], 0.02],
];
/** C&I borrowers by NAICS sector. */
const INDUSTRY: readonly (readonly [[string, string], number])[] = [
  [['62', 'Health care and social assistance'], 0.21],
  [['23', 'Construction'], 0.15],
  [['44', 'Retail trade'], 0.11],
  [['31', 'Manufacturing'], 0.1],
  [['72', 'Accommodation and food services'], 0.09],
  [['54', 'Professional and technical services'], 0.09],
  [['48', 'Transportation and warehousing'], 0.08],
  [['42', 'Wholesale trade'], 0.07],
  [['11', 'Agriculture, forestry and fishing'], 0.05],
  [['81', 'Other services'], 0.05],
];
/** Debt service coverage by property type: hotels and offices run thinner. */
const DSCR: Record<string, [number, number]> = { Office: [1.05, 0.55], Hotel: [1.1, 0.6], Retail: [1.2, 0.55], Multifamily: [1.25, 0.45], 'Industrial and warehouse': [1.35, 0.5], 'Construction and land': [1.0, 0.0] };

/** One detail row for each open commercial loan, keyed by loan number. */
export function generateLoanDetail(t: GeneratedTenant) {
  const rows: unknown[][] = [];
  for (const l of t.loans as unknown[][]) {
    const [id, party, branch, , category, , open, close, chargeOff, , balance, , , , ltv, term] = l as [number, number, number, number, string, number, string, string | null, string | null, number, number, number, number, number | null, number | null, number | null];
    if (close !== null || chargeOff !== null || (category !== 'Commercial Real Estate' && category !== 'Commercial & Industrial')) continue;
    const [county, state] = unit(id, 1) < 0.045 ? OUT_OF_MARKET[Math.floor(unit(id, 2) * OUT_OF_MARKET.length)]! : COUNTY_BY_BRANCH[branch] ?? ['Harbor County', 'WA'];
    // About one borrower in eight has two or three related loans: the relationship is the first party's.
    const relationship = unit(party, 3) < 0.12 ? party - (party % 3) : party;
    if (category === 'Commercial Real Estate') {
      const [type, owner] = weighted(PROPERTY, unit(id, 4));
      // Commercial real estate loans balloon in five to ten years from origination.
      const years = [5, 7, 10][Math.floor(unit(id, 5) * 3)]!;
      let maturity = new Date(`${open}T00:00:00Z`);
      maturity.setUTCFullYear(maturity.getUTCFullYear() + years);
      // A loan past its first balloon has been renewed for another five years.
      while (maturity.toISOString().slice(0, 10) < '2026-11-01') maturity = new Date(Date.UTC(maturity.getUTCFullYear() + 5, maturity.getUTCMonth(), maturity.getUTCDate()));
      const [base, spread] = DSCR[type] ?? [1.3, 0.5];
      const dscr = type === 'Construction and land' ? null : Math.round((base + unit(id, 6) * spread) * 100) / 100;
      // The latest appraisal: the loan-to-value at origination on the original amount, refreshed for some.
      // Office values have fallen since origination, hotels and retail less so: their loan-to-values run higher.
      const skew = type === 'Office' ? 1.22 : type === 'Hotel' ? 1.12 : type === 'Retail' ? 1.06 : 1;
      const value = Math.round((Number(balance) / Math.max(0.35, Math.min(0.92, (Number(ltv ?? 70) / 100) * (0.75 + unit(id, 7) * 0.3) * skew))) * 100) / 100;
      const appraised = unit(id, 8) < 0.3 ? '2025-0' + (1 + Math.floor(unit(id, 9) * 9)) + '-15' : open;
      rows.push([id, type, owner, county, state, owner ? weighted(INDUSTRY, unit(id, 10))[0] : null, owner ? weighted(INDUSTRY, unit(id, 10))[1] : null, maturity.toISOString().slice(0, 10), dscr, value, appraised, relationship]);
    } else {
      const [sector, industry] = weighted(INDUSTRY, unit(id, 11));
      const maturity = new Date(`${open}T00:00:00Z`);
      maturity.setUTCMonth(maturity.getUTCMonth() + Number(term ?? 60));
      rows.push([id, null, null, county, state, sector, industry, maturity.toISOString().slice(0, 10), null, null, null, relationship]);
    }
  }
  return rows;
}
