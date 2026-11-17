import { describe, expect, it } from 'vitest';
import { categoryLabels } from '../src/chart/buildOption.ts';

const BRANCHES = ['Westport', 'Northgate', 'Riverside', 'Lakeshore', 'Downtown', 'Eastgate'];

describe('x-axis labels for the room the chart has', () => {
  it('keeps the desktop layout where there is room: every label, wrapped at 96 px', () => {
    expect(categoryLabels(6, 1000, BRANCHES)).toEqual({ interval: 0, width: 96, overflow: 'break', hideOverlap: true });
    expect(categoryLabels(6)).toMatchObject({ interval: 0, width: 96 });
  });

  it('on a phone, keeps short labels level, each within its share of the width', () => {
    const labels = categoryLabels(4, 340, ['Auto', 'HELOC', 'Credit Card', 'Business']);
    expect(labels).toMatchObject({ interval: 0, overflow: 'break', fontSize: 11 });
    expect(labels).not.toHaveProperty('rotate');
    expect((labels as { width: number }).width * 4).toBeLessThanOrEqual(340 - 64);
  });

  it('tilts names too long for their share, rather than cutting a word in two or overlapping', () => {
    expect(categoryLabels(6, 320, BRANCHES)).toEqual({ interval: 0, rotate: 40, width: 88, overflow: 'truncate', hideOverlap: true, fontSize: 11 });
  });

  it('lets ECharts thin a long series and hide any label that would collide', () => {
    expect(categoryLabels(24, 320, [])).toEqual({ hideOverlap: true, fontSize: 11 });
    expect(categoryLabels(24, 1000, [])).toEqual({ hideOverlap: true });
  });
});
