// @vitest-environment node
// ESP alignment, phase 1: accounts, what sits under each, households, customer details and addresses,
// loan and share terms. The numbers agree with what DI already shows (member number, last four digits),
// every loan and share sits under exactly one account, and the terms agree with the loan itself (a late
// loan's due date is its days delinquent ago; a line's limit covers its balance).
import { describe, expect, it } from 'vitest';
import { AS_OF, holdingNumberOf, memberNumberOf, tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { blockSchema } from '@dinext/block-schemas';
import { memberNumber, RelationshipService } from '@dinext/di-core';
import { SemanticService } from '@dinext/semantic';
import { member360 } from '../src/index.ts';
import { termsDetail } from '../src/member.ts';

describe('numbers', () => {
  it('match what DI shows: the member number, and the last four digits of each loan and share', () => {
    for (const id of [1, 7, 4_521, 31_817]) expect(memberNumberOf(id)).toBe(memberNumber(id));
    expect(holdingNumberOf('loan', 3, 12_345).slice(-4)).toBe(String(12_345 % 10_000).padStart(4, '0'));
    expect(holdingNumberOf('deposit', 1, 7).slice(-4)).toBe('0007');
    expect(holdingNumberOf('loan', 3, 12_345)).not.toBe(holdingNumberOf('deposit', 3, 12_345));
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cdm_account_holding LIMIT 1').then(() => true, () => false));
  describe.skipIf(!up)(`${DB}: phase 1`, () => {
    const pool = tenantPool(DB);
    const n = async (sql: string) => Number(((await pool.query(sql)) as unknown as [{ n: number }[]])[0][0]!.n);

    it('puts every loan and share under exactly one account, numbered as DI shows it', async () => {
      expect(await n("SELECT COUNT(*) AS n FROM cdm_loan l LEFT JOIN cdm_account_holding h ON h.account_kind = 'loan' AND h.account_id = l.loan_id WHERE h.account_number IS NULL")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_deposit_account d LEFT JOIN cdm_account_holding h ON h.account_kind = 'deposit' AND h.account_id = d.account_id WHERE h.account_number IS NULL")).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM cdm_account_holding h LEFT JOIN cdm_account a ON a.account_number = h.account_number WHERE a.account_number IS NULL')).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_account_holding WHERE RIGHT(holding_number, 4) <> LPAD(MOD(account_id, 10000), 4, '0')")).toBe(0);
      // A holding's account belongs to the person who owns it as primary.
      expect(await n("SELECT COUNT(*) AS n FROM cdm_account_holding h JOIN cdm_account a ON a.account_number = h.account_number JOIN cdm_loan l ON h.account_kind = 'loan' AND l.loan_id = h.account_id WHERE a.primary_party_id <> l.party_id")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_account_holding h JOIN cdm_account a ON a.account_number = h.account_number JOIN cdm_deposit_account d ON h.account_kind = 'deposit' AND d.account_id = h.account_id WHERE a.primary_party_id <> d.party_id")).toBe(0);
      // Suffixes are unique within an account.
      expect(await n('SELECT COUNT(*) AS n FROM (SELECT account_number, suffix FROM cdm_account_holding GROUP BY account_number, suffix HAVING COUNT(*) > 1) x')).toBe(0);
    });

    it('gives every member their own account under their member number, and business accounts their commercial loans', async () => {
      expect(await n("SELECT COUNT(*) AS n FROM cdm_party p LEFT JOIN cdm_account a ON a.primary_party_id = p.party_id AND a.account_type IN ('Individual', 'Joint') WHERE p.is_member = 1 AND a.account_number IS NULL")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_account WHERE account_type IN ('Individual', 'Joint') AND CAST(account_number AS UNSIGNED) <> 10004520 + primary_party_id")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_account_holding h ON h.account_kind = 'loan' AND h.account_id = l.loan_id JOIN cdm_account a ON a.account_number = h.account_number WHERE l.loan_category IN ('Commercial Real Estate', 'Commercial & Industrial', 'Business') AND a.account_type <> 'Business'")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_account WHERE account_type = 'Joint'")).toBeGreaterThan(0);
    });

    it('covers every person with details and an address, and every household', async () => {
      expect(await n('SELECT COUNT(*) AS n FROM cdm_party p LEFT JOIN cdm_party_detail d ON d.party_id = p.party_id LEFT JOIN cdm_party_address a ON a.party_id = p.party_id WHERE d.party_id IS NULL OR a.party_id IS NULL')).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM cdm_party_detail WHERE CAST(member_number AS UNSIGNED) <> 10004520 + party_id')).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM (SELECT p.household_id, COUNT(*) AS c FROM cdm_party p GROUP BY p.household_id) x LEFT JOIN cdm_household h ON h.household_id = x.household_id WHERE h.household_id IS NULL OR h.members <> x.c')).toBe(0);
      // The deceased are older people, and few.
      expect(await n(`SELECT COUNT(*) AS n FROM cdm_party_detail d JOIN cdm_party p ON p.party_id = d.party_id WHERE d.deceased_date IS NOT NULL AND TIMESTAMPDIFF(YEAR, p.birth_date, '${AS_OF}') < 70`)).toBe(0);
      const people = await n('SELECT COUNT(*) AS n FROM cdm_party');
      const deceased = await n('SELECT COUNT(*) AS n FROM cdm_party_detail WHERE deceased_date IS NOT NULL');
      // The bank's demo customers are all under 63, so only the credit union has any.
      if (DB.endsWith('cu')) expect(deceased).toBeGreaterThan(0);
      expect(deceased / people).toBeLessThan(0.01);
    });

    it('keeps loan terms consistent with the loan', async () => {
      expect(await n('SELECT COUNT(*) AS n FROM cdm_loan l LEFT JOIN cdm_loan_terms t ON t.loan_id = l.loan_id WHERE t.loan_id IS NULL')).toBe(0);
      // A late loan is due from the payment it missed; a current one is due after today.
      expect(await n(`SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_loan_terms t ON t.loan_id = l.loan_id WHERE l.close_date IS NULL AND l.charge_off_date IS NULL AND l.days_delinquent > 0 AND t.payment_due_date <> DATE_SUB('${AS_OF}', INTERVAL l.days_delinquent DAY)`)).toBe(0);
      expect(await n(`SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_loan_terms t ON t.loan_id = l.loan_id WHERE l.days_delinquent = 0 AND t.payment_due_date <= '${AS_OF}'`)).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_loan_terms t ON t.loan_id = l.loan_id WHERE (l.close_date IS NOT NULL OR l.charge_off_date IS NOT NULL) AND (t.payment_amount <> 0 OR t.payment_due_date IS NOT NULL)')).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_loan_terms t ON t.loan_id = l.loan_id WHERE l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0 AND t.payment_amount <= 0')).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_loan_terms t ON t.loan_id = l.loan_id WHERE t.structure = 'Line' AND (t.credit_limit < l.balance OR MOD(t.credit_limit, 500) <> 0)")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_loan_terms t ON t.loan_id = l.loan_id WHERE l.loan_category IN ('Credit Card', 'HELOC') AND t.structure <> 'Line'")).toBe(0);
    });

    it('shows the details on Member 360: where they live, language, household, payments, and who has died or opted out', async () => {
      const svc = new RelationshipService(pool, DB.replace('dinext_t_', ''), DB.endsWith('bank') ? 'bank' : 'credit_union');
      const pickOne = async (sql: string) => Number(((await pool.query(sql)) as unknown as [{ id: number }[]])[0][0]?.id ?? 0);
      const borrower = await pickOne('SELECT l.party_id AS id FROM cdm_loan l JOIN cdm_loan_terms t ON t.loan_id = l.loan_id WHERE l.close_date IS NULL AND l.charge_off_date IS NULL AND l.balance > 0 AND l.days_delinquent = 0 ORDER BY l.loan_id LIMIT 1');
      const p = await svc.profile(borrower, {});
      expect(p.details?.place).toMatch(/^[A-Za-z .]+, [A-Z]{2} \d{5}$/);
      const current = p.loans.find((l) => !l.daysPastDue && l.terms)!;
      expect(termsDetail(current)).toMatch(/^(Limit \$[\d,]+; )?\$[\d,]+\.\d{2} due [A-Z][a-z]{2} \d{1,2}$/);
      const block = member360(p, 'r');
      expect(blockSchema.safeParse(block).success).toBe(true);
      const contact = block.data.sections.find((s) => s.kind === 'contact') as Extract<(typeof block.data.sections)[number], { kind: 'contact' }>;
      expect(contact.place).toBe(p.details!.place);
      expect(contact.language).toBe(p.details!.language);
      const household = block.data.sections.find((s) => s.kind === 'household') as Extract<(typeof block.data.sections)[number], { kind: 'household' }>;
      expect(household.name).toMatch(/ household$/);
      // The street never leaves the warehouse.
      expect(JSON.stringify(block)).not.toMatch(/\d+ [A-Z][a-z]+ (St|Ave|Rd|Dr|Ln|Way|Ct|Pl|Blvd|Ter)\b/);
      const optedOut = await pickOne('SELECT party_id AS id FROM cdm_party_detail WHERE marketing_opt_out = 1 ORDER BY party_id LIMIT 1');
      expect(member360(await svc.profile(optedOut, {}), 'r').data.badges.map((b) => b.label)).toContain('No marketing');
      if (DB.endsWith('cu')) {
        const deceased = await pickOne('SELECT party_id AS id FROM cdm_party_detail WHERE deceased_date IS NOT NULL ORDER BY party_id LIMIT 1');
        expect(member360(await svc.profile(deceased, {}), 'r').data.badges.map((b) => b.label)).toContain('Deceased');
      }
    });

    it('answers the new questions, and they tie to the figures DI already shows', async () => {
      const svc = await SemanticService.create(pool, DB.replace('dinext_t_', ''), DB.endsWith('bank') ? 'bank' : 'credit_union');
      const one = async (metric: string) => Number((await svc.query({ metrics: [metric] }, { canViewSql: true })).rows[0]![metric]);
      for (const m of ['household_count', 'products_per_household', 'average_household_deposits', 'account_count', 'scheduled_loan_payments', 'credit_line_limits', 'unused_commitments', 'line_utilization', 'variable_rate_share', 'marketing_opt_out_rate']) expect(await one(m), m).toBeGreaterThan(0);
      const deposits = await one('deposit_balance');
      const loans = await one('loan_balance');
      expect(await one('account_deposit_balance')).toBeCloseTo(deposits, 0);
      expect(await one('account_loan_balance')).toBeCloseTo(loans, 0);
      expect((await one('average_household_deposits')) * (await one('household_count'))).toBeCloseTo(deposits, -1);
      const byRate = await svc.query({ metrics: ['loan_balance'], dimensions: ['rate_type'] }, { canViewSql: true });
      expect(byRate.rows.reduce((t, r) => t + Number(r.loan_balance), 0)).toBeCloseTo(loans, 0);
      const byLanguage = await svc.query({ metrics: ['member_count'], dimensions: ['language'] }, { canViewSql: true });
      expect(byLanguage.rows.reduce((t, r) => t + Number(r.member_count), 0)).toBe(await one('member_count'));
      expect(await one('line_utilization')).toBeLessThanOrEqual(100);
      // Existing questions still read the tables they did: no new join.
      const plain = await svc.query({ metrics: ['loan_balance', 'deposit_balance', 'member_count'], dimensions: ['branch'] }, { canViewSql: true });
      expect(plain.lineage.flatMap((l) => l.tables).filter((t) => /terms|detail|address|household|cdm_account$/.test(t))).toEqual([]);
    });

    it('fills phase 1b: dealers as Indirect counts them, maturities, products, tiers, cards, boxes and account titles', async () => {
      // Every indirect loan has the dealer Indirect's monthly figures already credit it to; direct loans have none.
      expect(await n('SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_loan_terms t ON t.loan_id = l.loan_id WHERE (l.is_indirect = 1 AND (t.dealer_id IS NULL OR t.dealer_id <> MOD(l.loan_id, 30) + 1)) OR (l.is_indirect = 0 AND t.dealer_id IS NOT NULL)')).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM cdm_loan_terms t LEFT JOIN ind_dealer d ON d.dealer_id = t.dealer_id WHERE t.dealer_id IS NOT NULL AND d.dealer_id IS NULL')).toBe(0);
      // Amortizing loans mature at the end of their term; lines don't.
      expect(await n("SELECT COUNT(*) AS n FROM cdm_loan l JOIN cdm_loan_terms t ON t.loan_id = l.loan_id WHERE t.structure = 'Amortizing' AND l.term_months IS NOT NULL AND t.maturity_date <> DATE_ADD(l.open_date, INTERVAL l.term_months MONTH)")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_loan_terms WHERE structure = 'Line' AND maturity_date IS NOT NULL")).toBe(0);
      // Every product has its details and a cross-sell group that exists.
      expect(await n("SELECT (SELECT COUNT(*) FROM cdm_loan_product p LEFT JOIN cdm_product_detail d ON d.account_kind = 'loan' AND d.product_id = p.product_id WHERE d.product_id IS NULL) + (SELECT COUNT(*) FROM cdm_deposit_product p LEFT JOIN cdm_product_detail d ON d.account_kind = 'deposit' AND d.product_id = p.product_id WHERE d.product_id IS NULL) AS n")).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM cdm_product_detail d LEFT JOIN cdm_cross_sell_group g ON g.group_id = d.cross_sell_group WHERE g.group_id IS NULL')).toBe(0);
      // Rates never step down as the balance rises.
      expect(await n('SELECT COUNT(*) AS n FROM cdm_dividend_tier a JOIN cdm_dividend_tier b ON b.product_id = a.product_id AND b.tier = a.tier + 1 WHERE b.rate < a.rate OR b.min_balance <= a.min_balance')).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM cdm_dividend_tier')).toBeGreaterThan(0);
      // Every card has a product and an expiry; an open card hasn't expired.
      expect(await n('SELECT COUNT(*) AS n FROM cdm_card c LEFT JOIN cdm_card_terms t ON t.card_id = c.card_id LEFT JOIN cdm_card_product p ON p.card_product_id = t.card_product_id WHERE p.card_product_id IS NULL')).toBe(0);
      expect(await n(`SELECT COUNT(*) AS n FROM cdm_card c JOIN cdm_card_terms t ON t.card_id = c.card_id WHERE c.closed IS NULL AND t.expires <= '${AS_OF}'`)).toBe(0);
      // Safe deposit boxes sit under the member's own account.
      expect(await n('SELECT COUNT(*) AS n FROM cdm_misc_account m LEFT JOIN cdm_account a ON a.account_number = m.account_number AND a.primary_party_id = m.party_id WHERE a.account_number IS NULL')).toBe(0);
      expect(await n('SELECT COUNT(*) AS n FROM cdm_misc_account')).toBeGreaterThan(0);
      // Titles and relationship codes agree with the account type; a servicing override is another branch.
      expect(await n("SELECT COUNT(*) AS n FROM cdm_account WHERE title = '' OR (account_type = 'Business' AND relationship_code <> 'BUS') OR (account_type = 'Trust' AND relationship_code <> 'TRS') OR (account_type = 'Joint' AND relationship_code NOT IN ('JNT', 'REP') ) OR (account_type = 'Joint' AND title NOT LIKE '% OR %')")).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_account_holding h JOIN cdm_loan l ON h.account_kind = 'loan' AND l.loan_id = h.account_id WHERE h.servicing_branch_id = l.branch_id")).toBe(0);
      // Only certificates that renew have an amount that renews, and never more than the balance.
      expect(await n('SELECT COUNT(*) AS n FROM cdm_deposit_terms t JOIN cdm_deposit_account d ON d.account_id = t.account_id WHERE (t.auto_renew_amount IS NOT NULL AND (t.auto_renew <> 1 OR t.auto_renew_amount > d.balance + 0.01)) OR (t.auto_renew = 1 AND t.auto_renew_amount IS NULL)')).toBe(0);
    });

    it('gives every share its terms, with certificate terms and opening deposits that make sense', async () => {
      expect(await n('SELECT COUNT(*) AS n FROM cdm_deposit_account d LEFT JOIN cdm_deposit_terms t ON t.account_id = d.account_id WHERE t.account_id IS NULL')).toBe(0);
      expect(await n("SELECT COUNT(*) AS n FROM cdm_deposit_account d JOIN cdm_deposit_terms t ON t.account_id = d.account_id WHERE d.deposit_category LIKE 'Certificates%' AND (t.term_months IS NULL OR t.auto_renew IS NULL OR t.original_amount > d.balance + 0.01)")).toBe(0);
    });
  });
}
