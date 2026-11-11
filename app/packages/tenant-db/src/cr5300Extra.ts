// The rest of DI's 5300 Reporting: per-loan category overrides, charge-off and recovery uploads, and
// GL mapping kept editable (cr_gl_account becomes writable). Each change also records the manual
// adjustment that carries it into the lines, so the report and its audit trail agree.
export const CR_EXTRA_DDL = [
  `CREATE TABLE cr_loan_override (loan_id INT PRIMARY KEY, quarter_end DATE NOT NULL, from_code VARCHAR(12) NOT NULL, to_code VARCHAR(12) NOT NULL, amount DECIMAL(16,2) NOT NULL, reason VARCHAR(300) NOT NULL, decided_by VARCHAR(80) NOT NULL, decided_at DATETIME NOT NULL, approval_id VARCHAR(40) NOT NULL)`,
  `CREATE TABLE cr_chargeoff_upload (row_id INT AUTO_INCREMENT PRIMARY KEY, quarter_end DATE NOT NULL, file_name VARCHAR(120) NOT NULL, loan_id INT NULL, category VARCHAR(40) NOT NULL, kind VARCHAR(12) NOT NULL, amount DECIMAL(16,2) NOT NULL, posted DATE NULL, line_code VARCHAR(12) NOT NULL, uploaded_by VARCHAR(80) NOT NULL, approval_id VARCHAR(40) NOT NULL, KEY ix_co_upload (quarter_end, approval_id))`,
];
export const CR_EXTRA_WRITE_TABLES = ['cr_gl_account', 'cr_loan_override', 'cr_chargeoff_upload'];
