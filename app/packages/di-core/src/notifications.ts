// Email notifications (today's DI: new COMs, follow-up emails, the inbox each morning, report schedule
// deliveries). This demo has no mail service, so every email goes to a simulated outbox and is marked
// "sent (simulated)". Code writes the subject and body from the record: a name and a link, never an
// account number. Each person decides which kinds they get; changing that is an approved operation.
import type { Pool } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';

export type EmailKind = 'new_work' | 'updates' | 'follow_up' | 'digest' | 'report_schedule' | 'approvals';

/** The kinds, in the order people see them, and whether each is on before anyone changes it. */
export const EMAIL_KINDS: { kind: EmailKind; label: string; on: boolean }[] = [
  { kind: 'new_work', label: 'New work assigned to me', on: true },
  { kind: 'updates', label: 'Updates on work I sent', on: true },
  { kind: 'follow_up', label: 'Follow-up reminders', on: true },
  { kind: 'digest', label: 'My inbox each morning (digest)', on: false },
  { kind: 'report_schedule', label: 'Report schedule deliveries', on: true },
  { kind: 'approvals', label: 'Approvals waiting for me', on: true },
];

export const emailKindLabel = (k: string) => EMAIL_KINDS.find((x) => x.kind === k)?.label ?? k;

export const SIMULATED = 'Delivery is simulated in this demo: nothing leaves DI.';

export interface EmailRow {
  emailId: number;
  kind: EmailKind;
  toName: string;
  toAddress: string;
  subject: string;
  body: string;
  link: string;
  status: 'queued' | 'sent (simulated)';
  createdAt: string;
}

export interface EmailPref {
  kind: EmailKind;
  label: string;
  on: boolean;
  /** False while it is still the default. */
  changed: boolean;
}

export interface EmailDraft {
  userId: string;
  toName: string;
  kind: EmailKind;
  /** What happened, in a few words: "New HELOC referral: Suzanne Jackson". */
  title: string;
  detail?: string;
  /** A path in DI, such as /workflows/referrals/inbox?id=88213. */
  link: string;
  /** What the email is about; the same one is never sent twice to a person. */
  sourceRef: string;
}

const sqlTime = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : `${String(v).replace(' ', 'T')}Z`);

/** Removes anything that looks like an account, card or member number. Names and links stay. */
export const scrub = (s: string) =>
  s
    .replace(/(?:…|\.\.\.|x{2,}|\*{2,})\s?\d{3,}/gi, '[number removed]')
    .replace(/\b\d{6,}\b/g, '[number removed]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[number removed]');

/** "Dana Lee" at Harborview → dana.lee@harborview.example. Fictional, like the people. */
export const emailAddress = (name: string, domain: string) => `${name.toLowerCase().normalize('NFKD').replace(/[^a-z\s-]/g, '').trim().split(/\s+/).join('.')}@${domain}.example`;

/** The domain part for a tenant: its first word, "Harborview Federal Credit Union" → harborview. */
export const tenantDomain = (tenantName: string) => tenantName.toLowerCase().split(/\s+/)[0]!.replace(/[^a-z0-9]/g, '') || 'tenant';

/** Subject and body, written by code from the record. */
export function composeEmail(d: Pick<EmailDraft, 'toName' | 'kind' | 'title' | 'detail' | 'link'>) {
  const first = d.toName.split(' ')[0] ?? d.toName;
  const title = scrub(d.title).slice(0, 160);
  const detail = d.detail ? scrub(d.detail).slice(0, 300) : '';
  const subject = `DI: ${title}`.slice(0, 200);
  const body = [`Hi ${first},`, '', `${title}.`, ...(detail ? [detail] : []), '', `Open it in DI: ${d.link}`, '', `You get this because “${emailKindLabel(d.kind)}” is on in your email notifications. Ask DI to change that at any time.`, SIMULATED].join('\n');
  return { subject, body };
}

type Row = Record<string, unknown>;

export class EmailOutbox {
  constructor(
    private readonly pool: Pool,
    private readonly domain = 'tenant',
  ) {}

  /** The person's choices, with the default for any kind they haven't changed. */
  async prefs(userId: string): Promise<EmailPref[]> {
    const [rows] = await this.pool.query('SELECT kind, enabled FROM ntf_pref WHERE user_id = ?', [userId]);
    const set = new Map((rows as Row[]).map((r) => [r.kind as string, r.enabled === 1]));
    return EMAIL_KINDS.map((k) => ({ kind: k.kind, label: k.label, on: set.get(k.kind) ?? k.on, changed: set.has(k.kind) }));
  }

  async isOn(userId: string, kind: EmailKind) {
    return (await this.prefs(userId)).find((p) => p.kind === kind)?.on ?? false;
  }

  /** ntf.pref.set: one person's choice for one kind. Running it again changes nothing more. */
  async setPref(userId: string, kind: EmailKind, on: boolean, meta: { approvalId: string }) {
    if (!EMAIL_KINDS.some((k) => k.kind === kind)) throw new CoreError('INVALID', `There is no “${kind}” email.`);
    await this.pool.query('INSERT INTO ntf_pref (user_id, kind, enabled, approval_id, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), approval_id = VALUES(approval_id), updated_at = VALUES(updated_at)', [userId, kind, on ? 1 : 0, meta.approvalId, sqlTime(new Date())]);
  }

  /**
   * Writes one email to the outbox, if the person wants that kind, then marks it sent: delivery is
   * simulated. The same source never emails a person twice. Returns null when nothing was written.
   */
  async queue(d: EmailDraft): Promise<EmailRow | null> {
    if (!(await this.isOn(d.userId, d.kind))) return null;
    const { subject, body } = composeEmail(d);
    const now = new Date();
    const [r] = await this.pool.query(
      "INSERT IGNORE INTO ntf_email (user_id, to_name, to_address, subject, body, link, kind, source_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
      [d.userId, d.toName, emailAddress(d.toName, this.domain), subject, body, d.link.slice(0, 300), d.kind, d.sourceRef.slice(0, 160), sqlTime(now)],
    );
    const id = (r as { insertId: number; affectedRows: number }).affectedRows ? (r as { insertId: number }).insertId : 0;
    if (!id) return null;
    await this.pool.query("UPDATE ntf_email SET status = 'sent (simulated)', sent_at = ? WHERE email_id = ? AND status = 'queued'", [sqlTime(new Date()), id]);
    return (await this.recent(d.userId, { limit: 1, emailId: id }))[0] ?? null;
  }

  /** The person's own emails, newest first. Nobody reads anyone else's. */
  async recent(userId: string, opts: { since?: string; limit?: number; emailId?: number } = {}): Promise<EmailRow[]> {
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (opts.since) {
      where.push('created_at >= ?');
      params.push(opts.since);
    }
    if (opts.emailId) {
      where.push('email_id = ?');
      params.push(opts.emailId);
    }
    const [rows] = await this.pool.query(`SELECT * FROM ntf_email WHERE ${where.join(' AND ')} ORDER BY created_at DESC, email_id DESC LIMIT ?`, [...params, Math.min(opts.limit ?? 50, 200)]);
    return (rows as Row[]).map((x) => ({ emailId: x.email_id as number, kind: x.kind as EmailKind, toName: x.to_name as string, toAddress: x.to_address as string, subject: x.subject as string, body: x.body as string, link: x.link as string, status: x.status as EmailRow['status'], createdAt: iso(x.created_at) }));
  }

  /** For administrators: how many emails of each kind, to how many people. Counts only, never bodies. */
  async deliveryCounts(): Promise<{ kind: EmailKind; label: string; emails: number; people: number; latest: string | null }[]> {
    const [rows] = await this.pool.query('SELECT kind, COUNT(*) AS emails, COUNT(DISTINCT user_id) AS people, MAX(created_at) AS latest FROM ntf_email GROUP BY kind');
    const by = new Map((rows as Row[]).map((r) => [r.kind as string, r]));
    return EMAIL_KINDS.map((k) => {
      const r = by.get(k.kind);
      return { kind: k.kind, label: k.label, emails: Number(r?.emails ?? 0), people: Number(r?.people ?? 0), latest: r?.latest ? iso(r.latest) : null };
    });
  }

  /** How many people turned each kind off (or on, for the digest), for the same admin view. */
  async prefCounts(): Promise<Record<string, { on: number; off: number }>> {
    const [rows] = await this.pool.query('SELECT kind, SUM(enabled = 1) AS on_n, SUM(enabled = 0) AS off_n FROM ntf_pref GROUP BY kind');
    return Object.fromEntries((rows as Row[]).map((r) => [r.kind as string, { on: Number(r.on_n), off: Number(r.off_n) }]));
  }
}
