// Direct core connections (spec 14.5 DB connections and remote databases, 14.6 Sync in Remote Data).
// Two parts:
// - DI's own store: saved logins, connections, table mappings, sync runs, and landing tables that a
//   pull writes into.
// - For the credit union tenant, a stand-in for the core's reporting replica. It is a separate
//   database in the vendor's own shape: Jack Henry Symitar style tables, codes and YYYYMMDD dates.
//   A read-only login, core_reader, can see only it. The DI application account can't see it at all,
//   so the only way in is through a connection a person sets up.
// The replica is built from the tenant's curated tables with SQL, so a pull and reconcile match to the
// cent. Two members and three loan balances are changed on purpose, so reconciliation has rows to
// report.
import type mysql from 'mysql2/promise';

export const SOURCES_DDL = [
  `CREATE TABLE IF NOT EXISTS src_credential (
     credential_id INT AUTO_INCREMENT PRIMARY KEY,
     system_id VARCHAR(20) NOT NULL,
     host VARCHAR(255) NOT NULL,
     port INT NOT NULL,
     database_name VARCHAR(64) NOT NULL,
     login VARCHAR(64) NOT NULL,
     secret VARCHAR(600) NOT NULL,
     created_by VARCHAR(40) NOT NULL,
     created_at DATETIME NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS src_connection (
     connection_id INT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     system_id VARCHAR(20) NOT NULL,
     credential_id INT NOT NULL,
     schedule VARCHAR(40) NOT NULL,
     state VARCHAR(20) NOT NULL,
     in_use TINYINT NOT NULL DEFAULT 0,
     in_use_since DATE NULL,
     created_by VARCHAR(40) NOT NULL,
     created_name VARCHAR(80) NOT NULL,
     created_on DATE NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     UNIQUE KEY ux_src_connection_approval (approval_id)
   )`,
  `CREATE TABLE IF NOT EXISTS src_mapping (
     mapping_id INT AUTO_INCREMENT PRIMARY KEY,
     connection_id INT NOT NULL,
     di_table VARCHAR(64) NOT NULL,
     their_tables VARCHAR(200) NOT NULL,
     definition JSON NOT NULL,
     KEY ix_src_mapping_connection (connection_id)
   )`,
  `CREATE TABLE IF NOT EXISTS src_sync_run (
     run_id INT AUTO_INCREMENT PRIMARY KEY,
     connection_id INT NOT NULL,
     started_at DATETIME NOT NULL,
     finished_at DATETIME NULL,
     state VARCHAR(20) NOT NULL,
     rows_pulled INT NOT NULL DEFAULT 0,
     detail JSON NULL,
     approval_id VARCHAR(40) NOT NULL,
     KEY ix_src_run_connection (connection_id),
     UNIQUE KEY ux_src_run_approval (approval_id)
   )`,
  // Custom column mappings: what an institution adds beyond Kinective's standard mapping (a Symitar
  // tracking record, a user-defined field). Each one was proposed, previewed and approved.
  `CREATE TABLE IF NOT EXISTS src_column_map (
     map_id INT AUTO_INCREMENT PRIMARY KEY,
     system_id VARCHAR(20) NOT NULL,
     di_table VARCHAR(64) NOT NULL,
     field VARCHAR(64) NOT NULL,
     label VARCHAR(80) NOT NULL,
     expression VARCHAR(400) NOT NULL,
     value_type VARCHAR(10) NOT NULL,
     state VARCHAR(12) NOT NULL,
     note VARCHAR(200) NULL,
     added_by VARCHAR(40) NOT NULL,
     added_name VARCHAR(80) NOT NULL,
     added_on DATE NOT NULL,
     approval_id VARCHAR(40) NOT NULL,
     UNIQUE KEY ux_src_column_map_approval (approval_id),
     KEY ix_src_column_map_field (di_table, field)
   )`,
  // Proposing mappings for a core (Core Mapping and Ontology, phase 2): each run profiles the core's
  // columns and scores DI's properties against them; nothing here changes a pull until it's approved.
  `CREATE TABLE IF NOT EXISTS map_run (
     run_id INT AUTO_INCREMENT PRIMARY KEY,
     connection_id INT NOT NULL,
     system_id VARCHAR(20) NOT NULL,
     mode VARCHAR(20) NOT NULL,
     started_at DATETIME NOT NULL,
     finished_at DATETIME NULL,
     columns_profiled INT NOT NULL DEFAULT 0,
     summary JSON NULL,
     run_by VARCHAR(40) NOT NULL,
     KEY ix_map_run_connection (connection_id)
   )`,
  `CREATE TABLE IF NOT EXISTS map_profile (
     run_id INT NOT NULL,
     core_table VARCHAR(64) NOT NULL,
     core_column VARCHAR(64) NOT NULL,
     data_type VARCHAR(40) NOT NULL,
     kind VARCHAR(12) NOT NULL,
     row_count INT NOT NULL,
     filled INT NOT NULL,
     distinct_count INT NOT NULL,
     min_value VARCHAR(80) NULL,
     max_value VARCHAR(80) NULL,
     top_values JSON NULL,
     refers_to VARCHAR(140) NULL,
     PRIMARY KEY (run_id, core_table, core_column)
   )`,
  `CREATE TABLE IF NOT EXISTS map_candidate (
     run_id INT NOT NULL,
     core_table VARCHAR(64) NOT NULL,
     core_column VARCHAR(64) NOT NULL,
     di_table VARCHAR(64) NOT NULL,
     di_column VARCHAR(64) NOT NULL,
     property_id VARCHAR(80) NOT NULL,
     score DECIMAL(5,3) NOT NULL,
     band VARCHAR(12) NOT NULL,
     transform VARCHAR(12) NOT NULL,
     signals JSON NOT NULL,
     runner_up JSON NULL,
     status VARCHAR(12) NOT NULL DEFAULT 'proposed',
     PRIMARY KEY (run_id, di_table, di_column),
     KEY ix_map_candidate_core (run_id, core_table, core_column)
   )`,
  // Mapping versions and drift (Core Mapping and Ontology, phase 3). A connection's mapping as pulls
  // use it, one row per approved change; version 1 is Kinective's standard mapping for the core.
  `CREATE TABLE IF NOT EXISTS map_version (
     version_id INT AUTO_INCREMENT PRIMARY KEY,
     connection_id INT NOT NULL,
     version_no INT NOT NULL,
     source VARCHAR(20) NOT NULL,
     summary VARCHAR(300) NOT NULL,
     definition JSON NOT NULL,
     created_by VARCHAR(40) NOT NULL,
     created_name VARCHAR(80) NOT NULL,
     created_at DATETIME NOT NULL,
     approval_id VARCHAR(60) NOT NULL,
     UNIQUE KEY ux_map_version_approval (approval_id),
     UNIQUE KEY ux_map_version_no (connection_id, version_no)
   )`,
  // What a pull found that the mapping doesn't expect: a code the crosswalk lacks (its rows are held),
  // a column that appeared or disappeared, or totals that no longer tie out to the regulatory return.
  `CREATE TABLE IF NOT EXISTS map_drift (
     drift_id INT AUTO_INCREMENT PRIMARY KEY,
     connection_id INT NOT NULL,
     version_id INT NOT NULL,
     sync_run_id INT NULL,
     kind VARCHAR(20) NOT NULL,
     core_table VARCHAR(64) NOT NULL,
     core_column VARCHAR(64) NOT NULL,
     value VARCHAR(80) NOT NULL DEFAULT '',
     detail JSON NULL,
     state VARCHAR(12) NOT NULL,
     found_at DATETIME NOT NULL,
     resolved_at DATETIME NULL,
     resolved_version_id INT NULL,
     UNIQUE KEY ux_map_drift_item (connection_id, kind, core_table, core_column, value)
   )`,
  // The values custom mappings bring in, one row per record and field.
  `CREATE TABLE IF NOT EXISTS cdm_custom_field (
     di_table VARCHAR(64) NOT NULL,
     record_id BIGINT NOT NULL,
     field VARCHAR(64) NOT NULL,
     value_text VARCHAR(200) NULL,
     value_num DECIMAL(18,4) NULL,
     PRIMARY KEY (di_table, field, record_id)
   )`,
];

/** DI's tables that a core connection can feed, and the landing table a pull writes for each. */
export const SOURCE_TARGETS = ['cdm_party', 'cdm_deposit_account', 'cdm_loan'] as const;
export const landingTable = (diTable: string) => `src_land_${diTable.replace(/^cdm_/, '')}`;
const LANDING_DDL = SOURCE_TARGETS.map((t) => `CREATE TABLE IF NOT EXISTS ${landingTable(t)} LIKE ${t}`);

export const SOURCES_WRITE_TABLES = ['src_credential', 'src_connection', 'src_mapping', 'src_sync_run', 'src_column_map', 'cdm_custom_field', 'map_run', 'map_profile', 'map_candidate', 'map_version', 'map_drift'];
/** The raw zone: the replica's mapped tables as they came, so existing reports on core tables keep working. A pull replaces them. */
export const RAW_TABLES = ['ACCOUNT', 'NAME', 'SAVINGS', 'LOAN'] as const;
export const rawTable = (coreTable: string) => `src_raw_${coreTable.toLowerCase()}`;
/** A pull replaces what landed last time, so the landing tables also allow deletes. Nothing else does. */
export const SOURCES_LANDING_TABLES = SOURCE_TARGETS.map(landingTable);

/** The replica's database name for a tenant schema. */
export const replicaDatabase = (schema: string) => `${schema}_symitar`;
export const CORE_READER = 'core_reader';
export const coreReaderPassword = () => process.env.DI_CORE_READER_PASSWORD ?? 'core_reader_demo';

/** This credit union's Symitar type codes, as Kinective records them at onboarding. */
export const SYMITAR_CODES = {
  memberType: { Retail: 0, 'Young Adult': 10, Senior: 20, 'Small Business': 50 } as Record<string, number>,
  shareType: { 'Share Savings': 0, Checking: 9, 'Money Market': 12, Certificates: 50, IRA: 70 } as Record<string, number>,
  loanType: { Auto: 1, Personal: 10, Mortgage: 30, HELOC: 31, 'Credit Card': 60, Business: 70 } as Record<string, number>,
};

const caseOf = (column: string, codes: Record<string, number>) => `CASE ${column} ${Object.entries(codes).map(([k, v]) => `WHEN '${k.replace(/'/g, "''")}' THEN ${v}`).join(' ')} ELSE 99 END`;
const ymd = (column: string) => `IFNULL(DATE_FORMAT(${column}, '%Y%m%d'), '00000000')`;

/** DI's store for core connections, in one tenant schema. Safe to run again. */
export async function createSourceTables(admin: mysql.Connection, schema: string) {
  await admin.query(`USE \`${schema}\``);
  for (const ddl of [...SOURCES_DDL, ...LANDING_DDL]) await admin.query(ddl);
  // A landing table may hold a row without a value its curated table requires: a pull lands a code
  // the crosswalk doesn't know as nothing, held for a decision, rather than as a wrong name.
  for (const t of SOURCE_TARGETS) {
    const [cols] = (await admin.query("SELECT COLUMN_NAME AS c, COLUMN_TYPE AS ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND IS_NULLABLE = 'NO' AND COLUMN_KEY <> 'PRI'", [schema, landingTable(t)])) as unknown as [{ c: string; ty: string }[]];
    for (const c of cols) await admin.query(`ALTER TABLE \`${schema}\`.\`${landingTable(t)}\` MODIFY \`${c.c}\` ${c.ty} NULL`);
  }
  for (const table of SOURCES_WRITE_TABLES) await admin.query(`GRANT INSERT, UPDATE ON \`${schema}\`.\`${table}\` TO 'dinext'@'%'`);
  for (const table of SOURCES_LANDING_TABLES) await admin.query(`GRANT INSERT, UPDATE, DELETE ON \`${schema}\`.\`${table}\` TO 'dinext'@'%'`);
  // A pull replaces the values each custom mapping brought in, so it may delete them.
  await admin.query(`GRANT DELETE ON \`${schema}\`.\`cdm_custom_field\` TO 'dinext'@'%'`);
}

/**
 * The Symitar-style replica for one tenant, built from its curated tables. Dropped and rebuilt each
 * time. core_reader gets SELECT on it and nothing else.
 */
/**
 * The raw zone for a tenant: an empty copy of each mapped replica table, in the tenant's database,
 * which a pull fills as it reads the core. The app may replace their rows and nothing else.
 */
export async function createRawTables(admin: mysql.Connection, schema: string, replica: string) {
  for (const t of RAW_TABLES) {
    await admin.query(`DROP TABLE IF EXISTS \`${schema}\`.\`${rawTable(t)}\``);
    await admin.query(`CREATE TABLE \`${schema}\`.\`${rawTable(t)}\` LIKE \`${replica}\`.\`${t}\``);
    await admin.query(`GRANT SELECT, INSERT, DELETE ON \`${schema}\`.\`${rawTable(t)}\` TO 'dinext'@'%'`);
  }
}

export async function seedCoreReplica(admin: mysql.Connection, schema: string) {
  const db = replicaDatabase(schema);
  const [[build]] = (await admin.query(`SELECT DATE_FORMAT(as_of_date, '%Y-%m-%d') AS as_of FROM \`${schema}\`.meta_build ORDER BY as_of_date DESC LIMIT 1`)) as unknown as [{ as_of: string }[]];
  const asOf = build?.as_of ?? '2026-10-25';
  await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await admin.query(`USE \`${db}\``);
  const ddl = [
    `CREATE TABLE CONTROL (PROCESSDATE CHAR(8) NOT NULL, INSTITUTION VARCHAR(60) NOT NULL, RELEASE_LEVEL VARCHAR(20) NOT NULL)`,
    `CREATE TABLE ACCOUNT (ACCOUNTNUMBER CHAR(10) PRIMARY KEY, TYPE SMALLINT NOT NULL, BRANCH SMALLINT NOT NULL, OPENDATE CHAR(8) NOT NULL, CLOSEDATE CHAR(8) NOT NULL, HOUSEHOLDACCOUNT CHAR(10) NOT NULL, NONMEMBER TINYINT NOT NULL, LASTCHANGEDATE CHAR(8) NOT NULL)`,
    `CREATE TABLE NAME (PARENTACCOUNT CHAR(10) NOT NULL, ORDINAL SMALLINT NOT NULL, TYPE SMALLINT NOT NULL, FIRST VARCHAR(40) NOT NULL, LAST VARCHAR(40) NOT NULL, BIRTHDATE CHAR(8) NOT NULL, PRIMARY KEY (PARENTACCOUNT, ORDINAL))`,
    `CREATE TABLE SAVINGS (PARENTACCOUNT CHAR(10) NOT NULL, ID CHAR(4) NOT NULL, SERIAL INT NOT NULL UNIQUE, TYPE SMALLINT NOT NULL, BRANCH SMALLINT NOT NULL, OPENDATE CHAR(8) NOT NULL, CLOSEDATE CHAR(8) NOT NULL, MATURITYDATE CHAR(8) NOT NULL, BALANCE DECIMAL(14,2) NOT NULL, DIVRATE INT NOT NULL, PRIMARY KEY (PARENTACCOUNT, ID))`,
    `CREATE TABLE LOAN (PARENTACCOUNT CHAR(10) NOT NULL, ID CHAR(4) NOT NULL, SERIAL INT NOT NULL UNIQUE, TYPE SMALLINT NOT NULL, BRANCH SMALLINT NOT NULL, LOANOFFICER INT NOT NULL, DEALERNUMBER INT NOT NULL, OPENDATE CHAR(8) NOT NULL, CLOSEDATE CHAR(8) NOT NULL, CHARGEOFFDATE CHAR(8) NOT NULL, ORIGINALBALANCE DECIMAL(14,2) NOT NULL, BALANCE DECIMAL(14,2) NOT NULL, INTERESTRATE INT NOT NULL, DUEDATE CHAR(8) NOT NULL, PRIMARY KEY (PARENTACCOUNT, ID))`,
    // Symitar's account tracking records: each institution decides what its TYPE numbers and USER
    // fields hold, so Kinective's standard mapping can't know them.
    `CREATE TABLE ACCOUNTTRACKING (PARENTACCOUNT CHAR(10) NOT NULL, ID CHAR(4) NOT NULL, TYPE SMALLINT NOT NULL, USERCHAR1 VARCHAR(40) NOT NULL, USERCHAR2 VARCHAR(40) NOT NULL, USERCODE1 SMALLINT NOT NULL, USERDATE1 CHAR(8) NOT NULL, USERAMOUNT1 DECIMAL(14,2) NOT NULL, PRIMARY KEY (PARENTACCOUNT, ID))`,
    `CREATE TABLE LOANTRANSACTION (PARENTACCOUNT CHAR(10) NOT NULL, PARENTID CHAR(4) NOT NULL, SEQUENCENUMBER INT NOT NULL, POSTDATE CHAR(8) NOT NULL, AMOUNT DECIMAL(14,2) NOT NULL, PRIMARY KEY (PARENTACCOUNT, PARENTID, SEQUENCENUMBER))`,
  ];
  for (const d of ddl) await admin.query(d);
  const src = `\`${schema}\``;
  await admin.query(`INSERT INTO CONTROL VALUES (?, ?, 'Symitar 2026.01')`, [asOf.replaceAll('-', ''), schema]);
  await admin.query(`INSERT INTO ACCOUNT SELECT LPAD(party_id, 10, '0'), ${caseOf('segment_code', SYMITAR_CODES.memberType)}, primary_branch_id, ${ymd('join_date')}, '00000000', LPAD(household_id, 10, '0'), 1 - is_member, ${ymd('join_date')} FROM ${src}.cdm_party`);
  await admin.query(`INSERT INTO NAME SELECT LPAD(party_id, 10, '0'), 0, 0, first_name, last_name, ${ymd('birth_date')} FROM ${src}.cdm_party`);
  // Joint owners are extra NAME records; the mapping reads the primary name only (TYPE 0).
  await admin.query(`INSERT INTO NAME SELECT LPAD(p.party_id, 10, '0'), 1, 1, q.first_name, p.last_name, ${ymd('q.birth_date')} FROM ${src}.cdm_party p JOIN ${src}.cdm_party q ON q.party_id = p.party_id + 1 AND q.household_id = p.household_id WHERE MOD(p.party_id, 7) = 0`);
  await admin.query(`INSERT INTO SAVINGS SELECT LPAD(party_id, 10, '0'), LPAD(ROW_NUMBER() OVER (PARTITION BY party_id ORDER BY account_id), 4, '0'), account_id, ${caseOf('deposit_category', SYMITAR_CODES.shareType)}, branch_id, ${ymd('open_date')}, ${ymd('close_date')}, ${ymd('maturity_date')}, balance, ROUND(rate * 1000) FROM ${src}.cdm_deposit_account`);
  // Symitar keeps the next payment's due date; DI keeps days past due as of the process date.
  await admin.query(
    `INSERT INTO LOAN SELECT LPAD(party_id, 10, '0'), LPAD(ROW_NUMBER() OVER (PARTITION BY party_id ORDER BY loan_id) + 100, 4, '0'), loan_id, ${caseOf('loan_category', SYMITAR_CODES.loanType)}, branch_id, officer_id, IF(is_indirect = 1, 4000 + MOD(loan_id, 37), 0), ${ymd('open_date')}, ${ymd('close_date')}, ${ymd('charge_off_date')}, original_amount, balance, ROUND(rate * 1000), DATE_FORMAT(IF(days_delinquent > 0, DATE_SUB(?, INTERVAL days_delinquent DAY), DATE_ADD(?, INTERVAL 1 + MOD(loan_id, 27) DAY)), '%Y%m%d') FROM ${src}.cdm_loan`,
    [asOf, asOf],
  );
  // Tracking records this credit union uses: type 12 marketing preferences (email and text consent,
  // and when they were last confirmed), type 21 board and insider status, type 30 a representative payee.
  await admin.query(`INSERT INTO ACCOUNTTRACKING SELECT LPAD(party_id, 10, '0'), '0012', 12, IF(MOD(party_id, 10) < 7, 'Y', 'N'), IF(MOD(party_id, 10) < 4, 'Y', 'N'), 0, ${ymd('join_date')}, 0 FROM ${src}.cdm_party WHERE MOD(party_id, 20) <> 0`);
  await admin.query(`INSERT INTO ACCOUNTTRACKING SELECT LPAD(party_id, 10, '0'), '0021', 21, '', '', IF(MOD(party_id, 2) = 0, 1, 2), '00000000', 0 FROM ${src}.cdm_party WHERE MOD(party_id, 211) = 0`);
  await admin.query(`INSERT INTO ACCOUNTTRACKING SELECT LPAD(party_id, 10, '0'), '0030', 30, CONCAT('Payee for ', first_name), '', 0, ${ymd('join_date')}, 0 FROM ${src}.cdm_party WHERE MOD(party_id, 97) = 0`);
  // What reconciliation should find: two accounts opened in the core that the build doesn't have, and
  // three open loans whose balances moved by a posted payment.
  const [[top]] = (await admin.query(`SELECT MAX(party_id) AS id FROM ${src}.cdm_party`)) as unknown as [{ id: number }[]];
  const next = Number(top?.id ?? 0);
  const process = asOf.replaceAll('-', '');
  for (const [i, first, last, birth] of [
    [1, 'Priya', 'Raman', '19910614'],
    [2, 'Marcus', 'Bell', '19850203'],
  ] as const) {
    const acct = String(next + i).padStart(10, '0');
    await admin.query(`INSERT INTO ACCOUNT VALUES (?, 0, 1, ?, '00000000', ?, 0, ?)`, [acct, process, acct, process]);
    await admin.query(`INSERT INTO NAME VALUES (?, 0, 0, ?, ?, ?)`, [acct, first, last, birth]);
  }
  const [moved] = (await admin.query(`SELECT PARENTACCOUNT, ID, SERIAL, BALANCE FROM LOAN WHERE CLOSEDATE = '00000000' AND CHARGEOFFDATE = '00000000' AND BALANCE > 5000 ORDER BY SERIAL LIMIT 3`)) as unknown as [{ PARENTACCOUNT: string; ID: string; SERIAL: number; BALANCE: number | string }[]];
  for (const [n, l] of moved.entries()) {
    const payment = [412.37, 1250, 286.9][n]!;
    await admin.query(`UPDATE LOAN SET BALANCE = BALANCE - ? WHERE SERIAL = ?`, [payment, l.SERIAL]);
    await admin.query(`INSERT INTO LOANTRANSACTION VALUES (?, ?, 1, ?, ?)`, [l.PARENTACCOUNT, l.ID, process, -payment]);
  }
  await admin.query(`CREATE USER IF NOT EXISTS '${CORE_READER}'@'%' IDENTIFIED BY ?`, [coreReaderPassword()]);
  await admin.query(`ALTER USER '${CORE_READER}'@'%' IDENTIFIED BY ?`, [coreReaderPassword()]);
  await admin.query(`GRANT SELECT ON \`${db}\`.* TO '${CORE_READER}'@'%'`);
  await createRawTables(admin, schema, db);
  await admin.query(`USE ${src}`);
  return { database: db, processDate: asOf };
}
