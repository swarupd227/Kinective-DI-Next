// Workflow store for COMs (spec 19) and the referral configuration from the Referral Builder
// Worksheet (spec 17.3). Unlike the warehouse tables, the application account may write here.
import { unit, type GeneratedTenant, type TenantProfile } from './generate.ts';
import { DECLINE_DDL } from './relationship.ts';
import { REPORT_DDL, REPORT_WRITE_TABLES } from './reports.ts';

export const WORKFLOW_DDL = [
  `CREATE TABLE mod_ref_types (
     type_id VARCHAR(40) PRIMARY KEY,
     category VARCHAR(40) NOT NULL,
     label VARCHAR(60) NOT NULL,
     description VARCHAR(200) NOT NULL,
     route_rule JSON NOT NULL,
     fields JSON NOT NULL,
     active TINYINT NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE esp_com_queues (
     queue_id VARCHAR(40) PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     branch_id INT NULL,
     member_employee_ids JSON NOT NULL,
     rr_pointer INT NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE ai_approvals (
     approval_id VARCHAR(40) PRIMARY KEY,
     operation VARCHAR(60) NOT NULL,
     payload JSON NOT NULL,
     payload_hash CHAR(71) NOT NULL,
     risk_tier VARCHAR(10) NOT NULL,
     requested_by VARCHAR(40) NOT NULL,
     run_id VARCHAR(40) NOT NULL,
     thread_id VARCHAR(40) NOT NULL,
     status VARCHAR(12) NOT NULL,
     created_at DATETIME(3) NOT NULL,
     expires_at DATETIME(3) NOT NULL,
     decided_by VARCHAR(40) NULL,
     decided_at DATETIME(3) NULL,
     channel VARCHAR(10) NULL,
     note VARCHAR(500) NULL,
     result_ref VARCHAR(40) NULL,
     KEY ix_appr_thread (thread_id, status)
   )`,
  `CREATE TABLE esp_com_items (
     com_id INT AUTO_INCREMENT PRIMARY KEY,
     definition VARCHAR(30) NOT NULL,
     type_id VARCHAR(40) NOT NULL,
     party_id INT NULL,
     prospect JSON NULL,
     fields JSON NOT NULL,
     notes VARCHAR(500) NULL,
     stage VARCHAR(30) NOT NULL,
     status VARCHAR(40) NULL,
     priority VARCHAR(10) NOT NULL,
     sender_user_id VARCHAR(40) NOT NULL,
     sender_name VARCHAR(80) NOT NULL,
     sender_employee_id INT NULL,
     closed_at DATETIME(3) NULL,
     to_queue_id VARCHAR(40) NOT NULL,
     assignee_employee_id INT NULL,
     routing JSON NOT NULL,
     created_at DATETIME(3) NOT NULL,
     run_id VARCHAR(40) NULL,
     approval_id VARCHAR(40) NULL,
     UNIQUE KEY ux_com_approval (approval_id),
     KEY ix_com_queue (to_queue_id, stage),
     KEY ix_com_sender (sender_user_id)
   ) AUTO_INCREMENT = 88214`,
  `CREATE TABLE esp_com_lines (
     line_id INT AUTO_INCREMENT PRIMARY KEY,
     com_id INT NOT NULL,
     kind VARCHAR(20) NOT NULL,
     text VARCHAR(1000) NOT NULL,
     by_user_id VARCHAR(40) NOT NULL,
     created_at DATETIME(3) NOT NULL,
     KEY ix_line_com (com_id)
   )`,
  DECLINE_DDL,
  ...REPORT_DDL,
];

export const WORKFLOW_WRITE_TABLES = ['esp_com_items', 'esp_com_lines', 'esp_com_queues', 'ai_approvals', 'mod_suggestion_decline', ...REPORT_WRITE_TABLES];

export type RouteRule =
  /** The queue mapped to the member's branch, round-robin among its members (spec 19.5 by_location). */
  | { kind: 'by_location'; queue: 'lending' | 'service'; fallbackQueue: string }
  /** One shared queue whose members claim items. */
  | { kind: 'queue'; queueId: string };

export interface FormField {
  id: string;
  label: string;
  type: 'money' | 'enum' | 'text';
  required: boolean;
  options?: string[];
  help?: string;
}

export interface ReferralType {
  typeId: string;
  category: string;
  label: string;
  description: string;
  route: RouteRule;
  fields: FormField[];
}

const contact: FormField[] = [
  { id: 'preferred_contact', label: 'Preferred contact method', type: 'enum', required: true, options: ['Phone', 'Email', 'Text', 'In branch'] },
  { id: 'best_time', label: 'Best time to contact', type: 'enum', required: false, options: ['Morning', 'Afternoon', 'Evening', 'Any time'] },
];
const amount = (label: string): FormField => ({ id: 'estimated_amount', label, type: 'money', required: false, help: 'Approximate amount the member mentioned' });

export const REFERRAL_TYPES: ReferralType[] = [
  { typeId: 'heloc', category: 'Lending', label: 'HELOC', description: 'Home equity line of credit', route: { kind: 'by_location', queue: 'lending', fallbackQueue: 'q_lending_central' }, fields: [amount('Estimated line amount'), ...contact] },
  { typeId: 'auto_loan', category: 'Lending', label: 'Auto loan', description: 'New or used vehicle loan, or refinance from another lender', route: { kind: 'by_location', queue: 'lending', fallbackQueue: 'q_lending_central' }, fields: [amount('Estimated loan amount'), ...contact] },
  { typeId: 'mortgage', category: 'Mortgage', label: 'First mortgage', description: 'Purchase or refinance of a first mortgage', route: { kind: 'queue', queueId: 'q_mortgage' }, fields: [amount('Estimated loan amount'), ...contact] },
  { typeId: 'credit_card', category: 'Cards', label: 'Credit card', description: 'New credit card or limit increase', route: { kind: 'by_location', queue: 'service', fallbackQueue: 'q_card_services' }, fields: contact },
  { typeId: 'certificate', category: 'Deposits', label: 'Certificate', description: 'New certificate or renewal conversation', route: { kind: 'by_location', queue: 'service', fallbackQueue: 'q_member_services' }, fields: [amount('Estimated deposit'), ...contact] },
  { typeId: 'retention_follow_up', category: 'Retention', label: 'Retention follow-up', description: 'A personal check-in with someone who may be about to leave', route: { kind: 'by_location', queue: 'service', fallbackQueue: 'q_member_services' }, fields: contact },
  // A staff task, not a sale: it closes as Done, and the agent never contacts the applicant (AI-AGT-181).
  { typeId: 'loan_follow_up', category: 'Task', label: 'Application follow-up', description: 'A task for the owner of a stalled loan application', route: { kind: 'by_location', queue: 'lending', fallbackQueue: 'q_lending_central' }, fields: [{ id: 'application_id', label: 'Application', type: 'text', required: true }] },
  { typeId: 'business_account', category: 'Business', label: 'Business account', description: 'Business checking, savings or lending', route: { kind: 'queue', queueId: 'q_business' }, fields: contact },
];

/**
 * Work already in the first branch's queues, so an inbox has something in it on day one. Ages run
 * back from now, so one item is always overdue. Employees 1 and 4 to 6 belong to that branch.
 */
export function referralSeed(parties: number[], now = new Date()) {
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 23).replace('T', ' ');
  const [a, b, c, d, e] = parties;
  const lead = (typeId: string, party: number | undefined, fields: object, notes: string, stage: string, priority: string, queue: string, assignee: number, days: number) => [
    'referral', typeId, party, JSON.stringify(fields), notes, stage, priority, 'user:5120', 'Marcus Reed', 6, queue, assignee, JSON.stringify({ queueId: queue, assigneeId: assignee, rule: 'seed' }), ago(days),
  ];
  return [
    lead('retention_follow_up', a, { preferred_contact: 'Phone' }, 'Attrition score 8 of 10: direct deposit stopped last month.', 'New Referral', 'High', 'q_service_westport', 4, 3),
    lead('credit_card', b, { preferred_contact: 'Email' }, 'Asked about a rewards card at the counter.', 'New Referral', 'Normal', 'q_service_westport', 4, 1),
    lead('certificate', c, { preferred_contact: 'Phone', best_time: 'Morning' }, 'Certificate matures next month.', 'Active', 'Normal', 'q_service_westport', 4, 2),
    lead('retention_follow_up', d, { preferred_contact: 'Text' }, 'Attrition score 7 of 10: balances falling.', 'New Referral', 'High', 'q_service_westport', 5, 1),
    lead('auto_loan', e, { preferred_contact: 'Phone' }, 'Wants to refinance from another lender.', 'Active', 'Normal', 'q_lending_westport', 1, 6),
  ];
}

/** The account category that fulfils each referral type, for checking that a sale was really opened. */
export const REFERRAL_PRODUCT: Record<string, string[]> = {
  heloc: ['HELOC'],
  auto_loan: ['Auto'],
  mortgage: ['Mortgage'],
  credit_card: ['Credit Card'],
  certificate: ['Certificates', 'Certificates of Deposit'],
  business_account: ['Business', 'Commercial & Industrial'],
};
/** An open referral with no activity this long expires (DI's auto-expire) [Assumption: 45 days]. */
export const REFERRAL_EXPIRE_DAYS = 45;

/**
 * A year of referral history, all closed except a few gone stale: sales tied to accounts members really
 * opened (made a few days before the account), declines, and referrals that expired. Senders are the
 * branch's MSRs and manager; lending goes to its loan officers. Drawn with unit() so nothing else moves.
 */
export function referralHistory(t: GeneratedTenant, asOf: string) {
  const end = new Date(`${asOf}T12:00:00Z`).getTime();
  const DAY = 86_400_000;
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
  const staff = (branch: number, roles: string[]) => (t.employees as [number, string, string, number][]).filter((e) => e[3] === branch && roles.includes(e[2]));
  const branchName = (b: number) => String((t.locations as unknown[][])[b - 1]?.[1] ?? '').toLowerCase();
  const partyBranch = new Map((t.parties as unknown[][]).map((p) => [p[0] as number, p[5] as number]));
  const rows: unknown[][] = [];
  const add = (typeId: string, party: number, created: number, stage: string, closed: number | null, key: number, note: string) => {
    const branch = partyBranch.get(party) ?? 1;
    const lending = ['heloc', 'auto_loan', 'mortgage', 'business_account'].includes(typeId);
    const senders = staff(branch, ['MSR', 'Branch manager']);
    const workers = staff(branch, lending ? ['Loan officer'] : ['MSR']);
    const sender = senders[Math.floor(unit(key, 1301) * senders.length)];
    const worker = workers[Math.floor(unit(key, 1302) * workers.length)];
    if (!sender) return;
    const queue = typeId === 'mortgage' ? 'q_mortgage' : typeId === 'business_account' ? 'q_business' : `q_${lending ? 'lending' : 'service'}_${branchName(branch)}`;
    rows.push(['referral', typeId, party, JSON.stringify({ preferred_contact: ['Phone', 'Email', 'Text', 'In branch'][Math.floor(unit(key, 1303) * 4)] }), note, stage, unit(key, 1304) < 0.15 ? 'High' : 'Normal', `emp:${sender[0]}`, sender[1], sender[0], queue, worker?.[0] ?? null, JSON.stringify({ queueId: queue, assigneeId: worker?.[0] ?? null, rule: 'history' }), stamp(created), closed === null ? null : stamp(closed)]);
  };
  const byType = Object.entries(REFERRAL_PRODUCT);
  // Sales: accounts opened in the last year that a referral led to; a few sold where nothing opens after.
  const accounts = [...(t.loans as unknown[][]).map((l) => [l[0], l[1], l[4], l[6]]), ...(t.deposits as unknown[][]).map((d) => [d[0], d[1], d[3], d[4]])] as [number, number, string, string][];
  let sold = 0;
  for (const [id, party, cat, open] of accounts) {
    const typeId = byType.find(([, cats]) => cats.includes(cat))?.[0];
    if (!typeId) continue;
    const at = new Date(`${open}T12:00:00Z`).getTime();
    if (at < end - 365 * DAY || at > end - 5 * DAY || unit(id, 1201) >= (typeId === 'certificate' ? 0.06 : 0.14)) continue;
    const created = at - (2 + Math.floor(unit(id, 1202) * 22)) * DAY;
    const unopened = unit(id, 1203) < 0.06;
    add(typeId, party, created, 'Sold', unopened ? created + DAY : at + Math.floor(unit(id, 1204) * 3) * DAY, id, 'Referred at the counter.');
    if (unopened) rows[rows.length - 1]![2] = (t.parties as unknown[][])[Math.floor(unit(id, 1205) * t.parties.length)]![0];
    sold++;
  }
  // Declines and expiries in proportion; a few stale ones still open outside the first branch.
  const members = (t.parties as unknown[][]).filter((p) => p[8] === 1);
  const pick = (k: number) => members[Math.floor(unit(k, 1210) * members.length)]![0] as number;
  // Only products this institution offers, so a bank without cards gets no card referrals.
  const offered = new Set(accounts.map((a) => a[2]));
  const types = ['heloc', 'auto_loan', 'credit_card', 'certificate', 'mortgage', 'retention_follow_up', 'auto_loan', 'credit_card', 'business_account'].filter((ty) => ty === 'retention_follow_up' || REFERRAL_PRODUCT[ty]!.some((cat) => offered.has(cat)));
  for (let k = 0; k < Math.round(sold * 0.9); k++) {
    const created = end - Math.floor(10 + unit(k, 1211) * 350) * DAY;
    add(types[Math.floor(unit(k, 1212) * types.length)]!, pick(k), created, 'Not Interested', created + Math.floor(3 + unit(k, 1213) * 25) * DAY, 50_000 + k, 'Member said not now.');
  }
  for (let k = 0; k < Math.round(sold * 0.25); k++) {
    const created = end - Math.floor(REFERRAL_EXPIRE_DAYS + 5 + unit(k, 1221) * 300) * DAY;
    add(types[Math.floor(unit(k, 1222) * types.length)]!, pick(70_000 + k), created, 'Expired', created + REFERRAL_EXPIRE_DAYS * DAY, 70_000 + k, 'No contact made.');
  }
  for (let k = 0; k < 8; k++) {
    const party = members.find((p, i) => i > k * 500 && p[5] !== 1)?.[0] as number;
    add(types[k % types.length]!, party, end - (50 + k * 6) * DAY, k % 2 ? 'Active' : 'New Referral', null, 90_000 + k, 'Waiting on a call back.');
  }
  return rows;
}

/** Queues per branch (lending: loan officers; service: MSRs) plus the institution-wide queues. */
export function workflowSeed(profile: TenantProfile, employees: unknown[][]) {
  const byBranch = (branch: number, role: string) => employees.filter((e) => e[3] === branch && e[2] === role).map((e) => e[0] as number);
  const queues: unknown[][] = [];
  profile.branches.forEach((b, i) => {
    queues.push([`q_lending_${b.name.toLowerCase()}`, `${b.name} Lending Queue`, i + 1, JSON.stringify(byBranch(i + 1, 'Loan officer')), 0]);
    queues.push([`q_service_${b.name.toLowerCase()}`, `${b.name} Member Services`, i + 1, JSON.stringify(byBranch(i + 1, 'MSR')), 0]);
  });
  const member = profile.institutionType === 'bank' ? 'Customer' : 'Member';
  queues.push(['q_lending_central', 'Central Lending Queue', null, '[]', 0]);
  queues.push(['q_mortgage', 'Mortgage Center', null, '[]', 0]);
  queues.push(['q_card_services', 'Card Services', null, '[]', 0]);
  queues.push(['q_member_services', `${member} Services Center`, null, '[]', 0]);
  queues.push(['q_business', 'Business Banking', null, '[]', 0]);
  const types = REFERRAL_TYPES.map((t) => [t.typeId, t.category, t.label, t.description, JSON.stringify(t.route), JSON.stringify(t.fields), 1]);
  return { queues, types };
}
