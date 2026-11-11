// The Referral Desk: the parts of DI's Referral Manager around the core referral flow. A referral for
// someone who isn't a member yet (a prospect), creating referrals from an uploaded list, copying
// colleagues on a referral, changing its priority, and saved views of the referral list. Every write
// is applied on approval and is idempotent by the approval.
import type { Pool } from '@dinext/tenant-db';
import { CLOSED_STAGES, CoreError, memberNumber, type CoreContext, type ReferralService } from './referrals.ts';

export interface ProspectReferral {
  typeId: string;
  name: string;
  phone?: string;
  email?: string;
  branch: string;
  notes?: string;
  priority?: 'Low' | 'Normal' | 'High' | 'Urgent';
}

export interface BulkRow {
  line: number;
  member: string;
  type: string;
  notes?: string;
}

export interface BulkReady {
  line: number;
  partyId: number;
  name: string;
  branch: string;
  typeId: string;
  typeLabel: string;
  queueId: string;
  queueName: string;
  notes?: string;
}

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const sqlNow = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;

/** One line of a CSV, with quoted cells. */
export function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** A referral list as uploaded: a header row naming member (or member number), type and notes columns. */
export function parseReferralCsv(text: string): { rows: BulkRow[]; problems: string[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], problems: ['The file needs a header row and at least one referral.'] };
  const head = csvCells(lines[0]!).map((h) => h.toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const member = col('member number', 'customer number', 'member', 'customer', 'name');
  const type = col('referral type', 'type', 'product');
  const notes = col('note', 'comment');
  if (member < 0 || type < 0) return { rows: [], problems: ['The header needs a member (or member number) column and a referral type column.'] };
  const out: BulkRow[] = [];
  for (let i = 1; i < lines.length && out.length < 500; i++) {
    const c = csvCells(lines[i]!);
    out.push({ line: i + 1, member: c[member] ?? '', type: c[type] ?? '', ...(notes >= 0 && c[notes] ? { notes: c[notes]!.slice(0, 200) } : {}) });
  }
  return { rows: out, problems: lines.length - 1 > 500 ? ['Only the first 500 rows are read.'] : [] };
}

export class ReferralDeskService {
  constructor(
    private readonly pool: Pool,
    private readonly referrals: ReferralService,
  ) {}

  /** A type by its id or label, among the active types. */
  async typeNamed(name: string) {
    const types = await this.referrals.types();
    const n = name.trim().toLowerCase();
    return types.find((t) => t.typeId === n || t.label.toLowerCase() === n) ?? types.find((t) => t.label.toLowerCase().includes(n) || n.includes(t.label.toLowerCase()));
  }

  /** Where a type's referral goes for a branch: the branch's own queue when the type routes by location. */
  async queueFor(typeId: string, branchId: number) {
    const type = await this.referrals.type(typeId);
    const route = type.route as { kind: string; queue?: string; queueId?: string; fallbackQueue?: string };
    const candidates: string[] = [];
    if (route.kind === 'queue' && route.queueId) candidates.push(route.queueId);
    if (route.kind === 'by_location' && route.queue) {
      const [b] = await rows<{ name: string }>(this.pool, 'SELECT name FROM cdm_location WHERE int_id = ?', [branchId]);
      if (b) candidates.push(`q_${route.queue}_${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`);
    }
    if (route.fallbackQueue) candidates.push(route.fallbackQueue);
    for (const id of candidates) {
      const [q] = await rows<{ queue_id: string; name: string; member_employee_ids: unknown; rr_pointer: number }>(this.pool, 'SELECT queue_id, name, member_employee_ids, rr_pointer FROM esp_com_queues WHERE queue_id = ?', [id]);
      if (q) return { queueId: q.queue_id, name: q.name };
    }
    throw new CoreError('NOT_FOUND', `No queue takes ${type.label} referrals for that branch.`);
  }

  async branchNamed(name: string, ctx: CoreContext) {
    const [b] = await rows<{ int_id: number; name: string }>(this.pool, 'SELECT int_id, name FROM cdm_location WHERE LOWER(name) = ?', [name.trim().toLowerCase()]);
    if (!b) throw new CoreError('NOT_FOUND', `There’s no branch called ${name}.`);
    if (ctx.purviewBranches && !ctx.purviewBranches.includes(b.name)) throw new CoreError('NO_ACCESS', `${b.name} is outside the branches you can work.`);
    return { branchId: b.int_id, name: b.name };
  }

  /** Inserts one referral, round-robin within its queue, unless this approval already made it. */
  private async insert(p: { approvalId: string; typeId: string; partyId: number | null; prospect: Record<string, unknown> | null; fields: Record<string, unknown>; notes?: string; priority: string; queueId: string }, meta: { userId: string; userName: string; employeeId?: number; runId?: string }) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.query('SELECT com_id FROM esp_com_items WHERE approval_id = ? FOR UPDATE', [p.approvalId]);
      const prior = (existing as { com_id: number }[])[0];
      if (prior) {
        await conn.commit();
        return { comId: prior.com_id, replayed: true };
      }
      const [qs] = await conn.query('SELECT queue_id, member_employee_ids, rr_pointer FROM esp_com_queues WHERE queue_id = ? FOR UPDATE', [p.queueId]);
      const q = (qs as { queue_id: string; member_employee_ids: unknown; rr_pointer: number }[])[0];
      if (!q) throw new CoreError('NOT_FOUND', 'The queue no longer exists.');
      const members = ((typeof q.member_employee_ids === 'string' ? JSON.parse(q.member_employee_ids) : q.member_employee_ids) as number[]) ?? [];
      const assignee = members.length ? members[q.rr_pointer % members.length]! : null;
      if (members.length) await conn.query('UPDATE esp_com_queues SET rr_pointer = rr_pointer + 1 WHERE queue_id = ?', [q.queue_id]);
      const now = sqlNow();
      const [ins] = await conn.query(
        `INSERT INTO esp_com_items (definition, type_id, party_id, prospect, fields, notes, stage, priority, sender_user_id, sender_name, sender_employee_id, to_queue_id, assignee_employee_id, routing, created_at, run_id, approval_id)
         VALUES ('referral', ?, ?, ?, ?, ?, 'New Referral', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.typeId, p.partyId, p.prospect ? JSON.stringify(p.prospect) : null, JSON.stringify(p.fields), p.notes?.slice(0, 500) ?? null, p.priority, meta.userId, meta.userName, meta.employeeId ?? null, q.queue_id, assignee, JSON.stringify({ queueId: q.queue_id, assigneeId: assignee, rule: members.length ? 'round_robin' : 'queue' }), now, meta.runId ?? null, p.approvalId],
      );
      const comId = (ins as { insertId: number }).insertId;
      await conn.query("INSERT INTO esp_com_lines (com_id, kind, text, by_user_id, created_at) VALUES (?, 'created', ?, ?, ?)", [comId, `Created by ${meta.userName} through DI (approval ${p.approvalId}).`, meta.userId, now]);
      await conn.commit();
      return { comId, replayed: false };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** A referral for someone who isn't a member yet: their name and how to reach them. */
  async prospect(p: ProspectReferral & { branchId: number; queueId: string }, meta: { approvalId: string; userId: string; userName: string; employeeId?: number; runId?: string }) {
    return this.insert(
      { approvalId: meta.approvalId, typeId: p.typeId, partyId: null, prospect: { name: p.name, phone: p.phone ?? null, email: p.email ?? null, branchId: p.branchId, branch: p.branch }, fields: { preferred_contact: p.phone ? 'Phone' : 'Email', new_member: 'Yes' }, notes: p.notes, priority: p.priority ?? 'Normal', queueId: p.queueId },
      meta,
    );
  }

  /** Checks an uploaded list: each row's member (by member number or a unique name you can see) and type. */
  async checkBulk(list: BulkRow[], ctx: CoreContext) {
    const ready: BulkReady[] = [];
    const problems: { line: number; problem: string }[] = [];
    for (const r of list) {
      const type = r.type ? await this.typeNamed(r.type) : undefined;
      if (!type || type.category === 'Task') {
        problems.push({ line: r.line, problem: `“${r.type || 'blank'}” isn’t a referral type.` });
        continue;
      }
      const digits = r.member.replace(/\D/g, '');
      let hits: { party_id: number; first_name: string; last_name: string; branch: string; branch_id: number }[] = [];
      if (digits.length >= 6) {
        const id = Number(digits) - 10_004_520;
        hits = id > 0 ? await rows(this.pool, 'SELECT p.party_id, p.first_name, p.last_name, b.name AS branch, b.int_id AS branch_id FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.party_id = ?', [id]) : [];
        if (hits[0] && memberNumber(hits[0].party_id) !== digits) hits = [];
      } else {
        const parts = r.member.trim().split(/\s+/);
        if (parts.length >= 2) hits = await rows(this.pool, 'SELECT p.party_id, p.first_name, p.last_name, b.name AS branch, b.int_id AS branch_id FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.first_name = ? AND p.last_name = ? LIMIT 3', [parts[0], parts.slice(1).join(' ')]);
      }
      if (ctx.purviewBranches) hits = hits.filter((h) => ctx.purviewBranches!.includes(h.branch));
      if (!hits.length) {
        problems.push({ line: r.line, problem: `No one you can see matches “${r.member}”.` });
        continue;
      }
      if (hits.length > 1) {
        problems.push({ line: r.line, problem: `More than one person is named ${r.member}; use the member number.` });
        continue;
      }
      const h = hits[0]!;
      const open = await this.referrals.openFor(type.typeId, [h.party_id]);
      if (open.has(h.party_id)) {
        problems.push({ line: r.line, problem: `${h.first_name} ${h.last_name} already has a new ${type.label} referral.` });
        continue;
      }
      if (ready.some((x) => x.partyId === h.party_id && x.typeId === type.typeId)) {
        problems.push({ line: r.line, problem: `A repeat of an earlier row.` });
        continue;
      }
      const q = await this.queueFor(type.typeId, h.branch_id);
      ready.push({ line: r.line, partyId: h.party_id, name: `${h.first_name} ${h.last_name}`, branch: h.branch, typeId: type.typeId, typeLabel: type.label, queueId: q.queueId, queueName: q.name, ...(r.notes ? { notes: r.notes } : {}) });
    }
    return { ready, problems };
  }

  /** Creates the checked rows, one referral each; a replay of the same approval makes none twice. */
  async createBulk(ready: BulkReady[], meta: { approvalId: string; userId: string; userName: string; employeeId?: number; runId?: string }) {
    const made: number[] = [];
    for (const [i, r] of ready.entries()) {
      const x = await this.insert({ approvalId: `${meta.approvalId}:${i + 1}`.slice(0, 40), typeId: r.typeId, partyId: r.partyId, prospect: null, fields: { preferred_contact: 'Phone', uploaded: 'Yes' }, notes: r.notes, priority: 'Normal', queueId: r.queueId }, meta);
      made.push(x.comId);
    }
    return made;
  }

  /** A referral you can see, with who is copied on it. */
  async referral(comId: number, ctx: CoreContext) {
    const [r] = await rows<{ com_id: number; stage: string; priority: string; cc: unknown; type_label: string; first_name: string | null; last_name: string | null; prospect: unknown; branch: string | null }>(
      this.pool,
      `SELECT c.com_id, c.stage, c.priority, c.cc, t.label AS type_label, p.first_name, p.last_name, c.prospect, COALESCE(b.name, JSON_UNQUOTE(JSON_EXTRACT(c.prospect, '$.branch'))) AS branch
         FROM esp_com_items c JOIN mod_ref_types t ON t.type_id = c.type_id LEFT JOIN cdm_party p ON p.party_id = c.party_id LEFT JOIN cdm_location b ON b.int_id = p.primary_branch_id
        WHERE c.com_id = ? AND c.definition = 'referral'`,
      [comId],
    );
    if (!r || (ctx.purviewBranches && !ctx.purviewBranches.includes(r.branch ?? ''))) throw new CoreError('NOT_FOUND', `I can’t find referral #${comId} among those you can see.`);
    const cc = ((json(r.cc) as unknown as number[] | null) ?? []).map(Number);
    const who = r.first_name ? `${r.first_name} ${r.last_name}` : String((json(r.prospect) ?? {}).name ?? 'a prospect');
    return { comId: r.com_id, stage: r.stage, priority: r.priority, cc, typeLabel: r.type_label, who, open: !CLOSED_STAGES.includes(r.stage) };
  }

  /** Employees by name, for copying on a referral. */
  async employees(names: string[]) {
    const out: { employeeId: number; name: string }[] = [];
    for (const n of names) {
      const [e] = await rows<{ employee_id: number; display_name: string }>(this.pool, 'SELECT employee_id, display_name FROM cdm_employee WHERE LOWER(display_name) = ? OR LOWER(display_name) LIKE ? ORDER BY LOWER(display_name) = ? DESC LIMIT 1', [n.toLowerCase(), `${n.toLowerCase()}%`, n.toLowerCase()]);
      if (!e) throw new CoreError('NOT_FOUND', `There’s no one called ${n} on staff.`);
      out.push({ employeeId: e.employee_id, name: e.display_name });
    }
    return out;
  }

  async setCc(comId: number, employeeIds: number[], meta: { userId: string; userName: string }, names: string[]) {
    await this.pool.query('UPDATE esp_com_items SET cc = ? WHERE com_id = ?', [JSON.stringify([...new Set(employeeIds)]), comId]);
    await this.pool.query("INSERT INTO esp_com_lines (com_id, kind, text, by_user_id, created_at) VALUES (?, 'note', ?, ?, ?)", [comId, `${meta.userName} copied ${names.join(', ')} on this referral.`, meta.userId, sqlNow()]);
  }

  async setPriority(comId: number, priority: string, meta: { userId: string; userName: string }, from: string) {
    await this.pool.query('UPDATE esp_com_items SET priority = ? WHERE com_id = ?', [priority, comId]);
    await this.pool.query("INSERT INTO esp_com_lines (com_id, kind, text, by_user_id, created_at) VALUES (?, 'note', ?, ?, ?)", [comId, `${meta.userName} changed the priority from ${from} to ${priority}.`, meta.userId, sqlNow()]);
  }

  async saveView(userId: string, name: string, filters: Record<string, unknown>) {
    await this.pool.query('INSERT INTO ref_saved_view (user_id, name, filters, saved_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE filters = VALUES(filters), saved_at = VALUES(saved_at)', [userId, name.slice(0, 60), JSON.stringify(filters)]);
  }

  async views(userId: string) {
    return (await rows<{ name: string; filters: unknown; saved_at: unknown }>(this.pool, 'SELECT name, filters, saved_at FROM ref_saved_view WHERE user_id = ? ORDER BY name', [userId]).catch(() => [])).map((v) => ({ name: v.name, filters: json(v.filters) ?? {} }));
  }

  async view(userId: string, name: string) {
    const all = await this.views(userId);
    const n = name.trim().toLowerCase();
    return all.find((v) => v.name.toLowerCase() === n) ?? all.find((v) => v.name.toLowerCase().includes(n)) ?? null;
  }
}
