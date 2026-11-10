// The board's yardsticks: this year's plan (budget) for each headline measure, and the peer median the
// institution compares itself with. Plans are the demo institutions' own; peers are illustrative medians
// for a credit union over $1B (NCUA Financial Performance Report peer group) and a $1–3B community bank
// (FDIC peer group), not any real institution's or regulator's published figures.
export const BENCHMARK_DDL = [
  `CREATE TABLE fin_benchmark (
     kind VARCHAR(8) NOT NULL,
     metric VARCHAR(60) NOT NULL,
     value DECIMAL(12,4) NOT NULL,
     source VARCHAR(160) NOT NULL,
     PRIMARY KEY (kind, metric)
   )`,
  // The budget as it is drafted and approved, a line per measure and year, and every change to it.
  `CREATE TABLE fin_budget (
     year INT NOT NULL,
     metric VARCHAR(60) NOT NULL,
     value DECIMAL(12,4) NOT NULL,
     status VARCHAR(12) NOT NULL,
     note VARCHAR(200) NULL,
     updated_by VARCHAR(80) NULL,
     approval_id VARCHAR(40) NULL,
     PRIMARY KEY (year, metric)
   )`,
  `CREATE TABLE fin_budget_event (
     event_id INT AUTO_INCREMENT PRIMARY KEY,
     year INT NOT NULL,
     action VARCHAR(20) NOT NULL,
     detail VARCHAR(200) NOT NULL,
     by_name VARCHAR(80) NOT NULL,
     at DATETIME NOT NULL,
     approval_id VARCHAR(40) NULL
   )`,
  // A bank's shares outstanding and share price at each quarter end. Neither is on the Call Report: the
  // CFO enters them from the transfer agent's report and the market close, and each change is approved.
  `CREATE TABLE fin_share (
     quarter_end DATE NOT NULL PRIMARY KEY,
     shares_outstanding BIGINT NOT NULL,
     weighted_shares BIGINT NOT NULL,
     price DECIMAL(10,2) NULL,
     source VARCHAR(160) NOT NULL,
     entered_by VARCHAR(80) NOT NULL,
     approval_id VARCHAR(40) NULL
   )`,
  // The CFO's CECL assumptions: the economic scenario weights (weight:baseline, weight:adverse,
  // weight:severe, in percent) and the qualitative adjustment for each loan type (q:<loan type>, in basis
  // points of its balance). Each change is approved.
  `CREATE TABLE fin_cecl (
     setting VARCHAR(60) NOT NULL PRIMARY KEY,
     value DECIMAL(10,4) NOT NULL,
     note VARCHAR(200) NULL,
     updated_by VARCHAR(80) NULL,
     approval_id VARCHAR(40) NULL
   )`,
];

export const BUDGET_WRITE_TABLES = ['fin_budget', 'fin_budget_event', 'fin_share', 'fin_cecl'];

/** A bank CFO's CECL assumptions as set for the third quarter: mostly the baseline forecast, and two Q-factors. */
export function ceclSeed(institutionType: 'credit_union' | 'bank') {
  if (institutionType !== 'bank') return [];
  return [
    ['weight:baseline', 75, 'Consensus forecast: growth slows, unemployment near 4.5%', 'Elena Ortiz', null],
    ['weight:adverse', 20, 'A moderate recession', 'Elena Ortiz', null],
    ['weight:severe', 5, 'A deep recession', 'Elena Ortiz', null],
    ['q:Commercial Real Estate', 5, 'Office and retail exposure in a concentrated CRE book', 'Elena Ortiz', null],
    ['q:Consumer', 25, 'Unsecured consumer delinquency rising nationally', 'Elena Ortiz', null],
  ];
}

/** A bank's share register by quarter, as the CFO entered it: shares edge up as restricted stock vests. */
export function shareSeed(institutionType: 'credit_union' | 'bank') {
  if (institutionType !== 'bank') return [];
  const q: [string, number, number, number][] = [
    ['2025-09-30', 4_872_400, 4_871_100, 26.1],
    ['2025-12-31', 4_875_900, 4_874_300, 25.4],
    ['2026-03-31', 4_881_200, 4_878_800, 26.8],
    ['2026-06-30', 4_884_000, 4_882_700, 27.2],
    ['2026-09-30', 4_886_500, 4_885_300, 27.9],
  ];
  return q.map(([end, out, avg, price]) => [end, out, avg, price, 'Transfer agent report and OTCQX close', 'Elena Ortiz', null]);
}

/** This year's plan as approved lines, and the event that approved it. */
export function budgetSeed(institutionType: 'credit_union' | 'bank') {
  const lines = benchmarks(institutionType).filter((r) => r[0] === 'plan').map(([, metric, value]) => [2026, metric, value, 'Approved', 'Approved by the board, December 2025', institutionType === 'bank' ? 'Elena Ortiz' : 'Dana Lee', null]);
  return { lines, events: [[2026, 'Approved', `${lines.length} targets approved by the board`, 'Board of directors', '2025-12-16 18:00:00', null]] };
}

type Row = [kind: 'plan' | 'peer', metric: string, value: number, source: string];
const PLAN_CU = '2026 budget, approved by the board in December 2025';
const PEER_CU = 'Peer median: credit unions over $1B in assets, Q2 2026 (illustrative)';
const PLAN_BANK = '2026 budget, approved by the board in December 2025';
const PEER_BANK = 'Peer median: commercial banks $1–3B in assets, Q2 2026 (illustrative)';

export function benchmarks(institutionType: 'credit_union' | 'bank'): Row[] {
  if (institutionType === 'bank') {
    return [
      ['plan', 'return_on_assets', 1.0, PLAN_BANK],
      ['plan', 'net_interest_margin', 3.4, PLAN_BANK],
      ['plan', 'efficiency_ratio', 62, PLAN_BANK],
      ['plan', 'net_worth_ratio', 10.25, PLAN_BANK],
      ['plan', 'net_charge_off_ratio', 0.3, PLAN_BANK],
      ['peer', 'return_on_assets', 1.05, PEER_BANK],
      ['peer', 'net_interest_margin', 3.45, PEER_BANK],
      ['peer', 'efficiency_ratio', 62.5, PEER_BANK],
      ['peer', 'net_worth_ratio', 10.6, PEER_BANK],
      ['peer', 'net_charge_off_ratio', 0.22, PEER_BANK],
      ['plan', 'delinquency_ratio_60_plus', 0.55, PLAN_BANK],
      ['plan', 'loan_to_share_ratio', 80, PLAN_BANK],
      ['plan', 'loan_growth', 5, PLAN_BANK],
      ['plan', 'deposit_growth', 4, PLAN_BANK],
      ['plan', 'member_growth', 1.5, PLAN_BANK],
      ['peer', 'delinquency_ratio_60_plus', 0.62, PEER_BANK],
      ['peer', 'loan_to_share_ratio', 84.5, PEER_BANK],
      ['peer', 'loan_growth', 4.1, PEER_BANK],
      ['peer', 'deposit_growth', 3.2, PEER_BANK],
      ['peer', 'member_growth', 1.0, PEER_BANK],
      ['plan', 'non_interest_income_share', 15, PLAN_BANK],
      ['peer', 'non_interest_income_share', 19.5, PEER_BANK],
      ['plan', 'tbv_per_share_growth', 7, PLAN_BANK],
      ['peer', 'tbv_per_share_growth', 6.5, PEER_BANK],
      ['peer', 'price_to_tangible_book', 1.2, PEER_BANK],
      ['peer', 'price_to_earnings', 11.5, PEER_BANK],
      ['plan', 'provision_to_average_loans', 0.3, PLAN_BANK],
      ['peer', 'provision_to_average_loans', 0.24, PEER_BANK],
      ['peer', 'allowance_to_loans', 1.25, PEER_BANK],
    ];
  }
  return [
    ['plan', 'return_on_assets', 0.9, PLAN_CU],
    ['plan', 'net_interest_margin', 3.25, PLAN_CU],
    ['plan', 'efficiency_ratio', 70, PLAN_CU],
    ['plan', 'net_worth_ratio', 10.5, PLAN_CU],
    ['plan', 'net_charge_off_ratio', 0.55, PLAN_CU],
    ['plan', 'delinquency_ratio_60_plus', 0.75, PLAN_CU],
    ['plan', 'loan_to_share_ratio', 76, PLAN_CU],
    ['plan', 'loan_growth', 4, PLAN_CU],
    ['plan', 'deposit_growth', 4.5, PLAN_CU],
    ['plan', 'member_growth', 2, PLAN_CU],
    ['peer', 'return_on_assets', 0.71, PEER_CU],
    ['peer', 'net_interest_margin', 3.08, PEER_CU],
    ['peer', 'efficiency_ratio', 75.8, PEER_CU],
    ['peer', 'net_worth_ratio', 10.9, PEER_CU],
    ['peer', 'net_charge_off_ratio', 0.72, PEER_CU],
    ['peer', 'delinquency_ratio_60_plus', 0.96, PEER_CU],
    ['peer', 'loan_to_share_ratio', 83.5, PEER_CU],
    ['peer', 'loan_growth', 2.8, PEER_CU],
    ['peer', 'deposit_growth', 3.9, PEER_CU],
    ['peer', 'member_growth', 1.1, PEER_CU],
  ];
}
