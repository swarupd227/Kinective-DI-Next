// Clicking a bar or point offers follow-ups (drill, why, the rows), each asked in the conversation with
// the chart attached; hovering says how the value compares (the month before, or the average).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnnouncerProvider, TooltipProvider } from '@dinext/ui';
import { blockSchema, type ChartBlock } from '@dinext/block-schemas';
import { chartFixture } from '@dinext/block-schemas/fixtures';
import { BlockHostProvider, BlockRenderer, type BlockHost } from '../src/index.ts';
import { isTimeAxis, pointMenu } from '../src/chart/pointMenu.ts';
import { tooltipLines } from '../src/chart/buildOption.ts';

// ECharts needs a real layout engine: the stand-in reports a click on the second category.
vi.mock('../src/chart/EChart.tsx', () => ({
  EChart: ({ ariaLabel, onPointClick }: { ariaLabel: string; onPointClick?: (p: { index: number; seriesIndex: number | null; offsetX: number; offsetY: number }) => void }) => (
    <div role="img" aria-label={ariaLabel}>
      {onPointClick && <button onClick={() => onPointClick({ index: 1, seriesIndex: null, offsetX: 40, offsetY: 60 })}>point</button>}
    </div>
  ),
}));

const months: ChartBlock = {
  ...chartFixture,
  id: 'blk_chtDqMonths1',
  title: 'Delinquency 60+ by month',
  data: {
    chartType: 'line',
    dataset: { dimensions: [{ name: 'x', displayName: 'Month', type: 'ordinal' }, { name: 'y', displayName: 'Delinquency 60+' }], source: [['Aug 2026', 0.5], ['Sep 2026', 0.62], ['Oct 2026', 0.58]] },
    series: [{ name: 'Delinquency 60+', encode: { x: 'x', y: 'y' } }],
    axes: { y: [{ title: 'Delinquency 60+', unit: 'percent' }] },
  },
};

describe('point menu', () => {
  it('offers a breakdown and a why for a branch, in plain words', () => {
    const c = pointMenu(chartFixture, { x: 'Westport', series: 'Q3 2026', value: 200.6e6 });
    expect(c.map((x) => x.kind)).toEqual(['drill', 'why']);
    expect(c[0]!.question).toMatch(/^Break down .+ for Westport$/);
    expect(c[1]!.question).toMatch(/^Why is .+ for Westport\?$/);
  });

  it('asks what moved for a month, and adds the records behind the figure when the block has them', () => {
    expect(isTimeAxis(months)).toBe(true);
    expect(isTimeAxis(chartFixture)).toBe(false);
    const withRecords: ChartBlock = { ...months, actions: [{ id: 'records', kind: 'ask_followup', label: 'Show the loans behind it', params: { question: 'Show the loans behind delinquency 60+' } }] };
    const c = pointMenu(withRecords, { x: 'Sep 2026', series: 'Delinquency 60+', value: 0.62 });
    expect(c.map((x) => x.question)).toEqual(['Show delinquency 60+ by branch for Sep 2026', 'Why did delinquency 60+ change in Sep 2026?', 'Show the loans behind delinquency 60+ for Sep 2026']);
    expect(c[2]!.label).toBe('Show the loans behind Sep 2026');
  });

  it('uses the agent’s own follow-ups when the chart carries them', () => {
    const own: ChartBlock = { ...chartFixture, data: { ...chartFixture.data, pointActions: [{ id: 'drill', kind: 'drill', label: '{x} by loan category', question: 'Show loan balance at {x} by loan category' }, { id: 'why', kind: 'why', label: 'Why is {x} at {value}?', question: 'Why is loan balance {value} at {x}?' }] } };
    expect(blockSchema.safeParse(own).success).toBe(true);
    const c = pointMenu(own, { x: 'Harbor', series: 'Q3 2026', value: 2_500_000 });
    expect(c[0]!.question).toBe('Show loan balance at Harbor by loan category');
    expect(c[1]!.question).toMatch(/^Why is loan balance \S+ at Harbor\?$/);
    expect(c[0]!.label).toBe('Harbor by loan category');
  });
});

describe('hover', () => {
  const fmt = (v: unknown) => `${String(v)}%`;
  it('says the change from the month before', () => {
    const lines = tooltipLines(months, fmt, true)([{ dataIndex: 1, seriesIndex: 0, name: 'Sep 2026' }]);
    expect(lines).toBe('Sep 2026\n0.62% (up 0.12 pts from Aug 2026)\nClick for more');
  });
  it('says how many more or fewer for counts', () => {
    const people: ChartBlock = { ...months, data: { ...months.data, axes: { y: [{ title: 'Customers', unit: 'count' }] }, dataset: { ...months.data.dataset, source: [['Jun 2026', 29_777], ['Jul 2026', 29_789]] } } };
    expect(tooltipLines(people, String, false)([{ dataIndex: 1, seriesIndex: 0, name: 'Jul 2026' }])).toBe('Jul 2026\n29789 (up 12 from Jun 2026)');
  });

  it('says the gap from the average across branches', () => {
    const bars: ChartBlock = { ...months, data: { ...months.data, chartType: 'bar', dataset: { dimensions: [{ name: 'x', displayName: 'Branch' }, { name: 'y' }], source: [['Harbor', 1], ['Midtown', 2], ['Bayview', 3]] } } };
    expect(tooltipLines(bars, fmt, false)([{ dataIndex: 2, seriesIndex: 0, name: 'Bayview' }])).toBe('Bayview\n3% (1.00 pts above the average)');
  });
});

describe('clicking a point', () => {
  it('opens the menu at the point and asks the choice in the conversation', async () => {
    const onAction = vi.fn();
    const host: BlockHost = { onAction };
    render(
      <TooltipProvider>
        <AnnouncerProvider>
          <BlockHostProvider value={host}>
            <BlockRenderer block={months} />
          </BlockHostProvider>
        </AnnouncerProvider>
      </TooltipProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'point' }));
    expect(await screen.findByText('Sep 2026: 0.62%')).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Why did it move in Sep 2026?' }));
    expect(onAction).toHaveBeenCalledWith(months, expect.objectContaining({ kind: 'ask_followup', params: { question: 'Why did delinquency 60+ change in Sep 2026?' } }));
  });

  it('offers nothing when the host cannot ask', async () => {
    render(
      <TooltipProvider>
        <AnnouncerProvider>
          <BlockHostProvider value={{}}>
            <BlockRenderer block={months} />
          </BlockHostProvider>
        </AnnouncerProvider>
      </TooltipProvider>,
    );
    await screen.findByRole('img');
    expect(screen.queryByRole('button', { name: 'point' })).toBeNull();
  });
});
