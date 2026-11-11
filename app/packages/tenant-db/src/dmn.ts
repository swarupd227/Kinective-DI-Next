// Decision tables (DMN): business rules people can read and change, which DI applies to its own data.
// Each version of a table is kept: its inputs and outputs, its hit policy and its rules. One version is
// active; a change is a new version, made active once someone other than the person asking approves it.
// - Retention outreach: from the attrition model's band, deposits, products and years as a member, what
//   to do about each member, who does it and within how many days.
// - Consumer loan pricing adjustments: from the credit score, LTV, term and whether pay is deposited
//   here, the basis points added to or taken off the base rate, summed (a collect-and-sum table).
export const DMN_DDL = [
  `CREATE TABLE IF NOT EXISTS dmn_table_version (
     table_key VARCHAR(40) NOT NULL,
     version INT NOT NULL,
     status VARCHAR(12) NOT NULL,
     name VARCHAR(120) NOT NULL,
     description VARCHAR(500) NOT NULL,
     module VARCHAR(40) NOT NULL,
     hit_policy VARCHAR(12) NOT NULL,
     aggregation VARCHAR(8) NULL,
     inputs JSON NOT NULL,
     outputs JSON NOT NULL,
     rules JSON NOT NULL,
     note VARCHAR(500) NULL,
     changed_by VARCHAR(80) NOT NULL,
     changed_at DATETIME NOT NULL,
     approved_by VARCHAR(80) NULL,
     approval_id VARCHAR(40) NULL,
     activated_at DATETIME NULL,
     PRIMARY KEY (table_key, version)
   )`,
];
export const DMN_WRITE_TABLES = ['dmn_table_version'];

export interface DmnColumn {
  key: string;
  label: string;
  type: 'number' | 'text' | 'boolean';
  /** For an output: the values it may take, when it is a fixed list. */
  values?: string[];
}
export interface DmnRule {
  /** One condition per input, by key: "-" for any. */
  when: Record<string, string>;
  /** One value per output, by key. */
  then: Record<string, string>;
  note?: string;
}
export interface DmnTableDef {
  key: string;
  name: string;
  description: string;
  module: string;
  hitPolicy: 'FIRST' | 'UNIQUE' | 'COLLECT' | 'RULE ORDER';
  aggregation?: 'SUM' | 'MIN' | 'MAX' | 'COUNT';
  inputs: DmnColumn[];
  outputs: DmnColumn[];
  rules: DmnRule[];
}

/** The tables a new institution starts with, worded for a credit union or a bank. */
export function defaultDecisionTables(institutionType: 'credit_union' | 'bank'): DmnTableDef[] {
  const member = institutionType === 'bank' ? 'customer' : 'member';
  const service = institutionType === 'bank' ? 'Customer service' : 'Member service';
  return [
    {
      key: 'retention_action',
      name: 'Retention outreach',
      description: `What to do about each ${member} the attrition model scores, who does it and within how many days. The first rule that matches decides.`,
      module: 'predictive',
      hitPolicy: 'FIRST',
      inputs: [
        { key: 'band', label: 'Attrition band', type: 'text' },
        { key: 'deposits', label: 'Deposits ($)', type: 'number' },
        { key: 'products', label: 'Products held', type: 'number' },
        { key: 'years', label: `Years as a ${member}`, type: 'number' },
      ],
      outputs: [
        { key: 'action', label: 'Action', type: 'text' },
        { key: 'owner', label: 'Owner', type: 'text' },
        { key: 'within', label: 'Within (days)', type: 'number' },
      ],
      rules: [
        { when: { band: 'High', deposits: '>= 50000', products: '-', years: '-' }, then: { action: 'Branch manager call', owner: 'Branch manager', within: '2' }, note: 'The most to lose' },
        { when: { band: 'High', deposits: '[10000..50000)', products: '-', years: '-' }, then: { action: 'Personal call', owner: 'Relationship banker', within: '5' } },
        { when: { band: 'High', deposits: '< 10000', products: '-', years: '>= 5' }, then: { action: 'Personal call', owner: service, within: '7' }, note: 'Long relationships are worth a call' },
        { when: { band: 'High', deposits: '-', products: '-', years: '-' }, then: { action: 'Email with a retention offer', owner: 'Marketing', within: '7' } },
        { when: { band: 'Medium', deposits: '>= 25000', products: '-', years: '-' }, then: { action: 'Personal call', owner: 'Relationship banker', within: '10' } },
        { when: { band: 'Medium', deposits: '-', products: '<= 1', years: '-' }, then: { action: 'Cross-sell offer', owner: 'Marketing', within: '14' }, note: 'One product is the easiest to leave' },
        { when: { band: 'Medium', deposits: '-', products: '-', years: '-' }, then: { action: 'Check-in email', owner: 'Marketing', within: '14' } },
        { when: { band: '-', deposits: '-', products: '-', years: '-' }, then: { action: 'No action', owner: '—', within: '0' } },
      ],
    },
    {
      key: 'loan_pricing',
      name: 'Consumer loan pricing adjustments',
      description: 'Basis points added to or taken off the base rate for a consumer loan. Every rule that matches applies, and their adjustments add up. Over +300 bp needs a pricing exception.',
      module: 'profitability',
      hitPolicy: 'COLLECT',
      aggregation: 'SUM',
      inputs: [
        { key: 'score', label: 'Credit score', type: 'number' },
        { key: 'ltv', label: 'LTV (%)', type: 'number' },
        { key: 'term', label: 'Term (months)', type: 'number' },
        { key: 'direct_deposit', label: 'Direct deposit here', type: 'boolean' },
      ],
      outputs: [
        { key: 'adjustment', label: 'Adjustment (bp)', type: 'number' },
        { key: 'reason', label: 'Reason', type: 'text' },
      ],
      rules: [
        { when: { score: '>= 760', ltv: '-', term: '-', direct_deposit: '-' }, then: { adjustment: '-25', reason: 'Tier A credit' } },
        { when: { score: '[700..760)', ltv: '-', term: '-', direct_deposit: '-' }, then: { adjustment: '0', reason: 'Tier B credit' } },
        { when: { score: '[640..700)', ltv: '-', term: '-', direct_deposit: '-' }, then: { adjustment: '100', reason: 'Tier C credit' } },
        { when: { score: '< 640', ltv: '-', term: '-', direct_deposit: '-' }, then: { adjustment: '250', reason: 'Tier D credit' } },
        { when: { score: '-', ltv: '> 100', term: '-', direct_deposit: '-' }, then: { adjustment: '75', reason: 'Over 100% LTV' } },
        { when: { score: '-', ltv: '-', term: '> 72', direct_deposit: '-' }, then: { adjustment: '50', reason: 'Term over 72 months' } },
        { when: { score: '-', ltv: '-', term: '-', direct_deposit: 'yes' }, then: { adjustment: '-25', reason: 'Direct deposit discount' } },
      ],
    },
  ];
}

/** Rows for dmn_table_version: each default table as version 1, active. */
export function decisionTableRows(institutionType: 'credit_union' | 'bank', at: string) {
  return defaultDecisionTables(institutionType).map((t) => [t.key, 1, 'Active', t.name, t.description, t.module, t.hitPolicy, t.aggregation ?? null, JSON.stringify(t.inputs), JSON.stringify(t.outputs), JSON.stringify(t.rules), 'The table DI starts with.', 'DI setup', at, 'DI setup', null, at]);
}
export const DECISION_TABLE_COLUMNS = ['table_key', 'version', 'status', 'name', 'description', 'module', 'hit_policy', 'aggregation', 'inputs', 'outputs', 'rules', 'note', 'changed_by', 'changed_at', 'approved_by', 'approval_id', 'activated_at'];
