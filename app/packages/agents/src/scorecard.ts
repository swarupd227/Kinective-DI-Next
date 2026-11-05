// The board's scorecard: each headline measure with its actual, this year's plan, the peer median and
// five quarters of trend, from the governed metrics (the 5300 for earnings and capital, month-end
// history for balances, growth and credit quality). A report widget of kind "analysis" names it, so
// the Board report and the Executive dashboard lead with how the institution is doing against plan.
import type { Block, DiTake, TableBlock } from '@dinext/block-schemas';
import type { SemanticService } from '@dinext/semantic';
import type { Pool } from '@dinext/tenant-db';
import { moduleTable } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

type Good = 'up' | 'down' | 'target';
interface Line {
  /** A governed metric, or a growth rate worked out from one. */
  key: string;
  label: string;
  metric: string;
  growth?: boolean;
  good: Good;
  places: number;
}

const CU: Line[] = [
  { key: 'return_on_assets', label: 'Return on assets', metric: 'return_on_assets', good: 'up', places: 2 },
  { key: 'net_interest_margin', label: 'Net interest margin', metric: 'net_interest_margin', good: 'up', places: 2 },
  { key: 'efficiency_ratio', label: 'Efficiency ratio', metric: 'efficiency_ratio', good: 'down', places: 1 },
  { key: 'net_worth_ratio', label: 'Net worth ratio', metric: 'net_worth_ratio', good: 'up', places: 2 },
  { key: 'loan_growth', label: 'Loan growth, 12 months', metric: 'loan_balance', growth: true, good: 'up', places: 1 },
  { key: 'deposit_growth', label: 'Share growth, 12 months', metric: 'deposit_balance', growth: true, good: 'up', places: 1 },
  { key: 'member_growth', label: 'Member growth, 12 months', metric: 'member_count', growth: true, good: 'up', places: 1 },
  { key: 'loan_to_share_ratio', label: 'Loan-to-share', metric: 'loan_to_share_ratio', good: 'target', places: 1 },
  { key: 'delinquency_ratio_60_plus', label: 'Delinquency 60+', metric: 'delinquency_ratio_60_plus', good: 'down', places: 2 },
  { key: 'net_charge_off_ratio', label: 'Net charge-offs to average loans', metric: 'net_charge_off_ratio', good: 'down', places: 2 },
];
const BANK: Line[] = [
  { key: 'loan_growth', label: 'Loan growth, 12 months', metric: 'loan_balance', growth: true, good: 'up', places: 1 },
  { key: 'deposit_growth', label: 'Deposit growth, 12 months', metric: 'deposit_balance', growth: true, good: 'up', places: 1 },
  { key: 'member_growth', label: 'Customer growth, 12 months', metric: 'member_count', growth: true, good: 'up', places: 1 },
  { key: 'loan_to_share_ratio', label: 'Loan-to-deposit', metric: 'loan_to_share_ratio', good: 'target', places: 1 },
  { key: 'delinquency_ratio_60_plus', label: 'Delinquency 60+', metric: 'delinquency_ratio_60_plus', good: 'down', places: 2 },
];

const fmt = (n: number | null, places: number) => (n === null || !Number.isFinite(n) ? '—' : `${n.toFixed(places)}%`);
const quarterStart = (monthEnd: string, back: number) => {
  const d = new Date(`${monthEnd.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 3 * back - 2);
  return d.toISOString().slice(0, 7);
};

export interface ScorecardRow {
  label: string;
  actual: number | null;
  plan: number | null;
  peer: number | null;
  trend: (number | null)[];
  vsPlan: 'Ahead' | 'Behind' | 'On plan' | '—';
  vsPeer: 'Better' | 'Worse' | 'In line' | 'Higher' | 'Lower' | '—';
  places: number;
}

/** Ahead or behind, honouring which way is good. A target (loan-to-share) is on plan within 2 points. */
const versus = (actual: number | null, ref: number | null, good: Good, places: number) => {
  if (actual === null || ref === null) return 0;
  const gap = Number(actual.toFixed(places)) - Number(ref.toFixed(places));
  if (good === 'target') return Math.abs(gap) <= 2 ? 0 : -1;
  if (gap === 0) return 0;
  return (good === 'up' ? gap > 0 : gap < 0) ? 1 : -1;
};

export async function boardScorecard(svc: SemanticService, pool: Pool, institutionType: 'credit_union' | 'bank') {
  const lines = institutionType === 'bank' ? BANK : CU;
  const [bench] = (await pool.query('SELECT kind, metric, value FROM fin_benchmark').catch(() => [[]])) as [{ kind: string; metric: string; value: number }[]];
  const ref = (kind: string, key: string) => {
    const b = bench.find((x) => x.kind === kind && x.metric === key);
    return b ? Number(b.value) : null;
  };
  const end = svc.build.latestMonthEnd;
  const time = { grain: 'quarter' as const, from: quarterStart(end, 4), to: end.slice(0, 7) };
  const ctx = { canViewSql: false };
  const rows: ScorecardRow[] = [];
  for (const l of lines) {
    let trend: (number | null)[] = [];
    let actual: number | null = null;
    try {
      const r = await svc.query({ metrics: [l.metric], time }, ctx);
      const values = r.rows.map((x) => (x[l.metric] === null || x[l.metric] === undefined ? null : Number(x[l.metric])));
      if (l.growth) {
        const first = values[0];
        const last = values.at(-1);
        actual = first && last ? ((last - first) / first) * 100 : null;
        // Growth on the year to each quarter-end isn't available before the history starts; show the balance path instead.
        trend = [];
      } else {
        trend = values;
        actual = values.at(-1) ?? null;
      }
    } catch {
      actual = null;
    }
    const plan = ref('plan', l.key);
    const peer = ref('peer', l.key);
    const p = versus(actual, plan, l.good, l.places);
    const q = versus(actual, peer, l.good, l.places);
    rows.push({ label: l.label, actual, plan, peer, trend, places: l.places, vsPlan: actual === null || plan === null ? '—' : p > 0 ? 'Ahead' : p < 0 ? 'Behind' : 'On plan', vsPeer: actual === null || peer === null ? '—' : l.good === 'target' ? (q === 0 ? 'In line' : actual > peer ? 'Higher' : 'Lower') : q > 0 ? 'Better' : q < 0 ? 'Worse' : 'In line' });
  }
  const ahead = rows.filter((r) => r.vsPlan === 'Ahead' || r.vsPlan === 'On plan').length;
  const judged = rows.filter((r) => r.vsPlan !== '—').length;
  const better = rows.filter((r) => r.vsPeer === 'Better' || r.vsPeer === 'In line').length;
  const peered = rows.filter((r) => r.vsPeer === 'Better' || r.vsPeer === 'In line' || r.vsPeer === 'Worse').length;
  const behind = rows.filter((r) => r.vsPlan === 'Behind');
  const headline = `On or ahead of plan on ${ahead} of ${judged} measures, and in line with or better than peers on ${better} of ${peered}.${behind.length ? ` Behind plan: ${behind.map((b) => `${b.label.toLowerCase().replace(/, 12 months$/, '')} (${fmt(b.actual, b.places)} against ${fmt(b.plan, b.places)})`).join('; ')}.` : ''}`;
  return { rows, headline, behind, asOf: end };
}

export function boardAnalyses(svc: SemanticService, pool: Pool, institutionType: 'credit_union' | 'bank'): ReportAnalyses {
  return {
    keys: ['board.scorecard'],
    async run(_key, runId): Promise<{ block: Block; take?: DiTake }> {
      const s = await boardScorecard(svc, pool, institutionType);
      const cols: TableBlock['data']['columns'] = [
        { field: 'measure', headerName: 'Measure', type: 'text' },
        { field: 'actual', headerName: 'Actual', type: 'text' },
        { field: 'plan', headerName: 'Plan', type: 'text' },
        { field: 'vsPlan', headerName: 'Against plan', type: 'text' },
        { field: 'peer', headerName: 'Peer median', type: 'text' },
        { field: 'vsPeer', headerName: 'Against peers', type: 'text' },
        { field: 'trend', headerName: 'Last five quarters', type: 'text' },
      ];
      const block = moduleTable(
        { agent: 'Report Builder', sources: [{ kind: 'table', label: institutionType === 'bank' ? 'Month-end history and the 2026 plan' : 'The 5300, month-end history and the 2026 plan', ref: 'table:fin_benchmark' }] },
        'Scorecard against plan and peers',
        runId,
        'board.scorecard',
        cols,
        s.rows.map((r) => ({ measure: r.label, actual: fmt(r.actual, r.places), plan: fmt(r.plan, r.places), vsPlan: r.vsPlan, peer: fmt(r.peer, r.places), vsPeer: r.vsPeer, trend: r.trend.length ? r.trend.map((v) => (v === null ? '—' : v.toFixed(r.places))).join(' → ') : '—' })),
        `${s.asOf.slice(0, 10)}`,
      );
      const first = s.behind[0];
      return {
        block: { ...block, subtitle: `Plan: the 2026 budget. Peers: ${institutionType === 'bank' ? 'commercial banks $1–3B' : 'credit unions over $1B'}, Q2 2026 medians (illustrative).${institutionType === 'bank' ? ' Earnings and capital need the FFIEC Call Report, which isn’t loaded.' : ''}` } as Block,
        take: { headline: s.headline, action: first ? { label: `Why is ${first.label.toLowerCase().replace(/, 12 months$/, '')} behind plan?`, ask: `Why is ${first.label.toLowerCase().replace(/, 12 months$/, '')} behind plan?` } : { label: 'What changed since last quarter?', ask: 'What changed since last quarter-end?' } },
      };
    },
  };
}
