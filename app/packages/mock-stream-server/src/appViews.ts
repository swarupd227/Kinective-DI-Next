// The workspace pages (spec 8.10 to 8.15, 8.19, 8.22). Each page opens on DI's view, then the figures
// and records to check. They read the same DI Core services the agents use, under the same purview,
// so a page and an answer always agree. Changes happen in a task, behind an approval card.
import type { AppTile, AppView, AppViewId, Block, TableBlock } from '@dinext/block-schemas';
import { IndirectService, ProspectService, CalendarService, CallReportService, DataLogService, FILE_FOLDERS, FILE_LIBRARY, GovernanceService, IssueService, OnboardingService, OperationsService, RetentionService, SAVED_QUERIES, SegService, type CalendarEvent, type CoreContext } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';

type ColumnSpec = TableBlock['data']['columns'][number];

export interface ViewDeps {
  pool: Pool;
  blockId: () => string;
  person: 'member' | 'customer';
  ctx: CoreContext;
  employeeId?: number;
  leads: boolean;
  modules: string[];
  retention: boolean;
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
    const service = new CalendarService({ onboarding: onboarding as never, issues: issues as never, retention: retention as never });
    const items = await service.events({ employeeId: deps.leads ? undefined : deps.employeeId, canUse: (s) => (s === 'retention' ? deps.retention : deps.modules.includes(s)), ctx });
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
        lede: `Dated work from your modules, as of the last build on ${today}.`,
        take: { headline: overdue.length ? `${count(overdue.length, 'item')} overdue. Start with ${next?.title}.` : next ? `Next up: ${next.title}, on ${next.date}.` : 'Nothing is scheduled in the next few weeks.', action: { label: 'What’s due this week?', ask: 'What’s due this week?' } },
        tiles: [{ label: 'Overdue', value: String(overdue.length), tone: overdue.length ? 'danger' : 'neutral' }, { label: 'Today', value: String(items.filter((e) => e.date === today).length) }, { label: 'Next 7 days', value: String(week.length) }],
        prompts: ['What’s due this week?', 'Show the calendar for the next two weeks'],
        events: items.map(({ date, kind, title, detail, late, ask }) => ({ date, kind, title, detail, late, ask })),
        today,
        blocks: [],
      };
    },
    async files() {
      const folders = Object.keys(FILE_FOLDERS);
      const newest = [...FILE_LIBRARY].sort((a, b) => b.modified.localeCompare(a.modified))[0]!;
      return {
        title: 'Files',
        lede: 'Documents your institution keeps in DI.',
        take: { headline: `${count(FILE_LIBRARY.length, 'file')} in ${count(folders.length, 'folder')}. The newest is ${newest.name}.`, action: { label: 'Find a document', ask: 'Find the dealer agreement for Smith Ford' } },
        tiles: [{ label: 'Files', value: String(FILE_LIBRARY.length) }, { label: 'Folders', value: String(folders.length) }, { label: 'Total size', value: `${(FILE_LIBRARY.reduce((n, f) => n + f.sizeKb, 0) / 1024).toFixed(1)} MB` }],
        prompts: ['Find the dealer agreement for Smith Ford', 'Who can see the Board Packs folder?'],
        notice: 'These are sample documents. Uploading, opening and moving files aren’t built yet.',
        blocks: [table('All files', 'files.list', [text('name', 'Name'), text('folder', 'Folder'), text('type', 'Type'), { field: 'size', headerName: 'Size (KB)', type: 'number' }, text('owner', 'Owner'), text('modified', 'Modified')], FILE_LIBRARY.map((f) => ({ name: f.name, folder: f.folder, type: f.type, size: f.sizeKb, owner: f.owner, modified: f.modified }))), table('Folders', 'files.folders', [text('folder', 'Folder'), { field: 'files', headerName: 'Files', type: 'count' }, text('access', 'Who can see it')], folders.map((folder) => ({ folder, files: FILE_LIBRARY.filter((f) => f.folder === folder).length, access: FILE_FOLDERS[folder]! })))],
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
