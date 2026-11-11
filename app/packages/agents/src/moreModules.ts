// The remaining business modules on the shared agent. Operations and Admin (spec 24.13, 24.14), the
// 5300 Call Report (24.25), Collections Early Warning (24.19), Campaigns (24.20) and SEG (24.22).
// Each states its limits: the Call Report agent is read-only, the Admin agent can't change its own
// user or impersonate anyone, and DI never contacts a borrower or changes a loan.
import { z } from 'zod';
import { CALL_REPORT_EDITION, CR_ADJUST_REASONS, CR_RESOLUTIONS, type CrAdjustReason, type CrResolution, CAPABILITIES, CLASSES, CoreError, SEG_STAGES, USER_CLASSES, type CallReportLine, type CallReportService, stampUtc, type ApiService, type CampaignService, type CollectionsService, type OperationsService, type SegService } from '@dinext/di-core';
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
    request: /\bis (the |our )?data (current|fresh|up to date|stale)\b|\bhow (fresh|current|old|recent) is (the |our )?data\b|\bnightly build\b|\bnew build\b|\blast night['’]?s? (build|load)\b|\buploaders?\b|\blate[- ]file\b|\b(data quality|dq) checks?\b|\bchecks? failed\b|\bcreate a user\b|\bwho can\b|\bwhy can['’]?t\b|\b(lock|unlock) .*(user|account)\b|^\s*(lock|unlock)\s+\S+\s+\S+\s*[.!?]?\s*$|\bspoof\b|\bimpersonate\b|\b(?:has|have) left\b|\bleaver\b|\boff-?board|\bremove (?:\w+ )?access\b|\bdeactivate\b|\b(?:to|into) the \w+ class\b|\bclass\b.*\b(?:to|into)\b|\bmake [A-Z][\w.'-]*(?: [A-Z][\w.'-]*)? an? (?:manager|lender|msr|executive|analyst|administrator)\b|\bsigned in\b|\bsign-?ins?\b|\bdormant\b|\blast (?:log|sign)/i,
    // Everyone may ask whether the data is current; without Operations they get the build's dates.
    shared: /\bis (the |our )?data (current|fresh|up to date|stale)\b|\bhow (fresh|current|old|recent) is (the |our )?data\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Platform operations: builds, checks and users', ref: 'table:ops_dq_check' }],
    prompt: ({ tenant, user, title }) => `You are the Operations agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) runs the platform.

- "Did last night's build finish?", "which uploaders missed their late-file time?": ops_build_status.
- "Which checks failed?": ops_checks_list.
- "Who can approve incentives?": iam_who_can. "Why can't Tom see the Westport referrals?": iam_access_explain.
- "Create a user for Maria Gomez as a Westport MSR": iam_user_create. Lock or unlock: iam_user_status.
- "Sofia Ruiz has left, remove her access": iam_user_offboard. "Change Ana Ruiz to the Manager class": iam_user_class.
- "Who hasn't signed in for 90 days?": iam_signin_review. Sign-in history isn't recorded yet; say so plainly.
- Access changes need a second approver, an executive or another administrator. The requester can withdraw them but not approve them.
- Impersonating a user isn't available. You can't change your own user.`,
    plan: (text) => {
      const t = clean(text);
      if (/\bspoof\b|\bimpersonate\b/i.test(t)) return { say: 'Impersonating a user isn’t available through DI.' };
      if (/\bcreate a user\b/i.test(t)) {
        const m = /\bfor ((?:[A-Z][\w'-]*\s?){1,3}?)\s+as an? (?:([A-Z][a-z]+)\s+)?([A-Z][\w]*)/.exec(t);
        return m ? { tool: 'iam_user_create', args: { name: m[1]!.trim(), user_class: m[3]!, ...(m[2] ? { branch: m[2] } : {}) } } : { say: 'Who’s the user, and which class and branch should they have?' };
      }
      // Offboarding, class changes and the sign-in review, asked in people's own words.
      const left = /\b((?:[A-Z][\w.'-]*\s?){1,3}?)\s+(?:has|have)\s+left\b/.exec(t) ?? /\b(?:offboard|deactivate|remove (?:the )?access (?:for|of))\s+((?:[A-Z][\w.'-]*\s?){1,3})/i.exec(t);
      if (left || /\b(?:leaver|off-?board|remove (?:\w+ )?access|deactivate)\b/i.test(t)) {
        const who = left?.[1]?.trim();
        return who ? { tool: 'iam_user_offboard', args: { user: who } } : { say: 'Who is leaving? Tell me their name and I’ll prepare locking their account.' };
      }
      const moveTo =
        /\b(?:[Cc]hange|[Mm]ove|[Ss]witch|[Pp]ut)\s+((?:[A-Z][\w.'-]*\s?){1,3}?)(?:\s+at\s+([A-Z][a-z]+))?\s+(?:to|into|in)\s+(?:the\s+)?([A-Za-z]+)(?:\s+class)?\b/.exec(t) ??
        /\b[Mm]ake\s+((?:[A-Z][\w.'-]*\s?){1,3}?)(?:\s+at\s+([A-Z][a-z]+))?\s+an?\s+([A-Za-z]+)\b/.exec(t);
      if (moveTo && USER_CLASSES.some((c) => c.toLowerCase() === moveTo[3]!.toLowerCase())) return { tool: 'iam_user_class', args: { user: [moveTo[1]!.trim(), moveTo[2]].filter(Boolean).join(' '), user_class: moveTo[3]! } };
      if (/\bsigned in\b|\bsign-?ins?\b|\bdormant\b|\blast (?:log|sign)/i.test(t)) return { tool: 'iam_signin_review', args: {} };
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
          const [b, checks] = await Promise.all([ops.build(), ops.checks(true)]);
          const late = b.uploads.filter((u) => u.late);
          const failed = checks.items.map((c) => `${c.name.charAt(0).toLowerCase()}${c.name.slice(1)}${'rowsFailed' in c && c.rowsFailed ? ` (${Number(c.rowsFailed).toLocaleString('en-US')} rows)` : ''}`);
          // The build is named by its date: data can be days old, and "last night's" would hide that.
          const d = new Date(`${b.asOf.slice(0, 10)}T00:00:00Z`);
          const built = /^\d{4}-\d{2}-\d{2}/.test(b.asOf) ? `${d.getUTCDate()} ${new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d)} ${d.getUTCFullYear()}` : b.asOf;
          const finished = /^\d{4}-\d{2}-\d{2}$/.test(b.finishedOn) ? (() => { const f = new Date(`${b.finishedOn}T00:00:00Z`); return `${f.getUTCDate()} ${new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(f)} ${f.getUTCFullYear()}`; })() : b.finishedOn;
          return { text: `${b.stale ? `**No new build for ${b.ageDays} days.** ` : ''}The latest build finished ${finished}, with data as of ${built}, and **${b.state}**. ${late.length ? `**${late.length}** ${late.length === 1 ? 'uploader' : 'uploaders'} missed the late-file time: ${late.map((u) => `${u.source} (due ${u.dueBy}, arrived ${u.arrived})`).join(', ')}.` : 'Every uploader arrived on time.'} ${checks.failed ? `**${checks.failed} of ${checks.total}** data quality checks failed: ${failed.join('; ')}.` : `All ${checks.total} data quality checks passed.`}`, blocks: [moduleTable(spec, 'Uploads', ctx.runId, 'build.state.get', [{ field: 'source', headerName: 'Source', type: 'text' }, { field: 'dueBy', headerName: 'Due by', type: 'text' }, { field: 'arrived', headerName: 'Arrived', type: 'text' }, { field: 'state', headerName: 'State', type: 'text' }], b.uploads.map((u) => ({ source: u.source, dueBy: u.dueBy, arrived: u.arrived, state: u.late ? 'Late' : 'On time' })))] };
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
          return { text: `**${w.users.length} ${w.users.length === 1 ? 'person' : 'people'}** can ${CAPABILITIES[cap]}, through the ${w.classes.length > 2 ? `${w.classes.slice(0, -1).join(', ')} and ${w.classes.at(-1)}` : w.classes.join(' and ')} ${w.classes.length === 1 ? 'class' : 'classes'}.`, blocks: [moduleTable(spec, 'Who can', ctx.runId, 'iam.user.list', [{ field: 'name', headerName: 'Name', type: 'text' }, { field: 'userClass', headerName: 'Class', type: 'text' }, { field: 'branch', headerName: 'Branch', type: 'text' }], w.users.slice(0, 25).map((u) => ({ name: u.name, userClass: u.userClass, branch: u.branch ?? 'All' })))] };
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
          return { change: { summary: `Create user ${a.name} as ${userClass}${a.branch ? ` at ${a.branch}` : ''}`, changes: [{ label: 'User', before: '—', after: a.name }, { label: 'Class', before: '—', after: userClass }, { label: 'Purview', before: '—', after: a.branch ?? 'All branches' }], text: `I’ve prepared a new user for **${a.name}**.`, done: `Created **${a.name}** as ${userClass}.`, risk: 'high', stepUp: true, secondApprover: { role: 'An executive or another administrator', policy: 'Access changes' }, apply: { name: a.name, userClass, branch: a.branch ?? null } } };
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
          return { change: { summary: `${a.lock ? 'Lock' : 'Unlock'} ${u.name}`, changes: [{ label: u.name, before: u.status, after: to }], text: `I’ve prepared ${a.lock ? 'locking' : 'unlocking'} **${u.name}**.`, done: `**${u.name}** is now ${to.toLowerCase()}.`, risk: 'high', stepUp: true, secondApprover: { role: 'An executive or another administrator', policy: 'Access changes' }, apply: { userId: u.userId, status: to } } };
        },
        apply: async (p: { userId: string; status: 'Active' | 'Locked' }) => ops.setStatus(p.userId, p.status),
      },
      {
        name: 'iam_user_offboard',
        description: 'Prepare offboarding someone who has left: lock their account. Needs a second approver. Returns approval_required.',
        input: z.object({ user: z.string().min(2).max(80) }).strict(),
        run: async (a: { user: string }, ctx) => {
          need(ctx);
          admin(ctx);
          const u = await ops.user(a.user);
          if (u.userId === ctx.user.id || u.name === ctx.user.name) throw new CoreError('NO_ACCESS', 'I can’t change your own user.');
          if (u.status !== 'Active') throw new CoreError('INVALID', `${u.name}’s account is already ${u.status.toLowerCase()}.`);
          return {
            change: {
              summary: `Offboard ${u.name}: lock their account`,
              changes: [
                { label: 'Account', before: u.status, after: 'Locked' },
                { label: 'Reason', before: '—', after: 'Left the institution' },
                { label: 'Open work', before: '—', after: `Stays in the ${u.branch ?? 'institution'} queues for the team` },
              ],
              text: `I’ve prepared offboarding **${u.name}** (${u.userClass}${u.branch ? `, ${u.branch}` : ''}). Locking stops their sign-in straight away. It needs a second approver: an executive or another administrator.`,
              done: `**${u.name}** is offboarded: their account is locked.`,
              risk: 'high',
              stepUp: true,
              secondApprover: { role: 'An executive or another administrator', policy: 'Access changes' },
              apply: { userId: u.userId, status: 'Locked' },
            },
          };
        },
        apply: async (p: { userId: string; status: 'Locked' }) => ops.setStatus(p.userId, p.status),
      },
      {
        name: 'iam_user_class',
        description: 'Prepare moving a user to another class. Needs a second approver. Returns approval_required.',
        input: z.object({ user: z.string().min(2).max(80), user_class: z.string().max(30) }).strict(),
        run: async (a: { user: string; user_class: string }, ctx) => {
          need(ctx);
          admin(ctx);
          const userClass = USER_CLASSES.find((c) => c.toLowerCase() === a.user_class.toLowerCase());
          if (!userClass) throw new CoreError('INVALID', `Which class: ${USER_CLASSES.join(', ')}?`);
          if (userClass === 'Administrator' && !ctx.modules.includes('admin')) throw new CoreError('NO_ACCESS', 'You can’t grant a class you don’t hold.');
          const u = await ops.user(a.user);
          if (u.userId === ctx.user.id || u.name === ctx.user.name) throw new CoreError('NO_ACCESS', 'I can’t change your own user.');
          if (u.userClass === userClass) throw new CoreError('INVALID', `${u.name} is already in the ${userClass} class.`);
          const can = (c: string) => (CLASSES[c] ?? []).map((k) => CAPABILITIES[k]!);
          const gains = can(userClass).filter((c) => !can(u.userClass).includes(c));
          const loses = can(u.userClass).filter((c) => !can(userClass).includes(c));
          return {
            change: {
              summary: `Move ${u.name} from ${u.userClass} to ${userClass}`,
              changes: [
                { label: 'Class', before: u.userClass, after: userClass },
                ...(gains.length ? [{ label: 'Can now', before: '—', after: gains.join(', ') }] : []),
                ...(loses.length ? [{ label: 'Can no longer', before: loses.join(', '), after: '—' }] : []),
              ],
              text: `I’ve prepared moving **${u.name}** to the ${userClass} class. It needs a second approver: an executive or another administrator.`,
              done: `**${u.name}** is now in the ${userClass} class.`,
              risk: 'high',
              stepUp: true,
              secondApprover: { role: 'An executive or another administrator', policy: 'Access changes' },
              apply: { userId: u.userId, userClass },
            },
          };
        },
        apply: async (p: { userId: string; userClass: string }) => ops.setClass(p.userId, p.userClass),
      },
      {
        name: 'iam_signin_review',
        description: 'Who has not signed in lately. Sign-in history is not recorded yet, so this says so and shows what can be reviewed.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const classes = await ops.classes();
          const active = classes.reduce((n, c) => n + c.active, 0);
          const locked = classes.reduce((n, c) => n + c.locked, 0);
          return {
            text: `DI doesn’t record sign-ins yet, so I can’t tell who hasn’t signed in. Sign-in history arrives with single sign-on through your identity provider. For an access review now: **${active}** active users and **${locked}** locked, by class below.`,
            blocks: [moduleTable(spec, 'Users by class', ctx.runId, 'iam.class.list', [{ field: 'userClass', headerName: 'Class', type: 'text' }, { field: 'active', headerName: 'Active', type: 'count' }, { field: 'locked', headerName: 'Locked', type: 'count' }], classes.map((c) => ({ userClass: c.userClass, active: c.active, locked: c.locked })))],
          };
        },
      },
    ],
  };
  return spec;
}

// ---- 5300 Call Report -------------------------------------------------------------------------

export function callReportModule(cr: CallReportService): ModuleSpec {
  const noAccess = 'The 5300 Call Report is for credit unions with the module. A bank call report is scoped separately by Kinective.';
  const need = (ctx: ModuleContext) => guard(ctx, 'callreport', noAccess);
  const READ_ONLY = 'I can’t submit the 5300 or change GL mappings. Filing in CUOnline stays a person’s action, and mappings are changed in the 5300 workspace by authorized staff. What I can do, each with your approval: record a manual adjustment to a line, settle a difference from your prepared figures, and write the explanation for a line that moved.';
  const DOWNLOAD = 'Yes. On the **Call Report** page there are three downloads: the **data file** (CSV) and the **XML file**, each 5300 account code and its value after any manual adjustments, for your Call Report software or to map to CUOnline’s import; and the **review workbook** (Excel), every schedule with the prior quarter, the edits, the explanations, the manual adjustments and the check against your prepared figures, for sign-off. While edits are open the files are marked DRAFT. Filing in CUOnline stays with you.';
  const code = /\b(\d{3}[A-Z]?\d?|[A-Z]{2}\d{4}|\d{4}[A-Z])\b/;
  const SCHEDULES: [RegExp, string, string?][] = [
    [/balance sheet|financial condition|\bassets\b|liabilit/i, 'SFC'],
    [/income|expense|net income|earnings/i, 'SIE'],
    [/delinquen|past due/i, 'A', 'Section 2 - Delinquent Loans & Leases: Total'],
    [/charge[- ]?offs?|recover/i, 'A', 'Section 3'],
    [/schedule a\b|loans by type|loan types/i, 'A', 'Section 1'],
    [/schedule b\b|investment/i, 'B'],
    [/schedule d\b|members|insured/i, 'D'],
  ];
  const money = (n: number | null) => (n === null ? '' : dollars(n));
  const change = (l: CallReportLine) => (l.change === null ? '' : `${l.change >= 0 ? 'up' : 'down'} ${dollars(Math.abs(l.change))}${l.pct !== null ? ` (${Math.abs(l.pct)}%)` : ''}`);
  const lineRows = (ls: CallReportLine[]) => ls.map((l) => ({ code: l.code, name: l.name, prior: l.prior ?? 0, current: l.current ?? 0, change: l.pct === null ? '' : `${l.pct}%` }));
  const lineCols = (prior: string, current: string) => [{ field: 'code', headerName: 'Account', type: 'text' as const }, { field: 'name', headerName: 'Line', type: 'text' as const }, { field: 'prior', headerName: prior, type: 'currency' as const }, { field: 'current', headerName: current, type: 'currency' as const }, { field: 'change', headerName: 'Change', type: 'text' as const }];
  const glCols = [{ field: 'gl', headerName: 'GL account', type: 'text' as const }, { field: 'name', headerName: 'Name', type: 'text' as const }, { field: 'balance', headerName: 'Balance', type: 'currency' as const }, { field: 'lastPosted', headerName: 'Last posted', type: 'text' as const }, { field: 'likely', headerName: 'Likely 5300 line', type: 'text' as const }, { field: 'note', headerName: 'Why it is open', type: 'text' as const }];
  const glRows = (gl: Awaited<ReturnType<CallReportService['uncategorized']>>) => gl.map((g) => ({ gl: g.glNumber, name: g.name, balance: g.balance, lastPosted: g.lastPosted, likely: g.likelyLine ?? 'Not suggested', note: g.note ?? '' }));
  const spec: ModuleSpec = {
    id: 'callreport',
    prefix: 'cr',
    agent: 'Call Report',
    request: /\b5300\b|\bcall report\b|\bprepared (?:5300|figures?|numbers)\b|\bmanual adjustments?\b|\b(?:di|di’s|di's|the prepared figure|our figure) is (?:correct|right) on\b|\badjust (?:line )?\d{3}[A-Z]?\d?\b|\bexplanation for (?:line )?\d{3}[A-Z]?\d?\b|\bready to file\b|\bschedule [A-I]\b|\bline \d{3}[A-Z]?\b|\b(how is|why did) \d{3}[A-Z]?\b|\buncategori[sz]ed gl\b|\bgl accounts? (are|is) (uncategori[sz]ed|unmapped)\b|\bnet worth ratio\b|\bwell capitali[sz]ed\b|\bcculr\b|\bpca\b/i,
    noAccess,
    sources: [{ kind: 'table', label: '5300 Call Report', ref: 'table:cr_line' }],
    prompt: ({ tenant, user, title }) => `You are the Call Report agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) prepares the quarterly NCUA Form 5300, ${CALL_REPORT_EDITION}. Lines are NCUA account codes (025B total loans and leases, 018 total shares and deposits, 041B loans 60+ days delinquent, 010 total assets, 997 net worth, 998 net worth ratio). NCUA edits are Errors, which block submission, and Warnings, which need an explanation in the comments.

- "Are we ready to file Q3?", "what's blocking the 5300?", "when is it due?": cr_readiness. It names any uncategorized GL accounts.
- "Which GL accounts are uncategorized?": cr_uncategorized.
- "How is 025B calculated?", "why did 041B go up?", "what's in line 013?": cr_line_explain with the account code.
- "What moved more than 10% since last quarter?", "which lines need an explanation?": cr_variance.
- "Show schedule A delinquency", "show the balance sheet", "show charge-offs": cr_schedule with the schedule (SFC, SIE, A, B, D, G) and, for Schedule A, a section word.
- "What's our net worth ratio?", "are we well capitalized?", "are we on the CCULR?": cr_capital.
- "Draft explanations for the lines that moved": cr_variance, then write one short draft per line from its figures in your message, saying a person adds them in the 5300 workspace.
- "Check our figures against DI", "where do we differ from our prepared 5300?": cr_reconcile.
- "DI is correct on 013 because…", "the prepared figure is right on 370, adjust DI", "that's explained: …": cr_resolve (resolution DI correct, Prepared correct or Explained, with the person's reason).
- "Adjust 003 by $412,600 for loans locked after the build": cr_adjust (amount, reason Timing, Participation, Mapping, Off-core loans, Correction or Other, and a note). "Show the manual adjustments": cr_adjustments.
- "Use this explanation for 003: …": cr_explain_write.
- Every change needs approval. You never submit the 5300 or change a GL mapping: say a person does that.`,
    plan: (text) => {
      const t = clean(text);
      const lineCode = [...text.matchAll(new RegExp(code.source, 'g'))].map((m) => m[1]!).find((c) => c !== '5300');
      const because = /\b(?:because|since|as|:)\s+(.{5,300})$/i.exec(text)?.[1]?.trim();
      // Settling a difference from the prepared figures, adjusting a line, writing an explanation.
      if (lineCode && /\b(?:di|di’s|di's)(?: figure)? is (?:correct|right)\b/i.test(t)) return { tool: 'cr_resolve', args: { code: lineCode, resolution: 'DI correct', reason: because ?? 'DI’s figure agrees with the source records.' } };
      if (lineCode && /\b(?:prepared|our|cu|credit union’s|credit union's)(?: figure| amount| number)? is (?:correct|right)\b|\badjust di\b/i.test(t)) return { tool: 'cr_resolve', args: { code: lineCode, resolution: 'Prepared correct', reason: because ?? 'The prepared figure agrees with the source records.' } };
      if (lineCode && /\b(?:that’s|that's|it’s|it's|is) explained\b|\bmark (?:it|\w+) (?:as )?explained\b/i.test(t)) return { tool: 'cr_resolve', args: { code: lineCode, resolution: 'Explained', reason: because ?? 'Explained by the preparer.' } };
      const amt = /\bby\s+([+−-]?)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m|million|thousand)?/i.exec(text);
      if (lineCode && amt && /\badjust\b/i.test(t)) {
        const n = Number(amt[2]!.replace(/,/g, '')) * (/^m|million/i.test(amt[3] ?? '') ? 1e6 : /^k|thousand/i.test(amt[3] ?? '') ? 1e3 : 1) * (amt[1] ? -1 : 1);
        const reason = /\btiming|after the build|cleared|locked\b/i.test(t) ? 'Timing' : /\bparticipation/i.test(t) ? 'Participation' : /\bmapping|mapped\b/i.test(t) ? 'Mapping' : /\boff[- ]core\b/i.test(t) ? 'Off-core loans' : /\bcorrect/i.test(t) ? 'Correction' : 'Other';
        return { tool: 'cr_adjust', args: { code: lineCode, amount: n, reason, note: (/\bfor\s+(.{5,300})$/i.exec(text)?.[1] ?? because ?? text).trim().slice(0, 300) } };
      }
      if (/\b(?:manual )?adjustments?\b/i.test(t) && !/\badjust \w/i.test(t)) return { tool: 'cr_adjustments', args: {} };
      const explanation = /\b(?:use|write|add|record|save)\b[^.?!:]*\bexplanation\b[^:]*:\s*(.{10,400})$/i.exec(text);
      if (lineCode && explanation) return { tool: 'cr_explain_write', args: { code: lineCode, explanation: explanation[1]!.trim() } };
      if (/\b(reconcil\w*|compare|check)\b[^.?!]*\b(prepared|our own|our figures|our numbers|cu amount|workbook)\b|\bwhere (?:do|does) (?:we|di|it) differ\b|\bdifferences? (?:from|with|between)\b/i.test(t)) return { tool: 'cr_reconcile', args: {} };
      if (/\b(download|export|excel|csv|xml|spreadsheet|workbook|upload file|send (it )?to cuonline|get it (in)?to cuonline)\b/i.test(t)) return { say: DOWNLOAD };
      if (/\b(can|could|are|will) (you|di)\b|\babilit|\bable to\b|\bdo you\b|\bis it possible\b/i.test(t) && /\b(create|prepare|produce|build|generate|make|fill out|fill in)\b/i.test(t)) return { tool: 'cr_overview', args: {} };
      if (/\b(submit|file it|upload|change|edit|remap|map)\b/i.test(t) && !/\bready\b|\bdue\b/i.test(t)) return { say: READ_ONLY };
      if (/\buncategori[sz]ed\b|\bunmapped\b|\bgl accounts?\b/i.test(t)) return { tool: 'cr_uncategorized', args: {} };
      if (/net worth|capital|\bpca\b|cculr|leverage/i.test(t)) return { tool: 'cr_capital', args: {} };
      if (/\bready\b|\bdue\b|\bblock|\bfiling\b/i.test(t)) return { tool: 'cr_readiness', args: {} };
      const line = code.exec(text)?.[1];
      if (line && line !== '5300') return { tool: 'cr_line_explain', args: { code: line } };
      if (/\bmoved|\bchanged?|\bvariance|\bexplanation|\b\d+(\.\d+)?\s*%/i.test(t)) return { tool: 'cr_variance', args: { min_pct: Number(/(\d+(?:\.\d+)?)\s*%/.exec(t)?.[1] ?? 10), ...(/\bschedule ([A-Z])\b/i.exec(t)?.[1] ? { schedule: /\bschedule ([A-Z])\b/i.exec(t)![1]!.toUpperCase() } : {}) } };
      const s = SCHEDULES.find(([re]) => re.test(t));
      if (s) return { tool: 'cr_schedule', args: { schedule: s[1], ...(s[2] ? { section: s[2] } : {}) } };
      return { tool: 'cr_readiness', args: {} };
    },
    tools: [
      {
        name: 'cr_overview',
        description: 'What DI does with the 5300: it prepares every schedule from the warehouse and GL and runs the NCUA edits; a person files. With the quarter’s state and the schedules it covers.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const [lines, r] = await Promise.all([cr.lines(), cr.readiness()]);
          const schedules = [...new Set(lines.map((l) => l.schedule))];
          const rows = schedules.map((sc) => ({ schedule: sc, items: lines.filter((l) => l.schedule === sc).length }));
          const open = [...r.errors.map((c) => c.detail.replace(/\.$/, '')), ...(r.warnings.length ? [`${r.warnings.length} ${r.warnings.length === 1 ? 'warning needs' : 'warnings need'} an explanation`] : [])];
          const state = open.length ? `it isn’t ready yet: ${open.join('; ')}` : 'every edit passes, so it’s ready to review';
          return {
            text: `Yes. DI prepares the ${r.quarter.label} NCUA Form 5300 from the warehouse and the general ledger: **${lines.length} lines on ${schedules.length} schedules** (${schedules.join(', ')}), with the prior quarter beside each, and runs NCUA’s edits before it goes to CUOnline. Right now ${state}. Filing it stays with you.`,
            blocks: [moduleTable(spec, '5300 schedules', ctx.runId, 'callreport.schedules', [{ field: 'schedule', headerName: 'Schedule', type: 'text' }, { field: 'items', headerName: 'Lines', type: 'count' }], rows)],
            suggestions: ['Are we ready to file the 5300?', 'Show schedule A delinquency', 'How is 025B calculated?'],
          };
        },
      },
      {
        name: 'cr_readiness',
        description: 'Whether the quarter can be filed: the edits that failed (Errors block submission, Warnings need an explanation), the uncategorized GL accounts, the explanations still needed and the due date.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const r = await cr.readiness();
          const q = r.quarter;
          const due = new Date(`${q.dueDate}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
          const gl = r.uncategorized;
          // A failed mapping check names the accounts, so nobody has to go looking for them.
          const glText = gl.length ? ` The uncategorized GL accounts are ${gl.map((g) => `**${g.glNumber}** ${g.name} (${dollars(g.balance)})`).join(', ')}.` : '';
          const errText = r.errors.length ? ` ${r.errors.length} ${r.errors.length === 1 ? 'error blocks' : 'errors block'} submission: ${r.errors.map((c) => `${c.name}: ${c.detail}`).join(' ')}${glText}` : '';
          const warnText = r.warnings.length ? ` ${r.warnings.length} ${r.warnings.length === 1 ? 'warning needs' : 'warnings need'} an explanation: ${r.warnings.map((c) => c.detail).join(' ')}` : '';
          const checks = moduleTable(spec, 'Edits', ctx.runId, 'dq.status_report', [{ field: 'name', headerName: 'Edit', type: 'text' }, { field: 'severity', headerName: 'Type', type: 'text' }, { field: 'result', headerName: 'Result', type: 'text' }, { field: 'detail', headerName: 'Detail', type: 'text' }], r.checks.map((c) => ({ name: c.editCode ? `${c.editCode}: ${c.name}` : c.name, severity: c.severity, result: c.passed ? 'Passed' : 'Failed', detail: c.detail })));
          const accounts = gl.length ? [moduleTable(spec, 'Uncategorized GL accounts', ctx.runId, 'callreport.gl_uncategorized', glCols, glRows(gl))] : [];
          return {
            text: r.ready && !r.warnings.length ? `The ${q.label} 5300 is **ready to review**: every edit passed. It’s due **${due}** in CUOnline, and filing stays with you.` : r.ready ? `The ${q.label} 5300 has no blocking errors.${warnText} It’s due **${due}** in CUOnline.` : `The ${q.label} 5300 **isn’t ready yet**.${errText}${warnText} It’s due **${due}** in CUOnline.`,
            blocks: [checks, ...accounts],
            suggestions: [...(gl.length ? ['Which GL accounts are uncategorized?'] : []), ...(r.warnings.length ? ['Which lines need an explanation?'] : []), 'What’s our net worth ratio?'],
          };
        },
      },
      {
        name: 'cr_reconcile',
        description: 'Check DI’s figures against the credit union’s own prepared 5300: every line that differs, how much, whether it starts there or follows from a line under it, and how each was settled (DI correct, prepared correct, explained).',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const x = await cr.reconcile();
          if (!x) return { text: 'No prepared figures are on file for this quarter, so there’s nothing to check DI’s against yet. Once your own 5300 is loaded, I’ll compare every line.' };
          const roots = x.items.filter((i) => !i.follows);
          const settledText = (i: (typeof x.items)[number]) => (i.resolution ? `${i.resolution}: ${i.resolution.reason}` : i.follows ? 'Follows from a line above' : 'Open');
          const head = `I compared **${x.compared} lines** with ${x.upload.file} (uploaded by ${x.upload.by} on ${x.upload.at}): **${x.matched} match**${x.items.length ? ` and **${x.items.length} differ**` : ''}.`;
          const body = roots.length ? ` The differences start on ${roots.length} ${roots.length === 1 ? 'line' : 'lines'}: ${roots.map((i) => `**${i.code}** ${i.name} (prepared ${dollars(i.prepared)}, DI ${dollars(i.di)}, ${i.difference > 0 ? '+' : '−'}${dollars(Math.abs(i.difference))}${i.resolution ? `, settled as ${i.resolution.resolution}` : ''})`).join('; ')}. The rest follow in the totals above them.` : '';
          const open = x.open.length ? ` **${x.open.length}** still ${x.open.length === 1 ? 'needs' : 'need'} settling: say which figure is right, for example “DI is correct on ${x.open[0]!.code} because…” or “The prepared figure is correct on ${x.open[0]!.code}, adjust DI”.` : x.items.length ? ' Every difference is settled.' : '';
          return {
            text: head + body + open,
            blocks: [moduleTable(spec, 'DI against the prepared 5300', ctx.runId, 'callreport.reconcile', [{ field: 'code', headerName: 'Account', type: 'text' }, { field: 'name', headerName: 'Line', type: 'text' }, { field: 'prepared', headerName: 'Prepared', type: 'currency' }, { field: 'di', headerName: 'DI', type: 'currency' }, { field: 'difference', headerName: 'Difference', type: 'currency' }, { field: 'pct', headerName: '% difference', type: 'text' }, { field: 'status', headerName: 'Settled', type: 'text' }], x.items.map((i) => ({ code: i.code, name: i.name, prepared: i.prepared, di: i.di, difference: i.difference, pct: i.pct === null ? '' : `${i.pct}%`, status: settledText(i) })))],
            suggestions: x.open.length ? [`The prepared figure is correct on ${x.open[0]!.code}, adjust DI`, `DI is correct on ${x.open[0]!.code}`] : ['Show the manual adjustments', 'Are we ready to file the 5300?'],
          };
        },
      },
      {
        name: 'cr_resolve',
        description: 'Settle a difference from the prepared figures on one line: DI correct, Prepared correct (records the adjustment that makes DI match, carried into the totals), or Explained. Needs a reason and approval.',
        input: z.object({ code: z.string().min(3).max(12), resolution: z.enum(CR_RESOLUTIONS), reason: z.string().min(5).max(300) }).strict(),
        run: async (a: { code: string; resolution: CrResolution; reason: string }, ctx) => {
          need(ctx);
          const x = await cr.reconcile();
          const item = x?.items.find((i) => i.code.toLowerCase() === a.code.toLowerCase());
          if (!item) throw new CoreError('INVALID', `${a.code} matches the prepared figures, so there’s nothing to settle.`);
          if (item.follows) throw new CoreError('INVALID', `${item.code} only differs because of a line under it. Settle that line and ${item.code} follows.`);
          const adjust = a.resolution === 'Prepared correct' ? item.difference : 0;
          const preview = adjust ? await cr.previewAdjustment(item.code, adjust) : null;
          return {
            change: {
              summary: `${item.code}: ${a.resolution}${adjust ? `, adjust DI by ${adjust > 0 ? '+' : '−'}${dollars(Math.abs(adjust))}` : ''}`,
              changes: [
                { label: `${item.code} ${item.name}`.slice(0, 80), before: `Prepared ${dollars(item.prepared)}, DI ${dollars(item.di)}`, after: a.resolution },
                { label: 'Reason', before: '—', after: a.reason },
                ...(preview ? preview.touched.map((t) => ({ label: `${t.line.code} ${t.line.name}`.slice(0, 80), before: dollars(t.line.current ?? 0), after: dollars((t.line.current ?? 0) + t.delta) })) : []),
              ],
              text: adjust ? `I’ve prepared settling **${item.code}** as *Prepared correct*. It records a manual adjustment of ${adjust > 0 ? '+' : '−'}${dollars(Math.abs(adjust))} with your reason, carried into ${preview!.touched.length - 1} ${preview!.touched.length === 2 ? 'total' : 'totals'} above it. DI’s own figure stays on file beside it.` : `I’ve prepared settling **${item.code}** as *${a.resolution}*, with your reason. No figure changes.`,
              done: adjust ? `**${item.code}** is settled and DI now matches the prepared figure; the adjustment is on record.` : `**${item.code}** is settled as ${a.resolution}.`,
              risk: adjust ? 'medium' : 'low',
              apply: { code: item.code, resolution: a.resolution, reason: a.reason, adjustment: adjust },
            },
          };
        },
        apply: async (p: { code: string; resolution: CrResolution; reason: string; adjustment: number }, meta, ctx) => cr.resolve(p, { by: ctx.user.name, approvalId: meta.approvalId }),
      },
      {
        name: 'cr_adjust',
        description: 'Record a documented manual adjustment to one input line (amount, reason, note), carried into the totals above it. DI’s own figure is kept beside it. Needs approval.',
        input: z.object({ code: z.string().min(3).max(12), amount: z.number().refine((n) => n !== 0, 'The adjustment can’t be zero'), reason: z.enum(CR_ADJUST_REASONS), note: z.string().min(5).max(300) }).strict(),
        run: async (a: { code: string; amount: number; reason: CrAdjustReason; note: string }, ctx) => {
          need(ctx);
          const p = await cr.previewAdjustment(a.code, a.amount);
          return {
            change: {
              summary: `Adjust ${p.line.code} by ${a.amount > 0 ? '+' : '−'}${dollars(Math.abs(a.amount))} (${a.reason})`,
              changes: [...p.touched.map((t) => ({ label: `${t.line.code} ${t.line.name}`.slice(0, 80), before: dollars(t.line.current ?? 0), after: dollars((t.line.current ?? 0) + t.delta) })), { label: 'Reason', before: '—', after: `${a.reason}: ${a.note}` }],
              text: `I’ve prepared a manual adjustment to **${p.line.code}** ${p.line.name}: ${a.amount > 0 ? '+' : '−'}${dollars(Math.abs(a.amount))}, carried into ${p.touched.length - 1} ${p.touched.length === 2 ? 'total' : 'totals'} above it. It’s kept as its own record with your reason; DI’s computed figure isn’t changed.`,
              done: `The adjustment to **${p.line.code}** is recorded and the totals above it follow.`,
              risk: 'medium',
              apply: { code: p.line.code, amount: a.amount, reason: a.reason, note: a.note },
            },
          };
        },
        apply: async (p: { code: string; amount: number; reason: CrAdjustReason; note: string }, meta, ctx) => {
          await cr.adjust(p, { by: ctx.user.name, approvalId: meta.approvalId });
        },
      },
      {
        name: 'cr_adjustments',
        description: 'The manual adjustments recorded this quarter: line, amount, reason, note, who and when.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const adj = await cr.adjustments();
          if (!adj.length) return { text: 'No manual adjustments are recorded this quarter: every figure is DI’s own.' };
          return {
            text: `**${adj.length} manual ${adj.length === 1 ? 'adjustment' : 'adjustments'}** this quarter, net ${dollars(adj.reduce((n, a) => n + a.amount, 0))}. Each is kept beside DI’s own figure and goes into the workpapers.`,
            blocks: [moduleTable(spec, 'Manual adjustments', ctx.runId, 'callreport.adjustments', [{ field: 'code', headerName: 'Account', type: 'text' }, { field: 'name', headerName: 'Line', type: 'text' }, { field: 'amount', headerName: 'Amount', type: 'currency' }, { field: 'reason', headerName: 'Reason', type: 'text' }, { field: 'note', headerName: 'Note', type: 'text' }, { field: 'by', headerName: 'By', type: 'text' }, { field: 'at', headerName: 'When', type: 'text' }], adj.map((a) => ({ code: a.code, name: a.name, amount: a.amount, reason: a.reason, note: a.note, by: a.by, at: a.at })))],
          };
        },
      },
      {
        name: 'cr_explain_write',
        description: 'Write the explanation NCUA asks for on a line that moved, in the person’s words or from a draft they accepted. Needs approval.',
        input: z.object({ code: z.string().min(3).max(12), explanation: z.string().min(10).max(400) }).strict(),
        run: async (a: { code: string; explanation: string }, ctx) => {
          need(ctx);
          const l = await cr.line(a.code.toUpperCase());
          const was = (await cr.explanations()).find((e) => e.code === l.code);
          return {
            change: {
              summary: `Explanation for ${l.code}`,
              changes: [{ label: `${l.code} ${l.name}`.slice(0, 80), before: was?.explanation ?? (was ? 'Needed' : '—'), after: a.explanation }],
              text: `I’ve prepared the explanation for **${l.code}** ${l.name}. It goes into the comments filed with the 5300.`,
              done: `The explanation for **${l.code}** is written.`,
              risk: 'low',
              apply: { code: l.code, explanation: a.explanation },
            },
          };
        },
        apply: async (p: { code: string; explanation: string }, _meta, ctx) => cr.explain(p.code, p.explanation, ctx.user.name),
      },
      {
        name: 'cr_uncategorized',
        description: 'The GL accounts with no 5300 line yet: balance, last posting, the line they most likely belong on, and why they are open.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const gl = await cr.uncategorized();
          if (!gl.length) return { text: 'Every GL account is mapped to a 5300 line.' };
          const total = gl.reduce((n, g) => n + g.balance, 0);
          return {
            text: `**${gl.length} GL ${gl.length === 1 ? 'account has' : 'accounts have'}** no 5300 line yet, totalling **${dollars(total)}**. The largest is **${gl[0]!.glNumber}** ${gl[0]!.name} at ${dollars(gl[0]!.balance)}. Mapping them is a person’s change in the 5300 workspace; DI only reads them.`,
            blocks: [moduleTable(spec, 'Uncategorized GL accounts', ctx.runId, 'callreport.gl_uncategorized', glCols, glRows(gl))],
          };
        },
      },
      {
        name: 'cr_line_explain',
        description: 'One 5300 line by its NCUA account code: this quarter against last, and what makes it up (its GL accounts, or for a total the lines its formula adds).',
        input: z.object({ code: z.string().min(3).max(8) }).strict(),
        run: async (a: { code: string }, ctx) => {
          need(ctx);
          const q = await cr.quarters();
          const l = await cr.line(a.code.toUpperCase());
          const value = l.text ?? (l.code === '998' ? `${l.current}%` : money(l.current));
          const how = l.gl.length ? ` It comes from the general ledger: ${l.gl.map((g) => `GL ${g.glNumber} ${g.name}`).join(', ')}.` : l.parts.length ? ` It adds ${l.parts.length} ${l.parts.length === 1 ? 'line' : 'lines'}${l.formula ? ` (${l.formula})` : ''}.` : ` It comes from the ${l.source.toLowerCase()}.`;
          const top = [...l.parts].filter((p) => p.change !== null).sort((x, y) => Math.abs(y.change!) - Math.abs(x.change!))[0];
          const block = l.gl.length
            ? moduleTable(spec, `GL accounts in ${l.code}`, ctx.runId, 'callreport.line.explain', [{ field: 'gl', headerName: 'GL account', type: 'text' }, { field: 'name', headerName: 'Name', type: 'text' }, { field: 'prior', headerName: q.priorLabel ?? 'Prior', type: 'currency' }, { field: 'current', headerName: q.label, type: 'currency' }], l.gl.map((g) => ({ gl: g.glNumber, name: g.name, prior: g.prior, current: g.current })))
            : l.parts.length
              ? moduleTable(spec, `How ${l.code} is built`, ctx.runId, 'callreport.line.explain', lineCols(q.priorLabel ?? 'Prior', q.label), lineRows(l.parts))
              : null;
          return {
            text: `Line **${l.code}**, ${l.name}, is **${value}** at ${q.label}${l.change !== null && l.code !== '998' ? `, ${change(l)} from ${q.priorLabel}` : ''}.${how}${top && top.change ? ` **${top.code}** ${top.name} moved most, ${change(top)}.` : ''}`,
            ...(block ? { blocks: [block] } : {}),
          };
        },
      },
      {
        name: 'cr_variance',
        description: 'Lines that moved by at least a percentage (and $100,000) since last quarter, largest first, with whether each has the explanation NCUA asks for. Excludes the year-to-date income statement unless schedule SIE is asked for.',
        input: z.object({ min_pct: z.number().min(0).max(1000).default(10), schedule: z.string().max(4).optional() }).strict(),
        run: async (a: { min_pct: number; schedule?: string }, ctx) => {
          need(ctx);
          const q = await cr.quarters();
          const v = await cr.variance(a.min_pct, a.schedule);
          if (!v.length) return { text: `No lines moved ${a.min_pct}% or more from ${q.priorLabel}${a.schedule ? ` in schedule ${a.schedule.toUpperCase()}` : ''}.` };
          const needed = v.filter((l) => l.explanation?.status === 'Needed');
          return {
            text: `**${v.length} ${v.length === 1 ? 'line' : 'lines'}** moved ${a.min_pct}% or more from ${q.priorLabel}${a.schedule ? ` in schedule ${a.schedule.toUpperCase()}` : ''}. The largest is **${v[0]!.code}**, ${v[0]!.name}, ${change(v[0]!)}.${needed.length ? ` ${needed.length} still ${needed.length === 1 ? 'needs' : 'need'} an explanation before filing: ${needed.map((l) => `**${l.code}**`).join(', ')}.` : ''}`,
            blocks: [moduleTable(spec, `Changes from ${q.priorLabel}`, ctx.runId, 'callreport.variance', [...lineCols(q.priorLabel ?? 'Prior', q.label), { field: 'explanation', headerName: 'Explanation', type: 'text' }], v.map((l) => ({ ...lineRows([l])[0]!, explanation: l.explanation ? (l.explanation.explanation ?? 'Needed') : '' })))],
            suggestions: [`How is ${v[0]!.code} calculated?`],
          };
        },
      },
      {
        name: 'cr_schedule',
        description: 'The lines of one schedule (SFC balance sheet, SIE income statement, A loans, B investments, D shares and members, G net worth), optionally one section by a word of its name, this quarter against last.',
        input: z.object({ schedule: z.string().min(1).max(4), section: z.string().max(80).optional() }).strict(),
        run: async (a: { schedule: string; section?: string }, ctx) => {
          need(ctx);
          const q = await cr.quarters();
          const all = (await cr.schedule(a.schedule)).filter((l) => !a.section || l.section.toLowerCase().includes(a.section.toLowerCase()));
          // Zero lines are filed but not worth reading; totals always show.
          const shown = all.filter((l) => l.kind === 'total' || (l.current ?? 0) !== 0 || l.text);
          if (!shown.length) return { text: `There’s no schedule ${a.schedule} on this 5300.` };
          const head = shown.find((l) => l.kind === 'total') ?? shown[0]!;
          return {
            text: `${shown[0]!.scheduleName}${a.section ? `, ${shown[0]!.section}` : ''}: **${shown.length} lines** with a balance at ${q.label}${all.length > shown.length ? `, of ${all.length} on the form` : ''}. **${head.code}** ${head.name} is ${head.text ?? money(head.current)}${head.change !== null ? `, ${change(head)}` : ''}.`,
            blocks: [moduleTable(spec, `${shown[0]!.scheduleName}${a.section ? ` · ${shown[0]!.section.replace(/^Section \d+ - /, '')}` : ''}`, ctx.runId, 'callreport.schedule', lineCols(q.priorLabel ?? 'Prior', q.label), lineRows(shown).map((r, i) => (shown[i]!.text ? { ...r, change: shown[i]!.text! } : r)))],
          };
        },
      },
      {
        name: 'cr_capital',
        description: 'Net worth (997), total assets for the ratio (NW0010), the net worth ratio (998) and its PCA classification (700), and whether the credit union is complex and on the CCULR.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const q = await cr.quarters();
          const c = await cr.capital();
          const moved = c.priorRatio !== null ? Math.round((c.ratio - c.priorRatio) * 100) : null;
          return {
            text: `The net worth ratio is **${c.ratio.toFixed(2)}%** at ${q.label}${moved !== null ? `, ${moved >= 0 ? 'up' : 'down'} ${Math.abs(moved)} bp from ${q.priorLabel}` : ''}: net worth of ${dollars(c.netWorth)} on total assets of ${dollars(c.assets)}. That is **${c.classification}** (7% or more under 12 CFR 702.102).${c.complex ? ` With assets over $500 million the credit union is complex, and ${c.cculr ? `it has elected the CCULR, which needs a net worth ratio of 9% or more, so ${c.ratio >= 9 ? 'it qualifies' : 'it falls short'}` : 'it files the risk-based capital ratio'}.` : ''}`,
          };
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

export function campaignModule(cmp: CampaignService, api: ApiService | null = null): ModuleSpec {
  const noAccess = 'Campaigns aren’t part of your DI access.';
  const need = (ctx: ModuleContext) => guard(ctx, 'campaigns', noAccess);
  const spec: ModuleSpec = {
    id: 'campaigns',
    prefix: 'cmp',
    agent: 'Campaigns',
    request: /\bcampaigns?\b|\baudiences?\b|\bmarketing (roi|return|spend|sources?)\b|\bsales by (?:marketing )?source\b|\b(?:roi|return on spend) (?:history|by quarter|over time)\b|\bcampaign lift\b|\b(?:send|push)\b[^.?!]*\bto (?:the )?(?:relay|marketing platform)\b|\bopen and click\b|\bclick rates?\b|\bhow did the email\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Campaign Success', ref: 'table:cmp_campaign' }],
    prompt: ({ tenant, user, title }) => `You are the Campaign agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) reviews campaigns and builds audiences.

- "Which campaigns produced the most loan dollars?": cmp_results.
- "Which campaigns paid for themselves?", "what was the lift?", "campaign ROI": cmp_roi. Lift is against each campaign's held-back control group.
- "Build an audience of members with no auto loan": cmp_audience_prepare. Suppression is applied by the platform and its counts are shown.
- "Send the audience of members with no auto loan to Relay", "push it to the marketing platform": cmp_audience_send. It is high risk: contact details leave DI.
- "Pull back the campaign results": cmp_platform_pull. "How did the email do?", "open and click rates": cmp_platform_results.
- "How has campaign ROI changed?", "ROI by quarter": cmp_roi_history. "What did campaigns bring in by product and channel?": cmp_product_channel. "Sales by marketing source", "what came from campaigns this month?": cmp_sources. "Campaign timeline", "when did responses come in?": cmp_timeline.
- Exporting an audience as a file isn't available; sending goes through the connected marketing platform.`,
    plan: (text) => {
      const t = clean(text);
      const no = /\bno ([\w ]+?) loan\b|\bwithout an? ([\w ]+?) loan\b/i.exec(t);
      if (/\b(?:send|push|upload|sync)\b/i.test(t) && /\b(?:audience|list|relay|marketing platform)\b/i.test(t)) return no ? { tool: 'cmp_audience_send', args: { without_category: (no[1] ?? no[2])! } } : { say: 'Which audience should I send? For example, “Send members with no auto loan to Relay.”' };
      if (/\bexport\b/i.test(t)) return { say: 'DI can’t export an audience as a file: member contact details would leave DI with no record of where they went. It can send an audience to the connected marketing platform, with an approval that shows who and which fields.' };
      if (/\bpull\b[^.?!]*\bresults?\b|\bpull (?:them |it )?back\b|\brefresh\b[^.?!]*\bresults?\b/i.test(t)) return { tool: 'cmp_platform_pull', args: {} };
      if (/\bopen(?:ed|s| rate)?\b|\bclick|\bdeliver|\bunsubscrib|\bplatform results\b|\bon relay\b|\bhow did\b[^.?!]*\b(?:email|send)\b/i.test(t)) return { tool: 'cmp_platform_results', args: {} };
      if (/\baudience\b/i.test(t)) return no ? { tool: 'cmp_audience_prepare', args: { without_category: (no[1] ?? no[2])! } } : { say: 'Which loan should the audience not already have?' };
      if (/\btimeline\b|\bwhen did (?:the )?responses\b|\bweek by week\b/i.test(t)) return { tool: 'cmp_timeline', args: {} };
      if (/\b(?:sales|accounts?|openings?) by (?:marketing )?source\b|\bmarketing sources?\b|\bcame from (?:a )?campaigns?\b|\bdaily\b/i.test(t)) return { tool: 'cmp_sources', args: {} };
      if (/\bby product\b[^.?!]*\bchannel\b|\bby channel\b[^.?!]*\bproduct\b|\bproduct and channel\b|\bbrought in\b/i.test(t)) return { tool: 'cmp_product_channel', args: {} };
      if (/\b(?:roi|return)\b[^.?!]*\b(?:history|by quarter|quarter by quarter|over time|trend|changed)\b|\bby quarter\b/i.test(t)) return { tool: 'cmp_roi_history', args: {} };
      if (/\blift\b|\broi\b|\breturn\b|\bincremental\b|\bpa(id|y) (for|off)\b|\bworth it\b|\bprofitab|\bcost per\b|\bspend\b|\bcontrol group\b/i.test(t)) return { tool: 'cmp_roi', args: {} };
      return { tool: 'cmp_results', args: {} };
    },
    tools: [
      {
        name: 'cmp_roi_history',
        description: 'Return on spend by quarter launched and channel: campaigns, spend, value caused and return, oldest quarter first.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const h = await cmp.history();
          const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n)}%`);
          const best = [...h.byChannel].filter((c) => c.roiPct !== null).sort((a, b) => b.roiPct! - a.roiPct!)[0];
          const last = h.quarters.at(-1)!;
          return {
            text: `Over ${h.quarters.length} quarters, from ${h.quarters[0]!.quarter} to ${last.quarter}: **${best?.channel}** returned the most on its spend, ${pct(best?.roiPct ?? null)}. ${last.quarter} returned ${pct(last.total.roiPct)} on ${dollars(last.total.cost)} of spend.`,
            blocks: [
              moduleTable(spec, 'Return on spend by quarter and channel', ctx.runId, 'campaign.roi.history', [{ field: 'quarter', headerName: 'Quarter launched', type: 'text' }, ...h.channels.map((ch, i) => ({ field: `c${i}`, headerName: ch, type: 'text' as const })), { field: 'cost', headerName: 'Spend', type: 'currency' }, { field: 'value', headerName: 'Value caused', type: 'currency' }, { field: 'roi', headerName: 'Return', type: 'text' }], h.quarters.map((q) => ({ quarter: q.quarter, ...Object.fromEntries(h.channels.map((ch, i) => [`c${i}`, q.byChannel[ch]!.campaigns ? pct(q.byChannel[ch]!.roiPct) : ''])), cost: q.total.cost, value: q.total.value, roi: pct(q.total.roiPct) }))),
              moduleTable(spec, 'By channel, all quarters', ctx.runId, 'campaign.roi.history', [{ field: 'channel', headerName: 'Channel', type: 'text' }, { field: 'campaigns', headerName: 'Campaigns', type: 'count' }, { field: 'cost', headerName: 'Spend', type: 'currency' }, { field: 'value', headerName: 'Value caused', type: 'currency' }, { field: 'roi', headerName: 'Return', type: 'text' }], h.byChannel.map((c) => ({ channel: c.channel, campaigns: c.campaigns, cost: c.cost, value: c.value, roi: pct(c.roiPct) }))),
            ],
          };
        },
      },
      {
        name: 'cmp_product_channel',
        description: 'What campaigns brought in, from the accounts credited to them: by product and channel, accounts, dollars and lifetime value.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const rows = await cmp.productByChannel();
          const top = rows[0]!;
          return {
            text: `Campaigns are credited with **${rows.reduce((s, r) => s + r.accounts, 0).toLocaleString('en-US')} accounts** (opened within 60 days of a campaign for that product), worth about ${dollars(rows.reduce((s, r) => s + r.value, 0))} over their life. The most valuable mix is ${top.product} by ${top.channel.toLowerCase()}, ${dollars(top.value)}.`,
            blocks: [moduleTable(spec, 'Brought in by product and channel', ctx.runId, 'campaign.product_channel', [{ field: 'product', headerName: 'Product', type: 'text' }, { field: 'channel', headerName: 'Channel', type: 'text' }, { field: 'accounts', headerName: 'Accounts', type: 'count' }, { field: 'dollars', headerName: 'Dollars', type: 'currency' }, { field: 'value', headerName: 'Lifetime value', type: 'currency' }], rows)],
          };
        },
      },
      {
        name: 'cmp_sources',
        description: 'Accounts opened each day for the last 30 days by marketing source: each campaign channel, or no campaign.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const s = await cmp.sources(30);
          const total = s.days.reduce((n, d) => n + d.total, 0);
          const none = s.days.reduce((n, d) => n + d.none, 0);
          const byCh = s.channels.map((ch) => ({ ch, n: s.days.reduce((n, d) => n + (d.byChannel[ch] ?? 0), 0) })).sort((a, b) => b.n - a.n);
          return {
            text: `From ${s.from} to ${s.to}, **${total.toLocaleString('en-US')} accounts** were opened: ${(total - none).toLocaleString('en-US')} credited to campaigns (${byCh.filter((c) => c.n).map((c) => `${c.ch.toLowerCase()} ${c.n}`).join(', ') || 'none'}) and ${none.toLocaleString('en-US')} with no campaign.`,
            blocks: [moduleTable(spec, 'Sales by marketing source, each day', ctx.runId, 'campaign.sources', [{ field: 'day', headerName: 'Day', type: 'text' }, ...s.channels.map((ch, i) => ({ field: `c${i}`, headerName: ch, type: 'count' as const })), { field: 'none', headerName: 'No campaign', type: 'count' }, { field: 'total', headerName: 'Total', type: 'count' }], s.days.map((d) => ({ day: d.day, ...Object.fromEntries(s.channels.map((ch, i) => [`c${i}`, d.byChannel[ch] ?? 0])), none: d.none, total: d.total })))],
          };
        },
      },
      {
        name: 'cmp_timeline',
        description: 'Each campaign’s window, from launch to 60 days after, and the accounts credited to it week by week.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const t = await cmp.timeline();
          const recent = t.slice(-8);
          return {
            text: `The last ${recent.length} campaigns’ windows and when responses came in. Most responses land in the first two to three weeks; ${recent.at(-1)!.name} peaked in week ${recent.at(-1)!.peakWeek}.`,
            blocks: [moduleTable(spec, 'Campaign timeline', ctx.runId, 'campaign.timeline', [{ field: 'name', headerName: 'Campaign', type: 'text' }, { field: 'channel', headerName: 'Channel', type: 'text' }, { field: 'launched', headerName: 'Launched', type: 'text' }, { field: 'ends', headerName: 'Window ends', type: 'text' }, ...Array.from({ length: 9 }, (_, w) => ({ field: `w${w}`, headerName: `Week ${w + 1}`, type: 'count' as const })), { field: 'accounts', headerName: 'Accounts', type: 'count' }], recent.map((c) => ({ name: c.name, channel: c.channel, launched: c.launched, ends: c.ends, ...Object.fromEntries(c.weeks.map((n, w) => [`w${w}`, n])), accounts: c.accounts })))],
          };
        },
      },
      {
        name: 'cmp_roi',
        description: 'Each campaign’s lift over its held-back control group, the incremental responses and dollars it caused, its cost, and the return on that cost from the lifetime contribution of what it caused.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const r = (await cmp.results()).filter((c) => c.roiPct !== null).sort((a, b) => (b.roiPct ?? 0) - (a.roiPct ?? 0));
          if (!r.length) return { text: 'No campaign has a control group, so DI can’t measure lift yet.' };
          const best = r[0]!;
          const losers = r.filter((c) => (c.roiPct ?? 0) < 0);
          const spend = r.reduce((s, c) => s + c.cost, 0);
          const value = r.reduce((s, c) => s + (c.value ?? 0), 0);
          const pct = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '' : '−'}${Math.abs(Math.round(n)).toLocaleString('en-US')}%`);
          return {
            text: `Across ${r.length} campaigns, **${money(spend)}** of spend caused about **${money(value)}** of lifetime contribution, measured against each campaign’s held-back control group. **${best.name}** returned the most, ${pct(best.roiPct)} on ${money(best.cost)}: a lift of ${best.liftPts!.toFixed(2)} points (${best.responseRatePct.toFixed(2)}% responded against ${best.controlRatePct!.toFixed(2)}% of the control), so about ${best.incremental} of its ${best.applications} responses wouldn’t have happened without it.${losers.length ? ` ${losers.length > 1 ? `${losers.slice(0, -1).map((c) => c.name).join(', ')} and ${losers.at(-1)!.name}` : losers[0]!.name} didn’t pay for ${losers.length === 1 ? 'itself' : 'themselves'}${losers.some((c) => /certificate/i.test(c.product)) ? '; certificates bought at a special rate cost more than their funding is worth' : ''}.` : ''} Value uses each product’s contribution per dollar from Profitability; the control group is 10% of each audience.`,
            blocks: [
              moduleTable(spec, 'Campaign lift and return', ctx.runId, 'campaign.roi', [{ field: 'name', headerName: 'Campaign', type: 'text' }, { field: 'channel', headerName: 'Channel', type: 'text' }, { field: 'rate', headerName: 'Responded', type: 'text' }, { field: 'control', headerName: 'Control', type: 'text' }, { field: 'lift', headerName: 'Lift (pts)', type: 'text' }, { field: 'incremental', headerName: 'Caused', type: 'count' }, { field: 'cost', headerName: 'Cost', type: 'currency' }, { field: 'value', headerName: 'Value caused', type: 'currency' }, { field: 'roi', headerName: 'Return', type: 'text' }], r.map((c) => ({ name: c.name, channel: c.channel, rate: `${c.responseRatePct.toFixed(2)}%`, control: `${c.controlRatePct!.toFixed(2)}%`, lift: c.liftPts!.toFixed(2), incremental: c.incremental ?? 0, cost: Math.round(c.cost), value: Math.round(c.value ?? 0), roi: pct(c.roiPct) }))),
            ],
            suggestions: ['Which campaigns produced the most loan dollars?', 'Build an audience of members with no auto loan'],
          };
        },
      },
      {
        name: 'cmp_results',
        description: 'Campaigns by loan dollars, with channel, applications and sends.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const r = await cmp.results();
          const [top] = r;
          return { text: top ? `**${top.name}** produced the most loan dollars: **${money(top.dollars)}** from ${top.applications} applications by ${top.channel.toLowerCase()}. Attribution uses each campaign’s response window.` : 'No campaigns have run.', blocks: [moduleTable(spec, 'Campaign results', ctx.runId, 'campaign.results', [{ field: 'name', headerName: 'Campaign', type: 'text' }, { field: 'channel', headerName: 'Channel', type: 'text' }, { field: 'product', headerName: 'Product', type: 'text' }, { field: 'sent', headerName: 'Sent', type: 'count' }, { field: 'applications', headerName: 'Applications', type: 'count' }, { field: 'dollars', headerName: 'Loan dollars', type: 'currency' }], r.map((c) => ({ name: c.name, channel: c.channel, product: c.product, sent: c.sent, applications: c.applications, dollars: c.dollars })))] };
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
      {
        name: 'cmp_audience_send',
        description: 'Prepare sending an audience of members without a loan type to the connected marketing platform and starting its email campaign. Members go as a reference, first name and email. Returns approval_required (high risk).',
        input: z.object({ without_category: z.string().min(2).max(40), campaign_name: z.string().min(2).max(60).optional() }).strict(),
        run: async (a: { without_category: string; campaign_name?: string }, ctx) => {
          need(ctx);
          const c = api ? await api.marketing() : null;
          if (!c) throw new CoreError('NOT_FOUND', 'No marketing platform is connected that can take a list. An Integrations administrator connects one under Vendor API on Integrations; then I can send audiences to it.');
          const x = await cmp.audienceMembers(a.without_category, ctx);
          if (!x.members.length) throw new CoreError('INVALID', `No member without a ${x.category} loan can be emailed, after suppression.`);
          const audience = `Members without ${x.category}`;
          const campaign = (a.campaign_name ?? `${x.category} offer, ${new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`).trim();
          const count = (v: number) => v.toLocaleString('en-US');
          return {
            change: {
              summary: `Send ${count(x.members.length)} members to ${c.name} and start “${campaign}”`,
              changes: [
                { label: 'Audience', before: '—', after: `${audience}: ${count(x.found)} matched` },
                { label: 'Removed first', before: '—', after: `${count(x.suppressed)} opted out or contacted recently; ${count(x.noEmail)} with no email on file` },
                { label: 'Sent', before: '—', after: `${count(x.members.length)} members` },
                { label: 'Fields', before: '—', after: 'A reference DI can match back, first name, email. No member number, balance or account detail.' },
                { label: 'To', before: '—', after: `${c.name}, ${c.baseUrl}` },
                { label: 'Campaign', before: '—', after: `${campaign}, email, sent by the platform` },
              ],
              text: `I’ll send **${count(x.members.length)} members** to **${c.name}** and start the email campaign “${campaign}”. Their contact details leave DI, so this is high risk. They go as a reference only DI can match back, first name and email; nothing else. DI pulls the results back each night, and matches who clicked to members inside DI.`,
              done: `Sent the audience to ${c.name}.`,
              risk: 'high',
              records: x.members.length,
              external: x.members.length,
              apply: { connectionId: c.connectionId, category: x.category, audienceName: audience, campaignName: campaign, expected: x.members.length },
            },
          };
        },
        apply: async (p: { connectionId: number; category: string; audienceName: string; campaignName: string; expected: number }, meta, ctx) => {
          if (!api) throw new CoreError('INVALID', 'API connections aren’t set up in this environment.');
          const x = await cmp.audienceMembers(p.category, ctx);
          // What's sent is exactly what was approved: if the audience changed, nothing goes.
          if (x.members.length !== p.expected) throw new CoreError('INVALID', `The audience changed since you approved it (${p.expected.toLocaleString('en-US')} then, ${x.members.length.toLocaleString('en-US')} now), so nothing was sent. Ask again to see the new count.`);
          const r = await api.pushAudience({ connectionId: p.connectionId, audienceName: p.audienceName, category: p.category, campaignName: p.campaignName, members: x.members }, { userId: ctx.user.id, name: ctx.user.name }, { approvalId: meta.approvalId, runId: ctx.runId });
          return { text: `Sent **${r.accepted.toLocaleString('en-US')} members** to ${r.connection}${r.rejected ? ` (${r.rejected.toLocaleString('en-US')} refused for a malformed email)` : ''}, and it started “${p.campaignName}”. Results come back with tonight’s pull, or ask me to pull them now.`, suggestions: ['Pull back the campaign results', 'How did the email do?'] };
        },
      },
      {
        name: 'cmp_platform_pull',
        description: 'Prepare pulling campaign results back from the connected marketing platform now, from where the last pull stopped. Returns approval_required.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const c = api ? (await api.connections()).find((x) => x.status === 'Active' && x.requests.some((q) => q.purpose === 'pull')) : null;
          if (!c) throw new CoreError('NOT_FOUND', 'No marketing platform is connected, so there are no platform results to pull. An Integrations administrator connects one on Integrations.');
          const q = c.requests.find((r) => r.purpose === 'pull')!;
          return { change: { summary: `Pull campaign results from ${c.name} now`, changes: [{ label: q.name, before: q.lastRunAt ? `Last pulled ${stampUtc(q.lastRunAt)}` : 'Never pulled', after: 'What changed since then' }], text: `I’ll pull campaign results from **${c.name}** now, from where the last pull stopped.`, done: `Pulled from ${c.name}.`, risk: 'low', apply: { connectionId: c.connectionId } } };
        },
        apply: async (p: { connectionId: number }, _meta, ctx) => {
          const r = await api!.pull(p.connectionId, ctx.runId);
          const x = r.results[0];
          const view = await platformView(ctx);
          return { ...view, text: `Pulled from **${r.connection}**: ${x?.rows ?? 0} ${x?.rows === 1 ? 'campaign' : 'campaigns'} ${x?.since ? 'changed since the last pull' : 'in all'}. ${view.text}` };
        },
      },
      {
        name: 'cmp_platform_results',
        description: 'Campaign results pulled from the marketing platform: sent, delivered, opened, clicked and unsubscribed, and for DI’s own sends, how many who clicked DI matched to members.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          return platformView(ctx);
        },
      },
    ],
  };
  const platformView = async (ctx: ModuleContext) => {
    const r = api ? await api.platformResults() : { metrics: [], pushes: [] };
    if (!r.metrics.length) return { text: api && (await api.connections()).length ? 'Nothing has been pulled from the marketing platform yet. Ask me to pull back the campaign results.' : 'No marketing platform is connected, so there are no platform results. Campaign results here come from DI’s own loan and deposit data.', suggestions: [] as string[] };
    const pct = (v: number) => `${v.toFixed(1)}%`;
    const latest = r.metrics[0]!;
    const own = r.metrics.find((m) => m.pushId !== null);
    const matched = own ? (await api!.clickers(own.pushId!)).length : 0;
    const pulled = r.metrics.map((m) => m.pulledAt).sort().at(-1)!;
    const avgOpen = r.metrics.reduce((s, m) => s + m.openPct, 0) / r.metrics.length;
    return {
      text: `${r.metrics.length} campaigns came back from **${latest.connection}**, pulled ${stampUtc(pulled)}. They opened at ${pct(avgOpen)} on average.${own ? ` DI’s own send, **${own.name}**, reached ${own.delivered.toLocaleString('en-US')} of ${own.sent.toLocaleString('en-US')}: ${pct(own.openPct)} opened and ${pct(own.clickPct)} clicked. DI matched ${matched.toLocaleString('en-US')} ${matched === 1 ? 'click' : 'clicks'} to members; applications from them are counted from DI’s own loan data as they arrive.` : ''}`,
      blocks: [moduleTable(spec, `Results from ${latest.connection}`, ctx.runId, 'campaign.platform.results', [{ field: 'name', headerName: 'Campaign', type: 'text' }, { field: 'sentAt', headerName: 'Sent on', type: 'text' }, { field: 'sent', headerName: 'Sent', type: 'count' }, { field: 'delivered', headerName: 'Delivered', type: 'count' }, { field: 'open', headerName: 'Opened', type: 'text' }, { field: 'click', headerName: 'Clicked', type: 'text' }, { field: 'unsubscribed', headerName: 'Unsubscribed', type: 'count' }, { field: 'source', headerName: 'Sent from', type: 'text' }], r.metrics.map((m) => ({ name: m.name, sentAt: m.sentAt ? new Date(`${m.sentAt}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('Sept', 'Sep') : '—', sent: m.sent, delivered: m.delivered, open: pct(m.openPct), click: pct(m.clickPct), unsubscribed: m.unsubscribed, source: m.pushId !== null ? 'DI audience' : m.campaignId !== null ? 'DI campaign' : 'The platform' })))],
      suggestions: ['Which campaigns paid for themselves?', 'Pull back the campaign results'],
    };
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

