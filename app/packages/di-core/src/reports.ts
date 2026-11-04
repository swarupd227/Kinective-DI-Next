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
  status: 'stock' | 'published' | 'draft' | 'binned';
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

/** A report on Home. `audience` is 'me' or a user class, such as "Manager". */
export interface PinDraft {
  templateId: string;
  audience: string;
}

export interface PinRow extends PinDraft {
  pinId: string;
  templateName: string;
  pinnedBy: string;
  pinnedById: string;
  createdAt: string;
}

/** Who is looking: their user class decides whether a report limited to some classes opens for them. */
export interface Viewer {
  userClass?: string;
}

/** The settings a saved report's owner can change by asking DI (today's DI Build Reports form). */
export interface SettingsPayload {
  templateId: string;
  templateName: string;
  /** Only the fields that change, as they were and as they become. */
  before: SettingsFields;
  after: SettingsFields;
}

export interface SettingsFields {
  name?: string;
  description?: string;
  periodType?: 'month' | 'quarter';
  usePeriod?: 'current' | 'previous';
  addHierarchyControls?: boolean;
  addHistoryControls?: boolean;
  controlClasses?: string[];
  enabled?: boolean;
  showQueries?: boolean;
}

export interface SettingsChangeRow {
  changeId: number;
  templateId: string;
  userName: string;
  createdAt: string;
  after: SettingsFields;
}

/**
 * Whether someone other than the owner may see a saved report: it must be turned on, and if it is
 * limited to some user classes, theirs must be one. Anything else reads as not found. Stock reports
 * keep DI's class list for reference only, so every Report Viewer opens them.
 */
export function openableBy(t: Pick<TemplateRow, 'status' | 'ownerUserId' | 'definition'>, userId: string, viewer: Viewer = {}) {
  if (t.status !== 'published' || t.ownerUserId === userId) return true;
  const s = t.definition.settings;
  if (s.enabled === false) return false;
  return !s.controlClasses?.length || (viewer.userClass !== undefined && s.controlClasses.includes(viewer.userClass));
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
  async list(userId: string, viewer: Viewer = {}): Promise<TemplateRow[]> {
    const [rows] = await this.pool.query("SELECT * FROM esp_report_templates WHERE status IN ('stock', 'published') OR (status = 'draft' AND owner_user_id = ?) ORDER BY folder, name", [userId]);
    // A report turned off, or limited to classes the viewer isn't in, isn't listed for them.
    return (rows as Row[]).map((r) => this.toTemplate(r)).filter((t) => openableBy(t, userId, viewer));
  }

  /** report.template.get. A draft is visible only to its owner, and reads the same as a missing one. */
  async get(templateId: string, userId: string, viewer: Viewer = {}): Promise<TemplateRow> {
    const [rows] = await this.pool.query('SELECT * FROM esp_report_templates WHERE template_id = ?', [templateId]);
    const r = (rows as Row[])[0];
    // A saved draft has become a report of its own; it is no longer opened by its draft ID.
    if (!r || r.status === 'saved' || r.status === 'binned' || (r.status === 'draft' && r.owner_user_id !== userId)) throw new CoreError('NOT_FOUND', 'That report was not found.');
    const t = this.toTemplate(r);
    if (!openableBy(t, userId, viewer)) throw new CoreError('NOT_FOUND', 'That report was not found.');
    return t;
  }

  /**
   * report.settings.update: the owner's approved change to a saved report's settings. Only the fields
   * in the approval change; idempotent on the approval ID, so a retry changes nothing more.
   */
  async updateSettings(p: SettingsPayload, meta: { approvalId: string; userId: string; userName: string }): Promise<TemplateRow & { replayed: boolean }> {
    const [done] = await this.pool.query('SELECT change_id FROM esp_report_setting_changes WHERE approval_id = ?', [meta.approvalId]);
    if ((done as Row[]).length) return { ...(await this.get(p.templateId, meta.userId)), replayed: true };
    const t = await this.get(p.templateId, meta.userId);
    if (t.status !== 'published' || t.ownerUserId !== meta.userId) throw new CoreError('NO_ACCESS', 'Only the owner of a saved report can change its settings.');
    const { name, description, ...settings } = p.after;
    const definition: ReportDefinition = { ...t.definition, name: name ?? t.definition.name, description: description ?? t.definition.description, settings: { ...t.definition.settings, ...settings } };
    const now = sqlTime(new Date());
    // The change row goes first: its unique approval ID stops a second apply racing this one.
    await this.pool.query('INSERT INTO esp_report_setting_changes (template_id, user_id, user_name, before_settings, after_settings, approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [t.templateId, meta.userId, meta.userName, JSON.stringify(p.before), JSON.stringify(p.after), meta.approvalId, now]);
    await this.pool.query("UPDATE esp_report_templates SET name = ?, definition = ?, version = version + 1, updated_at = ? WHERE template_id = ? AND status = 'published'", [definition.name, JSON.stringify(definition), now, t.templateId]);
    return { ...(await this.get(t.templateId, meta.userId)), replayed: false };
  }

  /** The latest approved settings change to a report, for its Settings view. */
  async lastSettingsChange(templateId: string): Promise<SettingsChangeRow | null> {
    const [rows] = await this.pool.query('SELECT * FROM esp_report_setting_changes WHERE template_id = ? ORDER BY change_id DESC LIMIT 1', [templateId]).catch(() => [[]]);
    const r = (rows as Row[])[0];
    return r ? { changeId: r.change_id as number, templateId: r.template_id as string, userName: r.user_name as string, createdAt: iso(r.created_at as string), after: parse<SettingsFields>(r.after_settings) } : null;
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

  // ---- Home and the Recycle Bin -----------------------------------------------------------------

  /** Reports on Home for this person: their own pins and those for their user class, newest first. */
  async pins(userId: string, userClass: string | undefined): Promise<PinRow[]> {
    const [rows] = await this.pool.query(
      `SELECT p.*, t.name, t.status AS t_status, t.owner_user_id AS t_owner, t.definition AS t_definition FROM esp_report_pins p JOIN esp_report_templates t ON t.template_id = p.template_id
       WHERE p.removed_at IS NULL AND t.status IN ('stock', 'published') AND ((p.audience = 'me' AND p.user_id = ?) OR p.audience = ?)
       ORDER BY p.created_at DESC`,
      [userId, userClass ?? '-'],
    );
    const seen = new Set<string>();
    return (rows as Row[])
      // A report turned off, or limited to other classes, leaves this person's Home with it.
      .filter((r) => openableBy({ status: r.t_status as TemplateRow['status'], ownerUserId: r.t_owner as string, definition: parse<ReportDefinition>(r.t_definition) }, userId, { userClass }))
      .map((r) => ({ pinId: r.pin_id as string, templateId: r.template_id as string, templateName: r.name as string, audience: r.audience as string, pinnedBy: r.user_name as string, pinnedById: r.user_id as string, createdAt: iso(r.created_at as string) }))
      .filter((p) => !seen.has(p.templateId) && seen.add(p.templateId));
  }

  /** Every live pin of one report, whoever made it: what "take it off Home" would remove. */
  async pinsOf(templateId: string): Promise<PinRow[]> {
    const [rows] = await this.pool.query("SELECT p.*, t.name FROM esp_report_pins p JOIN esp_report_templates t ON t.template_id = p.template_id WHERE p.template_id = ? AND p.removed_at IS NULL", [templateId]);
    return (rows as Row[]).map((r) => ({ pinId: r.pin_id as string, templateId: r.template_id as string, templateName: r.name as string, audience: r.audience as string, pinnedBy: r.user_name as string, pinnedById: r.user_id as string, createdAt: iso(r.created_at as string) }));
  }

  /** report.pin: puts a report on Home. Idempotent on the approval ID; an existing identical pin is kept. */
  async pin(p: PinDraft, meta: { approvalId: string; userId: string; userName: string }): Promise<{ pinId: string; replayed: boolean }> {
    const [done] = await this.pool.query('SELECT pin_id FROM esp_report_pins WHERE approval_id = ?', [meta.approvalId]);
    const prior = (done as Row[])[0];
    if (prior) return { pinId: prior.pin_id as string, replayed: true };
    const t = await this.get(p.templateId, meta.userId);
    if (t.status === 'draft') throw new CoreError('INVALID', 'Save the draft before putting it on Home.');
    const [same] = await this.pool.query("SELECT pin_id FROM esp_report_pins WHERE template_id = ? AND audience = ? AND removed_at IS NULL AND (audience <> 'me' OR user_id = ?)", [p.templateId, p.audience, meta.userId]);
    const existing = (same as Row[])[0];
    if (existing) return { pinId: existing.pin_id as string, replayed: true };
    const pinId = `pin_${randomBytes(6).toString('hex')}`;
    await this.pool.query('INSERT INTO esp_report_pins (pin_id, template_id, user_id, user_name, audience, approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [pinId, p.templateId, meta.userId, meta.userName, p.audience, meta.approvalId, sqlTime(new Date())]);
    return { pinId, replayed: false };
  }

  /** report.unpin: takes the named pins off Home. Removing a removed pin changes nothing. */
  async unpin(pinIds: string[], meta: { approvalId: string }): Promise<number> {
    if (!pinIds.length) return 0;
    const [r] = await this.pool.query('UPDATE esp_report_pins SET removed_at = ?, removed_approval_id = ? WHERE pin_id IN (?) AND removed_at IS NULL', [sqlTime(new Date()), meta.approvalId, pinIds]);
    return (r as { affectedRows: number }).affectedRows;
  }

  /** The user's own saved reports in the Recycle Bin. */
  async bin(userId: string): Promise<TemplateRow[]> {
    const [rows] = await this.pool.query("SELECT * FROM esp_report_templates WHERE status = 'binned' AND owner_user_id = ? ORDER BY updated_at DESC", [userId]);
    return (rows as Row[]).map((r) => this.toTemplate(r));
  }

  /** report.delete: moves the owner's saved report to the Recycle Bin, and off every Home. Never a hard delete. */
  async toBin(templateId: string, meta: { approvalId: string; userId: string }): Promise<TemplateRow> {
    const [rows] = await this.pool.query('SELECT * FROM esp_report_templates WHERE template_id = ?', [templateId]);
    const r = (rows as Row[])[0];
    if (!r || r.owner_user_id !== meta.userId || !['published', 'binned'].includes(r.status as string)) throw new CoreError('NOT_FOUND', 'That report was not found among your saved reports.');
    await this.pool.query("UPDATE esp_report_templates SET status = 'binned', updated_at = ? WHERE template_id = ? AND status = 'published'", [sqlTime(new Date()), templateId]);
    await this.pool.query('UPDATE esp_report_pins SET removed_at = ?, removed_approval_id = ? WHERE template_id = ? AND removed_at IS NULL', [sqlTime(new Date()), meta.approvalId, templateId]);
    return this.toTemplate({ ...r, status: 'binned' });
  }

  /** report.restore: brings the owner's report back from the Recycle Bin to its folder. Pins stay removed. */
  async restore(templateId: string, meta: { userId: string }): Promise<TemplateRow> {
    const [rows] = await this.pool.query('SELECT * FROM esp_report_templates WHERE template_id = ?', [templateId]);
    const r = (rows as Row[])[0];
    if (!r || r.owner_user_id !== meta.userId || !['published', 'binned'].includes(r.status as string)) throw new CoreError('NOT_FOUND', 'That report is not in your Recycle Bin.');
    await this.pool.query("UPDATE esp_report_templates SET status = 'published', updated_at = ? WHERE template_id = ? AND status = 'binned'", [sqlTime(new Date()), templateId]);
    return this.toTemplate({ ...r, status: 'published' });
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
