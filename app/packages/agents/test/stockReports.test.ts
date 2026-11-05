// @vitest-environment node
// Every stock report runs on the seeded warehouse with every section built: no "not defined" or
// failed sections, for both a credit union and a bank. No model calls are made.
import { describe, expect, it } from 'vitest';
import { validateBlock } from '@dinext/block-schemas';
import { SemanticService } from '@dinext/semantic';
import { stockReports, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { AlcoService } from '@dinext/di-core';
import { alcoAnalyses, boardAnalyses, combineAnalyses, runReport } from '../src/index.ts';

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
          const { canvas } = await runReport(def, {}, svc, { canViewSql: false, analyses: combineAnalyses(alcoAnalyses(new AlcoService(pool, type)), boardAnalyses(svc, pool, type)) }, { runId: 'R-stocktest', mode: 'read', status: 'stock', version: 1 });
          const broken = canvas.data.widgets.filter((w) => w.view.type === 'notice').map((w) => `${def.name} / ${w.title}: ${w.view.type === 'notice' ? w.view.data.message : ''}`);
          expect(broken).toEqual([]);
        }
      } finally {
        await pool.end();
      }
    });

    it('the ALCO pack leads with policy compliance and carries rate risk, liquidity, capital, funding and loans', async () => {
      const pool = tenantPool(schema);
      const svc = await SemanticService.create(pool, tenant, type);
      try {
        const def = stockReports(type).find((d) => d.templateId === 'alco_monthly_pack')!;
        const { canvas } = await runReport(def, {}, svc, { canViewSql: false, analyses: combineAnalyses(alcoAnalyses(new AlcoService(pool, type)), boardAnalyses(svc, pool, type)) }, { runId: `R-alco-${type}`, mode: 'read', status: 'stock', version: 2 });
        expect(validateBlock(canvas).ok).toBe(true);
        const titles = canvas.data.widgets.map((w) => w.title);
        expect(titles[0]).toBe('Policy compliance');
        expect(titles).toEqual(expect.arrayContaining(['Interest rate risk: NII and NEV under rate shocks', 'Liquidity: available funds and a deposit run', 'Capital', 'Funding: deposits and certificate maturities', 'Loans: mix, yields, growth and concentration']));
        const policy = canvas.data.widgets[0]!.view;
        expect(policy.type).toBe('table');
        if (type === 'bank') {
          // A CRE-heavy bank: NEV at +400 bp and commercial real estate concentration are outside policy, and the pack says so first.
          expect(canvas.data.take?.headline).toMatch(/^\d+ of \d+ policy limits are breached\. NEV at \+400 bp is −\d+\.\d% \(limit −30%\)/);
          expect(canvas.data.take?.headline).toMatch(/[Cc]ommercial real estate is \d+% of capital \(limit 300%\)/);
        } else {
          expect(canvas.data.take?.headline).toMatch(/^All \d+ policy limits are met/);
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
