// ESP alignment, phase 3: what a loan is worth as collateral. Lien positions (finbi_lienposition),
// participations bought and sold with the investor on each (finbi_loanparticipationtypes, fhlb_investors,
// the loan's percentOwnership, retainedBalance and investorNumber), and the FHLB's qualifying collateral
// report: which real-estate loans can be pledged and, for those that can't, every reason, ranked
// (fhlb_ineligibilitytypes, fhlb_ineligibilities, fhlb_manualineligibilities).
//
// cdm_loan.balance stays the institution's own balance: on a participation sold it is the part kept, and
// the whole loan's balance sits here. Tables of their own; nothing generated before changes. Draws are
// unit() on salts 2901 to 2949.
import { AS_OF, unit } from './generate.ts';

export const ESP_COLLATERAL_DDL = [
  `CREATE TABLE cdm_lien_position (lien_position_id TINYINT PRIMARY KEY, name VARCHAR(30) NOT NULL, short_name VARCHAR(8) NOT NULL, description VARCHAR(160) NOT NULL)`,
  `CREATE TABLE cdm_participation_type (participation_type_id VARCHAR(12) PRIMARY KEY, name VARCHAR(40) NOT NULL, description VARCHAR(200) NOT NULL)`,
  `CREATE TABLE cdm_fhlb_investor (investor_number VARCHAR(12) PRIMARY KEY, name VARCHAR(80) NOT NULL, description VARCHAR(200) NULL)`,
  `CREATE TABLE cdm_loan_collateral (loan_id INT PRIMARY KEY, lien_position_id TINYINT NULL, fhlb_category VARCHAR(40) NULL, fhlb_credit_score SMALLINT NULL, participation_type_id VARCHAR(12) NULL, percent_owned DECIMAL(5,2) NOT NULL, gross_balance DECIMAL(14,2) NOT NULL, retained_balance DECIMAL(14,2) NOT NULL, investor_number VARCHAR(12) NULL, KEY ix_coll_cat (fhlb_category))`,
  `CREATE TABLE cdm_fhlb_ineligibility_type (type_id TINYINT PRIMARY KEY, code VARCHAR(16) NOT NULL, name VARCHAR(80) NOT NULL, ranking TINYINT NOT NULL, informational TINYINT NOT NULL)`,
  `CREATE TABLE cdm_fhlb_ineligibility (loan_id INT NOT NULL, type_id TINYINT NOT NULL, ranking TINYINT NOT NULL, manual_id INT NULL, PRIMARY KEY (loan_id, type_id))`,
  `CREATE TABLE cdm_fhlb_manual_ineligibility (manual_id INT PRIMARY KEY, loan_id INT NOT NULL, type_id TINYINT NOT NULL, note VARCHAR(200) NOT NULL, entered_by VARCHAR(60) NOT NULL, entered_on DATE NOT NULL, KEY ix_fmi_loan (loan_id))`,
];

export const ESP_COLLATERAL_COLUMNS = {
  cdm_lien_position: ['lien_position_id', 'name', 'short_name', 'description'],
  cdm_participation_type: ['participation_type_id', 'name', 'description'],
  cdm_fhlb_investor: ['investor_number', 'name', 'description'],
  cdm_loan_collateral: ['loan_id', 'lien_position_id', 'fhlb_category', 'fhlb_credit_score', 'participation_type_id', 'percent_owned', 'gross_balance', 'retained_balance', 'investor_number'],
  cdm_fhlb_ineligibility_type: ['type_id', 'code', 'name', 'ranking', 'informational'],
  cdm_fhlb_ineligibility: ['loan_id', 'type_id', 'ranking', 'manual_id'],
  cdm_fhlb_manual_ineligibility: ['manual_id', 'loan_id', 'type_id', 'note', 'entered_by', 'entered_on'],
} as const;

const LIENS = [
  [1, 'First lien', '1st', 'The first claim on the property; a first mortgage or a home equity line with no mortgage ahead of it.'],
  [2, 'Second lien', '2nd', 'Behind a first mortgage; paid only after it in a foreclosure.'],
  [3, 'Third or lower lien', '3rd+', 'Behind two or more other liens.'],
];
const PARTICIPATIONS = [
  ['WHOLE', 'Whole loan', 'The institution made and holds all of the loan.'],
  ['SOLD', 'Participation sold', 'The institution made the loan and sold a share of it to other lenders; it keeps the rest and services it.'],
  ['PURCHASED', 'Participation purchased', 'A share of a loan another lender made and services.'],
];
/** Banks a commercial participation is sold to or bought from. */
const INVESTORS = [
  ['INV-101', 'Kingsbridge Valley Bank', 'Buys shares of commercial real estate loans over $1M.'],
  ['INV-102', 'Ashgrove Savings Bank', 'Buys shares of commercial real estate and business loans.'],
  ['INV-103', 'Tamarack Community Bank', 'Sells shares of its larger commercial real estate loans; the lead lender on those bought.'],
  ['INV-104', 'Cedar Hollow Bank & Trust', 'Lead lender on business real estate loans bought.'],
];

/** The FHLB's reasons a loan can't be pledged, ranked: the first that applies is the one reported. */
export const INELIGIBILITY_TYPES: [id: number, code: string, name: string, informational: number][] = [
  [1, 'DELINQUENT', 'Delinquent 60 days or more', 0],
  [2, 'CLASSIFIED', 'Classified substandard or worse', 0],
  [3, 'INSIDER', 'Loan to a director, officer or employee', 0],
  [4, 'PURCHASED', 'Participation purchased from another lender', 0],
  [5, 'LTV', 'Loan-to-value over the FHLB’s limit', 0],
  [6, 'DOCS', 'Note or mortgage missing from the collateral file', 0],
  [7, 'CONSTRUCTION', 'Construction loan', 0],
  [8, 'FICO', 'Credit score 660 or below', 1],
  [9, 'NO_SCORE', 'No credit score on file', 1],
];
/** Loan-to-value limits the FHLB applies by collateral category. */
export const FHLB_LTV_LIMIT: Record<string, number> = { 'One-to-four family first liens': 95, 'Home equity': 90, 'Commercial real estate': 80 };

const MANUAL_NOTES = ['Original note not in the vault; imaged copy only.', 'Assignment of mortgage not recorded.', 'Title policy missing from the file.', 'Mortgage not signed by all owners on title.'];

export interface CollateralInputs {
  institutionType: 'bank' | 'credit_union';
  loans: unknown[][];
  /** cdm_insider_loan rows: [loan, party, kind, effective, expiration, approved]. */
  insiderLoans: unknown[][];
}

export function generateCollateral(x: CollateralInputs) {
  const bank = x.institutionType === 'bank';
  const asOf = new Date(`${AS_OF}T00:00:00Z`);
  const insider = new Set(x.insiderLoans.filter((r) => !r[4]).map((r) => Number(r[0])));
  const collateral: unknown[][] = [];
  const ineligible: unknown[][] = [];
  const manual: unknown[][] = [];
  const loans = x.loans as [number, number, number, number, string, number, string, string | null, string | null, number, number, number, number, number | null, number | null, number, number | null][];
  for (const l of loans) {
    const [id, , , , cat, , , close, chargeOff, , balance, , days, score, ltv, , rating] = l;
    if (close || chargeOff || !(balance > 0)) continue;
    const category = cat === 'Mortgage' ? 'One-to-four family first liens' : cat === 'HELOC' ? 'Home equity' : cat === 'Commercial Real Estate' ? 'Commercial real estate' : null;
    const lien = cat === 'Mortgage' ? 1 : cat === 'HELOC' ? (unit(id, 2901) < 0.15 ? 1 : 2) : cat === 'Commercial Real Estate' ? (unit(id, 2901) < 0.05 ? 2 : 1) : null;
    // A bank's commercial participations: larger loans partly sold to other banks, and a few bought.
    let type: string | null = null;
    let owned = 100;
    let investor: string | null = null;
    if (bank && (cat === 'Commercial Real Estate' || cat === 'Commercial & Industrial')) {
      if (balance >= 900_000 && unit(id, 2902) < 0.55) {
        type = 'SOLD';
        owned = Math.round(50 + unit(id, 2903) * 25);
        investor = INVESTORS[Math.floor(unit(id, 2904) * 2)]![0]!;
      } else if (unit(id, 2905) < 0.06) {
        type = 'PURCHASED';
        investor = INVESTORS[2 + Math.floor(unit(id, 2906) * 2)]![0]!;
      } else type = 'WHOLE';
    }
    if (!category && !type) continue;
    const gross = Math.round((balance * 100) / owned * 100) / 100;
    collateral.push([id, lien, category, category ? score : null, type, owned, gross, balance, investor]);
    if (!category) continue;
    // Every reason that applies, ranked; the first is the one the report shows.
    const reasons: [number, number | null][] = [];
    if (days >= 60) reasons.push([1, null]);
    if (rating !== null && rating >= 7) reasons.push([2, null]);
    if (insider.has(id)) reasons.push([3, null]);
    if (type === 'PURCHASED') reasons.push([4, null]);
    if (ltv !== null && ltv > FHLB_LTV_LIMIT[category]!) reasons.push([5, null]);
    // A collateral review found a document missing on a few files.
    if (unit(id, 2907) < 0.008) {
      const manualId = manual.length + 1;
      const on = new Date(asOf.getTime() - Math.floor(unit(id, 2908) * 270) * 86_400_000).toISOString().slice(0, 10);
      manual.push([manualId, id, 6, MANUAL_NOTES[Math.floor(unit(id, 2909) * MANUAL_NOTES.length)]!, 'Collateral review', on]);
      reasons.push([6, manualId]);
    }
    if (score === null) reasons.push([9, null]);
    else if (score <= 660) reasons.push([8, null]);
    for (const [t, m] of reasons) ineligible.push([id, t, INELIGIBILITY_TYPES.find((y) => y[0] === t)![0], m]);
  }
  return {
    liens: LIENS,
    participationTypes: PARTICIPATIONS,
    investors: bank ? INVESTORS : [],
    types: INELIGIBILITY_TYPES.map(([id, code, name, info]) => [id, code, name, id, info]),
    collateral,
    ineligible,
    manual,
  };
}

const SIXTY_PLUS = new Set(['60–89 days', '90–179 days', '180–359 days', '360+ days']);

export interface CollateralHistoryInputs {
  loans: unknown[][];
  /** [month end, loan, balance, delinquency status], from the generator. */
  loanMonths: unknown[][];
  /** cdm_insider_loan rows: [loan, party, kind, effective, expiration, approved]. */
  insiderLoans: unknown[][];
  /** This generator's collateral and manual rows, for participations bought and files missing a document. */
  collateral: unknown[][];
  manual: unknown[][];
}

/**
 * The qualifying collateral report at each quarter-end in the history (fhlb_loanprod1histyq): real-estate
 * loans by collateral category and first-ranked reason, at that month-end's balance and delinquency. The
 * loan's rating, score and loan-to-value are today's, and a loan's participation and insider status count
 * from when they began; a file's missing document counts from the review that found it.
 */
export function collateralHistory(x: CollateralHistoryInputs) {
  const loans = new Map((x.loans as unknown[][]).map((l) => [Number(l[0]), l]));
  const purchased = new Set((x.collateral as unknown[][]).filter((c) => c[4] === 'PURCHASED').map((c) => Number(c[0])));
  const docs = new Map((x.manual as unknown[][]).map((m) => [Number(m[1]), String(m[5])]));
  const insider = (x.insiderLoans as unknown[][]).map((r) => ({ loan: Number(r[0]), from: String(r[3]), to: r[4] ? String(r[4]) : null }));
  const agg = new Map<string, [number, number]>();
  for (const [me, id, balance, status] of x.loanMonths as [string, number, number, string][]) {
    if (!/-(03|06|09|12)-/.test(me)) continue;
    const l = loans.get(id);
    if (!l) continue;
    const cat = String(l[4]);
    const category = cat === 'Mortgage' ? 'One-to-four family first liens' : cat === 'HELOC' ? 'Home equity' : cat === 'Commercial Real Estate' ? 'Commercial real estate' : null;
    if (!category) continue;
    const rating = l[16] as number | null;
    const ltv = l[14] as number | null;
    const reason = SIXTY_PLUS.has(status)
      ? 1
      : rating !== null && rating >= 7
        ? 2
        : insider.some((i) => i.loan === id && i.from <= me && (!i.to || i.to > me))
          ? 3
          : purchased.has(id)
            ? 4
            : ltv !== null && ltv > FHLB_LTV_LIMIT[category]!
              ? 5
              : docs.has(id) && docs.get(id)! <= me
                ? 6
                : null;
    const key = `${me}|${category}|${reason ?? ''}`;
    const v = agg.get(key) ?? [0, 0];
    v[0] += 1;
    v[1] += balance;
    agg.set(key, v);
  }
  return [...agg].map(([k, [n, b]]) => {
    const [me, category, reason] = k.split('|');
    return [me, category, reason ? Number(reason) : null, n, Math.round(b * 100) / 100];
  });
}
