// @vitest-environment node
// A branch manager's Home: their branch against the CEO's six targets, and the operations items that
// each open the Branch Performance question explaining them.
import { describe, expect, it } from 'vitest';
import { blockSchema, type KpiGroupBlock } from '@dinext/block-schemas';
import { BRANCH_MEASURES, BranchKpiService } from '@dinext/di-core';
import { BRANCH_KPI_REQUEST, branchKpiPlan } from '@dinext/agents';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { branchHome, targetGap } from '../src/branchHome.ts';

describe('the gap to a target', () => {
  it('is measured from the floor for growth and from the ceiling for delinquency', () => {
    expect(targetGap('depositGrowthPct', 5.1)).toMatchObject({ value: -2.9, direction: 'down', goodWhen: 'up', label: 'vs target +8% to +12% a year' });
    expect(targetGap('newMembersPerMonth', 59.5)).toMatchObject({ value: 34.5, direction: 'up', goodWhen: 'up' });
    expect(targetGap('nps', 70)).toMatchObject({ value: 0, direction: 'flat' });
    expect(targetGap('nps', 58.06)).toMatchObject({ value: -12, direction: 'down' });
    expect(targetGap('productsPerMember', 2.6449)).toMatchObject({ value: -0.86 });
    expect(targetGap('dq30Pct', 1.27)).toMatchObject({ value: 0.52, direction: 'up', goodWhen: 'down', label: 'vs target under 0.75%' });
    expect(targetGap('dq30Pct', 0.5)).toMatchObject({ value: -0.25, direction: 'down', goodWhen: 'down' });
  });
});

const base: KpiGroupBlock = { id: 'blk_base000000000000', type: 'kpi_group', version: '1.0.0', provenance: { agent: 'Dashboard/Briefing', sources: [] }, freshness: { kind: 'none' }, data: { layout: 'row', items: [] } } as unknown as KpiGroupBlock;

const SCHEMA = 'dinext_t_test_cu';
const up = await warehouseAvailable(SCHEMA).then((ok) => ok && tenantPool(SCHEMA).query('SELECT 1 FROM bro_teller_day LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('a branch manager’s Home on the credit union', () => {
  it('shows Westport against the six targets and its operations, each opening its question', async () => {
    const pool = tenantPool(SCHEMA);
    try {
      const svc = new BranchKpiService(pool);
      const home = (await branchHome(svc, 'Westport', base))!;
      const targets = await svc.targets({ branches: ['Westport'] });
      const w = targets.lines[0]!;
      const met = w.scores.filter((s) => s.met).length;
      expect(home.title).toBe(`Westport: ${met} of 6 CEO targets met`);
      expect(home.kpis.data.items).toHaveLength(BRANCH_MEASURES.length);
      expect(home.kpis.id).not.toBe(base.id);
      expect(home.kpis.data.items[0]!.value).toBeCloseTo(w.depositGrowthPct, 2);
      expect(home.kpis.data.items[5]!.comparison!.goodWhen).toBe('down');
      expect(blockSchema.safeParse(home.kpis).success).toBe(true);
      expect(blockSchema.safeParse(home.ops).success).toBe(true);

      expect(home.ops.data.items.map((i) => i.id)).toEqual(['balancing', 'lobby', 'audit', 'people']);
      // Nothing about another branch reaches Westport's Home.
      expect(JSON.stringify(home)).not.toMatch(/Eastgate|Downtown|Northgate|Riverside|Lakeshore/);
      const tools: Record<string, string> = { balancing: 'bk_balancing', lobby: 'bk_lobby', audit: 'bk_audit', people: 'bk_people' };
      for (const item of home.ops.data.items) {
        const q = decodeURIComponent(item.link!.replace('/c/new?q=', ''));
        expect(BRANCH_KPI_REQUEST.test(q), q).toBe(true);
        expect(branchKpiPlan(q).tool, q).toBe(tools[item.id]);
      }
      const balancing = await svc.balancing({ branches: ['Westport'] });
      expect(home.ops.data.items[0]!.title).toBe(`Teller balancing: ${balancing.lines[0]!.balancedPct.toFixed(1)}% of drawers balanced`);

      expect(await branchHome(svc, 'Nowhere', base)).toBeNull();
    } finally {
      await pool.end();
    }
  });
});
