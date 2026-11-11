// @vitest-environment node
// Every stock report runs on the seeded warehouse with every section built: no "not defined" or
// failed sections, for both a credit union and a bank. No model calls are made.
import { describe, expect, it } from 'vitest';
import { validateBlock } from '@dinext/block-schemas';
import { SemanticService } from '@dinext/semantic';
import { stockReports, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { PortfolioService, AlcoService, BranchScorecardService, BsaService, CapitalPlanService, ConcentrationService, GoalsService, LendingProductionService, OpRiskService, ProfitabilityService } from '@dinext/di-core';
import { portfolioAnalyses, alcoAnalyses, boardAnalyses, branchAnalyses, baselAnalyses, bsaAnalyses, camelsAnalyses, capitalPlanAnalyses, combineAnalyses, concentrationAnalyses, lendingAnalyses, opRiskAnalyses, profitAnalyses, runReport } from '../src/index.ts';

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
          const { canvas } = await runReport(def, {}, svc, { canViewSql: false, analyses: combineAnalyses(portfolioAnalyses(new PortfolioService(pool), type === 'bank' ? 'customer' : 'member'), alcoAnalyses(new AlcoService(pool, type)), profitAnalyses(new ProfitabilityService(pool, type)), camelsAnalyses({ pool, institutionType: type, semantic: async () => svc }), baselAnalyses({ pool, institutionType: type }), boardAnalyses(svc, pool, type), branchAnalyses(new BranchScorecardService(pool), new GoalsService(pool), type === 'bank' ? 'customers' : 'members'), lendingAnalyses(new LendingProductionService(pool), new GoalsService(pool)), type === 'bank' ? concentrationAnalyses(new ConcentrationService(pool)) : null, type === 'bank' ? bsaAnalyses(new BsaService(pool)) : null, type === 'bank' ? opRiskAnalyses(new OpRiskService(pool)) : null, type === 'bank' ? capitalPlanAnalyses(new CapitalPlanService(pool)) : null) }, { runId: 'R-stocktest', mode: 'read', status: 'stock', version: 1 });
          const broken = canvas.data.widgets.filter((w) => w.view.type === 'notice').map((w) => `${def.name} / ${w.title}: ${w.view.type === 'notice' ? w.view.data.message : ''}`);
          expect(broken).toEqual([]);
          // The whole report must pass the block schema, or the page shows "failed validation".
          const v = validateBlock(canvas);
          expect(v.ok ? [] : v.issues.map((i) => `${def.name}: ${i}`)).toEqual([]);
        }
      } finally {
        await pool.end();
      }
    }, 30_000);

    it('the ALCO pack leads with policy compliance and carries rate risk, liquidity, capital, funding and loans', async () => {
      const pool = tenantPool(schema);
      const svc = await SemanticService.create(pool, tenant, type);
      try {
        const def = stockReports(type).find((d) => d.templateId === 'alco_monthly_pack')!;
        const { canvas } = await runReport(def, {}, svc, { canViewSql: false, analyses: combineAnalyses(portfolioAnalyses(new PortfolioService(pool), type === 'bank' ? 'customer' : 'member'), alcoAnalyses(new AlcoService(pool, type)), profitAnalyses(new ProfitabilityService(pool, type)), camelsAnalyses({ pool, institutionType: type, semantic: async () => svc }), baselAnalyses({ pool, institutionType: type }), boardAnalyses(svc, pool, type), branchAnalyses(new BranchScorecardService(pool), new GoalsService(pool), type === 'bank' ? 'customers' : 'members'), lendingAnalyses(new LendingProductionService(pool), new GoalsService(pool))) }, { runId: `R-alco-${type}`, mode: 'read', status: 'stock', version: 2 });
        expect(validateBlock(canvas)).toMatchObject({ ok: true });
        const titles = canvas.data.widgets.map((w) => w.title);
        expect(titles[0]).toBe('Policy compliance');
        expect(titles).toEqual(expect.arrayContaining([type === 'bank' ? 'Interest rate risk: NII and EVE under rate shocks' : 'Interest rate risk: NII and NEV under rate shocks', ...(type === 'bank' ? ['Net interest income over two years: rates moving at once or over a year'] : []), 'Liquidity: available funds and a deposit run', 'Capital', 'Funding: deposits and certificate maturities', 'Loans: mix, yields, growth and concentration']));
        const policy = canvas.data.widgets[0]!.view;
        expect(policy.type).toBe('table');
        if (type === 'bank') {
          // With capital from the Call Report, the bank's one breach is EVE at +400 bp against that shock's limit, and the pack says so first.
          expect(canvas.data.take?.headline).toMatch(/^1 of \d+ policy limits is breached\. EVE at \+400 bp is −\d+\.\d% \(limit −35%\)/);
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
