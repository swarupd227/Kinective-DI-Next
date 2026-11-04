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
    // The strip has the numbers; the sentence names what they mean and repeats none of them.
    expect(narrative).toBe('**Referrals** is the goal furthest behind, so that’s where to focus this month. Start with your overdue work.');
    expect(narrative).not.toMatch(/\d/);
  });

  it('still works with no goals', () => {
    expect(personalKpis(kpis, null, [], { open: 0, overdue: 0 }, now).kpis.data.items.map((i) => i.label)).toEqual(['Referrals I sent', 'My open work']);
  });
});

describe('Jump back in', () => {
  it('repeats nothing Home already shows: no strip figure, no flagged outlier', () => {
    // Northgate is in Worth a look with its own Why?, so delinquency gets no second card.
    const cards = jumpCards('executive', { kpis, lookAt: [flag] }, [], { open: 9, overdue: 3 });
    expect(cards.map((c) => c.title)).toEqual(['Executive dashboard']);
    expect(cards[0]).toMatchObject({ reason: expect.stringContaining('per-member averages'), action: { label: 'Brief me' } });
    expect(cards.every((c) => !c.figure && !c.change)).toBe(true);
    // Without a flag, the delinquency card says where to go, not the strip's number again.
    const calm = jumpCards('executive', { kpis, lookAt: [] }, [], null);
    expect(calm.map((c) => c.title)).toEqual(['Loan delinquency', 'Executive dashboard']);
    expect(calm[0]!.figure).toBeUndefined();
    expect(cards.length).toBeLessThanOrEqual(4);
  });

  it('gives a pinned report its own figure, and shows no change that rounds to nothing', () => {
    const canvas = (value: number, change: number) => ({ data: { widgets: [{ view: { type: 'kpi', data: { label: 'Checking balance', value, unit: 'currency', comparison: { label: 'vs Aug 2026', value: change, unit: 'percent', direction: change ? 'up' : 'down', goodWhen: 'up' } } } }] } }) as never;
    const [pin] = jumpCards('executive', { kpis, lookAt: [flag] }, [{ templateId: 'checking_growth_monthly', name: 'Checking growth', audience: 'me', pinnedBy: 'Dana Lee', canvas: canvas(4.1e8, 0) }], null);
    expect(pin).toMatchObject({ title: 'Checking growth', figure: { label: 'Checking balance', value: 4.1e8 } });
    expect(pin!.change).toBeUndefined();
  });

  it('only offers what the person can open', () => {
    // Sofia has no Reports: nothing to put forward beyond her own work.
    expect(jumpCards('msr', { kpis, lookAt: [flag] }, [], { open: 2, overdue: 0 })).toEqual([]);
    const marcus = jumpCards('branch', { kpis, lookAt: [] }, [], null);
    expect(marcus.map((c) => c.title)).toEqual(['Loan delinquency', 'Growth report – My branch']);
    // One branch is named, so the card says whose it is.
    expect(marcus[0]).toMatchObject({ reason: 'Loans 60 or more days past due at Westport, by category and branch.' });
  });
});
