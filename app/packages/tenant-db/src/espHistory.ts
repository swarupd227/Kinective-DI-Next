// ESP alignment, phase 4: history account by account. Each open loan and share at each month-end
// (finbi_loandata_ym, finbi_depositdata_ym), and the same month-ends added up by account (crm_accountdata_ym),
// by person (crm_customerdata_ym, finbi_loansbymember_ym, finbi_depositsbymember_ym) and by household
// (crm_householdstats_ym). The generator already walks every account month by month to build the
// month-end totals by branch and category (hist_loan_month, hist_deposit_month); these are the same
// paths kept per account, so they add up to those totals.
//
// Also voided and reversed transactions (finbi_voidedsharetransdata, finbi_reversedsharetransdata and the
// loan ones): entries keyed and voided the same day, fees charged and refunded, and loan payments returned.
// DI's posted transactions leave out what was voided and the pairs that cancel, so these rows move no
// balance. Tables of their own; nothing generated before changes. Draws are unit() on salts 3001 to 3049.
import { unit } from './generate.ts';

export const ESP_HISTORY_DDL = [
  `CREATE TABLE hist_loan_account_month (month_end DATE NOT NULL, loan_id INT NOT NULL, balance DECIMAL(14,2) NOT NULL, delinquency_status VARCHAR(20) NOT NULL, PRIMARY KEY (month_end, loan_id), KEY ix_lam_loan (loan_id))`,
  `CREATE TABLE hist_deposit_account_month (month_end DATE NOT NULL, account_id INT NOT NULL, balance DECIMAL(14,2) NOT NULL, rate DECIMAL(6,3) NOT NULL, PRIMARY KEY (month_end, account_id), KEY ix_dam_account (account_id))`,
  `CREATE TABLE hist_account_month (month_end DATE NOT NULL, account_number VARCHAR(12) NOT NULL, deposit_count SMALLINT NOT NULL, deposit_balance DECIMAL(16,2) NOT NULL, loan_count SMALLINT NOT NULL, loan_balance DECIMAL(16,2) NOT NULL, PRIMARY KEY (month_end, account_number), KEY ix_acm_account (account_number))`,
  `CREATE TABLE hist_person_month (month_end DATE NOT NULL, party_id INT NOT NULL, deposit_count SMALLINT NOT NULL, deposit_balance DECIMAL(16,2) NOT NULL, loan_count SMALLINT NOT NULL, loan_balance DECIMAL(16,2) NOT NULL, PRIMARY KEY (month_end, party_id), KEY ix_pm_party (party_id))`,
  `CREATE TABLE hist_household_month (month_end DATE NOT NULL, household_id INT NOT NULL, people SMALLINT NOT NULL, deposit_balance DECIMAL(16,2) NOT NULL, loan_balance DECIMAL(16,2) NOT NULL, PRIMARY KEY (month_end, household_id), KEY ix_hm_household (household_id))`,
  `CREATE TABLE hist_fhlb_collateral_quarter (quarter_end DATE NOT NULL, fhlb_category VARCHAR(40) NOT NULL, reason_type_id TINYINT NULL, loan_count INT NOT NULL, balance DECIMAL(16,2) NOT NULL, KEY ix_fcq_quarter (quarter_end))`,
  `CREATE TABLE cdm_transaction_exception (exception_id INT PRIMARY KEY, kind VARCHAR(8) NOT NULL, account_kind VARCHAR(8) NOT NULL, account_id INT NOT NULL, party_id INT NOT NULL, entered DATE NOT NULL, code VARCHAR(12) NOT NULL, amount DECIMAL(12,2) NOT NULL, channel VARCHAR(12) NOT NULL, branch_id INT NULL, employee_id INT NULL, reason VARCHAR(60) NOT NULL, reposted_txn_id INT NULL, KEY ix_tx_entered (entered), KEY ix_tx_employee (employee_id), KEY ix_tx_party (party_id))`,
];

export const ESP_HISTORY_COLUMNS = {
  hist_loan_account_month: ['month_end', 'loan_id', 'balance', 'delinquency_status'],
  hist_deposit_account_month: ['month_end', 'account_id', 'balance', 'rate'],
  hist_account_month: ['month_end', 'account_number', 'deposit_count', 'deposit_balance', 'loan_count', 'loan_balance'],
  hist_person_month: ['month_end', 'party_id', 'deposit_count', 'deposit_balance', 'loan_count', 'loan_balance'],
  hist_household_month: ['month_end', 'household_id', 'people', 'deposit_balance', 'loan_balance'],
  hist_fhlb_collateral_quarter: ['quarter_end', 'fhlb_category', 'reason_type_id', 'loan_count', 'balance'],
  cdm_transaction_exception: ['exception_id', 'kind', 'account_kind', 'account_id', 'party_id', 'entered', 'code', 'amount', 'channel', 'branch_id', 'employee_id', 'reason', 'reposted_txn_id'],
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface HistoryInputs {
  /** [month end, loan, balance, status], from the generator. */
  loanMonths: unknown[][];
  /** [month end, account, balance, rate]. */
  depositMonths: unknown[][];
  loans: unknown[][];
  deposits: unknown[][];
  parties: unknown[][];
  /** cdm_account_holding rows: [kind, id, account number, ...]. */
  holdings: unknown[][];
}

/** The month-end rows added up by account, by person and by household. */
export function generateHistory(x: HistoryInputs) {
  const loanParty = new Map(x.loans.map((l) => [Number(l[0]), Number(l[1])]));
  const depositParty = new Map(x.deposits.map((d) => [Number(d[0]), Number(d[1])]));
  const accountOf = new Map(x.holdings.map((h) => [`${h[0]}|${h[1]}`, String(h[2])]));
  const householdOf = new Map(x.parties.filter((p) => p[7] !== null && p[7] !== undefined).map((p) => [Number(p[0]), Number(p[7])]));
  // [deposit count, deposit balance, loan count, loan balance]
  const byAccount = new Map<string, number[]>();
  const byPerson = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, key: string, deposit: boolean, balance: number) => {
    const v = map.get(key) ?? [0, 0, 0, 0];
    v[deposit ? 0 : 2]! += 1;
    v[deposit ? 1 : 3]! += balance;
    map.set(key, v);
  };
  for (const [me, id, balance] of x.depositMonths as [string, number, number][]) {
    const account = accountOf.get(`deposit|${id}`);
    if (account) add(byAccount, `${me}|${account}`, true, balance);
    const party = depositParty.get(id);
    if (party !== undefined) add(byPerson, `${me}|${party}`, true, balance);
  }
  for (const [me, id, balance] of x.loanMonths as [string, number, number][]) {
    const account = accountOf.get(`loan|${id}`);
    if (account) add(byAccount, `${me}|${account}`, false, balance);
    const party = loanParty.get(id);
    if (party !== undefined) add(byPerson, `${me}|${party}`, false, balance);
  }
  // [people with a balance, deposits, loans]
  const byHousehold = new Map<string, number[]>();
  for (const [key, v] of byPerson) {
    const [me, party] = key.split('|');
    const hh = householdOf.get(Number(party));
    if (hh === undefined) continue;
    const k = `${me}|${hh}`;
    const h = byHousehold.get(k) ?? [0, 0, 0];
    h[0]! += 1;
    h[1]! += v[1]!;
    h[2]! += v[3]!;
    byHousehold.set(k, h);
  }
  return {
    accounts: [...byAccount].map(([k, v]) => {
      const [me, account] = k.split('|');
      return [me, account, v[0], round2(v[1]!), v[2], round2(v[3]!)];
    }),
    people: [...byPerson].map(([k, v]) => {
      const [me, party] = k.split('|');
      return [me, Number(party), v[0], round2(v[1]!), v[2], round2(v[3]!)];
    }),
    households: [...byHousehold].map(([k, v]) => {
      const [me, hh] = k.split('|');
      return [me, Number(hh), v[0], round2(v[1]!), round2(v[2]!)];
    }),
  };
}

export interface ExceptionInputs {
  /** cdm_share_transaction rows: [txn, account, party, posted, code, amount, channel, branch]. */
  share: unknown[][];
  /** cdm_loan_transaction rows: [txn, loan, party, posted, code, amount, principal, interest, channel]. */
  loan: unknown[][];
  /** [employee, name, role, branch]. */
  employees: unknown[][];
  /** cdm_deposit_account rows: [account, party, branch, ...]. */
  deposits: unknown[][];
}

/** How often a posted fee of each kind had a twin that was charged and refunded. */
const FEE_REFUND: Record<string, number> = { 'FEE-OD': 0.11, 'FEE-MNT': 0.035, 'FEE-ATM': 0.05 };
const FEE_REASONS = ['Courtesy refund', 'Member request', 'Charged in error', 'First-time courtesy'];

/**
 * Voided and reversed transactions over the same 30 days as the posted ones. Tellers key a few
 * entries wrong and void them; member service reps refund some fees; a few loan payments come back
 * unpaid. One rep refunds fees far more often than the others at the branch, several times for the
 * same member: the pattern a fee-reversal review looks for.
 */
export function generateExceptions(x: ExceptionInputs) {
  const reps = (x.employees as [number, string, string, number][]).filter((e) => e[2] === 'MSR');
  const repsAt = new Map<number, number[]>();
  for (const e of reps) repsAt.set(e[3], [...(repsAt.get(e[3]) ?? []), e[0]]);
  const branchOf = new Map((x.deposits as unknown[][]).map((d) => [Number(d[0]), Number(d[2])]));
  // The rep whose refunds stand out, at the branch with the most of them, and the members that rep favors.
  const branches = [...repsAt.keys()].sort((a, b) => a - b);
  const outlierBranch = branches[Math.floor(unit(7, 3001) * branches.length)]!;
  const outlier = repsAt.get(outlierBranch)![0]!;
  const favoredAccounts = new Set<number>();
  const rows: unknown[][] = [];
  const push = (r: unknown[]) => rows.push([rows.length + 1, ...r]);
  const repFor = (branch: number, id: number, salt: number) => {
    const at = repsAt.get(branch);
    if (!at?.length) return null;
    // At the outlier’s branch that rep takes most of the refunds.
    if (branch === outlierBranch && unit(id, salt + 1) < 0.45) return outlier;
    return at[Math.floor(unit(id, salt) * at.length)]!;
  };
  for (const [txn, account, party, posted, code, amount, channel, branch] of x.share as [number, number, number, string, string, number, string, number | null][]) {
    if (channel === 'Teller' && unit(txn, 3002) < 0.011 && branch) {
      // Keyed with a slipped decimal or a dropped digit, voided, and keyed again correctly.
      const wrong = round2(unit(txn, 3003) < 0.5 ? amount * 10 : amount / 10);
      push(['Void', 'deposit', account, party, posted, code, wrong, channel, branch, repFor(branch, txn, 3004), 'Keyed in error; re-entered', txn]);
      continue;
    }
    const chance = FEE_REFUND[code];
    if (!chance) continue;
    const home = branchOf.get(account) ?? null;
    const atOutlier = home === outlierBranch;
    if (atOutlier && favoredAccounts.size < 3 && code === 'FEE-OD' && unit(txn, 3005) < 0.35) favoredAccounts.add(account);
    const favored = favoredAccounts.has(account);
    if (!favored && unit(txn, 3006) >= chance * (atOutlier ? 1.6 : 1)) continue;
    const by = favored ? outlier : home ? repFor(home, txn, 3007) : null;
    // A fee charged and refunded: the pair cancels, so neither is among the posted transactions.
    const day = posted;
    const times = favored ? 2 + Math.floor(unit(txn, 3008) * 2) : 1;
    for (let k = 0; k < times; k++) push(['Reversal', 'deposit', account, party, day, code, Math.abs(amount), 'Branch', home, by, favored ? 'Courtesy refund' : FEE_REASONS[Math.floor(unit(txn, 3009 + k) * FEE_REASONS.length)]!, null]);
  }
  for (const [txn, loan, party, posted, code, amount, , , channel] of x.loan as [number, number, number, string, string, number, number, number, string][]) {
    if (code !== 'LNPMT' || !['ACH', 'Online'].includes(channel) || unit(txn, 3020) >= 0.006) continue;
    push(['Reversal', 'loan', loan, party, posted, code, Math.abs(amount), channel, null, null, unit(txn, 3021) < 0.7 ? 'Payment returned: insufficient funds' : 'Payment returned: account closed', null]);
  }
  return rows;
}
