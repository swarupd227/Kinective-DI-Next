// @vitest-environment node
// ESP alignment, step 2: loan and share products. Every account has exactly one product of its own
// category, product totals tie to the book, and the 5300 keeps its current mapping.
import { describe, expect, it } from 'vitest';
import { CallReportService, PortfolioService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { PORTFOLIO_REQUEST, callReportModule, portfolioModule } from '../src/index.ts';

describe('routing', () => {
  it('sends product questions to the right tools', () => {
    expect(PORTFOLIO_REQUEST.test('Show our loan products')).toBe(true);
    const port = portfolioModule({} as never);
    expect(port.plan('Show our loan products', {} as never)).toEqual({ tool: 'port_products', args: { kind: 'loan' } });
    expect(port.plan('What products do we offer for savings?', {} as never)).toEqual({ tool: 'port_products', args: { kind: 'deposit' } });
    expect(port.plan('Show member growth', {} as never)).toEqual({ tool: 'portfolio_report', args: { question: 'members' } });
    expect(callReportModule({} as never).plan('Show the 5300 loan lines by product', {} as never)).toEqual({ tool: 'cr_product_lines', args: {} });
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cdm_account_product LIMIT 1').then(() => true, () => false));
  describe.skipIf(!up)(`${DB}: products`, () => {
    const pool = tenantPool(DB);
    const one = async <T>(sql: string) => ((await pool.query(sql)) as unknown as [T[]])[0][0]!;

    it('gives every account one product of its own category', async () => {
      const bad = await one<{ n: number }>("SELECT (SELECT COUNT(*) FROM cdm_loan l LEFT JOIN cdm_account_product ap ON ap.account_kind = 'loan' AND ap.account_id = l.loan_id LEFT JOIN cdm_loan_product p ON p.product_id = ap.product_id WHERE p.product_id IS NULL OR p.loan_category <> l.loan_category) + (SELECT COUNT(*) FROM cdm_deposit_account d LEFT JOIN cdm_account_product ap ON ap.account_kind = 'deposit' AND ap.account_id = d.account_id LEFT JOIN cdm_deposit_product p ON p.product_id = ap.product_id WHERE p.product_id IS NULL OR p.deposit_category <> d.deposit_category) AS n");
      expect(Number(bad.n)).toBe(0);
    });

    it('puts each mortgage on the product that matches its term', async () => {
      const bad = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_account_product ap ON ap.account_kind = 'loan' AND ap.account_id = l.loan_id WHERE l.loan_category = 'Mortgage' AND l.term_months IS NOT NULL AND ap.product_id <> IF(l.term_months <= 180, 'MTG-15', 'MTG-30')");
      expect(Number(bad.n)).toBe(0);
    });

    it('ties product totals to the book', async () => {
      const svc = new PortfolioService(pool);
      const loans = (await svc.products('loan'))!;
      const book = await one<{ b: number }>('SELECT SUM(balance) AS b FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL AND balance > 0');
      expect(Math.abs(loans.reduce((s, r) => s + r.balance, 0) - Number(book.b))).toBeLessThan(loans.length);
      const deps = (await svc.products('deposit'))!;
      const dbook = await one<{ b: number }>('SELECT SUM(balance) AS b FROM cdm_deposit_account WHERE close_date IS NULL');
      expect(Math.abs(deps.reduce((s, r) => s + r.balance, 0) - Number(dbook.b))).toBeLessThan(deps.length);
    });

    it('shows the 5300 by product without changing the 5300', async () => {
      const cr = new CallReportService(pool);
      const before = DB.endsWith('cu') ? (await cr.lines()).find((l) => l.code === '370')?.current : null;
      const lines = await cr.productLines();
      if (DB.endsWith('cu')) {
        expect(lines!.map((l) => l.code)).toEqual(expect.arrayContaining(['385', '370', '703A']));
        expect((await cr.lines()).find((l) => l.code === '370')?.current).toBe(before);
      } else expect(lines ?? []).toHaveLength(0);
    });
  });
}
