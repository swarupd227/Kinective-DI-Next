// Workflow definitions for the Workflow Builder (spec 8.16, 24.7): name, folder, persistent and
// non-persistent fields, stages and routing. Drafts sit beside the live definition until published.
// The four seeded definitions describe the workflows the app already runs.
import { REFERRAL_TYPES } from './workflow.ts';

export const WORKFLOW_DEF_DDL = [
  `CREATE TABLE wf_definition (
     def_id INT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(80) NOT NULL,
     folder VARCHAR(60) NOT NULL,
     status VARCHAR(10) NOT NULL,
     version INT NOT NULL,
     base_id INT NULL,
     spec JSON NOT NULL,
     icon VARCHAR(80) NOT NULL,
     updated_by VARCHAR(80) NOT NULL,
     updated_at DATE NOT NULL,
     approval_id VARCHAR(40) NULL UNIQUE,
     KEY ix_wf_name (name, status)
   )`,
  // The Referral Builder Worksheet for each referral type: what mod_ref_types doesn't hold.
  `CREATE TABLE mod_ref_worksheet (
     type_id VARCHAR(40) PRIMARY KEY,
     products JSON NOT NULL,
     creators JSON NOT NULL,
     success VARCHAR(200) NOT NULL,
     unsuccessful VARCHAR(200) NOT NULL,
     credit VARCHAR(16) NOT NULL,
     credit_rule VARCHAR(200) NOT NULL,
     fallback VARCHAR(200) NOT NULL,
     notes JSON NOT NULL,
     updated_by VARCHAR(80) NOT NULL,
     updated_at DATE NOT NULL,
     approval_id VARCHAR(40) NULL UNIQUE
   )`,
];

export const WORKFLOW_DEF_WRITE_TABLES = ['wf_definition', 'mod_ref_worksheet', 'mod_ref_types'];

export interface WfField {
  id: string;
  label: string;
  type: 'text' | 'enum' | 'money' | 'date' | 'person' | 'file';
}

/** How the form is laid out: tabs of sections, each with its fields in order (spec 8.22 form layout). */
export interface WfLayout {
  tabs: { title: string; sections: { title: string; columns: 1 | 2; fields: string[] }[] }[];
  /** Help text under a field, by field id. */
  help: Record<string, string>;
}

export interface WfSpec {
  persistent: WfField[];
  nonPersistent: WfField[];
  stages: string[];
  route: { queue: string; byLocation: boolean; escalateDays: number | null; fallback: string | null };
  notify: string;
  /** Set once someone changes the layout; until then the form shows its fields in one Details tab. */
  layout?: WfLayout;
}

/** One referral type's worksheet (Referral Builder Worksheet sections 1, 2, 5 and 6). */
export interface Worksheet {
  products: string[];
  creators: string[];
  success: string;
  unsuccessful: string;
  credit: 'Yes' | 'No' | 'Not sure yet';
  creditRule: string;
  fallback: string;
  notes: { topic: string; answer: string; owner: string }[];
}

const SALE = { success: 'The product is opened or funded', unsuccessful: 'The member says no, or nothing is opened within 30 days' };
export const worksheetFor = (typeId: string): Worksheet => {
  const creators = ['Tellers', 'Member Service Reps', 'Branch Managers', 'Call Center', 'Loan Officers'];
  const by: Record<string, Partial<Worksheet>> = {
    heloc: { products: ['Mortgage / HELOC'], credit: 'Yes', creditRule: 'The referrer earns credit when the line is booked', fallback: 'Lending central queue' },
    auto_loan: { products: ['Auto loan'], credit: 'Yes', creditRule: 'The referrer earns credit when the loan is booked', fallback: 'Lending central queue' },
    mortgage: { products: ['Mortgage / HELOC'], credit: 'Yes', creditRule: 'The referrer earns credit when the application is submitted', fallback: 'Mortgage team lead' },
    credit_card: { products: ['Credit card'], credit: 'Yes', creditRule: 'The referrer earns credit when the card is booked', fallback: 'Card services queue' },
    certificate: { products: ['Savings account'], credit: 'Not sure yet', creditRule: '', fallback: 'Member services queue' },
    retention_follow_up: { products: ['Other: retention check-in'], creators: ['Branch Managers', 'Member Service Reps'], credit: 'No', creditRule: '', success: 'The member keeps their deposits', unsuccessful: 'The member moves their deposits', fallback: 'Member services queue' },
    loan_follow_up: { products: ['Other: loan application follow-up'], creators: ['Loan Officers', 'Branch Managers'], credit: 'No', creditRule: '', success: 'The application moves forward', unsuccessful: 'The application is withdrawn', fallback: 'Lending central queue' },
    business_account: { products: ['Business services'], credit: 'Yes', creditRule: 'The referrer earns credit when the account is opened', fallback: 'Business banking lead' },
  };
  return { products: ['Other'], creators, ...SALE, credit: 'Not sure yet', creditRule: '', fallback: '', notes: [], ...by[typeId] };
};

const f = (label: string, type: WfField['type'] = 'text'): WfField => ({ id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), label, type });

export const SEED_DEFINITIONS: { name: string; folder: string; icon: string; spec: WfSpec }[] = [
  { name: 'Referral', folder: 'Sales', icon: 'icons/referral.svg', spec: { persistent: [f('Referral type', 'enum'), f('Member', 'person'), f('Preferred contact method', 'enum'), f('Best time to contact', 'enum'), f('Estimated amount', 'money')], nonPersistent: [f('Notes')], stages: ['New Referral', 'Active', 'Sold', 'Not Interested', 'Done'], route: { queue: 'Branch lending or member services queue', byLocation: true, escalateDays: 2, fallback: 'Marcus Reed' }, notify: 'Assignee, and the sender when it closes' } },
  { name: 'Task', folder: 'General', icon: 'icons/task.svg', spec: { persistent: [f('Summary'), f('Description'), f('Due date', 'date'), f('Owner', 'person')], nonPersistent: [f('Notes'), f('Public notes')], stages: ['Open', 'Done'], route: { queue: 'The named owner', byLocation: false, escalateDays: null, fallback: null }, notify: 'Owner' } },
  { name: 'Compliance issue', folder: 'Compliance', icon: 'icons/issue.svg', spec: { persistent: [f('Category', 'enum'), f('Source', 'enum'), f('Member', 'person'), f('Resolve by', 'date')], nonPersistent: [f('Resolution'), f('Root cause', 'enum')], stages: ['New', 'In progress', 'Escalated', 'Closed'], route: { queue: 'Compliance', byLocation: false, escalateDays: 5, fallback: 'Dana Lee' }, notify: 'Owner, and the compliance officer on escalation' } },
  { name: 'Data log', folder: 'Operations', icon: 'icons/datalog.svg', spec: { persistent: [f('Log type', 'enum'), f('Title'), f('Amount', 'money'), f('Branch', 'enum')], nonPersistent: [f('Return note')], stages: ['Draft', 'Submitted', 'Approved', 'Returned'], route: { queue: 'Branch approvers', byLocation: true, escalateDays: null, fallback: 'Sam Taylor' }, notify: 'Approvers, and the creator on return' } },
];

interface Conn {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function seedWorkflowDefs(db: Conn, ignore = false) {
  await db.query(`${ignore ? 'INSERT IGNORE' : 'INSERT'} INTO mod_ref_worksheet (type_id, products, creators, success, unsuccessful, credit, credit_rule, fallback, notes, updated_by, updated_at) VALUES ?`, [
    REFERRAL_TYPES.map((t) => {
      const w = worksheetFor(t.typeId);
      return [t.typeId, JSON.stringify(w.products), JSON.stringify(w.creators), w.success, w.unsuccessful, w.credit, w.creditRule, w.fallback, JSON.stringify(w.notes), 'Kinective', '2026-09-01'];
    }),
  ]);
  await db.query(`${ignore ? 'INSERT IGNORE' : 'INSERT'} INTO wf_definition (def_id, name, folder, status, version, base_id, spec, icon, updated_by, updated_at) VALUES ?`, [SEED_DEFINITIONS.map((d, i) => [i + 1, d.name, d.folder, 'Active', 1, null, JSON.stringify(d.spec), d.icon, 'Kinective', '2026-09-01'])]);
}
