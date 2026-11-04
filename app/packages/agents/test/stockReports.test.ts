// @vitest-environment node
// Every stock report runs on the seeded warehouse with every section built: no "not defined" or
// failed sections, for both a credit union and a bank. No model calls are made.
import { describe, expect, it } from 'vitest';
import { SemanticService } from '@dinext/semantic';
import { stockReports, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { runReport } from '../src/index.ts';

describe('the named reports', () => {
  it('include the ones today’s DI shows on its Dashboards home', () => {
    expect(stockReports('credit_union').map((r) => r.name)).toEqual(expect.arrayContaining(['Checking growth', 'Lending – Auto loans', 'Lending – Loan delinquency', 'Loan app reports', 'Growth report – My branch', 'Lending portfolio', 'Board report', 'Executive dashboard']));
  });
});

for (const [schema, tenant, type] of [['dinext_t_test_cu', 'test_cu', 'credit_union'], ['dinext_t_test_bank', 'test_bank', 'bank']] as const) {
  const up = await warehouseAvailable(schema);
  describe.skipIf(!up)(`stock reports for ${type}`, () => {
    it('build every section', async () => {
      const pool = tenantPool(schema);
      const svc = await SemanticService.create(pool, tenant, type);
      try {
        for (const def of stockReports(type)) {
          const { canvas } = await runReport(def, {}, svc, { canViewSql: false }, { runId: 'R-stocktest', mode: 'read', status: 'stock', version: 1 });
          const broken = canvas.data.widgets.filter((w) => w.view.type === 'notice').map((w) => `${def.name} / ${w.title}: ${w.view.type === 'notice' ? w.view.data.message : ''}`);
          expect(broken).toEqual([]);
        }
      } finally {
        await pool.end();
      }
    });

    it('limits a section to its filter: auto loans are part of all loans', async () => {
      const pool = tenantPool(schema);
      const svc = await SemanticService.create(pool, tenant, type);
      try {
        const def = stockReports(type).find((d) => d.templateId === 'lending_auto_loans_monthly')!;
        const { canvas } = await runReport(def, {}, svc, { canViewSql: false }, { runId: 'R-stocktest', mode: 'read', status: 'stock', version: 1 });
        const auto = canvas.data.widgets[0]!.view;
        const all = await svc.query({ metrics: ['loan_balance'], time: { grain: 'month', from: svc.build.latestMonthEnd.slice(0, 7), to: svc.build.latestMonthEnd.slice(0, 7) } }, { canViewSql: false });
        expect(auto.type === 'kpi' && auto.data.value).toBeGreaterThan(0);
        expect(auto.type === 'kpi' && auto.data.value).toBeLessThan(all.rows[0]!.loan_balance as number);
      } finally {
        await pool.end();
      }
    });
  });
}
