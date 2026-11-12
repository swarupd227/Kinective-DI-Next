// @vitest-environment node
// A bank's finance leader sees net interest margin on Home where others see head count.
import { describe, expect, it } from 'vitest';
import type { KpiGroupBlock } from '@dinext/block-schemas';
import { financeKpis } from '../src/live.ts';

const item = (label: string, metric: string) => ({ label, value: 1, unit: 'count' as const, metricRef: `metric:${metric}` });
const base = {
  id: 'blk_kpgFinance00001',
  type: 'kpi_group',
  version: '1.0.0',
  provenance: { agent: 'Dashboard/Briefing', sources: [{ kind: 'metric', label: 'Customers', ref: 'metric:member_count' }] },
  data: { layout: 'row', items: [item('Loans', 'loan_balance'), item('Deposits', 'deposit_balance'), item('Delinquency 60+', 'delinquency_ratio_60_plus'), item('Customers', 'member_count')] },
} as unknown as KpiGroupBlock;
const svc = (rows: { period: string; net_interest_margin: number | null }[]) => ({ model: { metrics: { net_interest_margin: { label: 'Net interest margin (NIM)' } } }, query: async () => ({ rows }) }) as never;

describe('finance Home figures', () => {
  it('puts margin against last quarter before delinquency, in place of customers', async () => {
    const k = await financeKpis(svc([{ period: 'Q2 2026', net_interest_margin: 3.36 }, { period: 'Q3 2026', net_interest_margin: 3.34 }]), base);
    expect(k.data.items.map((i) => i.label)).toEqual(['Loans', 'Deposits', 'Net interest margin', 'Delinquency 60+']);
    expect(k.data.items[2]!.comparison).toMatchObject({ label: 'Q3 2026 vs Q2 2026', value: -2, unit: 'bp', direction: 'down', goodWhen: 'up' });
    expect(k.provenance.sources.map((s) => s.ref)).toEqual(['metric:net_interest_margin']);
  });

  it('keeps the institution figures without two quarters of margin', async () => {
    expect(await financeKpis(svc([{ period: 'Q3 2026', net_interest_margin: 3.34 }]), base)).toBe(base);
  });
});
