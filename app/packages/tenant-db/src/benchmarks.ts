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
];

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
