// @vitest-environment node
// Campaign attribution by account and by age, branch, segment or month; the loan hierarchy and
// application quality rates; profitability per member and attrition reasons across members.
import { describe, expect, it } from 'vitest';
import { CampaignService, PipelineService, PredictiveService, ProfitabilityService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { PIPELINE_FORECAST_REQUEST, PREDICTIVE_REQUEST, pipelineForecastModule, predictiveModule } from '../src/index.ts';

describe('routing the new questions', () => {
  it('reaches the right agents and tools', () => {
    for (const q of ['Show application quality by loan officer', 'Show the loan hierarchy', 'Direct vs indirect booked loans']) expect(PIPELINE_FORECAST_REQUEST.test(q), q).toBe(true);
    for (const q of ['Who are our least profitable members?', 'What are the root causes of attrition?']) expect(PREDICTIVE_REQUEST.test(q), q).toBe(true);
    const pool = {} as never;
    const lap = pipelineForecastModule({} as never);
    expect(lap.plan('Show application quality by product', {} as never)).toEqual({ tool: 'lap_quality', args: { by: 'product' } });
    expect(lap.plan('Show the loan hierarchy for indirect', {} as never)).toEqual({ tool: 'lap_hierarchy', args: { channel: 'Indirect' } });
    const pred = predictiveModule({} as never, 'member', { svc: {} as never, pool });
    expect(pred.plan('Who are our least profitable members?', {} as never)).toEqual({ tool: 'pred_profit', args: { show: 'bottom' } });
    expect(pred.plan('Why are members at risk? Show the root causes of attrition', {} as never)).toEqual({ tool: 'pred_root_causes', args: {} });
  });
});

const DB = 'dinext_t_test_cu';
const up = await warehouseAvailable(DB);
describe.skipIf(!up)('against the warehouse', () => {
  const pool = tenantPool(DB);
  it('lists a campaign’s accounts and breaks results down', async () => {
    const cmp = new CampaignService(pool);
    const c = await cmp.campaignNamed();
    const accts = await cmp.accounts(c.campaign_id, {});
    expect(accts.length).toBeGreaterThan(0);
    const byAge = await cmp.breakdown('age', { campaignId: c.campaign_id }, {});
    expect(byAge.reduce((s, r) => s + r.accounts, 0)).toBe(accts.length);
    expect(Math.round(byAge.reduce((s, r) => s + r.sharePct, 0))).toBeGreaterThanOrEqual(99);
  });

  it('drills booked loans and rates application quality', async () => {
    const lap = new PipelineService(pool);
    const top = await lap.hierarchy({}, {});
    expect(top.level).toBe('channel');
    const direct = await lap.hierarchy({ channel: 'Direct' }, {});
    expect(direct.level).toBe('region');
    expect(direct.total).toBeLessThanOrEqual(top.total);
    const q = await lap.quality('institution', { leads: true, details: true }, {}, 'product');
    expect(q.total.applications).toBeGreaterThan(0);
    expect(q.total.approvedPct).toBeGreaterThan(0);
  });

  it('scores profitability per member and rolls up attrition reasons', async () => {
    const m = await new ProfitabilityService(pool, 'credit_union').members();
    expect(m.length).toBeGreaterThan(1000);
    expect(m.some((x) => x.contribution < 0)).toBe(true);
    const r = await new PredictiveService(pool).rootCauses({});
    expect(r.highBand).toBeGreaterThan(0);
    expect(r.rows[0]!.high).toBeGreaterThan(0);
  });
});
