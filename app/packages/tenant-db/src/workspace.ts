// Calendar events (spec 8.14) and uploaded files (8.15). Both change only through approved DI Core
// operations; approval_id makes each apply run once. Uploads wait as Staged until a save is approved,
// and a delete moves a file to the Recycle Bin, never out of the table. The seeded rows are demo values.
export const WORKSPACE_DDL = [
  `CREATE TABLE cal_event (
     event_id INT AUTO_INCREMENT PRIMARY KEY,
     owner_user_id VARCHAR(40) NOT NULL,
     owner_name VARCHAR(80) NOT NULL,
     title VARCHAR(160) NOT NULL,
     starts_at DATETIME NOT NULL,
     ends_at DATETIME NOT NULL,
     with_whom VARCHAR(120) NULL,
     with_user_id VARCHAR(40) NULL,
     source VARCHAR(160) NULL,
     link VARCHAR(200) NULL,
     status VARCHAR(12) NOT NULL,
     created_at DATE NOT NULL,
     approval_id VARCHAR(40) NULL UNIQUE,
     KEY ix_event_owner (owner_user_id, starts_at),
     KEY ix_event_with (with_user_id, starts_at)
   )`,
  `CREATE TABLE fil_file (
     file_id INT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(200) NOT NULL,
     folder VARCHAR(60) NULL,
     previous_folder VARCHAR(60) NULL,
     type VARCHAR(20) NOT NULL,
     mime VARCHAR(100) NOT NULL,
     size_kb INT NOT NULL,
     owner VARCHAR(80) NOT NULL,
     owner_user_id VARCHAR(40) NOT NULL,
     modified DATE NOT NULL,
     status VARCHAR(12) NOT NULL,
     staged_at DATETIME NOT NULL,
     content LONGBLOB NOT NULL,
     approval_id VARCHAR(40) NULL UNIQUE,
     KEY ix_file_folder (status, folder),
     KEY ix_file_owner (owner_user_id, status)
   )`,
];

export const WORKSPACE_WRITE_TABLES = ['cal_event', 'fil_file'];

// Repeating events: the rule hangs on its cal_event row, whose start is the first date. One date can
// be cancelled or moved on its own in cal_occurrence; cancelling the whole series cancels the event.
export const CALENDAR_SERIES_DDL = [
  `CREATE TABLE cal_series (
     event_id INT PRIMARY KEY,
     rule VARCHAR(300) NOT NULL,
     first_date DATE NOT NULL,
     approval_id VARCHAR(40) NULL UNIQUE
   )`,
  `CREATE TABLE cal_occurrence (
     event_id INT NOT NULL,
     occurs_on DATE NOT NULL,
     status VARCHAR(12) NOT NULL,
     starts_at DATETIME NULL,
     ends_at DATETIME NULL,
     approval_id VARCHAR(40) NULL,
     PRIMARY KEY (event_id, occurs_on)
   )`,
];

export const CALENDAR_SERIES_WRITE_TABLES = ['cal_series', 'cal_occurrence'];

// [owner id, owner name, title, starts, ends, with, with user id, source]
const EVENTS: [string, string, string, string, string, string | null, string | null, string | null][] = [
  ['user:9229', 'Dana Lee', 'Board pack review', '2026-10-27 14:00', '2026-10-27 15:00', null, null, 'Board Packs'],
  ['user:9229', 'Dana Lee', 'ALCO meeting', '2026-10-29 09:00', '2026-10-29 10:30', 'Priya Shah', 'user:4410', 'Finance/ALCO'],
  ['user:5120', 'Marcus Reed', 'Branch huddle', '2026-10-28 08:30', '2026-10-28 09:00', 'Ana Ruiz', 'user:6101', null],
  ['user:5120', 'Marcus Reed', 'Dealer visit: Smith Ford', '2026-10-30 15:00', '2026-10-30 16:00', null, null, 'Indirect Lending'],
  ['user:6101', 'Ana Ruiz', 'Follow-up with Suzanne Jackson', '2026-10-27 16:00', '2026-10-27 16:30', 'Suzanne Jackson', null, 'HELOC referral'],
  ['user:6004', 'Sofia Ruiz', 'Welcome calls for new members', '2026-10-26 10:00', '2026-10-26 11:00', null, null, 'Onboarding'],
  ['user:4410', 'Priya Shah', 'Data quality review', '2026-10-26 11:00', '2026-10-26 11:30', null, null, null],
  ['user:1002', 'Sam Taylor', 'SFTP key rotation window', '2026-10-30 18:00', '2026-10-30 19:00', null, null, null],
  ['user:7001', 'Elena Ortiz', 'ALCO meeting', '2026-10-29 10:00', '2026-10-29 11:30', null, null, 'Finance/ALCO'],
];

// Two small uploads with content, so a download works on a fresh seed.
const FILES: [string, string, string, string, string, string, string][] = [
  ['Westport huddle notes.txt', 'My Files', 'Text', 'text/plain', 'Dana Lee', 'user:9229', 'Westport huddle, 22 October\n- Two HELOC referrals waiting on a call back\n- Smith Ford rate sheet follow-up\n'],
  ['Q4 HELOC rate sheet.csv', 'Marketing', 'CSV', 'text/csv', 'Priya Shah', 'user:4410', 'tier,rate\nup to 80% LTV,7.49\n80 to 90% LTV,7.99\n'],
];

interface Conn {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function seedWorkspace(db: Conn, ignore = false) {
  const insert = ignore ? 'INSERT IGNORE' : 'INSERT';
  await db.query(`${insert} INTO cal_event (event_id, owner_user_id, owner_name, title, starts_at, ends_at, with_whom, with_user_id, source, status, created_at) VALUES ?`, [EVENTS.map(([owner, name, title, starts, ends, withWhom, withUser, source], i) => [i + 1, owner, name, title, `${starts}:00`, `${ends}:00`, withWhom, withUser, source, 'Scheduled', '2026-10-20'])]);
  await db.query(`${insert} INTO fil_file (file_id, name, folder, type, mime, size_kb, owner, owner_user_id, modified, status, staged_at, content) VALUES ?`, [FILES.map(([name, folder, type, mime, owner, ownerId, body], i) => [i + 1, name, folder, type, mime, Math.max(1, Math.ceil(Buffer.byteLength(body) / 1024)), owner, ownerId, '2026-10-23', 'Saved', '2026-10-23 09:00:00', Buffer.from(body)])]);
}
