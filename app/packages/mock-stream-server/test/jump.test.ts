// @vitest-environment node
// "Jump back in" on Home: which places DI puts forward for each person, and why. Pure: no warehouse.
import { describe, expect, it } from 'vitest';
import type { KpiGroupBlock } from '@dinext/block-schemas';
import type { Scorecard } from '@dinext/di-core';
import { jumpCards, personalKpis } from '../src/live.ts';

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

describe('frontline figures', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const goal = (name: string, actual: number, target: number, qualifier = false) => ({ goalId: name, name, unit: 'count' as const, unitLabel: '', actual, target, targetFrom: '', pct: 0, pending: 0, qualifier, rule: null, earned: 0 });
  const mine = { employeeId: 4, name: 'Sofia Ruiz', role: 'MSR', branch: 'Westport', periodEnd: '2026-10-31', period: 'October 2026', asOf: '', goals: [goal('Referrals', 8, 10), goal('Checking', 12, 10), goal('Survey', 90, 80, true)], qualified: true, total: 120, behind: true } as unknown as Scorecard;
  const sent = [{ createdAt: '2026-10-20T10:00:00Z', stage: 'Sold' }, { createdAt: '2026-10-22T10:00:00Z', stage: 'Active' }, { createdAt: '2026-08-01T10:00:00Z', stage: 'Sold' }];

  it('shows the person’s own month, never branch money', () => {
    const { kpis: k, narrative } = personalKpis(kpis, mine, sent, { open: 3, overdue: 1 }, now);
    expect(k.data.items.map((i) => [i.label, i.value])).toEqual([
      ['My goal attainment', 100],
      ['Incentive so far, October 2026', 120],
      ['Referrals I sent', 2],
      ['My open work', 3],
    ]);
    expect(JSON.stringify(k)).not.toMatch(/loan balance|deposit|Delinquency/i);
    expect(narrative).toBe('You’re at **100%** of your October 2026 goals, with 1 behind target, and **$120.00** in incentive so far. You sent **2** referrals in the last 30 days, and 1 sold. **1** of your 3 open items is overdue: start there.');
  });

  it('still works with no goals', () => {
    expect(personalKpis(kpis, null, [], { open: 0, overdue: 0 }, now).kpis.data.items.map((i) => i.label)).toEqual(['Referrals I sent', 'My open work']);
  });
});

describe('Jump back in', () => {
  it('leads with what DI flagged, says why, and offers one action', () => {
    const cards = jumpCards('executive', { kpis, lookAt: [flag] }, [], { open: 9, overdue: 3 });
    expect(cards[0]).toMatchObject({ title: 'Loan delinquency', reason: flag.title, change: { text: '↑ 5 bp vs September month-end', good: false }, action: { label: 'Ask why', ask: flag.question }, link: '/reports/loan_delinquency_monthly' });
    // Referrals are in Your work, so they aren't repeated here.
    expect(cards.map((c) => c.title)).toEqual(['Loan delinquency', 'Board report']);
    expect(cards[0]!.figure!.label).toBe('60+ days across the institution');
    expect(cards.length).toBeLessThanOrEqual(4);
  });

  it('shows no change that rounds to nothing', () => {
    const still = { data: { ...kpis.data, items: kpis.data.items.map((k, i) => (i === 2 ? { ...k, comparison: { ...k.comparison!, value: 0, direction: 'down' as const } } : k)) } } as KpiGroupBlock;
    expect(jumpCards('executive', { kpis: still, lookAt: [] }, [], null)[0]!.change).toBeUndefined();
  });

  it('only offers what the person can open', () => {
    // Sofia has no Reports: nothing to put forward beyond her own work.
    expect(jumpCards('msr', { kpis, lookAt: [flag] }, [], { open: 2, overdue: 0 })).toEqual([]);
    const marcus = jumpCards('branch', { kpis, lookAt: [] }, [], null);
    expect(marcus.map((c) => c.title)).toEqual(['Loan delinquency', 'Growth report – My branch']);
    // One branch is named, so the figure says whose it is.
    expect(marcus[0]).toMatchObject({ figure: { label: '60+ days at Westport' }, reason: 'Loans 60 or more days past due at Westport.' });
  });
});
