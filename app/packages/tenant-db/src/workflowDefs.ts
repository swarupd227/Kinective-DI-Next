// Workflow definitions for the Workflow Builder (spec 8.16, 24.7): name, folder, persistent and
// non-persistent fields, stages and routing. Drafts sit beside the live definition until published.
// The four seeded definitions describe the workflows the app already runs.
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
];

export const WORKFLOW_DEF_WRITE_TABLES = ['wf_definition'];

export interface WfField {
  id: string;
  label: string;
  type: 'text' | 'enum' | 'money' | 'date' | 'person' | 'file';
}

export interface WfSpec {
  persistent: WfField[];
  nonPersistent: WfField[];
  stages: string[];
  route: { queue: string; byLocation: boolean; escalateDays: number | null; fallback: string | null };
  notify: string;
}

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
  await db.query(`${ignore ? 'INSERT IGNORE' : 'INSERT'} INTO wf_definition (def_id, name, folder, status, version, base_id, spec, icon, updated_by, updated_at) VALUES ?`, [SEED_DEFINITIONS.map((d, i) => [i + 1, d.name, d.folder, 'Active', 1, null, JSON.stringify(d.spec), d.icon, 'Kinective', '2026-09-01'])]);
}
