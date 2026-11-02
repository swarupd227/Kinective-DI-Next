// Indirect Lending (spec 8.28) and Outbound Prospecting (8.31). Dealer funded figures come from the
// warehouse's own indirect loans: each indirect loan belongs to one dealer. Received, decision and
// FICO figures, dealer and prospect names, places and the prospect timeline are demo values.
export const GROWTH_DDL = [
  `CREATE TABLE ind_dealer (
     dealer_id INT PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     city VARCHAR(40) NOT NULL,
     branch VARCHAR(40) NOT NULL,
     lat DECIMAL(8,5) NOT NULL,
     lng DECIMAL(8,5) NOT NULL,
     rep VARCHAR(80) NOT NULL,
     cudl_id VARCHAR(12) NOT NULL,
     dealertrack_id VARCHAR(12) NOT NULL,
     routeone_id VARCHAR(12) NOT NULL,
     ytd_visits INT NOT NULL,
     last_visited DATE NULL,
     status VARCHAR(12) NOT NULL
   )`,
  `CREATE TABLE ind_dealer_month (
     dealer_id INT NOT NULL,
     month CHAR(7) NOT NULL,
     received INT NOT NULL,
     approved INT NOT NULL,
     declined INT NOT NULL,
     countered INT NOT NULL,
     funded INT NOT NULL,
     funded_amount DECIMAL(14,2) NOT NULL,
     avg_fico INT NOT NULL,
     PRIMARY KEY (dealer_id, month)
   )`,
  `CREATE TABLE ind_visit (visit_id INT AUTO_INCREMENT PRIMARY KEY, dealer_id INT NOT NULL, on_date DATE NOT NULL, note VARCHAR(300) NOT NULL, by_name VARCHAR(80) NOT NULL, approval_id VARCHAR(40) NULL UNIQUE)`,
  `CREATE TABLE prs_stage (position INT PRIMARY KEY, name VARCHAR(40) NOT NULL UNIQUE)`,
  `CREATE TABLE prs_disposition (name VARCHAR(40) PRIMARY KEY)`,
  `CREATE TABLE prs_prospect (
     prospect_id INT PRIMARY KEY,
     company VARCHAR(80) NOT NULL,
     contact VARCHAR(80) NOT NULL,
     city VARCHAR(40) NOT NULL,
     branch VARCHAR(40) NOT NULL,
     lat DECIMAL(8,5) NOT NULL,
     lng DECIMAL(8,5) NOT NULL,
     assets DECIMAL(14,2) NOT NULL,
     grade CHAR(1) NOT NULL,
     stage VARCHAR(40) NOT NULL,
     disposition VARCHAR(40) NOT NULL,
     owner VARCHAR(80) NOT NULL,
     next_follow_up DATE NULL
   )`,
  `CREATE TABLE prs_activity (activity_id INT AUTO_INCREMENT PRIMARY KEY, prospect_id INT NOT NULL, on_date DATE NOT NULL, kind VARCHAR(20) NOT NULL, from_stage VARCHAR(40) NULL, to_stage VARCHAR(40) NULL, note VARCHAR(300) NOT NULL, by_name VARCHAR(80) NOT NULL, approval_id VARCHAR(40) NULL UNIQUE, KEY ix_prs_act (prospect_id, on_date))`,
];

export const GROWTH_WRITE_TABLES = ['ind_dealer', 'ind_visit', 'prs_prospect', 'prs_activity'];

export const PROSPECT_STAGES = ['Suspect', 'Follow-up', 'Prospect', 'Pre-Qualified', 'Qualified', 'Application', 'Approved'];
export const PROSPECT_DISPOSITIONS = ['Interested', 'Call back', 'No answer', 'Not interested', 'Meeting set'];

const DEALERS = ['Smith Ford', 'Lakeside Honda', 'Capital Toyota', 'Riverview Chevrolet', 'Northway Subaru', 'Hudson Valley Kia', 'Empire Nissan', 'Colonie Hyundai', 'Patroon Mazda', 'Greenbush Dodge', 'Mohawk Volkswagen', 'Saratoga Jeep'];
const COMPANIES: [string, string][] = [['Acme Manufacturing', 'Dana Smith'], ['Bright Path Logistics', 'Leo Park'], ['Cedar Ridge Dental', 'Amy Chen'], ['Delta Precision Tools', 'Raj Patel'], ['Evergreen Landscaping', 'Mia Lopez'], ['Fulton Street Bakery', 'Sam Ortiz'], ['Granite State Roofing', 'Jo Kim'], ['Harbor Marine Supply', 'Ben Ward'], ['Ironwood Builders', 'Kate Moss'], ['Juniper Health Clinic', 'Omar Haddad'], ['Keystone Auto Body', 'Lena Fox'], ['Lighthouse Architects', 'Nico Ruiz'], ['Maple Leaf Daycare', 'Ivy Brooks'], ['Northstar Electric', 'Paul Grant'], ['Oakline Furniture', 'Rosa Diaz'], ['Pioneer Plumbing', 'Eli Stone'], ['Quarry Hill Farms', 'Tess Young'], ['Redwood Accounting', 'Max Hale']];
/** A fictional county around the institution's head office. */
const HUB = [42.65, -73.76];
const place = (i: number, ring: number) => [HUB[0]! + Math.sin(i * 2.399) * ring, HUB[1]! + Math.cos(i * 2.399) * ring * 1.35] as const;
const round = (n: number) => Math.round(n * 1e5) / 1e5;

interface Conn {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Fills the growth tables from the tenant's branches, staff and indirect loans. Run after them. */
export async function seedGrowth(db: Conn, ignore = false) {
  const insert = ignore ? 'INSERT IGNORE' : 'INSERT';
  const [branches] = (await db.query('SELECT name FROM cdm_location ORDER BY int_id')) as [{ name: string }[]];
  const [staff] = (await db.query("SELECT display_name FROM cdm_employee WHERE role IN ('Loan officer', 'Branch manager') AND display_name NOT LIKE '_. %' ORDER BY employee_id")) as [{ display_name: string }[]];
  const branch = (i: number) => branches[i % branches.length]!.name;
  const person = (i: number) => staff[i % staff.length]?.display_name ?? 'Unassigned';
  const dealers = DEALERS.map((name, i) => {
    const [lat, lng] = place(i, 0.09 + (i % 4) * 0.05);
    return [i + 1, name, branch(i), branch(i), round(lat), round(lng), person(i), `CU${4100 + i * 7}`, `DT${88200 + i * 13}`, `R1${5300 + i * 11}`, 2 + (i * 5) % 9, `2026-${String(7 + (i % 4)).padStart(2, '0')}-${String(3 + (i * 7) % 24).padStart(2, '0')}`, i === 11 ? 'Inactive' : 'Active'];
  });
  await db.query(`${insert} INTO ind_dealer VALUES ?`, [dealers]);
  // Funded counts and amounts are the indirect loans each dealer sent; the rest follows from them.
  await db.query(`${insert} INTO ind_dealer_month (dealer_id, month, received, approved, declined, countered, funded, funded_amount, avg_fico)
    SELECT d, m, ROUND(n * (1.45 + MOD(d, 5) / 10)), ROUND(n * (1.15 + MOD(d, 3) / 20)), ROUND(n * (0.22 + MOD(d, 4) / 20)), ROUND(n * 0.08), n, amount, 690 + MOD(d * 7, 45)
    FROM (SELECT MOD(loan_id, ${DEALERS.length}) + 1 AS d, DATE_FORMAT(open_date, '%Y-%m') AS m, COUNT(*) AS n, SUM(original_amount) AS amount FROM cdm_loan WHERE is_indirect = 1 AND open_date >= '2026-01-01' GROUP BY d, m) x`);
  await db.query(`${insert} INTO prs_stage VALUES ?`, [PROSPECT_STAGES.map((s, i) => [i + 1, s])]);
  await db.query(`${insert} INTO prs_disposition VALUES ?`, [PROSPECT_DISPOSITIONS.map((d) => [d])]);
  const prospects = COMPANIES.map(([company, contact], i) => {
    const [lat, lng] = place(i + 20, 0.05 + (i % 5) * 0.04);
    const stage = PROSPECT_STAGES[[0, 1, 2, 2, 3, 3, 4, 4, 4, 5, 2, 1, 3, 4, 5, 6, 0, 2][i]!]!;
    return [i + 1, company, contact, branch(i + 2), branch(i + 2), round(lat), round(lng), [1.2, 3.4, 8.9, 0.6, 5.2, 12.5, 2.1, 6.8, 15.0, 4.4, 0.9, 7.3, 1.6, 9.8, 22.0, 3.1, 0.4, 5.9][i]! * 1e6, 'ABCD'[(i * 3) % 4], stage, PROSPECT_DISPOSITIONS[i % PROSPECT_DISPOSITIONS.length], person(i + 1), i % 3 ? `2026-10-${String(26 + (i % 5)).padStart(2, '0')}` : null];
  });
  await db.query(`${insert} INTO prs_prospect VALUES ?`, [prospects]);
  // Each prospect walked up the stages to where it is now, one step every two or three weeks.
  const activity: unknown[][] = [];
  for (const p of prospects) {
    const reached = PROSPECT_STAGES.indexOf(p[9] as string);
    for (let s = 1; s <= reached; s++) {
      const at = new Date(Date.UTC(2026, 6, 1 + ((p[0] as number) * 3) % 20 + s * 15)).toISOString().slice(0, 10);
      const day = at > '2026-10-24' ? '2026-10-24' : at;
      activity.push([p[0], day, 'Stage change', PROSPECT_STAGES[s - 1], PROSPECT_STAGES[s], `Moved to ${PROSPECT_STAGES[s]}.`, p[11]]);
    }
    activity.push([p[0], '2026-10-20', 'Call', null, null, `${p[10]}.`, p[11]]);
  }
  await db.query(`${insert} INTO prs_activity (prospect_id, on_date, kind, from_stage, to_stage, note, by_name) VALUES ?`, [activity]);
}

/** Where a branch is, for routes. Branches sit on a small ring round the head office. */
export const branchPlace = (index: number) => place(index + 40, 0.03).map(round) as [number, number];
