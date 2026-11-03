// The workspace pages (spec 8.10 to 8.15, 8.19, 8.22). Each page opens on DI's view, then the figures
// and records to check. They read the same DI Core services the agents use, under the same purview,
// so a page and an answer always agree. Changes happen in a task, behind an approval card.
import type { AppTile, AppView, AppViewId, Block, TableBlock } from '@dinext/block-schemas';
import { WorkflowDefService, TaskService, CampaignService, CollectionsService, IndirectService, ProspectService, attritionBand, CalendarService, CalendarStore, CallReportService, DataLogService, FILE_FOLDERS, FILE_LIBRARY, FileStore, foldersFor, GovernanceService, IssueService, OnboardingService, OperationsService, RetentionService, SAVED_QUERIES, SegService, type CalendarEvent, type CoreContext } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { TableService } from '@dinext/di-core';

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
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const text = (field: string, headerName: string): ColumnSpec => ({ field, headerName, type: 'text' });

export function createAppViews(deps: ViewDeps) {
  const { pool, blockId, ctx } = deps;
  const table = (title: string, operation: string, columns: ColumnSpec[], rows: Record<string, string | number>[]): Block => ({ id: blockId(), type: 'table', version: '1.0.0', title, provenance: { agent: 'DI', operations: [operation], sources: [] }, freshness: { kind: 'workflow_event' }, data: { columns, rows, rowCount: rows.length } });
  const operations = new OperationsService(pool);
  const issues = new IssueService(pool);
  const onboarding = new OnboardingService(pool);
  const logs = new DataLogService(pool);
  const retention = new RetentionService(pool);

  const calendarEvents = async () => {
    const service = new CalendarService({ onboarding: onboarding as never, issues: issues as never, retention: retention as never, meetings: deps.workspace ? new CalendarStore(pool) : null });
    const items = await service.events({ employeeId: deps.leads ? undefined : deps.employeeId, userId: deps.user.id || undefined, canUse: (s) => (s === 'retention' ? deps.retention : deps.modules.includes(s)), ctx });
    const today = (await onboarding.list({ overdueOnly: true }, ctx)).asOf;
    return { today, items };
  };

  const views: Record<AppViewId, () => Promise<AppView>> = {
    async calendar() {
      const { today, items } = await calendarEvents();
      const overdue = items.filter((e) => e.late);
      const inDays = (e: CalendarEvent, n: number) => e.date >= today && (Date.parse(e.date) - Date.parse(today)) / 86_400_000 <= n;
      const week = items.filter((e) => inDays(e, 7));
      const next = overdue[0] ?? week[0];
      return {
        title: 'Calendar',
        lede: `Your events, and dated work from your modules as of the last build on ${today}. Ask DI to add, move or cancel an event.`,
        take: { headline: overdue.length ? `${count(overdue.length, 'item')} overdue. Start with ${next?.title}.` : next ? `Next up: ${next.title}, on ${next.date}.` : 'Nothing is scheduled in the next few weeks.', action: { label: 'What’s due this week?', ask: 'What’s due this week?' } },
        tiles: [{ label: 'Overdue', value: String(overdue.length), tone: overdue.length ? 'danger' : 'neutral' }, { label: 'Today', value: String(items.filter((e) => e.date === today).length) }, { label: 'Next 7 days', value: String(week.length) }],
        prompts: ['What’s due this week?', 'Show the calendar for the next two weeks', 'Schedule a follow-up with Suzanne Jackson next Tuesday at 2 pm about the HELOC referral'],
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
      return {
        title: 'Files',
        lede: 'Documents your institution keeps in DI, in the folders you can see.',
        take: { headline: newest ? `${count(all.length, 'file')} in ${count(folders.length, 'folder')}. The newest is ${newest.name}.` : 'There are no files in your folders yet.', action: { label: 'Find a document', ask: 'Find the dealer agreement for Smith Ford' } },
        tiles: [{ label: 'Files', value: String(all.length) }, { label: 'Uploaded', value: String(uploads.length) }, { label: 'Total size', value: `${(all.reduce((n, f) => n + f.sizeKb, 0) / 1024).toFixed(1)} MB` }],
        prompts: ['Find the dealer agreement for Smith Ford', 'Who can see the Board Packs folder?', ...bin.slice(0, 3).map((f) => `Restore ${f.name}`)],
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
      const row = (o: (typeof saved)[number]) => ({ name: o.name, kind: o.kind === 'View' ? 'Saved view' : 'Snapshot', table: label(o.tableId), rows: o.kind === 'View' ? 'Runs when opened' : o.rowCount.toLocaleString('en-US'), owner: o.ownerName, shared: shared(o.sharedClass), made: o.recycledOn ?? o.createdOn });
      const columns = [text('name', 'Name'), text('kind', 'Kind'), text('table', 'Table'), text('rows', 'Rows'), text('owner', 'Owner'), text('shared', 'Who can see it')];
      const views = saved.filter((o) => o.kind === 'View').length;
      return {
        title: 'Tables',
        lede: 'Curated tables from the nightly build, and the saved views and snapshots made from them.',
        take: { headline: saved.length ? `${count(saved.length, 'saved view or snapshot', 'saved views and snapshots')} you can open${bin.length ? `, and ${count(bin.length, 'item')} in your Recycle Bin` : ''}.` : 'No saved views or snapshots yet. Ask DI to snapshot a table, or merge two into a saved view.', action: { label: 'Profile Loan Accounts', ask: 'Profile the Loan Accounts table' } },
        tiles: [{ label: 'Curated tables', value: String(svc.catalog.length) }, { label: 'Saved views', value: String(views) }, { label: 'Snapshots', value: String(saved.length - views) }, { label: 'Recycle Bin', value: String(bin.length) }],
        prompts: ['Which tables link to Loan Accounts?', 'Snapshot the Loan Accounts table', 'Show my saved views and snapshots', ...bin.slice(0, 3).map((o) => (o.kind === 'View' ? `Restore the ${o.name} view` : `Restore ${o.name}`))],
        notice: 'Rows come from the core system in each nightly build, so they can’t be added or edited here. Records change through workflows and the core system. Comparing two snapshots isn’t built yet.',
        links: saved.map((o) => ({ label: `Open ${o.name}`, to: `/tables/${o.kind === 'View' ? 'view' : 'snapshot'}-${o.objId}` })),
        blocks: [...(saved.length ? [table('Saved views and snapshots', 'tables.objects', columns, saved.map(row))] : []), ...(bin.length ? [table(`Recycle Bin (${bin.length})`, 'tables.bin', [...columns.slice(0, 3), text('made', 'Deleted on')], bin.map(row))] : [])],
      };
    },
    async queries() {
      return {
        title: 'Queries',
        lede: 'Run read-only SQL over curated tables. Up to 500 rows.',
        take: { headline: `${count(SAVED_QUERIES.length, 'saved query', 'saved queries')} ready to run. For most questions, asking DI is quicker.`, action: { label: 'Ask DI instead', ask: 'Show loan growth by branch for Q3 vs Q2' } },
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
      return {
        title: 'Users',
        lede: 'Everyone with DI access, their class and their purview.',
        take: { headline: `${count(all.length, 'user')} in ${count(classes.size, 'class', 'classes')}${locked.length ? `, ${locked.length} locked` : ', none locked'}.`, action: { label: 'Who can approve incentives?', ask: 'Who can approve incentives?' } },
        tiles: [{ label: 'Users', value: String(all.length) }, { label: 'Classes', value: String(classes.size) }, { label: 'Locked', value: String(locked.length), tone: locked.length ? 'danger' : 'neutral' }],
        prompts: ['Who can approve incentives?', 'Create a user for Maria Gomez as a Westport MSR'],
        blocks: [table('Users', 'iam.user.list', [text('name', 'Name'), text('userClass', 'Class'), text('branch', 'Branch'), text('status', 'Status')], all.map((u) => ({ name: u.name, userClass: u.userClass, branch: u.branch ?? 'All', status: u.status })))],
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
        lede: `Platform health. Data as of ${build.asOf}.`,
        take: { headline: `Last night’s build ${build.state}. ${checks.failed ? `${count(checks.failed, 'check')} failed` : 'All checks passed'}${late.length ? `, and ${late[0]!.source} arrived late` : ''}.`, action: { label: 'Which checks failed?', ask: 'Which checks failed?' } },
        tiles: [{ label: 'Build', value: build.state }, { label: 'Checks failed', value: `${checks.failed} of ${checks.total}`, tone: checks.failed ? 'danger' : 'neutral' }, { label: 'Late uploads', value: String(late.length), tone: late.length ? 'warning' : 'neutral' }, ...(usage ? [{ label: 'AI cost', value: `$${usage.totals.cost.toFixed(2)}`, detail: month! } satisfies AppTile] : [])],
        prompts: ['Which checks failed?', 'Show AI cost by agent for October', 'Show the negative feedback'],
        blocks: [table('Uploads', 'build.state.get', [text('source', 'Source'), text('dueBy', 'Due by'), text('arrived', 'Arrived'), text('state', 'State')], build.uploads.map((u) => ({ source: u.source, dueBy: u.dueBy, arrived: u.arrived, state: u.late ? 'Late' : 'On time' }))), table('Data quality checks', 'dq.status_report', [text('domain', 'Domain'), text('dimension', 'Dimension'), text('name', 'Check'), text('result', 'Result')], checks.items.map((c) => ({ domain: c.domain, dimension: c.dimension, name: c.name, result: c.passed ? 'Passed' : `Failed, ${c.rowsFailed} rows` })))],
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
        blocks: [table('Data logs', 'datalog.list', [{ field: 'id', headerName: 'Log', type: 'number' }, text('type', 'Type'), text('title', 'Title'), { field: 'amount', headerName: 'Amount', type: 'currency' }, text('branch', 'Branch'), text('status', 'Status'), text('by', 'Created by')], (open.length ? open : items).slice(0, 100).map((l) => ({ id: l.logId, type: l.type, title: l.title, amount: l.amount ?? 0, branch: l.branch, status: l.status, by: l.createdName })))],
      };
    },
    async seg() {
      const list = await new SegService(pool).companies();
      const top = list[0];
      return {
        title: 'SEG Management',
        lede: 'Select employee groups and their progress.',
        take: { headline: top ? `${top.name} added the most members, with ${top.newMembers} new.` : 'No SEGs are set up.', action: { label: 'Prepare a SEG meeting', ask: 'Prepare me for my SEG meeting with Albany Medical' } },
        tiles: [{ label: 'Companies', value: String(list.length) }, { label: 'SEG members', value: list.reduce((n, c) => n + c.members, 0).toLocaleString('en-US') }, { label: 'New members', value: String(list.reduce((n, c) => n + c.newMembers, 0)) }, { label: 'Loans', value: usd(list.reduce((n, c) => n + c.loans, 0)) }],
        prompts: ['Which SEGs had the most new members?', 'Prepare me for my SEG meeting with Albany Medical'],
        blocks: [table('SEG companies', 'seg.performance', [text('name', 'Company'), text('stage', 'Stage'), { field: 'members', headerName: 'Members', type: 'count' }, { field: 'newMembers', headerName: 'New', type: 'count' }, { field: 'loans', headerName: 'Loans', type: 'currency' }, { field: 'deposits', headerName: 'Deposits', type: 'currency' }], list.map(({ name, stage, members, newMembers, loans, deposits }) => ({ name, stage, members, newMembers, loans, deposits })))],
      };
    },
    async callreport() {
      const cr = new CallReportService(pool);
      const [lines, ready] = await Promise.all([cr.lines(), cr.readiness()]);
      const moved = lines.filter((l) => Math.abs(l.pct) >= 10).length;
      return {
        title: '5300 Call Report',
        lede: 'Q3 lines against last quarter. DI reads this report and never changes it.',
        take: { headline: ready.ready ? 'Q3 is ready to review.' : `Q3 isn’t ready: ${ready.failed.map((c) => c.detail).join(' ')}`, action: { label: 'Are we ready to file?', ask: 'Are we ready to file Q3?' } },
        tiles: [{ label: 'Checks passed', value: `${ready.checks.length - ready.failed.length} of ${ready.checks.length}`, tone: ready.failed.length ? 'danger' : 'neutral' }, { label: 'Lines', value: String(lines.length) }, { label: 'Moved 10% or more', value: String(moved), tone: moved ? 'warning' : 'neutral' }],
        prompts: ['Are we ready to file Q3?', 'Show schedule A changes over 10% from last quarter', 'How is 025B calculated?'],
        blocks: [table('Q3 lines', 'callreport.lines', [text('code', 'Account'), text('schedule', 'Schedule'), text('name', 'Line'), { field: 'prior', headerName: 'Q2', type: 'currency' }, { field: 'current', headerName: 'Q3', type: 'currency' }, text('pct', 'Change')], lines.map((l) => ({ code: l.code, schedule: l.schedule, name: l.name, prior: l.prior, current: l.current, pct: `${l.pct}%` }))), table('Checks', 'dq.status_report', [text('name', 'Check'), text('result', 'Result'), text('detail', 'Detail')], ready.checks.map((c) => ({ name: c.name, result: c.passed ? 'Passed' : 'Failed', detail: c.detail })))],
      };
    },
    async workflows() {
      const [referrals] = (await pool.query("SELECT COUNT(*) AS n FROM esp_com_items WHERE definition = 'referral' AND stage NOT IN ('Sold', 'Not Interested', 'Done')")) as unknown as [{ n: number }[]];
      const open = [{ name: 'Referrals', count: Number(referrals[0]?.n ?? 0), link: 'Open in Referrals' }];
      if (deps.modules.includes('compliance')) open.push({ name: 'Compliance issues', count: (await issues.list({}, ctx)).count, link: 'Ask DI' });
      if (deps.modules.includes('onboarding')) open.push({ name: 'Onboarding touch points', count: (await onboarding.list({}, ctx)).count, link: 'Ask DI' });
      if (deps.modules.includes('datalogs')) open.push({ name: 'Data logs', count: (await logs.list({ status: 'Submitted' }, ctx)).count, link: 'Ask DI' });
      const total = open.reduce((n, w) => n + w.count, 0);
      return {
        title: 'Workflows',
        lede: 'Everything open across your workflows.',
        take: { headline: `${count(total, 'item')} open across ${count(open.length, 'workflow')}.`, action: { label: 'What should I do today?', ask: 'What should I do today?' } },
        tiles: open.slice(0, 4).map((w) => ({ label: w.name, value: w.count.toLocaleString('en-US') })),
        prompts: ['What’s in my referrals inbox?', 'What should I do today?'],
        links: [{ label: 'Open Referrals', to: '/workflows/referrals/inbox' }],
        blocks: [table('Open work', 'workflow.summary', [text('name', 'Workflow'), { field: 'count', headerName: 'Open', type: 'count' }], open.map(({ name, count: n }) => ({ name, count: n })))],
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
        take: { headline: p.partial ? `${count(sum('funded'), 'loan')} funded through dealers in ${p.label}, against ${prior} in all of ${p.priorLabel}. ${p.dealers.sort((x, y) => y.funded - x.funded)[0]?.name ?? ''} leads so far.` : `${count(sum('funded'), 'loan')} funded through dealers in ${p.label}, ${sum('funded') >= prior ? 'up' : 'down'} from ${prior}.${drop ? ` ${drop.name} fell most, to ${drop.funded} from ${drop.prior.funded}.` : ''}`, action: { label: 'Plan dealer visits', ask: `Plan visits for my top five dealers near ${p.dealers[0]?.branch ?? ''}` } },
        tiles: [{ label: 'Dealers', value: String(p.dealers.length) }, { label: 'Received', value: sum('received').toLocaleString('en-US') }, { label: 'Funded', value: sum('funded').toLocaleString('en-US') }, { label: 'Funded $', value: usd(sum('fundedAmount')) }],
        prompts: ['Which dealers had the biggest drop in funded loans this month?', 'How did Smith Ford do this quarter compared with last?', ...(deps.modules.includes('indirect-direct') ? ['How many indirect borrowers became direct members this year?'] : [])],
        notice: 'Dealer locations are shown as a visit list with miles between stops. A map isn’t built yet.',
        blocks: [table(`Dealers, ${p.label}`, 'indirect.dealer.performance', [text('name', 'Dealer'), text('branch', 'Branch'), { field: 'received', headerName: 'Received', type: 'count' }, { field: 'approved', headerName: 'Approved', type: 'count' }, { field: 'funded', headerName: 'Funded', type: 'count' }, { field: 'amount', headerName: 'Funded $', type: 'currency' }, { field: 'fico', headerName: 'Avg FICO', type: 'number' }, text('rep', 'Rep'), text('status', 'Status')], p.dealers.map((d) => ({ name: d.name, branch: d.branch, received: d.received, approved: d.approved, funded: d.funded, amount: d.fundedAmount, fico: d.avgFico, rep: d.rep, status: d.status })))],
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
        take: { headline: `${count(list.length, 'prospect')} in the funnel${due.length ? `, ${due.length} with a follow-up due` : ''}.${biggest ? ` The largest is ${biggest.company}, in ${biggest.stage}.` : ''}`, action: { label: 'Plan a route', ask: `Plan a route to prospects within 10 miles of ${biggest?.branch ?? ''}` } },
        tiles: funnel.map((f) => ({ label: f.stage, value: String(f.count) })),
        prompts: ['Show my prospects in Qualified with assets over $5 million', 'What’s our conversion from Prospect to Application this quarter?'],
        notice: 'Routes are shown as a list with miles and a directions link. A map isn’t built yet.',
        blocks: [table('Prospects', 'prospect.list', [text('company', 'Company'), text('stage', 'Stage'), text('grade', 'Grade'), { field: 'assets', headerName: 'Assets', type: 'currency' }, text('disposition', 'Disposition'), text('owner', 'Owner'), text('next', 'Next follow-up'), text('branch', 'Branch')], list.map((p) => ({ company: p.company, stage: p.stage, grade: p.grade, assets: p.assets, disposition: p.disposition, owner: p.owner, next: p.nextFollowUp ?? '—', branch: p.branch })))],
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
        take: { headline: list[0] ? `${list[0].name} produced the most loan dollars, ${usd(list[0].dollars)}. ${best && best.name !== list[0].name ? `${best.name} had the best response, ${Math.round((best.applications / best.sent) * 1000) / 10}% of those sent applied.` : ''}` : 'No campaigns have run.', action: { label: 'Build an audience', ask: 'Build an audience of members with no auto loan' } },
        tiles: [{ label: 'Campaigns', value: String(list.length) }, { label: 'Sent', value: sum('sent').toLocaleString('en-US') }, { label: 'Applications', value: sum('applications').toLocaleString('en-US') }, { label: 'Loan dollars', value: usd(sum('dollars')) }],
        prompts: ['Which campaigns produced the most loan dollars?', 'Build an audience of members with no auto loan'],
        blocks: [table('Campaigns', 'campaign.results', [text('name', 'Campaign'), text('channel', 'Channel'), text('product', 'Product'), { field: 'sent', headerName: 'Sent', type: 'count' }, { field: 'applications', headerName: 'Applications', type: 'count' }, text('response', 'Response'), { field: 'dollars', headerName: 'Loan dollars', type: 'currency' }], list.map((c) => ({ name: c.name, channel: c.channel, product: c.product, sent: c.sent, applications: c.applications, response: `${Math.round((c.applications / c.sent) * 1000) / 10}%`, dollars: c.dollars })))],
      };
    },
    async onboarding() {
      const [open, noDd] = await Promise.all([onboarding.list({ employeeId: deps.leads ? undefined : deps.employeeId, withinDays: 14 }, ctx), onboarding.noDirectDeposit(ctx)]);
      const first = open.items.find((t) => t.daysLate > 0) ?? open.items[0];
      return {
        title: 'Onboarding Manager',
        lede: `New ${deps.person}s’ touch points, as of the last build on ${open.asOf}. Seven days late counts as missed.`,
        take: { headline: open.overdue ? `${count(open.overdue, 'touch point')} overdue, ${open.missed} missed. Start with ${first?.member}, ${first?.touch.toLowerCase()}.` : 'No touch points are overdue.', action: { label: 'Show what’s overdue', ask: 'Show my overdue onboarding touch points' } },
        tiles: [{ label: 'Open, next two weeks', value: String(open.count) }, { label: 'Overdue', value: String(open.overdue), tone: open.overdue ? 'danger' : 'neutral' }, { label: 'Missed', value: String(open.missed), tone: open.missed ? 'danger' : 'neutral' }, { label: 'No direct deposit after 30 days', value: String(noDd.items.length), tone: noDd.items.length ? 'warning' : 'neutral' }],
        prompts: ['Show my overdue onboarding touch points', 'Which new members haven’t set up direct deposit after 30 days?'],
        blocks: [table('Touch points', 'onboarding.task.list', [text('member', 'Member'), text('touch', 'Touch point'), text('due', 'Due'), text('state', 'State'), text('assignee', 'With'), text('branch', 'Branch')], open.items.slice(0, 100).map((t) => ({ member: `${t.member} (…${t.last4})`, touch: t.touch, due: t.due, state: t.state, assignee: t.assignee ?? 'Branch queue', branch: t.branch })))],
      };
    },
    async compliance() {
      const all = await issues.list({}, ctx);
      const regulatory = all.items.filter((i) => i.kind === 'regulatory');
      const overdue = all.items.filter((i) => i.overdue);
      return {
        title: 'Compliance',
        lede: `Open issues and complaints, as of ${all.asOf}. Regulatory issues must be resolved in 15 days, others in 30.`,
        take: { headline: overdue.length ? `${count(overdue.length, 'issue')} past their resolve-by date, ${overdue.filter((i) => i.kind === 'regulatory').length} regulatory. The oldest is ${all.oldestDays} days.` : `${count(all.count, 'issue')} open, none overdue.`, action: { label: 'Show regulatory issues', ask: 'Which regulatory issues are open more than 3 weeks?' } },
        tiles: [{ label: 'Open', value: String(all.count) }, { label: 'Regulatory', value: String(regulatory.length) }, { label: 'Past due', value: String(overdue.length), tone: overdue.length ? 'danger' : 'neutral' }, { label: 'Oldest', value: `${all.oldestDays} days` }],
        prompts: ['Which regulatory issues are open more than 3 weeks?', 'Show the past-due compliance issues'],
        blocks: [table('Open issues', 'cpm.issue.list', [{ field: 'id', headerName: 'Issue', type: 'number' }, text('kind', 'Kind'), text('source', 'Source'), text('category', 'Category'), text('member', 'Member'), { field: 'age', headerName: 'Age (days)', type: 'number' }, text('due', 'Resolve by'), text('owner', 'Owner'), text('branch', 'Branch')], all.items.slice(0, 100).map((i) => ({ id: i.issueId, kind: i.kind === 'regulatory' ? 'Regulatory' : 'Customer', source: i.source, category: i.category, member: `${i.member} (…${i.last4})`, age: i.ageDays, due: `${i.resolveBy}${i.overdue ? ', overdue' : ''}`, owner: i.owner ?? 'Unassigned', branch: i.branch })))],
      };
    },
    async predictive() {
      const scope = ctx.purviewBranches ? ' JOIN cdm_party p ON p.party_id = s.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE b.name IN (?)' : '';
      const [bands] = (await pool.query(`SELECT s.score, COUNT(*) AS n, MAX(s.model_version) AS model, MAX(s.run_date) AS run FROM cdm_attrition_score s${scope} GROUP BY s.score`, ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])) as unknown as [{ score: number; n: number; model: string; run: unknown }[]];
      const by = (band: string) => bands.filter((b) => attritionBand(b.score) === band).reduce((n, b) => n + Number(b.n), 0);
      const model = bands[0]?.model ?? '—';
      const run = String(bands[0]?.run instanceof Date ? (bands[0].run as Date).toISOString() : bands[0]?.run ?? '').slice(0, 10);
      const [watch, certificates] = await Promise.all([new CollectionsService(pool).watchlist(ctx), deps.retention ? retention.maturing({ days: 90, atRiskOnly: true }, ctx) : null]);
      return {
        title: 'Predictive Analytics',
        lede: `Scores from ${model}, run ${run}. A score of 7 or more is high risk of leaving, 4 to 6 medium.`,
        take: { headline: `${by('High').toLocaleString('en-US')} ${deps.person}s are at high risk of leaving and ${by('Medium').toLocaleString('en-US')} at medium risk. ${watch.count.toLocaleString('en-US')} current loans show stress.`, action: { label: 'Who’s at risk of leaving?', ask: `Find ${deps.person}s at risk of leaving and draft follow-ups` } },
        tiles: [{ label: 'High risk of leaving', value: by('High').toLocaleString('en-US'), tone: 'danger' }, { label: 'Medium risk', value: by('Medium').toLocaleString('en-US'), tone: 'warning' }, { label: 'Loans showing stress', value: watch.count.toLocaleString('en-US') }, ...(certificates ? [{ label: 'Certificates at risk, 90 days', value: usd(certificates.atRisk.dollars), detail: `${certificates.atRisk.count} certificates` } satisfies AppTile] : [])],
        prompts: [`Find ${deps.person}s at risk of leaving and draft follow-ups`, 'Show the early-warning list', ...(deps.retention ? ['Which certificates mature in the next 90 days and are at risk?'] : [])],
        blocks: [table('Attrition score distribution', 'predictive.scores.distribution', [{ field: 'score', headerName: 'Score', type: 'number' }, text('band', 'Band'), { field: 'members', headerName: deps.person === 'member' ? 'Members' : 'Customers', type: 'count' }], [...bands].sort((a, b) => b.score - a.score).map((b) => ({ score: b.score, band: attritionBand(b.score), members: Number(b.n) }))), table('Loan stress signals', 'collections.watchlist.signals', [text('label', 'Signal'), { field: 'count', headerName: 'Loans', type: 'count' }], watch.signals.map((s) => ({ label: s.label, count: s.count })))],
      };
    },
    async dq() {
      const checks = await operations.checks(false);
      const dims = [...new Set(checks.items.map((c) => c.dimension))];
      const domains = [...new Set(checks.items.map((c) => c.domain))];
      const passed = (list: typeof checks.items) => `${list.filter((c) => c.passed).length} of ${list.length}`;
      return {
        title: 'Data Quality',
        lede: 'Last night’s checks across six dimensions, by data domain.',
        take: { headline: checks.failed ? `${count(checks.failed, 'check')} failed of ${checks.total}: ${checks.items.filter((c) => !c.passed).map((c) => `${c.name} (${c.rowsFailed.toLocaleString('en-US')} rows)`).join(', ')}.` : `All ${checks.total} checks passed.`, action: { label: 'Where does a failure matter?', ask: 'Where does 60+ delinquency come from?' } },
        tiles: dims.map((d) => { const own = checks.items.filter((c) => c.dimension === d); return { label: d, value: passed(own), tone: own.some((c) => !c.passed) ? ('danger' as const) : ('neutral' as const) }; }),
        prompts: ['Which checks failed?', 'Where does 60+ delinquency come from?'],
        blocks: [table('By domain', 'dq.status_report', [text('domain', 'Domain'), text('passed', 'Passed'), { field: 'rows', headerName: 'Rows failing', type: 'count' }], domains.map((d) => { const own = checks.items.filter((c) => c.domain === d); return { domain: d, passed: passed(own), rows: own.reduce((n, c) => n + c.rowsFailed, 0) }; })), table('Checks', 'dq.status_report', [text('domain', 'Domain'), text('dimension', 'Dimension'), text('name', 'Check'), text('result', 'Result')], checks.items.map((c) => ({ domain: c.domain, dimension: c.dimension, name: c.name, result: c.passed ? 'Passed' : `Failed, ${c.rowsFailed} rows` })))],
      };
    },
    async tasks() {
      const svc = new TaskService(pool);
      const m = await svc.mine({ userId: deps.user.id, name: deps.user.name, employeeId: deps.employeeId }, ctx);
      const time = deps.modules.includes('mytime') ? await svc.hours(deps.user.id) : null;
      const first = m.items[0];
      return {
        title: 'Tasks',
        lede: `Everything open for you, from every source, as of ${m.asOf}.`,
        take: { headline: m.items.length ? `${count(m.items.length, 'item')} open${m.late ? `, ${m.late} past due` : ''}. ${first ? `First: ${first.title}.` : ''}` : 'You have nothing open.', action: { label: 'Add a task', ask: 'Create a task to ' } },
        tiles: [...m.bySource.map((s) => ({ label: s.source, value: String(s.count) })), { label: 'Past due', value: String(m.late), tone: m.late ? ('danger' as const) : ('neutral' as const) }, ...(time?.month ? [{ label: `Hours, ${new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${time.month}-15T00:00:00Z`))}`, value: String(time.total) } satisfies AppTile] : [])],
        prompts: ['What are my tasks today?', ...(time ? ['Show my hours this month'] : [])],
        blocks: [table('Open', 'task.list', [text('title', 'Task'), text('source', 'Source'), text('due', 'Due'), text('status', 'Status')], m.items.map((i) => ({ title: i.title, source: i.source, due: i.due ?? '—', status: i.due && i.due < m.asOf ? 'Past due' : i.status }))), ...(time?.month ? [table(`My hours, ${time.month}`, 'time.summary', [text('project', 'Project'), { field: 'hours', headerName: 'Hours', type: 'number' }], time.byProject)] : [])],
      };
    },
    async integrations() {
      const build = await operations.build();
      const late = build.uploads.filter((u) => u.late);
      return {
        title: 'Integrations',
        lede: `Where the data comes from, and how last night’s loads went. Data as of ${build.asOf}.`,
        take: { headline: late.length ? `${count(late.length, 'source')} arrived late: ${late.map((u) => `${u.source}, due ${u.dueBy}, arrived ${u.arrived}`).join('; ')}. The build ${build.state} with what was there.` : `Every source arrived on time, and the build ${build.state}.`, action: { label: 'Which uploaders were late?', ask: 'Which uploaders missed their late-file time?' } },
        tiles: [{ label: 'Sources', value: String(build.uploads.length) }, { label: 'Late', value: String(late.length), tone: late.length ? 'warning' : 'neutral' }, { label: 'Last build', value: build.state }],
        prompts: ['Which uploaders missed their late-file time?', 'Did last night’s build finish?'],
        notice: 'Read only. Adding a source, connections and credentials are set up by Kinective and aren’t built here yet.',
        blocks: [table('Data sources', 'ingestion.sources', [text('source', 'Source'), text('method', 'How it arrives'), text('dueBy', 'Due by'), text('arrived', 'Arrived'), text('state', 'Last load')], build.uploads.map((u) => ({ source: u.source, method: u.method, dueBy: u.dueBy, arrived: u.arrived, state: u.late ? 'Late' : 'On time' })))],
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
      return {
        title: 'Workflow Builder',
        lede: 'Workflow definitions: fields, stages and routing. Describe a workflow or a change; it becomes a draft, and nothing is live until it’s published.',
        take: { headline: `${count(live.length, 'live workflow')}${drafts.length ? ` and ${count(drafts.length, 'draft')}: ${drafts.map((d) => d.name).join(', ')}` : ''}. ${live.reduce((n, d) => n + d.openItems, 0)} open items run on them.`, action: { label: 'Describe a new workflow', ask: 'Create a workflow for branch maintenance requests with category, location, urgency and photo, routed to Facilities by location' } },
        tiles: [{ label: 'Live', value: String(live.length) }, { label: 'Drafts', value: String(drafts.length), tone: drafts.length ? 'warning' : 'neutral' }, { label: 'Open items', value: String(live.reduce((n, d) => n + d.openItems, 0)) }],
        prompts: ['Create a workflow for branch maintenance requests with category, location, urgency and photo, routed to Facilities by location', 'Add a "Waiting on member" stage between Active and Sold for referrals', ...drafts.map((d) => `Test the routing for the ${d.name} workflow`)],
        notice: 'Publishing records the definition and creates its queue. The Referrals app still uses its built-in stages, so a referral stage change is recorded here but not yet shown there.',
        blocks: [table('Definitions', 'workflow.definition.list', [{ field: 'id', headerName: 'ID', type: 'number' }, text('name', 'Name'), text('folder', 'Folder'), text('persistent', 'Persistent fields'), text('nonPersistent', 'Non-persistent fields'), text('stages', 'Stages'), text('routing', 'Routing'), text('status', 'Status'), { field: 'open', headerName: 'Open items', type: 'count' }, text('icon', 'Desktop icon path')], [...live, ...drafts].map((d) => ({ id: d.defId, name: d.name, folder: d.folder, persistent: d.spec.persistent.map((f) => f.label).join(', '), nonPersistent: d.spec.nonPersistent.map((f) => f.label).join(', ') || '—', stages: d.spec.stages.join(' → '), routing: `${d.spec.route.queue}${d.spec.route.byLocation ? ' by location' : ''}${d.spec.route.fallback ? `; fallback ${d.spec.route.fallback}` : ''}`, status: d.status === 'Draft' ? 'Draft' : `Live v${d.version}`, open: d.openItems, icon: d.icon })))],
      };
    },
    async rm() {
      const scope = ctx.purviewBranches ? ' JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE b.name IN (?)' : '';
      const [r] = (await pool.query(`SELECT COUNT(*) AS n FROM cdm_party p${scope}`, ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])) as unknown as [{ n: number }[]];
      const n = Number(r[0]?.n ?? 0);
      const who = deps.person === 'member' ? 'member' : 'customer';
      return {
        title: 'Relationship Manager',
        lede: `Find a ${who} to open their record.`,
        take: { headline: `${count(n, who)} in your purview.`, action: { label: 'Who’s at risk of leaving?', ask: `Find ${who}s at risk of leaving and draft follow-ups` } },
        tiles: [],
        prompts: [`Find ${who}s at risk of leaving and draft follow-ups`, 'Prepare me for my meeting with Suzanne Jackson'],
        blocks: [],
      };
    },
  };
  return { views, calendarEvents };
}
