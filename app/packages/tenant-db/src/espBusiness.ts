// ESP alignment, phase 8 (business relationships, ESP's brm): the businesses DI deals with, their
// locations, contacts and who receives their statements and invoices.
// - brm_business: every SEG (the employer groups in seg_company), every prospect company (prs_prospect),
//   the institution's vendors, and each business member's business (people in the small business and
//   commercial segments). Each links back to the record it comes from. For a SEG, how many of its people
//   bank with us comes from the employers on file (cdm_party_profile).
// - brm_status, brm_channel, brm_dd_account_type, brm_vendor_specialty, brm_business_specialty: the lists
//   they draw on.
// - brm_location, brm_contact: where each business is and who DI talks to there. SEG contacts are the
//   ones in seg_contact; the rest are made up, at example.com and on 555 numbers.
// - brm_recipient: who receives each business's statements and invoices, and how; and the staff who
//   receive invoices internally.
// - brm_direct_deposit: how a SEG's payroll reaches us: the originating bank, account type and the last
//   four digits only.
import { FIRST, LAST, unit } from './generate.ts';
import { STREETS } from './espAccounts.ts';

export const ESP_BUSINESS_DDL = [
  `CREATE TABLE brm_status (status_id INT PRIMARY KEY, name VARCHAR(30) NOT NULL, active TINYINT NOT NULL)`,
  `CREATE TABLE brm_channel (channel_id INT PRIMARY KEY, name VARCHAR(30) NOT NULL, communication TINYINT NOT NULL, print TINYINT NOT NULL, active TINYINT NOT NULL)`,
  `CREATE TABLE brm_dd_account_type (type_id INT PRIMARY KEY, name VARCHAR(20) NOT NULL)`,
  `CREATE TABLE brm_vendor_specialty (specialty_id INT PRIMARY KEY, name VARCHAR(40) NOT NULL, active TINYINT NOT NULL)`,
  `CREATE TABLE brm_business (
     business_id INT PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     short_name VARCHAR(30) NOT NULL,
     kind VARCHAR(16) NOT NULL,
     status_id INT NOT NULL,
     parent_id INT NULL,
     seg_company_id INT NULL,
     prospect_id INT NULL,
     party_id INT NULL,
     seg_group_number VARCHAR(10) NULL,
     assigned_branch_id INT NULL,
     assigned_bdo VARCHAR(80) NULL,
     website VARCHAR(80) NULL,
     date_established DATE NULL,
     date_added DATE NOT NULL,
     total_employees INT NULL,
     employees_with_us INT NULL,
     employees_direct_deposit INT NULL,
     KEY ix_brm_kind (kind),
     KEY ix_brm_party (party_id)
   )`,
  `CREATE TABLE brm_business_specialty (business_id INT NOT NULL, specialty_id INT NOT NULL, PRIMARY KEY (business_id, specialty_id))`,
  `CREATE TABLE brm_location (
     location_id INT PRIMARY KEY,
     business_id INT NOT NULL,
     name VARCHAR(80) NOT NULL,
     street VARCHAR(80) NOT NULL,
     city VARCHAR(40) NOT NULL,
     state CHAR(2) NOT NULL,
     zip CHAR(5) NOT NULL,
     is_physical TINYINT NOT NULL,
     is_mailing TINYINT NOT NULL,
     can_bill TINYINT NOT NULL,
     KEY ix_loc_business (business_id)
   )`,
  `CREATE TABLE brm_contact (
     contact_id INT PRIMARY KEY,
     business_id INT NOT NULL,
     location_id INT NULL,
     first_name VARCHAR(40) NOT NULL,
     last_name VARCHAR(40) NOT NULL,
     title VARCHAR(80) NULL,
     email VARCHAR(120) NULL,
     phone VARCHAR(20) NULL,
     preferred_method VARCHAR(10) NOT NULL,
     is_primary TINYINT NOT NULL,
     party_id INT NULL,
     KEY ix_contact_business (business_id)
   )`,
  `CREATE TABLE brm_recipient (
     recipient_id INT PRIMARY KEY,
     business_id INT NOT NULL,
     location_id INT NULL,
     kind VARCHAR(20) NOT NULL,
     contact_id INT NULL,
     employee_id INT NULL,
     channel_id INT NOT NULL,
     KEY ix_recipient_business (business_id)
   )`,
  `CREATE TABLE brm_direct_deposit (
     business_id INT PRIMARY KEY,
     originating_bank VARCHAR(60) NOT NULL,
     account_type_id INT NOT NULL,
     account_last4 CHAR(4) NOT NULL,
     remittance_email VARCHAR(120) NOT NULL,
     is_default TINYINT NOT NULL,
     modified DATE NOT NULL
   )`,
];

export const ESP_BUSINESS_COLUMNS = {
  brm_status: ['status_id', 'name', 'active'],
  brm_channel: ['channel_id', 'name', 'communication', 'print', 'active'],
  brm_dd_account_type: ['type_id', 'name'],
  brm_vendor_specialty: ['specialty_id', 'name', 'active'],
  brm_business: ['business_id', 'name', 'short_name', 'kind', 'status_id', 'parent_id', 'seg_company_id', 'prospect_id', 'party_id', 'seg_group_number', 'assigned_branch_id', 'assigned_bdo', 'website', 'date_established', 'date_added', 'total_employees', 'employees_with_us', 'employees_direct_deposit'],
  brm_business_specialty: ['business_id', 'specialty_id'],
  brm_location: ['location_id', 'business_id', 'name', 'street', 'city', 'state', 'zip', 'is_physical', 'is_mailing', 'can_bill'],
  brm_contact: ['contact_id', 'business_id', 'location_id', 'first_name', 'last_name', 'title', 'email', 'phone', 'preferred_method', 'is_primary', 'party_id'],
  brm_recipient: ['recipient_id', 'business_id', 'location_id', 'kind', 'contact_id', 'employee_id', 'channel_id'],
  brm_direct_deposit: ['business_id', 'originating_bank', 'account_type_id', 'account_last4', 'remittance_email', 'is_default', 'modified'],
} as const;

const STATUSES = [[1, 'Active', 1], [2, 'Prospect', 1], [3, 'Inactive', 0], [4, 'Closed', 0]];
const CHANNELS = [[1, 'Email', 1, 0, 1], [2, 'Mail', 0, 1, 1], [3, 'Fax', 1, 1, 0], [4, 'Online portal', 1, 0, 1]];
const SPECIALTIES = ['Payroll processing', 'Card processing', 'Core processing', 'Collections', 'Printing and mail', 'Indirect lending platform', 'Insurance', 'Appraisal'];
const VENDORS: [string, number][] = [['Cascade Payroll Services', 0], ['Summit Card Processing', 1], ['Northline Core Systems', 2], ['Evergreen Recovery Group', 3], ['Pioneer Print and Mail', 4], ['RoadReady Lending Network', 5], ['Harborline Insurance Agency', 6], ['Ridgeview Appraisal Co.', 7]];
const TRADES = ['Plumbing', 'Dental', 'Auto Repair', 'Bakery', 'Landscaping', 'Construction', 'Consulting', 'Salon', 'Electric', 'Roofing', 'Cafe', 'Accounting', 'Veterinary Clinic', 'Fitness', 'Florist', 'Hardware', 'Insurance Agency', 'Physical Therapy', 'Printing', 'Realty'];
const BANKS = ['First Cascade Bank', 'Pacific Commerce Bank', 'Evergreen National Bank'];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const phone = (n: number) => `555${String((n * 7919) % 10_000_000).padStart(7, '0')}`;

export interface BusinessInputs {
  institutionType: 'credit_union' | 'bank';
  /** cdm_party rows, cdm_party_address rows: [party, street, street2, city, state, zip]. */
  parties: unknown[][];
  addresses: unknown[][];
  /** cdm_employee rows: [employee, name, role, branch]. */
  employees: unknown[][];
  /** seg_company rows: [id, name, stage, members, ...]; seg_contact rows: [company, name, title, phone, email, branch, bd_manager, active, employees, ...]. */
  segCompanies: unknown[][];
  segContacts: unknown[][];
  /** prs_prospect rows: [id, company, contact, city, branch, lat, lng, assets, grade, stage, disposition, owner, ...]. */
  prospects: unknown[][];
  /** cdm_location rows: [id, name, ...]. */
  locations: unknown[][];
  /** Employers on file: [party, employer]; and who has direct deposit: party ids. */
  employers: unknown[][];
  directDeposit: Set<number>;
}

export function generateBusinesses(x: BusinessInputs) {
  const businesses: unknown[][] = [];
  const specialties: unknown[][] = [];
  const locations: unknown[][] = [];
  const contacts: unknown[][] = [];
  const recipients: unknown[][] = [];
  const deposits: unknown[][] = [];
  let bId = 1;
  let lId = 1;
  let cId = 1;
  let rId = 1;
  const branchByName = new Map(x.locations.map((l) => [String(l[1]), Number(l[0])]));
  const branchIds = x.locations.map((l) => Number(l[0]));
  const state = String(x.addresses[0]?.[4] ?? 'OR');
  const towns = [...new Map(x.addresses.map((a) => [String(a[5]), [String(a[3]), String(a[5])]])).values()];
  const town = (n: number) => towns[Math.floor(unit(n, 9100) * towns.length)]!;
  const street = (n: number) => `${100 + Math.floor(unit(n, 9101) * 9800)} ${STREETS[Math.floor(unit(n, 9102) * STREETS.length)]} ${['St', 'Ave', 'Blvd', 'Way', 'Rd'][Math.floor(unit(n, 9103) * 5)]}`;
  const finance = x.employees.filter((e) => /manager|finance|accounting|operations/i.test(String(e[2])));
  const employeesOf = new Map<string, number[]>();
  for (const [party, employer] of x.employers as [number, string][]) if (employer) (employeesOf.get(employer) ?? employeesOf.set(employer, []).get(employer)!).push(Number(party));
  // A location and a mailing address, and who gets the statements: email for most, mail for some.
  const place = (business: number, name: string, n: number, count = 1) => {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const [city, zip] = town(n * 7 + i);
      locations.push([lId, business, i === 0 ? name : `${name}, ${city}`, street(n * 7 + i), city, state, zip, 1, i === 0 ? 1 : 0, i === 0 ? 1 : 0]);
      ids.push(lId++);
    }
    return ids;
  };
  const person = (business: number, location: number | null, n: number, title: string, primary: boolean, domain: string) => {
    const first = FIRST[Math.floor(unit(n, 9110) * FIRST.length)]!;
    const last = LAST[Math.floor(unit(n, 9111) * LAST.length)]!;
    contacts.push([cId, business, location, first, last, title, `${first}.${last}@${domain}.example.com`.toLowerCase(), phone(n), unit(n, 9112) < 0.7 ? 'Email' : 'Phone', primary ? 1 : 0, null]);
    return cId++;
  };
  const recipient = (business: number, location: number | null, kind: string, contact: number | null, n: number) => recipients.push([rId++, business, location, kind, contact, null, unit(n, 9120) < 0.72 ? 1 : unit(n, 9120) < 0.95 ? 2 : 4]);

  // SEGs: the employer groups, with their contacts, payroll and statement recipients.
  for (const s of x.segCompanies) {
    const id = bId++;
    const name = String(s[1]);
    const stage = String(s[2]);
    const active = Number(s[3]) > 0;
    const contactRow = x.segContacts.find((c) => Number(c[0]) === Number(s[0]));
    const people = employeesOf.get(name) ?? [];
    const withDd = people.filter((p) => x.directDeposit.has(p)).length;
    const total = contactRow ? Number(contactRow[8]) : null;
    businesses.push([id, name, name.split(' ')[0]!.slice(0, 30), 'SEG', active ? 1 : 2, null, Number(s[0]), null, null, active ? `SEG${String(100 + Number(s[0]))}` : null, contactRow ? (branchByName.get(String(contactRow[5])) ?? null) : null, contactRow ? String(contactRow[6]) : (s[7] as string | null), `www.${slug(name)}.example.com`, `${1950 + Math.floor(unit(id, 9130) * 65)}-0${1 + Math.floor(unit(id, 9131) * 9)}-15`, '2019-01-15', total !== null ? Math.max(total, people.length) : people.length || null, people.length, withDd]);
    const locs = place(id, name, 1000 + id, Number(s[3]) > 500 ? 2 : 1);
    let primary: number | null = null;
    if (contactRow) {
      const [first, ...rest] = String(contactRow[1]).split(' ');
      contacts.push([cId, id, locs[0], first, rest.join(' ') || first, contactRow[2], contactRow[4], contactRow[3], 'Email', 1, null]);
      primary = cId++;
    } else primary = person(id, locs[0]!, 1000 + id, 'HR manager', true, slug(name));
    const payroll = person(id, locs[0]!, 2000 + id, 'Payroll manager', false, slug(name));
    recipient(id, locs[0]!, 'Statement', primary, id);
    recipient(id, locs[0]!, 'Invoice', payroll, id + 1);
    if (active) deposits.push([id, BANKS[Math.floor(unit(id, 9140) * BANKS.length)]!, unit(id, 9141) < 0.85 ? 1 : 2, String(1000 + Math.floor(unit(id, 9142) * 9000)), `payroll@${slug(name)}.example.com`, 1, '2026-06-30']);
  }
  // Prospects: companies the business development team is working, not yet SEGs.
  for (const p of x.prospects) {
    const id = bId++;
    const name = String(p[1]);
    businesses.push([id, name, name.split(' ')[0]!.slice(0, 30), 'Prospect', 2, null, null, Number(p[0]), null, null, branchByName.get(String(p[4])) ?? null, p[11] as string, `www.${slug(name)}.example.com`, null, '2026-01-15', 20 + Math.floor(unit(id, 9150) * 400), (employeesOf.get(name) ?? []).length, null]);
    const locs = place(id, name, 3000 + id);
    const [first, ...rest] = String(p[2]).split(' ');
    contacts.push([cId++, id, locs[0], first, rest.join(' ') || first, 'Owner', `${slug(String(p[2]))}@${slug(name)}.example.com`, phone(3000 + id), 'Phone', 1, null]);
  }
  // Vendors, with what they do and who in finance receives their invoices.
  for (const [name, spec] of VENDORS) {
    const id = bId++;
    businesses.push([id, name, name.split(' ')[0]!, 'Vendor', 1, null, null, null, null, null, null, null, `www.${slug(name)}.example.com`, null, '2018-03-01', null, null, null]);
    specialties.push([id, spec + 1]);
    const locs = place(id, name, 4000 + id);
    const c = person(id, locs[0]!, 4000 + id, 'Account manager', true, slug(name));
    recipient(id, locs[0]!, 'Statement', c, 4000 + id);
    const staff = finance[Math.floor(unit(id, 9160) * Math.max(1, finance.length))];
    if (staff) recipients.push([rId++, id, locs[0], 'Internal invoice', null, Number(staff[0]), 1]);
  }
  // Business members: each small business and commercial client's business, with the owner as its contact.
  const addressOf = new Map(x.addresses.map((a) => [Number(a[0]), a]));
  for (const p of x.parties) {
    if (!/business|commercial/i.test(String(p[6]))) continue;
    const id = bId++;
    const party = Number(p[0]);
    const trade = TRADES[Math.floor(unit(party, 9170) * TRADES.length)]!;
    const name = `${String(p[2])} ${trade}`;
    const ad = addressOf.get(party);
    businesses.push([id, name, String(p[2]).slice(0, 30), 'Business member', 1, null, null, null, party, null, Number(p[5]) || (branchIds[0] ?? null), null, null, `${1975 + Math.floor(unit(party, 9171) * 50)}-0${1 + Math.floor(unit(party, 9172) * 9)}-01`, String(p[4]).slice(0, 10), 1 + Math.floor(unit(party, 9173) * (/commercial/i.test(String(p[6])) ? 120 : 12)), null, null]);
    const [city, zip] = ad ? [String(ad[3]), String(ad[5])] : town(party);
    locations.push([lId, id, name, street(party + 7), city, state, zip, 1, 1, 1]);
    contacts.push([cId, id, lId, p[1], p[2], 'Owner', null, null, 'Phone', 1, party]);
    recipients.push([rId++, id, lId, 'Statement', cId, null, unit(party, 9174) < 0.6 ? 1 : 2]);
    lId++;
    cId++;
  }
  return {
    statuses: STATUSES,
    channels: CHANNELS,
    ddTypes: [[1, 'Checking'], [2, 'Savings']],
    vendorSpecialties: SPECIALTIES.map((n, i) => [i + 1, n, 1]),
    businesses,
    specialties,
    locations,
    contacts,
    recipients,
    deposits,
  };
}
