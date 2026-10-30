// Dashboard/Briefing (spec 6.3, 24.6). The figures come straight from the semantic layer and the
// narrative is assembled by code, so Home, "Brief me" and the Analytics agent always agree.
import type { ChartBlock, KpiGroupBlock } from '@dinext/block-schemas';
import type { QueryContext, SemanticResult, SemanticService } from '@dinext/semantic';
import { formatMetric, newBlockId, TENANT_UTC_OFFSET } from './answer.ts';

export const BRIEFING_AGENT = 'Dashboard/Briefing';

export interface Briefing {
  kpis: KpiGroupBlock;
  trend: ChartBlock;
  narrative: string;
  lookAt: { title: string; subtitle: string; why: string; question: string }[];
  results: SemanticResult[];
}

const monthName = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
const num = (r: SemanticResult, metric: string, where: Record<string, string> = {}) => {
  const row = r.rows.find((x) => Object.entries(where).every(([k, v]) => x[k] === v));
  return row ? Number(row[metric]) : null;
};

export async function buildBriefing(svc: SemanticService, ctx: QueryContext, runId = 'home'): Promise<Briefing> {
  const m = svc.model.metrics;
  const [now, history, joins, branches] = await Promise.all([
    svc.query({ metrics: ['loan_balance', 'deposit_balance', 'delinquency_ratio_60_plus', 'member_count'] }, ctx),
    svc.query({ metrics: ['loan_balance', 'deposit_balance', 'delinquency_ratio_60_plus', 'member_count'], time: { grain: 'month', last: 12 } }, ctx),
    svc.query({ metrics: ['new_members'], time: { grain: 'month', last: 1 } }, ctx),
    svc.query({ metrics: ['delinquency_ratio_60_plus', 'loan_balance'], dimensions: ['branch'], order: [{ field: 'delinquency_ratio_60_plus', dir: 'desc' }] }, ctx),
  ]);
  const periods = history.periods!;
  const last = periods[periods.length - 1]!.label;
  const series = (metric: string) => periods.map((p) => num(history, metric, { period: p.label }) ?? 0);

  const loans = num(now, 'loan_balance')!;
  const deposits = num(now, 'deposit_balance')!;
  const dq = num(now, 'delinquency_ratio_60_plus')!;
  const members = num(now, 'member_count')!;
  const loansThen = num(history, 'loan_balance', { period: last })!;
  const depositsThen = num(history, 'deposit_balance', { period: last })!;
  const dqThen = num(history, 'delinquency_ratio_60_plus', { period: last })!;
  const joined = num(joins, 'new_members') ?? 0;
  const pct = (a: number, b: number) => (b ? ((a - b) / Math.abs(b)) * 100 : 0);
  const vsLabel = `vs ${monthName(svc.build.latestMonthEnd)} month-end`;
  const dir = (v: number) => (v > 0.0005 ? 'up' : v < -0.0005 ? 'down' : 'flat') as 'up' | 'down' | 'flat';

  const asOf = `${svc.build.completedAt}${TENANT_UTC_OFFSET}`;
  const kpis: KpiGroupBlock = {
    id: newBlockId('kpg'),
    type: 'kpi_group',
    version: '1.0.0',
    provenance: {
      agent: BRIEFING_AGENT,
      runId,
      operations: ['semantic.query'],
      sources: ['loan_balance', 'deposit_balance', 'delinquency_ratio_60_plus', 'member_count'].map((x) => ({ kind: 'metric' as const, label: m[x]!.label, ref: `metric:${x}` })),
      filters: now.filtersApplied,
      purviewApplied: Boolean(ctx.purviewBranches),
      semanticQueryId: now.queryId,
    },
    freshness: { kind: 'nightly_build', asOf, buildId: svc.build.buildId },
    data: {
      layout: 'row',
      items: [
        { label: m.loan_balance!.label, value: loans, unit: 'currency', format: { compact: true, decimals: 2 }, comparison: { label: vsLabel, value: Math.round(pct(loans, loansThen) * 10) / 10, unit: 'percent', direction: dir(pct(loans, loansThen)), goodWhen: 'up' }, sparkline: series('loan_balance'), metricRef: 'metric:loan_balance' },
        { label: m.deposit_balance!.label, value: deposits, unit: 'currency', format: { compact: true, decimals: 2 }, comparison: { label: vsLabel, value: Math.round(pct(deposits, depositsThen) * 10) / 10, unit: 'percent', direction: dir(pct(deposits, depositsThen)), goodWhen: 'up' }, sparkline: series('deposit_balance'), metricRef: 'metric:deposit_balance' },
        { label: 'Delinquency 60+', value: dq, unit: 'percent', format: { decimals: 2 }, comparison: { label: vsLabel, value: Math.round((dq - dqThen) * 100), unit: 'bp', direction: dir(dq - dqThen), goodWhen: 'down' }, sparkline: series('delinquency_ratio_60_plus'), metricRef: 'metric:delinquency_ratio_60_plus' },
        { label: m.member_count!.label, value: members, unit: 'count', comparison: { label: `joined in ${monthName(svc.build.latestMonthEnd)}`, value: joined, unit: 'count', direction: 'flat', goodWhen: 'up' }, sparkline: series('member_count'), metricRef: 'metric:member_count' },
      ],
    },
  };

  const trend: ChartBlock = {
    id: newBlockId('cht'),
    type: 'chart',
    version: '2.0.0',
    title: 'Delinquency 60+ trend',
    subtitle: `Month-end, last ${periods.length} months`,
    provenance: { agent: BRIEFING_AGENT, runId, operations: ['semantic.query'], sources: [{ kind: 'metric', label: `${m.delinquency_ratio_60_plus!.label} (definition)`, ref: 'metric:delinquency_ratio_60_plus' }, { kind: 'table', label: 'Loan history (month-end)' }], filters: history.filtersApplied, semanticQueryId: history.queryId },
    freshness: { kind: 'nightly_build', asOf, buildId: svc.build.buildId },
    actions: [{ id: 'explain', kind: 'explain', label: 'Explain' }, { id: 'open', kind: 'open_workspace', label: 'Open grid' }],
    a11y: { summary: `Line chart of the 60+ day delinquency ratio at each month-end, from ${formatMetric(series('delinquency_ratio_60_plus')[0]!, 'percent_2')} in ${periods[0]!.label} to ${formatMetric(dqThen, 'percent_2')} in ${last}.` },
    data: {
      chartType: 'line',
      dataset: { dimensions: [{ name: 'x', displayName: 'Month', type: 'ordinal' }, { name: 'y', displayName: 'Delinquency 60+' }], source: periods.map((p, i) => [p.label.replace(/ \d{4}$/, (y) => (i === 0 || p.label.startsWith('Jan') ? y : '')), series('delinquency_ratio_60_plus')[i]!]) },
      series: [{ name: 'Delinquency 60+', encode: { x: 'x', y: 'y' } }],
      axes: { y: [{ title: 'Rate', unit: 'percent' }] },
      legend: false,
    },
  };

  // Narrative assembled from computed values only (spec 26.7).
  const worst = branches.rows[0];
  const lines = [
    `${m.loan_balance!.label} is **${formatMetric(loans, 'currency')}**, ${pct(loans, loansThen) >= 0 ? 'up' : 'down'} ${formatMetric(Math.abs(pct(loans, loansThen)), 'pct')} since the ${monthName(svc.build.latestMonthEnd)} month-end, and ${m.deposit_balance!.label.toLowerCase()} is **${formatMetric(deposits, 'currency')}**.`,
    `Delinquency 60+ is **${formatMetric(dq, 'percent_2')}**, ${dq >= dqThen ? 'up' : 'down'} ${formatMetric(Math.abs(dq - dqThen) * 100, 'bp')} over the same period${worst && branches.rows.length > 1 ? `; **${worst.branch}** is highest at ${formatMetric(Number(worst.delinquency_ratio_60_plus), 'percent_2')}` : ''}.`,
    `${formatMetric(joined, 'count')} new ${svc.model.institutionType === 'bank' ? 'customers' : 'members'} joined in ${monthName(svc.build.latestMonthEnd)}.`,
  ];

  const lookAt: Briefing['lookAt'] = [];
  if (worst && branches.rows.length > 1) {
    const avg = dq;
    lookAt.push({
      title: `${worst.branch}: delinquency 60+ at ${formatMetric(Number(worst.delinquency_ratio_60_plus), 'percent_2')}`,
      subtitle: `Institution rate ${formatMetric(avg, 'percent_2')}`,
      why: `The Briefing agent ranks branches by the 60+ day delinquency ratio as of the nightly build. ${worst.branch} has the highest ratio of ${branches.rows.length} branches.`,
      question: `Show delinquency 60+ by loan category for ${worst.branch}`,
    });
  }
  if (Math.abs(dq - dqThen) * 100 >= 3) {
    lookAt.push({
      title: `Delinquency 60+ ${dq > dqThen ? 'rose' : 'fell'} ${formatMetric(Math.abs(dq - dqThen) * 100, 'bp')} since the ${monthName(svc.build.latestMonthEnd)} month-end`,
      subtitle: `Now ${formatMetric(dq, 'percent_2')}`,
      why: 'Changes of 3 basis points or more against the last month-end are flagged.',
      question: 'Show the delinquency 60+ trend by branch for the last 6 months',
    });
  }

  return { kpis, trend, narrative: lines.join(' '), lookAt, results: [now, history, joins, branches] };
}
