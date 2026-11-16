// ESP alignment, phase 6: account and member profitability, by funds transfer pricing (ESP's finProfit).
// - cdm_profit_group: the cost model per product group (ESP's loan and deposit cost/profit setup): what an
//   account costs to service and brings in fees each year, a loan's expected loss and remaining life, a
//   deposit's funding credit. These are the same standard assumptions DI's profitability answers use
//   (di-core's profitability.ts); a test holds the two to each other.
// - cdm_product_profit_group: which group each loan and deposit product is costed in (ESP's finprofitsort1).
// - cdm_ftp_rate: the funding curve at each month-end, by term (ESP's fhlbrates). Today's curve is DI's
//   standard one; earlier month-ends move with the market, about half as far as the federal funds rate.
// - cdm_product_ftp: the term each product is funded at (ESP's fhlbproductmap).
// - cdm_predicted_loss: each loan category's expected lifetime loss at each month-end (ESP's
//   predictedloanloss, kept apart from profit as ESP keeps it).
// - cdm_transaction_cost: what each kind of transaction costs to handle, by channel (ESP's loan and
//   deposit transaction costs).
// - cdm_profit_line: the lines a profit statement is built from, and their sign (ESP's typedata).
// - hist_loan_profit_month, hist_deposit_profit_month: each loan and share at each of the last 12
//   month-ends: interest, the FTP charge or credit, expected loss, servicing, fees and what is left.
// - hist_account_profit_month, hist_person_profit_month: the same added up by account and by person.
// The month-end balances are phase 4's; the latest month, times twelve, is the annual contribution DI's
// member profitability shows.
import { fedFundsAt } from './generate.ts';

export const ESP_PROFIT_DDL = [
  `CREATE TABLE cdm_profit_group (
     group_id INT PRIMARY KEY,
     account_kind VARCHAR(8) NOT NULL,
     category VARCHAR(40) NOT NULL,
     name VARCHAR(60) NOT NULL,
     servicing_cost_yearly DECIMAL(10,2) NOT NULL,
     fee_income_yearly DECIMAL(10,2) NOT NULL,
     expected_loss_pct DECIMAL(6,3) NULL,
     life_years DECIMAL(5,2) NULL,
     ftp_credit_pct DECIMAL(6,3) NULL
   )`,
  `CREATE TABLE cdm_product_profit_group (
     account_kind VARCHAR(8) NOT NULL,
     product_id VARCHAR(24) NOT NULL,
     group_id INT NOT NULL,
     PRIMARY KEY (account_kind, product_id)
   )`,
  `CREATE TABLE cdm_ftp_rate (
     month_end DATE NOT NULL,
     max_term_months INT NOT NULL,
     rate_pct DECIMAL(6,3) NOT NULL,
     PRIMARY KEY (month_end, max_term_months)
   )`,
  `CREATE TABLE cdm_product_ftp (
     account_kind VARCHAR(8) NOT NULL,
     product_id VARCHAR(24) NOT NULL,
     term_months INT NULL,
     PRIMARY KEY (account_kind, product_id)
   )`,
  `CREATE TABLE cdm_predicted_loss (
     month_end DATE NOT NULL,
     loan_category VARCHAR(40) NOT NULL,
     lifetime_loss_pct DECIMAL(6,3) NOT NULL,
     PRIMARY KEY (month_end, loan_category)
   )`,
  `CREATE TABLE cdm_transaction_cost (
     code VARCHAR(10) NOT NULL,
     channel VARCHAR(12) NOT NULL,
     cost_each DECIMAL(6,2) NOT NULL,
     note VARCHAR(120) NOT NULL,
     PRIMARY KEY (code, channel)
   )`,
  `CREATE TABLE cdm_profit_line (
     line_id INT PRIMARY KEY,
     name VARCHAR(40) NOT NULL,
     side VARCHAR(8) NOT NULL,
     sign TINYINT NOT NULL,
     description VARCHAR(160) NOT NULL
   )`,
  `CREATE TABLE hist_loan_profit_month (
     month_end DATE NOT NULL,
     loan_id INT NOT NULL,
     balance DECIMAL(14,2) NOT NULL,
     rate_pct DECIMAL(6,3) NOT NULL,
     ftp_pct DECIMAL(6,3) NOT NULL,
     interest_income DECIMAL(12,2) NOT NULL,
     ftp_charge DECIMAL(12,2) NOT NULL,
     expected_loss DECIMAL(12,2) NOT NULL,
     servicing DECIMAL(10,2) NOT NULL,
     fee_income DECIMAL(10,2) NOT NULL,
     profit DECIMAL(12,2) NOT NULL,
     PRIMARY KEY (month_end, loan_id),
     KEY ix_lpm_loan (loan_id)
   )`,
  `CREATE TABLE hist_deposit_profit_month (
     month_end DATE NOT NULL,
     account_id INT NOT NULL,
     balance DECIMAL(14,2) NOT NULL,
     rate_pct DECIMAL(6,3) NOT NULL,
     ftp_pct DECIMAL(6,3) NOT NULL,
     interest_expense DECIMAL(12,2) NOT NULL,
     ftp_credit DECIMAL(12,2) NOT NULL,
     servicing DECIMAL(10,2) NOT NULL,
     fee_income DECIMAL(10,2) NOT NULL,
     profit DECIMAL(12,2) NOT NULL,
     PRIMARY KEY (month_end, account_id),
     KEY ix_dpm_account (account_id)
   )`,
  `CREATE TABLE hist_account_profit_month (
     month_end DATE NOT NULL,
     account_number VARCHAR(12) NOT NULL,
     loan_profit DECIMAL(12,2) NOT NULL,
     deposit_profit DECIMAL(12,2) NOT NULL,
     profit DECIMAL(12,2) NOT NULL,
     PRIMARY KEY (month_end, account_number)
   )`,
  `CREATE TABLE hist_person_profit_month (
     month_end DATE NOT NULL,
     party_id INT NOT NULL,
     loan_income DECIMAL(12,2) NOT NULL,
     loan_expense DECIMAL(12,2) NOT NULL,
     deposit_income DECIMAL(12,2) NOT NULL,
     deposit_expense DECIMAL(12,2) NOT NULL,
     loan_profit DECIMAL(12,2) NOT NULL,
     deposit_profit DECIMAL(12,2) NOT NULL,
     profit DECIMAL(12,2) NOT NULL,
     PRIMARY KEY (month_end, party_id),
     KEY ix_ppm_party (party_id)
   )`,
];

export const ESP_PROFIT_COLUMNS = {
  cdm_profit_group: ['group_id', 'account_kind', 'category', 'name', 'servicing_cost_yearly', 'fee_income_yearly', 'expected_loss_pct', 'life_years', 'ftp_credit_pct'],
  cdm_product_profit_group: ['account_kind', 'product_id', 'group_id'],
  cdm_ftp_rate: ['month_end', 'max_term_months', 'rate_pct'],
  cdm_product_ftp: ['account_kind', 'product_id', 'term_months'],
  cdm_predicted_loss: ['month_end', 'loan_category', 'lifetime_loss_pct'],
  cdm_transaction_cost: ['code', 'channel', 'cost_each', 'note'],
  cdm_profit_line: ['line_id', 'name', 'side', 'sign', 'description'],
  hist_loan_profit_month: ['month_end', 'loan_id', 'balance', 'rate_pct', 'ftp_pct', 'interest_income', 'ftp_charge', 'expected_loss', 'servicing', 'fee_income', 'profit'],
  hist_deposit_profit_month: ['month_end', 'account_id', 'balance', 'rate_pct', 'ftp_pct', 'interest_expense', 'ftp_credit', 'servicing', 'fee_income', 'profit'],
  hist_account_profit_month: ['month_end', 'account_number', 'loan_profit', 'deposit_profit', 'profit'],
  hist_person_profit_month: ['month_end', 'party_id', 'loan_income', 'loan_expense', 'deposit_income', 'deposit_expense', 'loan_profit', 'deposit_profit', 'profit'],
} as const;

// DI's standard assumptions, as di-core's profitability.ts holds them; a test keeps the two equal.
/** The FTP rate a loan is charged for its funding today, by contractual term. */
export const PROFIT_FTP_CURVE: [maxMonths: number, ratePct: number][] = [
  [12, 3.75],
  [36, 3.7],
  [60, 3.72],
  [84, 3.8],
  [180, 3.95],
  [9999, 4.1],
];
/** The credit a deposit earns for its funding today. */
export const PROFIT_DEPOSIT_FTP: Record<string, number> = { Checking: 3.55, 'Share Savings': 3.45, Savings: 3.45, 'Money Market': 3.5, Certificates: 3.85, 'Certificates of Deposit': 3.85, IRA: 3.9 };
/** Annual expected loss on the balance, and remaining life in years, by loan category. */
export const PROFIT_LOSS_RATE: Record<string, number> = { Mortgage: 0.05, HELOC: 0.15, Auto: 0.55, Personal: 2.3, 'Credit Card': 3.1, Consumer: 2.0, Business: 0.5, 'Commercial Real Estate': 0.25, 'Commercial & Industrial': 0.6 };
export const PROFIT_LIFE_YEARS: Record<string, number> = { Mortgage: 7, HELOC: 4.5, Auto: 2.2, Personal: 1.9, 'Credit Card': 1.5, Consumer: 1.9, Business: 3, 'Commercial Real Estate': 4.5, 'Commercial & Industrial': 2.5 };
/** Servicing cost and fee income per account per year. */
export const PROFIT_LOAN_COST: Record<string, [cost: number, fees: number]> = { Mortgage: [620, 140], HELOC: [310, 60], Auto: [190, 25], Personal: [170, 30], 'Credit Card': [95, 70], Consumer: [160, 25], Business: [1800, 450], 'Commercial Real Estate': [3600, 900], 'Commercial & Industrial': [2600, 700] };
export const PROFIT_DEPOSIT_COST: Record<string, [cost: number, fees: number]> = { Checking: [165, 120], 'Share Savings': [38, 6], Savings: [38, 6], 'Money Market': [70, 10], Certificates: [45, 4], 'Certificates of Deposit': [45, 4], IRA: [60, 4] };
/** How much more a weaker credit band loses than the category's average. */
export const PROFIT_BAND_FACTOR = (score: number | null, rating: number | null) => (rating !== null ? (rating >= 7 ? 6 : rating === 6 ? 3 : 0.8) : score === null ? 1 : score >= 740 ? 0.45 : score >= 680 ? 0.9 : score >= 620 ? 2.1 : 4.2);

/** What each kind of transaction costs to handle: a teller's time, the ATM network, card processing. */
const TRANSACTION_COST: [code: string, channel: string, cost: number, note: string][] = [
  ['TLRD', 'Teller', 4.25, 'A teller deposit: counter time and the cash drawer.'],
  ['TLRW', 'Teller', 4.25, 'A teller withdrawal.'],
  ['LNPMT', 'Teller', 4.25, 'A loan payment at the counter.'],
  ['ATMW', 'ATM', 0.95, 'An ATM withdrawal on our own machines: cash handling and the network.'],
  ['POS', 'Card', 0.14, 'A debit card purchase: processing, net of nothing (interchange is income).'],
  ['ACHC', 'ACH', 0.09, 'An ACH credit, such as a paycheck.'],
  ['ACHD', 'ACH', 0.09, 'An ACH debit.'],
  ['LNPMT', 'ACH', 0.09, 'A loan payment by ACH.'],
  ['XFER', 'Online', 0.06, 'A transfer in online banking.'],
  ['BILL', 'Online', 0.32, 'A bill paid through bill pay: the bill-pay vendor’s fee.'],
  ['LNPMT', 'Online', 0.06, 'A loan payment in online banking.'],
  ['MRDC', 'Mobile', 0.18, 'A check deposited in the mobile app: capture and review.'],
];

const LINES: [string, string, number, string][] = [
  ['Interest income', 'loan', 1, 'Interest the loan earns at its rate.'],
  ['FTP charge', 'loan', -1, 'What the funding the loan uses costs, at the curve for its term.'],
  ['Expected loss', 'loan', -1, 'A year’s expected loss on the balance, by category and credit band.'],
  ['Interest expense', 'deposit', -1, 'Dividends or interest paid on the share.'],
  ['FTP credit', 'deposit', 1, 'What the funding the share provides is worth.'],
  ['Servicing', 'both', -1, 'What the account costs to service: statements, systems, staff time.'],
  ['Fee income', 'both', 1, 'Fees the account brings in.'],
];

const round2 = (n: number) => Math.round(n * 100) / 100;
const ftpOn = (curve: [number, number][], term: number | null) => curve.find(([m]) => (term ?? 12) <= m)![1];

export interface ProfitInputs {
  /** Loan and deposit products: [product, name, category, ...]. */
  loanProducts: unknown[][];
  depositProducts: unknown[][];
  /** cdm_loan rows, cdm_deposit_account rows. */
  loans: unknown[][];
  deposits: unknown[][];
  /** cdm_account_holding rows: [kind, id, account number, ...]. */
  holdings: unknown[][];
}

/** The cost model: profit groups, which product sits in which, the FTP curve by month, terms, losses, transaction costs and lines. */
export function generateProfitSetup(x: ProfitInputs, monthEnds: string[]) {
  const groups: unknown[][] = [];
  const groupOf = new Map<string, number>();
  let id = 1;
  for (const [category, [cost, fees]] of Object.entries(PROFIT_LOAN_COST)) {
    groupOf.set(`loan|${category}`, id);
    groups.push([id++, 'loan', category, `${category} loans`, cost, fees, PROFIT_LOSS_RATE[category] ?? null, PROFIT_LIFE_YEARS[category] ?? null, null]);
  }
  for (const [category, [cost, fees]] of Object.entries(PROFIT_DEPOSIT_COST)) {
    groupOf.set(`deposit|${category}`, id);
    groups.push([id++, 'deposit', category, category, cost, fees, null, null, PROFIT_DEPOSIT_FTP[category] ?? null]);
  }
  const productGroups: unknown[][] = [];
  const productFtp: unknown[][] = [];
  for (const p of x.loanProducts) {
    const g = groupOf.get(`loan|${p[2]}`);
    if (g) productGroups.push(['loan', p[0], g]);
  }
  for (const p of x.depositProducts) {
    const g = groupOf.get(`deposit|${p[2]}`);
    if (g) productGroups.push(['deposit', p[0], g]);
  }
  // A product is funded at its typical term: the median term of its loans, or a certificate's own term.
  for (const p of x.loanProducts) {
    const terms = x.loans.filter((l) => l[4] === p[2] && l[15] !== null && l[15] !== undefined).map((l) => Number(l[15])).sort((a, b) => a - b);
    productFtp.push(['loan', p[0], terms.length ? terms[Math.floor(terms.length / 2)]! : null]);
  }
  for (const p of x.depositProducts) productFtp.push(['deposit', p[0], /(\d+)-Month/.exec(String(p[1]))?.[1] ? Number(/(\d+)-Month/.exec(String(p[1]))![1]) : null]);
  // The curve moves with the market, about half as far as the federal funds rate.
  const last = monthEnds.at(-1)!;
  const shift = (me: string) => 0.5 * (fedFundsAt(me) - fedFundsAt(last));
  const ftp = monthEnds.flatMap((me) => PROFIT_FTP_CURVE.map(([m, r]) => [me, m, round2(r + shift(me))]));
  const losses = monthEnds.flatMap((me) => Object.keys(PROFIT_LOSS_RATE).map((c) => [me, c, Math.round(PROFIT_LOSS_RATE[c]! * PROFIT_LIFE_YEARS[c]! * 1000) / 1000]));
  const lines = LINES.map((l, i) => [i + 1, ...l]);
  return { groups, productGroups, productFtp, ftp, losses, costs: TRANSACTION_COST.map((c) => [...c]), lines, shift };
}

/**
 * Each loan and share's profit at each of the given month-ends, a month at a time, with the same added up
 * by account and person. Built from phase 4's month-end rows: [month end, loan, balance, status] and
 * [month end, share, balance, rate then].
 */
export function* generateProfitMonths(x: ProfitInputs, loanMonths: unknown[][], depositMonths: unknown[][], monthEnds: string[], shift: (me: string) => number): Generator<{ loans: unknown[][]; deposits: unknown[][]; accounts: unknown[][]; people: unknown[][] }> {
  const loanBy = new Map(x.loans.map((l) => [Number(l[0]), l]));
  const depBy = new Map(x.deposits.map((d) => [Number(d[0]), d]));
  const accountOf = new Map(x.holdings.map((h) => [`${h[0]}|${h[1]}`, String(h[2])]));
  const wanted = new Set(monthEnds);
  const rowsFor = (rows: unknown[][]) => {
    const at = new Map<string, unknown[][]>();
    for (const r of rows) {
      const me = String(r[0]);
      if (wanted.has(me)) (at.get(me) ?? at.set(me, []).get(me)!).push(r);
    }
    return at;
  };
  const loanAt = rowsFor(loanMonths);
  const depAt = rowsFor(depositMonths);
  for (const me of monthEnds) {
    const curve = PROFIT_FTP_CURVE.map(([m, r]) => [m, r + shift(me)] as [number, number]);
    const loans: unknown[][] = [];
    const deposits: unknown[][] = [];
    const byAccount = new Map<string, [number, number]>();
    const byPerson = new Map<number, number[]>();
    const person = (p: number) => byPerson.get(p) ?? byPerson.set(p, [0, 0, 0, 0, 0, 0]).get(p)!;
    for (const [, id, balance] of (loanAt.get(me) ?? []) as [string, number, number][]) {
      const l = loanBy.get(id);
      if (!l) continue;
      const category = String(l[4]);
      const bal = Number(balance);
      const rate = Number(l[11]);
      const ftp = ftpOn(curve, l[15] === null || l[15] === undefined ? null : Number(l[15]));
      const [cost, fees] = PROFIT_LOAN_COST[category] ?? [200, 30];
      const interest = (bal * rate) / 1200;
      const charge = (bal * ftp) / 1200;
      const loss = (bal * (PROFIT_LOSS_RATE[category] ?? 0.5) * PROFIT_BAND_FACTOR(l[13] === null || l[13] === undefined ? null : Number(l[13]), l[16] === null || l[16] === undefined ? null : Number(l[16]))) / 1200;
      const profit = interest - charge - loss - cost / 12 + fees / 12;
      loans.push([me, id, round2(bal), rate, round2(ftp), round2(interest), round2(charge), round2(loss), round2(cost / 12), round2(fees / 12), round2(profit)]);
      const acct = accountOf.get(`loan|${id}`);
      if (acct) (byAccount.get(acct) ?? byAccount.set(acct, [0, 0]).get(acct)!)[0] += profit;
      const p = person(Number(l[1]));
      p[0]! += interest + fees / 12;
      p[1]! += charge + loss + cost / 12;
      p[4]! += profit;
    }
    for (const [, id, balance, then] of (depAt.get(me) ?? []) as [string, number, number, number][]) {
      const d = depBy.get(id);
      if (!d) continue;
      const category = String(d[3]);
      const bal = Number(balance);
      const rate = Number(then);
      const credit = (PROFIT_DEPOSIT_FTP[category] ?? 3.5) + shift(me);
      const [cost, fees] = PROFIT_DEPOSIT_COST[category] ?? [60, 5];
      const expense = (bal * rate) / 1200;
      const value = (bal * credit) / 1200;
      const profit = value - expense - cost / 12 + fees / 12;
      deposits.push([me, id, round2(bal), rate, round2(credit), round2(expense), round2(value), round2(cost / 12), round2(fees / 12), round2(profit)]);
      const acct = accountOf.get(`deposit|${id}`);
      if (acct) (byAccount.get(acct) ?? byAccount.set(acct, [0, 0]).get(acct)!)[1] += profit;
      const p = person(Number(d[1]));
      p[2]! += value + fees / 12;
      p[3]! += expense + cost / 12;
      p[5]! += profit;
    }
    yield {
      loans,
      deposits,
      accounts: [...byAccount].map(([a, [lp, dp]]) => [me, a, round2(lp), round2(dp), round2(lp + dp)]),
      people: [...byPerson].map(([p, v]) => [me, p, round2(v[0]!), round2(v[1]!), round2(v[2]!), round2(v[3]!), round2(v[4]!), round2(v[5]!), round2(v[4]! + v[5]!)]),
    };
  }
}

/** The last `count` month-ends on file, oldest first. */
export const lastMonthEnds = (rows: unknown[][], count = 12) => [...new Set(rows.map((r) => String(r[0])))].sort().slice(-count);
