// ESP alignment, phase 7: membership applications, alerts, matching people across sources, and marketing
// touches.
// - cdm_membership_application, cdm_membership_applicant, cdm_application_status, cdm_application_history:
//   every application to join (a bank's account-opening application) over the last 24 months. Each
//   person who joined in that time has the application they joined through, opened the day they joined;
//   the rest were denied, withdrawn, abandoned online or are still in review.
// - cdm_person_match: people from other sources matched to the core's (ESP's customer deduplication):
//   applicants who are already members, under the same name or a variant of it, and applications that
//   couldn't be matched for want of a birth date.
// - cdm_alert_type, cdm_account_alert, cdm_person_alert: events on accounts and people over the last 30
//   days, each from data DI already has: a large deposit or withdrawal, an overdraft fee, a loan 30 days
//   or more late, a certificate maturing, a share closed, direct deposit stopped, a new member, a birthday.
// - cmp_touch: each campaign's sends, to the person, their account, email or street address; postcards
//   also go to addresses of people who aren't members, and some of them joined after. Every account a
//   campaign is credited with (cmp_attribution) was touched before it opened, and each campaign's first
//   sends add up to its count sent.
// Names of applicants who aren't members come from the generator's lists; their email addresses are at
// example.com.
import { AS_OF, FIRST, LAST, unit } from './generate.ts';
import { STREETS } from './espAccounts.ts';

export const ESP_ENGAGEMENT_DDL = [
  `CREATE TABLE cdm_application_status (
     status_id INT PRIMARY KEY,
     name VARCHAR(30) NOT NULL,
     approved TINYINT NOT NULL,
     booked TINYINT NOT NULL,
     denied TINYINT NOT NULL,
     finished TINYINT NOT NULL,
     withdrawn TINYINT NOT NULL,
     ordering INT NOT NULL
   )`,
  `CREATE TABLE cdm_membership_application (
     application_id INT PRIMARY KEY,
     app_number VARCHAR(12) NOT NULL,
     applied DATE NOT NULL,
     channel VARCHAR(10) NOT NULL,
     branch_id INT NOT NULL,
     employee_id INT NULL,
     products VARCHAR(80) NOT NULL,
     status_id INT NOT NULL,
     status_date DATE NOT NULL,
     approved_date DATE NULL,
     opened_date DATE NULL,
     denied_date DATE NULL,
     withdrawn_date DATE NULL,
     denial_reason VARCHAR(60) NULL,
     opening_deposit DECIMAL(12,2) NULL,
     party_id INT NULL,
     KEY ix_app_applied (applied),
     KEY ix_app_party (party_id)
   )`,
  `CREATE TABLE cdm_membership_applicant (
     applicant_id INT PRIMARY KEY,
     application_id INT NOT NULL,
     role VARCHAR(8) NOT NULL,
     first_name VARCHAR(40) NOT NULL,
     last_name VARCHAR(40) NOT NULL,
     birth_date DATE NULL,
     email VARCHAR(80) NULL,
     street VARCHAR(80) NULL,
     base_zip CHAR(5) NULL,
     monthly_income DECIMAL(10,2) NULL,
     credit_score SMALLINT NULL,
     employment_date DATE NULL,
     party_id INT NULL,
     KEY ix_applicant_app (application_id),
     KEY ix_applicant_party (party_id)
   )`,
  `CREATE TABLE cdm_application_history (
     application_id INT NOT NULL,
     status_id INT NOT NULL,
     changed DATE NOT NULL,
     PRIMARY KEY (application_id, status_id)
   )`,
  `CREATE TABLE cdm_person_match (
     match_id INT PRIMARY KEY,
     source_table VARCHAR(40) NOT NULL,
     source_id INT NOT NULL,
     party_id INT NULL,
     rule VARCHAR(60) NOT NULL,
     score DECIMAL(4,2) NULL,
     status VARCHAR(20) NOT NULL,
     detail VARCHAR(160) NOT NULL,
     KEY ix_match_party (party_id)
   )`,
  `CREATE TABLE cdm_alert_type (
     type_id INT PRIMARY KEY,
     applies_to VARCHAR(8) NOT NULL,
     code VARCHAR(20) NOT NULL,
     name VARCHAR(40) NOT NULL,
     description VARCHAR(160) NOT NULL,
     color VARCHAR(10) NOT NULL,
     include_in_totals TINYINT NOT NULL,
     enabled TINYINT NOT NULL
   )`,
  `CREATE TABLE cdm_account_alert (
     alert_id INT PRIMARY KEY,
     account_number VARCHAR(12) NOT NULL,
     type_id INT NOT NULL,
     description VARCHAR(160) NOT NULL,
     event_date DATE NOT NULL,
     KEY ix_aa_account (account_number),
     KEY ix_aa_date (event_date)
   )`,
  `CREATE TABLE cdm_person_alert (
     alert_id INT PRIMARY KEY,
     party_id INT NOT NULL,
     type_id INT NOT NULL,
     description VARCHAR(160) NOT NULL,
     event_date DATE NOT NULL,
     KEY ix_pa_party (party_id),
     KEY ix_pa_date (event_date)
   )`,
  `CREATE TABLE cmp_touch (
     touch_id INT PRIMARY KEY,
     campaign_id INT NOT NULL,
     action VARCHAR(20) NOT NULL,
     touched DATE NOT NULL,
     party_id INT NULL,
     was_member TINYINT NOT NULL,
     account_number VARCHAR(12) NULL,
     email VARCHAR(80) NULL,
     street VARCHAR(80) NULL,
     zip CHAR(5) NULL,
     KEY ix_touch_campaign (campaign_id, party_id),
     KEY ix_touch_party (party_id)
   )`,
];

export const ESP_ENGAGEMENT_COLUMNS = {
  cdm_application_status: ['status_id', 'name', 'approved', 'booked', 'denied', 'finished', 'withdrawn', 'ordering'],
  cdm_membership_application: ['application_id', 'app_number', 'applied', 'channel', 'branch_id', 'employee_id', 'products', 'status_id', 'status_date', 'approved_date', 'opened_date', 'denied_date', 'withdrawn_date', 'denial_reason', 'opening_deposit', 'party_id'],
  cdm_membership_applicant: ['applicant_id', 'application_id', 'role', 'first_name', 'last_name', 'birth_date', 'email', 'street', 'base_zip', 'monthly_income', 'credit_score', 'employment_date', 'party_id'],
  cdm_application_history: ['application_id', 'status_id', 'changed'],
  cdm_person_match: ['match_id', 'source_table', 'source_id', 'party_id', 'rule', 'score', 'status', 'detail'],
  cdm_alert_type: ['type_id', 'applies_to', 'code', 'name', 'description', 'color', 'include_in_totals', 'enabled'],
  cdm_account_alert: ['alert_id', 'account_number', 'type_id', 'description', 'event_date'],
  cdm_person_alert: ['alert_id', 'party_id', 'type_id', 'description', 'event_date'],
  cmp_touch: ['touch_id', 'campaign_id', 'action', 'touched', 'party_id', 'was_member', 'account_number', 'email', 'street', 'zip'],
} as const;

const DAY = 86_400_000;
const asOfT = Date.parse(`${AS_OF}T00:00:00Z`);
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const day = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const addDays = (d: string, n: number) => ymd(Date.parse(`${d}T00:00:00Z`) + Math.round(n) * DAY);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const long = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export const APPLICATION_STATUSES: [number, string, number, number, number, number, number][] = [
  [1, 'Started', 0, 0, 0, 0, 0],
  [2, 'Submitted', 0, 0, 0, 0, 0],
  [3, 'In review', 0, 0, 0, 0, 0],
  [4, 'Approved', 1, 0, 0, 0, 0],
  [5, 'Opened', 1, 1, 0, 1, 0],
  [6, 'Denied', 0, 0, 1, 1, 0],
  [7, 'Withdrawn', 0, 0, 0, 1, 1],
  [8, 'Abandoned', 0, 0, 0, 1, 1],
];
const ORDER: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 4, 7: 3, 8: 2 };

/** A familiar form of a first name, for applicants who are already members under the full one. */
const NICKNAMES: Record<string, string> = { Robert: 'Bob', William: 'Bill', Richard: 'Rick', James: 'Jim', Michael: 'Mike', Elizabeth: 'Liz', Katherine: 'Kate', Jennifer: 'Jen', Christopher: 'Chris', Daniel: 'Dan', Matthew: 'Matt', Joseph: 'Joe', Thomas: 'Tom', Anthony: 'Tony', Margaret: 'Peggy', Patricia: 'Pat', Samuel: 'Sam', Benjamin: 'Ben', Alexander: 'Alex', Victoria: 'Vicky' };

export interface EngagementInputs {
  institutionType: 'credit_union' | 'bank';
  parties: unknown[][];
  deposits: unknown[][];
  loans: unknown[][];
  employees: unknown[][];
  /** cdm_party_contact rows: [party, email, phone, preferred]. */
  contacts: unknown[][];
  /** cdm_party_address rows: [party, street, street2, city, state, zip]. */
  addresses: unknown[][];
  /** cdm_digital_usage rows. */
  digital: unknown[][];
  /** cdm_share_transaction rows: [txn, account, party, posted, code, amount, channel, branch]. */
  share: unknown[][];
  /** cdm_account rows, cdm_account_holding rows. */
  accounts: unknown[][];
  holdings: unknown[][];
  /** cmp_campaign rows: [id, name, channel, product, sent, ..., launched]; cmp_attribution rows: [campaign, party, kind, account, product, opened, amount]. */
  campaigns: unknown[][];
  attribution: unknown[][];
  /** cdm_membership_exit rows: [party, branch, join, close, birth, ...]. */
  exits: unknown[][];
}

export function generateApplications(x: EngagementInputs) {
  const bank = x.institutionType === 'bank';
  const from = addDays(AS_OF, -730);
  const contactOf = new Map(x.contacts.map((c) => [Number(c[0]), c]));
  const addressOf = new Map(x.addresses.map((a) => [Number(a[0]), a]));
  const staffAt = new Map<number, number[]>();
  for (const e of x.employees) if (e[2] === 'MSR' || e[2] === 'Teller' || e[2] === 'Branch manager') (staffAt.get(Number(e[3])) ?? staffAt.set(Number(e[3]), []).get(Number(e[3]))!).push(Number(e[0]));
  const branchIds = [...new Set(x.parties.map((p) => Number(p[5])))].sort((a, b) => a - b);
  const depositsAtJoin = new Map<number, string[]>();
  for (const d of x.deposits) {
    const party = Number(d[1]);
    (depositsAtJoin.get(party) ?? depositsAtJoin.set(party, []).get(party)!).push(String(d[3]));
  }
  const applications: unknown[][] = [];
  const applicants: unknown[][] = [];
  const history: unknown[][] = [];
  const matches: unknown[][] = [];
  let appId = 1;
  let applicantId = 1;
  let matchId = 1;
  const push = (a: { applied: string; channel: string; branch: number; employee: number | null; products: string; status: number; statusDate: string; approved: string | null; opened: string | null; denied: string | null; withdrawn: string | null; reason: string | null; deposit: number | null; party: number | null }) => {
    const id = appId++;
    applications.push([id, `MA${String(100000 + id)}`, a.applied, a.channel, a.branch, a.employee, a.products, a.status, a.statusDate, a.approved, a.opened, a.denied, a.withdrawn, a.reason, a.deposit, a.party]);
    // The path it took: started (online), submitted, in review, then approved and opened, or not.
    const steps: [number, string][] = [];
    if (a.channel !== 'Branch') steps.push([1, a.applied]);
    if (a.status !== 8) steps.push([2, a.applied]);
    if (a.status !== 8 && a.status !== 1 && a.status !== 2) steps.push([3, addDays(a.applied, a.channel === 'Branch' ? 0 : 1)]);
    if (a.approved) steps.push([4, a.approved]);
    if (a.opened) steps.push([5, a.opened]);
    if (a.denied) steps.push([6, a.denied]);
    if (a.withdrawn) steps.push([a.status, a.withdrawn]);
    for (const [s, d] of steps) history.push([id, s, d]);
    return id;
  };

  // Everyone who joined in the last 24 months, through the application they joined with.
  for (const p of x.parties) {
    if (Number(p[8]) !== 1) continue;
    const join = String(day(p[4]));
    if (join <= from || join > AS_OF) continue;
    const id = Number(p[0]);
    const u = (s: number) => unit(id, 6100 + s);
    const channel = u(1) < (bank ? 0.42 : 0.45) ? 'Online' : u(1) < 0.9 ? 'Branch' : 'Mobile';
    const lead = channel === 'Branch' ? 0 : Math.floor(u(2) * 9);
    const applied = addDays(join, -lead);
    const branch = Number(p[5]);
    const staff = staffAt.get(branch) ?? [];
    const employee = channel === 'Branch' && staff.length ? staff[Math.floor(u(3) * staff.length)]! : null;
    const products = [...new Set(depositsAtJoin.get(id) ?? [bank ? 'Checking' : 'Share Savings'])].slice(0, 3).join(', ');
    const approved = channel === 'Branch' ? join : addDays(applied, Math.min(lead, 1 + Math.floor(u(4) * 2)));
    const appIdNow = push({ applied, channel, branch, employee, products, status: 5, statusDate: join, approved, opened: join, denied: null, withdrawn: null, reason: null, deposit: Math.round((25 + u(5) * (u(6) < 0.2 ? 5000 : 500)) * 100) / 100, party: id });
    const c = contactOf.get(id);
    const ad = addressOf.get(id);
    applicants.push([applicantId++, appIdNow, 'Primary', p[1], p[2], day(p[3]), c?.[1] ?? null, ad?.[1] ?? null, ad?.[5] ?? null, Math.round((2400 + u(7) * 9000) / 10) * 10, 600 + Math.floor(u(8) * 220), addDays(join, -Math.floor(365 * (1 + u(9) * 12))), id]);
  }
  const booked = applications.length;

  // The ones that didn't open: denied, withdrawn, abandoned part-way online, or still in review.
  const notOpened = Math.round(booked * (bank ? 0.42 : 0.38));
  const reasons = bank ? ['ChexSystems record', 'Identity not verified', 'OFAC review not cleared'] : ['ChexSystems record', 'Identity not verified', 'Outside the field of membership'];
  const members = x.parties.filter((p) => Number(p[8]) === 1);
  for (let i = 0; i < notOpened; i++) {
    const u = (s: number) => unit(900_000 + i, 6200 + s);
    const applied = addDays(from, 1 + Math.floor(u(1) * 729));
    const channel = u(2) < 0.62 ? 'Online' : u(2) < 0.88 ? 'Branch' : 'Mobile';
    const branch = branchIds[Math.floor(u(3) * branchIds.length)]!;
    const staff = staffAt.get(branch) ?? [];
    const employee = channel === 'Branch' && staff.length ? staff[Math.floor(u(4) * staff.length)]! : null;
    const age = daysBetween(applied, AS_OF);
    let status: number;
    if (age <= 14 && u(5) < 0.5) status = u(6) < 0.6 ? 3 : 4;
    else if (channel !== 'Branch' && u(7) < 0.5) status = 8;
    else status = u(8) < 0.55 ? 6 : 7;
    const decided = addDays(applied, 1 + Math.floor(u(9) * 6));
    const id = push({
      applied,
      channel,
      branch,
      employee,
      products: u(10) < 0.7 ? (bank ? 'Checking, Savings' : 'Share Savings, Checking') : bank ? 'Checking' : 'Share Savings',
      status,
      statusDate: status === 3 ? addDays(applied, 1) : status === 4 ? decided : status === 8 ? applied : decided,
      approved: status === 4 ? decided : null,
      opened: null,
      denied: status === 6 ? decided : null,
      withdrawn: status === 7 || status === 8 ? (status === 8 ? addDays(applied, 7) : decided) : null,
      reason: status === 6 ? reasons[Math.floor(u(11) * reasons.length)]! : null,
      deposit: null,
      party: null,
    });
    // A few applicants are already members: applying again, or under a familiar form of their name.
    const already = u(12) < 0.035 ? members[Math.floor(u(13) * members.length)] : undefined;
    const missingBirth = !already && channel === 'Online' && u(14) < 0.02;
    let first: string, last: string, birth: string | null, email: string | null, street: string | null, zip: string | null, party: number | null = null;
    if (already) {
      const nick = NICKNAMES[String(already[1])];
      const useNick = !!nick && u(15) < 0.5;
      first = useNick ? nick! : String(already[1]);
      last = String(already[2]);
      birth = day(already[3]);
      const ad = addressOf.get(Number(already[0]));
      street = ad ? String(ad[1]) : null;
      zip = ad ? String(ad[5]) : null;
      email = String(contactOf.get(Number(already[0]))?.[1] ?? '') || null;
      party = Number(already[0]);
      matches.push([matchId++, 'cdm_membership_applicant', applicantId, party, useNick ? 'Familiar first name, last name, birth date, address' : 'Name, birth date and address', useNick ? 0.86 : 0.98, useNick ? 'Possible match' : 'Confirmed', `${first} ${last} applied on ${long(applied)}; already ${bank ? 'a customer' : 'a member'} as ${already[1]} ${already[2]}`]);
    } else {
      first = FIRST[Math.floor(u(16) * FIRST.length)]!;
      last = LAST[Math.floor(u(17) * LAST.length)]!;
      birth = missingBirth ? null : addDays('1950-01-01', Math.floor(u(18) * 365 * 52));
      const like = x.addresses[Math.floor(u(19) * x.addresses.length)];
      street = `${100 + Math.floor(u(20) * 9800)} ${STREETS[Math.floor(u(21) * STREETS.length)]} ${['St', 'Ave', 'Rd', 'Ln', 'Dr'][Math.floor(u(22) * 5)]}`;
      zip = like ? String(like[5]) : null;
      email = `${first}.${last}${900_000 + i}@example.com`.toLowerCase().replace(/[^a-z0-9.@]/g, '');
      if (missingBirth) matches.push([matchId++, 'cdm_membership_applicant', applicantId, null, 'Name, birth date and address', null, 'Could not match', `${first} ${last}’s application has no birth date`]);
    }
    applicants.push([applicantId++, id, 'Primary', first, last, birth, email, street, zip, Math.round((1800 + u(23) * 8000) / 10) * 10, status === 6 ? 520 + Math.floor(u(24) * 90) : 590 + Math.floor(u(24) * 230), null, party]);
  }
  return { statuses: APPLICATION_STATUSES.map((s) => [...s, ORDER[s[0]]!]), applications, applicants, history, matches, booked };
}

export const ALERT_TYPES: [number, string, string, string, string, string][] = [
  [1, 'account', 'LARGE_DEPOSIT', 'Large deposit', 'A single deposit of $10,000 or more.', 'green'],
  [2, 'account', 'LARGE_WITHDRAWAL', 'Large withdrawal', 'A single withdrawal or payment out of $10,000 or more.', 'amber'],
  [3, 'account', 'OVERDRAFT', 'Overdraft fee', 'An overdraft fee was charged.', 'red'],
  [4, 'account', 'LOAN_LATE', 'Loan past due', 'A loan 30 days or more past due.', 'red'],
  [5, 'account', 'CERT_MATURING', 'Certificate maturing', 'A certificate matures in the next 30 days.', 'blue'],
  [6, 'person', 'SHARE_CLOSED', 'Account closed', 'A share or deposit account closed in the last 30 days.', 'amber'],
  [7, 'person', 'DD_STOPPED', 'Direct deposit stopped', 'Direct deposit stopped in the last 30 days.', 'red'],
  [8, 'person', 'NEW_MEMBER', 'New', 'Joined in the last 30 days.', 'green'],
  [9, 'person', 'BIRTHDAY', 'Birthday', 'A birthday in the next 14 days.', 'blue'],
];

/** Events on accounts and people over the last 30 days, each from data already loaded. */
export function generateAlerts(x: EngagementInputs) {
  const bank = x.institutionType === 'bank';
  const accountOf = new Map(x.holdings.map((h) => [`${h[0]}|${h[1]}`, String(h[2])]));
  const since = addDays(AS_OF, -30);
  const accountAlerts: unknown[][] = [];
  const personAlerts: unknown[][] = [];
  let a = 1;
  let p = 1;
  const depBy = new Map(x.deposits.map((d) => [Number(d[0]), d]));
  const sfx = (id: number) => String(id % 10_000).padStart(4, '0');
  for (const t of x.share) {
    const amount = Number(t[5]);
    const posted = String(day(t[3]));
    const code = String(t[4]);
    const acct = accountOf.get(`deposit|${t[1]}`);
    if (!acct || posted < since) continue;
    const d = depBy.get(Number(t[1]));
    const where = `${d ? String(d[3]) : 'Share'} (…${sfx(Number(t[1]))})`;
    if (code === 'FEE-OD') accountAlerts.push([a++, acct, 3, `Overdraft fee of ${money(Math.abs(amount))} on ${where}`, posted]);
    else if (amount >= 10_000 && !code.startsWith('FEE') && code !== 'DIV') accountAlerts.push([a++, acct, 1, `Deposit of ${money(amount)} to ${where}`, posted]);
    else if (amount <= -10_000) accountAlerts.push([a++, acct, 2, `${money(-amount)} out of ${where}`, posted]);
  }
  for (const l of x.loans) {
    if (l[7] || l[8] || Number(l[10]) <= 0 || Number(l[12]) < 30) continue;
    const acct = accountOf.get(`loan|${l[0]}`);
    if (acct) accountAlerts.push([a++, acct, 4, `${String(l[4])} loan (…${sfx(Number(l[0]))}) ${Number(l[12])} days past due`, addDays(AS_OF, -(Number(l[12]) - 30))]);
  }
  const in30 = addDays(AS_OF, 30);
  for (const d of x.deposits) {
    const maturity = day(d[6]);
    if (d[5] || !maturity || maturity < AS_OF || maturity > in30) continue;
    const acct = accountOf.get(`deposit|${d[0]}`);
    if (acct) accountAlerts.push([a++, acct, 5, `${String(d[3])} (…${sfx(Number(d[0]))}) of ${money(Number(d[7]))} matures ${long(maturity)}`, AS_OF]);
  }
  for (const d of x.deposits) {
    const closed = day(d[5]);
    if (closed && closed > since && closed <= AS_OF) personAlerts.push([p++, Number(d[1]), 6, `${String(d[3])} (…${sfx(Number(d[0]))}) closed ${long(closed)}`, closed]);
  }
  for (const g of x.digital) {
    const changed = day(g[7]);
    if (g[6] === 'stopped' && changed && changed > since && changed <= AS_OF) personAlerts.push([p++, Number(g[0]), 7, `Direct deposit stopped ${long(changed)}`, changed]);
  }
  const asOf = new Date(asOfT);
  for (const q of x.parties) {
    if (Number(q[8]) !== 1) continue;
    const join = String(day(q[4]));
    if (join > since && join <= AS_OF) personAlerts.push([p++, Number(q[0]), 8, `${bank ? 'Became a customer' : 'Joined'} ${long(join)}`, join]);
    const birth = String(day(q[3]));
    const next = new Date(Date.UTC(asOf.getUTCFullYear(), Number(birth.slice(5, 7)) - 1, Number(birth.slice(8, 10))));
    if (next.getTime() < asOfT) next.setUTCFullYear(next.getUTCFullYear() + 1);
    const ahead = (next.getTime() - asOfT) / DAY;
    if (ahead >= 0 && ahead <= 14) personAlerts.push([p++, Number(q[0]), 9, `Turns ${next.getUTCFullYear() - Number(birth.slice(0, 4))} on ${long(ymd(next.getTime()))}`, AS_OF]);
  }
  return { types: ALERT_TYPES.map((t) => [...t, 1, 1]), accountAlerts, personAlerts };
}

/**
 * Each campaign's sends. Members first, by a draw each campaign makes; postcards also go to the addresses
 * of people who aren't members (a quarter of them). Everyone a campaign is credited with was sent it.
 * Email campaigns send a reminder to the half who didn't open the first. Returns the rows a batch at a time.
 */
export function* generateTouches(x: EngagementInputs, batch = 50_000): Generator<unknown[][]> {
  const contactOf = new Map(x.contacts.map((c) => [Number(c[0]), c]));
  const addressOf = new Map(x.addresses.map((a) => [Number(a[0]), a]));
  const primaryAccount = new Map<number, string>();
  for (const a of x.accounts) if (!a[6] && !primaryAccount.has(Number(a[1]))) primaryAccount.set(Number(a[1]), String(a[0]));
  const exitDate = new Map(x.exits.map((e) => [Number(e[0]), String(day(e[3]))]));
  const credited = new Map<number, Map<number, string>>();
  for (const r of x.attribution) {
    const c = Number(r[0]);
    const m = credited.get(c) ?? credited.set(c, new Map()).get(c)!;
    const opened = String(day(r[5]));
    const prev = m.get(Number(r[1]));
    if (!prev || opened < prev) m.set(Number(r[1]), opened);
  }
  const people = x.parties.filter((p) => Number(p[8]) === 1).map((p) => ({ id: Number(p[0]), join: String(day(p[4])) }));
  // People who joined after a postcard reached their address while they weren't members.
  const joiners = people.filter((p) => p.join > addDays(AS_OF, -760));
  let rows: unknown[][] = [];
  let id = 1;
  const emit = (r: unknown[]) => {
    rows.push([id++, ...r]);
  };
  for (const c of x.campaigns) {
    const campaign = Number(c[0]);
    const channel = String(c[2]);
    const sent = Number(c[4]);
    const launched = String(day(c[11]) ?? AS_OF);
    if (launched > AS_OF) continue;
    const forced = credited.get(campaign) ?? new Map<number, string>();
    const postcard = channel === 'Postcard';
    const eligible = people.filter((p) => p.join <= launched && !forced.has(p.id) && !(exitDate.has(p.id) && exitDate.get(p.id)! <= launched)).sort((a, b) => unit(a.id, 7000 + campaign) - unit(b.id, 7000 + campaign));
    // A list bigger than the people already with us went to prospects too: their addresses or emails.
    const nonMembers = Math.max(postcard ? Math.round(sent * 0.25) : 0, sent - forced.size - eligible.length);
    const chosen = [...forced.keys(), ...eligible.slice(0, Math.max(0, sent - nonMembers - forced.size)).map((p) => p.id)];
    const action = channel === 'Email' ? 'Email' : channel === 'Postcard' ? 'Postcard' : channel === 'Branch' ? 'Branch event' : 'Digital ad';
    for (const party of chosen) {
      // Sent before the account it's credited with opened.
      const opened = forced.get(party);
      const touched = opened && opened < launched ? opened : launched;
      const ad = addressOf.get(party);
      emit([campaign, action, touched, party, 1, primaryAccount.get(party) ?? null, channel === 'Email' || channel === 'Digital' ? (contactOf.get(party)?.[1] ?? null) : null, postcard ? (ad?.[1] ?? null) : null, postcard ? (ad?.[5] ?? null) : null]);
      if (channel === 'Email' && unit(party, 7100 + campaign) < 0.5) emit([campaign, 'Reminder', addDays(launched, 7), party, 1, primaryAccount.get(party) ?? null, contactOf.get(party)?.[1] ?? null, null, null]);
      if (rows.length >= batch) {
        yield rows;
        rows = [];
      }
    }
    // Addresses of people who weren't members; some joined within 90 days, and their touch is theirs now.
    for (let i = 0; i < nonMembers; i++) {
      const joiner = joiners[Math.floor(unit(campaign * 100_000 + i, 7200) * joiners.length)];
      const joined = joiner && joiner.join > launched && daysBetween(launched, joiner.join) <= 90 && unit(campaign * 100_000 + i, 7201) < 0.6 ? joiner : undefined;
      const ad = joined ? addressOf.get(joined.id) : undefined;
      const like = x.addresses[Math.floor(unit(campaign * 100_000 + i, 7202) * x.addresses.length)];
      const street = ad ? String(ad[1]) : `${100 + Math.floor(unit(campaign * 100_000 + i, 7203) * 9800)} ${STREETS[Math.floor(unit(campaign * 100_000 + i, 7204) * STREETS.length)]} ${['St', 'Ave', 'Rd', 'Ln', 'Dr'][Math.floor(unit(campaign * 100_000 + i, 7205) * 5)]}`;
      // Postcards go to the address; emails and ads to a prospect's email, at example.com.
      if (postcard) emit([campaign, action, launched, joined ? joined.id : null, 0, null, null, street, ad ? String(ad[5]) : like ? String(like[5]) : null]);
      else emit([campaign, action, launched, joined ? joined.id : null, 0, null, joined ? (contactOf.get(joined.id)?.[1] ?? null) : `prospect${campaign}.${i + 1}@example.com`, null, null]);
      if (rows.length >= batch) {
        yield rows;
        rows = [];
      }
    }
  }
  if (rows.length) yield rows;
}
