// Branch Performance: what a branch manager runs the branch on, by asking. The CEO's six measures against
// their targets, delinquency at 30, 60 and 90 days, digital adoption, results per person, the complaint
// log, daily balancing and the vault, lobby waits, BSA and fraud, audit exceptions and surprise counts, and
// people (turnover, engagement, training), each for the branches in the viewer's purview beside the
// network. Code computes every figure; the model only picks the tool.
import { z } from 'zod';
import { BRANCH_TARGETS, CoreError, LOBBY_WAIT_TARGET, NETWORK, REG_E_DAYS, REQUIRED_TRAINING, type BranchKpiService, type BranchMeasure, type TargetStatus } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const TARGETS_ASK = /\bceo(?:'|’)?s?\b[^.?!]*\b(?:targets?|metrics|measures|goals|numbers)\b|\bbranch (?:targets?|kpis?)\b|\b(?:against|vs\.?|versus|hitting|meeting|hit|meet|miss(?:ing)?) (?:the |our |its |my |their )?(?:ceo(?:'|’)?s? |six |branch )*targets?\b|\bnps\b|\bnet promoter\b/;
const DQ_ASK = /\b(?:delinquen\w*|past due)\b[^.?!]*\b30\b[^.?!]*\b60\b[^.?!]*\b90\b|\b30\b[^.?!]*\b60\b[^.?!]*\b90\b[^.?!]*\b(?:delinquen\w*|past due)/;
const DIGITAL_ASK = /\bdigital adoption\b|\be-?statement (?:adoption|enrollment|rate|use)s?\b|\bdebit cards? (?:adoption|activation)\b|\bactive debit cards\b|\bmobile (?:banking )?adoption\b/;
const PRODUCTIVITY_ASK = /\bstaff productivity\b|\bproductivity\b[^.?!]*\b(?:branch|staff|team|fte)\b|\b(?:per|each) (?:fte|full[- ]time (?:employee|person)|staff member|employee)\b/;
const COMPLAINT_ASK = /\bcomplaint log\b|\bcomplaints?\b[^.?!]*\b(?:by branch|for (?:my|our|the|this) branch(?:es)?|at (?:my|our|the|this) branch(?:es)?)\b|\bbranch complaints\b/;
const BALANCING_ASK = /\bbalancing\b|\b(?:drawers?|tellers?)\b[^.?!]*\bbalanc\w*|\bout of balance\b|\bover(?: and |\/| or )short\b|\bcash vault\b|\bvault (?:report|cash|limits?)\b|\btransactions? (?:per|an|a) (?:teller )?hour\b/;
const LOBBY_ASK = /\blobby\b|\bwait times?\b|\bfoot traffic\b|\bhow long (?:do )?(?:members|customers|people) wait\b/;
const RISK_ASK = /\bctrs?\b|\bcurrency transaction reports?\b|\bstructuring\b|\bskimm\w*\b|\bcheck fraud\b|\belder (?:financial )?(?:abuse|exploitation)\b|\breg(?:ulation)? e\b|\bfraud (?:loss(?:es)?|cases?)\b|\bfraud\b[^.?!]*\bbranch(?:es)?\b|\bbsa\b|\baml\b|\bsars?\b/;
const AUDIT_ASK = /\baudit (?:exceptions?|findings?)\b|\bsurprise (?:cash )?counts?\b|\bcash counts?\b|\bdual control\b/;
const PEOPLE_ASK = /\b(?:staff|employee|team) (?:turnover|engagement)\b|\bturnover\b[^.?!]*\b(?:staff|branch|team|people)\b|\bengagement (?:scores?|surveys?)\b|\btraining\b[^.?!]*\b(?:complet\w*|finish\w*|overdue|status|done|behind)\b|\b(?:complet\w*|finish\w*|overdue|done)\b[^.?!]*\btraining\b|\b(?:bsa|aml|fair lending|security|required) training\b/;
export const BRANCH_KPI_REQUEST = new RegExp([TARGETS_ASK, DQ_ASK, DIGITAL_ASK, PRODUCTIVITY_ASK, COMPLAINT_ASK, BALANCING_ASK, LOBBY_ASK, RISK_ASK, AUDIT_ASK, PEOPLE_ASK].map((r) => r.source).join('|'), 'i');

const NO_ACCESS = 'Branch performance isn’t part of your DI access.';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
const p1 = (v: number) => `${v.toFixed(1)}%`;
const p2 = (v: number) => `${v.toFixed(2)}%`;
const m = (v: number) => `$${(v / 1e6).toFixed(2)}M`;
const n0 = (v: number) => Math.round(v).toLocaleString('en-US');

/** A measure's value as people say it. */
export function showMeasure(measure: BranchMeasure, v: number) {
  switch (measure) {
    case 'depositGrowthPct':
    case 'loanGrowthPct':
      return signed(v);
    case 'newMembersPerMonth':
      return v.toFixed(1);
    case 'productsPerMember':
      return v.toFixed(2);
    case 'nps':
      return v.toFixed(0);
    case 'dq30Pct':
      return p2(v);
  }
}
const STATUS: Record<TargetStatus, Record<'range' | 'floor' | 'ceiling', string>> = {
  below: { range: 'Below target', floor: 'Below target', ceiling: 'On target' },
  'in range': { range: 'On target', floor: 'On target', ceiling: 'On target' },
  above: { range: 'Above range', floor: 'On target', ceiling: 'Above target' },
};
const shape = (k: BranchMeasure) => (BRANCH_TARGETS[k].low !== null && BRANCH_TARGETS[k].high !== null ? 'range' : BRANCH_TARGETS[k].low !== null ? 'floor' : 'ceiling');
const statusText = (k: BranchMeasure, s: TargetStatus) => STATUS[s][shape(k)];
const SAID: Record<BranchMeasure, string> = { depositGrowthPct: 'deposit growth', loanGrowthPct: 'net loan growth', newMembersPerMonth: 'new members a month', productsPerMember: 'products per member', nps: 'NPS', dq30Pct: '30+ delinquency' };
const lower = (k: BranchMeasure) => SAID[k];

const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
const usd2 = (v: number) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const overShort = (v: number) => (v === 0 ? '$0.00' : `${usd2(v)} ${v > 0 ? 'over' : 'short'}`);
const opsSources: ModuleSpec['sources'] = [
  { kind: 'table', label: 'Teller drawers, vault and lobby', ref: 'table:bro_teller_day' },
  { kind: 'table', label: 'CTRs, BSA referrals and fraud cases', ref: 'table:bro_fraud_case' },
  { kind: 'table', label: 'Audit exceptions and cash counts', ref: 'table:bro_audit_exception' },
  { kind: 'table', label: 'Training, staff changes and engagement', ref: 'table:bro_training' },
];

type Kind = 'targets' | 'delinquency' | 'digital' | 'productivity' | 'complaints' | 'balancing' | 'lobby' | 'risk' | 'audit' | 'people';

export function branchKpiPlan(t: string): { tool: string; args: Record<string, unknown> } {
  const s = t.toLowerCase();
  const NOT = ['CEO', 'NPS', 'FTE', 'CFPB', 'NCUA', 'September', 'October', 'November', 'December', 'January', 'The', 'My', 'Our', 'What', 'Which', 'How', 'Show', 'Digital', 'Branch', 'Staff'];
  const named = [/\b(?:at|in|for|of) ([A-Z][a-z]+)\b/g, /\b(?:is|are|did|does|[Ss]how|[Hh]ow(?:'|’)s) ([A-Z][a-z]+)\b/g].flatMap((re) => [...t.matchAll(re)].map((x) => x[1]!)).find((w) => !NOT.includes(w));
  const args = named ? { branch: named } : {};
  const order: [Kind, boolean][] = [
    ['complaints', /\bcomplaints?\b/.test(s)],
    ['people', PEOPLE_ASK.test(s)],
    ['audit', AUDIT_ASK.test(s)],
    ['balancing', BALANCING_ASK.test(s)],
    ['lobby', LOBBY_ASK.test(s)],
    ['risk', RISK_ASK.test(s)],
    ['delinquency', /\b30\b[^.?!]*\b60\b[^.?!]*\b90\b/.test(s) && !/\btargets?\b/.test(s)],
    ['digital', /\bdigital adoption|e-?statement|debit card|mobile (?:banking )?adoption\b/.test(s)],
    ['productivity', /\bproductivity\b|\b(?:per|each) (?:fte|full[- ]time|staff member|employee)\b/.test(s)],
  ];
  const kind: Kind = order.find(([, hit]) => hit)?.[0] ?? 'targets';
  return { tool: `bk_${kind}`, args };
}

export function branchKpiModule(svc: BranchKpiService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('branchkpi')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  /** The branches in view: the one asked for, if the viewer may see it, or all of theirs. */
  const scope = async (ctx: ModuleContext, branch?: string) => {
    const mine = ctx.purviewBranches;
    const name = branch?.trim().toLowerCase();
    // A word that isn't a branch's name narrows nothing.
    const found = name ? (await svc.branchNames()).find((b) => b.toLowerCase() === name) : undefined;
    if (!found) return { branches: mine };
    if (mine && !mine.includes(found)) throw new CoreError('NO_ACCESS', `That’s outside the branches you can see, so I can’t show ${found}. Your access covers ${mine.join(', ')}.`);
    return { branches: [found] };
  };
  const sources: ModuleSpec['sources'] = [
    { kind: 'table', label: 'Month-end balances, members and delinquency by branch', ref: 'table:hist_loan_month' },
    { kind: 'table', label: 'Member surveys', ref: 'table:cdm_survey' },
    { kind: 'table', label: 'Digital banking and cards', ref: 'table:cdm_digital_usage' },
    { kind: 'table', label: 'Complaints and regulator inquiries', ref: 'table:cpm_issue' },
  ];
  const branchArg = z.object({ branch: z.string().max(40).optional() }).strict();
  const spec: ModuleSpec = {
    id: 'branchkpi',
    prefix: 'bk',
    agent: 'Branch Performance',
    request: BRANCH_KPI_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the Branch Performance agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) runs branches and looks at them against the CEO's targets and the network (every branch together). Each tool covers the branches they can see; pass branch to narrow to one.

- bk_targets (branch): the CEO's six measures against their targets: deposit growth ${BRANCH_TARGETS.depositGrowthPct.target}, net loan growth ${BRANCH_TARGETS.loanGrowthPct.target}, new members ${BRANCH_TARGETS.newMembersPerMonth.target}, products per member ${BRANCH_TARGETS.productsPerMember.target}, NPS ${BRANCH_TARGETS.nps.target}, delinquency 30+ ${BRANCH_TARGETS.dq30Pct.target}.
- bk_delinquency (branch): delinquency at 30, 60 and 90 days.
- bk_digital (branch): digital adoption: mobile, online banking, e-statements, bill pay, recent logins and active debit cards.
- bk_productivity (branch): loans funded and accounts opened per person and per lender, a month.
- bk_complaints (branch): the complaint log: open member and regulator complaints, past due and closed.
- bk_balancing (branch): daily balancing and the cash vault: drawers in balance, over and short by teller, transactions per teller hour, the vault against its limit and dual control.
- bk_lobby (branch): lobby traffic and wait times against the ${LOBBY_WAIT_TARGET}-minute target, and the busiest times.
- bk_risk (branch): CTRs, structuring and other referrals to the BSA officer, fraud losses by type (skimming, check fraud, elder exploitation) and Reg E claims. Never SARs by branch.
- bk_audit (branch): audit exceptions and surprise cash counts, with dual control.
- bk_people (branch): turnover, engagement and required training (${REQUIRED_TRAINING.join(', ')}) against 100%.`,
    plan: (t) => branchKpiPlan(t),
    tools: [
      {
        name: 'bk_targets',
        description: 'The CEO’s six branch measures against their targets (deposit growth, net loan growth, new members a month, products per member, NPS, 30+ delinquency) for each branch in view and the network.',
        input: branchArg,
        run: async (a: { branch?: string }, ctx) => {
          need(ctx);
          const x = await svc.targets(await scope(ctx, a.branch));
          if (!x.lines.length) return { text: 'There are no branches in your view to score.' };
          const keys = Object.keys(BRANCH_TARGETS) as BranchMeasure[];
          if (x.lines.length === 1) {
            const b = x.lines[0]!;
            const met = b.scores.filter((s) => s.met);
            const missed = b.scores.filter((s) => !s.met);
            const rows = b.scores.map((s) => ({ measure: BRANCH_TARGETS[s.measure].label, branch: showMeasure(s.measure, s.value), network: showMeasure(s.measure, x.network[s.measure]), target: BRANCH_TARGETS[s.measure].target, status: statusText(s.measure, s.status) }));
            const worst = missed.map((s) => `${lower(s.measure)} ${showMeasure(s.measure, s.value)} (target ${BRANCH_TARGETS[s.measure].target})`);
            return {
              text: `**${b.branch} meets ${met.length} of the CEO’s 6 targets**${met.length ? `: ${met.map((s) => `${lower(s.measure)} ${showMeasure(s.measure, s.value)}`).join(', ')}` : ''}. ${missed.length ? `Short of target: ${worst.join('; ')}.` : 'Every measure is on target.'} The network averages ${showMeasure('depositGrowthPct', x.network.depositGrowthPct)} deposit growth, ${showMeasure('loanGrowthPct', x.network.loanGrowthPct)} loan growth and ${showMeasure('dq30Pct', x.network.dq30Pct)} 30+ delinquency. Balances and delinquency are at the ${x.label} month-end; NPS is from ${n0(b.npsResponses)} surveys in the last 12 months.`,
              blocks: [moduleTable(spec, `${b.branch} against the CEO’s targets`, ctx.runId, 'branch.kpi.targets', [text('measure', 'Measure'), text('branch', b.branch), text('network', 'Network'), text('target', 'Target'), text('status', 'Status')], rows, x.end)],
              sources,
              suggestions: [`Show ${b.branch} delinquency at 30, 60 and 90 days`, `What’s digital adoption at ${b.branch}?`, 'Show the complaint log for my branch'],
            };
          }
          const cols = [text('branch', 'Branch'), ...keys.map((k) => text(k, BRANCH_TARGETS[k].label.replace(', 12 months', ''))), text('met', 'Targets met')];
          const row = (l: (typeof x.lines)[number] | typeof x.network) => ({ branch: l.branch, ...Object.fromEntries(keys.map((k) => [k, `${showMeasure(k, l[k])}${l.scores.find((s) => s.measure === k)!.met ? '' : ' ✗'}`])), met: `${l.scores.filter((s) => s.met).length} of 6` });
          const ranked = [...x.lines].sort((p, q) => q.scores.filter((s) => s.met).length - p.scores.filter((s) => s.met).length);
          const missedBy = keys.map((k) => ({ k, n: x.lines.filter((l) => !l.scores.find((s) => s.measure === k)!.met).length }));
          const allMiss = missedBy.filter((v) => v.n === x.lines.length).map((v) => lower(v.k));
          return {
            text: `**${ranked[0]!.branch} meets the most of the CEO’s targets (${ranked[0]!.scores.filter((s) => s.met).length} of 6)**; ${ranked.at(-1)!.branch} meets the fewest (${ranked.at(-1)!.scores.filter((s) => s.met).length}).${allMiss.length ? ` No branch is on target for ${allMiss.join(', ')}.` : ''} Targets: ${keys.map((k) => `${lower(k)} ${BRANCH_TARGETS[k].target}`).join('; ')}. ✗ marks a miss.`,
            blocks: [moduleTable(spec, 'Branches against the CEO’s targets', ctx.runId, 'branch.kpi.targets', cols, [...x.lines.map(row), row(x.network)], x.end)],
            sources,
            suggestions: [`How is ${ranked.at(-1)!.branch} doing against the CEO’s targets?`, 'Show delinquency at 30, 60 and 90 days by branch', 'Show staff productivity by branch'],
          };
        },
      },
      {
        name: 'bk_delinquency',
        description: 'Delinquency at 30, 60 and 90 days for each branch in view and the network, at the latest month-end, against the 0.75% 30+ target.',
        input: branchArg,
        run: async (a: { branch?: string }, ctx) => {
          need(ctx);
          const x = await svc.delinquency(await scope(ctx, a.branch));
          const all = [...x.lines, x.network];
          const target = BRANCH_TARGETS.dq30Pct.high;
          const over = x.lines.filter((l) => l.ratio30 > target);
          const one = x.lines.length === 1 ? x.lines[0]! : null;
          const head = one
            ? `**${one.branch}: ${p2(one.ratio30)} of loans are 30+ days past due**, ${p2(one.ratio60)} 60+ and ${p2(one.ratio90)} 90+ (${n0(one.loans30)} loans, ${m(one.d30 + one.d60 + one.d90)}). That is ${one.ratio30 > target ? 'above' : 'within'} the CEO’s ${target}% target; the network is ${p2(x.network.ratio30)}.`
            : `**${over.length} of ${x.lines.length} branches are above the CEO’s ${target}% 30+ target.** The network is ${p2(x.network.ratio30)} 30+, ${p2(x.network.ratio60)} 60+ and ${p2(x.network.ratio90)} 90+.`;
          return {
            text: `${head} At the ${x.label} month-end.`,
            blocks: [
              moduleTable(spec, `Delinquency at 30, 60 and 90 days, ${x.label}`, ctx.runId, 'branch.kpi.delinquency', [text('branch', 'Branch'), { field: 'balance', headerName: 'Loans', type: 'currency' }, { field: 'd30', headerName: '30–59 days', type: 'currency' }, { field: 'd60', headerName: '60–89 days', type: 'currency' }, { field: 'd90', headerName: '90+ days', type: 'currency' }, { field: 'loans30', headerName: 'Loans 30+', type: 'count' }, text('r30', '30+'), text('r60', '60+'), text('r90', '90+'), text('target', 'Against 0.75%')], all.map((l) => ({ branch: l.branch, balance: Math.round(l.balance), d30: Math.round(l.d30), d60: Math.round(l.d60), d90: Math.round(l.d90), loans30: l.loans30, r30: p2(l.ratio30), r60: p2(l.ratio60), r90: p2(l.ratio90), target: l.ratio30 > target ? 'Above' : 'Within' })), x.month),
            ],
            sources,
            suggestions: ['Which loans should we work first?', 'Show the roll rates', `How is ${one?.branch ?? 'each branch'} doing against the CEO’s targets?`],
          };
        },
      },
      {
        name: 'bk_digital',
        description: 'Digital adoption by members’ home branch: mobile banking, online banking, e-statements, bill pay, logins in the last 90 days, members with an active debit card, and debit cards issued but not activated.',
        input: branchArg,
        run: async (a: { branch?: string }, ctx) => {
          need(ctx);
          const x = await svc.digital(await scope(ctx, a.branch));
          const one = x.lines.length === 1 ? x.lines[0]! : null;
          const lowest = [...x.lines].sort((p, q) => p.estatementsPct - q.estatementsPct)[0];
          const head = one
            ? `**At ${one.branch}, ${p1(one.mobilePct)} of members use mobile banking, ${p1(one.estatementsPct)} take e-statements and ${p1(one.activeDebitPct)} have an active debit card** (network ${p1(x.network.mobilePct)}, ${p1(x.network.estatementsPct)} and ${p1(x.network.activeDebitPct)}). ${p1(one.loggedIn90Pct)} logged in within 90 days. ${n0(one.debitNotActivated)} debit cards were issued and never activated: worth a call.`
            : `**Across the network, ${p1(x.network.mobilePct)} of members use mobile banking, ${p1(x.network.estatementsPct)} take e-statements and ${p1(x.network.activeDebitPct)} have an active debit card.**${lowest ? ` ${lowest.branch} has the lowest e-statement use (${p1(lowest.estatementsPct)}).` : ''} ${n0(x.network.debitNotActivated)} debit cards were issued and never activated.`;
          return {
            text: `${head} Members are counted at their home branch, as of ${x.asOf}.`,
            blocks: [moduleTable(spec, 'Digital adoption', ctx.runId, 'branch.kpi.digital', [text('branch', 'Branch'), { field: 'members', headerName: 'Members', type: 'count' }, text('mobile', 'Mobile banking'), text('online', 'Online banking'), text('est', 'E-statements'), text('bp', 'Bill pay'), text('li', 'Logged in, 90 days'), text('debit', 'Active debit card'), text('act', 'Debit cards activated'), { field: 'idle', headerName: 'Not activated', type: 'count' }], [...x.lines, x.network].map((l) => ({ branch: l.branch, members: l.members, mobile: p1(l.mobilePct), online: p1(l.onlinePct), est: p1(l.estatementsPct), bp: p1(l.billPayPct), li: p1(l.loggedIn90Pct), debit: p1(l.activeDebitPct), act: p1(l.debitActivationPct), idle: l.debitNotActivated })), x.asOf)],
            sources,
            suggestions: ['Find members at risk of leaving and draft follow-ups', 'Show staff productivity for my branch', 'How is my branch doing against the CEO’s targets?'],
          };
        },
      },
      {
        name: 'bk_productivity',
        description: 'Results per person over the last 12 months for each branch in view and the network: staff on the roster, loans funded and deposit accounts opened per person a month, and loans per lender a month.',
        input: branchArg,
        run: async (a: { branch?: string }, ctx) => {
          need(ctx);
          const x = await svc.productivity(await scope(ctx, a.branch));
          const one = x.lines.length === 1 ? x.lines[0]! : null;
          const top = [...x.lines].sort((p, q) => q.accountsPerStaffMonth - p.accountsPerStaffMonth)[0];
          const head = one
            ? `**${one.branch}’s ${one.staff} people opened ${one.accountsPerStaffMonth.toFixed(1)} accounts and funded ${one.loansPerStaffMonth.toFixed(1)} loans each a month** over the last ${x.months} months (network ${x.network.accountsPerStaffMonth.toFixed(1)} and ${x.network.loansPerStaffMonth.toFixed(1)}). Its ${one.lenders} lenders funded ${one.loansPerLenderMonth.toFixed(1)} loans each a month, against ${x.network.loansPerLenderMonth.toFixed(1)}.`
            : `**${top?.branch ?? NETWORK} is the most productive branch: ${top?.accountsPerStaffMonth.toFixed(1)} accounts opened per person a month**, against ${x.network.accountsPerStaffMonth.toFixed(1)} across the network, over the last ${x.months} months.`;
          return {
            text: `${head} Each person on the roster counts as one full-time person. Transactions per teller hour are in the teller balancing report.`,
            blocks: [moduleTable(spec, 'Staff productivity, last 12 months', ctx.runId, 'branch.kpi.productivity', [text('branch', 'Branch'), { field: 'staff', headerName: 'People', type: 'count' }, { field: 'lenders', headerName: 'Lenders', type: 'count' }, { field: 'funded', headerName: 'Loans funded', type: 'count' }, { field: 'opened', headerName: 'Accounts opened', type: 'count' }, text('lps', 'Loans per person a month'), text('lpl', 'Loans per lender a month'), text('aps', 'Accounts per person a month')], [...x.lines, x.network].map((l) => ({ branch: l.branch, staff: l.staff, lenders: l.lenders, funded: l.loansFunded, opened: l.accountsOpened, lps: l.loansPerStaffMonth.toFixed(1), lpl: l.loansPerLenderMonth.toFixed(1), aps: l.accountsPerStaffMonth.toFixed(1) })), x.end)],
            sources,
            suggestions: ['Who on my team is behind on goals?', 'Show referral conversion by sender', 'How is my branch doing against the CEO’s targets?'],
          };
        },
      },
      {
        name: 'bk_complaints',
        description: 'The complaint log for the branches in view: open member complaints and regulator complaints (CFPB, NCUA) and BBB, past due, closed in 12 months and days to close, with the open ones listed oldest first.',
        input: branchArg,
        run: async (a: { branch?: string }, ctx) => {
          need(ctx);
          const x = await svc.complaints(await scope(ctx, a.branch));
          const open = x.lines.reduce((s, l) => s + l.open, 0);
          const reg = x.lines.reduce((s, l) => s + l.openRegulatory, 0);
          const late = x.lines.reduce((s, l) => s + l.pastDue, 0);
          const where = x.lines.length === 1 ? x.lines[0]!.branch : `your ${x.lines.length} branches`;
          const oldest = x.open[0];
          return {
            text: open
              ? `**${open} open ${open === 1 ? 'complaint' : 'complaints'} at ${where}**, ${reg} from a regulator (CFPB or NCUA) and ${late} past ${late === 1 ? 'its' : 'their'} resolve-by date.${oldest ? ` The oldest, #${oldest.issueId} (${oldest.source}, ${oldest.category.toLowerCase()}), has been open ${oldest.ageDays} days.` : ''} The network has ${x.network.open} open, ${x.network.pastDue} past due.`
              : `No open complaints at ${where}. The network has ${x.network.open} open.`,
            blocks: [
              moduleTable(spec, 'Complaint log by branch', ctx.runId, 'branch.kpi.complaints', [text('branch', 'Branch'), { field: 'open', headerName: 'Open', type: 'count' }, { field: 'reg', headerName: 'Open, regulator', type: 'count' }, { field: 'late', headerName: 'Past due', type: 'count' }, { field: 'closed', headerName: 'Closed, 12 months', type: 'count' }, text('days', 'Days to close'), text('oldest', 'Oldest open')], [...x.lines, x.network].map((l) => ({ branch: l.branch, open: l.open, reg: l.openRegulatory, late: l.pastDue, closed: l.closed12, days: l.avgDaysToClose === null ? '—' : String(l.avgDaysToClose), oldest: l.oldestOpenDays === null ? '—' : `${l.oldestOpenDays} days` })), x.asOf),
              ...(x.open.length ? [moduleTable(spec, 'Open complaints', ctx.runId, 'branch.kpi.complaints.open', [text('id', 'Issue'), text('branch', 'Branch'), text('source', 'Source'), text('category', 'Category'), text('summary', 'Summary'), text('opened', 'Opened'), text('age', 'Age'), text('owner', 'Owner'), text('status', 'Status')], x.open.map((c) => ({ id: `#${c.issueId}`, branch: c.branch, source: c.source, category: c.category, summary: c.summary, opened: c.opened, age: `${c.ageDays} days`, owner: c.owner ?? 'Unassigned', status: `${c.status}${c.pastDue ? ', past due' : ''}` })), x.asOf)] : []),
            ],
            sources,
            suggestions: oldest ? [`Summarize case ${oldest.issueId}`, 'Which regulatory issues are open more than 3 weeks?', 'How is my branch doing against the CEO’s targets?'] : ['How is my branch doing against the CEO’s targets?'],
          };
        },
      },
      {
        name: 'bk_balancing',
        description: 'Daily balancing and the cash vault over the last 30 days for the branches in view and the network: teller drawers in balance, net and gross over and short, each teller’s record, transactions per teller hour, and the vault against its limit and under dual control.',
        input: branchArg,
        run: async (a: { branch?: string }, ctx) => {
          need(ctx);
          const x = await svc.balancing(await scope(ctx, a.branch));
          const one = x.lines.length === 1 ? x.lines[0]! : null;
          const worstTeller = [...x.people].sort((p, q) => q.outOfBalance - p.outOfBalance || q.gross - p.gross)[0];
          const vaultOver = x.lines.filter((l) => l.vaultOverLimitDays);
          const head = one
            ? `**${one.branch}’s drawers balanced on ${p1(one.balancedPct)} of days over the last ${x.days} days**: ${one.outOfBalance} of ${one.drawers} drawer closes were out, ${overShort(one.net)} net (${usd2(one.gross)} gross).${worstTeller?.outOfBalance ? ` ${worstTeller.name} was out ${worstTeller.outOfBalance} ${worstTeller.outOfBalance === 1 ? 'time' : 'times'}.` : ''} The vault closed over its ${usd(one.vaultLimit)} limit on ${one.vaultOverLimitDays} of ${one.vaultDays} days (peak ${usd(one.vaultPeak)})${one.vaultNoDualDays ? `, and ${one.vaultNoDualDays} ${one.vaultNoDualDays === 1 ? 'close was' : 'closes were'} not under dual control` : ', every close under dual control'}. Tellers handled ${one.txPerHour.toFixed(1)} transactions an hour (network ${x.network.txPerHour.toFixed(1)}).`
            : `**Drawers balanced on ${p1(x.network.balancedPct)} of days across the network over the last ${x.days} days**, ${x.network.outOfBalance} of ${x.network.drawers} closes out, ${overShort(x.network.net)} net. ${vaultOver.length ? `${vaultOver.map((l) => `${l.branch}’s vault was over its limit on ${l.vaultOverLimitDays} days`).join('; ')}.` : 'No vault closed over its limit.'} Tellers handled ${x.network.txPerHour.toFixed(1)} transactions an hour.`;
          return {
            text: `${head} From ${x.start} to ${x.end}; the front line is the MSRs, who also run the teller line.`,
            blocks: [
              moduleTable(spec, 'Daily balancing and the vault', ctx.runId, 'branch.kpi.balancing', [text('branch', 'Branch'), { field: 'drawers', headerName: 'Drawer closes', type: 'count' }, { field: 'out', headerName: 'Out of balance', type: 'count' }, text('bal', 'Balanced'), text('net', 'Net over/short'), text('gross', 'Gross differences'), text('tph', 'Transactions per teller hour'), text('vault', 'Vault over limit'), { field: 'nodual', headerName: 'Vault closes without dual control', type: 'count' }], [...x.lines, x.network].map((l) => ({ branch: l.branch, drawers: l.drawers, out: l.outOfBalance, bal: p1(l.balancedPct), net: overShort(l.net), gross: usd2(l.gross), tph: l.txPerHour.toFixed(1), vault: `${l.vaultOverLimitDays} of ${l.vaultDays} days`, nodual: l.vaultNoDualDays })), x.end),
              moduleTable(spec, 'Tellers', ctx.runId, 'branch.kpi.balancing.tellers', [text('name', 'Teller'), text('branch', 'Branch'), { field: 'drawers', headerName: 'Drawer closes', type: 'count' }, { field: 'out', headerName: 'Out of balance', type: 'count' }, text('net', 'Net over/short'), text('tph', 'Transactions an hour')], x.people.map((t) => ({ name: t.name, branch: t.branch, drawers: t.drawers, out: t.outOfBalance, net: overShort(t.net), tph: t.txPerHour.toFixed(1) })), x.end),
            ],
            sources: opsSources,
            suggestions: ['Show audit exceptions and surprise cash counts', 'What are lobby wait times this month?', 'Show staff productivity for my branch'],
          };
        },
      },
      {
        name: 'bk_lobby',
        description: `Lobby traffic and wait times over the last 30 days for the branches in view and the network, against the ${LOBBY_WAIT_TARGET}-minute target: visitors a day, average wait, the share of open hours over target, the longest wait and the busiest time.`,
        input: branchArg,
        run: async (a: { branch?: string }, ctx) => {
          need(ctx);
          const x = await svc.lobby(await scope(ctx, a.branch));
          const one = x.lines.length === 1 ? x.lines[0]! : null;
          const when = (b: { day: string; hour: number; avgWait: number } | null) => (b ? `${b.day}s at ${b.hour}:00, averaging ${b.avgWait.toFixed(1)} minutes` : '—');
          const slowest = [...x.lines].sort((p, q) => q.avgWait - p.avgWait)[0];
          const head = one
            ? `**${one.branch}’s average lobby wait was ${one.avgWait.toFixed(1)} minutes over the last 30 days**, ${one.avgWait <= x.target ? 'under' : 'over'} the ${x.target}-minute target, with ${n0(one.visitorsPerDay)} visitors a day. ${p1(one.hoursOverTargetPct)} of open hours averaged over ${x.target} minutes; the busiest time is ${when(one.busiest)}${one.busiest && one.busiest.avgWait > x.target ? ', over target' : ''}. The longest single wait was ${one.longestWait.toFixed(1)} minutes.`
            : `**The network’s average lobby wait was ${x.network.avgWait.toFixed(1)} minutes over the last 30 days**, against the ${x.target}-minute target.${slowest ? ` ${slowest.branch} waits longest, ${slowest.avgWait.toFixed(1)} minutes.` : ''} The busiest time is ${when(x.network.busiest)}.`;
          return {
            text: `${head} From the lobby queue system, ${x.start} to ${x.end}.`,
            blocks: [moduleTable(spec, 'Lobby traffic and waits', ctx.runId, 'branch.kpi.lobby', [text('branch', 'Branch'), text('visitors', 'Visitors a day'), text('wait', 'Average wait'), text('over', `Hours over ${x.target} minutes`), text('longest', 'Longest wait'), text('busiest', 'Busiest time')], [...x.lines, x.network].map((l) => ({ branch: l.branch, visitors: n0(l.visitorsPerDay), wait: `${l.avgWait.toFixed(1)} min`, over: p1(l.hoursOverTargetPct), longest: `${l.longestWait.toFixed(1)} min`, busiest: l.busiest ? `${l.busiest.day} ${l.busiest.hour}:00 (${l.busiest.avgWait.toFixed(1)} min)` : '—' })), x.end)],
            sources: opsSources,
            suggestions: ['Show daily balancing and the cash vault', 'Show staff productivity for my branch', 'How is my branch doing against the CEO’s targets?'],
          };
        },
      },
      {
        name: 'bk_risk',
        description: 'BSA and fraud by branch over the last 12 months: CTRs filed and late (15 days), unusual-activity and structuring referrals to the BSA officer, and fraud cases and net losses by type (card skimming, check fraud, elder financial exploitation, account takeover), with Reg E claims and any past 45 days. Never SARs by branch.',
        input: branchArg,
        run: async (a: { branch?: string }, ctx) => {
          need(ctx);
          const x = await svc.risk(await scope(ctx, a.branch));
          const one = x.lines.length === 1 ? x.lines[0]! : null;
          const l = one ?? x.network;
          const top = l.byType[0];
          const where = one ? one.branch : 'Across the network';
          const head = `**${where}, last 12 months: ${n0(l.ctrs)} CTRs filed, ${l.ctrsLate} late** (after 15 days), and staff made ${l.referrals} unusual-activity ${l.referrals === 1 ? 'referral' : 'referrals'} to the BSA officer, ${l.structuring} for structuring. ${l.fraudCases} fraud cases cost ${usd(l.netLoss)} net of recoveries${top ? `; ${top.type.toLowerCase()} is the largest (${usd(top.loss)} across ${top.cases} ${top.cases === 1 ? 'case' : 'cases'})` : ''}. ${l.skimming} card skimming, ${l.checkFraud} check fraud and ${l.elderCases} elder exploitation ${l.elderCases === 1 ? 'case' : 'cases'}. ${l.regEClaims} Reg E claims, ${l.regELate ? `${l.regELate} past ${REG_E_DAYS} days` : `none past ${REG_E_DAYS} days`}.`;
          return {
            text: `${head} SARs aren’t shown by branch: they stay with the BSA officer.`,
            blocks: [
              moduleTable(spec, 'BSA and fraud by branch, last 12 months', ctx.runId, 'branch.kpi.risk', [text('branch', 'Branch'), { field: 'ctrs', headerName: 'CTRs filed', type: 'count' }, { field: 'late', headerName: 'CTRs late', type: 'count' }, { field: 'refs', headerName: 'Referrals to BSA', type: 'count' }, { field: 'struct', headerName: 'Structuring', type: 'count' }, { field: 'cases', headerName: 'Fraud cases', type: 'count' }, { field: 'net', headerName: 'Net fraud loss', type: 'currency' }, { field: 'skim', headerName: 'Skimming', type: 'count' }, { field: 'check', headerName: 'Check fraud', type: 'count' }, { field: 'elder', headerName: 'Elder exploitation', type: 'count' }, { field: 'rege', headerName: 'Reg E claims', type: 'count' }, { field: 'regelate', headerName: `Reg E past ${REG_E_DAYS} days`, type: 'count' }], [...x.lines, x.network].map((r) => ({ branch: r.branch, ctrs: r.ctrs, late: r.ctrsLate, refs: r.referrals, struct: r.structuring, cases: r.fraudCases, net: Math.round(r.netLoss), skim: r.skimming, check: r.checkFraud, elder: r.elderCases, rege: r.regEClaims, regelate: r.regELate })), x.asOf),
              moduleTable(spec, `Fraud by type, ${one ? one.branch : NETWORK}`, ctx.runId, 'branch.kpi.risk.fraud', [text('type', 'Type'), { field: 'cases', headerName: 'Cases', type: 'count' }, { field: 'loss', headerName: 'Net loss', type: 'currency' }], l.byType.map((t) => ({ type: t.type, cases: t.cases, loss: Math.round(t.loss) })), x.asOf),
            ],
            sources: opsSources,
            suggestions: ['Show audit exceptions and surprise cash counts', 'Who hasn’t finished BSA training?', 'Show the complaint log for my branch'],
          };
        },
      },
      {
        name: 'bk_audit',
        description: 'Audit exceptions (open, high, past due) and surprise cash counts over the last 12 months for the branches in view and the network, with dual control and differences, and the open exceptions listed.',
        input: branchArg,
        run: async (a: { branch?: string }, ctx) => {
          need(ctx);
          const x = await svc.audits(await scope(ctx, a.branch));
          const open = x.lines.reduce((s, l) => s + l.open, 0);
          const high = x.lines.reduce((s, l) => s + l.openHigh, 0);
          const late = x.lines.reduce((s, l) => s + l.pastDue, 0);
          const counts = x.lines.reduce((s, l) => s + l.counts, 0);
          const off = x.lines.reduce((s, l) => s + l.countsWithDifference, 0);
          const diff = x.lines.reduce((s, l) => s + l.countDifference, 0);
          const noDual = x.lines.reduce((s, l) => s + l.countsWithoutDualControl, 0);
          const where = x.lines.length === 1 ? x.lines[0]!.branch : `your ${x.lines.length} branches`;
          const first = x.open.find((e) => e.severity === 'High') ?? x.open[0];
          return {
            text: `**${open} open audit ${open === 1 ? 'exception' : 'exceptions'} at ${where}, ${high} high and ${late} past due.**${first ? ` ${first.severity}: ${first.detail} (found ${first.found}, due ${first.due}${first.pastDue ? ', past due' : ''}).` : ''} Surprise cash counts: ${counts} in 12 months, ${off} with a difference${off ? ` (${usd2(diff)} in all)` : ''} and ${noDual} without dual control. The network has ${x.network.open} open exceptions.`,
            blocks: [
              moduleTable(spec, 'Audit exceptions and surprise counts', ctx.runId, 'branch.kpi.audit', [text('branch', 'Branch'), { field: 'open', headerName: 'Open exceptions', type: 'count' }, { field: 'high', headerName: 'High', type: 'count' }, { field: 'late', headerName: 'Past due', type: 'count' }, { field: 'found', headerName: 'Found, 12 months', type: 'count' }, { field: 'counts', headerName: 'Surprise counts', type: 'count' }, { field: 'off', headerName: 'With a difference', type: 'count' }, { field: 'nodual', headerName: 'Without dual control', type: 'count' }], [...x.lines, x.network].map((l) => ({ branch: l.branch, open: l.open, high: l.openHigh, late: l.pastDue, found: l.exceptions, counts: l.counts, off: l.countsWithDifference, nodual: l.countsWithoutDualControl })), x.asOf),
              ...(x.open.length ? [moduleTable(spec, 'Open audit exceptions', ctx.runId, 'branch.kpi.audit.open', [text('branch', 'Branch'), text('found', 'Found'), text('source', 'Source'), text('category', 'Category'), text('severity', 'Severity'), text('detail', 'Detail'), text('due', 'Due')], x.open.map((e) => ({ branch: e.branch, found: e.found, source: e.source, category: e.category, severity: e.severity, detail: e.detail, due: `${e.due}${e.pastDue ? ', past due' : ''}` })), x.asOf)] : []),
            ],
            sources: opsSources,
            suggestions: ['Show daily balancing and the cash vault', 'Who hasn’t finished BSA training?', 'Show BSA and fraud for my branch'],
          };
        },
      },
      {
        name: 'bk_people',
        description: `People for the branches in view and the network: headcount, who left and joined in 12 months and turnover, the latest engagement score, and required training (${REQUIRED_TRAINING.join(', ')}) against 100%, with who hasn’t finished.`,
        input: branchArg,
        run: async (a: { branch?: string }, ctx) => {
          need(ctx);
          const x = await svc.people(await scope(ctx, a.branch));
          const one = x.lines.length === 1 ? x.lines[0]! : null;
          const l = one ?? x.network;
          const q = l.engagementQuarter ? new Date(`${l.engagementQuarter}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
          const eng = l.engagement === null ? 'No engagement survey yet.' : `Engagement is ${l.engagement.toFixed(1)} of 5 in the ${q} survey${l.engagementPrior === null ? '' : ` (${l.engagement >= l.engagementPrior ? 'up' : 'down'} from ${l.engagementPrior.toFixed(1)})`}.`;
          const overdue = x.incomplete.filter((t) => t.overdue);
          const turnover = one
            ? `**${one.branch}: ${one.left} of ${one.headcount} people left in the last 12 months (${p1(one.turnoverPct)} turnover, network ${p1(x.network.turnoverPct)})**, and ${one.joined} joined.`
            : `**Across the network, ${x.network.left} of ${x.network.headcount} people left in the last 12 months (${p1(x.network.turnoverPct)} turnover)**, and ${x.network.joined} joined.`;
          return {
            text: `${turnover}${x.reasons.length ? ` Why they left: ${x.reasons.map((r) => `${r.reason.toLowerCase()} (${r.count})`).join(', ')}.` : ''} ${eng} Required training (${REQUIRED_TRAINING.join(', ')}) is ${p1(l.trainingPct)} complete against 100%${overdue.length ? `: ${overdue.length} overdue (${overdue.slice(0, 4).map((t) => `${t.name}, ${t.course}, due ${t.due}`).join('; ')})` : ''}${x.incomplete.length > overdue.length ? `, and ${x.incomplete.length - overdue.length} more not yet due` : ''}.`,
            blocks: [
              moduleTable(spec, 'People and training', ctx.runId, 'branch.kpi.people', [text('branch', 'Branch'), { field: 'head', headerName: 'People', type: 'count' }, { field: 'left', headerName: 'Left, 12 months', type: 'count' }, { field: 'joined', headerName: 'Joined, 12 months', type: 'count' }, text('turnover', 'Turnover'), text('eng', 'Engagement (of 5)'), ...REQUIRED_TRAINING.map((c) => text(`t_${c}`, `${c} training`)), { field: 'overdue', headerName: 'Training overdue', type: 'count' }], [...x.lines, x.network].map((r) => ({ branch: r.branch, head: r.headcount, left: r.left, joined: r.joined, turnover: p1(r.turnoverPct), eng: r.engagement === null ? '—' : r.engagement.toFixed(1), ...Object.fromEntries(r.training.map((c) => [`t_${c.course}`, p1(c.completionPct)])), overdue: r.trainingOverdue })), x.asOf),
              ...(x.incomplete.length ? [moduleTable(spec, 'Required training not finished', ctx.runId, 'branch.kpi.people.training', [text('name', 'Person'), text('branch', 'Branch'), text('course', 'Course'), text('due', 'Due')], x.incomplete.map((t) => ({ name: t.name, branch: t.branch, course: t.course, due: `${t.due}${t.overdue ? ', overdue' : ''}` })), x.asOf)] : []),
            ],
            sources: opsSources,
            suggestions: overdue.length ? [`Create a to-do for ${overdue[0]!.name} to finish ${overdue[0]!.course} training`, 'Who on my team is behind on goals?', 'Show audit exceptions and surprise cash counts'] : ['Who on my team is behind on goals?', 'Show audit exceptions and surprise cash counts'],
          };
        },
      },
    ],
  };
  return spec;
}
