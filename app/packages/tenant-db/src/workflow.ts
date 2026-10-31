// Workflow store for COMs (spec 19) and the referral configuration from the Referral Builder
// Worksheet (spec 17.3). Unlike the warehouse tables, the application account may write here.
import type { TenantProfile } from './generate.ts';
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
    'referral', typeId, party, JSON.stringify(fields), notes, stage, priority, 'user:5120', 'Marcus Reed', queue, assignee, JSON.stringify({ queueId: queue, assigneeId: assignee, rule: 'seed' }), ago(days),
  ];
  return [
    lead('retention_follow_up', a, { preferred_contact: 'Phone' }, 'Attrition score 8 of 10: direct deposit stopped last month.', 'New Referral', 'High', 'q_service_westport', 4, 3),
    lead('credit_card', b, { preferred_contact: 'Email' }, 'Asked about a rewards card at the counter.', 'New Referral', 'Normal', 'q_service_westport', 4, 1),
    lead('certificate', c, { preferred_contact: 'Phone', best_time: 'Morning' }, 'Certificate matures next month.', 'Active', 'Normal', 'q_service_westport', 4, 2),
    lead('retention_follow_up', d, { preferred_contact: 'Text' }, 'Attrition score 7 of 10: balances falling.', 'New Referral', 'High', 'q_service_westport', 5, 1),
    lead('auto_loan', e, { preferred_contact: 'Phone' }, 'Wants to refinance from another lender.', 'Active', 'Normal', 'q_lending_westport', 1, 6),
  ];
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
