// The FFIEC 051 Call Report (domestic offices, under $5B), headline items of the schedules a CFO
// reviews: RC balance sheet, RC-B securities, RC-C loans, RC-E deposits, RC-K quarterly averages,
// RC-N past due and nonaccrual, RC-O deposit insurance, RC-R Part I capital (community bank leverage
// ratio), RI income statement, RI-A changes in equity and RI-B charge-offs and the allowance. Item
// codes are the MDRM codes on the June 2026 forms (no changes to the 051 in March or June 2026); a
// production build checks each against the FFIEC MDRM dictionary.
// Row: [code, schedule, schedule name, section, order, name, kind, formula].
export const FFIEC_051_EDITION = 'FFIEC 051, June 2026 forms (apply to September 30, 2026)';

type Row = [string, string, string, string, number, string, 'input' | 'total' | 'memo', string | null];

const rc: Row[] = [
  ['RCON0081', 'RC', 'Balance Sheet', 'Assets', 1, 'Cash and noninterest-bearing balances due from depository institutions', 'input', null],
  ['RCON0071', 'RC', 'Balance Sheet', 'Assets', 2, 'Interest-bearing balances', 'input', null],
  ['RCON1754', 'RC', 'Balance Sheet', 'Assets', 3, 'Held-to-maturity securities (amortized cost)', 'input', null],
  ['RCON1773', 'RC', 'Balance Sheet', 'Assets', 4, 'Available-for-sale debt securities (fair value)', 'input', null],
  ['RCONB528', 'RC', 'Balance Sheet', 'Assets', 5, 'Loans and leases held for investment', 'input', null],
  ['RCON3123', 'RC', 'Balance Sheet', 'Assets', 6, 'LESS: Allowance for credit losses on loans and leases', 'input', null],
  ['RCONB529', 'RC', 'Balance Sheet', 'Assets', 7, 'Loans and leases held for investment, net of allowance', 'total', 'RCONB528 - RCON3123'],
  ['RCON2145', 'RC', 'Balance Sheet', 'Assets', 8, 'Premises and fixed assets', 'input', null],
  ['RCON3163', 'RC', 'Balance Sheet', 'Assets', 9, 'Goodwill', 'input', null],
  ['RCON0426', 'RC', 'Balance Sheet', 'Assets', 10, 'Other intangible assets', 'input', null],
  ['RCON2160', 'RC', 'Balance Sheet', 'Assets', 11, 'Other assets', 'input', null],
  ['RCON2170', 'RC', 'Balance Sheet', 'Assets', 12, 'Total assets', 'total', 'RCON0081 + RCON0071 + RCON1754 + RCON1773 + RCONB529 + RCON2145 + RCON3163 + RCON0426 + RCON2160'],
  ['RCON2200', 'RC', 'Balance Sheet', 'Liabilities', 13, 'Deposits', 'input', null],
  ['RCON3190', 'RC', 'Balance Sheet', 'Liabilities', 14, 'Other borrowed money (FHLB advances)', 'input', null],
  ['RCON2930', 'RC', 'Balance Sheet', 'Liabilities', 15, 'Other liabilities', 'input', null],
  ['RCON2948', 'RC', 'Balance Sheet', 'Liabilities', 16, 'Total liabilities', 'total', 'RCON2200 + RCON3190 + RCON2930'],
  ['RCON3230', 'RC', 'Balance Sheet', 'Equity Capital', 17, 'Common stock', 'input', null],
  ['RCON3839', 'RC', 'Balance Sheet', 'Equity Capital', 18, 'Surplus', 'input', null],
  ['RCON3632', 'RC', 'Balance Sheet', 'Equity Capital', 19, 'Retained earnings', 'input', null],
  ['RCONB530', 'RC', 'Balance Sheet', 'Equity Capital', 20, 'Accumulated other comprehensive income', 'input', null],
  ['RCON3210', 'RC', 'Balance Sheet', 'Equity Capital', 21, 'Total bank equity capital', 'total', 'RCON3230 + RCON3839 + RCON3632 + RCONB530'],
  ['RCON3300', 'RC', 'Balance Sheet', 'Equity Capital', 22, 'Total liabilities and equity capital', 'total', 'RCON2948 + RCON3210'],
];
const rcb: Row[] = [
  ['RCON1754B', 'RC-B', 'Securities', 'Held-to-maturity', 1, 'Total held-to-maturity securities, amortized cost', 'input', null],
  ['RCON1771', 'RC-B', 'Securities', 'Held-to-maturity', 2, 'Total held-to-maturity securities, fair value', 'input', null],
  ['RCON1772', 'RC-B', 'Securities', 'Available-for-sale', 3, 'Total available-for-sale securities, amortized cost', 'input', null],
  ['RCON1773B', 'RC-B', 'Securities', 'Available-for-sale', 4, 'Total available-for-sale securities, fair value', 'input', null],
  ['RCON0416', 'RC-B', 'Securities', 'Memoranda', 5, 'Pledged securities', 'memo', null],
];
const rcc: Row[] = [
  ['RCONF159', 'RC-C', 'Loans and Leases', 'Part I - Loans secured by real estate', 1, 'Other construction loans and all land development and other land loans', 'input', null],
  ['RCON1797', 'RC-C', 'Loans and Leases', 'Part I - Loans secured by real estate', 2, 'Revolving, open-end loans secured by 1-4 family residential properties (HELOCs)', 'input', null],
  ['RCON5367', 'RC-C', 'Loans and Leases', 'Part I - Loans secured by real estate', 3, 'Closed-end loans secured by 1-4 family residential properties, first liens', 'input', null],
  ['RCON1460', 'RC-C', 'Loans and Leases', 'Part I - Loans secured by real estate', 4, 'Secured by multifamily (5 or more) residential properties', 'input', null],
  ['RCONF160', 'RC-C', 'Loans and Leases', 'Part I - Loans secured by real estate', 5, 'Secured by owner-occupied nonfarm nonresidential properties', 'input', null],
  ['RCONF161', 'RC-C', 'Loans and Leases', 'Part I - Loans secured by real estate', 6, 'Secured by other nonfarm nonresidential properties', 'input', null],
  ['RCON1766', 'RC-C', 'Loans and Leases', 'Part I - Other loans', 7, 'Commercial and industrial loans', 'input', null],
  ['RCONB538', 'RC-C', 'Loans and Leases', 'Part I - Other loans', 8, 'Loans to individuals: credit cards', 'input', null],
  ['RCONK137', 'RC-C', 'Loans and Leases', 'Part I - Other loans', 9, 'Loans to individuals: automobile loans', 'input', null],
  ['RCONK207', 'RC-C', 'Loans and Leases', 'Part I - Other loans', 10, 'Loans to individuals: other consumer loans', 'input', null],
  ['RCON2122', 'RC-C', 'Loans and Leases', 'Part I - Total', 11, 'Total loans and leases held for investment', 'total', 'RCONF159 + RCON1797 + RCON5367 + RCON1460 + RCONF160 + RCONF161 + RCON1766 + RCONB538 + RCONK137 + RCONK207'],
];
const rce: Row[] = [
  ['RCON2215', 'RC-E', 'Deposit Liabilities', 'Deposits', 1, 'Total transaction accounts', 'input', null],
  ['RCON2385', 'RC-E', 'Deposit Liabilities', 'Deposits', 2, 'Total nontransaction accounts', 'input', null],
  ['RCON2200E', 'RC-E', 'Deposit Liabilities', 'Deposits', 3, 'Total deposits', 'total', 'RCON2215 + RCON2385'],
  ['RCON6810', 'RC-E', 'Deposit Liabilities', 'Memoranda', 4, 'Money market deposit accounts (MMDAs)', 'memo', null],
  ['RCON0352', 'RC-E', 'Deposit Liabilities', 'Memoranda', 5, 'Other savings deposits', 'memo', null],
  ['RCONJ473', 'RC-E', 'Deposit Liabilities', 'Memoranda', 6, 'Time deposits of $250,000 or less', 'memo', null],
  ['RCONJ474', 'RC-E', 'Deposit Liabilities', 'Memoranda', 7, 'Time deposits of more than $250,000', 'memo', null],
  ['RCON2365', 'RC-E', 'Deposit Liabilities', 'Memoranda', 8, 'Total brokered deposits', 'memo', null],
];
const rck: Row[] = [
  ['RCON3360', 'RC-K', 'Quarterly Averages', 'Assets', 1, 'Total loans', 'input', null],
  ['RCON3368', 'RC-K', 'Quarterly Averages', 'Assets', 2, 'Total assets', 'input', null],
];
const rcn: Row[] = [
  ['RCON1406', 'RC-N', 'Past Due and Nonaccrual', 'Totals', 1, 'Past due 30 through 89 days and still accruing', 'input', null],
  ['RCON1407', 'RC-N', 'Past Due and Nonaccrual', 'Totals', 2, 'Past due 90 days or more and still accruing', 'input', null],
  ['RCON1403', 'RC-N', 'Past Due and Nonaccrual', 'Totals', 3, 'Nonaccrual', 'input', null],
];
const rco: Row[] = [['RCON5597', 'RC-O', 'Other Data for Deposit Insurance Assessments', 'Memoranda', 1, 'Estimated amount of uninsured deposits', 'memo', null]];
const rcr: Row[] = [
  ['RCONLE74', 'RC-R', 'Regulatory Capital', 'Part I', 1, 'Does the institution opt into the community bank leverage ratio framework?', 'input', null],
  ['RCONP841', 'RC-R', 'Regulatory Capital', 'Part I', 2, 'LESS: Goodwill net of associated deferred tax liabilities', 'input', null],
  ['RCONP842', 'RC-R', 'Regulatory Capital', 'Part I', 3, 'LESS: Intangible assets (other than goodwill and mortgage servicing assets), net of associated deferred tax liabilities', 'input', null],
  ['RCONP742', 'RC-R', 'Regulatory Capital', 'Part I', 4, 'Common equity tier 1 capital', 'total', null],
  ['RCON8274', 'RC-R', 'Regulatory Capital', 'Part I', 5, 'Tier 1 capital', 'total', null],
  ['RCONA224', 'RC-R', 'Regulatory Capital', 'Part I', 6, 'Total assets for the leverage ratio', 'input', null],
  ['RCON7204', 'RC-R', 'Regulatory Capital', 'Part I', 7, 'Leverage ratio', 'total', 'RCON8274 / RCONA224'],
];
const ri: Row[] = [
  ['RIAD4010', 'RI', 'Income Statement', 'Interest income', 1, 'Interest and fee income on loans', 'input', null],
  ['RIAD4115', 'RI', 'Income Statement', 'Interest income', 2, 'Interest income on balances due from depository institutions', 'input', null],
  ['RIADB488', 'RI', 'Income Statement', 'Interest income', 3, 'Interest and dividend income on securities', 'input', null],
  ['RIAD4107', 'RI', 'Income Statement', 'Interest income', 4, 'Total interest income', 'total', 'RIAD4010 + RIAD4115 + RIADB488'],
  ['RIAD4508', 'RI', 'Income Statement', 'Interest expense', 5, 'Interest on transaction accounts', 'input', null],
  ['RIAD0093', 'RI', 'Income Statement', 'Interest expense', 6, 'Interest on savings deposits (including MMDAs)', 'input', null],
  ['RIADHK03', 'RI', 'Income Statement', 'Interest expense', 7, 'Interest on time deposits of $250,000 or less', 'input', null],
  ['RIADHK04', 'RI', 'Income Statement', 'Interest expense', 8, 'Interest on time deposits of more than $250,000', 'input', null],
  ['RIAD4180', 'RI', 'Income Statement', 'Interest expense', 9, 'Expense of other borrowed money', 'input', null],
  ['RIAD4073', 'RI', 'Income Statement', 'Interest expense', 10, 'Total interest expense', 'total', 'RIAD4508 + RIAD0093 + RIADHK03 + RIADHK04 + RIAD4180'],
  ['RIAD4074', 'RI', 'Income Statement', 'Net interest income', 11, 'Net interest income', 'total', 'RIAD4107 - RIAD4073'],
  ['RIADJJ33', 'RI', 'Income Statement', 'Provision', 12, 'Provision for credit losses', 'input', null],
  ['RIAD4070', 'RI', 'Income Statement', 'Noninterest income', 13, 'Income from fiduciary activities', 'input', null],
  ['RIAD4080', 'RI', 'Income Statement', 'Noninterest income', 14, 'Service charges on deposit accounts', 'input', null],
  ['RIADC886', 'RI', 'Income Statement', 'Noninterest income', 15, 'Fees and commissions from securities brokerage', 'input', null],
  ['RIADC887', 'RI', 'Income Statement', 'Noninterest income', 16, 'Fees and commissions from annuity sales', 'input', null],
  ['RIADC387', 'RI', 'Income Statement', 'Noninterest income', 17, 'Income from other insurance activities', 'input', null],
  ['RIADB492', 'RI', 'Income Statement', 'Noninterest income', 18, 'Net servicing fees', 'input', null],
  ['RIAD5416', 'RI', 'Income Statement', 'Noninterest income', 19, 'Net gains (losses) on sales of loans and leases', 'input', null],
  ['RIADF555', 'RI', 'Income Statement', 'Noninterest income', 20, 'Bank card and credit card interchange fees', 'input', null],
  ['RIADB497', 'RI', 'Income Statement', 'Noninterest income', 21, 'Other noninterest income', 'input', null],
  ['RIAD4079', 'RI', 'Income Statement', 'Noninterest income', 22, 'Total noninterest income', 'total', 'RIAD4070 + RIAD4080 + RIADC886 + RIADC887 + RIADC387 + RIADB492 + RIAD5416 + RIADF555 + RIADB497'],
  ['RIAD4135', 'RI', 'Income Statement', 'Noninterest expense', 23, 'Salaries and employee benefits', 'input', null],
  ['RIAD4217', 'RI', 'Income Statement', 'Noninterest expense', 24, 'Expenses of premises and fixed assets', 'input', null],
  ['RIAD4092', 'RI', 'Income Statement', 'Noninterest expense', 25, 'Other noninterest expense', 'input', null],
  ['RIAD4093', 'RI', 'Income Statement', 'Noninterest expense', 26, 'Total noninterest expense', 'total', 'RIAD4135 + RIAD4217 + RIAD4092'],
  ['RIAD4301', 'RI', 'Income Statement', 'Income', 27, 'Income before applicable income taxes', 'total', 'RIAD4074 - RIADJJ33 + RIAD4079 - RIAD4093'],
  ['RIAD4302', 'RI', 'Income Statement', 'Income', 28, 'Applicable income taxes', 'input', null],
  ['RIAD4340', 'RI', 'Income Statement', 'Income', 29, 'Net income', 'total', 'RIAD4301 - RIAD4302'],
];
const ria: Row[] = [
  ['RIAD3217', 'RI-A', 'Changes in Bank Equity Capital', 'Equity', 1, 'Total bank equity capital at the end of the previous calendar year', 'input', null],
  ['RIAD4340A', 'RI-A', 'Changes in Bank Equity Capital', 'Equity', 2, 'Net income', 'input', null],
  ['RIAD4460', 'RI-A', 'Changes in Bank Equity Capital', 'Equity', 3, 'LESS: Cash dividends declared on common stock', 'input', null],
  ['RIADB511', 'RI-A', 'Changes in Bank Equity Capital', 'Equity', 4, 'Other comprehensive income', 'input', null],
  ['RIAD3210', 'RI-A', 'Changes in Bank Equity Capital', 'Equity', 5, 'Total bank equity capital end of current period', 'total', 'RIAD3217 + RIAD4340A - RIAD4460 + RIADB511'],
];
const rib: Row[] = [
  ['RIAD4635', 'RI-B', 'Charge-offs and Allowance', 'Part I', 1, 'Total charge-offs (year to date)', 'input', null],
  ['RIAD4605', 'RI-B', 'Charge-offs and Allowance', 'Part I', 2, 'Total recoveries (year to date)', 'input', null],
  ['RIADB522', 'RI-B', 'Charge-offs and Allowance', 'Part II', 3, 'Allowance for credit losses at the end of the previous calendar year', 'input', null],
  ['RIADJH88', 'RI-B', 'Charge-offs and Allowance', 'Part II', 4, 'Provision for credit losses on loans and leases', 'input', null],
  ['RIAD3123', 'RI-B', 'Charge-offs and Allowance', 'Part II', 5, 'Allowance for credit losses on loans and leases, end of current period', 'total', 'RIADB522 + RIAD4605 - RIAD4635 + RIADJH88'],
];

export const FFIEC_051: Row[] = [...rc, ...rcb, ...rcc, ...rce, ...rck, ...rcn, ...rco, ...rcr, ...ri, ...ria, ...rib];
