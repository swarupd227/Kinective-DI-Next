// ESP alignment, step 2: loan and share products (ESP's esp_finbi_loanproddata and shareproddata), each
// loan product carrying its NCUA 5300 line, and which product each account is. Kept in tables of their
// own; the existing category columns stay, and the 5300 keeps its current category mapping until we
// choose to switch. Drawn with unit() on salts of their own, so no existing figure moves.
import { unit } from './generate.ts';

export const ESP_PRODUCT_DDL = [
  `CREATE TABLE cdm_loan_product (product_id VARCHAR(24) PRIMARY KEY, name VARCHAR(60) NOT NULL, loan_category VARCHAR(40) NOT NULL, reg_amount_code VARCHAR(12) NULL, reg_count_code VARCHAR(12) NULL, secured TINYINT NOT NULL, revolving TINYINT NOT NULL)`,
  `CREATE TABLE cdm_deposit_product (product_id VARCHAR(24) PRIMARY KEY, name VARCHAR(60) NOT NULL, deposit_category VARCHAR(40) NOT NULL, interest_bearing TINYINT NOT NULL, minimum_balance DECIMAL(12,2) NOT NULL, monthly_fee DECIMAL(8,2) NOT NULL)`,
  `CREATE TABLE cdm_account_product (account_kind VARCHAR(8) NOT NULL, account_id INT NOT NULL, product_id VARCHAR(24) NOT NULL, PRIMARY KEY (account_kind, account_id), KEY ix_acct_product (product_id))`,
];

type LoanProduct = [id: string, name: string, category: string, share: number, amount: string | null, count: string | null, secured: number, revolving: number];
type DepositProduct = [id: string, name: string, category: string, share: number, interest: number, minimum: number, fee: number];

/** A credit union's loan products, with the 5300 lines they report on (the split our category mapping approximates). */
const CU_LOANS: LoanProduct[] = [
  ['AUTO-NEW', 'New Auto Loan', 'Auto', 0.38, '385', '958', 1, 0],
  ['AUTO-USED', 'Used Auto Loan', 'Auto', 0.62, '370', '968', 1, 0],
  ['MTG-30', '30-Year Fixed Mortgage', 'Mortgage', 0.7, '703A', '959A', 1, 0],
  ['MTG-15', '15-Year Fixed Mortgage', 'Mortgage', 0.3, '703A', '959A', 1, 0],
  ['HELOC', 'Home Equity Line of Credit', 'HELOC', 1, '386A', '960A', 1, 1],
  ['SIG', 'Signature Loan', 'Personal', 0.7, '397', '994', 0, 0],
  ['PLOC', 'Personal Line of Credit', 'Personal', 0.3, '397', '994', 0, 1],
  ['VISA-PLAT', 'Visa Platinum', 'Credit Card', 0.6, '396', '993', 0, 1],
  ['VISA-REW', 'Visa Rewards', 'Credit Card', 0.4, '396', '993', 0, 1],
  ['BUS-OOCRE', 'Owner-Occupied Commercial Real Estate', 'Business', 0.6, '718A5', '900K4', 1, 0],
  ['BUS-LOC', 'Business Line of Credit', 'Business', 0.4, '400P', '900P', 0, 1],
];
const BANK_LOANS: LoanProduct[] = [
  ['CRE-INV', 'Investor Commercial Real Estate', 'Commercial Real Estate', 0.6, null, null, 1, 0],
  ['CRE-OO', 'Owner-Occupied Commercial Real Estate', 'Commercial Real Estate', 0.4, null, null, 1, 0],
  ['CI-TERM', 'Business Term Loan', 'Commercial & Industrial', 0.5, null, null, 1, 0],
  ['CI-LOC', 'Business Line of Credit', 'Commercial & Industrial', 0.5, null, null, 0, 1],
  ['MTG-30', '30-Year Fixed Mortgage', 'Mortgage', 0.7, null, null, 1, 0],
  ['MTG-15', '15-Year Fixed Mortgage', 'Mortgage', 0.3, null, null, 1, 0],
  ['AUTO', 'Auto Loan', 'Auto', 1, null, null, 1, 0],
  ['PERS', 'Personal Loan', 'Consumer', 0.6, null, null, 0, 0],
  // The bank's consumer loans are small unsecured or deposit-secured installment loans ($1k to $25k,
  // about four years), so no home equity product here: that would need a lien and a longer term.
  ['DEP-SEC', 'Deposit-Secured Loan', 'Consumer', 0.4, null, null, 1, 0],
];
const CU_DEPOSITS: DepositProduct[] = [
  ['SAV', 'Primary Share Savings', 'Share Savings', 1, 1, 5, 0],
  ['CHK-FREE', 'Free Checking', 'Checking', 0.7, 0, 0, 0],
  ['CHK-PREM', 'Premium Checking', 'Checking', 0.3, 1, 2500, 8],
  ['MM', 'Money Market Savings', 'Money Market', 1, 1, 2500, 0],
  ['CERT-12', '12-Month Certificate', 'Certificates', 0.4, 1, 500, 0],
  ['CERT-24', '24-Month Certificate', 'Certificates', 0.3, 1, 500, 0],
  ['CERT-60', '60-Month Certificate', 'Certificates', 0.3, 1, 500, 0],
  ['IRA-TRAD', 'Traditional IRA', 'IRA', 0.6, 1, 100, 0],
  ['IRA-ROTH', 'Roth IRA', 'IRA', 0.4, 1, 100, 0],
];
const BANK_DEPOSITS: DepositProduct[] = [
  ['SAV', 'Statement Savings', 'Savings', 1, 1, 100, 0],
  ['CHK-PERS', 'Personal Checking', 'Checking', 0.65, 0, 0, 5],
  ['CHK-BUS', 'Business Checking', 'Checking', 0.35, 0, 1000, 12],
  ['MM', 'Money Market', 'Money Market', 1, 1, 2500, 10],
  ['CD-12', '12-Month CD', 'Certificates of Deposit', 0.4, 1, 1000, 0],
  ['CD-24', '24-Month CD', 'Certificates of Deposit', 0.3, 1, 1000, 0],
  ['CD-60', '60-Month CD', 'Certificates of Deposit', 0.3, 1, 1000, 0],
];

const pick = <T extends [string, string, string, number, ...unknown[]]>(list: T[], category: string, u: number): T | undefined => {
  const mine = list.filter((p) => p[2] === category);
  let acc = 0;
  for (const p of mine) {
    acc += p[3];
    if (u < acc) return p;
  }
  return mine.at(-1);
};

/** loans: cdm_loan rows (id at 0, category at 4); deposits: cdm_deposit_account rows (id at 0, category at 3). */
export function generateProducts(institutionType: string, loans: unknown[][], deposits: unknown[][]) {
  const bank = institutionType === 'bank';
  const L = bank ? BANK_LOANS : CU_LOANS;
  const D = bank ? BANK_DEPOSITS : CU_DEPOSITS;
  const accounts: unknown[][] = [];
  for (const l of loans) {
    // A mortgage's product follows its term (term_months at 15): 15 years or less is the 15-year product.
    const term = l[15] === null || l[15] === undefined ? null : Number(l[15]);
    const p = String(l[4]) === 'Mortgage' && term !== null ? L.find((x) => x[0] === (term <= 180 ? 'MTG-15' : 'MTG-30')) : pick(L, String(l[4]), unit(l[0] as number, 2201));
    if (p) accounts.push(['loan', l[0], p[0]]);
  }
  for (const d of deposits) {
    const p = pick(D, String(d[3]), unit(d[0] as number, 2202));
    if (p) accounts.push(['deposit', d[0], p[0]]);
  }
  return {
    loanProducts: L.map((p) => [p[0], p[1], p[2], p[4], p[5], p[6], p[7]]),
    depositProducts: D.map((p) => [p[0], p[1], p[2], p[4], p[5], p[6]]),
    accounts,
  };
}
