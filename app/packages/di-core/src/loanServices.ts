// Services sold with loans and shares (ESP phase 5): how often GAP, mechanical repair coverage and debt
// protection go with the loans made over the last year, by product, branch, officer and dealer, and what
// they brought in; and courtesy pay, overdraft transfer, direct deposit and debit cards on checking.
// Every figure is worked out here; the agents only word it.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export type AddOn = 'GAP' | 'MRC' | 'DP';
export interface AddOnRow {
  name: string;
  loans: number;
  /** Loans with each add-on, and the share of loans. */
  GAP: number;
  MRC: number;
  DP: number;
  gapPct: number;
  mrcPct: number;
  dpPct: number;
  /** What the add-ons sold for (debt protection: one month's fee). */
  income: number;
}

const ADD_ON_NAMES: Record<AddOn, string> = { GAP: 'GAP coverage', MRC: 'mechanical repair coverage', DP: 'debt protection' };
export const addOnName = (a: AddOn) => ADD_ON_NAMES[a];

export class LoanServicesService {
  constructor(private readonly pool: Pool) {}

  /** The as-of date of the build, and whether the services are loaded. */
  private async asOf() {
    const [b] = await rows<{ d: unknown }>(this.pool, 'SELECT MAX(as_of_date) AS d FROM meta_build').catch(() => []);
    return b?.d ? day(b.d) : null;
  }

  /**
   * Add-ons on loans opened over the last `months`: by product, by branch and officer for loans made in
   * the branches, and by dealer for indirect auto loans. Null where the services aren't loaded.
   */
  async addOns(months = 12) {
    const has = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM cdm_loan_service').catch(() => null);
    const asOf = await this.asOf();
    if (!has?.[0] || !Number(has[0].n) || !asOf) return null;
    const found = await rows<{ loan_id: number; loan_category: string; is_indirect: number; branch: string; officer: string | null; dealer: string | null; code: string | null; amount: number | null }>(
      this.pool,
      `SELECT l.loan_id, l.loan_category, l.is_indirect, b.name AS branch, e.display_name AS officer, d.name AS dealer, t.code, s.amount
         FROM cdm_loan l JOIN cdm_location b ON b.int_id = l.branch_id
         LEFT JOIN cdm_employee e ON e.employee_id = l.officer_id
         LEFT JOIN cdm_loan_terms lt ON lt.loan_id = l.loan_id LEFT JOIN ind_dealer d ON d.dealer_id = lt.dealer_id
         LEFT JOIN cdm_loan_service s ON s.loan_id = l.loan_id LEFT JOIN cdm_service_type t ON t.service_id = s.service_id
        WHERE l.open_date > DATE_SUB(?, INTERVAL ? MONTH) AND l.open_date <= ?
          AND l.loan_category IN (SELECT DISTINCT p.loan_category FROM cdm_loan_product p JOIN cdm_product_service ps ON ps.product_id = p.product_id)`,
      [asOf, months, asOf],
    );
    type Loan = { category: string; indirect: boolean; branch: string; officer: string | null; dealer: string | null; codes: Set<string>; income: number };
    const loans = new Map<number, Loan>();
    for (const r of found) {
      const l = loans.get(r.loan_id) ?? { category: r.loan_category, indirect: Number(r.is_indirect) === 1, branch: r.branch, officer: r.officer, dealer: r.dealer, codes: new Set<string>(), income: 0 };
      if (r.code) {
        l.codes.add(r.code);
        l.income += Number(r.amount ?? 0);
      }
      loans.set(r.loan_id, l);
    }
    const roll = (name: string, list: Loan[]): AddOnRow => {
      const n = (c: AddOn) => list.filter((l) => l.codes.has(c)).length;
      return { name, loans: list.length, GAP: n('GAP'), MRC: n('MRC'), DP: n('DP'), gapPct: pct(n('GAP'), list.length), mrcPct: pct(n('MRC'), list.length), dpPct: pct(n('DP'), list.length), income: Math.round(list.reduce((s, l) => s + l.income, 0)) };
    };
    const group = (list: Loan[], key: (l: Loan) => string | null) => {
      const by = new Map<string, Loan[]>();
      for (const l of list) {
        const k = key(l);
        if (k) by.set(k, [...(by.get(k) ?? []), l]);
      }
      return [...by].map(([k, v]) => roll(k, v)).sort((a, b) => b.loans - a.loans || a.name.localeCompare(b.name));
    };
    const all = [...loans.values()];
    const product = (l: Loan) => (l.category === 'Auto' ? `Auto, ${l.indirect ? 'indirect' : 'direct'}` : l.category);
    const byProduct = group(all, product);
    const directAuto = all.filter((l) => l.category === 'Auto' && !l.indirect);
    const indirectAuto = all.filter((l) => l.category === 'Auto' && l.indirect);
    const directAll = roll('Direct auto', directAuto);
    const indirectAll = roll('Indirect auto', indirectAuto);
    const byBranch = group(directAuto, (l) => l.branch);
    const byOfficer = group(directAuto, (l) => l.officer).filter((o) => o.loans >= 10);
    const byDealer = group(indirectAuto, (l) => l.dealer);
    // A dealer selling GAP and repair coverage on far more of its loans than the others: what a
    // payment-packing review looks for. A branch selling GAP on far fewer of its loans: income missed.
    const packing = byDealer.filter((d) => d.loans >= 8 && d.gapPct >= indirectAll.gapPct * 1.4 && d.mrcPct >= indirectAll.mrcPct * 1.8);
    const avgGapPrice = directAll.GAP ? (await rows<{ a: number }>(this.pool, "SELECT AVG(s.amount) AS a FROM cdm_loan_service s JOIN cdm_service_type t ON t.service_id = s.service_id JOIN cdm_loan l ON l.loan_id = s.loan_id WHERE t.code = 'GAP' AND l.is_indirect = 0"))[0]?.a ?? 0 : 0;
    const lowGap = byBranch
      .filter((b) => b.loans >= 20 && b.gapPct <= directAll.gapPct * 0.5)
      .map((b) => ({ ...b, missed: Math.round(((directAll.gapPct - b.gapPct) / 100) * b.loans * Number(avgGapPrice)) }));
    return { asOf, months, loans: all.length, income: byProduct.reduce((s, p) => s + p.income, 0), byProduct, directAuto: directAll, indirectAuto: indirectAll, byBranch, byOfficer, byDealer, packing, lowGap };
  }

  /** Services on open checking accounts: courtesy pay, overdraft transfer, direct deposit and debit cards, overall and by branch. */
  async checking() {
    const asOf = await this.asOf();
    const found = await rows<{ branch: string; accounts: number; cpay: number; odt: number; dd: number; debit: number }>(
      this.pool,
      `SELECT b.name AS branch, COUNT(*) AS accounts,
              SUM(EXISTS (SELECT 1 FROM cdm_deposit_service s JOIN cdm_service_type t ON t.service_id = s.service_id WHERE s.account_id = d.account_id AND t.code = 'CPAY' AND (s.removed IS NULL OR s.removed > ?))) AS cpay,
              SUM(EXISTS (SELECT 1 FROM cdm_deposit_service s JOIN cdm_service_type t ON t.service_id = s.service_id WHERE s.account_id = d.account_id AND t.code = 'ODT' AND (s.removed IS NULL OR s.removed > ?))) AS odt,
              SUM(EXISTS (SELECT 1 FROM cdm_deposit_service s JOIN cdm_service_type t ON t.service_id = s.service_id WHERE s.account_id = d.account_id AND t.code = 'DD' AND (s.removed IS NULL OR s.removed > ?))) AS dd,
              SUM(EXISTS (SELECT 1 FROM cdm_deposit_service s JOIN cdm_service_type t ON t.service_id = s.service_id WHERE s.account_id = d.account_id AND t.code = 'DEBIT' AND (s.removed IS NULL OR s.removed > ?))) AS debit
         FROM cdm_deposit_account d JOIN cdm_location b ON b.int_id = d.branch_id
        WHERE d.deposit_category = 'Checking' AND d.close_date IS NULL GROUP BY b.name ORDER BY COUNT(*) DESC`,
      [asOf, asOf, asOf, asOf],
    ).catch(() => null);
    if (!found?.length || !asOf) return null;
    const [cp] = await rows<{ name: string }>(this.pool, "SELECT name FROM cdm_service_type WHERE code = 'CPAY'");
    const line = (r: { branch: string; accounts: number; cpay: number; odt: number; dd: number; debit: number }) => ({ branch: r.branch, accounts: Number(r.accounts), cpay: Number(r.cpay), odt: Number(r.odt), dd: Number(r.dd), debit: Number(r.debit), cpayPct: pct(Number(r.cpay), Number(r.accounts)), odtPct: pct(Number(r.odt), Number(r.accounts)), ddPct: pct(Number(r.dd), Number(r.accounts)), debitPct: pct(Number(r.debit), Number(r.accounts)) });
    const byBranch = found.map(line);
    const total = line(byBranch.reduce((s, r) => ({ branch: 'All branches', accounts: s.accounts + r.accounts, cpay: s.cpay + r.cpay, odt: s.odt + r.odt, dd: s.dd + r.dd, debit: s.debit + r.debit }), { branch: 'All branches', accounts: 0, cpay: 0, odt: 0, dd: 0, debit: 0 }));
    // Overdraft fees over the 30 days on file, and how many of the accounts charged had courtesy pay.
    const [fees] = await rows<{ n: number; amt: number; accounts: number }>(this.pool, "SELECT COUNT(*) AS n, SUM(amount) AS amt, COUNT(DISTINCT account_id) AS accounts FROM cdm_share_transaction WHERE code = 'FEE-OD'").catch(() => []);
    return { asOf, courtesyPayName: cp?.name ?? 'Courtesy pay', total, byBranch, overdraftFees: fees ? { count: Number(fees.n), amount: Number(fees.amt ?? 0), accounts: Number(fees.accounts) } : null };
  }
}
