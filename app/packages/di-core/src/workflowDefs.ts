// DI Core for the Workflow Builder (spec 24.7). The agent works on drafts; a live definition changes
// only by publishing, after validation passes and a test route has run (AI-AGT-070, AI-AGT-071).
// Every check, test route and count of affected open items is worked out here.
import type { Pool, WfField, WfSpec } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as WfSpec;

export interface Definition {
  defId: number;
  name: string;
  folder: string;
  status: 'Active' | 'Draft';
  version: number;
  baseId: number | null;
  spec: WfSpec;
  icon: string;
  updatedBy: string;
}

export interface Problem {
  problem: string;
  fix: string;
}

const fieldOf = (label: string): WfField => {
  const l = label.trim();
  const type: WfField['type'] = /\b(photo|picture|attachment|file|document)\b/i.test(l) ? 'file' : /\b(amount|cost|\$)\b/i.test(l) ? 'money' : /\b(date|due|deadline)\b/i.test(l) ? 'date' : /\b(category|type|urgency|priority|status|location|branch)\b/i.test(l) ? 'enum' : 'text';
  return { id: l.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), label: l.charAt(0).toUpperCase() + l.slice(1), type };
};

/** Attachments go with the form, not the record (spec 8.16: persistent and non-persistent fields). */
export const splitFields = (labels: string[]) => {
  const fields = labels.map(fieldOf);
  return { persistent: fields.filter((x) => x.type !== 'file'), nonPersistent: fields.filter((x) => x.type === 'file') };
};

/** Open items each live workflow has, so a change can say how many it affects (FE-WF-003). */
const OPEN_ITEMS: Record<string, string> = {
  Referral: "SELECT COUNT(*) AS n FROM esp_com_items WHERE definition = 'referral' AND stage NOT IN ('Sold', 'Not Interested', 'Done')",
  Task: "SELECT COUNT(*) AS n FROM tsk_task WHERE status = 'Open'",
  'Compliance issue': "SELECT COUNT(*) AS n FROM cpm_issue WHERE status <> 'Closed'",
  'Data log': "SELECT COUNT(*) AS n FROM esp_datalog WHERE status IN ('Draft', 'Submitted', 'Returned')",
};

export class WorkflowDefService {
  constructor(private readonly pool: Pool) {}

  private toDef = (r: Record<string, unknown>): Definition => ({ defId: r.def_id as number, name: r.name as string, folder: r.folder as string, status: r.status as Definition['status'], version: r.version as number, baseId: (r.base_id as number | null) ?? null, spec: parse(r.spec), icon: r.icon as string, updatedBy: r.updated_by as string });

  async list() {
    const all = (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM wf_definition ORDER BY name, status')).map(this.toDef);
    return Promise.all(all.map(async (d) => ({ ...d, openItems: d.status === 'Active' ? await this.openItems(d.name) : 0 })));
  }

  async openItems(name: string) {
    const sql = OPEN_ITEMS[name];
    if (!sql) return 0;
    const [r] = await rows<{ n: number }>(this.pool, sql).catch(() => [{ n: 0 }]);
    return Number(r?.n ?? 0);
  }

  /** The live definition or the draft a name refers to. "referrals" finds Referral. */
  async find(name: string, status?: 'Active' | 'Draft') {
    const words = name.toLowerCase().replace(/\b(the|workflow|workflows|definition|draft)\b/g, '').split(/\s+/).filter(Boolean).map((w) => w.replace(/s$/, ''));
    const all = (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM wf_definition')).map(this.toDef).filter((d) => !status || d.status === status);
    const hits = all.filter((d) => words.length && words.every((w) => d.name.toLowerCase().includes(w)));
    const draft = hits.find((d) => d.status === 'Draft');
    const hit = status ? hits[0] : (draft ?? hits[0]);
    if (!hit) throw new CoreError('NOT_FOUND', `There’s no workflow called “${name}”. They are: ${[...new Set(all.map((d) => d.name))].join(', ')}.`);
    return hit;
  }

  /** The newest draft someone is working on, for "fallback to Sam Taylor" with no name. */
  async latestDraft() {
    const [r] = await rows<Record<string, unknown>>(this.pool, "SELECT * FROM wf_definition WHERE status = 'Draft' ORDER BY def_id DESC LIMIT 1");
    if (!r) throw new CoreError('NOT_FOUND', 'There’s no draft workflow yet. Describe the workflow you want first.');
    return this.toDef(r);
  }

  async queues() {
    return (await rows<{ name: string }>(this.pool, 'SELECT name FROM esp_com_queues ORDER BY name')).map((q) => q.name);
  }

  /** Problems with a definition, each with a proposed fix. A definition with any can't be published. */
  async validate(d: { name: string; spec: WfSpec; baseId: number | null }): Promise<Problem[]> {
    const out: Problem[] = [];
    const s = d.spec;
    if (!d.baseId) {
      const [clash] = await rows<{ n: number }>(this.pool, "SELECT COUNT(*) AS n FROM wf_definition WHERE status = 'Active' AND LOWER(name) = LOWER(?)", [d.name]);
      if (Number(clash?.n)) out.push({ problem: `A live workflow is already called ${d.name}.`, fix: 'Give the new workflow another name.' });
    }
    const labels = [...s.persistent, ...s.nonPersistent].map((x) => x.label.toLowerCase());
    const dup = labels.find((l, i) => labels.indexOf(l) !== i);
    if (dup) out.push({ problem: `Two fields are called “${dup}”.`, fix: 'Rename or remove one of them.' });
    if (!s.persistent.length) out.push({ problem: 'The workflow has no fields stored on the record.', fix: 'Add at least one field, such as a category or description.' });
    if (s.stages.length < 2 || new Set(s.stages.map((x) => x.toLowerCase())).size !== s.stages.length) out.push({ problem: 'Stages must be at least two, with no repeats.', fix: 'List the stages in order, for example New, In progress, Done.' });
    const known = (await this.queues()).map((q) => q.toLowerCase());
    const newQueue = !d.baseId && !known.some((q) => q.includes(s.route.queue.toLowerCase()));
    if (newQueue && !s.route.fallback) out.push({ problem: `${s.route.queue} is a new queue with nobody in it yet, and there’s no fallback recipient.`, fix: `Say who should get items nobody picks up, for example “fallback to Sam Taylor”.` });
    if (s.route.fallback) {
      const [u] = await rows<{ status: string }>(this.pool, 'SELECT status FROM iam_user WHERE LOWER(name) = LOWER(?) LIMIT 1', [s.route.fallback]);
      if (!u) out.push({ problem: `There’s no user called ${s.route.fallback} to fall back to.`, fix: 'Name an active user.' });
      else if (u.status !== 'Active') out.push({ problem: `${s.route.fallback} is ${u.status.toLowerCase()}, so items would go nowhere.`, fix: 'Name an active user.' });
    }
    return out;
  }

  /** A dry run of the routing for one sample item per rule (AI-AGT-071). */
  async simulate(spec: WfSpec) {
    const branches = (await rows<{ name: string }>(this.pool, 'SELECT name FROM cdm_location ORDER BY int_id LIMIT 2')).map((b) => b.name);
    const samples = spec.route.byLocation ? branches : ['any branch'];
    return samples.map((b) => ({ sample: `An item from ${b}`, route: `${spec.route.queue}${spec.route.byLocation ? ` (${b})` : ''}${spec.route.escalateDays && spec.route.fallback ? `, then ${spec.route.fallback} if nobody picks it up in ${spec.route.escalateDays} business ${spec.route.escalateDays === 1 ? 'day' : 'days'}` : spec.route.fallback ? `, ${spec.route.fallback} if the queue is empty` : ''}` }));
  }

  /** Field, stage and routing differences from the live version, for the publish card. */
  diff(before: WfSpec | null, after: WfSpec) {
    if (!before) return [{ label: 'New workflow', before: '—', after: `${after.persistent.length + after.nonPersistent.length} fields, ${after.stages.length} stages` }];
    const out: { label: string; before: string; after: string }[] = [];
    const names = (s: WfSpec) => [...s.persistent, ...s.nonPersistent].map((x) => x.label);
    const added = names(after).filter((n) => !names(before).includes(n));
    const removed = names(before).filter((n) => !names(after).includes(n));
    if (added.length) out.push({ label: 'Fields added', before: '—', after: added.join(', ') });
    if (removed.length) out.push({ label: 'Fields removed', before: removed.join(', '), after: '—' });
    if (before.stages.join('|') !== after.stages.join('|')) out.push({ label: 'Stages', before: before.stages.join(' → '), after: after.stages.join(' → ') });
    const route = (s: WfSpec) => `${s.route.queue}${s.route.byLocation ? ' by location' : ''}${s.route.fallback ? `, fallback ${s.route.fallback}` : ''}`;
    if (route(before) !== route(after)) out.push({ label: 'Routing', before: route(before), after: route(after) });
    return out;
  }

  async saveDraft(p: { name: string; folder: string; baseId: number | null; spec: WfSpec }, meta: { approvalId: string; actor: string; on: string }) {
    // One draft per workflow: a newer draft replaces the older one.
    await this.pool.query("UPDATE wf_definition SET status = 'Replaced' WHERE status = 'Draft' AND LOWER(name) = LOWER(?)", [p.name]);
    await this.pool.query("INSERT IGNORE INTO wf_definition (name, folder, status, version, base_id, spec, icon, updated_by, updated_at, approval_id) VALUES (?, ?, 'Draft', 0, ?, ?, 'icons/workflow.svg', ?, ?, ?)", [p.name, p.folder, p.baseId, JSON.stringify(p.spec), meta.actor, meta.on, meta.approvalId]);
  }

  async updateDraft(defId: number, spec: WfSpec, meta: { actor: string; on: string }) {
    await this.pool.query("UPDATE wf_definition SET spec = ?, updated_by = ?, updated_at = ? WHERE def_id = ? AND status = 'Draft'", [JSON.stringify(spec), meta.actor, meta.on, defId]);
  }

  /** The draft becomes the live version. A new queue is created with the definition. */
  async publish(draftId: number, meta: { approvalId: string; actor: string; on: string }) {
    const [r] = await rows<Record<string, unknown>>(this.pool, "SELECT * FROM wf_definition WHERE def_id = ? AND status = 'Draft'", [draftId]);
    if (!r) return; // already published from this approval
    const d = this.toDef(r);
    const problems = await this.validate(d);
    if (problems.length) throw new CoreError('INVALID', `It can’t be published: ${problems.map((p) => p.problem).join(' ')}`);
    if (d.baseId) {
      await this.pool.query("UPDATE wf_definition SET spec = ?, version = version + 1, updated_by = ?, updated_at = ?, approval_id = ? WHERE def_id = ? AND status = 'Active'", [JSON.stringify(d.spec), meta.actor, meta.on, meta.approvalId, d.baseId]);
      await this.pool.query("UPDATE wf_definition SET status = 'Published' WHERE def_id = ?", [draftId]);
    } else {
      await this.pool.query("UPDATE wf_definition SET status = 'Active', version = 1, updated_by = ?, updated_at = ? WHERE def_id = ?", [meta.actor, meta.on, draftId]);
      const known = (await this.queues()).map((q) => q.toLowerCase());
      if (!known.some((q) => q.includes(d.spec.route.queue.toLowerCase()))) {
        await this.pool.query("INSERT IGNORE INTO esp_com_queues (queue_id, name, branch_id, member_employee_ids, rr_pointer) VALUES (?, ?, NULL, '[]', 0)", [`q_${d.spec.route.queue.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, d.spec.route.queue]);
      }
    }
  }
}
