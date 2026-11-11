// SEG Management detail (DI's SEG module): each employer group's contact, branch, business development
// manager and next follow-up; the events held at each (benefits fairs, lunch-and-learns) and what they
// brought in; six months of business development activity; and the monthly goals for the BD scorecard.
// Credit unions only. Demo data [Assumption: demo]; drawn with unit() so nothing else moves.
import { AS_OF, unit } from './generate.ts';

export const SEG_DETAIL_DDL = [
  `CREATE TABLE seg_contact (company_id INT PRIMARY KEY, contact_name VARCHAR(80) NOT NULL, title VARCHAR(80) NOT NULL, phone VARCHAR(20) NOT NULL, email VARCHAR(120) NOT NULL, branch VARCHAR(40) NOT NULL, bd_manager VARCHAR(80) NOT NULL, active TINYINT NOT NULL, employees INT NOT NULL, next_follow_up DATE NULL, follow_up_note VARCHAR(200) NULL)`,
  `CREATE TABLE seg_event (event_id INT AUTO_INCREMENT PRIMARY KEY, company_id INT NOT NULL, held DATE NOT NULL, kind VARCHAR(40) NOT NULL, attendees INT NOT NULL, new_members INT NOT NULL, new_checking INT NOT NULL, new_loan_dollars DECIMAL(14,2) NOT NULL, referrals INT NOT NULL, by_name VARCHAR(80) NOT NULL, KEY ix_seg_event (held))`,
  // Notes on each group, and the sponsorships, donations and in-kind support given to it (DI's SEG record tabs).
  `CREATE TABLE seg_note (note_id INT AUTO_INCREMENT PRIMARY KEY, company_id INT NOT NULL, at DATE NOT NULL, by_name VARCHAR(80) NOT NULL, text VARCHAR(400) NOT NULL, approval_id VARCHAR(40) NULL UNIQUE, KEY ix_seg_note (company_id))`,
  `CREATE TABLE seg_sponsorship (sponsorship_id INT AUTO_INCREMENT PRIMARY KEY, company_id INT NOT NULL, given_on DATE NOT NULL, kind VARCHAR(20) NOT NULL, amount DECIMAL(12,2) NOT NULL, description VARCHAR(160) NOT NULL, approved_by VARCHAR(80) NOT NULL, approval_id VARCHAR(40) NULL UNIQUE, KEY ix_seg_spons (company_id))`,
  `CREATE TABLE seg_bd_goal (metric VARCHAR(30) PRIMARY KEY, label VARCHAR(60) NOT NULL, monthly_target DECIMAL(14,2) NOT NULL, unit VARCHAR(10) NOT NULL, sort_order INT NOT NULL)`,
];
export const SEG_DETAIL_WRITE_TABLES = ['seg_contact', 'seg_event', 'seg_note', 'seg_sponsorship'];

const FIRST = ['Karen', 'David', 'Lisa', 'Mark', 'Angela', 'Steven', 'Patricia', 'Brian', 'Michelle', 'Kevin', 'Laura', 'Jason'];
const LAST = ['Morales', 'Chen', 'Whitaker', 'Patel', 'Oconnor', 'Brooks', 'Nguyen', 'Romano', 'Fischer', 'Grant', 'Delgado', 'Hart'];
const TITLES = ['HR Director', 'Benefits Manager', 'VP of Human Resources', 'Payroll Manager', 'Office Manager', 'Chief People Officer'];
const NOTES = ['HR prefers email over calls; best reached Tuesday mornings.', 'New benefits director starts next month; reintroduce the partnership.', 'Asked about payroll deduction for savings.', 'Interested in a financial wellness series for new hires.', 'Union contract renewal in the spring; members may need bridge loans.', 'Wants co-branded welcome kits for new employees.'];
const GIFTS: [string, string, number, number][] = [['Sponsorship', 'Company picnic sponsorship', 500, 2500], ['Donation', 'Holiday food drive donation', 250, 1500], ['Sponsorship', 'Employee 5K run sponsor', 1000, 3000], ['In-kind', 'Financial literacy workshop materials', 150, 600], ['Donation', 'Scholarship fund contribution', 1000, 5000]];
const EVENTS = ['Benefits fair', 'Lunch-and-learn', 'New-hire orientation', 'Financial wellness seminar', 'Open enrollment table'];
export const BD_GOALS = [
  ['contacts', 'Calls and emails', 40, 'count', 1],
  ['meetings', 'Relationship meetings', 8, 'count', 2],
  ['events', 'Goaled events', 3, 'count', 3],
  ['new_members', 'New members', 25, 'count', 4],
  ['new_checking', 'New checking', 15, 'count', 5],
  ['new_loans', 'New loan dollars', 400000, 'currency', 6],
  ['referrals', 'Referrals', 10, 'count', 7],
];

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const DAY = 86_400_000;

export function generateSegDetail(companies: unknown[][], branches: string[]) {
  const asOf = Date.parse(`${AS_OF}T00:00:00Z`);
  const contacts: unknown[][] = [];
  const events: unknown[][] = [];
  const interactions: unknown[][] = [];
  const notes: unknown[][] = [];
  const sponsorships: unknown[][] = [];
  for (const c of companies) {
    const id = c[0] as number;
    const stage = String(c[2]);
    const owner = (c[7] as string | null) ?? 'Marcus Reed';
    const first = FIRST[Math.floor(unit(id, 1601) * FIRST.length)]!;
    const last = LAST[Math.floor(unit(id, 1602) * LAST.length)]!;
    const domain = String(c[1]).toLowerCase().replace(/[^a-z]+/g, '').slice(0, 18);
    const approved = stage === 'Board Approved';
    // Follow-ups: most approved groups have one in the next month; a few are past due.
    const due = unit(id, 1603) < 0.75 ? ymd(new Date(asOf + Math.round(-12 + unit(id, 1604) * 40) * DAY)) : null;
    contacts.push([id, `${first} ${last}`, TITLES[Math.floor(unit(id, 1605) * TITLES.length)], `555${String(1000000 + Math.floor(unit(id, 1606) * 8999999)).slice(0, 7)}`, `${first}.${last}@${domain}.example.com`.toLowerCase(), branches[Math.floor(unit(id, 1607) * branches.length)], owner, stage === 'Closed - Lost' ? 0 : 1, Math.round(80 + unit(id, 1608) * 2400), due, due ? (approved ? 'Quarterly check-in with HR' : 'Next step on the proposal') : null]);
    // Notes from the business development manager, and what the credit union has given the group.
    for (let k = 0; k < 1 + Math.floor(unit(id, 1630) * 3); k++) notes.push([id, ymd(new Date(asOf - Math.round(unit(id * 7 + k, 1631) * 300) * DAY)), owner, NOTES[Math.floor(unit(id * 7 + k, 1632) * NOTES.length)]]);
    if (approved && unit(id, 1633) < 0.55) {
      for (let k = 0; k < 1 + Math.floor(unit(id, 1634) * 3); k++) {
        const [kind, desc, lo, hi] = GIFTS[Math.floor(unit(id * 9 + k, 1635) * GIFTS.length)]!;
        sponsorships.push([id, ymd(new Date(asOf - Math.round(unit(id * 9 + k, 1636) * 330) * DAY)), kind, Math.round(lo + unit(id * 9 + k, 1637) * (hi - lo)), desc, 'Dana Lee']);
      }
    }
    if (!approved) continue;
    // Events at approved groups over the last six months, and what they brought in.
    const n = Math.floor(unit(id, 1609) * 4);
    for (let k = 0; k < n; k++) {
      const held = ymd(new Date(asOf - Math.round(5 + unit(id * 10 + k, 1610) * 175) * DAY));
      const attendees = Math.round(12 + unit(id * 10 + k, 1611) * 70);
      const members = Math.round(attendees * (0.05 + unit(id * 10 + k, 1612) * 0.15));
      events.push([id, held, EVENTS[Math.floor(unit(id * 10 + k, 1613) * EVENTS.length)], attendees, members, Math.round(members * 0.6), Math.round(members * (8000 + unit(id * 10 + k, 1614) * 22000)), Math.round(members * 0.4), owner]);
    }
    // Calls, emails and meetings over the last six months.
    const touches = Math.floor(3 + unit(id, 1615) * 10);
    for (let k = 0; k < touches; k++) {
      const at = ymd(new Date(asOf - Math.round(unit(id * 100 + k, 1616) * 180) * DAY));
      const kind = ['Phone call', 'Email', 'Email', 'Meeting'][Math.floor(unit(id * 100 + k, 1617) * 4)]!;
      interactions.push([id, at, kind, kind === 'Meeting' ? 'Relationship review with HR.' : kind === 'Email' ? 'Sent the monthly member benefits update.' : 'Checked in on upcoming events.', owner]);
    }
  }
  return { contacts, events, interactions, goals: BD_GOALS, notes, sponsorships };
}
