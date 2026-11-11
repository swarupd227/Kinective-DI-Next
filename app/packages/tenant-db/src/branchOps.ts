// Branch operations for a credit union's branch managers: what the teller platform, the vault log, the
// lobby queue system, the BSA officer's branch log, the fraud team, internal audit, the learning system
// and HR record for each branch. Teller drawers balanced each day with transactions and hours, the vault
// against its limit, lobby arrivals and waits by hour, CTRs and structuring referrals by branch (never
// SARs: those stay with the BSA officer), fraud and Reg E claims, surprise cash counts and audit
// exceptions, training assignments, staff who joined and left, and quarterly engagement.
//
// Demo data [Assumption: demo], drawn with unit() from its own salts, in tables of its own: nothing
// else in the seed moves. The CU's front line is its MSRs, who also run the teller line.
import type mysql from 'mysql2/promise';
import { AS_OF, unit } from './generate.ts';

export const BRANCH_OPS_DDL = [
  `CREATE TABLE bro_teller_day (business_date DATE NOT NULL, branch_id INT NOT NULL, employee_id INT NOT NULL, transactions INT NOT NULL, hours DECIMAL(4,1) NOT NULL, cash_handled DECIMAL(12,2) NOT NULL, over_short DECIMAL(8,2) NOT NULL, PRIMARY KEY (business_date, employee_id), KEY ix_teller_branch (branch_id, business_date))`,
  `CREATE TABLE bro_vault_day (business_date DATE NOT NULL, branch_id INT NOT NULL, vault_cash DECIMAL(12,2) NOT NULL, vault_limit DECIMAL(12,2) NOT NULL, dual_control TINYINT NOT NULL, PRIMARY KEY (business_date, branch_id))`,
  `CREATE TABLE bro_lobby_hour (business_date DATE NOT NULL, branch_id INT NOT NULL, hour TINYINT NOT NULL, arrivals INT NOT NULL, avg_wait_min DECIMAL(4,1) NOT NULL, max_wait_min DECIMAL(4,1) NOT NULL, PRIMARY KEY (business_date, branch_id, hour))`,
  `CREATE TABLE bro_ctr (ctr_id INT PRIMARY KEY, branch_id INT NOT NULL, txn_date DATE NOT NULL, filed_on DATE NOT NULL, amount DECIMAL(12,2) NOT NULL, direction VARCHAR(8) NOT NULL, KEY ix_ctr_branch (branch_id, txn_date))`,
  `CREATE TABLE bro_aml_referral (referral_id INT PRIMARY KEY, branch_id INT NOT NULL, referred_on DATE NOT NULL, typology VARCHAR(40) NOT NULL, amount DECIMAL(12,2) NOT NULL, referred_by INT NOT NULL, status VARCHAR(24) NOT NULL, KEY ix_aml_branch (branch_id, referred_on))`,
  `CREATE TABLE bro_fraud_case (case_id INT PRIMARY KEY, branch_id INT NOT NULL, opened DATE NOT NULL, fraud_type VARCHAR(40) NOT NULL, channel VARCHAR(20) NOT NULL, reg_e TINYINT NOT NULL, elder TINYINT NOT NULL, gross_loss DECIMAL(12,2) NOT NULL, recovered DECIMAL(12,2) NOT NULL, status VARCHAR(20) NOT NULL, resolved DATE NULL, KEY ix_fraud_branch (branch_id, opened))`,
  `CREATE TABLE bro_cash_count (count_id INT PRIMARY KEY, branch_id INT NOT NULL, count_date DATE NOT NULL, area VARCHAR(20) NOT NULL, employee_id INT NULL, expected DECIMAL(12,2) NOT NULL, counted DECIMAL(12,2) NOT NULL, dual_control TINYINT NOT NULL, KEY ix_count_branch (branch_id, count_date))`,
  `CREATE TABLE bro_audit_exception (exception_id INT PRIMARY KEY, branch_id INT NOT NULL, found_on DATE NOT NULL, source VARCHAR(30) NOT NULL, category VARCHAR(40) NOT NULL, severity VARCHAR(8) NOT NULL, detail VARCHAR(200) NOT NULL, due DATE NOT NULL, closed DATE NULL, KEY ix_audit_branch (branch_id, found_on))`,
  `CREATE TABLE bro_training (employee_id INT NOT NULL, course VARCHAR(40) NOT NULL, required TINYINT NOT NULL, assigned DATE NOT NULL, due DATE NOT NULL, completed DATE NULL, PRIMARY KEY (employee_id, course))`,
  `CREATE TABLE bro_staff_change (change_id INT PRIMARY KEY, branch_id INT NOT NULL, employee_name VARCHAR(80) NOT NULL, role VARCHAR(40) NOT NULL, kind VARCHAR(8) NOT NULL, change_date DATE NOT NULL, reason VARCHAR(60) NULL)`,
  `CREATE TABLE bro_engagement (branch_id INT NOT NULL, quarter_end DATE NOT NULL, score DECIMAL(4,1) NOT NULL, invited INT NOT NULL, responded INT NOT NULL, PRIMARY KEY (branch_id, quarter_end))`,
];
export const BRANCH_OPS_TABLES = ['bro_teller_day', 'bro_vault_day', 'bro_lobby_hour', 'bro_ctr', 'bro_aml_referral', 'bro_fraud_case', 'bro_cash_count', 'bro_audit_exception', 'bro_training', 'bro_staff_change', 'bro_engagement'];
export const BRANCH_OPS_COLUMNS: Record<string, string[]> = {
  bro_teller_day: ['business_date', 'branch_id', 'employee_id', 'transactions', 'hours', 'cash_handled', 'over_short'],
  bro_vault_day: ['business_date', 'branch_id', 'vault_cash', 'vault_limit', 'dual_control'],
  bro_lobby_hour: ['business_date', 'branch_id', 'hour', 'arrivals', 'avg_wait_min', 'max_wait_min'],
  bro_ctr: ['ctr_id', 'branch_id', 'txn_date', 'filed_on', 'amount', 'direction'],
  bro_aml_referral: ['referral_id', 'branch_id', 'referred_on', 'typology', 'amount', 'referred_by', 'status'],
  bro_fraud_case: ['case_id', 'branch_id', 'opened', 'fraud_type', 'channel', 'reg_e', 'elder', 'gross_loss', 'recovered', 'status', 'resolved'],
  bro_cash_count: ['count_id', 'branch_id', 'count_date', 'area', 'employee_id', 'expected', 'counted', 'dual_control'],
  bro_audit_exception: ['exception_id', 'branch_id', 'found_on', 'source', 'category', 'severity', 'detail', 'due', 'closed'],
  bro_training: ['employee_id', 'course', 'required', 'assigned', 'due', 'completed'],
  bro_staff_change: ['change_id', 'branch_id', 'employee_name', 'role', 'kind', 'change_date', 'reason'],
  bro_engagement: ['branch_id', 'quarter_end', 'score', 'invited', 'responded'],
};

/** Courses each person must finish every year, and the targets the CEO holds branches to. */
export const REQUIRED_COURSES = ['BSA/AML', 'Fair Lending', 'Information Security'];
const ELECTIVE_COURSES = ['Elder Financial Exploitation', 'Reg E Disputes'];
const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Business days (Monday to Saturday) in the last n calendar days to the as-of date, oldest first. */
function businessDays(n: number) {
  const end = Date.parse(`${AS_OF}T00:00:00Z`);
  const out: { t: number; date: string; dow: number }[] = [];
  for (let i = n; i >= 1; i--) {
    const t = end - i * DAY;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0) out.push({ t, date: ymd(t), dow });
  }
  return out;
}

const BRANCH_SIZE: Record<number, number> = { 1: 1.25, 2: 1, 3: 0.9, 4: 0.8, 5: 1.3, 6: 0.65 };
const LAST = ['Moore', 'Patel', 'Nguyen', 'Garcia', 'Brooks', 'Lopez', 'Kim', 'Hughes', 'Price', 'Diaz', 'Foster', 'Reyes'];
const FIRST = ['Avery', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Quinn', 'Drew', 'Parker', 'Rowan', 'Skyler'];

/** employees: cdm_employee rows (employee_id, display_name, role, branch_id). */
export function generateBranchOps(employees: unknown[][]) {
  const staff = employees.map((e) => ({ id: Number(e[0]), name: String(e[1]), role: String(e[2]), branch: Number(e[3]) }));
  const branches = [...new Set(staff.map((s) => s.branch))].sort((a, b) => a - b);
  const tellers = staff.filter((s) => s.role === 'MSR');
  const out: Record<string, unknown[][]> = Object.fromEntries(BRANCH_OPS_TABLES.map((t) => [t, []]));
  const days = businessDays(91);
  const asOf = Date.parse(`${AS_OF}T00:00:00Z`);

  // Teller drawers: most days balance to the penny. Westport's third teller (employee 5) is out more often.
  for (const d of days) {
    for (const s of tellers) {
      const size = BRANCH_SIZE[s.branch] ?? 1;
      const sat = d.dow === 6;
      const hours = sat ? 3.5 : r1(6.5 + unit(s.id * 1000 + d.t / DAY, 9101) * 1.5);
      const rate = (sat ? 15 : 13) + unit(s.id, 9102) * 6;
      const transactions = Math.round(hours * rate * (0.85 + unit(s.id * 1000 + d.t / DAY, 9103) * 0.3) * Math.sqrt(size));
      const missRate = s.id === 5 ? 0.09 : 0.02 + unit(s.id, 9104) * 0.02;
      const miss = unit(s.id * 1000 + d.t / DAY, 9105) < missRate;
      const amount = miss ? r2((unit(s.id * 1000 + d.t / DAY, 9106) < 0.55 ? -1 : 1) * [5, 10, 20, 20, 50, 100, 0.5, 1.25][Math.floor(unit(s.id * 1000 + d.t / DAY, 9107) * 8)]!) : 0;
      out.bro_teller_day!.push([d.date, s.branch, s.id, transactions, hours, r2(transactions * (180 + unit(s.id * 1000 + d.t / DAY, 9108) * 140)), amount]);
    }
  }

  // The vault at close against its limit. Westport runs over after Friday payroll cash orders.
  for (const d of days) {
    for (const b of branches) {
      const size = BRANCH_SIZE[b] ?? 1;
      const limit = Math.round((300_000 * size) / 25_000) * 25_000;
      let cash = limit * (0.55 + unit(b * 1000 + d.t / DAY, 9201) * 0.35);
      if (b === 1 && d.dow === 5 && unit(d.t / DAY, 9202) < 0.6) cash = limit * (1.04 + unit(d.t / DAY, 9203) * 0.12);
      out.bro_vault_day!.push([d.date, b, r2(cash), limit, unit(b * 1000 + d.t / DAY, 9204) < (b === 1 ? 0.985 : 0.995) ? 1 : 0]);
    }
  }

  // The lobby, by hour: lunch, Fridays and Saturday mornings are busiest.
  for (const d of days) {
    const hours = d.dow === 6 ? [9, 10, 11] : [9, 10, 11, 12, 13, 14, 15, 16];
    for (const b of branches) {
      const size = BRANCH_SIZE[b] ?? 1;
      const staffed = tellers.filter((s) => s.branch === b).length || 1;
      for (const h of hours) {
        const peak = (h === 12 ? 1.6 : h === 13 ? 1.35 : h === 16 ? 1.25 : 1) * (d.dow === 5 ? 1.35 : d.dow === 1 ? 1.15 : d.dow === 6 ? 1.3 : 1);
        const key = b * 100_000 + (d.t / DAY) * 24 + h;
        const arrivals = Math.max(1, Math.round(9 * size * peak * (0.8 + unit(key, 9301) * 0.4)));
        const load = arrivals / (staffed * 6.5);
        const wait = r1(Math.max(0.3, (load * load * 2.6 + unit(key, 9302) * 0.8) * (b === 5 ? 1.2 : 1)));
        out.bro_lobby_hour!.push([d.date, b, h, arrivals, wait, r1(wait * (1.8 + unit(key, 9303) * 1.4))]);
      }
    }
  }

  // CTRs: filed within 15 days of the transaction; a few late.
  let ctr = 1;
  for (let m = 0; m < 12; m++) {
    for (const b of branches) {
      const k = Math.round((BRANCH_SIZE[b] ?? 1) * (7 + unit(b * 100 + m, 9401) * 6));
      for (let i = 0; i < k; i++) {
        const key = b * 10_000 + m * 100 + i;
        const t = asOf - (m * 30 + Math.floor(unit(key, 9402) * 30) + 16) * DAY;
        const late = unit(key, 9403) < (b === 1 ? 0.03 : 0.015);
        out.bro_ctr!.push([ctr++, b, ymd(t), ymd(t + (late ? 17 + Math.floor(unit(key, 9404) * 10) : 2 + Math.floor(unit(key, 9405) * 10)) * DAY), r2(10_000 + unit(key, 9406) ** 2 * 60_000), unit(key, 9407) < 0.8 ? 'Cash in' : 'Cash out']);
      }
    }
  }

  // Unusual-activity referrals from branch staff to the BSA officer (what happens next is the BSA officer's).
  const TYPOLOGIES: [string, number][] = [['Structuring', 0.5], ['Unusual cash activity', 0.25], ['Third-party deposits', 0.15], ['Elder exploitation concern', 0.1]];
  let ref = 1;
  for (const b of branches) {
    const k = Math.round((BRANCH_SIZE[b] ?? 1) * 6) + (b === 1 ? 2 : 0);
    const mine = staff.filter((s) => s.branch === b);
    for (let i = 0; i < k; i++) {
      const key = b * 1000 + i;
      let x = unit(key, 9501);
      const typ = TYPOLOGIES.find(([, w]) => (x -= w) < 0)?.[0] ?? 'Structuring';
      const days = Math.floor(unit(key, 9502) * 360);
      out.bro_aml_referral!.push([ref++, b, ymd(asOf - days * DAY), typ, r2(typ === 'Structuring' ? 8_000 + unit(key, 9503) * 30_000 : 2_000 + unit(key, 9503) * 40_000), mine[Math.floor(unit(key, 9504) * mine.length)]?.id ?? 0, days < 30 ? 'With BSA officer' : 'Closed']);
    }
  }

  // Fraud: Eastgate's ATM had a skimmer in August; Westport carries two elder exploitation cases.
  const FRAUD: [string, string, number, number][] = [
    // type, channel, Reg E claim, weight
    ['Debit card fraud', 'Card', 1, 0.3],
    ['Card skimming', 'ATM', 1, 0.15],
    ['Check fraud', 'Branch', 0, 0.25],
    ['Account takeover', 'Online', 1, 0.12],
    ['Elder financial exploitation', 'Branch', 0, 0.08],
    ['Unauthorized ACH', 'ACH', 1, 0.1],
  ];
  let fc = 1;
  const fraud = (b: number, t: number, type: [string, string, number, number], key: number, elder = 0) => {
    const loss = r2(type[0] === 'Check fraud' ? 1_500 + unit(key, 9603) * 9_000 : type[0] === 'Elder financial exploitation' ? 6_000 + unit(key, 9603) * 30_000 : 150 + unit(key, 9603) * 2_400);
    const age = Math.round((asOf - t) / DAY);
    const open = age < 20 || (type[2] && age < 60 && unit(key, 9604) < 0.2);
    const recovered = r2(loss * (type[0] === 'Check fraud' ? 0.4 : type[2] ? 0.15 : 0.1) * unit(key, 9605));
    out.bro_fraud_case!.push([fc++, b, ymd(t), type[0], type[1], type[2], elder || (type[0] === 'Elder financial exploitation' ? 1 : 0), loss, recovered, open ? 'Open' : 'Closed', open ? null : ymd(t + Math.min(age, 8 + Math.floor(unit(key, 9606) * 30)) * DAY)]);
  };
  for (const b of branches) {
    const k = Math.round((BRANCH_SIZE[b] ?? 1) * 14);
    for (let i = 0; i < k; i++) {
      const key = b * 1000 + i;
      let x = unit(key, 9601);
      const type = FRAUD.find((f) => (x -= f[3]) < 0) ?? FRAUD[0]!;
      fraud(b, asOf - Math.floor(unit(key, 9602) * 360) * DAY, type, key);
    }
  }
  for (let i = 0; i < 9; i++) fraud(6, Date.parse('2026-08-11T00:00:00Z') + Math.floor(unit(i, 9607) * 9) * DAY, FRAUD[1]!, 60_000 + i);
  for (const [i, days] of [[0, 34], [1, 12]] as const) fraud(1, asOf - days * DAY, FRAUD[4]!, 70_000 + i, 1);

  // Surprise cash counts: the vault and a drawer most months, dual control witnessed.
  let cc = 1;
  for (const b of branches) {
    const mine = tellers.filter((s) => s.branch === b);
    for (let m = 0; m < 12; m++) {
      const key = b * 100 + m;
      // Westport's count 43 days ago found Caleb's drawer (employee 5) $20 short, counted by one person.
      const flagged = b === 1 && m === 1;
      const t = asOf - (flagged ? 43 : m * 30 + 3 + Math.floor(unit(key, 9701) * 25)) * DAY;
      const vault = r2(200_000 * (BRANCH_SIZE[b] ?? 1) * (0.7 + unit(key, 9702) * 0.3));
      out.bro_cash_count!.push([cc++, b, ymd(t), 'Vault', null, vault, vault, 1]);
      const who = flagged ? (mine.find((s) => s.id === 5) ?? mine[0]) : mine[m % Math.max(1, mine.length)];
      const drawer = r2(8_000 + unit(key, 9703) * 6_000);
      const off = flagged ? -20 : unit(key, 9704) < 0.06 ? (unit(key, 9705) < 0.5 ? -10 : 5) : 0;
      out.bro_cash_count!.push([cc++, b, ymd(t), 'Teller drawer', who?.id ?? null, drawer, r2(drawer + off), flagged ? 0 : 1]);
    }
  }

  // Audit exceptions: internal audit, surprise counts, dual control reviews and compliance reviews.
  const EXC: [number, number, string, string, string, string, number | null][] = [
    // branch, days ago found, source, category, severity, detail, days to close (null = open)
    [1, 43, 'Surprise cash count', 'Dual control', 'High', 'Surprise drawer count done without a second person present.', null],
    [1, 43, 'Surprise cash count', 'Cash difference', 'Medium', 'Teller drawer $20 short at the surprise count.', 9],
    [1, 26, 'Dual control review', 'Vault limit', 'Medium', 'Vault over its limit on Fridays after the payroll cash order.', null],
    [1, 150, 'Internal audit', 'Record retention', 'Low', 'Two signature cards missing from the account files.', 30],
    [2, 70, 'Internal audit', 'Overrides', 'Medium', 'Fee waivers above authority without manager approval.', 21],
    [3, 18, 'Compliance review', 'CIP', 'Medium', 'Two new accounts opened without a second ID recorded.', null],
    [4, 120, 'Internal audit', 'Key control', 'Low', 'Vault key log not signed for three days.', 12],
    [5, 55, 'Dual control review', 'Dual control', 'High', 'ATM replenished by one person per the camera review.', null],
    [5, 95, 'Surprise cash count', 'Cash difference', 'Low', 'Teller drawer $10 over at the surprise count.', 5],
    [6, 30, 'Compliance review', 'Reg E', 'Medium', 'Provisional credit given late on two card disputes.', null],
    [6, 200, 'Internal audit', 'Security', 'Low', 'Robbery drill not documented for the quarter.', 40],
  ];
  EXC.forEach(([b, ago, source, cat, sev, detail, close], i) => {
    if (!branches.includes(b)) return;
    const found = asOf - ago * DAY;
    out.bro_audit_exception!.push([i + 1, b, ymd(found), source, cat, sev, detail, ymd(found + (sev === 'High' ? 30 : sev === 'Medium' ? 45 : 60) * DAY), close === null ? null : ymd(found + close * DAY)]);
  });

  // Training: required courses due by year end of the plan year; a few Westport and Downtown people behind.
  const year = Number(AS_OF.slice(0, 4));
  for (const s of staff) {
    for (const [ci, course] of [...REQUIRED_COURSES, ...ELECTIVE_COURSES].entries()) {
      const required = ci < REQUIRED_COURSES.length ? 1 : 0;
      if (!required && s.role === 'Loan officer' && course === 'Reg E Disputes') continue;
      const key = s.id * 10 + ci;
      const due = ymd(Date.parse(`${year}-${['09-30', '10-15', '10-31', '11-30', '12-15'][ci]}T00:00:00Z`));
      const behind = (s.id === 5 && course === 'Fair Lending') || (s.id === 2 && course === 'Information Security') || (s.branch === 5 && unit(key, 9801) < 0.18 && required) || (!required && unit(key, 9802) < 0.35);
      const done = behind ? null : ymd(Math.min(asOf - 2 * DAY, Date.parse(`${due}T00:00:00Z`) - Math.floor(unit(key, 9803) * 60) * DAY));
      out.bro_training!.push([s.id, course, required, `${year}-01-15`, due, done]);
    }
  }

  // Staff who left and joined in the last 12 months (the roster holds only today's people).
  const LEFT: [number, string, number, string][] = [
    [1, 'MSR', 80, 'Better pay elsewhere'], [1, 'MSR', 210, 'Moved away'], [2, 'MSR', 140, 'Career change'], [3, 'Loan officer', 300, 'Better pay elsewhere'],
    [5, 'MSR', 60, 'Better pay elsewhere'], [5, 'MSR', 175, 'Schedule'], [5, 'Loan officer', 250, 'Promoted out of branch'], [6, 'MSR', 115, 'Better pay elsewhere'],
  ];
  LEFT.forEach(([b, role, ago, reason], i) => {
    if (!branches.includes(b)) return;
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`;
    out.bro_staff_change!.push([i * 2 + 1, b, name, role, 'Left', ymd(asOf - ago * DAY), reason]);
    const repl = staff.filter((s) => s.branch === b && s.role === role)[i % 2];
    if (repl) out.bro_staff_change!.push([i * 2 + 2, b, repl.name, role, 'Joined', ymd(asOf - (ago - 21) * DAY), null]);
  });

  // Quarterly engagement survey, 1 to 5.
  for (const b of branches) {
    const headcount = staff.filter((s) => s.branch === b).length;
    for (const [qi, q] of ['2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30'].entries()) {
      const base = b === 5 ? 3.5 - qi * 0.1 : b === 1 ? 3.9 + qi * 0.05 : 3.8 + unit(b * 10 + qi, 9901) * 0.4;
      out.bro_engagement!.push([b, q, r1(base), headcount, Math.max(1, headcount - (unit(b * 10 + qi, 9902) < 0.4 ? 1 : 0))]);
    }
  }
  return out;
}

/**
 * Creates and fills the branch operations tables in one credit union schema from its staff roster.
 * Safe to run again: it replaces only these tables. The application account reads them through the
 * schema-wide SELECT grant.
 */
export async function seedBranchOps(admin: mysql.Connection, schema: string) {
  await admin.query(`USE \`${schema}\``);
  for (const table of BRANCH_OPS_TABLES) await admin.query(`DROP TABLE IF EXISTS \`${table}\``);
  for (const ddl of BRANCH_OPS_DDL) await admin.query(ddl);
  const [employees] = await admin.query('SELECT employee_id, display_name, role, branch_id FROM cdm_employee ORDER BY employee_id');
  const rows = generateBranchOps((employees as Record<string, unknown>[]).map((e) => [e.employee_id, e.display_name, e.role, e.branch_id]));
  for (const table of BRANCH_OPS_TABLES) {
    const data = rows[table]!;
    for (let i = 0; i < data.length; i += 2000) await admin.query(`INSERT INTO \`${table}\` (${BRANCH_OPS_COLUMNS[table]!.join(', ')}) VALUES ?`, [data.slice(i, i + 2000)]);
  }
  return Object.fromEntries(BRANCH_OPS_TABLES.map((t) => [t, rows[t]!.length]));
}
