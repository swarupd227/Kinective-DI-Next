// @vitest-environment node
// What a click on a region or branch bar offers: one level down, why, and the records behind it.
import { describe, expect, it } from 'vitest';
import type { MetricDefinition } from '@dinext/semantic';
import { pointActionsFor } from '../src/answer.ts';

const def = (dims: string[]): MetricDefinition => ({ name: 'delinquency_ratio_60_plus', label: 'Delinquency 60+', description: '', formula: '', owner: '', version: '1', dimensionsAllowed: dims, trendable: true });
const records = { id: 'records', kind: 'ask_followup' as const, label: 'Show the loans behind it', params: { question: 'Show the loans behind delinquency 60+' } };

describe('chart follow-ups', () => {
  it('drills a region into its branches', () => {
    const { pointActions } = pointActionsFor('region', 'Delinquency 60+', def(['Branch', 'Region']), records);
    expect(pointActions!.map((a) => a.question)).toEqual(['Show delinquency 60+ at the {x} region by branch', 'Why is delinquency 60+ {value} at the {x} region?', 'Show the loans behind delinquency 60+ at the {x} region']);
  });

  it('drills a branch into the split its metric allows, or breaks it down in general words', () => {
    expect(pointActionsFor('branch', 'Delinquency 60+', def(['Branch', 'Loan category']), undefined).pointActions![0]).toEqual({ id: 'drill', kind: 'drill', label: '{x} by loan category', question: 'Show delinquency 60+ at {x} by loan category' });
    expect(pointActionsFor('branch', 'Delinquency 60+', undefined, undefined).pointActions![0]!.question).toBe('Break down delinquency 60+ at {x}');
  });

  it('leaves charts by month or product to the general follow-ups', () => {
    expect(pointActionsFor('period', 'Delinquency 60+', def(['Branch']), records)).toEqual({});
    expect(pointActionsFor('loan_category', 'Delinquency 60+', def(['Branch']), records)).toEqual({});
  });
});
