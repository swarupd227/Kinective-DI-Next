// Off-core loans (spec 8.21 Integrations > Files): loans the institution holds that its core doesn't
// carry, such as participations, purchased pools and partner programs, reported each month in a
// servicer's spreadsheet. DI keeps:
// - ofc_feed: one per spreadsheet that arrives each month, with how its columns map to DI's loan fields.
// - ofc_load: each approved load, with its file, as-of date, rows and balances.
// - ofc_loan: the rows of each load as mapped, with the DI loan number each was given.
// A publish step writes the latest load into cdm_loan with `source` set, so every loan figure includes
// it. That step uses its own account, dinext_build, which can add and remove rows in cdm_loan and
// nothing else; the application account stays read-only on curated tables. Rows with no source are
// the core's, and DI Core never changes them.
import type mysql from 'mysql2/promise';
import { dbUrl } from './db.ts';

export const OFFCORE_DDL = [
  `CREATE TABLE IF NOT EXISTS ofc_feed (
     feed_id INT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     source VARCHAR(80) NOT NULL,
     servicer VARCHAR(80) NULL,
     mapping TEXT NOT NULL,
     created_by VARCHAR(40) NOT NULL,
     created_by_name VARCHAR(80) NOT NULL,
     created_at DATETIME NOT NULL,
     UNIQUE KEY ux_feed_source (source)
   )`,
  `CREATE TABLE IF NOT EXISTS ofc_load (
     load_id INT AUTO_INCREMENT PRIMARY KEY,
     feed_id INT NOT NULL,
     file_name VARCHAR(160) NOT NULL,
     as_of DATE NOT NULL,
     row_count INT NOT NULL,
     skipped INT NOT NULL,
     balance DECIMAL(16,2) NOT NULL,
     delinquent_60_balance DECIMAL(16,2) NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     loaded_by VARCHAR(40) NOT NULL,
     loaded_by_name VARCHAR(80) NOT NULL,
     loaded_at DATETIME NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ofc_loan (
     load_id INT NOT NULL,
     external_ref VARCHAR(40) NOT NULL,
     loan_id INT NOT NULL,
     servicer_type VARCHAR(60) NOT NULL,
     loan_category VARCHAR(30) NOT NULL,
     is_indirect TINYINT NOT NULL,
     branch_id INT NOT NULL,
     balance DECIMAL(14,2) NOT NULL,
     original_amount DECIMAL(14,2) NOT NULL,
     rate DECIMAL(6,3) NOT NULL,
     days_delinquent INT NOT NULL,
     open_date DATE NOT NULL,
     term_months SMALLINT NULL,
     credit_score SMALLINT NULL,
     ltv DECIMAL(6,2) NULL,
     risk_rating TINYINT NULL,
     PRIMARY KEY (load_id, external_ref)
   )`,
];

export const OFFCORE_WRITE_TABLES = ['ofc_feed', 'ofc_load', 'ofc_loan'];

/** The account the publish step uses: it can add and remove rows in cdm_loan, and nothing else. */
export const BUILD_ACCOUNT = 'dinext_build';
export const buildPassword = () => process.env.DI_BUILD_DB_PASSWORD ?? 'dinext_build_demo';
/** The publish step's connection: the application's server, with the build account. */
export function buildDbUrl(url = dbUrl()) {
  const u = new URL(url);
  u.username = process.env.DI_BUILD_DB_USER ?? BUILD_ACCOUNT;
  u.password = buildPassword();
  return u.toString().replace(/\/$/, '');
}

/** DI's off-core store in one tenant schema, and the build account's rights there. Safe to run again. */
export async function createOffcoreTables(admin: mysql.Connection, schema: string) {
  await admin.query(`USE \`${schema}\``);
  for (const ddl of OFFCORE_DDL) await admin.query(ddl);
  for (const table of OFFCORE_WRITE_TABLES) await admin.query(`GRANT INSERT, UPDATE ON \`${schema}\`.\`${table}\` TO 'dinext'@'%'`);
  await admin.query(`CREATE USER IF NOT EXISTS '${BUILD_ACCOUNT}'@'%' IDENTIFIED BY ?`, [buildPassword()]);
  await admin.query(`ALTER USER '${BUILD_ACCOUNT}'@'%' IDENTIFIED BY ?`, [buildPassword()]);
  await admin.query(`GRANT SELECT, INSERT, DELETE ON \`${schema}\`.\`cdm_loan\` TO '${BUILD_ACCOUNT}'@'%'`);
}

// ---- the demo spreadsheet ---------------------------------------------------------------------

export const OFFCORE_DEMO_NAME = 'Participations and purchased loans October 2026.xlsx';
export const OFFCORE_DEMO_HEADERS = ['Loan Number', 'Borrower', 'Loan Type', 'Servicer', 'Current Balance', 'Original Balance', 'Interest Rate', 'Days Past Due', 'Origination Date', 'Maturity Date', 'FICO', 'LTV', 'Risk Grade', 'Branch', 'As Of Date'];

const frac = (seed: number, salt: number) => {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const addMonths = (date: string, months: number) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = y * 12 + (m - 1) + months;
  return iso(Math.floor(t / 12), (t % 12) + 1, Math.min(d, 28));
};
const COMPANIES = ['Harbor Point Medical Offices LLC', 'Riverside Self Storage LP', 'Lakeshore Hospitality Group', 'Northgate Retail Partners', 'Bayview Industrial Holdings', 'Summit Senior Living LLC', 'Coastal Marine Supply Co', 'Greenfield Farms Inc', 'Metro Fleet Services', 'Pioneer Dental Group'];
const PEOPLE = ['A. Patel', 'J. Moreno', 'K. Nguyen', 'L. Brooks', 'M. Chen', 'R. Okafor', 'S. Larsen', 'T. Rivera', 'D. Kim', 'E. Walsh', 'F. Haddad', 'G. Novak', 'H. Singh', 'I. Duarte', 'P. Murphy', 'Q. Adams', 'V. Ito', 'W. Clarke'];

/**
 * A servicer's monthly report of loans the core doesn't carry: commercial real estate and business
 * participations bought from other lenders, an indirect auto pool, and solar and student loans from
 * partner programs. Borrower names are in it, as servicers send them; DI doesn't load them. Three rows
 * have problems on purpose: one is repeated, one has no balance, one has no rate.
 */
export function offcoreDemoRows(branches: string[]) {
  const main = branches[0] ?? 'Main office';
  const branch = (i: number) => branches[i % branches.length] ?? main;
  const asOf = '2026-10-31';
  const rows: (string | number | null)[][] = [];
  const add = (ref: string, borrower: string, type: string, servicer: string, balance: number | null, original: number, rate: number | null, dpd: number, open: string, termMonths: number, fico: number | null, ltv: number | null, grade: number | null, br: string) =>
    rows.push([ref, borrower, type, servicer, balance === null ? null : Math.round(balance * 100) / 100, Math.round(original * 100) / 100, rate, dpd, open, addMonths(open, termMonths), fico, ltv, grade, br, asOf]);
  // Commercial real estate participations: large, few, one seriously behind.
  for (let i = 0; i < 6; i++) {
    const original = 2_000_000 + Math.round(frac(i, 1) * 30) * 100_000;
    const open = iso(2021 + (i % 4), 1 + ((i * 5) % 12), 10);
    add(`PCRE-${1040 + i}`, COMPANIES[i]!, 'CRE Participation', 'Atlantic Community Bank', original * (0.72 + frac(i, 2) * 0.2), original, 6.1 + Math.round(frac(i, 3) * 140) / 100, i === 3 ? 97 : 0, open, 120, null, 55 + Math.round(frac(i, 4) * 20), i === 3 ? 7 : 3 + (i % 3), main);
  }
  // Business participations.
  for (let i = 0; i < 4; i++) {
    const original = 400_000 + Math.round(frac(i, 5) * 12) * 100_000;
    const open = iso(2022 + (i % 3), 2 + i * 2, 15);
    add(`PCOM-${2210 + i}`, COMPANIES[6 + i]!, 'Commercial Participation', 'Atlantic Community Bank', original * (0.6 + frac(i, 6) * 0.3), original, 7.25 + Math.round(frac(i, 7) * 150) / 100, i === 2 ? 34 : 0, open, 84, null, null, 4 + (i % 2), main);
  }
  // An indirect auto pool bought from a dealer finance company.
  for (let i = 0; i < 18; i++) {
    const original = 22_000 + Math.round(frac(i, 8) * 30_000);
    const months = 6 + Math.round(frac(i, 9) * 30);
    const open = addMonths(asOf, -months);
    add(`IAP-${50310 + i}`, PEOPLE[i]!, 'Indirect Auto Pool', 'Keystone Auto Finance', original * (1 - months / 84), original, 5.9 + Math.round(frac(i, 10) * 300) / 100, i === 4 ? 62 : i === 11 ? 31 : 0, open, 72, 640 + Math.round(frac(i, 11) * 150), 85 + Math.round(frac(i, 12) * 30), null, branch(i));
  }
  // Solar and student loans from partner programs.
  for (let i = 0; i < 8; i++) {
    const original = 18_000 + Math.round(frac(i, 13) * 24_000);
    const open = addMonths(asOf, -(4 + i * 3));
    add(`SOL-${7700 + i}`, PEOPLE[(i + 5) % PEOPLE.length]!, 'Solar Loan', 'SunPath Lending', original * 0.93, original, 6.49 + (i % 3) * 0.5, 0, open, 240, 700 + Math.round(frac(i, 14) * 100), null, null, branch(i + 2));
  }
  for (let i = 0; i < 4; i++) {
    const original = 15_000 + Math.round(frac(i, 15) * 45_000);
    const open = addMonths(asOf, -(10 + i * 7));
    add(`STU-${3300 + i}`, PEOPLE[(i + 11) % PEOPLE.length]!, 'Student Loan Pool', 'Campus Partners', original * 0.97, original, 7.1 + i * 0.4, 0, open, 120, 720 + i * 15, null, null, branch(i + 4));
  }
  // The problems a servicer's file usually has.
  rows.push([...rows[8]!]);
  rows[14]![4] = null;
  rows[30]![6] = null;
  return { name: OFFCORE_DEMO_NAME, headers: OFFCORE_DEMO_HEADERS, rows };
}
