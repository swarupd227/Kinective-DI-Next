// Loan officer production and pipeline stage times as report sections, under the report's branch
// control and the viewer's purview. The funded-dollars goal comes from Goals & Incentives.
import type { Block, DiTake, TableBlock } from '@dinext/block-schemas';
import { PRODUCTION_WINDOW_DAYS, type GoalsService, type LendingProductionService } from '@dinext/di-core';
import { moduleTable } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

type Cols = TableBlock['data']['columns'];
const p0 = (n: number) => `${Math.round(n)}%`;
const longDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('Sept', 'Sep');
const who = { agent: 'Report Builder', sources: [{ kind: 'table' as const, label: 'Loan applications, status history and loans', ref: 'table:cdm_loan_application' }] };

export function lendingAnalyses(svc: LendingProductionService, goals: GoalsService | null): ReportAnalyses {
  return {
    keys: ['lending.officers', 'lending.stages'],
    async run(key, runId, scope): Promise<{ block: Block; take?: DiTake }> {
      const branches = scope?.node && scope.node !== 'all' ? [scope.node] : scope?.purviewBranches;
      if (key === 'lending.stages') {
        const s = await svc.stages({ branches });
        const slow = [...s.stages].sort((a, b) => b.averageDays - a.averageDays)[0];
        const cols: Cols = [{ field: 'stage', headerName: 'Stage', type: 'text' }, { field: 'apps', headerName: 'Applications', type: 'count' }, { field: 'avg', headerName: 'Average days', type: 'text' }, { field: 'median', headerName: 'Median days', type: 'text' }, { field: 'over', headerName: 'Over the threshold', type: 'text' }];
        return {
          block: { ...moduleTable(who, 'Time in each stage', runId, 'lending.stages', cols, s.stages.map((x) => ({ stage: x.label, apps: x.applications, avg: x.averageDays.toFixed(1), median: x.medianDays.toFixed(1), over: x.thresholdDays ? `${x.overThreshold} (over ${x.thresholdDays} days)` : '—' })), s.asOf), subtitle: `Applications made in the last ${PRODUCTION_WINDOW_DAYS} days.${slow ? ` The slowest stage is ${slow.label.toLowerCase()}, ${slow.averageDays.toFixed(1)} days on average.` : ''}` } as Block,
        };
      }
      const o = await svc.officers({ branches });
      const cards = goals ? await goals.team(undefined, { leads: true, approves: true }, { purviewBranches: branches }).catch(() => []) : [];
      const goalPct = (id: number) => cards.find((c) => c.employeeId === id)?.goals.find((g) => g.goalId === 'FUNDED')?.pct ?? null;
      const cols: Cols = [
        { field: 'name', headerName: 'Loan officer', type: 'text' },
        ...(new Set(o.lines.map((l) => l.branch)).size > 1 ? [{ field: 'branch', headerName: 'Branch', type: 'text' as const }] : []),
        { field: 'apps', headerName: 'Applications', type: 'count' },
        { field: 'approved', headerName: 'Approved', type: 'count' },
        { field: 'approvedAmt', headerName: 'Approved dollars', type: 'currency' },
        { field: 'rate', headerName: 'Approval rate', type: 'text' },
        { field: 'days', headerName: 'Days to decision', type: 'text' },
        { field: 'open', headerName: 'Open now', type: 'count' },
        { field: 'goal', headerName: 'Funded-dollars goal', type: 'text' },
        { field: 'bookBalance', headerName: 'Book originated', type: 'currency' },
        { field: 'dq', headerName: '30+ / 60+', type: 'text' },
      ];
      const rows = o.lines.map((l) => {
        const g = goalPct(l.employeeId);
        return { name: l.name, branch: l.branch, apps: l.applications, approved: l.approved, approvedAmt: Math.round(l.approvedDollars), rate: p0(l.approvalPct), days: l.daysToDecision === null ? '—' : l.daysToDecision.toFixed(1), open: l.open, goal: g === null ? '—' : `${g}%`, bookBalance: Math.round(l.portfolio), dq: `${l.dq30Pct.toFixed(2)}% / ${l.dq60Pct.toFixed(2)}%` };
      });
      const top = [...o.lines].sort((a, b) => b.approvedDollars - a.approvedDollars)[0];
      const behind = o.lines.map((l) => ({ l, g: goalPct(l.employeeId) })).filter((x) => x.g !== null && x.g < 100).sort((a, b) => a.g! - b.g!);
      const credit = [...o.lines].sort((a, b) => b.dq60Pct - a.dq60Pct)[0];
      const headline = top
        ? `${top.name} approved the most, $${(top.approvedDollars / 1e6).toFixed(1)}M from ${top.applications} applications at ${p0(top.approvalPct)}, in the last ${PRODUCTION_WINDOW_DAYS} days.${behind[0] ? ` ${behind.length} ${behind.length === 1 ? 'is' : 'are'} behind on funded dollars, furthest ${behind[0].l.name} at ${behind[0].g}%.` : ''}${credit && o.lines.length > 1 ? ` ${credit.name}’s book has the highest 60+ delinquency, ${credit.dq60Pct.toFixed(2)}%.` : ''}`
        : 'No loan officers in view.';
      return {
        block: { ...moduleTable(who, 'Loan officer production', runId, 'lending.officers', cols, rows, o.asOf), subtitle: `Applications made in the last ${PRODUCTION_WINDOW_DAYS} days (from ${longDay(o.since)}); open applications and the book as of ${longDay(o.asOf)}. The goal is this period’s, from Goals & Incentives.` } as Block,
        take: { headline, action: { label: 'Which applications are stuck?', ask: 'Which applications have sat in underwriting more than five days?' } },
      };
    },
  };
}
