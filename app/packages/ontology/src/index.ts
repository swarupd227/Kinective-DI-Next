export * from './model.ts';
export * from './rows.ts';
export * from './concepts.ts';
export * from './quality.ts';
export * from './owl.ts';
export * from './text.ts';
export * from './words.ts';

/** DI's hub tables: every column of each must be bound to a property (the build fails otherwise). */
export const HUB_TABLES = [
  'cdm_party', 'cdm_party_detail', 'cdm_party_address', 'cdm_party_contact',
  'cdm_account', 'cdm_account_holding', 'cdm_account_owner', 'cdm_account_product',
  'cdm_household',
  'cdm_deposit_account', 'cdm_deposit_terms', 'cdm_deposit_product',
  'cdm_loan', 'cdm_loan_terms', 'cdm_loan_product', 'cdm_loan_chargeoff', 'cdm_loan_recovery',
  'cdm_product_detail',
  'cdm_card', 'cdm_card_terms', 'cdm_card_product',
  'cdm_credit_score_history',
  'cdm_location', 'cdm_employee',
] as const;
