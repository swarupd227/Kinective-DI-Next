// Curated tenant tables (spec 15). One MySQL schema per tenant (spec 13.6, assumption in 5.7).
// cdm_* tables hold the current state after the nightly build; hist_* tables hold month-end
// rollups (FinBI history, spec 14.9) that trend questions are answered from.

export const TENANT_DDL = [
  `CREATE TABLE cdm_location (
     int_id INT PRIMARY KEY,
     name VARCHAR(60) NOT NULL,
     region VARCHAR(40) NOT NULL,
     opened_date DATE NOT NULL
   )`,
  `CREATE TABLE cdm_employee (
     employee_id INT PRIMARY KEY,
     display_name VARCHAR(80) NOT NULL,
     role VARCHAR(40) NOT NULL,
     branch_id INT NOT NULL,
     KEY ix_emp_branch (branch_id)
   )`,
  `CREATE TABLE cdm_party (
     party_id INT PRIMARY KEY,
     first_name VARCHAR(40) NOT NULL,
     last_name VARCHAR(40) NOT NULL,
     birth_date DATE NOT NULL,
     join_date DATE NOT NULL,
     primary_branch_id INT NOT NULL,
     segment_code VARCHAR(30) NOT NULL,
     household_id INT NOT NULL,
     is_member TINYINT NOT NULL,
     KEY ix_party_branch (primary_branch_id),
     KEY ix_party_join (join_date)
   )`,
  `CREATE TABLE cdm_loan (
     loan_id INT PRIMARY KEY,
     party_id INT NOT NULL,
     branch_id INT NOT NULL,
     officer_id INT NOT NULL,
     loan_category VARCHAR(30) NOT NULL,
     is_indirect TINYINT NOT NULL,
     open_date DATE NOT NULL,
     close_date DATE NULL,
     charge_off_date DATE NULL,
     original_amount DECIMAL(14,2) NOT NULL,
     balance DECIMAL(14,2) NOT NULL,
     rate DECIMAL(6,3) NOT NULL,
     days_delinquent INT NOT NULL,
     KEY ix_loan_branch (branch_id),
     KEY ix_loan_open (open_date)
   )`,
  `CREATE TABLE cdm_deposit_account (
     account_id INT PRIMARY KEY,
     party_id INT NOT NULL,
     branch_id INT NOT NULL,
     deposit_category VARCHAR(30) NOT NULL,
     open_date DATE NOT NULL,
     close_date DATE NULL,
     maturity_date DATE NULL,
     balance DECIMAL(14,2) NOT NULL,
     rate DECIMAL(6,3) NOT NULL,
     KEY ix_dep_branch (branch_id)
   )`,
  `CREATE TABLE hist_loan_month (
     month_end DATE NOT NULL,
     branch_id INT NOT NULL,
     loan_category VARCHAR(30) NOT NULL,
     is_indirect TINYINT NOT NULL,
     balance DECIMAL(16,2) NOT NULL,
     delinquent_60_balance DECIMAL(16,2) NOT NULL,
     loan_count INT NOT NULL,
     new_loan_amount DECIMAL(16,2) NOT NULL,
     new_loan_count INT NOT NULL,
     PRIMARY KEY (month_end, branch_id, loan_category, is_indirect)
   )`,
  `CREATE TABLE hist_deposit_month (
     month_end DATE NOT NULL,
     branch_id INT NOT NULL,
     deposit_category VARCHAR(30) NOT NULL,
     balance DECIMAL(16,2) NOT NULL,
     account_count INT NOT NULL,
     PRIMARY KEY (month_end, branch_id, deposit_category)
   )`,
  `CREATE TABLE hist_party_month (
     month_end DATE NOT NULL,
     branch_id INT NOT NULL,
     member_count INT NOT NULL,
     new_member_count INT NOT NULL,
     PRIMARY KEY (month_end, branch_id)
   )`,
  // Published nightly builds (spec 14.8.5): every answer states the build it came from.
  `CREATE TABLE meta_build (
     build_id VARCHAR(40) PRIMARY KEY,
     as_of_date DATE NOT NULL,
     completed_at DATETIME NOT NULL,
     state VARCHAR(20) NOT NULL
   )`,
];

export const TENANT_TABLES = ['cdm_location', 'cdm_employee', 'cdm_party', 'cdm_loan', 'cdm_deposit_account', 'hist_loan_month', 'hist_deposit_month', 'hist_party_month', 'meta_build'];
