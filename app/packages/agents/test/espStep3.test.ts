// @vitest-environment node
// ESP alignment, step 3: the org hierarchy. The tree agrees with each branch's region, and a roll-up at
// any unit adds up to the units under it.
import { describe, expect, it } from 'vitest';
import { PortfolioService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { portfolioModule } from '../src/index.ts';

describe('routing', () => {
  it('sends org questions to the roll-up', () => {
    const port = portfolioModule({} as never);
    expect(port.plan('Show the org hierarchy', {} as never)).toEqual({ tool: 'port_org', args: {} });
    expect(port.plan('Show the units under North', {} as never)).toEqual({ tool: 'port_org', args: { unit: 'North' } });
    expect(port.plan('Show our loan products', {} as never)).toEqual({ tool: 'port_products', args: { kind: 'loan' } });
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cdm_org_unit LIMIT 1').then(() => true, () => false));
  describe.skipIf(!up)(`${DB}: the org tree`, () => {
    const pool = tenantPool(DB);
    it('matches each branch’s region, and rolls up', async () => {
      const [[bad]] = (await pool.query("SELECT COUNT(*) AS n FROM cdm_location b LEFT JOIN cdm_org_unit u ON u.branch_id = b.int_id LEFT JOIN cdm_org_unit r ON r.unit_id = u.parent_id WHERE u.unit_id IS NULL OR r.name <> b.region OR r.level <> 'Region'")) as unknown as [{ n: number }[]];
      expect(Number(bad!.n)).toBe(0);
      const svc = new PortfolioService(pool);
      const top = (await svc.orgRollup())!;
      expect(top.level).toBe('Institution');
      expect(top.children.reduce((s, c) => s + c.branches, 0)).toBe(top.total.branches);
      expect(top.children.reduce((s, c) => s + c.deposits, 0)).toBeCloseTo(top.total.deposits, -2);
      const region = (await svc.orgRollup(top.children[0]!.name))!;
      expect(region.children.every((c) => c.level === 'Branch')).toBe(true);
      expect(region.total.people).toBe(top.children[0]!.people);
      const westport = (await svc.orgRollup(undefined, { purviewBranches: [region.children[0]!.name] }))!;
      expect(westport.total.branches).toBe(1);
    });
  });
}
