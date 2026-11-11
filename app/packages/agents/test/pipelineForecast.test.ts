// @vitest-environment node
// Pipeline Forecast: projected closings weighted by stage, approvals waiting to close, and credit tiers.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { PipelineService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { PIPELINE_FORECAST_REQUEST, pipelineForecastModule } from '../src/index.ts';

describe('pipeline forecast questions', () => {
  it('are recognized, and leave stalled applications to the pipeline agent', () => {
    for (const q of ['Forecast the loan pipeline: what will fund by month?', 'What will close in the next 30 days?', 'Show projected closings', 'Show applications by credit tier', 'Which loans are approved but not yet funded?']) expect(PIPELINE_FORECAST_REQUEST.test(q), q).toBe(true);
    expect(PIPELINE_FORECAST_REQUEST.test('Show my stalled applications')).toBe(false);
    const spec = pipelineForecastModule({} as PipelineService);
    expect(spec.plan('Show applications by credit tier', {} as never)).toEqual({ tool: 'lap_credit_tiers', args: {} });
    expect(spec.plan('What will close in the next 30 days?', {} as never)).toEqual({ tool: 'lap_forecast', args: {} });
  });
});

const up = await warehouseAvailable('dinext_t_test_cu').then((ok) => ok && tenantPool('dinext_t_test_cu').query('SELECT expected_close FROM cdm_loan_application LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('the credit union’s pipeline forecast', () => {
  it('weights closings by stage, lists approvals waiting to close, and approves better credit more often', async () => {
    const pool = tenantPool('dinext_t_test_cu');
    try {
      const svc = new PipelineService(pool);
      const who = { details: true };
      const f = await svc.forecast('institution', who, {});
      const [d30, , d90] = f.windows;
      expect(d90!.count).toBeGreaterThanOrEqual(d30!.count);
      expect(d30!.expectedDollars).toBeLessThan(d30!.dollars);
      expect(f.scheduled.length).toBeGreaterThan(0);
      expect(f.scheduled.every((a) => a.expectedClose! > f.asOf && !a.funded)).toBe(true);
      const t = await svc.creditTiers('institution', who, {});
      const [a, , , d] = t.tiers;
      expect(a!.approvalPct!).toBeGreaterThan(d!.approvalPct ?? 0);
      // A branch sees only its own.
      const westport = await svc.forecast('location', who, { purviewBranches: ['Westport'] });
      expect(westport.windows[2]!.count).toBeLessThan(d90!.count);

      const spec = pipelineForecastModule(svc);
      const ctx = { user: { id: 'u', name: 'Dana Lee' }, modules: ['lapforecast'], runId: 'r', threadId: 't' };
      for (const tool of spec.tools) {
        const out = (await tool.run({} as never, ctx)) as { text: string; blocks: unknown[] };
        expect(out.text, tool.name).toMatch(/the institution/);
        for (const b of out.blocks) expect(blockSchema.safeParse(b).success, tool.name).toBe(true);
      }
    } finally {
      await pool.end();
    }
  });
});
