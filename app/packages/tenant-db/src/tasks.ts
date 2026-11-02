// Tasks and My Time (spec 8.17). People's own tasks and time entries; tasks that agents create in
// other modules (referral follow-ups, touch points, outreach) stay where they are and are listed with
// them. The seeded tasks and October hours are demo values.
export const TASKS_DDL = [
  `CREATE TABLE tsk_task (
     task_id INT AUTO_INCREMENT PRIMARY KEY,
     title VARCHAR(160) NOT NULL,
     notes VARCHAR(500) NULL,
     owner_user_id VARCHAR(40) NOT NULL,
     owner_name VARCHAR(80) NOT NULL,
     due DATE NULL,
     status VARCHAR(12) NOT NULL,
     created_by VARCHAR(80) NOT NULL,
     created_at DATE NOT NULL,
     done_note VARCHAR(300) NULL,
     approval_id VARCHAR(40) NULL UNIQUE,
     KEY ix_task_owner (owner_user_id, status)
   )`,
  `CREATE TABLE tsk_time (
     entry_id INT AUTO_INCREMENT PRIMARY KEY,
     user_id VARCHAR(40) NOT NULL,
     on_date DATE NOT NULL,
     hours DECIMAL(5,2) NOT NULL,
     project VARCHAR(80) NOT NULL,
     note VARCHAR(200) NULL,
     approval_id VARCHAR(40) NULL UNIQUE,
     KEY ix_time_user (user_id, on_date)
   )`,
];

export const TASKS_WRITE_TABLES = ['tsk_task', 'tsk_time'];

const PEOPLE: [string, string][] = [['user:9229', 'Dana Lee'], ['user:5120', 'Marcus Reed'], ['user:6101', 'Ana Ruiz'], ['user:6004', 'Sofia Ruiz'], ['user:4410', 'Priya Shah'], ['user:1002', 'Sam Taylor']];
const TASKS: [number, string, string | null, string, string][] = [
  [0, 'Review the Q3 board pack draft', 'Check the deposit mix page against the ALCO numbers.', '2026-10-27', 'Open'],
  [0, 'Sign off October payouts', null, '2026-10-24', 'Open'],
  [1, 'Call the three Westport members who closed accounts this week', 'From the attrition list.', '2026-10-26', 'Open'],
  [1, 'Prepare the branch huddle agenda', null, '2026-10-28', 'Open'],
  [1, 'Follow up with Smith Ford on the rate sheet', null, '2026-10-22', 'Open'],
  [2, 'Send the HELOC disclosure to the Jacksons', null, '2026-10-25', 'Open'],
  [3, 'Order new debit card stock', null, '2026-10-29', 'Open'],
  [4, 'Validate the September delinquency rollup', 'Compare with the GL.', '2026-10-23', 'Done'],
  [5, 'Rotate the SFTP key for the LOS feed', null, '2026-10-30', 'Open'],
];
const PROJECTS = ['Branch operations', 'Member calls', 'Q4 board pack', 'Training', 'Lending reviews'];

interface Conn {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function seedTasks(db: Conn, ignore = false) {
  const insert = ignore ? 'INSERT IGNORE' : 'INSERT';
  await db.query(`${insert} INTO tsk_task (task_id, title, notes, owner_user_id, owner_name, due, status, created_by, created_at) VALUES ?`, [TASKS.map(([p, title, notes, due, status], i) => [i + 1, title, notes, PEOPLE[p]![0], PEOPLE[p]![1], due, status, PEOPLE[p]![1], '2026-10-20'])]);
  // Weekday hours for October, the same on every seed.
  const entries: unknown[][] = [];
  PEOPLE.forEach(([user], p) => {
    for (let d = 1; d <= 24; d++) {
      const date = `2026-10-${String(d).padStart(2, '0')}`;
      if ([0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) continue;
      entries.push([entries.length + 1, user, date, 6 + ((d + p) % 3), PROJECTS[(d + p) % PROJECTS.length], null]);
      if ((d + p) % 4 === 0) entries.push([entries.length + 1, user, date, 1.5, PROJECTS[(d + p + 2) % PROJECTS.length], null]);
    }
  });
  await db.query(`${insert} INTO tsk_time (entry_id, user_id, on_date, hours, project, note) VALUES ?`, [entries]);
}
