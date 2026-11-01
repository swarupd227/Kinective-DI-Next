// Goals & Incentives data (spec 15.5.2, 17.4): goals and targets by role, incentives and their tiers,
// and the credited records behind each score. Amounts are never stored here: the DI Core works them
// out from these rows, so a period can always be recalculated. Keyed on employee and period rather
// than the generator, so no other tenant figure moves. All of it is demo data [Assumption].
import { unit, type GeneratedTenant } from './generate.ts';

export const GOALS_DDL = [
  `CREATE TABLE mod_gi_goal (
     goal_id VARCHAR(24) PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     unit VARCHAR(12) NOT NULL,
     role VARCHAR(40) NOT NULL,
     goal_kind VARCHAR(12) NOT NULL,
     target DECIMAL(14,2) NOT NULL,
     unit_label VARCHAR(40) NOT NULL
   )`,
  // More specific than the role's target (spec 17.4). Only the employee level is seeded.
  `CREATE TABLE mod_gi_target (
     goal_id VARCHAR(24) NOT NULL,
     employee_id INT NOT NULL,
     target DECIMAL(14,2) NOT NULL,
     reason VARCHAR(120) NOT NULL,
     PRIMARY KEY (goal_id, employee_id)
   )`,
  `CREATE TABLE mod_gi_incentive (
     incentive_id VARCHAR(24) PRIMARY KEY,
     goal_id VARCHAR(24) NOT NULL,
     name VARCHAR(80) NOT NULL,
     payout_type VARCHAR(12) NOT NULL,
     per_unit DECIMAL(10,2) NULL,
     cap_amount DECIMAL(10,2) NULL
   )`,
  `CREATE TABLE mod_gi_tier (
     incentive_id VARCHAR(24) NOT NULL,
     tier INT NOT NULL,
     lower_pct INT NOT NULL,
     amount DECIMAL(10,2) NOT NULL,
     PRIMARY KEY (incentive_id, tier)
   )`,
  `CREATE TABLE mod_gi_period (
     period_end DATE PRIMARY KEY,
     state VARCHAR(20) NOT NULL
   )`,
  `CREATE TABLE cdm_gi_credit (
     credit_id INT AUTO_INCREMENT PRIMARY KEY,
     goal_id VARCHAR(24) NOT NULL,
     employee_id INT NOT NULL,
     period_end DATE NOT NULL,
     occurred DATE NOT NULL,
     label VARCHAR(80) NOT NULL,
     value DECIMAL(14,2) NOT NULL,
     state VARCHAR(12) NOT NULL,
     KEY ix_gi_credit (period_end, employee_id, goal_id)
   )`,
  // Separate rows: a calculated value is never edited (spec 17.4).
  `CREATE TABLE mod_gi_adjustment (
     adjustment_id INT AUTO_INCREMENT PRIMARY KEY,
     employee_id INT NOT NULL,
     period_end DATE NOT NULL,
     amount DECIMAL(10,2) NOT NULL,
     reason_code VARCHAR(24) NOT NULL,
     note VARCHAR(160) NOT NULL,
     status VARCHAR(12) NOT NULL,
     created_by VARCHAR(40) NOT NULL
   )`,
  // Written on approval, with the amount as approved. One decision per person and period.
  `CREATE TABLE mod_gi_payout (
     employee_id INT NOT NULL,
     period_end DATE NOT NULL,
     amount DECIMAL(10,2) NOT NULL,
     status VARCHAR(20) NOT NULL,
     approver_user_id VARCHAR(40) NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     approved_at DATETIME NOT NULL,
     PRIMARY KEY (employee_id, period_end)
   )`,
];

export const GOALS_WRITE_TABLES = ['mod_gi_payout'];

export const GI_PERIOD = '2026-10-31';
export const GI_PRIOR = '2026-09-30';

export const GI_GOALS = [
  ['CHECKING', 'New checking accounts', 'count', 'MSR', 'target', 10, 'accounts'],
  ['REFERRALS', 'Referrals sold', 'count', 'MSR', 'target', 6, 'sold referrals'],
  ['FUNDED', 'Funded loan dollars', 'currency', 'Loan officer', 'target', 400_000, 'funded'],
  ['BRANCH_FUNDED', 'Branch funded loan dollars', 'currency', 'Branch manager', 'target', 800_000, 'funded'],
  ['SURVEY', 'Member survey score', 'score', '*', 'qualifier', 80, 'points'],
] as const;

export const GI_INCENTIVES = [
  ['I_CHECKING', 'CHECKING', 'New checking incentive', 'tiered', null, null],
  ['I_REFERRALS', 'REFERRALS', 'Referrals sold incentive', 'per_unit', 10, 150],
  ['I_FUNDED', 'FUNDED', 'Funded loans incentive', 'tiered', null, null],
  ['I_BRANCH', 'BRANCH_FUNDED', 'Branch manager incentive', 'tiered', null, null],
] as const;

export const GI_TIERS = [
  ['I_CHECKING', 1, 100, 75],
  ['I_CHECKING', 2, 120, 150],
  ['I_FUNDED', 1, 100, 200],
  ['I_FUNDED', 2, 120, 400],
  ['I_FUNDED', 3, 150, 600],
  ['I_BRANCH', 1, 100, 300],
  ['I_BRANCH', 2, 120, 500],
] as const;

/** A first branch worth showing: a qualifier missed, a cap reached, a big jump, a pending adjustment. */
const SHOWCASE: Record<number, { FUNDED?: [number, number]; CHECKING?: [number, number]; REFERRALS?: [number, number]; survey?: number; active?: number }> = {
  1: { FUNDED: [520_000, 430_000] },
  2: { FUNDED: [310_000, 410_000] },
  3: { CHECKING: [13, 11], REFERRALS: [7, 6], survey: 76 },
  4: { CHECKING: [11, 10], REFERRALS: [4, 5], survey: 88, active: 2 },
  5: { CHECKING: [14, 8], REFERRALS: [18, 5], survey: 91 },
};

const PRODUCTS = ['Auto loan', 'First mortgage', 'HELOC', 'Personal loan', 'Business loan'];
const REFERRED = ['Auto loan', 'HELOC', 'Credit card', 'First mortgage'];

const inMonth = (period: string, id: number, salt: number) => `${period.slice(0, 8)}${String(1 + Math.floor(unit(id, salt) * (period === GI_PERIOD ? 25 : 30))).padStart(2, '0')}`;

export function generateGoals(t: GeneratedTenant) {
  const credits: unknown[][] = [];
  const add = (goal: string, emp: number, period: string, salt: number, label: string, value: number, state = 'counted') => credits.push([goal, emp, period, inMonth(period, emp * 100 + salt, 201), label, value, state]);
  for (const e of t.employees as [number, string, string, number][]) {
    const [id, , role] = e;
    const show = SHOWCASE[id];
    for (const [period, i] of [[GI_PERIOD, 0], [GI_PRIOR, 1]] as const) {
      const salt = i ? 211 : 203;
      if (role === 'Loan officer') {
        const total = show?.FUNDED?.[i] ?? Math.round((240_000 + unit(id, salt) * 340_000) / 1000) * 1000;
        const loans = 3 + Math.floor(unit(id, salt + 1) * 3);
        const each = Math.floor(total / loans / 100) * 100;
        for (let n = 0; n < loans; n++) add('FUNDED', id, period, n + i * 50, `${PRODUCTS[Math.floor(unit(id + n, salt + 2) * PRODUCTS.length)]} funded`, n === loans - 1 ? total - each * (loans - 1) : each);
      }
      if (role === 'MSR') {
        const checking = show?.CHECKING?.[i] ?? 6 + Math.floor(unit(id, salt + 3) * 9);
        const sold = show?.REFERRALS?.[i] ?? 2 + Math.floor(unit(id, salt + 4) * 9);
        for (let n = 0; n < checking; n++) add('CHECKING', id, period, n + i * 50, 'Checking opened', 1);
        for (let n = 0; n < sold; n++) add('REFERRALS', id, period, n + 100 + i * 50, `Referral sold: ${REFERRED[Math.floor(unit(id + n, salt + 5) * REFERRED.length)]}`, 1);
        if (!i) for (let n = 0; n < (show?.active ?? 0); n++) add('REFERRALS', id, period, n + 150, `Referral active: ${REFERRED[Math.floor(unit(id + n, salt + 6) * REFERRED.length)]}`, 1, 'active');
      }
      add('SURVEY', id, period, 199, 'Member survey score', (i ? null : show?.survey) ?? 81 + Math.floor(unit(id, salt + 7) * 16));
    }
  }
  return {
    periods: [[GI_PRIOR, 'paid'], [GI_PERIOD, 'pending_approval']],
    credits,
    targets: [[('CHECKING' as string), 5, 12, 'Senior MSR target, set by the branch manager']],
    adjustments: [
      [2, GI_PERIOD, 50, 'LATE-FUNDING', 'September loan funded after the cut-off', 'Approved', 'user:5120'],
      [5, GI_PERIOD, 150, 'MISSED-CREDIT', 'Referral credit missed', 'Pending', 'user:5120'],
    ],
  };
}
