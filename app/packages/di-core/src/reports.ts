// Report store (spec 18.2, 18.8, 18.9): templates, private drafts, schedules and exports. Drafts are
// autosaved privately and are not writes (spec 8.9); saving, scheduling and exporting run only from
// an approval, once, keyed by the approval ID.
import { randomBytes } from 'node:crypto';
import type { Pool, ReportDefinition } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';

export interface TemplateRow {
  templateId: string;
  name: string;
  folder: string;
  status: 'stock' | 'published' | 'draft';
  ownerUserId: string;
  ownerName: string;
  definition: ReportDefinition;
  origin: { agent: string; approvedBy: string; approvalId: string; at: string; modelVersion?: string } | null;
  version: number;
  updatedAt: string;
}

export interface Recipient {
  name: string;
  kind: 'user' | 'group' | 'external';
  count: number;
}

export interface ScheduleDraft {
  templateId: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  /** "MON".."FRI" for weekly, "BD1".."BD5" (business day of the month) for monthly. */
  dayRule: string;
  format: 'xlsx' | 'csv' | 'pdf';
  recipients: Recipient[];
  sendIfEmpty: boolean;
  controls: Record<string, string>;
}

export interface ScheduleRow extends ScheduleDraft {
  scheduleId: number;
  templateName: string;
  ownerUserId: string;
  ownerName: string;
  recipientCount: number;
  status: 'active' | 'cancelled';
  createdAt: string;
  lastRunAt: string | null;
  lastResult: 'ok' | 'empty' | 'failed' | null;
  lastDetail: string | null;
}

export interface ExportRow {
  exportId: string;
  templateId: string;
  userId: string;
  format: 'xlsx' | 'csv';
  controls: Record<string, string>;
  createdAt: string;
}

export interface ShareDraft {
  templateId: string;
  recipients: Recipient[];
  subject: string;
  body: string;
  controls: Record<string, string>;
}

export interface ShareRow {
  shareId: string;
  recipientCount: number;
}

/** Directory of delivery groups (spec 18.9: users, classes or alert groups). Fictional. */
export const DELIVERY_GROUPS: Record<string, number> = {
  'ALCO group': 7,
  'Branch managers': 6,
  'Finance team': 4,
  'Executive team': 5,
  'All lending staff': 31,
};

/** More than this many recipients makes a schedule high risk (spec 8.8). */
export const SCHEDULE_RECIPIENT_CAP = 25;

const sqlTime = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
const iso = (s: string) => `${String(s).replace(' ', 'T')}Z`;
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

type Row = Record<string, unknown>;

export class ReportStore {
  constructor(private readonly pool: Pool) {}

  private toTemplate(r: Row): TemplateRow {
    return {
      templateId: r.template_id as string,
      name: r.name as string,
      folder: r.folder as string,
      status: r.status as TemplateRow['status'],
      ownerUserId: r.owner_user_id as string,
      ownerName: r.owner_name as string,
      definition: parse<ReportDefinition>(r.definition),
      origin: r.origin ? parse<TemplateRow['origin']>(r.origin) : null,
      version: r.version as number,
      updatedAt: iso(r.updated_at as string),
    };
  }

  /** report.template.list: stock and published reports, and the user's own drafts. */
  async list(userId: string): Promise<TemplateRow[]> {
    const [rows] = await this.pool.query("SELECT * FROM esp_report_templates WHERE status IN ('stock', 'published') OR (status = 'draft' AND owner_user_id = ?) ORDER BY folder, name", [userId]);
    return (rows as Row[]).map((r) => this.toTemplate(r));
  }

  /** report.template.get. A draft is visible only to its owner, and reads the same as a missing one. */
  async get(templateId: string, userId: string): Promise<TemplateRow> {
    const [rows] = await this.pool.query('SELECT * FROM esp_report_templates WHERE template_id = ?', [templateId]);
    const r = (rows as Row[])[0];
    // A saved draft has become a report of its own; it is no longer opened by its draft ID.
    if (!r || r.status === 'saved' || (r.status === 'draft' && r.owner_user_id !== userId)) throw new CoreError('NOT_FOUND', 'That report was not found.');
    return this.toTemplate(r);
  }

  /** Autosaves a private draft (spec 8.9: draft edits are not writes). Returns the draft's ID. */
  async saveDraft(def: ReportDefinition, user: { id: string; name: string }, threadId: string): Promise<TemplateRow> {
    const now = sqlTime(new Date());
    const templateId = def.templateId.startsWith('draft_') ? def.templateId : `draft_${randomBytes(6).toString('hex')}`;
    const body = { ...def, templateId };
    const [existing] = await this.pool.query('SELECT owner_user_id, status FROM esp_report_templates WHERE template_id = ?', [templateId]);
    const prior = (existing as Row[])[0];
    if (prior && (prior.owner_user_id !== user.id || prior.status !== 'draft')) throw new CoreError('NO_ACCESS', 'Only the owner can change this draft.');
    await this.pool.query(
      `INSERT INTO esp_report_templates (template_id, name, folder, status, owner_user_id, owner_name, definition, version, thread_id, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), folder = VALUES(folder), definition = VALUES(definition), version = version + 1, updated_at = VALUES(updated_at)`,
      [templateId, def.name, def.folder, user.id, user.name, JSON.stringify(body), threadId, now, now],
    );
    return this.get(templateId, user.id);
  }

  /**
   * report.template.create: publishes a draft into a shared folder, recording its origin (AI-AGT-052).
   * Idempotent on the approval ID: a retry returns the report the first call created.
   */
  async publish(p: { draftId: string; name: string; folder: string; definition: ReportDefinition }, meta: { approvalId: string; userId: string; userName: string; agent: string; modelVersion?: string }): Promise<TemplateRow & { replayed: boolean }> {
    const [done] = await this.pool.query('SELECT template_id FROM esp_report_templates WHERE approval_id = ?', [meta.approvalId]);
    const prior = (done as Row[])[0];
    if (prior) return { ...(await this.get(prior.template_id as string, meta.userId)), replayed: true };
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'report';
    const templateId = `${slug}_${randomBytes(3).toString('hex')}`;
    const now = new Date();
    const origin = { agent: meta.agent, approvedBy: meta.userName, approvalId: meta.approvalId, at: now.toISOString(), modelVersion: meta.modelVersion };
    const definition: ReportDefinition = { ...p.definition, templateId, name: p.name, folder: p.folder, pendingEdits: [] };
    await this.pool.query(
      `INSERT INTO esp_report_templates (template_id, name, folder, status, owner_user_id, owner_name, definition, origin, version, approval_id, created_at, updated_at)
       VALUES (?, ?, ?, 'published', ?, ?, ?, ?, 1, ?, ?, ?)`,
      [templateId, p.name, p.folder, meta.userId, meta.userName, JSON.stringify(definition), JSON.stringify(origin), meta.approvalId, sqlTime(now), sqlTime(now)],
    );
    // The draft has become the report; it no longer shows under Drafts.
    await this.pool.query("UPDATE esp_report_templates SET status = 'saved' WHERE template_id = ? AND status = 'draft' AND owner_user_id = ?", [p.draftId, meta.userId]);
    return { ...(await this.get(templateId, meta.userId)), replayed: false };
  }

  /** report.schedule.create (spec 18.9). Runs only after the nightly build; idempotent on the approval. */
  async createSchedule(d: ScheduleDraft, meta: { approvalId: string; userId: string; userName: string }): Promise<ScheduleRow & { replayed: boolean }> {
    const [done] = await this.pool.query('SELECT schedule_id FROM esp_report_schedules WHERE approval_id = ?', [meta.approvalId]);
    const prior = (done as Row[])[0];
    if (prior) return { ...(await this.schedule(prior.schedule_id as number)), replayed: true };
    await this.get(d.templateId, meta.userId);
    const count = d.recipients.reduce((s, r) => s + r.count, 0);
    const [ins] = await this.pool.query(
      `INSERT INTO esp_report_schedules (template_id, owner_user_id, owner_name, frequency, day_rule, format, recipients, recipient_count, send_if_empty, controls, status, approval_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [d.templateId, meta.userId, meta.userName, d.frequency, d.dayRule, d.format, JSON.stringify(d.recipients), count, d.sendIfEmpty ? 1 : 0, JSON.stringify(d.controls), meta.approvalId, sqlTime(new Date())],
    );
    return { ...(await this.schedule((ins as { insertId: number }).insertId)), replayed: false };
  }

  async schedule(scheduleId: number): Promise<ScheduleRow> {
    const [rows] = await this.pool.query('SELECT s.*, t.name AS template_name FROM esp_report_schedules s JOIN esp_report_templates t ON t.template_id = s.template_id WHERE s.schedule_id = ?', [scheduleId]);
    const r = (rows as Row[])[0];
    if (!r) throw new CoreError('NOT_FOUND', `Schedule ${scheduleId} not found.`);
    return {
      scheduleId: r.schedule_id as number,
      templateId: r.template_id as string,
      templateName: r.template_name as string,
      ownerUserId: r.owner_user_id as string,
      ownerName: r.owner_name as string,
      frequency: r.frequency as ScheduleRow['frequency'],
      dayRule: r.day_rule as string,
      format: r.format as ScheduleRow['format'],
      recipients: parse<Recipient[]>(r.recipients),
      recipientCount: r.recipient_count as number,
      sendIfEmpty: r.send_if_empty === 1,
      controls: parse<Record<string, string>>(r.controls),
      status: r.status as ScheduleRow['status'],
      createdAt: iso(r.created_at as string),
      lastRunAt: r.last_run_at ? iso(r.last_run_at as string) : null,
      lastResult: (r.last_result as ScheduleRow['lastResult']) ?? null,
      lastDetail: (r.last_detail as string | null) ?? null,
    };
  }

  /** report.schedule.list: the user's schedules, newest first. */
  async schedules(userId: string, includeCancelled = false): Promise<ScheduleRow[]> {
    const [rows] = await this.pool.query(`SELECT schedule_id FROM esp_report_schedules WHERE owner_user_id = ? ${includeCancelled ? '' : "AND status = 'active'"} ORDER BY schedule_id DESC`, [userId]);
    return Promise.all((rows as Row[]).map((r) => this.schedule(r.schedule_id as number)));
  }

  /** All active schedules, for the after-build runner. */
  async activeSchedules(): Promise<ScheduleRow[]> {
    const [rows] = await this.pool.query("SELECT schedule_id FROM esp_report_schedules WHERE status = 'active' ORDER BY schedule_id");
    return Promise.all((rows as Row[]).map((r) => this.schedule(r.schedule_id as number)));
  }

  async cancelSchedule(scheduleId: number, userId: string) {
    const s = await this.schedule(scheduleId);
    if (s.ownerUserId !== userId) throw new CoreError('NO_ACCESS', 'Only the owner can stop this schedule.');
    await this.pool.query("UPDATE esp_report_schedules SET status = 'cancelled' WHERE schedule_id = ? AND status = 'active'", [scheduleId]);
    return { ...s, status: 'cancelled' as const };
  }

  async recordRun(scheduleId: number, result: 'ok' | 'empty' | 'failed', detail: string) {
    await this.pool.query('UPDATE esp_report_schedules SET last_run_at = ?, last_result = ?, last_detail = ? WHERE schedule_id = ?', [sqlTime(new Date()), result, detail.slice(0, 200), scheduleId]);
  }

  /** report.export: records an approved export once; the file is rendered when it is downloaded. */
  async createExport(e: { templateId: string; format: 'xlsx' | 'csv'; controls: Record<string, string> }, meta: { approvalId: string; userId: string }): Promise<ExportRow & { replayed: boolean }> {
    const [done] = await this.pool.query('SELECT export_id FROM esp_report_exports WHERE approval_id = ?', [meta.approvalId]);
    const prior = (done as Row[])[0];
    if (prior) return { ...(await this.export(prior.export_id as string, meta.userId)), replayed: true };
    await this.get(e.templateId, meta.userId);
    const exportId = `exp_${randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 12).padEnd(12, '0')}`;
    await this.pool.query('INSERT INTO esp_report_exports (export_id, template_id, user_id, format, controls, approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [exportId, e.templateId, meta.userId, e.format, JSON.stringify(e.controls), meta.approvalId, sqlTime(new Date())]);
    return { ...(await this.export(exportId, meta.userId)), replayed: false };
  }

  /** report.share: records one delivery of a report and its note. Idempotent on the approval ID. */
  async createShare(s: ShareDraft, meta: { approvalId: string; userId: string }): Promise<ShareRow & { replayed: boolean }> {
    const [done] = await this.pool.query('SELECT share_id, recipient_count FROM esp_report_shares WHERE approval_id = ?', [meta.approvalId]);
    const prior = (done as Row[])[0];
    if (prior) return { shareId: prior.share_id as string, recipientCount: prior.recipient_count as number, replayed: true };
    await this.get(s.templateId, meta.userId);
    const shareId = `shr_${randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 12).padEnd(12, '0')}`;
    const count = s.recipients.reduce((n, r) => n + r.count, 0);
    await this.pool.query('INSERT INTO esp_report_shares (share_id, template_id, user_id, recipients, recipient_count, subject, body, controls, approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [shareId, s.templateId, meta.userId, JSON.stringify(s.recipients), count, s.subject, s.body, JSON.stringify(s.controls), meta.approvalId, sqlTime(new Date())]);
    return { shareId, recipientCount: count, replayed: false };
  }

  /** An export belongs to the user who approved it; anyone else gets "not found". */
  async export(exportId: string, userId: string): Promise<ExportRow> {
    const [rows] = await this.pool.query('SELECT * FROM esp_report_exports WHERE export_id = ? AND user_id = ?', [exportId, userId]);
    const r = (rows as Row[])[0];
    if (!r) throw new CoreError('NOT_FOUND', 'That export was not found.');
    return { exportId: r.export_id as string, templateId: r.template_id as string, userId: r.user_id as string, format: r.format as ExportRow['format'], controls: parse(r.controls), createdAt: iso(r.created_at as string) };
  }

  async countDownload(exportId: string) {
    await this.pool.query('UPDATE esp_report_exports SET downloads = downloads + 1 WHERE export_id = ?', [exportId]);
  }
}
