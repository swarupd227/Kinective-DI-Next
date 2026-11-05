// The branch scorecard and the team's goals as report sections. They follow the report's branch control
// and the viewer's purview: a branch manager sees their branch against the network; an executive sees
// every branch side by side.
import type { Block, DiTake, TableBlock } from '@dinext/block-schemas';
import { averagePct, type BranchLine, type BranchScorecardService, type GoalsService } from '@dinext/di-core';
import { moduleTable } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

type Cols = TableBlock['data']['columns'];
const p1 = (n: number) => `${n.toFixed(1)}%`;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
const m = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const who = { agent: 'Report Builder', sources: [{ kind: 'table' as const, label: 'Month-end history, accounts, onboarding and goals', ref: 'table:hist_loan_month' }] };

/** The network average per branch, for a branch to compare itself with. */
function average(lines: BranchLine[]): BranchLine {
  const k = lines.length || 1;
  const avg = (f: (l: BranchLine) => number) => lines.reduce((s, l) => s + f(l), 0) / k;
  const total = (f: (l: BranchLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  return {
    branch: 'Network average',
    loans: avg((l) => l.loans),
    loanGrowthPct: (total((l) => l.loans) / total((l) => l.loans / (1 + l.loanGrowthPct / 100)) - 1) * 100,
    deposits: avg((l) => l.deposits),
    depositGrowthPct: (total((l) => l.deposits) / total((l) => l.deposits / (1 + l.depositGrowthPct / 100)) - 1) * 100,
    accountsOpened: avg((l) => l.accountsOpened),
    accountsClosed: avg((l) => l.accountsClosed),
    checkingOpened: avg((l) => l.checkingOpened),
    loansFunded: avg((l) => l.loansFunded),
    loanDollarsFunded: avg((l) => l.loanDollarsFunded),
    joined: avg((l) => l.joined),
    left: avg((l) => l.left),
    attritionPct: avg((l) => l.attritionPct),
    dq60Pct: total((l) => (l.dq60Pct * l.loans) / 100) / total((l) => l.loans) * 100,
    referralsSold: avg((l) => l.referralsSold),
    referralsOpen: avg((l) => l.referralsOpen),
    onboardingOnTimePct: avg((l) => l.onboardingOnTimePct),
    onboardingOverdue: avg((l) => l.onboardingOverdue),
    staff: avg((l) => l.staff),
    accountsPerStaff: total((l) => l.accountsOpened) / (total((l) => l.staff) || 1),
  };
}

export function branchAnalyses(svc: BranchScorecardService, goals: GoalsService | null, persons: 'members' | 'customers'): ReportAnalyses {
  const Persons = persons === 'members' ? 'Members' : 'Customers';
  return {
    keys: ['branch.scorecard', 'branch.team'],
    async run(key, runId, scope): Promise<{ block: Block; take?: DiTake }> {
      const node = scope?.node && scope.node !== 'all' ? scope.node : null;
      const all = await svc.scorecard({ branches: scope?.purviewBranches });
      const network = average((await svc.scorecard()).lines);
      if (key === 'branch.team') {
        if (!goals) throw new Error('Goals aren’t loaded here.');
        const cards = await goals.team(node ?? undefined, { leads: true, approves: true }, { purviewBranches: scope?.purviewBranches });
        const shown = node ? cards : cards.filter((c) => c.behind).slice(0, 12);
        const cols: Cols = [{ field: 'name', headerName: 'Name', type: 'text' }, ...(node ? [] : [{ field: 'branch', headerName: 'Branch', type: 'text' as const }]), { field: 'role', headerName: 'Role', type: 'text' }, { field: 'avg', headerName: 'Average of goal', type: 'text' }, { field: 'behind', headerName: 'Behind on', type: 'text' }, { field: 'earned', headerName: 'Earned', type: 'currency' }];
        const rows = shown.map((c) => {
          const gate = c.goals.find((g) => g.qualifier && g.actual < g.target);
          const under = c.goals.filter((g) => !g.qualifier && g.pct < 100).map((g) => `${g.name.toLowerCase()} ${g.pct}%`);
          return { name: c.name, branch: c.branch, role: c.role, avg: `${averagePct(c)}%`, behind: [...(gate ? [`${gate.name.toLowerCase()} ${gate.actual}, under ${gate.target}`] : []), ...under].join('; ') || 'Nothing', earned: c.total };
        });
        const behind = cards.filter((c) => c.behind).length;
        return { block: { ...moduleTable(who, 'Team goals', runId, 'branch.team', cols, rows, all.end), subtitle: `${cards[0]?.period ?? ''}: ${behind} of ${cards.length} behind${node ? '' : ', furthest behind first'}.` } as Block };
      }
      const lines = node ? all.lines.filter((l) => l.branch === node) : all.lines;
      if (lines.length === 1) {
        const b = lines[0]!;
        const rows: [string, string, string][] = [
          ['Loans', `${m(b.loans)}, ${signed(b.loanGrowthPct)} on the year`, `${m(network.loans)}, ${signed(network.loanGrowthPct)}`],
          ['Shares and deposits', `${m(b.deposits)}, ${signed(b.depositGrowthPct)} on the year`, `${m(network.deposits)}, ${signed(network.depositGrowthPct)}`],
          [`Deposit accounts opened, ${all.monthLabel}`, n0(b.accountsOpened), n0(network.accountsOpened)],
          [`Checking accounts opened, ${all.monthLabel}`, n0(b.checkingOpened), n0(network.checkingOpened)],
          [`Loans funded, ${all.monthLabel}`, `${n0(b.loansFunded)} (${m(b.loanDollarsFunded)})`, `${n0(network.loansFunded)} (${m(network.loanDollarsFunded)})`],
          [`${Persons} joined, ${all.monthLabel}`, n0(b.joined), n0(network.joined)],
          [`${Persons} who left, ${all.monthLabel}`, n0(b.left), n0(network.left)],
          ['Attrition, 12 months', p1(b.attritionPct), p1(network.attritionPct)],
          ['Delinquency 60+', `${b.dq60Pct.toFixed(2)}%`, `${network.dq60Pct.toFixed(2)}%`],
          ['Referrals sold this period', n0(b.referralsSold), n0(network.referralsSold)],
          ['Onboarding touchpoints done', p1(b.onboardingOnTimePct), p1(network.onboardingOnTimePct)],
          ['Onboarding touchpoints overdue', n0(b.onboardingOverdue), n0(network.onboardingOverdue)],
          ['Accounts opened per person', b.accountsPerStaff.toFixed(1), network.accountsPerStaff.toFixed(1)],
        ];
        const better = (x: number, y: number) => (x > y ? 'ahead of' : 'behind');
        const headline = `${b.branch}: loans ${signed(b.loanGrowthPct)} and ${persons === 'members' ? 'shares' : 'deposits'} ${signed(b.depositGrowthPct)} on the year, ${better(b.loanGrowthPct, network.loanGrowthPct)} the network on loans. ${n0(b.accountsOpened)} accounts opened in ${all.monthLabel}, ${b.accountsPerStaff.toFixed(0)} per person against ${network.accountsPerStaff.toFixed(0)}. Attrition is ${p1(b.attritionPct)} against ${p1(network.attritionPct)}${b.onboardingOverdue ? `, and ${n0(b.onboardingOverdue)} onboarding touchpoints are overdue` : ''}.`;
        return {
          block: { ...moduleTable(who, `${b.branch} against the network`, runId, 'branch.scorecard', [{ field: 'measure', headerName: 'Measure', type: 'text' }, { field: 'branch', headerName: b.branch, type: 'text' }, { field: 'network', headerName: 'Network average', type: 'text' }], rows.map(([measure, branch, net]) => ({ measure, branch, network: net })), all.end), subtitle: `Balances at the ${all.monthLabel} month-end; the network is the average of every branch.` } as Block,
          take: { headline, action: { label: 'Who on my team is behind?', ask: 'Who on my team is behind on goals?' } },
        };
      }
      const cols: Cols = [
        { field: 'branch', headerName: 'Branch', type: 'text' },
        { field: 'loans', headerName: 'Loans', type: 'currency' },
        { field: 'lg', headerName: 'Loan growth', type: 'text' },
        { field: 'deposits', headerName: persons === 'members' ? 'Shares' : 'Deposits', type: 'currency' },
        { field: 'dg', headerName: 'Growth', type: 'text' },
        { field: 'opened', headerName: `Accounts opened, ${all.monthLabel}`, type: 'count' },
        { field: 'funded', headerName: 'Loans funded', type: 'count' },
        { field: 'net', headerName: `${Persons} joined less left`, type: 'count' },
        { field: 'attr', headerName: 'Attrition', type: 'text' },
        { field: 'dq', headerName: '60+', type: 'text' },
        { field: 'ref', headerName: 'Referrals sold', type: 'count' },
        { field: 'onb', headerName: 'Onboarding done', type: 'text' },
        { field: 'per', headerName: 'Accounts per person', type: 'text' },
      ];
      const rows = lines.map((l) => ({ branch: l.branch, loans: Math.round(l.loans), lg: signed(l.loanGrowthPct), deposits: Math.round(l.deposits), dg: signed(l.depositGrowthPct), opened: l.accountsOpened, funded: l.loansFunded, net: l.joined - l.left, attr: p1(l.attritionPct), dq: `${l.dq60Pct.toFixed(2)}%`, ref: l.referralsSold, onb: p1(l.onboardingOnTimePct), per: l.accountsPerStaff.toFixed(1) }));
      const fastest = [...lines].sort((a, b) => b.loanGrowthPct - a.loanGrowthPct)[0]!;
      const worst = [...lines].sort((a, b) => b.attritionPct - a.attritionPct)[0]!;
      const dq = [...lines].sort((a, b) => b.dq60Pct - a.dq60Pct)[0]!;
      const headline = `${fastest.branch} grew loans fastest (${signed(fastest.loanGrowthPct)} on the year). ${worst.branch} loses the most ${persons} (${p1(worst.attritionPct)} a year)${dq.branch === worst.branch ? ' and has the highest delinquency' : `; ${dq.branch} has the highest delinquency`} (${dq.dq60Pct.toFixed(2)}%).`;
      return {
        block: { ...moduleTable(who, 'Branch scorecard', runId, 'branch.scorecard', cols, rows, all.end), subtitle: `Balances at the ${all.monthLabel} month-end, growth over 12 months; accounts, loans and ${persons} for ${all.monthLabel}.` } as Block,
        take: { headline, action: { label: `How is ${worst.branch} doing?`, ask: `Brief me on ${worst.branch}` } },
      };
    },
  };
}
