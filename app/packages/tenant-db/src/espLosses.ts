// ESP alignment, phase 2: losses and insiders.
// - Charge-offs and recoveries, account by account: loans (finbi_loanchargeoffs, finbi_loanrecoveries) and
//   overdrawn checking closed with a negative balance (finbi_depositchargeoffs, finbi_depositrecoveries).
//   The generator draws them; the Call Report's charge-off and recovery lines are their sums.
// - Insiders and their loans: directors, committee members, executive officers, principal shareholders and
//   employees (finbi_officialownedloans, finbi_employeeowned_loans). A bank's insider lending falls under
//   Regulation O (12 CFR 215); a credit union's loans to officials under NCUA 701.21(d). Each loan to an
//   official records the board's prior approval when the rule calls for one.
//
// Tables of their own. Draws are unit() on salts 2851 to 2899.
import { AS_OF, unit } from './generate.ts';

export const ESP_LOSS_DDL = [
  `CREATE TABLE cdm_loan_chargeoff (loan_id INT PRIMARY KEY, charge_off_date DATE NOT NULL, amount DECIMAL(14,2) NOT NULL, loan_category VARCHAR(40) NOT NULL, is_indirect TINYINT NOT NULL, branch_id INT NOT NULL, KEY ix_lco_date (charge_off_date))`,
  `CREATE TABLE cdm_loan_recovery (recovery_id INT PRIMARY KEY, loan_id INT NOT NULL, recovery_date DATE NOT NULL, amount DECIMAL(14,2) NOT NULL, KEY ix_lrec_loan (loan_id), KEY ix_lrec_date (recovery_date))`,
  `CREATE TABLE cdm_deposit_chargeoff (account_id INT PRIMARY KEY, charge_off_date DATE NOT NULL, amount DECIMAL(12,2) NOT NULL, deposit_category VARCHAR(40) NOT NULL, branch_id INT NOT NULL)`,
  `CREATE TABLE cdm_deposit_recovery (recovery_id INT PRIMARY KEY, account_id INT NOT NULL, recovery_date DATE NOT NULL, amount DECIMAL(12,2) NOT NULL, KEY ix_drec_account (account_id))`,
  `CREATE TABLE cdm_insider (party_id INT PRIMARY KEY, role VARCHAR(30) NOT NULL, title VARCHAR(60) NOT NULL, since DATE NOT NULL, until DATE NULL)`,
  `CREATE TABLE cdm_insider_loan (loan_id INT PRIMARY KEY, party_id INT NOT NULL, kind VARCHAR(10) NOT NULL, effective_date DATE NOT NULL, expiration_date DATE NULL, board_approved DATE NULL, KEY ix_insl_party (party_id))`,
];

export const ESP_LOSS_COLUMNS = {
  cdm_loan_chargeoff: ['loan_id', 'charge_off_date', 'amount', 'loan_category', 'is_indirect', 'branch_id'],
  cdm_loan_recovery: ['recovery_id', 'loan_id', 'recovery_date', 'amount'],
  cdm_deposit_chargeoff: ['account_id', 'charge_off_date', 'amount', 'deposit_category', 'branch_id'],
  cdm_deposit_recovery: ['recovery_id', 'account_id', 'recovery_date', 'amount'],
  cdm_insider: ['party_id', 'role', 'title', 'since', 'until'],
  cdm_insider_loan: ['loan_id', 'party_id', 'kind', 'effective_date', 'expiration_date', 'board_approved'],
} as const;

/**
 * Prior board approval: a bank's insider over the greater of $25,000 or 5% of capital, never more than
 * $500,000 (12 CFR 215.4(b)); a credit union's official over $20,000 in loans and lines (701.21(d)(4)).
 */
export const insiderApprovalThreshold = (bank: boolean, capital: number) => (bank ? Math.min(500_000, Math.max(25_000, capital * 0.05)) : 20_000);

const ROLES: Record<'bank' | 'credit_union', [role: string, title: string, count: number][]> = {
  credit_union: [
    ['Director', 'Board chair', 1], ['Director', 'Board vice chair', 1], ['Director', 'Board treasurer', 1], ['Director', 'Board secretary', 1], ['Director', 'Director', 5],
    ['Supervisory committee', 'Supervisory committee member', 3],
    ['Executive officer', 'President and CEO', 1], ['Executive officer', 'Chief financial officer', 1], ['Executive officer', 'Chief lending officer', 1], ['Executive officer', 'Chief operating officer', 1], ['Executive officer', 'Chief risk officer', 1],
  ],
  bank: [
    ['Director', 'Chairman of the board', 1], ['Director', 'Director', 8],
    ['Executive officer', 'President and CEO', 1], ['Executive officer', 'Chief financial officer', 1], ['Executive officer', 'Chief credit officer', 1], ['Executive officer', 'Chief operating officer', 1], ['Executive officer', 'Chief lending officer', 1],
    ['Principal shareholder', 'Principal shareholder (over 10%)', 2],
  ],
};

export interface LossInputs {
  institutionType: 'bank' | 'credit_union';
  chargeOffs: unknown[][];
  recoveries: unknown[][];
  depositChargeOffs: unknown[][];
  depositRecoveries: unknown[][];
  parties: unknown[][];
  loans: unknown[][];
  employees: unknown[][];
  /** Net worth or equity capital, for a bank's approval threshold. */
  capital: number;
}

export function generateLosses(x: LossInputs) {
  const bank = x.institutionType === 'bank';
  const recoveries = x.recoveries.map((r, i) => [i + 1, ...r]);
  const depositRecoveries = x.depositRecoveries.map((r, i) => [i + 1, ...r]);

  // ---- Insiders: people who hold loans with us, chosen by hash; the demos' first 500 members are left alone.
  const asOf = new Date(`${AS_OF}T00:00:00Z`);
  const loans = x.loans as [number, number, number, number, string, number, string, string | null, string | null, number, number, number][];
  const byParty = new Map<number, typeof loans>();
  for (const l of loans) {
    if (l[8]) continue;
    const list = byParty.get(l[1]) ?? [];
    list.push(l);
    byParty.set(l[1], list);
  }
  const parties = x.parties as [number, string, string, string, string, number, string, number, number][];
  const ageAt = (birth: string) => (asOf.getTime() - new Date(`${birth}T00:00:00Z`).getTime()) / (365.25 * 86_400_000);
  const pool = parties
    .filter((p) => p[0] > 500 && p[8] === 1 && ageAt(p[3]) >= 30 && ageAt(p[3]) < 72 && byParty.has(p[0]))
    .sort((a, b) => unit(a[0], 2851) - unit(b[0], 2851));
  const insiders: unknown[][] = [];
  const kindOf = new Map<number, 'Official' | 'Employee'>();
  const sinceOf = new Map<number, string>();
  let next = 0;
  const add = (role: string, title: string, official: boolean) => {
    const p = pool[next++];
    if (!p) return;
    // Serving for 1 to 14 years; a few left within the last year.
    const since = new Date(asOf.getTime() - (1 + unit(p[0], 2852) * 13) * 365.25 * 86_400_000);
    const left = unit(p[0], 2853) < 0.08 ? new Date(asOf.getTime() - unit(p[0], 2854) * 300 * 86_400_000) : null;
    const s = since.toISOString().slice(0, 10);
    insiders.push([p[0], role, title, s, left ? left.toISOString().slice(0, 10) : null]);
    kindOf.set(p[0], official ? 'Official' : 'Employee');
    sinceOf.set(p[0], s);
  };
  for (const [role, title, n] of ROLES[x.institutionType]) for (let k = 0; k < n; k++) add(role, title, true);
  // Employees who borrow from us: about a third of staff.
  const staff = Math.round(x.employees.length * 0.35);
  for (let k = 0; k < staff; k++) add('Employee', String(x.employees[Math.floor(unit(k, 2855) * x.employees.length)]![2] ?? 'Employee'), false);

  // ---- Their loans, from the later of the loan's opening and the person becoming an insider.
  const threshold = insiderApprovalThreshold(bank, x.capital);
  const insiderLoans: unknown[][] = [];
  // One credit-union official's largest loan this year or last went through without the board's
  // approval: the exception an examiner would find.
  const aggregateOf = (party: number) => (byParty.get(party) ?? []).filter((l) => !l[7]).reduce((s, l) => s + Number(l[9]), 0);
  const missed = bank
    ? null
    : insiders
        .filter((row) => kindOf.get(row[0] as number) === 'Official' && !row[4] && aggregateOf(row[0] as number) > threshold)
        .flatMap((row) => (byParty.get(row[0] as number) ?? []).filter((l) => !l[7] && l[6] >= String(row[3]) && l[6] >= '2025-01-01'))
        .sort((a, b) => Number(b[9]) - Number(a[9]))[0]?.[0] ?? null;
  for (const row of insiders) {
    const [party, , , since, until] = row as [number, string, string, string, string | null];
    const kind = kindOf.get(party)!;
    const list = byParty.get(party) ?? [];
    const aggregate = list.filter((l) => !l[7]).reduce((s, l) => s + Number(l[9]), 0);
    for (const l of list) {
      if (l[7] && l[7] < since) continue;
      const effective = l[6] > since ? l[6] : since;
      const expiration = [l[7], until].filter((d): d is string => Boolean(d)).sort()[0] ?? null;
      // Officials over the threshold need the board's approval before the loan is made.
      let approved: string | null = null;
      if (kind === 'Official' && aggregate > threshold && l[6] >= since && l[0] !== missed) {
        approved = new Date(new Date(`${l[6]}T00:00:00Z`).getTime() - (3 + Math.floor(unit(l[0], 2856) * 20)) * 86_400_000).toISOString().slice(0, 10);
      }
      insiderLoans.push([l[0], party, kind, effective, expiration, approved]);
    }
  }
  return { chargeOffs: x.chargeOffs, recoveries, depositChargeOffs: x.depositChargeOffs, depositRecoveries, insiders, insiderLoans };
}
