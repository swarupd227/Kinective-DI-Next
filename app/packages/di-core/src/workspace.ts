// DI Core for the workspace apps: the calendar (spec 8.14), the file library (8.15) and read-only
// queries (8.10). The calendar is built from work that already has a date, and the events people
// add through approved changes. Uploads are checked here and kept out of every folder until a save
// is approved. A query runs only as a
// single SELECT over curated tables, on the read-only account, and every limit is enforced here.
import type { Pool } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

// ---- calendar -----------------------------------------------------------------------------------

export interface CalendarEvent {
  date: string;
  kind: 'Event' | 'Touch point' | 'Issue due' | 'Certificates' | 'Payouts';
  title: string;
  detail: string;
  late: boolean;
  ask: string;
}

interface TouchSource {
  list(f: { employeeId?: number; withinDays?: number }, ctx: never): Promise<{ asOf: string; items: { member: string; touch: string; due: string; state: string; assignee: string | null; branch: string; daysLate: number }[] }>;
}
interface IssueSource {
  list(f: Record<string, never>, ctx: never): Promise<{ items: { issueId: number; member: string; category: string; resolveBy: string; overdue: boolean; branch: string }[] }>;
}
interface CertificateSource {
  maturing(f: { days: number }, ctx: never): Promise<{ items: { matures: string; amount: number }[] }>;
}
interface MeetingSource {
  forUser(userId: string): Promise<Meeting[]>;
}

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

export class CalendarService {
  constructor(private readonly sources: { onboarding: TouchSource; issues: IssueSource; retention: CertificateSource; meetings?: MeetingSource | null }) {}

  /** Dated work inside the purview, and the person's own events. A source this person can't use is left out, not an error. */
  async events(input: { employeeId?: number; userId?: string; canUse: (source: 'onboarding' | 'compliance' | 'retention') => boolean; ctx: unknown }) {
    const ctx = input.ctx as never;
    const empty = { asOf: '', items: [] };
    const [touch, issues, certificates, meetings] = await Promise.all([input.canUse('onboarding') ? this.sources.onboarding.list({ employeeId: input.employeeId, withinDays: 45 }, ctx) : empty, input.canUse('compliance') ? this.sources.issues.list({}, ctx) : { items: [] }, input.canUse('retention') ? this.sources.retention.maturing({ days: 45 }, ctx) : { items: [] }, input.userId && this.sources.meetings ? this.sources.meetings.forUser(input.userId) : []]);
    const events: CalendarEvent[] = [
      ...meetings.map((m): CalendarEvent => ({ date: m.startsAt.slice(0, 10), kind: 'Event', title: `${clock(m.startsAt.slice(11))} ${m.title}`, detail: [m.ownerUserId === input.userId ? (m.withWhom ? `With ${m.withWhom}` : 'Your calendar') : `From ${m.ownerName}`, m.source].filter(Boolean).join(' · '), late: false, ask: 'What’s on my calendar this week?' })),
      ...touch.items.map((t): CalendarEvent => ({ date: t.due, kind: 'Touch point', title: `${t.member}: ${t.touch.toLowerCase()}`, detail: `${t.branch}, ${t.assignee ?? 'branch queue'}`, late: t.daysLate > 0, ask: 'Show my overdue onboarding touch points' })),
      ...issues.items.map((i): CalendarEvent => ({ date: i.resolveBy, kind: 'Issue due', title: `Issue #${i.issueId}: ${i.category}`, detail: `${i.member}, ${i.branch}`, late: i.overdue, ask: `Show issue #${i.issueId}` })),
    ];
    const byDay = new Map<string, { count: number; total: number }>();
    for (const c of certificates.items) {
      const d = byDay.get(c.matures) ?? { count: 0, total: 0 };
      byDay.set(c.matures, { count: d.count + 1, total: d.total + c.amount });
    }
    for (const [date, d] of byDay) events.push({ date, kind: 'Certificates', title: `${d.count} ${d.count === 1 ? 'certificate matures' : 'certificates mature'}`, detail: money(d.total), late: false, ask: 'Find certificates at risk of leaving' });
    return events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }
}

// ---- calendar events ----------------------------------------------------------------------------

export interface Meeting {
  eventId: number;
  ownerUserId: string;
  ownerName: string;
  title: string;
  /** Local time, "YYYY-MM-DD HH:MM". */
  startsAt: string;
  endsAt: string;
  withWhom: string | null;
  withUserId: string | null;
  source: string | null;
  link: string | null;
}

/** "14:00" as "2 pm", "09:30" as "9:30 am". */
export function clock(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}

const MEETING_COLUMNS = "event_id, owner_user_id, owner_name, title, DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i') AS starts_at, DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i') AS ends_at, with_whom, with_user_id, source, link";
const toMeeting = (r: Record<string, unknown>): Meeting => ({ eventId: r.event_id as number, ownerUserId: r.owner_user_id as string, ownerName: r.owner_name as string, title: r.title as string, startsAt: r.starts_at as string, endsAt: r.ends_at as string, withWhom: (r.with_whom as string | null) ?? null, withUserId: (r.with_user_id as string | null) ?? null, source: (r.source as string | null) ?? null, link: (r.link as string | null) ?? null });
const eventWords = (t: string) => t.toLowerCase().replace(/[-–—:]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['the', 'and', 'with', 'for', 'about', 'event', 'meeting', 'appointment'].includes(w));

/** Events people put on their calendar. Someone else's reads as not found, unless they're invited to it. */
export class CalendarStore {
  constructor(private readonly pool: Pool) {}

  /** What a person sees: their own scheduled events and the ones they're invited to. */
  async forUser(userId: string) {
    return (await rows<Record<string, unknown>>(this.pool, `SELECT ${MEETING_COLUMNS} FROM cal_event WHERE status = 'Scheduled' AND (owner_user_id = ? OR with_user_id = ?) ORDER BY starts_at`, [userId, userId])).map(toMeeting);
  }

  /** One of the person's own scheduled events, by words in it and optionally its day or time. */
  async own(userId: string, q: { text: string; date?: string; time?: string; today: string }) {
    const want = eventWords(q.text);
    const fits = (m: Meeting) => (!q.date || m.startsAt.startsWith(q.date)) && (!q.time || m.startsAt.slice(11) === q.time) && want.every((w) => eventWords(`${m.title} ${m.withWhom ?? ''} ${m.source ?? ''}`).some((x) => x.startsWith(w) || w.startsWith(x)));
    const seen = (await this.forUser(userId)).filter(fits);
    const mine = seen.filter((m) => m.ownerUserId === userId);
    if (!mine.length && seen[0]) throw new CoreError('INVALID', `${seen[0].title} is ${seen[0].ownerName}’s event, so I can’t change it. Ask ${seen[0].ownerName.split(' ')[0]} to.`);
    // "My 3 pm dealer visit" means the next one, when there is one.
    const upcoming = mine.filter((m) => m.startsAt.slice(0, 10) >= q.today);
    const hits = upcoming.length ? upcoming : mine;
    if (!hits.length) throw new CoreError('NOT_FOUND', `You have no scheduled event matching “${q.text}”.`);
    if (hits.length > 1) throw new CoreError('INVALID', `${hits.length} of your events match: ${hits.slice(0, 4).map((m) => `${m.title} on ${m.startsAt.slice(0, 10)} at ${clock(m.startsAt.slice(11))}`).join('; ')}. Which one?`);
    return hits[0]!;
  }

  async create(p: { owner: { userId: string; name: string }; title: string; startsAt: string; endsAt: string; withWhom: string | null; withUserId: string | null; source: string | null; link: string | null }, meta: { approvalId: string; on: string }) {
    await this.pool.query("INSERT IGNORE INTO cal_event (owner_user_id, owner_name, title, starts_at, ends_at, with_whom, with_user_id, source, link, status, created_at, approval_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?, ?)", [p.owner.userId, p.owner.name, p.title.slice(0, 160), `${p.startsAt}:00`, `${p.endsAt}:00`, p.withWhom, p.withUserId, p.source, p.link, meta.on, meta.approvalId]);
  }

  /** Moves only from the time the card showed, so a second apply changes nothing. */
  async move(p: { eventId: number; from: string; startsAt: string; endsAt: string }) {
    await this.pool.query("UPDATE cal_event SET starts_at = ?, ends_at = ? WHERE event_id = ? AND starts_at = ? AND status = 'Scheduled'", [`${p.startsAt}:00`, `${p.endsAt}:00`, p.eventId, `${p.from}:00`]);
  }

  async cancel(eventId: number) {
    await this.pool.query("UPDATE cal_event SET status = 'Cancelled' WHERE event_id = ? AND status = 'Scheduled'", [eventId]);
  }
}

// ---- files --------------------------------------------------------------------------------------

export interface LibraryFile {
  name: string;
  folder: string;
  type: string;
  sizeKb: number;
  owner: string;
  modified: string;
  /** An upload, which has content. The demo library's entries have none. */
  fileId?: number;
  ownerUserId?: string;
}

/** Each person's own folder. Everything else is shared. */
export const MY_FILES = 'My Files';

export const FILE_FOLDERS: Record<string, string> = { [MY_FILES]: 'Only you', 'Board Packs': 'Executives and the DI administrator', 'Compliance/Policies': 'Everyone at the institution', 'Lending/Dealer Docs': 'Lending staff', 'Finance/ALCO': 'Finance and executives', Marketing: 'Everyone at the institution' };

/** What a restricted folder needs in the person's module list. The others are open to everyone with Files. */
const FOLDER_NEEDS: Record<string, string> = { 'Board Packs': 'files-board', 'Lending/Dealer Docs': 'files-lending', 'Finance/ALCO': 'files-finance' };

/** The folders a person can see. Outside them, a file reads as not found. */
export const foldersFor = (modules: string[]) => (modules.includes('files') ? Object.keys(FILE_FOLDERS).filter((f) => !FOLDER_NEEDS[f] || modules.includes(FOLDER_NEEDS[f])) : []);

/** "Lending > Dealer Docs", "the dealer docs folder" or "my files", as a folder's name. */
export function folderNamed(text: string) {
  const t = text.toLowerCase().replace(/\s*[>/\\]\s*/g, '/');
  if (/\bmy (own )?(files|folder)\b/.test(t)) return MY_FILES;
  const all = Object.keys(FILE_FOLDERS);
  return all.find((f) => t.includes(f.toLowerCase())) ?? all.find((f) => t.includes(f.split('/').at(-1)!.toLowerCase()));
}

/** Demo documents. Their names and sizes are listed; the contents don't exist. */
export const FILE_LIBRARY: LibraryFile[] = [
  { name: 'October board pack.pdf', folder: 'Board Packs', type: 'PDF', sizeKb: 4180, owner: 'Dana Lee', modified: '2026-10-22' },
  { name: 'September board pack.pdf', folder: 'Board Packs', type: 'PDF', sizeKb: 3925, owner: 'Dana Lee', modified: '2026-09-24' },
  { name: 'Board minutes Q3.docx', folder: 'Board Packs', type: 'Word', sizeKb: 212, owner: 'Dana Lee', modified: '2026-10-02' },
  { name: 'BSA and AML policy 2026.pdf', folder: 'Compliance/Policies', type: 'PDF', sizeKb: 860, owner: 'Priya Shah', modified: '2026-03-11' },
  { name: 'Complaint handling procedure.pdf', folder: 'Compliance/Policies', type: 'PDF', sizeKb: 340, owner: 'Priya Shah', modified: '2026-06-19' },
  { name: 'Reg E dispute checklist.docx', folder: 'Compliance/Policies', type: 'Word', sizeKb: 96, owner: 'Priya Shah', modified: '2026-08-05' },
  { name: 'Smith Ford dealer agreement.pdf', folder: 'Lending/Dealer Docs', type: 'PDF', sizeKb: 1240, owner: 'Marcus Reed', modified: '2026-05-14' },
  { name: 'Lakeside Honda dealer agreement.pdf', folder: 'Lending/Dealer Docs', type: 'PDF', sizeKb: 1190, owner: 'Marcus Reed', modified: '2026-07-01' },
  { name: 'Indirect rate sheet October.xlsx', folder: 'Lending/Dealer Docs', type: 'Excel', sizeKb: 58, owner: 'Marcus Reed', modified: '2026-10-01' },
  { name: 'ALCO pack Q3.pdf', folder: 'Finance/ALCO', type: 'PDF', sizeKb: 2310, owner: 'Dana Lee', modified: '2026-10-09' },
  { name: 'Liquidity stress test Q3.xlsx', folder: 'Finance/ALCO', type: 'Excel', sizeKb: 410, owner: 'Priya Shah', modified: '2026-10-07' },
  { name: 'HELOC fall campaign brief.pdf', folder: 'Marketing', type: 'PDF', sizeKb: 720, owner: 'Priya Shah', modified: '2026-08-28' },
];

const searchWords = (query: string) => query.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !['the', 'for', 'file', 'files', 'find', 'our', 'and', 'folder', 'document', 'documents'].includes(w));

/** Library documents matching any word, within the given folders when there are some. */
export function findFiles(query: string, folders?: string[]) {
  const words = searchWords(query);
  return FILE_LIBRARY.filter((f) => (!folders || folders.includes(f.folder)) && words.some((w) => `${f.name} ${f.folder} ${f.owner}`.toLowerCase().includes(w)));
}

// What can be uploaded (spec 8.15): checked by extension and by the file's first bytes, never by the
// type the browser claims. Text files must not hold binary. Nothing is virus scanned.
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0];
const FILE_TYPES: Record<string, { type: string; mime: string; magic?: number[] }> = {
  pdf: { type: 'PDF', mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  png: { type: 'Image', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { type: 'Image', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  jpeg: { type: 'Image', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  gif: { type: 'Image', mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  webp: { type: 'Image', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
  docx: { type: 'Word', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: ZIP },
  xlsx: { type: 'Excel', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: ZIP },
  pptx: { type: 'PowerPoint', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: ZIP },
  doc: { type: 'Word', mime: 'application/msword', magic: OLE },
  xls: { type: 'Excel', mime: 'application/vnd.ms-excel', magic: OLE },
  ppt: { type: 'PowerPoint', mime: 'application/vnd.ms-powerpoint', magic: OLE },
  csv: { type: 'CSV', mime: 'text/csv' },
  txt: { type: 'Text', mime: 'text/plain' },
};
export const UPLOAD_EXTENSIONS = Object.keys(FILE_TYPES);
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The file's type, or a plain refusal naming what's wrong. */
export function checkUpload(rawName: string, body: Buffer) {
  // No path, and none of the characters a file name can't hold, control characters included.
  const name = [...rawName.replace(/^.*[\\/]/, '')].filter((c) => c.charCodeAt(0) >= 32 && !'<>:"|?*'.includes(c)).join('').trim().slice(0, 200);
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const kind = FILE_TYPES[ext];
  const refuse = (message: string) => new CoreError('INVALID', message);
  if (!name || !kind) throw refuse('Only PDF, image, Office, CSV and text files can be uploaded.');
  if (!body.length) throw refuse('That file is empty.');
  if (body.length > MAX_UPLOAD_BYTES) throw refuse(`That file is ${(body.length / 1024 / 1024).toFixed(1)} MB. Files can be up to 5 MB.`);
  if (kind.magic && !kind.magic.every((b, i) => body[i] === b)) throw refuse(`That file doesn’t look like a ${kind.type} file, so it can’t be uploaded.`);
  if (!kind.magic && body.subarray(0, 8192).includes(0)) throw refuse('That file holds binary data, so it can’t be uploaded as text.');
  return { name, type: kind.type, mime: kind.mime, sizeKb: Math.max(1, Math.ceil(body.length / 1024)) };
}

const toFile = (r: Record<string, unknown>): LibraryFile => ({ fileId: r.file_id as number, name: r.name as string, folder: r.folder as string, type: r.type as string, sizeKb: r.size_kb as number, owner: r.owner as string, ownerUserId: r.owner_user_id as string, modified: r.modified as string });
const FILE_COLUMNS = "file_id, name, folder, type, size_kb, owner, owner_user_id, DATE_FORMAT(modified, '%Y-%m-%d') AS modified";

/** Uploaded files. A staged upload is the uploader's alone until a save is approved. */
export class FileStore {
  constructor(private readonly pool: Pool) {}

  /** Saved files in the folders this person can see; My Files only their own. */
  private visible(userId: string, folders: string[]) {
    const shared = folders.filter((f) => f !== MY_FILES);
    return { sql: `status = 'Saved' AND ((folder = ? AND owner_user_id = ? AND ?) OR folder IN (?))`, params: [MY_FILES, userId, folders.includes(MY_FILES), shared.length ? shared : ['']] };
  }

  /** Keeps an upload as Staged. It isn't in any folder until a save is approved. */
  async stage(p: { name: string; body: Buffer; owner: { userId: string; name: string }; on: string }) {
    const f = checkUpload(p.name, p.body);
    const [r] = (await this.pool.query("INSERT INTO fil_file (name, folder, type, mime, size_kb, owner, owner_user_id, modified, status, staged_at, content) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'Staged', NOW(), ?)", [f.name, f.type, f.mime, f.sizeKb, p.owner.name, p.owner.userId, p.on, p.body])) as unknown as [{ insertId: number }];
    return { fileId: r.insertId, name: f.name, type: f.type, sizeKb: f.sizeKb };
  }

  /** The person's newest upload waiting to be saved, from the last day, by name when given. */
  async staged(userId: string, name?: string) {
    const all = await rows<Record<string, unknown>>(this.pool, "SELECT file_id, name, type, size_kb FROM fil_file WHERE owner_user_id = ? AND status = 'Staged' AND staged_at >= NOW() - INTERVAL 1 DAY ORDER BY file_id DESC", [userId]);
    const want = name ? searchWords(name.replace(/\.[a-z0-9]+$/i, '')) : [];
    const hit = all.find((f) => want.every((w) => String(f.name).toLowerCase().includes(w)));
    if (!hit) throw new CoreError('NOT_FOUND', name && all.length ? `None of the files you uploaded today is called “${name}”.` : 'There’s no uploaded file waiting to be saved. Choose one on the Files page first; I can’t save a file I haven’t received.');
    return { fileId: hit.file_id as number, name: hit.name as string, type: hit.type as string, sizeKb: hit.size_kb as number };
  }

  /** Files a save once: a second apply finds nothing Staged. */
  async save(p: { fileId: number; folder: string }, meta: { approvalId: string; on: string }) {
    await this.pool.query("UPDATE fil_file SET status = 'Saved', folder = ?, modified = ?, approval_id = ? WHERE file_id = ? AND status = 'Staged'", [p.folder, meta.on, meta.approvalId, p.fileId]);
  }

  async list(userId: string, folders: string[]) {
    const v = this.visible(userId, folders);
    return (await rows<Record<string, unknown>>(this.pool, `SELECT ${FILE_COLUMNS} FROM fil_file WHERE ${v.sql} ORDER BY modified DESC, file_id DESC`, v.params)).map(toFile);
  }

  /** Uploads and library documents matching the words, within the folders this person can see. */
  async find(userId: string, folders: string[], query: string) {
    const words = searchWords(query);
    const uploads = (await this.list(userId, folders)).filter((f) => words.some((w) => `${f.name} ${f.folder} ${f.owner}`.toLowerCase().includes(w)));
    return [...uploads, ...findFiles(query, folders)];
  }

  /** One upload this person can see, by the words of its name. A library document can't be changed. */
  async one(userId: string, folders: string[], name: string) {
    const words = searchWords(name.replace(/\.[a-z0-9]+$/i, ''));
    const fits = (f: LibraryFile) => words.length > 0 && words.every((w) => f.name.toLowerCase().includes(w));
    const hits = (await this.list(userId, folders)).filter(fits);
    if (hits.length > 1) throw new CoreError('INVALID', `${hits.length} files match: ${hits.slice(0, 4).map((f) => `${f.name} in ${f.folder}`).join('; ')}. Which one?`);
    if (hits[0]) return hits[0];
    const sample = FILE_LIBRARY.find((f) => folders.includes(f.folder) && fits(f));
    if (sample) throw new CoreError('INVALID', `${sample.name} is a sample document with no content, so it can’t be moved or deleted.`);
    throw new CoreError('NOT_FOUND', `I couldn’t find a file called “${name}” in your folders. Files outside your access don’t show.`);
  }

  /** Moves only from the folder the card showed, so a second apply changes nothing. */
  async move(p: { fileId: number; from: string; to: string }, meta: { on: string }) {
    await this.pool.query("UPDATE fil_file SET folder = ?, modified = ? WHERE file_id = ? AND folder = ? AND status = 'Saved'", [p.to, meta.on, p.fileId, p.from]);
  }

  /** To the Recycle Bin, keeping the folder it came from. Nothing is ever hard deleted. */
  async recycle(p: { fileId: number; from: string }) {
    await this.pool.query("UPDATE fil_file SET status = 'Recycle Bin', previous_folder = folder WHERE file_id = ? AND folder = ? AND status = 'Saved'", [p.fileId, p.from]);
  }

  /** The bytes of an upload this person can see; null for anything else. */
  async content(userId: string, folders: string[], fileId: number) {
    const v = this.visible(userId, folders);
    const [f] = await rows<{ name: string; mime: string; content: Buffer }>(this.pool, `SELECT name, mime, content FROM fil_file WHERE file_id = ? AND ${v.sql}`, [fileId, ...v.params]);
    return f ? { name: f.name, mime: f.mime, body: f.content } : null;
  }
}

// ---- queries ------------------------------------------------------------------------------------

export interface SavedQuery {
  name: string;
  folder: string;
  description: string;
  sql: string;
}

export const SAVED_QUERIES: SavedQuery[] = [
  { name: 'Loans by branch', folder: 'Lending', description: 'Open loans and balance at each branch.', sql: 'SELECT b.name AS branch, COUNT(*) AS loans, SUM(l.balance) AS balance\nFROM cdm_loan l\nJOIN cdm_location b ON b.int_id = l.branch_id\nWHERE l.close_date IS NULL\nGROUP BY b.name\nORDER BY balance DESC' },
  { name: 'Delinquent by category', folder: 'Lending', description: 'Balance 60 or more days past due, by loan category.', sql: 'SELECT loan_category, COUNT(*) AS loans, SUM(balance) AS balance\nFROM cdm_loan\nWHERE close_date IS NULL AND days_delinquent >= 60\nGROUP BY loan_category\nORDER BY balance DESC' },
  { name: 'Certificates by month', folder: 'Deposits', description: 'Certificate balance by maturity month.', sql: "SELECT DATE_FORMAT(maturity_date, '%Y-%m') AS month, COUNT(*) AS accounts, SUM(balance) AS balance\nFROM cdm_deposit_account\nWHERE maturity_date IS NOT NULL AND close_date IS NULL\nGROUP BY month\nORDER BY month\nLIMIT 12" },
  { name: 'New members by branch', folder: 'Membership', description: 'Members who joined in the last 90 days of data.', sql: "SELECT b.name AS branch, COUNT(*) AS new_members\nFROM cdm_party p\nJOIN cdm_location b ON b.int_id = p.primary_branch_id\nWHERE p.join_date >= DATE_SUB('2026-10-25', INTERVAL 90 DAY)\nGROUP BY b.name\nORDER BY new_members DESC" },
];

/** Curated tables only. Contact details, interactions and everything operational stay out. */
const CURATED = /^(cdm_(location|employee|party|loan|deposit_account)|hist_\w+_month)$/;
const SENSITIVE = /\b(birth_date|household_id|email|phone|ssn|tax_id)\b/i;
const FORBIDDEN = /\b(into|outfile|dumpfile|for\s+update|lock\s+in|sleep|benchmark|load_file|get_lock|information_schema|performance_schema|mysql|sys)\b/i;
const MAX_ROWS = 500;

export interface QueryResult {
  statementType: 'SELECT';
  tables: string[];
  columns: string[];
  rows: Record<string, string | number | null>[];
  truncated: boolean;
}

export class QueryService {
  constructor(private readonly pool: Pool) {}

  /** Refuses anything but one SELECT over curated tables, naming what's wrong. */
  private async check(input: string) {
    const sql = input.trim().replace(/;\s*$/, '');
    const refuse = (message: string) => new CoreError('INVALID', message);
    if (!sql) throw refuse('Write a query first.');
    if (sql.length > 4000) throw refuse('That query is too long.');
    if (!/^(select|with)\b/i.test(sql)) throw refuse('Only SELECT queries can run here. Anything else needs an approval and isn’t available.');
    if (sql.includes(';')) throw refuse('Run one statement at a time.');
    if (/--|\/\*|#/.test(sql)) throw refuse('Remove the comments and run it again.');
    if (FORBIDDEN.test(sql)) throw refuse('That query uses something that isn’t allowed here.');
    if (SENSITIVE.test(sql)) throw refuse('That column holds personal data, so it can’t be queried here.');
    if (/\bselect\s+(distinct\s+)?\*|\.\*/i.test(sql)) throw refuse('Name the columns you need instead of using *.');
    // Names are checked across the whole statement, strings included: stripping strings here would let
    // an escaped quote hide a table. A false refusal is the cheaper mistake.
    const words = new Set(sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
    const schemas = await rows<{ s: string }>(this.pool, 'SELECT schema_name AS s FROM information_schema.schemata');
    if (schemas.some((x) => words.has(x.s.toLowerCase()))) throw refuse('Queries read this institution’s curated tables. Remove the database name.');
    const known = await rows<{ t: string }>(this.pool, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
    const used = known.map((k) => k.t.toLowerCase()).filter((t) => words.has(t));
    const blocked = used.filter((t) => !CURATED.test(t));
    if (blocked.length) throw refuse(`You can’t query ${blocked.join(', ')} here. Queries read curated tables.`);
    return { sql, tables: used };
  }

  async run(input: string): Promise<QueryResult> {
    const { sql, tables } = await this.check(input);
    let found: Record<string, unknown>[];
    try {
      found = await rows<Record<string, unknown>>(this.pool, `SELECT /*+ MAX_EXECUTION_TIME(8000) */ * FROM (${sql}) AS q LIMIT ${MAX_ROWS + 1}`);
    } catch (e) {
      throw new CoreError('INVALID', `MySQL refused that query: ${(e as Error).message.slice(0, 200)}`);
    }
    const value = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : String(v));
    const shown = found.slice(0, MAX_ROWS).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, value(v)])));
    return { statementType: 'SELECT', tables, columns: Object.keys(found[0] ?? {}), rows: shown, truncated: found.length > MAX_ROWS };
  }
}
