// Demo data for the business modules: compliance issues, onboarding touch points and data logs. Each
// is keyed on its own rows rather than the generator, so no existing figure moves.
import { AS_OF, unit, ymd, type GeneratedTenant } from './generate.ts';

export const MODULES_DDL = [
  `CREATE TABLE cpm_issue (
     issue_id INT PRIMARY KEY,
     party_id INT NOT NULL,
     kind VARCHAR(12) NOT NULL,
     source VARCHAR(24) NOT NULL,
     category VARCHAR(40) NOT NULL,
     summary VARCHAR(200) NOT NULL,
     status VARCHAR(16) NOT NULL,
     owner_employee_id INT NULL,
     branch_id INT NOT NULL,
     opened DATE NOT NULL,
     respond_by DATE NOT NULL,
     resolve_by DATE NOT NULL,
     closed DATE NULL,
     resolution VARCHAR(300) NULL,
     root_cause VARCHAR(80) NULL,
     approval_id VARCHAR(40) NULL UNIQUE,
     KEY ix_cpm_status (status, opened)
   )`,
  // Kept for the audit report: issues are never deleted (EP23-F01).
  `CREATE TABLE cpm_issue_history (
     history_id INT AUTO_INCREMENT PRIMARY KEY,
     issue_id INT NOT NULL,
     at DATE NOT NULL,
     actor VARCHAR(80) NOT NULL,
     action VARCHAR(40) NOT NULL,
     note VARCHAR(300) NULL,
     KEY ix_cpm_hist (issue_id, history_id)
   )`,
  `CREATE TABLE onb_task (
     task_id INT PRIMARY KEY,
     party_id INT NOT NULL,
     touch VARCHAR(40) NOT NULL,
     day_offset INT NOT NULL,
     due DATE NOT NULL,
     status VARCHAR(12) NOT NULL,
     assignee_employee_id INT NULL,
     branch_id INT NOT NULL,
     done_on DATE NULL,
     note VARCHAR(200) NULL,
     KEY ix_onb_due (status, due)
   )`,
  `CREATE TABLE esp_datalog_type (
     type_id VARCHAR(24) PRIMARY KEY,
     label VARCHAR(60) NOT NULL,
     financial TINYINT NOT NULL,
     requires_approval TINYINT NOT NULL
   )`,
  `CREATE TABLE esp_datalog (
     log_id INT PRIMARY KEY,
     type_id VARCHAR(24) NOT NULL,
     title VARCHAR(120) NOT NULL,
     amount DECIMAL(14,2) NULL,
     branch_id INT NOT NULL,
     status VARCHAR(12) NOT NULL,
     created_by VARCHAR(40) NOT NULL,
     created_name VARCHAR(80) NOT NULL,
     created_on DATE NOT NULL,
     approval_id VARCHAR(40) NULL UNIQUE
   )`,
  `CREATE TABLE esp_datalog_history (
     history_id INT AUTO_INCREMENT PRIMARY KEY,
     log_id INT NOT NULL,
     at DATE NOT NULL,
     actor VARCHAR(80) NOT NULL,
     from_status VARCHAR(12) NULL,
     to_status VARCHAR(12) NOT NULL,
     note VARCHAR(300) NULL,
     KEY ix_dlg_hist (log_id, history_id)
   )`,
  `CREATE TABLE ops_upload (source VARCHAR(40) PRIMARY KEY, due_by VARCHAR(8) NOT NULL, arrived VARCHAR(8) NOT NULL, late TINYINT NOT NULL)`,
  `CREATE TABLE ops_dq_check (check_id INT AUTO_INCREMENT PRIMARY KEY, domain VARCHAR(40) NOT NULL, dimension VARCHAR(20) NOT NULL, name VARCHAR(80) NOT NULL, status VARCHAR(8) NOT NULL, rows_failed INT NOT NULL)`,
  `CREATE TABLE iam_user (user_id VARCHAR(40) PRIMARY KEY, name VARCHAR(80) NOT NULL, user_class VARCHAR(30) NOT NULL, branch VARCHAR(40) NULL, status VARCHAR(12) NOT NULL, approval_id VARCHAR(40) NULL UNIQUE)`,
  `CREATE TABLE cr_line (code VARCHAR(8) PRIMARY KEY, schedule VARCHAR(4) NOT NULL, name VARCHAR(80) NOT NULL)`,
  `CREATE TABLE cr_entry (code VARCHAR(8) NOT NULL, entry_type VARCHAR(60) NOT NULL, source VARCHAR(60) NOT NULL, multiplier INT NOT NULL, prior_value DECIMAL(16,2) NOT NULL, current_value DECIMAL(16,2) NOT NULL, PRIMARY KEY (code, entry_type))`,
  `CREATE TABLE cr_check (name VARCHAR(80) PRIMARY KEY, status VARCHAR(8) NOT NULL, detail VARCHAR(160) NOT NULL)`,
  // The general ledger accounts the 5300 maps from. An account with no line is what fails the check.
  `CREATE TABLE cr_gl_account (gl_number VARCHAR(8) PRIMARY KEY, name VARCHAR(80) NOT NULL, balance DECIMAL(14,2) NOT NULL, line_code VARCHAR(8) NULL, opened DATE NOT NULL, last_posted DATE NOT NULL, likely_line VARCHAR(80) NULL, note VARCHAR(160) NULL)`,
  `CREATE TABLE col_outreach (loan_id INT PRIMARY KEY, status VARCHAR(12) NOT NULL, queued_by VARCHAR(80) NOT NULL, approval_id VARCHAR(40) NOT NULL)`,
  `CREATE TABLE cmp_campaign (campaign_id INT PRIMARY KEY, name VARCHAR(80) NOT NULL, channel VARCHAR(20) NOT NULL, product VARCHAR(40) NOT NULL, sent INT NOT NULL, applications INT NOT NULL, loan_dollars DECIMAL(14,2) NOT NULL)`,
  `CREATE TABLE cmp_audience (audience_id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL, category VARCHAR(40) NOT NULL, size INT NOT NULL, created_by VARCHAR(40) NOT NULL, approval_id VARCHAR(40) NOT NULL UNIQUE)`,
  `CREATE TABLE seg_company (company_id INT PRIMARY KEY, name VARCHAR(80) NOT NULL, stage VARCHAR(40) NOT NULL, members INT NOT NULL, new_members INT NOT NULL, loans DECIMAL(14,2) NOT NULL, deposits DECIMAL(14,2) NOT NULL, owner VARCHAR(80) NULL, sponsorship VARCHAR(120) NULL)`,
  `CREATE TABLE seg_interaction (interaction_id INT AUTO_INCREMENT PRIMARY KEY, company_id INT NOT NULL, at DATE NOT NULL, kind VARCHAR(20) NOT NULL, note VARCHAR(300) NOT NULL, by_name VARCHAR(80) NOT NULL, approval_id VARCHAR(40) NULL UNIQUE)`,
];

export const MODULES_WRITE_TABLES = ['cpm_issue', 'cpm_issue_history', 'onb_task', 'esp_datalog', 'esp_datalog_history', 'iam_user', 'col_outreach', 'cmp_audience', 'seg_company', 'seg_interaction'];

export const ISSUE_CATEGORIES = ['Fees', 'Overdraft', 'Card dispute', 'Loan servicing', 'Account access', 'Service'];
export const REGULATORS = ['OCC', 'CFPB', 'FDIC', 'NCUA'];
export const ROOT_CAUSES = ['Process', 'System', 'Staff error', 'Third party', 'Member error', 'No fault found'];
/** Days to respond and to resolve [Assumption CA-43]: demo values until Kinective supplies them. */
export const ISSUE_SLA = { regulatory: { respond: 5, resolve: 15 }, customer: { respond: 5, resolve: 30 } };

export const TOUCHES: [string, number][] = [['Welcome call', 2], ['Digital set-up check', 14], ['30-day check-in', 30], ['60-day review', 60], ['90-day review', 90]];

export const DATALOG_TYPES = [
  ['CASH_COUNT', 'Cash count adjustment', 1, 1],
  ['INCENTIVE', 'Manual incentive adjustment', 1, 1],
  ['EVENT', 'Community event', 0, 1],
  ['SURVEY', 'Member survey entry', 0, 0],
] as const;

/** Fixed demo content for the small operational modules. Nothing here depends on the generator. */
export const MODULE_FIXTURES = {
  uploads: [['Card processor', '03:00', '02:41', 0], ['Core extract', '03:00', '02:48', 0], ['Goal scores', '02:00', '05:15', 1], ['LOS feed', '03:30', '03:12', 0]],
  checks: [
    ['Core Integration', 'Completeness', 'loan.branch_id not null', 'Fail', 312],
    ['Core Integration', 'Conformity', 'share.open_date not in future', 'Fail', 4],
    ['Core Integration', 'Uniqueness', 'party.member_number unique', 'Pass', 0],
    ['Core Integration', 'Timeliness', 'core extract arrived by 03:00', 'Pass', 0],
    ['Lending', 'Consistency', 'loan balance matches the GL', 'Pass', 0],
    ['Lending', 'Accuracy', 'delinquency days are not negative', 'Pass', 0],
    ['Deposits', 'Completeness', 'certificate maturity present', 'Pass', 0],
    ['Deposits', 'Consistency', 'share balance matches the GL', 'Pass', 0],
  ],
  classes: [['user:9229', 'Dana Lee', 'Executive', null], ['user:4410', 'Priya Shah', 'Analyst', null], ['user:1002', 'Sam Taylor', 'Administrator', null], ['user:5120', 'Marcus Reed', 'Manager', 'Westport'], ['user:6101', 'Ana Ruiz', 'Lender', 'Westport'], ['user:6004', 'Sofia Ruiz', 'MSR', 'Westport']],
  lines: [['010', 'A', 'Cash on hand'], ['013', 'A', 'Investments'], ['025B', 'A', 'Total loans and leases'], ['018', 'A', 'Total shares and deposits'], ['041B', 'B', 'Delinquent loans, 60 days or more'], ['115', 'B', 'Net income']],
  entries: [
    ['010', 'Vault cash', 'GL 1010-1019', 1, 4_210_000, 4_480_000],
    ['013', 'Certificates at banks', 'GL 1200-1219', 1, 18_600_000, 17_900_000],
    ['013', 'Government securities', 'GL 1220-1239', 1, 26_400_000, 31_250_000],
    ['025B', 'First mortgages', 'Core: loans', 1, 118_200_000, 121_900_000],
    ['025B', 'Auto loans', 'Core: loans', 1, 74_300_000, 96_100_000],
    ['025B', 'Credit cards', 'Core: loans', 1, 12_900_000, 13_100_000],
    ['025B', 'Allowance reclass', 'GL 1490', -1, 800_000, 900_000],
    ['018', 'Share drafts', 'Core: deposits', 1, 92_100_000, 94_400_000],
    ['018', 'Certificates', 'Core: deposits', 1, 151_700_000, 160_900_000],
    ['041B', '60 to 179 days', 'Core: loans', 1, 610_000, 720_000],
    ['041B', '180 days or more', 'Core: loans', 1, 240_000, 225_000],
    ['115', 'Interest income', 'GL 4000-4199', 1, 3_920_000, 4_180_000],
    ['115', 'Operating expenses', 'GL 7000-7999', -1, 2_870_000, 3_010_000],
  ],
  // Three have no 5300 line yet, totalling $18,400: the failed check names them.
  glAccounts: [
    ['1010', 'Vault cash', 4_480_000, '010', '2002-03-01', '2026-10-24', null, null],
    ['1210', 'Certificates at other institutions', 17_900_000, '013', '2009-06-15', '2026-10-22', null, null],
    ['1225', 'US Treasury notes', 31_250_000, '013', '2011-01-10', '2026-10-20', null, null],
    ['1188', 'Due from CUSO, card program', 2_430, null, '2026-08-19', '2026-10-17', 'Other assets', 'Opened in August for the new card program; no 5300 line chosen yet.'],
    ['1795', 'Prepaid software licences', 9_850, null, '2026-07-02', '2026-10-01', 'Prepaid and other assets', 'Annual licence prepaid in July and amortised monthly; mapping not set.'],
    ['2310', 'Suspense, card settlement', 6_120, null, '2026-09-28', '2026-10-24', 'Accrued liabilities', 'Settlement timing differences; should clear or be mapped before filing.'],
    ['4010', 'Interest on loans', 4_180_000, '115', '2002-03-01', '2026-10-24', null, null],
    ['7010', 'Salaries and benefits', 1_840_000, '115', '2002-03-01', '2026-10-24', null, null],
  ],
  crChecks: [['Accounts balance', 'Pass', 'Assets equal liabilities and equity.'], ['GL accounts categorized', 'Fail', '3 uncategorized GL accounts, totalling $18,400.'], ['Delinquency agrees with the core', 'Pass', 'Within tolerance.'], ['Net income agrees with the GL', 'Pass', 'Within tolerance.']],
  campaigns: [[1, 'HELOC fall', 'Email', 'HELOC', 18400, 212, 8_400_000], [2, 'New auto', 'Postcard', 'Auto', 26100, 188, 5_100_000], [3, 'Card balance transfer', 'Email', 'Credit Card', 31200, 340, 1_260_000], [4, 'First home', 'Branch', 'First mortgage', 2200, 41, 9_800_000], [5, 'Refi your auto', 'Email', 'Auto', 14300, 96, 2_350_000], [6, 'Holiday loan', 'Email', 'Personal Loan', 22800, 154, 1540000], [7, 'Certificate special', 'Email', 'Certificate', 19600, 233, 0], [8, 'Teen checking', 'Branch', 'Checking', 3100, 87, 0], [9, 'Boat and RV', 'Postcard', 'Auto', 8700, 39, 1420000], [10, 'Spring HELOC', 'Email', 'HELOC', 17500, 168, 6900000], [11, 'Skip a payment', 'Email', 'Auto', 24400, 412, 0], [12, 'Mortgage pre-approval', 'Digital', 'First mortgage', 12900, 64, 7600000]],
  companies: [[1, 'Albany Medical', 'Board Approved', 412, 18, 9_400_000, 12_100_000, 'Marcus Reed', 'Annual health fair'], [2, 'Acme HR', 'Meeting Held', 0, 0, 0, 0, 'Marcus Reed', null], [3, 'Riverside Schools', 'Board Approved', 655, 24, 14_200_000, 19_800_000, 'Marcus Reed', 'Teacher of the year award'], [4, 'Northgate Logistics', 'Proposal', 12, 3, 180_000, 240_000, 'Marcus Reed', null], [5, 'Lakeshore Hospitality', 'Contacted', 0, 0, 0, 0, null, null], [6, 'St. Agnes Health System', 'Board Approved', 980, 16, 21400000, 28900000, 'Marcus Reed', 'Nurses week breakfast'], [7, 'Capital Region Transit', 'Board Approved', 540, 11, 9800000, 12600000, 'Tom Walsh', null], [8, 'Hudson Valley Water Authority', 'Board Approved', 210, 4, 3100000, 5400000, 'Ana Ruiz', null], [9, 'Mohawk Paper Mill', 'Board Approved', 365, 7, 6200000, 7900000, 'Marcus Reed', 'Retiree picnic'], [10, 'Town of Colonie', 'Board Approved', 720, 13, 15700000, 22300000, 'Marcus Reed', 'Public works appreciation day'], [11, 'Pine Bush Fire District', 'Board Approved', 88, 2, 1400000, 2000000, 'Tom Walsh', null], [12, 'Hudson Community College', 'Board Approved', 430, 15, 5900000, 8800000, 'Ana Ruiz', 'Scholarship fund'], [13, 'Tri-County Electric Co-op', 'Board Approved', 260, 5, 4600000, 6100000, 'Marcus Reed', null], [14, 'Saint Luke Parish School', 'Board Approved', 64, 1, 900000, 1300000, 'Tom Walsh', null], [15, 'Harmon Foods Distribution', 'Board Approved', 310, 9, 4800000, 3900000, 'Ana Ruiz', null], [16, 'Greenway Senior Living', 'Submit Letter for Board Approval', 0, 0, 0, 0, 'Marcus Reed', null], [17, 'Brightline Software', 'Submit Letter for Board Approval', 0, 0, 0, 0, 'Ana Ruiz', null], [18, 'Union Rail Maintenance', 'Proposal', 6, 2, 110000, 90000, 'Tom Walsh', null], [19, 'Kessler Machine Works', 'Proposal', 0, 0, 0, 0, 'Marcus Reed', null], [20, 'Downtown Business Alliance', 'Proposal', 0, 0, 0, 0, 'Ana Ruiz', null], [21, 'Maplewood Veterinary Group', 'Meeting Held', 0, 0, 0, 0, 'Tom Walsh', null], [22, 'Crescent Cold Storage', 'Meeting Held', 0, 0, 0, 0, 'Marcus Reed', null], [23, 'Orchard Grove Apartments', 'Meeting Held', 0, 0, 0, 0, 'Ana Ruiz', null], [24, 'Bayside Printing', 'Contacted', 0, 0, 0, 0, 'Tom Walsh', null], [25, 'Summit Dental Partners', 'Contacted', 0, 0, 0, 0, 'Marcus Reed', null], [26, 'Granite Peak Construction', 'Contacted', 0, 0, 0, 0, null, null], [27, 'Mapleton Plastics', 'Identification', 0, 0, 0, 0, null, null], [28, 'Iron Horse Brewing', 'Identification', 0, 0, 0, 0, null, null], [29, 'Clearwater Labs', 'Identification', 0, 0, 0, 0, null, null], [30, 'Valley Courier Service', 'Closed - Lost', 0, 0, 0, 0, 'Tom Walsh', null]],
  interactions: [[1, '2026-09-30', 'Meeting', 'Reviewed open enrollment dates.', 'Marcus Reed'], [1, '2026-10-14', 'Phone call', 'Confirmed the health fair booth.', 'Marcus Reed'], [2, '2026-10-20', 'Meeting', 'HR wants a lunch-and-learn in November.', 'Marcus Reed'], [6, '2026-07-02', 'Meeting', 'Walked HR through the payroll deduction set-up.', 'Marcus Reed'], [7, '2026-08-09', 'Phone call', 'Asked for a table at the benefits fair.', 'Tom Walsh'], [7, '2026-10-20', 'Email', 'Sent the employee benefits flyer.', 'Tom Walsh'], [8, '2026-09-16', 'Email', 'Sent the employee benefits flyer.', 'Ana Ruiz'], [8, '2026-07-27', 'Meeting', 'Met the new HR director.', 'Ana Ruiz'], [8, '2026-09-12', 'Phone call', 'Followed up on the board letter.', 'Ana Ruiz'], [9, '2026-10-23', 'Meeting', 'Met the new HR director.', 'Marcus Reed'], [10, '2026-07-04', 'Phone call', 'Followed up on the board letter.', 'Marcus Reed'], [10, '2026-09-15', 'Meeting', 'Walked HR through the payroll deduction set-up.', 'Marcus Reed'], [11, '2026-08-11', 'Meeting', 'Walked HR through the payroll deduction set-up.', 'Tom Walsh'], [11, '2026-10-22', 'Phone call', 'Asked for a table at the benefits fair.', 'Tom Walsh'], [11, '2026-08-07', 'Email', 'Sent the employee benefits flyer.', 'Tom Walsh'], [12, '2026-09-18', 'Phone call', 'Asked for a table at the benefits fair.', 'Ana Ruiz'], [13, '2026-10-25', 'Email', 'Sent the employee benefits flyer.', 'Marcus Reed'], [13, '2026-08-10', 'Meeting', 'Met the new HR director.', 'Marcus Reed'], [14, '2026-07-06', 'Meeting', 'Met the new HR director.', 'Tom Walsh'], [14, '2026-09-17', 'Phone call', 'Followed up on the board letter.', 'Tom Walsh'], [14, '2026-07-02', 'Meeting', 'Walked HR through the payroll deduction set-up.', 'Tom Walsh'], [15, '2026-08-13', 'Phone call', 'Followed up on the board letter.', 'Ana Ruiz'], [16, '2026-09-20', 'Meeting', 'Walked HR through the payroll deduction set-up.', 'Marcus Reed'], [16, '2026-07-05', 'Phone call', 'Asked for a table at the benefits fair.', 'Marcus Reed'], [17, '2026-10-27', 'Phone call', 'Asked for a table at the benefits fair.', 'Ana Ruiz'], [17, '2026-08-12', 'Email', 'Sent the employee benefits flyer.', 'Ana Ruiz'], [17, '2026-10-23', 'Meeting', 'Met the new HR director.', 'Ana Ruiz'], [18, '2026-07-08', 'Email', 'Sent the employee benefits flyer.', 'Tom Walsh'], [19, '2026-08-15', 'Meeting', 'Met the new HR director.', 'Marcus Reed'], [19, '2026-10-26', 'Phone call', 'Followed up on the board letter.', 'Marcus Reed'], [20, '2026-09-22', 'Phone call', 'Followed up on the board letter.', 'Ana Ruiz'], [20, '2026-07-07', 'Meeting', 'Walked HR through the payroll deduction set-up.', 'Ana Ruiz'], [20, '2026-09-18', 'Phone call', 'Asked for a table at the benefits fair.', 'Ana Ruiz'], [21, '2026-10-03', 'Meeting', 'Walked HR through the payroll deduction set-up.', 'Tom Walsh'], [22, '2026-07-10', 'Phone call', 'Asked for a table at the benefits fair.', 'Marcus Reed'], [22, '2026-09-21', 'Email', 'Sent the employee benefits flyer.', 'Marcus Reed'], [23, '2026-08-17', 'Email', 'Sent the employee benefits flyer.', 'Ana Ruiz'], [23, '2026-10-02', 'Meeting', 'Met the new HR director.', 'Ana Ruiz'], [23, '2026-08-13', 'Phone call', 'Followed up on the board letter.', 'Ana Ruiz'], [24, '2026-09-24', 'Meeting', 'Met the new HR director.', 'Tom Walsh'], [25, '2026-10-05', 'Phone call', 'Followed up on the board letter.', 'Marcus Reed'], [25, '2026-08-16', 'Meeting', 'Walked HR through the payroll deduction set-up.', 'Marcus Reed'], [30, '2026-07-14', 'Phone call', 'Followed up on the board letter.', 'Tom Walsh']],
};

const SUMMARIES: Record<string, string[]> = {
  Fees: ['Charged a monthly fee after meeting the waiver', 'Double fee on a shared branching deposit'],
  Overdraft: ['Overdraft fee on a same-day transfer', 'Disputes the order items were posted'],
  'Card dispute': ['Card transaction not recognised', 'Merchant refund not credited'],
  'Loan servicing': ['Payment applied to the wrong loan', 'Payoff figure differs from the letter'],
  'Account access': ['Locked out of online banking', 'Account frozen without notice'],
  Service: ['Unhappy with how a branch visit was handled', 'Waited too long on the phone'],
};

const DAY = 86_400_000;

export function generateModules(t: GeneratedTenant, institutionType: 'credit_union' | 'bank') {
  const asOf = Date.parse(`${AS_OF}T00:00:00Z`);
  const daysAgo = (n: number) => ymd(new Date(asOf - Math.floor(n) * DAY));
  const plus = (d: string, n: number) => ymd(new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY));
  const employees = t.employees as [number, string, string, number][];
  const parties = t.parties as unknown[][];
  const members = (branch: number) => parties.filter((p) => p[5] === branch && p[8] === 1);
  const regulators = institutionType === 'bank' ? ['OCC', 'CFPB', 'FDIC'] : ['NCUA', 'CFPB'];
  const sources = ['Call In', 'Call In', 'Branch', 'Email', 'BBB', ...regulators];

  const issues: unknown[][] = [];
  const history: unknown[][] = [];
  const tasks: unknown[][] = [];
  const logs: unknown[][] = [];
  const logHistory: unknown[][] = [];
  let issueId = 3300;
  let taskId = 7000;
  let logId = 4470;
  // Older history, numbered apart so the rows above keep their ids. It is mostly closed or done, so
  // it adds depth for trends and root causes without adding to anyone's open work.
  let pastIssueId = 5000;
  let pastTaskId = 9000;
  let pastLogId = 6000;

  t.locations.forEach((_, i) => {
    const branch = i + 1;
    const pool = members(branch);
    const staff = employees.filter((e) => e[3] === branch);
    const msrs = staff.filter((e) => e[2] === 'MSR');
    const manager = staff.find((e) => e[2] === 'Branch manager')!;
    for (let n = 0; n < 7; n++) {
      const id = issueId++;
      // The first branch always has regulator work open, so the demo's example questions have answers.
      const forced = i === 0 ? ([[regulators[0]!, 41], [regulators[1]!, 24], ['BBB', 30]] as [string, number][])[n] : undefined;
      const source = forced?.[0] ?? sources[Math.floor(unit(id, 301) * sources.length)]!;
      const kind = REGULATORS.includes(source) || source === 'BBB' ? 'regulatory' : 'customer';
      const category = ISSUE_CATEGORIES[Math.floor(unit(id, 302) * ISSUE_CATEGORIES.length)]!;
      const options = SUMMARIES[category]!;
      const age = forced?.[1] ?? 2 + Math.floor(Math.pow(unit(id, 303), 1.4) * 55);
      const opened = daysAgo(age);
      const party = pool[Math.floor(unit(id, 304) * pool.length)]![0];
      const owner = msrs[Math.floor(unit(id, 305) * msrs.length)]![0];
      const sla = ISSUE_SLA[kind as 'regulatory' | 'customer'];
      const done = !forced && age > 12 && unit(id, 306) < 0.55;
      const worked = age > 2;
      const closed = done ? plus(opened, Math.min(age - 1, 3 + Math.floor(unit(id, 307) * 14))) : null;
      const status = done ? 'Closed' : worked && unit(id, 308) < 0.2 ? 'Escalated' : worked ? 'In Progress' : 'Open';
      issues.push([id, party, kind, source, category, options[Math.floor(unit(id, 309) * options.length)], status, owner, branch, opened, plus(opened, sla.respond), plus(opened, sla.resolve), closed, done ? 'Reviewed with the member and resolved.' : null, done ? ['Process', 'System', 'Staff error', 'Third party'][Math.floor(unit(id, 310) * 4)] : null]);
      history.push([id, opened, staff.find((e) => e[0] === owner)![1], 'Opened', `Logged from ${source}.`]);
      if (worked) history.push([id, plus(opened, 1), staff.find((e) => e[0] === owner)![1], 'Contacted the member', 'Called and confirmed the details.']);
      if (status === 'Escalated') history.push([id, plus(opened, 2), manager[1], 'Escalated', 'Passed to the compliance officer.']);
      if (done) history.push([id, closed, manager[1], 'Closed', 'Resolved.']);
    }
    // New members, each at their own point in the 90-day plan.
    for (let n = 0; n < 8; n++) {
      const person = pool[Math.floor(unit(branch * 100 + n, 311) * pool.length)]!;
      const joined = Math.floor(3 + unit(branch * 100 + n, 312) * 85);
      const start = daysAgo(joined);
      const owner = msrs[n % msrs.length]![0];
      for (const [touch, offset] of TOUCHES) {
        const id = taskId++;
        const due = plus(start, offset);
        const past = offset < joined;
        // Most past touch points are done; a few have slipped.
        const done = past && unit(id, 313) < 0.72;
        tasks.push([id, person[0], touch, offset, due, done ? 'Done' : 'Open', owner, branch, done ? plus(due, Math.floor(unit(id, 314) * 3)) : null, done ? 'Spoke with the member.' : null]);
      }
    }
    const logRow = (type: string, title: string, amount: number | null, status: string, by: [number, string, string, number], ago: number, fixedId?: number) => {
      const id = fixedId ?? ++logId;
      const on = daysAgo(ago);
      logs.push([id, type, title, amount, branch, status, `emp:${by[0]}`, by[1], on]);
      logHistory.push([id, on, by[1], null, 'Entered', null]);
      if (status !== 'Entered') logHistory.push([id, plus(on, 0), by[1], 'Entered', 'Submitted', null]);
      if (status === 'Returned') logHistory.push([id, plus(on, 1), manager[1], 'Submitted', 'Returned', 'Please add the recount sheet.']);
      if (status === 'Approved') logHistory.push([id, plus(on, 1), manager[1], 'Submitted', 'Approved', null]);
    };
    logRow('CASH_COUNT', `${String(t.locations[i]![1])} cash count adjustment`, -350, 'Submitted', msrs[0]!, 1);
    logRow('EVENT', 'School savings day', null, 'Submitted', msrs[1]!, 2);
    logRow('CASH_COUNT', 'Teller drawer recount', 120, 'Returned', msrs[0]!, 4);
    logRow('EVENT', 'Chamber of commerce breakfast', null, 'Approved', msrs[1]!, 9);

    // Customer complaints from the last six months: all but the last few weeks' are closed.
    for (let n = 0; n < 10; n++) {
      const id = pastIssueId++;
      const source = ['Call In', 'Call In', 'Branch', 'Email'][Math.floor(unit(id, 321) * 4)]!;
      const category = ISSUE_CATEGORIES[Math.floor(unit(id, 322) * ISSUE_CATEGORIES.length)]!;
      const options = SUMMARIES[category]!;
      const age = 6 + Math.floor(unit(id, 323) * 170);
      const opened = daysAgo(age);
      const party = pool[Math.floor(unit(id, 324) * pool.length)]![0];
      const owner = msrs[Math.floor(unit(id, 325) * msrs.length)]![0];
      const ownerName = staff.find((e) => e[0] === owner)![1];
      const sla = ISSUE_SLA.customer;
      // Only recent ones are still open, so the oldest open complaint stays one of the branch's own above.
      const done = age > 20;
      const closed = done ? plus(opened, Math.min(age - 1, 2 + Math.floor(unit(id, 327) * 20))) : null;
      const status = done ? 'Closed' : 'In Progress';
      issues.push([id, party, 'customer', source, category, options[Math.floor(unit(id, 328) * options.length)], status, owner, branch, opened, plus(opened, sla.respond), plus(opened, sla.resolve), closed, done ? 'Reviewed with the member and resolved.' : null, done ? ROOT_CAUSES[Math.floor(unit(id, 329) * ROOT_CAUSES.length)] : null]);
      history.push([id, opened, ownerName, 'Opened', `Logged from ${source}.`]);
      history.push([id, plus(opened, 1), ownerName, 'Contacted the member', 'Called and confirmed the details.']);
      if (done) history.push([id, closed, manager[1], 'Closed', 'Resolved.']);
    }
    // Members who joined one to three months ago, further through the 90-day plan.
    for (let n = 0; n < 12; n++) {
      const person = pool[Math.floor(unit(branch * 100 + n, 331) * pool.length)]!;
      const joined = Math.floor(30 + unit(branch * 100 + n, 332) * 58);
      const start = daysAgo(joined);
      const owner = msrs[n % msrs.length]![0];
      for (const [touch, offset] of TOUCHES) {
        const id = pastTaskId++;
        const due = plus(start, offset);
        const past = offset < joined;
        const done = past && unit(id, 333) < 0.9;
        tasks.push([id, person[0], touch, offset, due, done ? 'Done' : 'Open', owner, branch, done ? plus(due, Math.floor(unit(id, 334) * 3)) : null, done ? 'Spoke with the member.' : null]);
      }
    }
    // Data logs from earlier months, all approved.
    const pastLogs: [string, string, number | null][] = [['CASH_COUNT', 'Vault count adjustment', -80], ['EVENT', 'Financial literacy night', null], ['SURVEY', 'Lobby survey cards', null], ['CASH_COUNT', 'ATM balancing difference', 40], ['EVENT', 'Farmers market table', null], ['SURVEY', 'New member survey calls', null], ['CASH_COUNT', 'Coin machine recount', -15], ['EVENT', 'High school career day', null]];
    pastLogs.forEach(([type, title, amount], n) => logRow(type, title, amount === null ? null : amount * (1 + (branch % 3)), 'Approved', msrs[n % msrs.length]!, 12 + n * 13 + branch, ++pastLogId));
  });
  return { issues, history, tasks, logs, logHistory };
}
