// @vitest-environment node
// "Jump back in" on Home: which places DI puts forward for each person, and why. Pure: no warehouse.
import { describe, expect, it } from 'vitest';
import type { KpiGroupBlock } from '@dinext/block-schemas';
import { jumpCards } from '../src/live.ts';

const kpis = {
  data: {
    layout: 'row',
    items: [
      { label: 'Total loan balance', value: 1.21e9, unit: 'currency', format: { compact: true, decimals: 2 }, comparison: { label: 'vs September month-end', value: -0.4, unit: 'percent', direction: 'down', goodWhen: 'up' } },
      { label: 'Total deposit balance', value: 1.64e9, unit: 'currency', comparison: { label: 'vs September month-end', value: 1.2, unit: 'percent', direction: 'up', goodWhen: 'up' } },
      { label: 'Delinquency 60+', value: 0.82, unit: 'percent', format: { decimals: 2 }, comparison: { label: 'vs September month-end', value: 5, unit: 'bp', direction: 'up', goodWhen: 'down' } },
      { label: 'Members', value: 48211, unit: 'count', comparison: { label: 'joined in October', value: 312, unit: 'count', direction: 'flat', goodWhen: 'up' } },
    ],
  },
} as unknown as KpiGroupBlock;
const flag = { title: 'Northgate: delinquency 60+ at 1.45%', subtitle: 'Institution rate 0.82%', question: 'Why is delinquency higher at Northgate?' };

describe('Jump back in', () => {
  it('leads with what DI flagged, says why, and offers one action', () => {
    const cards = jumpCards('executive', { kpis, lookAt: [flag] }, [], { open: 9, overdue: 3 });
    expect(cards[0]).toMatchObject({ title: 'Loan delinquency', reason: flag.title, change: { text: '↑ 5 bp vs September month-end', good: false }, action: { label: 'Ask why', ask: flag.question }, link: '/reports/loan_delinquency_monthly' });
    expect(cards[1]).toMatchObject({ title: 'Referrals', figure: { value: 9 }, change: { text: '3 overdue', good: false }, action: { ask: 'Show my overdue referrals' } });
    expect(cards.map((c) => c.title)).toContain('Board report');
    expect(cards.length).toBeLessThanOrEqual(4);
  });

  it('only offers what the person can open', () => {
    // Sofia has no Reports: no report cards, only her referrals.
    expect(jumpCards('msr', { kpis, lookAt: [flag] }, [], { open: 2, overdue: 0 }).map((c) => c.title)).toEqual(['Referrals']);
    expect(jumpCards('branch', { kpis, lookAt: [] }, [], null).map((c) => c.title)).toEqual(['Loan delinquency', 'Growth report – My branch']);
  });
});
