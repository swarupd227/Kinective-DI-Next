// The remaining business modules on the shared agent. Operations and Admin (spec 24.13, 24.14), the
// 5300 Call Report (24.25), Collections Early Warning (24.19), Campaigns (24.20) and SEG (24.22).
// Each states its limits: the Call Report agent is read-only, the Admin agent can't change its own
// user or impersonate anyone, and DI never contacts a borrower or changes a loan.
import { z } from 'zod';
import { CAPABILITIES, CoreError, SEG_STAGES, USER_CLASSES, type CallReportService, type CampaignService, type CollectionsService, type OperationsService, type SegService } from '@dinext/di-core';
import { money } from './pipelineAgent.ts';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const guard = (ctx: ModuleContext, id: string, message: string) => {
  if (!ctx.modules.includes(id)) throw new CoreError('NO_ACCESS', message);
};
const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/’/g, "'");
const dollars = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

// ---- operations and admin ---------------------------------------------------------------------

const CAP_WORDS: [RegExp, string][] = [[/incentive|payout/i, 'approve_incentives'], [/referral/i, 'referrals'], [/pipeline|application/i, 'loan_pipeline'], [/report/i, 'reports'], [/complian|issue/i, 'compliance'], [/users?\b/i, 'manage_users'], [/data log/i, 'data_logs']];
const capabilityFrom = (t: string) => CAP_WORDS.find(([w]) => w.test(t))?.[1];

export function operationsModule(ops: OperationsService): ModuleSpec {
  const noAccess = 'Operations and user administration aren’t part of your DI access.';
  const need = (ctx: ModuleContext) => guard(ctx, 'operations', noAccess);
  const admin = (ctx: ModuleContext) => guard(ctx, 'admin', 'Changing users needs the User Mgr permission.');
  const spec: ModuleSpec = {
    id: 'operations',
    prefix: 'ops',
    agent: 'Operations',
    request: /\bnightly build\b|\blast night['’]?s? (build|load)\b|\buploaders?\b|\blate[- ]file\b|\b(data quality|dq) checks?\b|\bchecks? failed\b|\bcreate a user\b|\bwho can\b|\bwhy can['’]?t\b|\b(lock|unlock) .*(user|account)\b|^\s*(lock|unlock)\s+\S+\s+\S+\s*[.!?]?\s*$|\bspoof\b|\bimpersonate\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Build and data quality', ref: 'table:ops_dq_check' }],
    prompt: ({ tenant, user, title }) => `You are the Operations agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) runs the platform.

- "Did last night's build finish?", "which uploaders missed their late-file time?": ops_build_status.
- "Which checks failed?": ops_checks_list.
- "Who can approve incentives?": iam_who_can. "Why can't Tom see the Westport referrals?": iam_access_explain.
- "Create a user for Maria Gomez as a Westport MSR": iam_user_create. Lock or unlock: iam_user_status.
- Impersonating a user isn't available. You can't change your own user.`,
    plan: (text) => {
      const t = clean(text);
      if (/\bspoof\b|\bimpersonate\b/i.test(t)) return { say: 'Impersonating a user isn’t available through DI.' };
      if (/\bcreate a user\b/i.test(t)) {
        const m = /\bfor ((?:[A-Z][\w'-]*\s?){1,3}?)\s+as an? (?:([A-Z][a-z]+)\s+)?([A-Z][\w]*)/.exec(t);
        return m ? { tool: 'iam_user_create', args: { name: m[1]!.trim(), user_class: m[3]!, ...(m[2] ? { branch: m[2] } : {}) } } : { say: 'Who’s the user, and which class and branch should they have?' };
      }
      const lock = /\b([Ll]ock|[Uu]nlock)\s+((?:[A-Z][\w'-]*\s?){1,3})/.exec(t);
      if (lock) return { tool: 'iam_user_status', args: { user: lock[2]!.replace(/\s*(?:user|account)?\s*$/i, '').trim(), lock: lock[1]!.toLowerCase() === 'lock' } };
      const why = /\bwhy can'?t ((?:[A-Z][\w'-]*\s?){1,3}?)\s+(see|approve|open|work)\b(.*)$/i.exec(t);
      if (why) return { tool: 'iam_access_explain', args: { user: why[1]!.trim(), what: `${why[2]} ${why[3]}`.trim(), ...(/\b(?:the\s+)?([A-Z][a-z]+) (?:referrals|applications|reports)\b/.exec(why[3]!)?.[1] ? { branch: /\b(?:the\s+)?([A-Z][a-z]+) (?:referrals|applications|reports)\b/.exec(why[3]!)![1] } : {}) } };
      if (/\bwho can\b/i.test(t)) return { tool: 'iam_who_can', args: { what: t } };
      if (/\bchecks?\b/i.test(t)) return { tool: 'ops_checks_list', args: { failed_only: /\bfailed\b/i.test(t) } };
      return { tool: 'ops_build_status', args: {} };
    },
    tools: [
      {
        name: 'ops_build_status',
        description: 'Last night’s build, and which uploaders arrived late.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const b = await ops.build();
          const late = b.uploads.filter((u) => u.late);
          return { text: `Last night’s build **${b.state}**, with data as of ${b.asOf}. ${late.length ? `**${late.length}** ${late.length === 1 ? 'uploader' : 'uploaders'} missed the late-file time: ${late.map((u) => `${u.source} (due ${u.dueBy}, arrived ${u.arrived})`).join(', ')}.` : 'Every uploader arrived on time.'}`, blocks: [moduleTable(spec, 'Uploads', ctx.runId, 'build.state.get', [{ field: 'source', headerName: 'Source', type: 'text' }, { field: 'dueBy', headerName: 'Due by', type: 'text' }, { field: 'arrived', headerName: 'Arrived', type: 'text' }, { field: 'state', headerName: 'State', type: 'text' }], b.uploads.map((u) => ({ source: u.source, dueBy: u.dueBy, arrived: u.arrived, state: u.late ? 'Late' : 'On time' })))] };
        },
      },
      {
        name: 'ops_checks_list',
        description: 'Data quality checks from the last build, by business domain and dimension.',
        input: z.object({ failed_only: z.boolean().default(false) }).strict(),
        run: async (a: { failed_only: boolean }, ctx) => {
          need(ctx);
          const c = await ops.checks(a.failed_only);
          const failed = c.items.filter((x) => !x.passed);
          return { text: c.failed ? `**${c.failed} of ${c.total} checks failed**${a.failed_only ? `: ${failed.map((x) => `${x.name} in ${x.domain} (${x.rowsFailed.toLocaleString('en-US')} rows)`).join(', ')}` : ''}.` : `All ${c.total} checks passed.`, blocks: c.items.length ? [moduleTable(spec, 'Data quality checks', ctx.runId, 'dq.status_report', [{ field: 'domain', headerName: 'Domain', type: 'text' }, { field: 'dimension', headerName: 'Dimension', type: 'text' }, { field: 'name', headerName: 'Check', type: 'text' }, { field: 'result', headerName: 'Result', type: 'text' }], c.items.map((x) => ({ domain: x.domain, dimension: x.dimension, name: x.name, result: x.passed ? 'Passed' : `Failed, ${x.rowsFailed} rows` })))] : [] };
        },
      },
      {
        name: 'iam_who_can',
        description: 'Which classes and people hold a capability.',
        input: z.object({ what: z.string().min(2).max(120) }).strict(),
        run: async (a: { what: string }, ctx) => {
          need(ctx);
          const cap = capabilityFrom(a.what);
          if (!cap) throw new CoreError('INVALID', `Which capability do you mean: ${Object.values(CAPABILITIES).join(', ')}?`);
          const w = await ops.whoCan(cap);
          return { text: `**${w.users.length} ${w.users.length === 1 ? 'person' : 'people'}** can ${CAPABILITIES[cap]}, through the ${w.classes.join(' and ')} ${w.classes.length === 1 ? 'class' : 'classes'}.`, blocks: [moduleTable(spec, 'Who can', ctx.runId, 'iam.user.list', [{ field: 'name', headerName: 'Name', type: 'text' }, { field: 'userClass', headerName: 'Class', type: 'text' }, { field: 'branch', headerName: 'Branch', type: 'text' }], w.users.slice(0, 25).map((u) => ({ name: u.name, userClass: u.userClass, branch: u.branch ?? 'All' })))] };
        },
      },
      {
        name: 'iam_access_explain',
        description: 'Why someone can or can’t do something, decided by the platform’s rules.',
        input: z.object({ user: z.string().min(2).max(80), what: z.string().min(2).max(120), branch: z.string().max(40).optional() }).strict(),
        run: async (a: { user: string; what: string; branch?: string }, ctx) => {
          need(ctx);
          const cap = capabilityFrom(a.what);
          if (!cap) throw new CoreError('INVALID', `Which capability do you mean: ${Object.values(CAPABILITIES).join(', ')}?`);
          const u = await ops.user(a.user);
          const r = ops.explain(u, cap, a.branch);
          return { text: `**${u.name} ${r.allowed ? 'can' : 'can’t'}** ${CAPABILITIES[cap]}${a.branch ? ` for ${a.branch}` : ''}: ${r.because}` };
        },
      },
      {
        name: 'iam_user_create',
        description: 'Prepare a new user with a class and branch. High risk, re-confirmed on screen. Returns approval_required.',
        input: z.object({ name: z.string().min(2).max(80), user_class: z.string().max(30), branch: z.string().max(40).optional() }).strict(),
        run: async (a: { name: string; user_class: string; branch?: string }, ctx) => {
          need(ctx);
          admin(ctx);
          const userClass = USER_CLASSES.find((c) => c.toLowerCase() === a.user_class.toLowerCase());
          if (!userClass) throw new CoreError('INVALID', `Which class: ${USER_CLASSES.join(', ')}?`);
          if (['Administrator'].includes(userClass) && !ctx.modules.includes('admin')) throw new CoreError('NO_ACCESS', 'You can’t grant a class you don’t hold.');
          return { change: { summary: `Create user ${a.name} as ${userClass}${a.branch ? ` at ${a.branch}` : ''}`, changes: [{ label: 'User', before: '—', after: a.name }, { label: 'Class', before: '—', after: userClass }, { label: 'Purview', before: '—', after: a.branch ?? 'All branches' }], text: `I’ve prepared a new user for **${a.name}**.`, done: `Created **${a.name}** as ${userClass}.`, risk: 'high', stepUp: true, apply: { name: a.name, userClass, branch: a.branch ?? null } } };
        },
        apply: async (p: Parameters<OperationsService['createUser']>[0], meta) => ops.createUser(p, meta),
      },
      {
        name: 'iam_user_status',
        description: 'Prepare locking or unlocking a user. Not your own. Returns approval_required.',
        input: z.object({ user: z.string().min(2).max(80), lock: z.boolean() }).strict(),
        run: async (a: { user: string; lock: boolean }, ctx) => {
          need(ctx);
          admin(ctx);
          const u = await ops.user(a.user);
          if (u.userId === ctx.user.id || u.name === ctx.user.name) throw new CoreError('NO_ACCESS', 'I can’t change your own user.');
          const to = a.lock ? 'Locked' : 'Active';
          return { change: { summary: `${a.lock ? 'Lock' : 'Unlock'} ${u.name}`, changes: [{ label: u.name, before: u.status, after: to }], text: `I’ve prepared ${a.lock ? 'locking' : 'unlocking'} **${u.name}**.`, done: `**${u.name}** is now ${to.toLowerCase()}.`, risk: 'high', stepUp: true, apply: { userId: u.userId, status: to } } };
        },
        apply: async (p: { userId: string; status: 'Active' | 'Locked' }) => ops.setStatus(p.userId, p.status),
      },
    ],
  };
  return spec;
}

// ---- 5300 Call Report -------------------------------------------------------------------------

export function callReportModule(cr: CallReportService): ModuleSpec {
  const noAccess = 'The 5300 Call Report is for credit unions with the module. A bank call report is scoped separately by Kinective.';
  const need = (ctx: ModuleContext) => guard(ctx, 'callreport', noAccess);
  const READ_ONLY = 'I can’t export, submit or change mappings on the 5300. Export for upload stays a person’s action in the 5300 workspace, and mappings are changed in its grid by authorised staff.';
  const code = /\b(\d{3}[A-Z]?)\b/;
  const spec: ModuleSpec = {
    id: 'callreport',
    prefix: 'cr',
    agent: 'Call Report',
    request: /\b5300\b|\bcall report\b|\bready to file\b|\bschedule [A-Z]\b|\bline \d{3}[A-Z]?\b|\b(how is|why did) \d{3}[A-Z]?\b/i,
    noAccess,
    sources: [{ kind: 'table', label: '5300 Call Report', ref: 'table:cr_line' }],
    prompt: ({ tenant, user, title }) => `You are the Call Report agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) prepares the quarterly 5300.

- "Are we ready to file Q3?": cr_readiness.
- "How is 025B calculated?", "why did 025B go up?": cr_line_explain.
- "Show schedule A changes over 10% from last quarter": cr_variance.
- You are read-only. If asked to export, submit or change a mapping, say a person does that in the 5300 workspace.`,
    plan: (text) => {
      const t = clean(text);
      if (/\b(export|submit|file it|upload|change|edit|remap)\b/i.test(t) && !/\bready\b/i.test(t)) return { say: READ_ONLY };
      if (/\bready\b/i.test(t)) return { tool: 'cr_readiness', args: {} };
      const line = code.exec(t)?.[1];
      if (line && line !== '5300') return { tool: 'cr_line_explain', args: { code: line } };
      return { tool: 'cr_variance', args: { min_pct: Number(/(\d+(?:\.\d+)?)\s*%/.exec(t)?.[1] ?? 10), ...(/\bschedule ([A-Z])\b/i.exec(t)?.[1] ? { schedule: /\bschedule ([A-Z])\b/i.exec(t)![1] } : {}) } };
    },
    tools: [
      {
        name: 'cr_readiness',
        description: 'Whether the quarter is ready to review, with any failed checks.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const r = await cr.readiness();
          return { text: r.ready ? 'The Q3 5300 is **ready to review**: every check passed. Export for upload stays with you in the 5300 workspace.' : `The Q3 5300 **isn’t ready yet**: ${r.failed.length} of ${r.checks.length} checks failed. ${r.failed.map((c) => `${c.name}: ${c.detail}`).join(' ')}`, blocks: [moduleTable(spec, 'Checks', ctx.runId, 'dq.status_report', [{ field: 'name', headerName: 'Check', type: 'text' }, { field: 'result', headerName: 'Result', type: 'text' }, { field: 'detail', headerName: 'Detail', type: 'text' }], r.checks.map((c) => ({ name: c.name, result: c.passed ? 'Passed' : 'Failed', detail: c.detail })))] };
        },
      },
      {
        name: 'cr_line_explain',
        description: 'How a 5300 line is built from its entry types and multipliers, compared with last quarter.',
        input: z.object({ code: z.string().min(3).max(6) }).strict(),
        run: async (a: { code: string }, ctx) => {
          need(ctx);
          const l = await cr.line(a.code);
          const top = [...l.entries].sort((x, y) => Math.abs((y.current - y.prior) * y.multiplier) - Math.abs((x.current - x.prior) * x.multiplier))[0];
          return { text: `Line **${l.code}**, ${l.name}, is **${dollars(l.current)}**, ${l.change >= 0 ? 'up' : 'down'} ${dollars(Math.abs(l.change))} (${Math.abs(l.pct)}%) from ${dollars(l.prior)} last quarter.${top ? ` **${top.entryType}** moved most, by ${dollars(Math.abs(top.current - top.prior))}.` : ''}`, blocks: [moduleTable(spec, `How ${l.code} is built`, ctx.runId, 'callreport.line.explain', [{ field: 'entry', headerName: 'Entry type', type: 'text' }, { field: 'source', headerName: 'Source', type: 'text' }, { field: 'multiplier', headerName: 'Sign', type: 'text' }, { field: 'prior', headerName: 'Q2', type: 'currency' }, { field: 'current', headerName: 'Q3', type: 'currency' }], l.entries.map((e) => ({ entry: e.entryType, source: e.source, multiplier: e.multiplier > 0 ? '+1' : '−1', prior: e.prior, current: e.current })))] };
        },
      },
      {
        name: 'cr_variance',
        description: 'Lines that moved by at least a percentage from last quarter, largest first.',
        input: z.object({ min_pct: z.number().min(0).max(1000).default(10), schedule: z.string().max(4).optional() }).strict(),
        run: async (a: { min_pct: number; schedule?: string }, ctx) => {
          need(ctx);
          const v = await cr.variance(a.min_pct, a.schedule);
          if (!v.length) return { text: `No lines moved ${a.min_pct}% or more from last quarter.` };
          return { text: `**${v.length} ${v.length === 1 ? 'line' : 'lines'}** moved ${a.min_pct}% or more from Q2${a.schedule ? ` in schedule ${a.schedule.toUpperCase()}` : ''}. The largest is **${v[0]!.code}**, ${v[0]!.name}, at ${v[0]!.pct}%.`, blocks: [moduleTable(spec, 'Changes from Q2', ctx.runId, 'callreport.variance', [{ field: 'code', headerName: 'Account', type: 'text' }, { field: 'name', headerName: 'Line', type: 'text' }, { field: 'prior', headerName: 'Q2', type: 'currency' }, { field: 'current', headerName: 'Q3', type: 'currency' }, { field: 'change', headerName: 'Change', type: 'text' }], v.map((l) => ({ code: l.code, name: l.name, prior: l.prior, current: l.current, change: `${l.pct}%` })))], suggestions: [`How is ${v[0]!.code} calculated?`] };
        },
      },
    ],
  };
  return spec;
}

// ---- collections early warning ----------------------------------------------------------------

const TASK_CAP = 10;

export function collectionsModule(col: CollectionsService): ModuleSpec {
  const noAccess = 'Collections early warning isn’t part of your DI access.';
  const need = (ctx: ModuleContext) => guard(ctx, 'collections', noAccess);
  const spec: ModuleSpec = {
    id: 'collections',
    prefix: 'col',
    agent: 'Collections Early Warning',
    request: /\bearly[- ]warning\b|\bwatch ?list\b|\boutreach tasks?\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Loans and predictive scores', ref: 'table:cdm_loan' }],
    today: async (ctx) => {
      const w = await col.watchlist(ctx);
      const open = w.items.filter((l) => !l.queued).length;
      return open ? { id: 'collections', title: `${open} ${open === 1 ? 'loan' : 'loans'} on the early-warning list`, why: `Current, but showing stress: ${w.signals[0]?.label ?? 'see the list'}.`, badge: 'Watch', ask: 'Show the early-warning list', weight: 55 } : null;
    },
    prompt: ({ tenant, user, title }) => `You are the Collections Early-Warning agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) watches loans that are current but showing stress.

- "Show the early-warning list": col_watchlist.
- "Queue outreach tasks": col_outreach_prepare.
- You never contact a borrower, change loan terms or take adverse action. You only queue tasks for the collections team.`,
    plan: (text) => {
      const t = clean(text);
      if (/\b(call|email|text|contact|waive|defer|modify)\b.*\b(borrowers?|members?|loans?)\b/i.test(t) && !/\btasks?\b/i.test(t)) return { say: 'I don’t contact borrowers or change loans. I can queue outreach tasks for the collections team.' };
      if (/\b(queue|create|prepare)\b.*\btasks?\b/i.test(t)) return { tool: 'col_outreach_prepare', args: {} };
      return { tool: 'col_watchlist', args: {} };
    },
    tools: [
      {
        name: 'col_watchlist',
        description: 'Loans that are current but whose borrower shows stress, with the signals and the data date.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const w = await col.watchlist(ctx);
          if (!w.count) return { text: 'Nothing is on the early-warning list.' };
          return { text: `**${w.count} ${w.count === 1 ? 'loan' : 'loans'}**, ${money(w.dollars)}, are current but showing stress. The main signals are ${w.signals.slice(0, 3).map((s) => `${s.label} (${s.count})`).join(', ')}.`, blocks: [moduleTable(spec, 'Early-warning list', ctx.runId, 'collections.watchlist.get', [{ field: 'member', headerName: 'Member', type: 'text' }, { field: 'loan', headerName: 'Loan', type: 'text' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'signals', headerName: 'Signals', type: 'text' }, { field: 'action', headerName: 'Suggested', type: 'text' }], w.items.slice(0, 25).map((l) => ({ member: `${l.name} (…${l.last4})`, loan: l.category, balance: l.balance, signals: l.signals.join(', '), action: l.queued ? 'Outreach queued' : 'Outreach call' })))], suggestions: w.items.some((l) => !l.queued) ? ['Queue outreach tasks for the early-warning list'] : [] };
        },
      },
      {
        name: 'col_outreach_prepare',
        description: `Prepare outreach tasks for the collections team, for up to ${TASK_CAP} loans at the top of the list. Nobody is contacted by DI. Returns approval_required.`,
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const open = (await col.watchlist(ctx)).items.filter((l) => !l.queued).slice(0, TASK_CAP);
          if (!open.length) throw new CoreError('NOT_FOUND', 'Every loan on the list already has outreach queued.');
          return { change: { summary: `Queue ${open.length} outreach ${open.length === 1 ? 'task' : 'tasks'} for the collections team`, changes: open.slice(0, 8).map((l) => ({ label: `${l.name}, ${l.category}`, before: dollars(l.balance), after: l.signals.join(', ') })), text: `I’ve prepared outreach tasks for the top ${open.length}. DI contacts nobody, and no loan changes.`, done: `Queued ${open.length} outreach ${open.length === 1 ? 'task' : 'tasks'} for the collections team.`, risk: 'medium', apply: { loanIds: open.map((l) => l.loanId) } } };
        },
        apply: async (p: { loanIds: number[] }, meta, ctx) => col.queue(p.loanIds, { approvalId: meta.approvalId, actor: ctx.user.name }),
      },
    ],
  };
  return spec;
}

// ---- campaigns --------------------------------------------------------------------------------

export function campaignModule(cmp: CampaignService): ModuleSpec {
  const noAccess = 'Campaigns aren’t part of your DI access.';
  const need = (ctx: ModuleContext) => guard(ctx, 'campaigns', noAccess);
  const spec: ModuleSpec = {
    id: 'campaigns',
    prefix: 'cmp',
    agent: 'Campaigns',
    request: /\bcampaigns?\b|\baudiences?\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Campaign Success', ref: 'table:cmp_campaign' }],
    prompt: ({ tenant, user, title }) => `You are the Campaign agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) reviews campaigns and builds audiences.

- "Which campaigns produced the most loan dollars?": cmp_results.
- "Build an audience of members with no auto loan": cmp_audience_prepare. Suppression is applied by the platform and its counts are shown.
- Exporting an audience file isn't available here.`,
    plan: (text) => {
      const t = clean(text);
      if (/\bexport\b/i.test(t)) return { say: 'Exporting an audience moves member contact data out of DI, and that isn’t built in this demo. I can save the audience.' };
      const no = /\bno ([\w ]+?) loan\b|\bwithout an? ([\w ]+?) loan\b/i.exec(t);
      if (/\baudience\b/i.test(t)) return no ? { tool: 'cmp_audience_prepare', args: { without_category: (no[1] ?? no[2])! } } : { say: 'Which loan should the audience not already have?' };
      return { tool: 'cmp_results', args: {} };
    },
    tools: [
      {
        name: 'cmp_results',
        description: 'Campaigns by loan dollars, with channel, applications and sends.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const r = await cmp.results();
          const [top] = r;
          return { text: top ? `**${top.name}** produced the most loan dollars: **${money(top.dollars)}** from ${top.applications} applications by ${top.channel.toLowerCase()}. Attribution uses each campaign’s response window.` : 'No campaigns have run.', blocks: [moduleTable(spec, 'Campaign results', ctx.runId, 'campaign.results', [{ field: 'name', headerName: 'Campaign', type: 'text' }, { field: 'channel', headerName: 'Channel', type: 'text' }, { field: 'product', headerName: 'Product', type: 'text' }, { field: 'sent', headerName: 'Sent', type: 'count' }, { field: 'applications', headerName: 'Applications', type: 'count' }, { field: 'dollars', headerName: 'Loan dollars', type: 'currency' }], r)] };
        },
      },
      {
        name: 'cmp_audience_prepare',
        description: 'Prepare an audience of members without a loan type, after the platform’s suppression rules. Returns approval_required to save it.',
        input: z.object({ without_category: z.string().min(2).max(40) }).strict(),
        run: async (a: { without_category: string }, ctx) => {
          need(ctx);
          const x = await cmp.audience(a.without_category, ctx);
          const name = `Members without ${x.category}`;
          return { change: { summary: `Save the audience “${name}”: ${x.size.toLocaleString('en-US')} members`, changes: [{ label: 'Matched', before: '—', after: x.found.toLocaleString('en-US') }, { label: 'Marketing opt-outs removed', before: '—', after: x.optOut.toLocaleString('en-US') }, { label: 'Recent contact removed', before: '—', after: x.recent.toLocaleString('en-US') }, { label: 'Audience', before: '—', after: x.size.toLocaleString('en-US') }], text: `**${x.size.toLocaleString('en-US')} members** have no ${x.category} loan, after removing ${x.optOut.toLocaleString('en-US')} opt-outs and ${x.recent.toLocaleString('en-US')} contacted recently.`, done: `Saved the audience **${name}**. Nothing has been sent or exported.`, risk: 'medium', apply: { name, category: x.category, size: x.size } } };
        },
        apply: async (p: Parameters<CampaignService['save']>[0], meta) => cmp.save(p, meta),
      },
    ],
  };
  return spec;
}

// ---- SEG --------------------------------------------------------------------------------------

export function segModule(seg: SegService, today: () => string): ModuleSpec {
  const noAccess = 'SEG Management is for credit unions.';
  const need = (ctx: ModuleContext) => guard(ctx, 'seg', noAccess);
  const company = /\b(?:with|for|at)\s+((?:[A-Z][\w&'-]*\s?){1,4})/;
  const spec: ModuleSpec = {
    id: 'seg',
    prefix: 'seg',
    agent: 'SEG Development',
    request: /\bSEGs?\b|\bsponsor(?:ship|ing)?\b|\blunch-and-learn\b|\bprospect stage\b/,
    noAccess,
    sources: [{ kind: 'table', label: 'SEG Management', ref: 'table:seg_company' }],
    prompt: ({ tenant, user, title }) => `You are the SEG/Business Development agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) develops select employee groups.

- "Which SEGs had the most new members?": seg_performance.
- "Prepare me for my SEG meeting with Albany Medical": seg_brief.
- "Log a SEG call with Acme HR ...": seg_interaction_prepare.
- "Move Acme HR to Proposal": seg_stage_prepare. Stages from Submit Letter for Board Approval onward need a note.`,
    plan: (text) => {
      const t = clean(text);
      const name = company.exec(t)?.[1]?.trim();
      const stage = SEG_STAGES.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(t));
      if (/\bmove\b/i.test(t) && stage) return { tool: 'seg_stage_prepare', args: { company: /\b[Mm]ove ((?:[A-Z][\w&'-]*\s?){1,4}?)\s+to\b/.exec(t)?.[1]?.trim() ?? '', stage, ...(/[:—]\s*(.+)$/.exec(t)?.[1] ? { note: /[:—]\s*(.+)$/.exec(t)![1] } : {}) } };
      if (/^\s*log\b/i.test(t)) return name ? { tool: 'seg_interaction_prepare', args: { company: name.replace(/[,.].*$/, ''), kind: /\bmeeting\b/i.test(t) ? 'Meeting' : 'Phone call', note: t } } : { say: 'Which company was it?' };
      if (/\b(prepare|brief)\b/i.test(t) && name) return { tool: 'seg_brief', args: { company: name } };
      return { tool: 'seg_performance', args: {} };
    },
    tools: [
      {
        name: 'seg_performance',
        description: 'Companies by new members, with stage, loans and deposits.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const list = await seg.companies();
          const [top] = list;
          return { text: top ? `**${top.name}** added the most members this quarter, with **${top.newMembers}** new.` : 'No SEGs are set up.', blocks: [moduleTable(spec, 'SEG performance', ctx.runId, 'seg.performance', [{ field: 'name', headerName: 'Company', type: 'text' }, { field: 'stage', headerName: 'Stage', type: 'text' }, { field: 'members', headerName: 'Members', type: 'count' }, { field: 'newMembers', headerName: 'New', type: 'count' }, { field: 'loans', headerName: 'Loans', type: 'currency' }, { field: 'deposits', headerName: 'Deposits', type: 'currency' }], list.map(({ name, stage, members, newMembers, loans, deposits }) => ({ name, stage, members, newMembers, loans, deposits })))] };
        },
      },
      {
        name: 'seg_brief',
        description: 'A meeting brief: performance, sponsorship and the last three interactions.',
        input: z.object({ company: z.string().min(2).max(80) }).strict(),
        run: async (a: { company: string }, ctx) => {
          need(ctx);
          const c = await seg.company(a.company);
          return { text: `**${c.name}** is at **${c.stage}**, with ${c.members} members, ${money(c.loans)} in loans and ${money(c.deposits)} in deposits.${c.sponsorship ? ` Sponsorship: ${c.sponsorship}.` : ''}${c.interactions.length ? `\n\nLast interactions:\n${c.interactions.map((i) => `- ${i.at}, ${i.kind}: ${i.note}`).join('\n')}` : ' There are no interactions yet.'}` };
        },
      },
      {
        name: 'seg_interaction_prepare',
        description: 'Prepare logging a call or meeting with a company. Returns approval_required.',
        input: z.object({ company: z.string().min(2).max(80), kind: z.enum(['Phone call', 'Meeting', 'Email']), note: z.string().min(2).max(300) }).strict(),
        run: async (a: { company: string; kind: string; note: string }, ctx) => {
          need(ctx);
          const c = await seg.company(a.company);
          return { change: { summary: `Log a ${a.kind.toLowerCase()} with ${c.name}`, changes: [{ label: a.kind, before: '—', after: a.note }], text: `I’ve prepared the ${a.kind.toLowerCase()} for **${c.name}**.`, done: `Logged the ${a.kind.toLowerCase()} with **${c.name}**.`, risk: 'low', apply: { companyId: c.companyId, kind: a.kind, note: a.note } } };
        },
        apply: async (p: { companyId: number; kind: string; note: string }, meta, ctx) => seg.log(p, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }),
      },
      {
        name: 'seg_stage_prepare',
        description: 'Prepare moving a company to a stage. A board-related stage needs a note. Returns approval_required.',
        input: z.object({ company: z.string().min(2).max(80), stage: z.string().max(40), note: z.string().max(300).optional() }).strict(),
        run: async (a: { company: string; stage: string; note?: string }, ctx) => {
          need(ctx);
          const stage = SEG_STAGES.find((s) => s.toLowerCase() === a.stage.toLowerCase());
          if (!stage) throw new CoreError('INVALID', `Which stage: ${SEG_STAGES.join(', ')}?`);
          if (SEG_STAGES.indexOf(stage) >= 4 && !a.note?.trim()) throw new CoreError('INVALID', `Moving to ${stage} needs a note. What should it say?`);
          const c = await seg.company(a.company);
          return { change: { summary: `Move ${c.name} to ${stage}`, changes: [{ label: c.name, before: c.stage, after: stage }, ...(a.note ? [{ label: 'Note', before: '—', after: a.note }] : [])], text: `I’ve prepared moving **${c.name}** to ${stage}.`, done: `**${c.name}** is now at ${stage}.`, risk: 'medium', apply: { companyId: c.companyId, stage, note: a.note ?? null } } };
        },
        apply: async (p: { companyId: number; stage: string; note: string | null }, meta, ctx) => seg.setStage(p.companyId, p.stage, p.note, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }),
      },
    ],
  };
  return spec;
}

