// ESP alignment, phase 1b: what phase 1 left. Product details (finbi_loanproddata, finbi_shareproddata: a
// description, whether it is offered, rate type, certificate term, the membership share, used autos, which
// cross-sell group it counts in, and a line for staff), cross-sell groups (finbi_crosssellgroups), dividend
// and interest tiers by balance (finbi_dividendtiers), card products and each card's product, expiry and the
// accounts it reaches (finbi_cardproddata, finbi_carddata), and miscellaneous accounts such as safe deposit
// boxes (finbi_miscproddata, finbi_miscdata).
//
// Tables of their own; nothing generated before changes. Draws are unit() on salts 2701 to 2749.
import { AS_OF, unit } from './generate.ts';
import { memberNumberOf } from './espAccounts.ts';

export const ESP_DETAIL_DDL = [
  `CREATE TABLE cdm_cross_sell_group (group_id VARCHAR(16) PRIMARY KEY, name VARCHAR(40) NOT NULL, kind VARCHAR(8) NOT NULL)`,
  `CREATE TABLE cdm_product_detail (account_kind VARCHAR(8) NOT NULL, product_id VARCHAR(24) NOT NULL, description VARCHAR(160) NOT NULL, active TINYINT NOT NULL, rate_type VARCHAR(10) NOT NULL, term_months SMALLINT NULL, membership_share TINYINT NOT NULL, used_auto TINYINT NOT NULL, conditionally_cancellable TINYINT NOT NULL, cross_sell_group VARCHAR(16) NOT NULL, conversation_starter VARCHAR(200) NOT NULL, PRIMARY KEY (account_kind, product_id))`,
  `CREATE TABLE cdm_dividend_tier (product_id VARCHAR(24) NOT NULL, tier TINYINT NOT NULL, min_balance DECIMAL(14,2) NOT NULL, rate DECIMAL(6,3) NOT NULL, PRIMARY KEY (product_id, tier))`,
  `CREATE TABLE cdm_card_product (card_product_id VARCHAR(16) PRIMARY KEY, name VARCHAR(60) NOT NULL, kind VARCHAR(8) NOT NULL, network VARCHAR(20) NOT NULL, annual_fee DECIMAL(8,2) NOT NULL, rewards VARCHAR(60) NULL)`,
  `CREATE TABLE cdm_card_terms (card_id INT PRIMARY KEY, card_product_id VARCHAR(16) NOT NULL, expires DATE NOT NULL, linked_accounts TINYINT NOT NULL)`,
  `CREATE TABLE cdm_misc_product (product_id VARCHAR(16) PRIMARY KEY, name VARCHAR(60) NOT NULL, annual_fee DECIMAL(8,2) NOT NULL)`,
  `CREATE TABLE cdm_misc_account (misc_id INT PRIMARY KEY, party_id INT NOT NULL, account_number VARCHAR(12) NOT NULL, product_id VARCHAR(16) NOT NULL, branch_id INT NOT NULL, open_date DATE NOT NULL, close_date DATE NULL, KEY ix_misc_party (party_id))`,
];

export const ESP_DETAIL_COLUMNS = {
  cdm_cross_sell_group: ['group_id', 'name', 'kind'],
  cdm_product_detail: ['account_kind', 'product_id', 'description', 'active', 'rate_type', 'term_months', 'membership_share', 'used_auto', 'conditionally_cancellable', 'cross_sell_group', 'conversation_starter'],
  cdm_dividend_tier: ['product_id', 'tier', 'min_balance', 'rate'],
  cdm_card_product: ['card_product_id', 'name', 'kind', 'network', 'annual_fee', 'rewards'],
  cdm_card_terms: ['card_id', 'card_product_id', 'expires', 'linked_accounts'],
  cdm_misc_product: ['product_id', 'name', 'annual_fee'],
  cdm_misc_account: ['misc_id', 'party_id', 'account_number', 'product_id', 'branch_id', 'open_date', 'close_date'],
} as const;

const GROUPS: [id: string, name: string, kind: 'deposit' | 'loan', matches: RegExp][] = [
  ['CHECKING', 'Checking', 'deposit', /^Checking$/],
  ['SAVINGS', 'Savings and money market', 'deposit', /Savings|Money Market/],
  ['TERM', 'Certificates and IRAs', 'deposit', /^Certificates|^IRA$/],
  ['AUTO', 'Auto loans', 'loan', /^Auto$/],
  ['HOME', 'Mortgages and home equity', 'loan', /Mortgage|HELOC|Home Equity/],
  ['CARD', 'Credit cards', 'loan', /Credit Card/],
  ['PERSONAL', 'Personal and consumer loans', 'loan', /Personal|Consumer/],
  ['BUSINESS', 'Business lending', 'loan', /Business|Commercial/],
];
const groupOf = (kind: 'deposit' | 'loan', category: string) => GROUPS.find(([, , k, matches]) => k === kind && matches.test(category))?.[0] ?? (kind === 'loan' ? 'PERSONAL' : 'SAVINGS');

/** A line staff can open with, by product family. */
const STARTER: Record<string, string> = {
  CHECKING: 'Is your paycheck coming here? Direct deposit makes this account free and gets you paid sooner.',
  SAVINGS: 'Want this savings working harder? Balances above the next tier earn more.',
  TERM: 'Rates on our certificates are set for the term; would locking in part of your savings help?',
  AUTO: 'Shopping for a car? Getting approved here first gives you a rate to take to the dealer.',
  HOME: 'Thinking about the house? Your equity could fund a project at a lower rate than a card.',
  CARD: 'Paying a higher rate on another card? A balance transfer here could save on interest.',
  PERSONAL: 'Consolidating a few balances into one fixed payment can lower the interest you pay.',
  BUSINESS: 'How is the business doing? A line of credit can smooth out the slow months.',
};

const DAY = 86_400_000;
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
const round = (n: number, step: number) => Math.round(n / step) * step;

export interface DetailInputs {
  institutionType: 'credit_union' | 'bank';
  /** cdm_loan_product rows: id, name, category, amount code, count code, secured, revolving. */
  loanProducts: unknown[][];
  /** cdm_deposit_product rows: id, name, category, interest-bearing, minimum, fee. */
  depositProducts: unknown[][];
  /** cdm_account_product rows: kind, account id, product id. */
  accountProducts: unknown[][];
  /** cdm_deposit_account rows: id 0, party 1, branch 2, category 3, open 4, close 5, maturity 6, balance 7, rate 8. */
  deposits: unknown[][];
  /** cdm_card rows: id 0, party 1, kind 2, last4 3, status 4, opened 5, activated 6, closed 7, account 8. */
  cards: unknown[][];
  /** cdm_party rows: id 0, ..., birth 3, join 4, branch 5, ..., is_member 8. */
  parties: unknown[][];
}

export function generateDetails(x: DetailInputs) {
  const bank = x.institutionType === 'bank';
  const groups = GROUPS.map(([id, name, kind]) => [id, name, kind]);

  // ---- Products ------------------------------------------------------------------------------------
  const products: unknown[][] = [];
  for (const p of x.loanProducts) {
    const [id, name, cat, , , , revolving] = p as [string, string, string, unknown, unknown, unknown, number];
    const g = groupOf('loan', cat);
    const variable = Number(revolving) === 1;
    products.push(['loan', id, `${name}: ${variable ? 'a revolving line at a variable rate' : 'fixed payments over a set term'}${/AUTO-USED/.test(id) ? ', for used vehicles' : ''}.`, 1, variable ? 'Variable' : /CRE|CI-TERM|BUS/.test(id) ? 'Either' : 'Fixed', null, 0, /AUTO-USED/.test(id) ? 1 : 0, variable && g !== 'BUSINESS' ? 1 : 0, g, STARTER[g]!]);
  }
  for (const p of x.depositProducts) {
    const [id, name, cat] = p as [string, string, string];
    const g = groupOf('deposit', cat);
    const term = /-(\d+)$/.exec(id)?.[1];
    products.push(['deposit', id, `${name}${term ? `: a ${term}-month term at a fixed rate` : cat === 'Money Market' ? ': tiered rates that rise with the balance' : ''}.`, 1, term ? 'Fixed' : 'Variable', term ? Number(term) : null, !bank && id === 'SAV' ? 1 : 0, 0, 0, g, STARTER[g]!]);
  }

  // ---- Dividend and interest tiers, from what accounts at each balance actually earn ---------------------
  const productOf = new Map(x.accountProducts.filter((r) => r[0] === 'deposit').map((r) => [Number(r[1]), String(r[2])]));
  const BANDS = [0, 2_500, 10_000, 25_000, 100_000];
  const tiers: unknown[][] = [];
  for (const p of x.depositProducts) {
    const id = String(p[0]);
    if (Number(p[3]) !== 1 || /-(\d+)$/.test(id) || /^IRA/.test(id)) continue;
    const open = x.deposits.filter((d) => !d[5] && productOf.get(Number(d[0])) === id);
    let last = 0;
    BANDS.forEach((min, i) => {
      const inBand = open.filter((d) => Number(d[7]) >= min && Number(d[7]) < (BANDS[i + 1] ?? Infinity));
      // A band with too few accounts to say takes the tier below's rate; rates never step down as balances rise.
      const avg = inBand.length >= 5 ? inBand.reduce((s, d) => s + Number(d[8]), 0) / inBand.length : last;
      last = Math.max(last, round(avg, 0.05));
      tiers.push([id, i + 1, min, Math.round(last * 1000) / 1000]);
    });
  }

  // ---- Cards -----------------------------------------------------------------------------------------
  const creditProducts = x.loanProducts.filter((p) => String(p[2]) === 'Credit Card');
  const cardProducts: unknown[][] = [
    ['DEBIT', bank ? 'Debit Mastercard' : 'Visa Debit', 'Debit', bank ? 'Mastercard' : 'Visa', 0, null],
    ...creditProducts.map((p) => [String(p[0]), String(p[1]), 'Credit', 'Visa', /REW/.test(String(p[0])) ? 49 : 0, /REW/.test(String(p[0])) ? '1.5% cash back' : null]),
  ];
  const loanProductOf = new Map(x.accountProducts.filter((r) => r[0] === 'loan').map((r) => [Number(r[1]), String(r[2])]));
  const savingsOf = new Set(x.deposits.filter((d) => !d[5] && /Savings|Money Market/.test(String(d[3]))).map((d) => Number(d[1])));
  const cardTerms = x.cards.map((c) => {
    const id = Number(c[0]);
    const credit = String(c[2]) === 'Credit';
    const product = credit ? (loanProductOf.get(Number(c[8])) ?? String(creditProducts[0]?.[0] ?? 'DEBIT')) : 'DEBIT';
    // Cards run four years from issue and are reissued while open, so an open card always has a future expiry.
    const opened = Date.parse(`${day(c[5])}T00:00:00Z`);
    let expires = new Date(opened);
    expires.setUTCMonth(expires.getUTCMonth() + 48);
    if (!c[7]) while (expires.getTime() <= Date.parse(`${AS_OF}T00:00:00Z`)) expires.setUTCMonth(expires.getUTCMonth() + 48);
    expires = new Date(Date.UTC(expires.getUTCFullYear(), expires.getUTCMonth() + 1, 0));
    // A debit card reaches checking, and savings too where the member has it and asked for it.
    const linked = credit ? 1 : 1 + (savingsOf.has(Number(c[1])) && unit(id, 2701) < 0.6 ? 1 : 0);
    return [id, product, expires.toISOString().slice(0, 10), linked];
  });

  // ---- Miscellaneous accounts: safe deposit boxes ------------------------------------------------------
  const miscProducts: unknown[][] = [
    ['SDB-S', 'Safe deposit box, small', 45],
    ['SDB-M', 'Safe deposit box, medium', 75],
    ['SDB-L', 'Safe deposit box, large', 120],
  ];
  const misc: unknown[][] = [];
  let next = 1;
  for (const p of x.parties) {
    const id = Number(p[0]);
    const age = (Date.parse(`${AS_OF}T00:00:00Z`) - Date.parse(`${day(p[3])}T00:00:00Z`)) / (365.25 * DAY);
    if (Number(p[8]) !== 1 || age < 35 || unit(id, 2711) >= (age >= 60 ? 0.09 : 0.03)) continue;
    const join = Date.parse(`${day(p[4])}T00:00:00Z`);
    const opened = new Date(join + unit(id, 2712) * Math.max(0, Date.parse(`${AS_OF}T00:00:00Z`) - join)).toISOString().slice(0, 10);
    const closed = unit(id, 2713) < 0.1 ? new Date(Date.parse(`${opened}T00:00:00Z`) + unit(id, 2714) * Math.max(DAY, Date.parse(`${AS_OF}T00:00:00Z`) - Date.parse(`${opened}T00:00:00Z`))).toISOString().slice(0, 10) : null;
    const size = unit(id, 2715);
    misc.push([next++, id, memberNumberOf(id), size < 0.55 ? 'SDB-S' : size < 0.9 ? 'SDB-M' : 'SDB-L', Number(p[5]), opened, closed]);
  }

  return { groups, products, tiers, cardProducts, cardTerms, miscProducts, misc };
}
