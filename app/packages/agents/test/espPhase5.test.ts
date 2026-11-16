// @vitest-environment node
// ESP phase 5: each login, and the services on each account, share and loan. The logins add up to the
// 90-day counts Member 360 already shows; the services follow the digital-use dates, the cards and the
// overdraft fees DI already has.
import { describe, expect, it } from 'vitest';
import { LoanServicesService, PortfolioService, RelationshipService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { portfolioModule } from '../src/portfolioReports.ts';
import { indirectModule } from '../src/growth.ts';
import { member360 } from '../src/member.ts';

describe('routing', () => {
  it('sends add-on and courtesy pay questions to port_services, and leaves fees, repricing gaps and dealers where they were', () => {
    const port = portfolioModule({} as PortfolioService, 'member', {} as LoanServicesService);
    const plan = (t: string) => port.plan(t, {} as never) as { tool?: string; args?: { kind?: string } };
    for (const [q, kind] of [
      ['What’s our GAP penetration on auto loans?', 'loan'],
      ['Which dealers sell the most add-ons on our loans?', 'loan'],
      ['How much debt protection did we sell this year?', 'loan'],
      ['Any signs of payment packing?', 'loan'],
      ['Show courtesy pay enrollment by branch', 'checking'],
      ['How many checking accounts are enrolled in overdraft privilege?', 'checking'],
    ] as const) {
      expect(port.request.test(q), q).toBe(true);
      expect(plan(q).tool, q).toBe('port_services');
      expect(plan(q).args?.kind, q).toBe(kind);
    }
    for (const q of ['Show overdraft fees by branch', 'What is our repricing gap?', 'Show the funding gap', 'How is Smith Ford doing?']) expect(port.request.test(q), q).toBe(false);
    const ind = indirectModule({} as never, ['Smith Ford'], () => '2026-10-25');
    expect(ind.request.test('Which dealers sell the most add-ons on our loans?')).toBe(false);
    expect(ind.request.test('Which dealers sold the most GAP coverage?')).toBe(false);
    expect(ind.request.test('Show the dealer scorecard')).toBe(true);
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cdm_login LIMIT 1').then(() => true, () => false));
  const type = DB.endsWith('bank') ? 'bank' : 'credit_union';
  describe.skipIf(!up)(`${DB}: phase 5`, () => {
    const pool = tenantPool(DB);
    const one = async (sql: string) => Number(((await pool.query(sql)) as unknown as [{ n: unknown }[]])[0][0]!.n ?? 0);
    const ctx = { user: { id: 'user:1', name: 'Test' }, modules: ['portfolio'], runId: 'r', threadId: 't' };

    it('adds the logins up to the 90-day counts, and ends each person’s on their last login', async () => {
      expect(await one('SELECT COUNT(*) AS n FROM cdm_party_activity a LEFT JOIN (SELECT party_id, COUNT(*) AS c, SUM(kind = \'Mobile\') AS m FROM cdm_login GROUP BY party_id) l ON l.party_id = a.party_id WHERE COALESCE(l.c, 0) <> a.logins_90d OR COALESCE(l.m, 0) <> a.mobile_logins_90d')).toBe(0);
      expect(await one('SELECT COUNT(*) AS n FROM (SELECT party_id, DATE(MAX(login_time)) AS d FROM cdm_login GROUP BY party_id) l JOIN cdm_digital_usage u ON u.party_id = l.party_id WHERE u.last_login IS NULL OR u.last_login <> l.d')).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM cdm_login WHERE login_time < DATE_SUB((SELECT MAX(as_of_date) FROM meta_build), INTERVAL 90 DAY) OR login_time > DATE_ADD((SELECT MAX(as_of_date) FROM meta_build), INTERVAL 1 DAY)")).toBe(0);
      // Documentation addresses only (RFC 5737): none is anyone's.
      expect(await one("SELECT COUNT(*) AS n FROM cdm_login WHERE ip_address NOT REGEXP '^(192\\\\.0\\\\.2|198\\\\.51\\\\.100|203\\\\.0\\\\.113)\\\\.'")).toBe(0);
    });

    it('puts the services where the digital-use dates, the cards and the overdraft fees say they are', async () => {
      // Online banking on every open account the person owns, from the day they signed up (or the account opened).
      expect(await one("SELECT COUNT(*) AS n FROM cdm_account a JOIN cdm_digital_usage u ON u.party_id = a.primary_party_id WHERE a.close_date IS NULL AND u.online_banking_since IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cdm_account_service s JOIN cdm_service_type t ON t.service_id = s.service_id WHERE s.account_number = a.account_number AND t.code = 'OLB' AND s.added = GREATEST(u.online_banking_since, a.open_date))")).toBe(0);
      // E-statements as each account records them.
      expect(await one("SELECT COUNT(*) AS n FROM cdm_account a WHERE a.close_date IS NULL AND a.estatements <> EXISTS (SELECT 1 FROM cdm_account_service s JOIN cdm_service_type t ON t.service_id = s.service_id WHERE s.account_number = a.account_number AND t.code = 'ESTMT')")).toBe(0);
      // Active direct deposit for exactly the people cdm_digital_usage says have it.
      expect(await one("SELECT COUNT(*) AS n FROM cdm_digital_usage u WHERE (u.direct_deposit_status = 'active') <> EXISTS (SELECT 1 FROM cdm_deposit_service s JOIN cdm_service_type t ON t.service_id = s.service_id JOIN cdm_deposit_account d ON d.account_id = s.account_id WHERE d.party_id = u.party_id AND t.code = 'DD' AND s.removed IS NULL)")).toBe(0);
      // A debit card service for each debit card.
      expect(await one("SELECT (SELECT COUNT(*) FROM cdm_card WHERE kind = 'Debit') - (SELECT COUNT(*) FROM cdm_deposit_service s JOIN cdm_service_type t ON t.service_id = s.service_id WHERE t.code = 'DEBIT') AS n")).toBe(0);
      // Everyone charged an overdraft fee has courtesy pay.
      expect(await one("SELECT COUNT(DISTINCT x.account_id) AS n FROM cdm_share_transaction x WHERE x.code = 'FEE-OD' AND NOT EXISTS (SELECT 1 FROM cdm_deposit_service s JOIN cdm_service_type t ON t.service_id = s.service_id WHERE s.account_id = x.account_id AND t.code = 'CPAY' AND s.removed IS NULL)")).toBe(0);
      // Add-ons only on loans whose product allows them.
      expect(await one('SELECT COUNT(*) AS n FROM cdm_loan_service s JOIN cdm_account_product ap ON ap.account_kind = \'loan\' AND ap.account_id = s.loan_id LEFT JOIN cdm_product_service ps ON ps.product_id = ap.product_id AND ps.service_id = s.service_id WHERE ps.product_id IS NULL')).toBe(0);
    });

    it('finds the dealer selling add-ons on far more loans, and the branch selling GAP on far fewer', async () => {
      const x = (await new LoanServicesService(pool).addOns(12))!;
      expect(x.directAuto.gapPct).toBeGreaterThan(20);
      expect(x.indirectAuto.gapPct).toBeGreaterThan(x.directAuto.gapPct);
      expect(x.packing.length).toBe(1);
      expect(x.lowGap.length).toBe(1);
      const tool = portfolioModule({} as PortfolioService, type === 'bank' ? 'customer' : 'member', new LoanServicesService(pool)).tools.find((t) => t.name === 'port_services')!;
      const loan = (await tool.run({ kind: 'loan' } as never, ctx as never)) as { text: string };
      expect(loan.text).toMatch(/payment-packing review/);
      expect(loan.text).toMatch(/compliance officer’s call/);
      const checking = (await tool.run({ kind: 'checking' } as never, ctx as never)) as { text: string };
      expect(checking.text).toMatch(type === 'bank' ? /have overdraft privilege/ : /have courtesy pay/);
      expect(checking.text).toMatch(/all of them enrolled/);
    });

    it('shows each account’s services and the latest logins on Member 360', async () => {
      const who = await one("SELECT d.party_id AS n FROM cdm_deposit_service s JOIN cdm_deposit_account d ON d.account_id = s.account_id JOIN cdm_party_activity a ON a.party_id = d.party_id WHERE s.removed IS NULL AND d.close_date IS NULL AND a.logins_90d >= 3 ORDER BY d.party_id LIMIT 1");
      const p = await new RelationshipService(pool, DB.replace('dinext_t_', ''), type).profile(who, {});
      expect(p.deposits.some((d) => d.services?.length)).toBe(true);
      expect(p.logins.length).toBe(3 <= p.usage!.logins90d ? Math.min(5, p.usage!.logins90d) : p.logins.length);
      const facts = (member360(p, 'r').data.sections.find((s) => s.kind === 'engagement') as { facts: { label: string; value: string }[] }).facts;
      expect(facts.find((f) => f.label === 'Last digital login')!.value).toMatch(/\((?:mobile|online)\); before that /);
      expect(facts.length).toBeLessThanOrEqual(8);
    });
  });
}
