// The workspace pages (spec 8.10 to 8.15, 8.19, 8.22). Each page opens on DI's view, then the figures
// and records to check. They read the same DI Core services the agents use, under the same purview,
// so a page and an answer always agree. Changes happen in a task, behind an approval card.
import type { AppTile, AppView, AppViewId, Block, ListBlock, TableBlock } from '@dinext/block-schemas';
import { memberNumber, WorkflowDefService, WorksheetService, TaskService, CampaignService, CollectionsService, IndirectService, ProspectService, attritionBand, CalendarService, CalendarStore, CallReportService, DataLogService, FILE_FOLDERS, FILE_LIBRARY, FileStore, foldersFor, GovernanceService, IssueService, OnboardingService, OperationsService, RetentionService, SAVED_QUERIES, SegService, type CalendarEvent, type CoreContext } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { SourceService, TableService, secretKeyFrom } from '@dinext/di-core';
import { EmailOutbox } from '@dinext/di-core';

type ColumnSpec = TableBlock['data']['columns'][number];

export interface ViewDeps {
  pool: Pool;
  blockId: () => string;
  person: 'member' | 'customer';
  ctx: CoreContext;
  employeeId?: number;
  user: { id: string; name: string };
  leads: boolean;
  modules: string[];
  retention: boolean;
  /** Calendar events and uploads are loaded (Slice 23 or later). */
  workspace?: boolean;
}

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
// "26 Oct 2026", the same as the freshness line under every block, never a raw "2026-10-26".
// Built by hand: en-GB writes "Sept".
const day = (iso: string) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCDate()} ${new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)} ${d.getUTCFullYear()}`;
};
// "November 2026" from "2026-11".
const monthName = (ym: string) => (/^\d{4}-\d{2}$/.test(ym) ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-15T00:00:00Z`)) : ym);
// A state word as a figure: "Completed", not "completed".
const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const text = (field: string, headerName: string): ColumnSpec => ({ field, headerName, type: 'text' });

export function createAppViews(deps: ViewDeps) {
  const { pool, blockId, ctx } = deps;
  const table = (title: string, operation: string, columns: ColumnSpec[], rows: Record<string, string | number>[]): Block => ({ id: blockId(), type: 'table', version: '1.0.0', title, provenance: { agent: 'DI', operations: [operation], sources: [] }, freshness: { kind: 'workflow_event' }, data: { columns, rows, rowCount: rows.length } });
  /** A bar chart for a page's main breakdown, so each page opens on a picture as well as figures. */
  const bar = (title: string, operation: string, rows: [string, number][], unit: 'count' | 'currency', valueName: string, subtitle?: string): Block => ({ id: blockId(), type: 'chart', version: '2.0.0', title, ...(subtitle ? { subtitle } : {}), provenance: { agent: 'DI', operations: [operation], sources: [] }, freshness: { kind: 'workflow_event' }, data: { chartType: 'bar', dataset: { dimensions: [{ name: 'label', displayName: title, type: 'ordinal' }, { name: 'value', displayName: valueName, type: 'number' }], source: rows }, series: [{ name: valueName, encode: { x: 'label', y: 'value' } }], axes: { y: [{ unit }] }, legend: false } } as Block);
  /** Counts of items by a field, largest first. */
  const countBy = <T,>(items: T[], key: (t: T) => string): [string, number][] => [...items.reduce((m, t) => m.set(key(t), (m.get(key(t)) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const operations = new OperationsService(pool);
  const issues = new IssueService(pool);
  const onboarding = new OnboardingService(pool);
  const logs = new DataLogService(pool);
  const retention = new RetentionService(pool);

  const calendarEvents = async () => {
    const service = new CalendarService({ onboarding: onboarding as never, issues: issues as never, retention: retention as never, meetings: deps.workspace ? new CalendarStore(pool) : null });
    const items = await service.events({ employeeId: deps.leads ? undefined : deps.employeeId, userId: deps.user.id || undefined, canUse: (s) => (s === 'retention' ? deps.retention : deps.modules.includes(s)), ctx });
    // The calendar runs on the real date: work due since the last build is overdue now, even though its
    // data is from the build. The build's date stays on the page, for what the data covers.
    const asOf = (await onboarding.list({ overdueOnly: true }, ctx)).asOf;
    const today = new Date().toISOString().slice(0, 10);
    const work = new Set(['Touch point', 'Issue due']);
    return { today, asOf, items: items.map((e) => ({ ...e, late: e.late || (work.has(e.kind) && e.date < today) })) };
  };

  const views: Record<AppViewId, () => Promise<AppView>> = {
    async calendar() {
      const { today, asOf, items } = await calendarEvents();
      const overdue = items.filter((e) => e.late);
      const inDays = (e: CalendarEvent, n: number) => e.date >= today && (Date.parse(e.date) - Date.parse(today)) / 86_400_000 <= n;
      const week = items.filter((e) => inDays(e, 7));
      const next = overdue[0] ?? week[0];
      return {
        title: 'Calendar',
        lede: `Your events, and dated work from your modules. Their status is from the last build, with data as of ${day(asOf)}. Ask DI to add, move or cancel an event.`,
        take: { headline: overdue.length ? `${count(overdue.length, 'item')} overdue. Start with ${next?.title}.` : next ? `Next up: ${next.title}, on ${day(next.date)}.` : 'Nothing is scheduled in the next few weeks.', action: { label: 'What’s due this week?', ask: 'What’s due this week?' } },
        tiles: [{ label: 'Overdue', value: String(overdue.length), tone: overdue.length ? 'danger' : 'neutral', ...(overdue.length ? { ask: 'What’s due this week?' } : {}) }, { label: 'Today', value: String(items.filter((e) => e.date === today).length) }, { label: 'Next 7 days', value: String(week.length) }],
        prompts: ['What’s due this week?', 'Show the calendar for the next two weeks', 'Block out an hour next Tuesday at 2 pm for planning'],
        notice: 'Events live in DI only. Syncing with Outlook or Google Calendar isn’t built.',
        events: items.map(({ date, kind, title, detail, late, ask }) => ({ date, kind, title, detail, late, ask })),
        today,
        blocks: [],
      };
    },
    async files() {
      // Only the folders this person can see; a file anywhere else isn't listed or counted.
      const folders = foldersFor(deps.modules);
      const uploads = deps.workspace ? await new FileStore(pool).list(deps.user.id, folders) : [];
      // The Recycle Bin: deleted uploads from the same folders, each one restored by asking DI.
      const bin = deps.workspace ? await new FileStore(pool).binned(deps.user.id, folders) : [];
      const all = [...uploads, ...FILE_LIBRARY.filter((f) => folders.includes(f.folder))].sort((a, b) => b.modified.localeCompare(a.modified));
      const newest = all[0];
      // Prompts about the person's own files and folders only: never a folder they can't see.
      const sample = all.find((f) => !f.fileId) ?? newest;
      const find = sample ? `Find ${sample.name.replace(/\.[a-z0-9]+$/i, '')}` : null;
      const prompts = [...(find ? [find] : []), ...(folders[0] ? [`Who can see the ${folders[0]} folder?`] : []), ...bin.slice(0, 3).map((f) => `Restore ${f.name}`)];
      return {
        title: 'Files',
        lede: 'Documents your institution keeps in DI, in the folders you can see.',
        take: { headline: newest ? `${count(all.length, 'file')} in ${count(folders.length, 'folder')}. The newest is ${newest.name}.` : 'There are no files in your folders yet.', ...(find ? { action: { label: 'Find a document', ask: find } } : {}) },
        tiles: [{ label: 'Files', value: String(all.length) }, { label: 'Uploaded', value: String(uploads.length) }, { label: 'Total size', value: `${(all.reduce((n, f) => n + f.sizeKb, 0) / 1024).toFixed(1)} MB` }],
        prompts,
        notice: deps.workspace ? 'Uploads aren’t virus scanned: scanning isn’t available yet. Only open files from people you trust. Sample documents are names only, with no content to download.' : 'Uploading isn’t set up in this environment. These are sample documents with no content.',
        files: all.map((f) => ({ name: f.name, folder: f.folder, type: f.type, sizeKb: f.sizeKb, owner: f.owner, modified: f.modified, ...(f.fileId ? { download: `/v1/files/${f.fileId}/content` } : {}) })),
        folders: deps.workspace ? folders : [],
        blocks: [table('Folders', 'files.folders', [text('folder', 'Folder'), { field: 'files', headerName: 'Files', type: 'count' }, text('access', 'Who can see it')], folders.map((folder) => ({ folder, files: all.filter((f) => f.folder === folder).length, access: FILE_FOLDERS[folder]! }))), ...(bin.length ? [table(`Recycle Bin (${bin.length})`, 'files.bin', [text('name', 'Name'), text('folder', 'Deleted from'), text('owner', 'Owner')], bin.map((f) => ({ name: f.name, folder: f.folder, owner: f.owner })))] : [])],
      };
    },
    async tables() {
      // Saved views and snapshots this person can open, and their own Recycle Bin. A tenant seeded
      // before the Tables slice has neither, so both read as empty.
      const svc = new TableService(pool, deps.person);
      const [saved, bin] = await Promise.all([svc.objects(deps.user.id).catch(() => []), svc.objects(deps.user.id, { status: 'Recycle Bin' }).catch(() => [])]);
      const label = (id: string) => svc.catalog.find((c) => c.id === id)?.label ?? id;
      const shared = (cls: string | null) => (!cls ? 'Only you' : cls === 'Everyone' ? 'Everyone' : `${cls} class`);
      const row = (o: (typeof saved)[number]) => ({ name: o.name, kind: o.kind === 'View' ? 'Saved view' : o.kind === 'Upload' ? 'Uploaded table' : 'Snapshot', table: o.kind === 'Upload' ? 'From a file' : label(o.tableId), rows: o.kind === 'View' ? 'Runs when opened' : o.rowCount.toLocaleString('en-US'), owner: o.ownerName, shared: shared(o.sharedClass), made: o.recycledOn ?? o.createdOn });
      const columns = [text('name', 'Name'), text('kind', 'Kind'), text('table', 'Table'), text('rows', 'Rows'), text('owner', 'Owner'), text('shared', 'Who can see it')];
      const views = saved.filter((o) => o.kind === 'View').length;
      return {
        title: 'Tables',
        lede: 'Curated tables from the nightly build, and the saved views and snapshots made from them.',
        take: { headline: saved.length ? `${count(saved.length, 'saved view, snapshot or uploaded table', 'saved views, snapshots and uploaded tables')} you can open${bin.length ? `, and ${count(bin.length, 'item')} in your Recycle Bin` : ''}.` : 'No saved views, snapshots or uploaded tables yet. Ask DI to snapshot a table, merge two into a saved view, or load a file on Integrations.', action: { label: 'Summarise Loan Accounts', ask: 'Profile the Loan Accounts table' } },
        tiles: [{ label: 'Curated tables', value: String(svc.catalog.length) }, { label: 'Saved views', value: String(views) }, { label: 'Snapshots', value: String(saved.filter((o) => o.kind === 'Snapshot').length) }, ...(saved.some((o) => o.kind === 'Upload') ? [{ label: 'Uploaded tables', value: String(saved.filter((o) => o.kind === 'Upload').length) }] : []), { label: 'Recycle Bin', value: String(bin.length) }],
        prompts: ['Which tables link to Loan Accounts?', 'Snapshot the Loan Accounts table', 'Show my saved views and snapshots', ...bin.slice(0, 3).map((o) => (o.kind === 'View' ? `Restore the ${o.name} view` : `Restore ${o.name}`))],
        notice: 'Curated tables come from the core system in each nightly build, so their rows can’t be added or edited here. Uploaded tables are your own data, loaded from a file on Integrations. Comparing two snapshots isn’t built yet.',
        links: saved.map((o) => ({ label: `Open ${o.name}`, to: `/tables/${o.kind === 'View' ? 'view' : o.kind === 'Upload' ? 'upload' : 'snapshot'}-${o.objId}` })),
        blocks: [...(saved.length ? [table('Saved views and snapshots', 'tables.objects', columns, saved.map(row))] : []), ...(bin.length ? [table(`Recycle Bin (${bin.length})`, 'tables.bin', [...columns.slice(0, 3), text('made', 'Deleted on')], bin.map(row))] : [])],
      };
    },
    // ---- Email notifications: my simulated outbox and preferences; counts across people for admins.
    async emails() {
      const outbox = new EmailOutbox(pool);
      const [mine, prefs] = await Promise.all([outbox.recent(deps.user.id, { limit: 50 }).catch(() => []), outbox.prefs(deps.user.id).catch(() => [])]);
      const admin = deps.modules.includes('admin');
      const counts = admin ? await outbox.deliveryCounts().catch(() => []) : [];
      const todayIso = new Date().toISOString().slice(0, 10);
      const today = mine.filter((e) => e.createdAt.slice(0, 10) === todayIso).length;
      const on = prefs.filter((p) => p.on);
      const when = (s: string) => new Date(s).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
      return {
        title: 'Email notifications',
        lede: 'The emails DI sends you about your own work, and which kinds you get. Ask DI to change them.',
        take: { headline: mine.length ? `DI sent you ${count(mine.length, 'email')} lately${today ? `, ${today} today` : ''}. The latest: ${mine[0]!.subject.replace(/^DI: /, '')}.` : `DI hasn’t emailed you yet. You get ${on.length} of ${prefs.length} kinds.`, action: { label: 'What did DI send me today?', ask: 'What emails did DI send me today?' } },
        tiles: [{ label: 'Today', value: String(today) }, { label: 'In your outbox', value: String(mine.length), detail: 'Latest 50' }, { label: 'Kinds on', value: `${on.length} of ${prefs.length}` }, ...(admin ? [{ label: 'All emails', value: String(counts.reduce((n, c) => n + c.emails, 0)), detail: 'Everyone, counts only' }] : [])],
        prompts: ['What emails did DI send me today?', on.some((p) => p.kind === 'follow_up') ? 'Stop emailing me follow-up reminders' : 'Email me follow-up reminders', prefs.find((p) => p.kind === 'digest')?.on ? 'Stop the morning digest' : 'Send me a morning digest', ...(admin ? ['How many emails went out by kind?'] : [])],
        notice: 'Delivery is simulated in this demo: nothing leaves DI, and addresses are fictional. Emails carry a name and a link, never account numbers. DI never emails other people on your behalf.',
        blocks: [
          table('My email notifications', 'ntf.prefs', [text('kind', 'Email'), text('on', 'On?'), text('set', 'Set by')], prefs.map((p) => ({ kind: p.label, on: p.on ? 'On' : 'Off', set: p.changed ? 'You' : 'Default' }))),
          ...(mine.length ? [table('My outbox, latest 50', 'ntf.outbox', [text('when', 'When'), text('kind', 'Kind'), text('subject', 'Subject'), text('to', 'To'), text('status', 'Status')], mine.map((e) => ({ when: when(e.createdAt), kind: prefs.find((p) => p.kind === e.kind)?.label ?? e.kind, subject: e.subject, to: e.toAddress, status: e.status })))] : []),
          ...(admin ? [table('Delivery by kind, everyone', 'ntf.delivery', [text('kind', 'Kind'), { field: 'emails', headerName: 'Emails', type: 'count' }, { field: 'people', headerName: 'People', type: 'count' }, text('latest', 'Latest')], counts.map((c) => ({ kind: c.label, emails: c.emails, people: c.people, latest: c.latest ? when(c.latest) : '—' })))] : []),
        ],
      };
    },
    async queries() {
      return {
        title: 'Queries',
        lede: 'Run read-only SQL over curated tables. Up to 500 rows.',
        take: { headline: `${count(SAVED_QUERIES.length, 'saved query', 'saved queries')} ready to run. For most questions, asking DI is quicker.`, action: { label: 'Ask: loan growth by branch', ask: 'Show loan growth by branch for Q3 vs Q2' } },
        tiles: [],
        prompts: [],
        blocks: [],
        saved: SAVED_QUERIES,
      };
    },
    async users() {
      const all = await operations.users();
      const locked = all.filter((u) => u.status === 'Locked');
      const classes = new Set(all.map((u) => u.userClass));
      // Names two or more people share. The user ID tells them apart, so DI says so rather than leave it to a guess.
      const seen = new Map<string, number>();
      for (const u of all) seen.set(u.name.toLowerCase(), (seen.get(u.name.toLowerCase()) ?? 0) + 1);
      const shared = [...seen].filter(([, n]) => n > 1).map(([name]) => all.find((u) => u.name.toLowerCase() === name)!.name);
      const id = (userId: string) => userId.replace(/^(user|emp):/, '');
      return {
        title: 'Users',
        lede: 'Everyone with DI access, their class and their purview. Ask DI to add, change or offboard someone; access changes need a second approver.',
        take: {
          headline: `${count(all.length, 'user')} in ${count(classes.size, 'class', 'classes')}${locked.length ? `, ${locked.length} locked` : ', none locked'}.${shared.length ? ` ${shared.map((n) => `“${n}”`).join(' and ')} ${shared.length === 1 ? 'is' : 'are'} shared by more than one person, so check the user ID before you change one.` : ''}`,
          action: { label: 'Remove Sofia Ruiz’s access', ask: 'Sofia Ruiz has left the credit union. Remove her access' },
        },
        tiles: [{ label: 'Users', value: String(all.length) }, { label: 'Classes', value: String(classes.size) }, { label: 'Locked', value: String(locked.length), tone: locked.length ? 'danger' : 'neutral' }],
        prompts: ['Why can’t Tom Walsh see the Westport referrals?', 'Change Ana Ruiz at Westport to the Manager class', 'Who hasn’t signed in for 90 days?', 'Create a user for Maria Gomez as a Westport MSR'],
        blocks: [table('Users', 'iam.user.list', [text('name', 'Name'), text('userId', 'User ID'), text('userClass', 'Class'), text('branch', 'Branch'), text('status', 'Status')], [...locked, ...all.filter((u) => u.status !== 'Locked')].map((u) => ({ name: u.name, userId: id(u.userId), userClass: u.userClass, branch: u.branch ?? 'All branches', status: u.status })))],
      };
    },
    async admin() {
      const build = await operations.build();
      const checks = await operations.checks(false);
      const late = build.uploads.filter((u) => u.late);
      const governance = deps.modules.includes('ai-admin') ? new GovernanceService(pool) : null;
      const month = await governance?.latestMonth().catch(() => null);
      const usage = governance && month ? await governance.usage(month, 'agent') : null;
      return {
        title: 'Admin',
        lede: `Platform health. Data as of ${day(build.asOf)}.`,
        take: { headline: `${build.stale ? `No new build for ${build.ageDays} days. The latest finished ${day(build.finishedOn)}, with data as of ${day(build.asOf)}.` : `The ${day(build.asOf)} build ${build.state}.`} ${checks.failed ? `${count(checks.failed, 'check')} failed` : 'All checks passed'}${late.length ? `, and ${late[0]!.source} arrived late` : ''}.`, action: { label: 'Which checks failed?', ask: 'Which checks failed?' } },
        tiles: [build.stale ? { label: 'Since the last build', value: `${build.ageDays} days`, detail: `Finished ${day(build.finishedOn)}`, tone: 'danger' as const } : { label: 'Build', value: title(build.state), detail: day(build.asOf) }, { label: 'Checks failed', value: `${checks.failed} of ${checks.total}`, tone: checks.failed ? 'danger' : 'neutral' }, { label: 'Late uploads', value: String(late.length), tone: late.length ? 'warning' : 'neutral' }, ...(usage ? [{ label: 'AI cost', value: `$${usage.totals.cost.toFixed(2)}`, detail: monthName(month!) } satisfies AppTile] : [])],
        prompts: ['Which checks failed?', 'Show AI cost by agent for October', 'Show the negative feedback'],
        // Admin shows only what needs someone; Integrations and Data Quality hold the full lists.
        notice: late.length || checks.failed ? undefined : 'Nothing needs you: every source arrived on time and every check passed.',
        links: [{ label: 'Every source on Integrations', to: '/integrations' }, { label: 'Every check on Data Quality', to: '/dq' }],
        blocks: [
          ...(late.length ? [table('Late uploads', 'build.state.get', [text('source', 'Source'), text('dueBy', 'Due by'), text('arrived', 'Arrived')], late.map((u) => ({ source: u.source, dueBy: u.dueBy, arrived: u.arrived })))] : []),
          ...(checks.failed ? [table('Failed checks', 'dq.status_report', [text('name', 'Check'), text('result', 'Result'), text('domain', 'Domain')], checks.items.filter((c) => !c.passed).map((c) => ({ domain: c.domain, name: c.name, result: `Failed, ${c.rowsFailed.toLocaleString('en-US')} rows` })))] : []),
        ],
      };
    },
    async datalogs() {
      const { items } = await logs.list({}, ctx);
      const open = items.filter((l) => !['Approved', 'Posted', 'Closed'].includes(l.status));
      const byStatus = new Map<string, number>();
      for (const l of items) byStatus.set(l.status, (byStatus.get(l.status) ?? 0) + 1);
      const waiting = byStatus.get('Submitted') ?? 0;
      return {
        title: 'Data Logs',
        lede: 'Manual entries, with their approval state.',
        take: { headline: waiting ? `${count(waiting, 'log')} waiting for approval.` : 'No logs are waiting for approval.', action: { label: 'Show what’s waiting', ask: 'Show the data logs waiting for approval' } },
        tiles: [...byStatus].slice(0, 4).map(([label, n]) => ({ label, value: String(n) })),
        prompts: ['Show the data logs waiting for approval', 'Show my returned data logs'],
        blocks: [table('Data logs', 'datalog.list', [text('id', 'Log'), text('type', 'Type'), text('title', 'Title'), { field: 'amount', headerName: 'Amount', type: 'currency' }, text('branch', 'Branch'), text('status', 'Status'), text('by', 'Created by')], (open.length ? open : items).slice(0, 100).map((l) => ({ id: `#${l.logId}`, type: l.type, title: l.title, amount: l.amount ?? 0, branch: l.branch, status: l.status, by: l.createdName })))],
      };
    },
    async seg() {
      const list = await new SegService(pool).companies();
      const top = list[0];
      return {
        title: 'SEG Management',
        lede: 'Select employee groups and their progress.',
        take: { headline: top ? `${top.name} added the most members, with ${top.newMembers} new.` : 'No SEGs are set up.', action: { label: 'Prepare for Albany Medical', ask: 'Prepare me for my SEG meeting with Albany Medical' } },
        tiles: [{ label: 'Companies', value: String(list.length) }, { label: 'SEG members', value: list.reduce((n, c) => n + c.members, 0).toLocaleString('en-US') }, { label: 'New members', value: String(list.reduce((n, c) => n + c.newMembers, 0)) }, { label: 'Loans', value: usd(list.reduce((n, c) => n + c.loans, 0)) }],
        prompts: ['Which SEGs had the most new members?', 'Prepare me for my SEG meeting with Albany Medical'],
        blocks: [table('SEG companies', 'seg.performance', [text('name', 'Company'), text('stage', 'Stage'), { field: 'members', headerName: 'Members', type: 'count' }, { field: 'newMembers', headerName: 'New', type: 'count' }, { field: 'loans', headerName: 'Loans', type: 'currency' }, { field: 'deposits', headerName: 'Deposits', type: 'currency' }], list.map(({ name, stage, members, newMembers, loans, deposits }) => ({ name, stage, members, newMembers, loans, deposits })))],
      };
    },
    async callreport() {
      const cr = new CallReportService(pool);
      const [lines, ready, capital, moved] = await Promise.all([cr.lines(), cr.readiness(), cr.capital(), cr.variance(25)]);
      const q = ready.quarter;
      const due = new Date(`${q.dueDate}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      const v = (code: string) => lines.find((l) => l.code === code);
      const needed = ready.explanations.filter((e) => e.status === 'Needed');
      const cols = [text('code', 'Account'), text('name', 'Line'), { field: 'prior', headerName: q.priorLabel ?? 'Prior', type: 'currency' as const }, { field: 'current', headerName: q.label, type: 'currency' as const }, text('pct', 'Change')];
      const rowsOf = (ls: typeof lines) => ls.map((l) => ({ code: l.code, name: l.name, prior: l.prior ?? 0, current: l.current ?? 0, pct: l.text ?? (l.pct === null ? '' : `${l.pct}%`) }));
      const filed = (ls: typeof lines) => ls.filter((l) => l.kind === 'total' || (l.current ?? 0) !== 0 || l.text);
      const sched = (id: string, section?: string) => filed(lines.filter((l) => l.schedule === id && (!section || l.section.startsWith(section))));
      const errors = ready.errors.length;
      return {
        title: `5300 Call Report · ${q.label}`,
        lede: `NCUA Form 5300, ${q.edition}, for the quarter ending ${new Date(`${q.current}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}. Due ${due} in CUOnline. DI prepares and checks it; a person files it.`,
        take: {
          headline: ready.ready && !ready.warnings.length ? `${q.label} is ready to review and file by ${due}.` : `${q.label} isn’t ready: ${[...ready.errors, ...ready.warnings].map((c) => c.detail).join(' ')}`,
          action: { label: 'Are we ready to file?', ask: `Are we ready to file ${q.label.split(' ')[0]}?` },
        },
        tiles: [
          { label: 'Due in CUOnline', value: due },
          { label: 'Errors blocking filing', value: String(errors), tone: errors ? 'danger' : 'neutral' },
          { label: 'Explanations needed', value: String(needed.length), tone: needed.length ? 'warning' : 'neutral' },
          { label: 'Net worth ratio', value: `${capital.ratio.toFixed(2)}%`, detail: capital.classification },
          { label: 'Total assets', value: `$${((v('010')?.current ?? 0) / 1e9).toFixed(2)}B` },
        ],
        prompts: ['Are we ready to file Q3?', ...(ready.uncategorized.length ? ['Which GL accounts are uncategorized?'] : []), ...(needed.length ? ['Which lines need an explanation?'] : []), 'Show schedule A delinquency', 'How is 025B calculated?', 'What’s our net worth ratio?'],
        blocks: [
          table('Edits', 'dq.status_report', [text('name', 'Edit'), text('severity', 'Type'), text('result', 'Result'), text('detail', 'Detail')], ready.checks.map((c) => ({ name: c.editCode ? `${c.editCode}: ${c.name}` : c.name, severity: c.severity, result: c.passed ? 'Passed' : 'Failed', detail: c.detail }))),
          // The accounts behind a failed mapping check sit right under it.
          ...(ready.uncategorized.length ? [table('Uncategorized GL accounts', 'callreport.gl_uncategorized', [text('gl', 'GL account'), text('name', 'Name'), { field: 'balance', headerName: 'Balance', type: 'currency' }, text('lastPosted', 'Last posted'), text('likely', 'Likely 5300 line'), text('note', 'Why it is open')], ready.uncategorized.map((g) => ({ gl: g.glNumber, name: g.name, balance: g.balance, lastPosted: g.lastPosted, likely: g.likelyLine ?? 'Not suggested', note: g.note ?? '' })))] : []),
          ...(moved.length ? [table(`Moved more than 25% since ${q.priorLabel}`, 'callreport.variance', [...cols, text('explanation', 'Explanation')], moved.map((l) => ({ ...rowsOf([l])[0]!, explanation: l.explanation ? (l.explanation.explanation ?? 'Needed') : '' })))] : []),
          table('Net worth (Schedule G)', 'callreport.capital', cols, rowsOf(filed(lines.filter((l) => l.schedule === 'G' || l.schedule === 'H')))),
          table('Statement of Financial Condition', 'callreport.sfc', cols, rowsOf(sched('SFC'))),
          table('Statement of Income and Expense (year to date)', 'callreport.sie', cols, rowsOf(sched('SIE'))),
          table('Schedule A: loans and leases', 'callreport.loans', cols, rowsOf(sched('A', 'Section 1'))),
          table('Schedule A: delinquent loans', 'callreport.delinquency', cols, rowsOf(filed(lines.filter((l) => l.schedule === 'A' && l.section.startsWith('Section 2') && (l.kind === 'total' || l.section.endsWith('(continued)')) && ((l.current ?? 0) !== 0 || l.section.endsWith('Total')))))),
          table('Schedule A: charge-offs and recoveries (year to date)', 'callreport.chargeoffs', cols, rowsOf(sched('A', 'Section 3'))),
          table('Schedules B and D: investments, shares and members', 'callreport.other', cols, rowsOf([...sched('B'), ...sched('D')])),
        ],
      };
    },
    async workflows() {
      // Referrals in the person's purview, by the member's home branch; a branch's count says it's the branch's.
      const branches = ctx.purviewBranches;
      const [referrals] = (await pool.query(
        `SELECT COUNT(*) AS n FROM esp_com_items i${branches ? ' JOIN cdm_party p ON p.party_id = i.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id' : ''} WHERE i.definition = 'referral' AND i.stage NOT IN ('Sold', 'Not Interested', 'Done')${branches ? ' AND b.name IN (?)' : ''}`,
        branches ? [branches.length ? branches : ['']] : [],
      )) as unknown as [{ n: number }[]];
      const where = branches?.length ? ` at ${branches.join(' and ')}` : '';
      const open = [{ name: `Referrals${where}`, count: Number(referrals[0]?.n ?? 0), link: 'Open in Referrals' }];
      if (deps.modules.includes('compliance')) open.push({ name: 'Compliance issues', count: (await issues.list({}, ctx)).count, link: 'Ask DI' });
      if (deps.modules.includes('onboarding')) open.push({ name: 'Onboarding touch points', count: (await onboarding.list({}, ctx)).count, link: 'Ask DI' });
      if (deps.modules.includes('datalogs')) open.push({ name: 'Data logs', count: (await logs.list({ status: 'Submitted' }, ctx)).count, link: 'Ask DI' });
      const total = open.reduce((n, w) => n + w.count, 0);
      return {
        title: 'Workflows',
        lede: `Everything open across your workflows${where ? `, for everyone${where}` : ''}. Your own items are on Tasks.`,
        take: { headline: `${count(total, 'item')} open${where} across ${count(open.length, 'workflow')}.`, action: { label: 'What should I do today?', ask: 'What should I do today?' } },
        tiles: open.slice(0, 4).map((w) => ({ label: w.name, value: w.count.toLocaleString('en-US') })),
        prompts: ['What’s in my referrals inbox?', 'What should I do today?'],
        links: [{ label: 'Open Referrals', to: '/workflows/referrals/inbox' }],
        blocks: [bar('Open work by workflow', 'workflow.summary', open.map((o) => [o.name, o.count]), 'count', 'Open'), table('Open work', 'workflow.summary', [text('name', 'Workflow'), { field: 'count', headerName: 'Open', type: 'count' }], open.map(({ name, count: n }) => ({ name, count: n })))],
      };
    },
    async indirect() {
      const ind = new IndirectService(pool);
      const p = await ind.performance('month', ctx);
      const sum = (k: 'received' | 'funded' | 'fundedAmount') => p.dealers.reduce((n, d) => n + d[k], 0);
      const prior = p.dealers.reduce((n, d) => n + d.prior.funded, 0);
      const drop = [...p.dealers].filter((d) => d.prior.funded > d.funded).sort((x, y) => (x.funded - x.prior.funded) - (y.funded - y.prior.funded))[0];
      return {
        title: 'Indirect Lending',
        lede: `Dealer performance for ${p.label}, against ${p.priorLabel}.`,
        take: { headline: p.partial ? `${count(sum('funded'), 'loan')} funded through dealers in ${p.label}, against ${prior} in all of ${p.priorLabel}. ${p.dealers.sort((x, y) => y.funded - x.funded)[0]?.name ?? ''} leads so far.` : `${count(sum('funded'), 'loan')} funded through dealers in ${p.label}, ${sum('funded') >= prior ? 'up' : 'down'} from ${prior}.${drop ? ` ${drop.name} fell most, to ${drop.funded} from ${drop.prior.funded}.` : ''}`, action: { label: 'Plan visits to my top 5 dealers', ask: `Plan visits for my top five dealers near ${p.dealers[0]?.branch ?? ''}` } },
        tiles: [{ label: 'Dealers', value: String(p.dealers.length) }, { label: 'Received', value: sum('received').toLocaleString('en-US') }, { label: 'Funded', value: sum('funded').toLocaleString('en-US') }, { label: 'Funded $', value: usd(sum('fundedAmount')) }],
        prompts: ['Which dealers had the biggest drop in funded loans this month?', 'How did Smith Ford do this quarter compared with last?', ...(deps.modules.includes('indirect-direct') ? ['How many indirect borrowers became direct members this year?'] : [])],
        notice: 'Dealer locations are shown as a visit list with miles between stops. A map isn’t built yet.',
        blocks: [bar(`Funded dollars by dealer, ${p.label}`, 'indirect.dealer.performance', p.dealers.map((d) => [d.name, d.fundedAmount]), 'currency', 'Funded $'), table(`Dealers, ${p.label}`, 'indirect.dealer.performance', [text('name', 'Dealer'), text('branch', 'Branch'), { field: 'received', headerName: 'Received', type: 'count' }, { field: 'approved', headerName: 'Approved', type: 'count' }, { field: 'funded', headerName: 'Funded', type: 'count' }, { field: 'amount', headerName: 'Funded $', type: 'currency' }, { field: 'fico', headerName: 'Avg FICO', type: 'number' }, text('rep', 'Rep'), text('status', 'Status')], p.dealers.map((d) => ({ name: d.name, branch: d.branch, received: d.received, approved: d.approved, funded: d.funded, amount: d.fundedAmount, fico: d.avgFico, rep: d.rep, status: d.status })))],
      };
    },
    async prospecting() {
      const prs = new ProspectService(pool);
      const [list, funnel] = await Promise.all([prs.list({}, ctx), prs.funnel(ctx)]);
      const due = list.filter((p) => p.nextFollowUp && p.nextFollowUp <= new Date().toISOString().slice(0, 10));
      const biggest = list[0];
      return {
        title: 'Prospecting',
        lede: 'Business prospects through the funnel.',
        take: { headline: `${count(list.length, 'prospect')} in the funnel${due.length ? `, ${due.length} with a follow-up due` : ''}.${biggest ? ` The largest is ${biggest.company}, in ${biggest.stage}.` : ''}`, action: { label: 'Route to nearby prospects', ask: `Plan a route to prospects within 10 miles of ${biggest?.branch ?? ''}` } },
        tiles: funnel.map((f) => ({ label: f.stage, value: String(f.count) })),
        prompts: ['Show my prospects in Qualified with assets over $5 million', 'What’s our conversion from Prospect to Application this quarter?'],
        notice: 'Routes are shown as a list with miles and a directions link. A map isn’t built yet.',
        blocks: [bar('Prospects by stage', 'prospect.list', countBy(list, (p) => p.stage), 'count', 'Prospects'), table('Prospects', 'prospect.list', [text('company', 'Company'), text('stage', 'Stage'), text('grade', 'Grade'), { field: 'assets', headerName: 'Assets', type: 'currency' }, text('disposition', 'Disposition'), text('owner', 'Owner'), text('next', 'Next follow-up'), text('branch', 'Branch')], list.map((p) => ({ company: p.company, stage: p.stage, grade: p.grade, assets: p.assets, disposition: p.disposition, owner: p.owner, next: p.nextFollowUp ? `${day(p.nextFollowUp)}${p.nextFollowUp < new Date().toISOString().slice(0, 10) ? ', overdue' : ''}` : '—', branch: p.branch })))],
      };
    },
    async campaigns() {
      const cmp = new CampaignService(pool);
      const list = await cmp.results();
      const sum = (k: 'sent' | 'applications' | 'dollars') => list.reduce((n, c) => n + c[k], 0);
      const best = [...list].sort((a, b) => b.applications / b.sent - a.applications / a.sent)[0];
      return {
        title: 'Campaign Success',
        lede: 'Campaigns by the loans they produced. Attribution uses each campaign’s response window.',
        take: { headline: list[0] ? `${list[0].name} produced the most loan dollars, ${usd(list[0].dollars)}. ${best && best.name !== list[0].name ? `${best.name} had the best response, ${Math.round((best.applications / best.sent) * 1000) / 10}% of those sent applied.` : ''}` : 'No campaigns have run.', action: { label: 'Find members with no auto loan', ask: 'Build an audience of members with no auto loan' } },
        tiles: [{ label: 'Campaigns', value: String(list.length) }, { label: 'Sent', value: sum('sent').toLocaleString('en-US') }, { label: 'Applications', value: sum('applications').toLocaleString('en-US') }, { label: 'Loan dollars', value: usd(sum('dollars')) }],
        prompts: ['Which campaigns produced the most loan dollars?', 'Build an audience of members with no auto loan'],
        blocks: [bar('Loan dollars by campaign', 'campaign.results', list.map((c) => [c.name, c.dollars]), 'currency', 'Loan dollars'), table('Campaigns', 'campaign.results', [text('name', 'Campaign'), text('channel', 'Channel'), text('product', 'Product'), { field: 'sent', headerName: 'Sent', type: 'count' }, { field: 'applications', headerName: 'Applications', type: 'count' }, text('response', 'Response'), { field: 'dollars', headerName: 'Loan dollars', type: 'currency' }], list.map((c) => ({ name: c.name, channel: c.channel, product: c.product, sent: c.sent, applications: c.applications, response: `${Math.round((c.applications / c.sent) * 1000) / 10}%`, dollars: c.dollars })))],
      };
    },
    async onboarding() {
      const [open, noDd] = await Promise.all([onboarding.list({ employeeId: deps.leads ? undefined : deps.employeeId, withinDays: 14 }, ctx), onboarding.noDirectDeposit(ctx)]);
      const first = open.items.find((t) => t.daysLate > 0) ?? open.items[0];
      return {
        title: 'Onboarding Manager',
        lede: `New ${deps.person}s’ touch points, as of the last build on ${day(open.asOf)}. Seven days late counts as missed.`,
        take: { headline: open.overdue ? `${count(open.overdue, 'touch point')} overdue, ${open.missed} missed. Start with ${first?.member}, ${first?.touch.toLowerCase()}.` : 'No touch points are overdue.', action: { label: 'Show what’s overdue', ask: 'Show my overdue onboarding touch points' } },
        tiles: [{ label: 'Open, next two weeks', value: String(open.count) }, { label: 'Overdue', value: String(open.overdue), tone: open.overdue ? 'danger' : 'neutral', ask: 'Show my overdue onboarding touch points' }, { label: 'Missed', value: String(open.missed), tone: open.missed ? 'danger' : 'neutral' }, { label: 'No direct deposit after 30 days', value: String(noDd.items.length), tone: noDd.items.length ? 'warning' : 'neutral' }],
        prompts: ['Show my overdue onboarding touch points', 'Which new members haven’t set up direct deposit after 30 days?'],
        blocks: [bar('Open touch points by state', 'onboarding.task.list', countBy(open.items, (t) => t.state), 'count', 'Touch points'), table('Touch points', 'onboarding.task.list', [text('member', deps.person === 'member' ? 'Member' : 'Customer'), text('touch', 'Touch point'), text('due', 'Due'), text('state', 'State'), text('assignee', 'With'), text('branch', 'Branch')], open.items.slice(0, 100).map((t) => ({ member: `${t.member} (…${t.last4})`, touch: t.touch, due: day(t.due), state: t.state, assignee: t.assignee ?? 'Branch queue', branch: t.branch })))],
      };
    },
    async compliance() {
      const all = await issues.list({}, ctx);
      const regulatory = all.items.filter((i) => i.kind === 'regulatory');
      const overdue = all.items.filter((i) => i.overdue);
      return {
        title: 'Compliance',
        lede: `Open issues and complaints, as of ${day(all.asOf)}. Regulatory issues must be resolved in 15 days, others in 30.`,
        take: { headline: overdue.length ? `${count(overdue.length, 'issue')} past their resolve-by date, ${overdue.filter((i) => i.kind === 'regulatory').length} regulatory. The oldest is ${all.oldestDays} days.` : `${count(all.count, 'issue')} open, none overdue.`, action: { label: 'Show regulatory issues', ask: 'Which regulatory issues are open more than 3 weeks?' } },
        tiles: [{ label: 'Open', value: String(all.count) }, { label: 'Regulatory', value: String(regulatory.length) }, { label: 'Past due', value: String(overdue.length), tone: overdue.length ? 'danger' : 'neutral', ask: 'Which regulatory issues are open more than 3 weeks?' }, { label: 'Oldest', value: `${all.oldestDays} days` }],
        prompts: ['Which regulatory issues are open more than 3 weeks?', 'Show the past-due compliance issues'],
        blocks: [bar('Open issues by category', 'cpm.issue.list', countBy(all.items, (i) => i.category), 'count', 'Issues'), table('Open issues', 'cpm.issue.list', [text('id', 'Issue'), text('kind', 'Kind'), text('source', 'Source'), text('category', 'Category'), text('member', 'Member'), { field: 'age', headerName: 'Age (days)', type: 'number' }, text('due', 'Resolve by'), text('owner', 'Owner'), text('branch', 'Branch')], all.items.slice(0, 100).map((i) => ({ id: `#${i.issueId}`, kind: i.kind === 'regulatory' ? 'Regulatory' : 'Customer', source: i.source, category: i.category, member: `${i.member} (…${i.last4})`, age: i.ageDays, due: `${day(i.resolveBy)}${i.overdue ? ', overdue' : ''}`, owner: i.owner ?? 'Unassigned', branch: i.branch })))],
      };
    },
    async predictive() {
      // The same people Relationship Manager counts: members (or customers) with a home branch, in purview.
      const scope = ` JOIN cdm_party p ON p.party_id = s.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.is_member = 1${ctx.purviewBranches ? ' AND b.name IN (?)' : ''}`;
      const [bands] = (await pool.query(`SELECT s.score, COUNT(*) AS n, MAX(s.model_version) AS model, MAX(s.run_date) AS run FROM cdm_attrition_score s${scope} GROUP BY s.score`, ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])) as unknown as [{ score: number; n: number; model: string; run: unknown }[]];
      const by = (band: string) => bands.filter((b) => attritionBand(b.score) === band).reduce((n, b) => n + Number(b.n), 0);
      const model = bands[0]?.model ?? '—';
      const run = String(bands[0]?.run instanceof Date ? (bands[0].run as Date).toISOString() : bands[0]?.run ?? '').slice(0, 10);
      const [watch, certificates] = await Promise.all([new CollectionsService(pool).watchlist(ctx), deps.retention ? retention.maturing({ days: 90, atRiskOnly: true }, ctx) : null]);
      return {
        title: 'Predictive Analytics',
        lede: `Scores from the attrition model${/\d/.test(model) ? ` (version ${model.replace(/^\D+/, '')})` : ''}, run ${day(run)}. A score of 7 or more is high risk of leaving, 4 to 6 medium.`,
        take: { headline: `${by('High').toLocaleString('en-US')} ${deps.person}s are at high risk of leaving and ${by('Medium').toLocaleString('en-US')} at medium risk. ${watch.count.toLocaleString('en-US')} current loans show stress.`, action: { label: 'Who’s at risk of leaving?', ask: `Find ${deps.person}s at risk of leaving and draft follow-ups` } },
        tiles: [{ label: 'High risk of leaving', value: by('High').toLocaleString('en-US'), tone: 'danger', ask: `Find ${deps.person}s at risk of leaving and draft follow-ups` }, { label: 'Medium risk', value: by('Medium').toLocaleString('en-US'), tone: 'warning' }, { label: 'Loans showing stress', value: watch.count.toLocaleString('en-US') }, ...(certificates ? [{ label: 'Certificates at risk, 90 days', value: usd(certificates.atRisk.dollars), detail: `${certificates.atRisk.count} certificates` } satisfies AppTile] : [])],
        prompts: [`Find ${deps.person}s at risk of leaving and draft follow-ups`, 'Show the early-warning list', ...(deps.retention ? ['Which certificates mature in the next 90 days and are at risk?'] : [])],
        blocks: [bar(`${deps.person === 'member' ? 'Members' : 'Customers'} by attrition score`, 'predictive.scores.distribution', [...bands].sort((a, b) => a.score - b.score).map((b) => [String(b.score), Number(b.n)]), 'count', deps.person === 'member' ? 'Members' : 'Customers', '7 or more is high risk'), table('Attrition score distribution', 'predictive.scores.distribution', [{ field: 'score', headerName: 'Score', type: 'number' }, text('band', 'Band'), { field: 'members', headerName: deps.person === 'member' ? 'Members' : 'Customers', type: 'count' }], [...bands].sort((a, b) => b.score - a.score).map((b) => ({ score: b.score, band: attritionBand(b.score), members: Number(b.n) }))), table('Loan stress signals', 'collections.watchlist.signals', [text('label', 'Signal'), { field: 'count', headerName: 'Loans', type: 'count' }], watch.signals.map((s) => ({ label: s.label, count: s.count })))],
      };
    },
    async dq() {
      const checks = await operations.checks(false);
      const dims = [...new Set(checks.items.map((c) => c.dimension))];
      const domains = [...new Set(checks.items.map((c) => c.domain))];
      const passed = (list: typeof checks.items) => `${list.filter((c) => c.passed).length} of ${list.length}`;
      // A check that passed nine days ago says nothing about today: the page dates its checks and,
      // when no build has run since, says the timeliness result is out of date.
      const build = await operations.build();
      return {
        title: 'Data Quality',
        lede: build.stale
          ? `Checks from the build that finished ${day(build.finishedOn)}. No build has run for ${build.ageDays} days, so these results, timeliness included, are out of date.`
          : `Checks from the build that finished ${day(build.finishedOn)}, across six dimensions and by data domain.`,
        take: { headline: checks.failed ? `${count(checks.failed, 'check')} failed of ${checks.total}: ${checks.items.filter((c) => !c.passed).map((c) => `${c.name} (${c.rowsFailed.toLocaleString('en-US')} rows)`).join(', ')}.` : `All ${checks.total} checks passed.`, action: { label: 'Where does 60+ delinquency come from?', ask: 'Where does 60+ delinquency come from?' } },
        tiles: dims.map((d) => { const own = checks.items.filter((c) => c.dimension === d); const late = d === 'Timeliness' && build.stale; return { label: `${d} checks passed`, value: passed(own), ...(late ? { detail: `Out of date: no build for ${build.ageDays} days` } : {}), tone: own.some((c) => !c.passed) ? ('danger' as const) : late ? ('warning' as const) : ('neutral' as const) }; }),
        prompts: ['Which checks failed?', 'Where does 60+ delinquency come from?'],
        blocks: [table('By domain', 'dq.status_report', [text('domain', 'Domain'), text('passed', 'Passed'), { field: 'rows', headerName: 'Rows failing', type: 'count' }], domains.map((d) => { const own = checks.items.filter((c) => c.domain === d); return { domain: d, passed: passed(own), rows: own.reduce((n, c) => n + c.rowsFailed, 0) }; })), table('Checks', 'dq.status_report', [text('name', 'Check'), text('result', 'Result'), text('domain', 'Domain'), text('dimension', 'Dimension')], checks.items.map((c) => ({ domain: c.domain, dimension: c.dimension, name: c.name, result: c.passed ? 'Passed' : `Failed, ${c.rowsFailed} rows` })))],
      };
    },
    async tasks() {
      const svc = new TaskService(pool);
      const m = await svc.mine({ userId: deps.user.id, name: deps.user.name, employeeId: deps.employeeId }, ctx);
      const time = deps.modules.includes('mytime') ? await svc.hours(deps.user.id) : null;
      const first = m.items[0];
      return {
        title: 'Tasks',
        lede: `Everything open for you, from every source. Past due counts from today; onboarding work is as of the last build, ${day(m.asOf)}.`,
        take: { headline: m.items.length ? `${count(m.items.length, 'item')} open${m.late ? `, ${m.late} past due` : ''}. ${first ? `First: ${first.title}.` : ''}` : 'You have nothing open.', action: { label: 'Add a task', ask: 'Create a task to ' } },
        tiles: [...m.bySource.map((s) => ({ label: s.source, value: String(s.count) })), { label: 'Past due', value: String(m.late), tone: m.late ? ('danger' as const) : ('neutral' as const) }, ...(time?.month ? [{ label: `Hours, ${new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${time.month}-15T00:00:00Z`))}`, value: String(time.total) } satisfies AppTile] : [])],
        prompts: ['What are my tasks today?', ...(time ? ['Show my hours this month'] : [])],
        blocks: [table('Open', 'task.list', [text('title', 'Task'), text('source', 'Source'), text('due', 'Due'), text('status', 'Status')], m.items.map((i) => ({ title: i.title, source: i.source, due: i.due ? day(i.due) : '—', status: i.due && i.due < m.today ? 'Past due' : i.status }))), ...(time?.month ? [table(`My hours, ${monthName(time.month)}`, 'time.summary', [text('project', 'Project'), { field: 'hours', headerName: 'Hours', type: 'number' }], time.byProject)] : [])],
      };
    },
    async integrations() {
      const build = await operations.build();
      const late = build.uploads.filter((u) => u.late);
      // Direct core connections, once the tenant has the source tables. Listing needs no key.
      const connections = await new SourceService(deps.pool, { secretKey: secretKeyFrom(), allowedHosts: [] }).connections().catch(() => []);
      const feeding = connections.find((c) => c.inUse);
      return {
        title: 'Integrations',
        lede: `Where the data comes from, and how the latest loads went. Data as of ${day(build.asOf)}.`,
        take: { headline: (build.stale ? `No new build for ${build.ageDays} days; the latest finished ${day(build.finishedOn)}, with data as of ${day(build.asOf)}. ` : '') + (late.length ? `${count(late.length, 'source')} arrived late: ${late.map((u) => `${u.source}, due ${u.dueBy}, arrived ${u.arrived}`).join('; ')}. The build ${build.state} with what was there.` : `Every source arrived on time, and the build ${build.state}.`), action: { label: 'Which data files arrived late?', ask: 'Which uploaders missed their late-file time?' } },
        tiles: [{ label: 'Sources', value: String(build.uploads.length) }, { label: 'Late', value: String(late.length), tone: late.length ? 'warning' : 'neutral' }, build.stale ? { label: 'Since the last build', value: `${build.ageDays} days`, detail: `Finished ${day(build.finishedOn)}`, tone: 'danger' as const } : { label: 'Last build', value: title(build.state), detail: day(build.asOf) }],
        prompts: ['Which uploaders missed their late-file time?', build.stale ? 'Why hasn’t a new build run?' : 'Did last night’s build finish?'],
        notice: `Connect the core’s reporting replica below with a read-only login: DI tests it, maps its tables and checks every row before anything changes. Or load a CSV or Excel file into a table of your own.${feeding ? ` Members, deposits and loans load from the ${feeding.name} from the next build.` : ''}`,
        blocks: [
          ...(connections.length
            ? [
                table(
                  'Core connections',
                  'src.connections',
                  [text('name', 'Connection'), text('core', 'Core'), text('tables', 'Tables'), text('schedule', 'Schedule'), text('last', 'Last pull'), text('use', 'Builds use it')],
                  connections.map((c) => ({ name: c.name, core: `${c.system.label} · ${c.login}, read-only`, tables: c.tables.map((t) => t.label).join(', '), schedule: c.schedule, last: c.lastRun ? `${c.lastRun.state === 'Done' ? c.lastRun.rows.toLocaleString('en-US') + ' rows' : c.lastRun.state}, ${day(c.lastRun.at)} ${c.lastRun.at.slice(11, 16)} UTC` : 'Not yet', use: c.inUse ? `From the first build after ${day(c.inUseSince ?? '')}` : 'Not yet' })),
                ),
              ]
            : []),
          table('Data sources', 'ingestion.sources', [text('source', 'Source'), text('method', 'How it arrives'), text('dueBy', 'Due by'), text('arrived', 'Arrived'), text('state', 'Last load')], build.uploads.map((u) => ({ source: u.source, method: u.source === 'Core extract' && feeding ? `Replaced by the ${feeding.name} from the next build` : u.method, dueBy: u.dueBy, arrived: u.arrived, state: u.late ? 'Late' : 'On time' }))),
        ],
      };
    },
    async classes() {
      const list = await operations.classes();
      return {
        title: 'Classes',
        lede: 'Roles, what each can do in DI, and who holds them.',
        take: { headline: `${count(list.length, 'class', 'classes')} and ${list.reduce((n, c) => n + c.active, 0)} active users. Ask DI who can do something, or why someone can’t.`, action: { label: 'Who can approve incentives?', ask: 'Who can approve incentives?' } },
        tiles: list.map((c) => ({ label: c.userClass, value: String(c.active) })),
        prompts: ['Who can approve incentives?', 'Why can’t Sofia Ruiz approve incentives?'],
        notice: 'Read only. Changing what a class can do isn’t built yet; changing a person’s user goes through DI with an approval.',
        blocks: [table('Classes', 'iam.class.list', [text('userClass', 'Class'), text('capabilities', 'Can'), { field: 'active', headerName: 'Active users', type: 'count' }, { field: 'locked', headerName: 'Locked', type: 'count' }], list.map((c) => ({ userClass: c.userClass, capabilities: c.capabilities.join(', '), active: c.active, locked: c.locked })))],
      };
    },
    async wfbuilder() {
      const defs = await new WorkflowDefService(pool).list();
      const live = defs.filter((d) => d.status === 'Active');
      const drafts = defs.filter((d) => d.status === 'Draft');
      const types = await new WorksheetService(pool).list().catch(() => []);
      return {
        title: 'Workflow Builder',
        lede: 'Workflow definitions: fields, stages and routing. Describe a workflow or a change; it becomes a draft, and nothing is live until it’s published.',
        take: { headline: `${count(live.length, 'live workflow')}${drafts.length ? ` and ${count(drafts.length, 'draft')}: ${drafts.map((d) => d.name).join(', ')}` : ''}. ${live.reduce((n, d) => n + d.openItems, 0)} open items run on them.`, action: { label: 'Try a sample workflow', ask: 'Create a workflow for branch maintenance requests with category, location, urgency and photo, routed to Facilities by location' } },
        tiles: [{ label: 'Live', value: String(live.length) }, { label: 'Drafts', value: String(drafts.length), tone: drafts.length ? 'warning' : 'neutral' }, { label: 'Open items', value: String(live.reduce((n, d) => n + d.openItems, 0)) }],
        prompts: ['Create a workflow for branch maintenance requests with category, location, urgency and photo, routed to Facilities by location', 'Add a "Waiting on member" stage between Active and Sold for referrals', 'Show the referral form', 'Move Best time to contact above Preferred contact method on the referral form', 'Show the worksheet for HELOC', ...drafts.map((d) => `Test the routing for the ${d.name} workflow`)],
        notice: 'Publishing records the definition and creates its queue. A stage published on the Referral workflow appears on every referral’s stage bar. Form layouts change by asking DI, with a preview of the form before you approve.',
        blocks: [table('Definitions', 'workflow.definition.list', [{ field: 'id', headerName: 'ID', type: 'number' }, text('name', 'Name'), text('status', 'Status'), { field: 'open', headerName: 'Open items', type: 'count' }, text('folder', 'Folder'), text('persistent', 'Saved fields'), text('nonPersistent', 'Form-only fields'), text('stages', 'Stages'), text('routing', 'Routing')], [...live, ...drafts].map((d) => ({ id: d.defId, name: d.name, folder: d.folder, persistent: d.spec.persistent.map((f) => f.label).join(', '), nonPersistent: d.spec.nonPersistent.map((f) => f.label).join(', ') || '—', stages: d.spec.stages.join(' → '), routing: `${d.spec.route.queue}${d.spec.route.byLocation ? ' by location' : ''}${d.spec.route.fallback ? `; fallback ${d.spec.route.fallback}` : ''}`, status: d.status === 'Draft' ? 'Draft' : `Live v${d.version}`, open: d.openItems }))), ...(types.length ? [table('Referral types (Referral Builder Worksheet)', 'referral.worksheet.list', [text('type', 'Referral type'), text('products', 'What is referred'), text('creators', 'Who creates it'), text('fields', 'Fields'), text('receives', 'Who receives it'), text('success', 'Success'), text('credit', 'Credit')], types.map((t) => ({ type: t.label, products: t.worksheet.products.join(', '), creators: t.worksheet.creators.join(', '), fields: t.fields.map((f) => f.label).join(', '), receives: t.receives, success: t.worksheet.success, credit: t.worksheet.credit })))] : [])],
      };
    },
    async rm() {
      // The same people Home counts as members (the semantic layer's member_count): members only, in purview.
      const scope = ` WHERE p.is_member = 1${ctx.purviewBranches ? ' AND b.name IN (?)' : ''}`;
      const params = ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [];
      const who = deps.person === 'member' ? 'member' : 'customer';
      const Who = who === 'member' ? 'Members' : 'Customers';
      // The largest relationships first, with how likely each is to leave and what they'd take next.
      const [[totals], [top]] = (await Promise.all([
        pool.query(`SELECT COUNT(*) AS n, SUM(s.score >= 7) AS high, SUM(COALESCE(d.dep, 0)) AS deposits, SUM(COALESCE(l.loan, 0)) AS loans FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id LEFT JOIN cdm_attrition_score s ON s.party_id = p.party_id LEFT JOIN (SELECT party_id, SUM(balance) AS dep FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY party_id) d ON d.party_id = p.party_id LEFT JOIN (SELECT party_id, SUM(balance) AS loan FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL GROUP BY party_id) l ON l.party_id = p.party_id${scope}`, params),
        pool.query(`SELECT p.party_id, p.first_name, p.last_name, b.name AS branch, p.join_date, COALESCE(d.dep, 0) AS deposits, COALESCE(l.loan, 0) AS loans, s.score, (SELECT x.product FROM cdm_suggestion x WHERE x.party_id = p.party_id ORDER BY x.likelihood DESC LIMIT 1) AS next FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id LEFT JOIN cdm_attrition_score s ON s.party_id = p.party_id LEFT JOIN (SELECT party_id, SUM(balance) AS dep FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY party_id) d ON d.party_id = p.party_id LEFT JOIN (SELECT party_id, SUM(balance) AS loan FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL GROUP BY party_id) l ON l.party_id = p.party_id${scope} ORDER BY COALESCE(d.dep, 0) + COALESCE(l.loan, 0) DESC LIMIT 25`, params),
      ])) as unknown as [[{ n: number; high: number; deposits: number; loans: number }[]], [{ party_id: number; first_name: string; last_name: string; branch: string; join_date: unknown; deposits: number; loans: number; score: number | null; next: string | null }[]]];
      const t = totals[0] ?? { n: 0, high: 0, deposits: 0, loans: 0 };
      const n = Number(t.n);
      const high = top.filter((r) => Number(r.score ?? 0) >= 7);
      const years = (d: unknown) => Math.round(((Date.now() - new Date(d instanceof Date ? d : String(d)).getTime()) / 31_557_600_000) * 10) / 10;
      const compact = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(v);
      return {
        title: 'Relationship Manager',
        lede: `${Who} 360: your largest relationships, how likely each is to leave, and what they'd take next. Search to open anyone's record.`,
        take: { headline: high.length ? `${count(high.length, who)} among your 25 largest ${high.length === 1 ? 'is' : 'are'} at high risk of leaving. Start with ${high[0]!.first_name} ${high[0]!.last_name} (…${memberNumber(high[0]!.party_id).slice(-4)}), ${compact(Number(high[0]!.deposits) + Number(high[0]!.loans))} with you.` : `${count(n, who)} in your purview. None of your 25 largest is at high risk of leaving.`, action: { label: 'Who’s at risk of leaving?', ask: `Find ${who}s at risk of leaving and draft follow-ups` } },
        tiles: [{ label: `${Who} in your purview`, value: n.toLocaleString('en-US') }, { label: 'Their deposits', value: compact(Number(t.deposits)), detail: 'Wherever the account is held' }, { label: 'Their loans', value: compact(Number(t.loans)), detail: 'Open, not charged off' }, { label: 'High risk of leaving', value: Number(t.high ?? 0).toLocaleString('en-US'), tone: Number(t.high) ? 'danger' : 'neutral', ask: `Find ${who}s at risk of leaving and draft follow-ups` }],
        // The meeting to prepare is with the person the take names: the largest relationship at risk, by last 4.
        prompts: [`Find ${who}s at risk of leaving and draft follow-ups`, ...(high[0] ? [`Prepare me for my meeting with ${high[0].first_name} ${high[0].last_name}, ending ${memberNumber(high[0].party_id).slice(-4)}`] : top[0] ? [`Prepare me for my meeting with ${top[0].first_name} ${top[0].last_name}, ending ${memberNumber(top[0].party_id).slice(-4)}`] : [])],
        blocks: [table(`Largest relationships`, 'rm.relationships.top', [text('member', who === 'member' ? 'Member' : 'Customer'), text('branch', 'Branch'), { field: 'tenure', headerName: 'Tenure (yrs)', type: 'number' }, { field: 'deposits', headerName: 'Deposits', type: 'currency' }, { field: 'loans', headerName: 'Loans', type: 'currency' }, { field: 'risk', headerName: 'Attrition risk', type: 'number' }, text('next', 'Next best product')], top.map((r) => ({ member: `${r.first_name} ${r.last_name} (…${memberNumber(r.party_id).slice(-4)})`, branch: r.branch, tenure: years(r.join_date), deposits: Number(r.deposits), loans: Number(r.loans), risk: r.score ?? 0, next: r.next ?? '—' })))],
      };
    },
  };
  /** Home's Platform health for an administrator: the build's age, checks, late feeds and access, worst first. */
  const platform = async (): Promise<ListBlock> => {
    const [build, checks, users] = await Promise.all([operations.build(), operations.checks(false), operations.users()]);
    const late = build.uploads.filter((u) => u.late);
    const failed = checks.items.filter((c) => !c.passed);
    const locked = users.filter((u) => u.status !== 'Active').length;
    const items: ListBlock['data']['items'] = [
      build.stale
        ? { id: 'build', lead: `${build.ageDays}d`, title: `No new build for ${build.ageDays} days`, subtitle: `The latest finished ${day(build.finishedOn)}, with data as of ${day(build.asOf)}. Every figure in DI comes from it.`, badge: { label: 'Stale', tone: 'danger' }, link: '/integrations', why: 'A nightly build is expected every night. Check the core extract and the build schedule.' }
        : { id: 'build', lead: '✓', title: `The ${day(build.asOf)} build ${build.state}`, subtitle: 'Figures are current.', badge: { label: 'Current', tone: 'success' }, link: '/integrations' },
      ...(failed.length ? [{ id: 'checks', lead: String(failed.length), title: `${count(failed.length, 'data quality check')} failed`, subtitle: failed.map((c) => `${c.name} (${c.rowsFailed.toLocaleString('en-US')} rows)`).join('; ').slice(0, 240), badge: { label: 'Failed', tone: 'danger' as const }, link: '/dq' }] : []),
      ...late.map((u) => ({ id: `late-${u.source}`, lead: u.arrived, title: `${u.source} arrived late`, subtitle: `Due by ${u.dueBy}, arrived ${u.arrived}. The build ran with what was there.`, badge: { label: 'Late', tone: 'warning' as const }, link: '/integrations' })),
      { id: 'access', lead: String(users.length - locked), title: `${count(users.length - locked, 'active user')}${locked ? `, ${locked} locked` : ', none locked'}`, subtitle: 'Access changes need a second approver.', link: '/admin/users' },
    ];
    return { id: blockId(), type: 'list', version: '1.0.0', title: 'Platform health', provenance: { agent: 'DI', operations: ['build.state.get', 'dq.status_report', 'iam.user.list'], sources: [] }, freshness: { kind: 'workflow_event' }, data: { items, layout: 'list' } } as ListBlock;
  };
  return { views, calendarEvents, platform };
}
