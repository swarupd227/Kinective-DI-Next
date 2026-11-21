// @vitest-environment node
// Two years of history (DI parity): annual report periods over complete calendar years, the Annual
// review stock report, and monthly rescoring of the models in use.
import { describe, expect, it } from 'vitest';
import { AttritionModelService } from '@dinext/di-core';
import { monthEnds, stockReports, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { parsePeriod, periodOptions, timeFor } from '../src/report.ts';
import { parseSettingsRequest } from '../src/reportSettings.ts';

describe('annual periods', () => {
  it('keeps two years of month-ends, so a whole calendar year is on file', () => {
    const ends = monthEnds();
    expect(ends).toHaveLength(24);
    expect(ends.filter((m) => m.startsWith('2025'))).toHaveLength(12);
  });

  it('offers the complete years in history, and reads a year as January to December', () => {
    expect(periodOptions('year', '2026-09-30')).toEqual([{ value: '2025', label: '2025' }]);
    // A December build makes its own year complete.
    expect(periodOptions('year', '2026-12-31').map((o) => o.value)).toEqual(['2026', '2025']);
    expect(timeFor('year', '2025')).toEqual({ grain: 'year', from: '2025-01', to: '2025-12' });
    // History begins in October 2024, so 2025 isn't compared with a part of 2024; 2026 will be compared with 2025.
    expect(timeFor('year', '2025', 2)).toEqual({ grain: 'year', from: '2025-01', to: '2025-12' });
    expect(timeFor('year', '2026', 2)).toEqual({ grain: 'year', from: '2025-01', to: '2026-12' });
    // A trend in an annual report runs month by month through the year.
    expect(timeFor('year', '2025', 12)).toEqual({ grain: 'month', from: '2025-01', to: '2025-12' });
    expect(parsePeriod('Show the annual review for 2025', 'year', '2026-09-30')).toBe('2025');
    expect(parsePeriod('last year', 'year', '2026-09-30')).toBe('2025');
    expect(parsePeriod('2024', 'year', '2026-09-30')).toBeUndefined();
  });

  it('makes a report annual, and ships an Annual review', () => {
    expect(parseSettingsRequest('Make it annual')).toMatchObject({ intent: 'settings', set: { period_type: 'year' } });
    expect(parseSettingsRequest('Make the branch scorecard yearly')).toMatchObject({ intent: 'settings', set: { period_type: 'year' } });
    const annual = stockReports('credit_union').find((r) => r.templateId === 'annual_review')!;
    expect(annual.settings).toMatchObject({ periodType: 'year' });
    expect(annual.settings.allowedPeriodTypes).toContain('year');
  });
});

const DB = 'dinext_t_test_cu';
const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query("SELECT 1 FROM ml_model WHERE name = 'attrition' AND status = 'Active' LIMIT 1").then(([r]) => (r as unknown[]).length > 0, () => false));
describe.skipIf(!up)('monthly rescoring', () => {
  const pool = tenantPool(DB);
  it('records each scoring run, and rescores only when a month-end is new', async () => {
    const svc = new AttritionModelService(pool);
    const m = (await svc.active())!;
    const before = (await svc.scoreRuns()).length;
    const r = await svc.score(m.modelId, 'Monthly rescoring');
    const runs = await svc.scoreRuns();
    expect(runs.length).toBe(before + 1);
    expect(runs[0]).toMatchObject({ version: m.version, monthEnd: r.months.at(-1), scored: r.scored, reason: 'Monthly rescoring' });
    // Scored for the latest month-end already: nothing to do.
    expect(await svc.rescoreIfDue()).toBeNull();
  }, 180_000);
});
