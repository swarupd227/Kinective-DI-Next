// Referral Management on the workflow store (spec 17.3, 19). Operations: referral.types.list,
// referral.form.get, relationship.party.search, referral.route (simulate) and referral.create.
// Purview, form validation and routing are decided here, never by an agent.
import type { FormField, Pool, ReferralType, RouteRule } from '@dinext/tenant-db';

export interface CoreContext {
  /** Branches whose members the user may see; undefined means every branch (COM purview, spec 20.7). */
  purviewBranches?: string[];
}

export interface PartyHit {
  partyId: number;
  name: string;
  firstName: string;
  branch: string;
  memberSince: string;
  /** Last four digits of the member number, the only identifier shown before a record is opened. */
  last4: string;
  products: string[];
}

export interface ReferralDraft {
  typeId: string;
  /** Straight to this person instead of the queue's rotation. */
  assigneeEmployeeId?: number;
  partyId: number;
  fields: Record<string, string | number>;
  notes?: string;
  priority?: 'Low' | 'Normal' | 'High' | 'Urgent';
}

export interface RouteResult {
  queueId: string;
  queueName: string;
  /** The next person in rotation, or null for queues whose members claim items. */
  assignee: { employeeId: number; name: string } | null;
  rule: RouteRule['kind'];
  reason: string;
}

export interface DraftCheck {
  ok: boolean;
  /** Required fields with no value, by label. */
  missing: FormField[];
  /** Problems the caller must fix: unknown fields, values outside a list, bad amounts. */
  errors: string[];
  /** The fields with values normalised to the form's options. */
  fields: Record<string, string | number>;
}

/** The stage bar (spec 17.3). Sold and Not Interested close a referral; Done closes a staff task. */
export const REFERRAL_STAGES = ['New Referral', 'Active', 'Sold', 'Not Interested', 'Done'] as const;
export type ReferralStage = (typeof REFERRAL_STAGES)[number];
const OPEN_STAGES: ReferralStage[] = ['New Referral', 'Active'];

/** Days to work a referral, by priority [Assumption]: until a tenant sets its own SLA. */
export const DUE_DAYS: Record<string, number> = { Urgent: 1, High: 2, Normal: 5, Low: 10 };

export type InboxBox = 'mine' | 'team' | 'sent';

export interface InboxItem {
  comId: number;
  typeLabel: string;
  category: string;
  partyId: number;
  name: string;
  last4: string;
  branch: string;
  stage: ReferralStage;
  priority: string;
  queueName: string;
  assignee: { employeeId: number; name: string } | null;
  senderUserId: string;
  senderName: string;
  createdAt: string;
  ageDays: number;
  dueAt: string;
  overdue: boolean;
  notes: string | null;
  fields: Record<string, string | number>;
}

export interface InboxDetail extends InboxItem {
  history: { kind: string; text: string; at: string }[];
  /** People who can take this referral over. */
  team: { employeeId: number; name: string }[];
}

export interface ChangeMeta {
  userId: string;
  userName: string;
  employeeId?: number;
}

export class CoreError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID' | 'NO_ACCESS',
    message: string,
  ) {
    super(message);
  }
}

export const memberNumber = (partyId: number) => String(10_004_520 + partyId);
const CATEGORY_LABEL: Record<string, string> = { Auto: 'Auto loan', Personal: 'Personal loan', Business: 'Business loan' };

type QueueRow = { queue_id: string; name: string; branch_id: number | null; member_employee_ids: number[] | string; rr_pointer: number };
const members = (q: QueueRow): number[] => (typeof q.member_employee_ids === 'string' ? JSON.parse(q.member_employee_ids) : q.member_employee_ids);
const sqlTime = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');

export class ReferralService {
  private typeCache: ReferralType[] | null = null;
  private employeeNames: Map<number, string> | null = null;

  constructor(
    private readonly pool: Pool,
    readonly institutionType: 'credit_union' | 'bank',
  ) {}

  /** referral.types.list */
  async types(): Promise<ReferralType[]> {
    if (!this.typeCache) {
      const [rows] = await this.pool.query('SELECT type_id, category, label, description, route_rule, fields FROM mod_ref_types WHERE active = 1 ORDER BY category, label');
      this.typeCache = (rows as { type_id: string; category: string; label: string; description: string; route_rule: RouteRule; fields: FormField[] }[]).map((r) => ({
        typeId: r.type_id,
        category: r.category,
        label: r.label,
        description: r.description,
        route: r.route_rule,
        fields: r.fields,
      }));
    }
    return this.typeCache;
  }

  /** referral.form.get */
  async type(typeId: string): Promise<ReferralType> {
    const t = (await this.types()).find((x) => x.typeId === typeId);
    if (!t) throw new CoreError('NOT_FOUND', `No referral type "${typeId}".`);
    return t;
  }

  /**
   * relationship.party.search: every word must start a first or last name. Members outside the
   * purview are never returned, so a miss looks the same whether or not the person exists.
   */
  async searchParties(query: string, ctx: CoreContext, limit = 5): Promise<PartyHit[]> {
    const words = query
      .normalize('NFKD')
      .replace(/[^A-Za-z' -]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 4);
    if (!words.length) return [];
    const params: unknown[] = [];
    const conds = words.map((w) => {
      params.push(`${w}%`, `${w}%`);
      return '(p.first_name LIKE ? OR p.last_name LIKE ?)';
    });
    if (ctx.purviewBranches) params.push(ctx.purviewBranches.length ? ctx.purviewBranches : ['']);
    params.push(limit);
    const [rows] = await this.pool.query(
      `SELECT p.party_id, p.first_name, p.last_name, p.join_date, b.name AS branch
         FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id
        WHERE ${conds.join(' AND ')} ${ctx.purviewBranches ? 'AND b.name IN (?)' : ''}
        ORDER BY p.join_date ASC, p.party_id ASC LIMIT ?`,
      params,
    );
    const hits = rows as { party_id: number; first_name: string; last_name: string; join_date: string; branch: string }[];
    if (!hits.length) return [];
    const ids = hits.map((h) => h.party_id);
    const [prod] = await this.pool.query(
      `SELECT party_id, loan_category AS c FROM cdm_loan WHERE party_id IN (?) AND close_date IS NULL AND charge_off_date IS NULL
        UNION SELECT party_id, deposit_category AS c FROM cdm_deposit_account WHERE party_id IN (?) AND close_date IS NULL`,
      [ids, ids],
    );
    const products = new Map<number, Set<string>>();
    for (const r of prod as { party_id: number; c: string }[]) (products.get(r.party_id) ?? products.set(r.party_id, new Set()).get(r.party_id)!).add(CATEGORY_LABEL[r.c] ?? r.c);
    return hits.map((h) => ({
      partyId: h.party_id,
      name: `${h.first_name} ${h.last_name}`,
      firstName: h.first_name,
      branch: h.branch,
      memberSince: h.join_date.slice(0, 4),
      last4: memberNumber(h.party_id).slice(-4),
      products: [...(products.get(h.party_id) ?? [])].sort(),
    }));
  }

  /** One party by id, within purview. */
  async party(partyId: number, ctx: CoreContext): Promise<PartyHit & { branchId: number }> {
    const [rows] = await this.pool.query('SELECT p.party_id, p.first_name, p.last_name, p.join_date, p.primary_branch_id, b.name AS branch FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.party_id = ?', [partyId]);
    const p = (rows as { party_id: number; first_name: string; last_name: string; join_date: string; primary_branch_id: number; branch: string }[])[0];
    if (!p || (ctx.purviewBranches && !ctx.purviewBranches.includes(p.branch))) throw new CoreError('NO_ACCESS', 'That member is outside your purview.');
    return { partyId: p.party_id, name: `${p.first_name} ${p.last_name}`, firstName: p.first_name, branch: p.branch, branchId: p.primary_branch_id, memberSince: p.join_date.slice(0, 4), last4: memberNumber(p.party_id).slice(-4), products: [] };
  }

  /** Checks a draft against the type's form (AI-AGT-160): no fields the form does not have. */
  async check(draft: Pick<ReferralDraft, 'typeId' | 'fields'>): Promise<DraftCheck> {
    const type = await this.type(draft.typeId);
    const errors: string[] = [];
    const fields: Record<string, string | number> = {};
    for (const [id, raw] of Object.entries(draft.fields ?? {})) {
      const f = type.fields.find((x) => x.id === id);
      if (!f) {
        errors.push(`The ${type.label} form has no field "${id}". Fields: ${type.fields.map((x) => x.id).join(', ')}.`);
        continue;
      }
      if (raw === '' || raw === null || raw === undefined) continue;
      if (f.type === 'enum') {
        const match = f.options!.find((o) => o.toLowerCase() === String(raw).trim().toLowerCase());
        if (!match) errors.push(`${f.label} must be one of: ${f.options!.join(', ')}.`);
        else fields[id] = match;
      } else if (f.type === 'money') {
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,\s]/g, ''));
        if (!Number.isFinite(n) || n <= 0 || n > 50_000_000) errors.push(`${f.label} must be a positive amount.`);
        else fields[id] = Math.round(n * 100) / 100;
      } else {
        fields[id] = String(raw).slice(0, 200);
      }
    }
    const missing = type.fields.filter((f) => f.required && fields[f.id] === undefined);
    return { ok: !errors.length && !missing.length, missing, errors, fields };
  }

  private async names() {
    if (!this.employeeNames) {
      const [rows] = await this.pool.query('SELECT employee_id, display_name FROM cdm_employee');
      this.employeeNames = new Map((rows as { employee_id: number; display_name: string }[]).map((r) => [r.employee_id, r.display_name]));
    }
    return this.employeeNames;
  }

  private async targetQueue(type: ReferralType, branchId: number): Promise<{ queue: QueueRow; rule: RouteRule['kind']; reason: string }> {
    const load = async (id: string) => {
      const [rows] = await this.pool.query('SELECT * FROM esp_com_queues WHERE queue_id = ?', [id]);
      return (rows as QueueRow[])[0];
    };
    if (type.route.kind === 'queue') return { queue: (await load(type.route.queueId))!, rule: 'queue', reason: `${type.label} referrals go to one shared queue` };
    const [loc] = await this.pool.query('SELECT name FROM cdm_location WHERE int_id = ?', [branchId]);
    const branch = (loc as { name: string }[])[0]!.name;
    const local = await load(`q_${type.route.queue}_${branch.toLowerCase()}`);
    if (local && members(local).length) return { queue: local, rule: 'by_location', reason: `Routed to the member's branch, ${branch}` };
    // Fallback when the branch queue has nobody to work it (spec 19.5).
    return { queue: (await load(type.route.fallbackQueue))!, rule: 'by_location', reason: `${branch} has no one in that queue, so the fallback queue is used` };
  }

  /** referral.route, simulated: who it would go to now, without advancing the rotation (AI-AGT-161). */
  async route(typeId: string, partyId: number): Promise<RouteResult> {
    const type = await this.type(typeId);
    const [rows] = await this.pool.query('SELECT primary_branch_id FROM cdm_party WHERE party_id = ?', [partyId]);
    const branchId = (rows as { primary_branch_id: number }[])[0]?.primary_branch_id;
    if (!branchId) throw new CoreError('NOT_FOUND', 'Member not found.');
    const { queue, rule, reason } = await this.targetQueue(type, branchId);
    const m = members(queue);
    const next = m.length ? m[queue.rr_pointer % m.length]! : null;
    const names = await this.names();
    return { queueId: queue.queue_id, queueName: queue.name, assignee: next ? { employeeId: next, name: names.get(next)! } : null, rule, reason: m.length > 1 ? `${reason}, round-robin among ${m.length} people` : reason };
  }

  /**
   * referral.create (wraps workflow.item.create). Idempotent on the approval ID (AI-TRG-003): a retry
   * returns the referral the first call created. The approved queue is used; the person within it
   * comes from the rotation at the moment of creation.
   */
  async create(draft: ReferralDraft & { toQueueId: string }, meta: { approvalId: string; runId: string; userId: string; userName: string }, ctx: CoreContext) {
    const check = await this.check(draft);
    if (!check.ok) throw new CoreError('INVALID', [...check.errors, ...check.missing.map((f) => `${f.label} is required.`)].join(' '));
    await this.party(draft.partyId, ctx);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.query('SELECT com_id FROM esp_com_items WHERE approval_id = ? FOR UPDATE', [meta.approvalId]);
      const prior = (existing as { com_id: number }[])[0];
      if (prior) {
        await conn.commit();
        return { ...(await this.get(prior.com_id)), replayed: true };
      }
      const [qs] = await conn.query('SELECT * FROM esp_com_queues WHERE queue_id = ? FOR UPDATE', [draft.toQueueId]);
      const queue = (qs as QueueRow[])[0];
      if (!queue) throw new CoreError('NOT_FOUND', 'The queue no longer exists.');
      const m = members(queue);
      const direct = draft.assigneeEmployeeId;
      const assignee = direct ?? (m.length ? m[queue.rr_pointer % m.length]! : null);
      if (m.length && direct === undefined) await conn.query('UPDATE esp_com_queues SET rr_pointer = rr_pointer + 1 WHERE queue_id = ?', [queue.queue_id]);
      const now = sqlTime(new Date());
      const routing = { queueId: queue.queue_id, assigneeId: assignee, rule: direct !== undefined ? 'direct' : m.length ? 'round_robin' : 'queue', pointer: queue.rr_pointer };
      const [ins] = await conn.query(
        `INSERT INTO esp_com_items (definition, type_id, party_id, fields, notes, stage, priority, sender_user_id, sender_name, to_queue_id, assignee_employee_id, routing, created_at, run_id, approval_id)
         VALUES ('referral', ?, ?, ?, ?, 'New Referral', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [draft.typeId, draft.partyId, JSON.stringify(check.fields), draft.notes?.slice(0, 500) ?? null, draft.priority ?? 'Normal', meta.userId, meta.userName, queue.queue_id, assignee, JSON.stringify(routing), now, meta.runId, meta.approvalId],
      );
      const comId = (ins as { insertId: number }).insertId;
      // The audit trail links the record to the run and approval that created it (AI-GRD-092).
      await conn.query("INSERT INTO esp_com_lines (com_id, kind, text, by_user_id, created_at) VALUES (?, 'created', ?, ?, ?)", [comId, `Created by ${meta.userName} through DI (run ${meta.runId}, approval ${meta.approvalId}).`, meta.userId, now]);
      await conn.commit();
      return { ...(await this.get(comId)), replayed: false };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Who already has an open referral of this type, so a repeat run does not double up. */
  async openFor(typeId: string, partyIds: number[]) {
    if (!partyIds.length) return new Set<number>();
    const [rows] = await this.pool.query("SELECT DISTINCT party_id FROM esp_com_items WHERE definition = 'referral' AND type_id = ? AND stage = 'New Referral' AND party_id IN (?)", [typeId, partyIds]);
    return new Set((rows as { party_id: number }[]).map((r) => r.party_id));
  }

  private toItem(r: Record<string, unknown>, now = new Date()): InboxItem {
    const created = new Date(`${String(r.created_at).replace(' ', 'T')}Z`);
    const priority = r.priority as string;
    const due = new Date(created.getTime() + (DUE_DAYS[priority] ?? DUE_DAYS.Normal!) * 86_400_000);
    const stage = r.stage as ReferralStage;
    return {
      comId: r.com_id as number,
      typeLabel: r.type_label as string,
      category: r.category as string,
      partyId: r.party_id as number,
      name: `${r.first_name} ${r.last_name}`,
      last4: memberNumber(r.party_id as number).slice(-4),
      branch: r.branch as string,
      stage,
      priority,
      queueName: r.queue_name as string,
      assignee: r.assignee_employee_id ? { employeeId: r.assignee_employee_id as number, name: r.assignee_name as string } : null,
      senderUserId: r.sender_user_id as string,
      senderName: r.sender_name as string,
      createdAt: created.toISOString(),
      ageDays: Math.floor((now.getTime() - created.getTime()) / 86_400_000),
      dueAt: due.toISOString(),
      overdue: OPEN_STAGES.includes(stage) && due < now,
      notes: (r.notes as string | null) ?? null,
      fields: (typeof r.fields === 'string' ? JSON.parse(r.fields) : r.fields) as Record<string, string | number>,
    };
  }

  private static readonly ITEM_SQL = `SELECT c.com_id, c.party_id, c.fields, c.notes, c.stage, c.priority, c.assignee_employee_id, c.sender_user_id, c.sender_name, c.created_at, c.to_queue_id,
      t.label AS type_label, t.category, p.first_name, p.last_name, b.name AS branch, q.name AS queue_name, e.display_name AS assignee_name
    FROM esp_com_items c JOIN mod_ref_types t ON t.type_id = c.type_id JOIN cdm_party p ON p.party_id = c.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id
    JOIN esp_com_queues q ON q.queue_id = c.to_queue_id LEFT JOIN cdm_employee e ON e.employee_id = c.assignee_employee_id`;

  /**
   * referral.inbox.list (BE-WF-003, FE-REF-001). Mine: open work assigned to the user. Team: open
   * work in the user's COM purview, including what nobody has claimed. Sent: what the user created,
   * wherever it went, with its current stage. Overdue first, then oldest first.
   */
  async inbox(box: InboxBox, who: { userId: string; employeeId?: number }, ctx: CoreContext, limit = 100): Promise<InboxItem[]> {
    const where = ["c.definition = 'referral'"];
    const params: unknown[] = [];
    if (box === 'mine') {
      if (who.employeeId === undefined) return [];
      where.push('c.assignee_employee_id = ?');
      params.push(who.employeeId);
    }
    if (box === 'sent') {
      where.push('c.sender_user_id = ?');
      params.push(who.userId);
    } else {
      where.push('c.stage IN (?)');
      params.push(OPEN_STAGES);
      if (ctx.purviewBranches) {
        where.push('b.name IN (?)');
        params.push(ctx.purviewBranches.length ? ctx.purviewBranches : ['']);
      }
    }
    const [rows] = await this.pool.query(`${ReferralService.ITEM_SQL} WHERE ${where.join(' AND ')} ORDER BY c.created_at ASC LIMIT ?`, [...params, limit]);
    const now = new Date();
    const items = (rows as Record<string, unknown>[]).map((r) => this.toItem(r, now));
    return items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.createdAt.localeCompare(b.createdAt));
  }

  /** One referral. The sender can always read it; otherwise it must be in the purview, or reads as not found. */
  async item(comId: number, who: { userId: string }, ctx: CoreContext): Promise<InboxDetail> {
    const [rows] = await this.pool.query(`${ReferralService.ITEM_SQL} WHERE c.com_id = ? AND c.definition = 'referral'`, [comId]);
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) throw new CoreError('NOT_FOUND', `Referral #${comId} was not found.`);
    const item = this.toItem(row);
    if (item.senderUserId !== who.userId && ctx.purviewBranches && !ctx.purviewBranches.includes(item.branch)) throw new CoreError('NOT_FOUND', `Referral #${comId} was not found.`);
    const [lines] = await this.pool.query('SELECT kind, text, created_at FROM esp_com_lines WHERE com_id = ? ORDER BY line_id', [comId]);
    const [q] = await this.pool.query('SELECT * FROM esp_com_queues WHERE queue_id = ?', [row.to_queue_id]);
    const names = await this.names();
    return {
      ...item,
      history: (lines as { kind: string; text: string; created_at: string }[]).map((l) => ({ kind: l.kind, text: l.text, at: `${String(l.created_at).replace(' ', 'T')}Z` })),
      team: members((q as QueueRow[])[0]!).map((employeeId) => ({ employeeId, name: names.get(employeeId)! })),
    };
  }

  /** Changes need the item in the purview: being its sender lets you read it, not work it. */
  private async workable(comId: number, meta: ChangeMeta, ctx: CoreContext) {
    const item = await this.item(comId, meta, ctx);
    if (ctx.purviewBranches && !ctx.purviewBranches.includes(item.branch)) throw new CoreError('NO_ACCESS', `Referral #${comId} is outside your purview.`);
    return item;
  }

  private async line(comId: number, kind: string, text: string, userId: string) {
    await this.pool.query('INSERT INTO esp_com_lines (com_id, kind, text, by_user_id, created_at) VALUES (?, ?, ?, ?, ?)', [comId, kind, text.slice(0, 1000), userId, sqlTime(new Date())]);
  }

  /** Stage is the lifecycle; a closed referral stays closed. Repeating the same change does nothing. */
  async transition(comId: number, stage: ReferralStage, note: string | undefined, meta: ChangeMeta, ctx: CoreContext) {
    if (!REFERRAL_STAGES.includes(stage)) throw new CoreError('INVALID', `Stage must be one of: ${REFERRAL_STAGES.join(', ')}.`);
    const item = await this.workable(comId, meta, ctx);
    if (item.stage === stage) return { item, changed: false };
    if (!OPEN_STAGES.includes(item.stage)) throw new CoreError('INVALID', `Referral #${comId} is already closed as ${item.stage}.`);
    if (stage === 'New Referral') throw new CoreError('INVALID', 'A referral that has started cannot go back to New Referral.');
    const task = item.category === 'Task';
    if (task ? stage === 'Sold' || stage === 'Not Interested' : stage === 'Done') throw new CoreError('INVALID', task ? 'A task closes as Done.' : 'A referral closes as Sold or Not Interested.');
    // Starting work on something nobody holds makes it yours.
    const claim = stage === 'Active' && !item.assignee && meta.employeeId !== undefined;
    await this.pool.query(`UPDATE esp_com_items SET stage = ?${claim ? ', assignee_employee_id = ?' : ''} WHERE com_id = ?`, claim ? [stage, meta.employeeId, comId] : [stage, comId]);
    await this.line(comId, 'stage', `${meta.userName} moved this from ${item.stage} to ${stage}.${note ? ` ${note}` : ''}`, meta.userId);
    return { item: await this.item(comId, meta, ctx), changed: true };
  }

  async addNote(comId: number, text: string, meta: ChangeMeta, ctx: CoreContext) {
    await this.workable(comId, meta, ctx);
    await this.line(comId, 'note', `${meta.userName}: ${text}`, meta.userId);
    return this.item(comId, meta, ctx);
  }

  /** Reassigns within the referral's queue: the person must be someone who works it. */
  async reassign(comId: number, employeeId: number, meta: ChangeMeta, ctx: CoreContext) {
    const item = await this.workable(comId, meta, ctx);
    if (!OPEN_STAGES.includes(item.stage)) throw new CoreError('INVALID', `Referral #${comId} is closed.`);
    const to = item.team.find((m) => m.employeeId === employeeId);
    if (!to) throw new CoreError('INVALID', `${item.queueName} is worked by ${item.team.map((m) => m.name).join(', ') || 'nobody yet'}.`);
    await this.pool.query('UPDATE esp_com_items SET assignee_employee_id = ? WHERE com_id = ?', [employeeId, comId]);
    await this.line(comId, 'assign', `${meta.userName} assigned this to ${to.name}.`, meta.userId);
    return this.item(comId, meta, ctx);
  }

  /** referral.get */
  async get(comId: number) {
    const [rows] = await this.pool.query(
      `SELECT c.com_id, c.type_id, c.party_id, c.fields, c.notes, c.stage, c.to_queue_id, q.name AS queue_name, c.assignee_employee_id, e.display_name AS assignee_name, c.sender_name, c.created_at, c.run_id, c.approval_id
         FROM esp_com_items c JOIN esp_com_queues q ON q.queue_id = c.to_queue_id LEFT JOIN cdm_employee e ON e.employee_id = c.assignee_employee_id
        WHERE c.com_id = ?`,
      [comId],
    );
    const r = (rows as Record<string, unknown>[])[0];
    if (!r) throw new CoreError('NOT_FOUND', `Referral #${comId} not found.`);
    return {
      comId: r.com_id as number,
      typeId: r.type_id as string,
      partyId: r.party_id as number,
      fields: (typeof r.fields === 'string' ? JSON.parse(r.fields) : r.fields) as Record<string, string | number>,
      notes: (r.notes as string | null) ?? undefined,
      stage: r.stage as string,
      queueId: r.to_queue_id as string,
      queueName: r.queue_name as string,
      assignee: r.assignee_employee_id ? { employeeId: r.assignee_employee_id as number, name: r.assignee_name as string } : null,
      senderName: r.sender_name as string,
      createdAt: `${String(r.created_at).replace(' ', 'T')}Z`,
      runId: r.run_id as string,
      approvalId: r.approval_id as string,
    };
  }

  /** referral.list (sent): open referrals the user created. */
  async sent(userId: string, limit = 20) {
    const [rows] = await this.pool.query("SELECT com_id FROM esp_com_items WHERE sender_user_id = ? AND definition = 'referral' ORDER BY com_id DESC LIMIT ?", [userId, limit]);
    return Promise.all((rows as { com_id: number }[]).map((r) => this.get(r.com_id)));
  }
}
