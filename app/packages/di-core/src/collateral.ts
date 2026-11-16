// FHLB qualifying collateral (ESP phase 3): the real-estate loans that can be pledged, by the FHLB's
// collateral categories, what they lend against, and for every loan that can't be pledged the reason that
// ranks first. Participations: a bank's own share of a loan it sold part of, and loans it bought into.
// Every figure is worked out here; the agent only words it.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

/** What the FHLB lends against each collateral category, as a share of the eligible balance. */
export const FHLB_LENDABLE: Record<string, number> = { 'One-to-four family first liens': 0.75, 'Home equity': 0.6, 'Commercial real estate': 0.5 };

export interface QcrCategory {
  category: string;
  loans: number;
  balance: number;
  eligibleLoans: number;
  eligible: number;
  lendableRate: number;
  lendable: number;
  /** Eligible loans with a score of 660 or below: still pledgeable, but the FHLB may haircut them more. */
  lowScore: number;
}

export class CollateralService {
  constructor(private readonly pool: Pool) {}

  /** Eligible collateral and its lendable value, for the liquidity model; null where the tables aren't loaded. */
  async fhlb() {
    const cats = await this.categories().catch(() => null);
    if (!cats?.length) return null;
    return { eligible: cats.reduce((s, c) => s + c.eligible, 0), lendable: cats.reduce((s, c) => s + c.lendable, 0), categories: cats };
  }

  private async categories(): Promise<QcrCategory[]> {
    const found = await rows<{ c: string; n: number; bal: number; en: number; eb: number; low: number }>(
      this.pool,
      `SELECT c.fhlb_category AS c, COUNT(*) AS n, SUM(l.balance) AS bal,
              SUM(x.loan_id IS NULL) AS en, SUM(CASE WHEN x.loan_id IS NULL THEN l.balance ELSE 0 END) AS eb,
              SUM(CASE WHEN x.loan_id IS NULL AND c.fhlb_credit_score <= 660 THEN l.balance ELSE 0 END) AS low
         FROM cdm_loan_collateral c JOIN cdm_loan l ON l.loan_id = c.loan_id
         LEFT JOIN (SELECT DISTINCT i.loan_id FROM cdm_fhlb_ineligibility i JOIN cdm_fhlb_ineligibility_type t ON t.type_id = i.type_id WHERE t.informational = 0) x ON x.loan_id = c.loan_id
        WHERE c.fhlb_category IS NOT NULL AND l.close_date IS NULL AND l.charge_off_date IS NULL
        GROUP BY c.fhlb_category ORDER BY SUM(l.balance) DESC`,
    );
    return found.map((r) => {
      const rate = FHLB_LENDABLE[r.c] ?? 0.5;
      return { category: r.c, loans: Number(r.n), balance: Number(r.bal), eligibleLoans: Number(r.en), eligible: Number(r.eb), lendableRate: rate, lendable: Number(r.eb) * rate, lowScore: Number(r.low) };
    });
  }

  /** The qualifying collateral report: categories, why loans are out, the largest that could be fixed, and participations. */
  async report() {
    const has = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM cdm_loan_collateral').catch(() => null);
    if (!has) return null;
    const categories = await this.categories();
    // The reason that ranks first on each ineligible loan.
    const reasons = (
      await rows<{ code: string; name: string; n: number; bal: number }>(
        this.pool,
        `SELECT t.code, t.name, COUNT(*) AS n, SUM(l.balance) AS bal
           FROM (SELECT i.loan_id, MIN(i.ranking) AS r FROM cdm_fhlb_ineligibility i JOIN cdm_fhlb_ineligibility_type t ON t.type_id = i.type_id WHERE t.informational = 0 GROUP BY i.loan_id) top
           JOIN cdm_fhlb_ineligibility_type t ON t.ranking = top.r
           JOIN cdm_loan l ON l.loan_id = top.loan_id
          WHERE l.close_date IS NULL AND l.charge_off_date IS NULL
          GROUP BY t.code, t.name, t.ranking ORDER BY t.ranking`,
      )
    ).map((r) => ({ code: r.code, reason: r.name, loans: Number(r.n), balance: Number(r.bal) }));
    // Files a collateral review found incomplete: the one reason the institution can fix itself.
    const fixable = (
      await rows<Record<string, unknown>>(
        this.pool,
        `SELECT m.loan_id, l.loan_category, l.balance, m.note, m.entered_on, c.fhlb_category,
                (SELECT COUNT(*) FROM cdm_fhlb_ineligibility i JOIN cdm_fhlb_ineligibility_type t ON t.type_id = i.type_id WHERE i.loan_id = m.loan_id AND t.informational = 0) AS reasons
           FROM cdm_fhlb_manual_ineligibility m JOIN cdm_loan l ON l.loan_id = m.loan_id JOIN cdm_loan_collateral c ON c.loan_id = m.loan_id
          WHERE l.close_date IS NULL AND l.charge_off_date IS NULL ORDER BY l.balance DESC`,
      )
    ).map((r) => ({ loanId: Number(r.loan_id), category: r.fhlb_category as string, balance: Number(r.balance), note: r.note as string, found: day(r.entered_on), onlyReason: Number(r.reasons) === 1 }));
    const fixableOnly = fixable.filter((f) => f.onlyReason);
    const parts = await rows<{ t: string; n: number; gross: number; kept: number }>(
      this.pool,
      `SELECT c.participation_type_id AS t, COUNT(*) AS n, SUM(c.gross_balance) AS gross, SUM(c.retained_balance) AS kept
         FROM cdm_loan_collateral c JOIN cdm_loan l ON l.loan_id = c.loan_id
        WHERE c.participation_type_id IN ('SOLD', 'PURCHASED') AND l.close_date IS NULL AND l.charge_off_date IS NULL GROUP BY c.participation_type_id`,
    );
    const byInvestor = (
      await rows<{ name: string; t: string; n: number; part: number }>(
        this.pool,
        `SELECT v.name, c.participation_type_id AS t, COUNT(*) AS n, SUM(CASE WHEN c.participation_type_id = 'SOLD' THEN c.gross_balance - c.retained_balance ELSE c.retained_balance END) AS part
           FROM cdm_loan_collateral c JOIN cdm_fhlb_investor v ON v.investor_number = c.investor_number JOIN cdm_loan l ON l.loan_id = c.loan_id
          WHERE l.close_date IS NULL AND l.charge_off_date IS NULL GROUP BY v.name, c.participation_type_id ORDER BY part DESC`,
      )
    ).map((r) => ({ investor: r.name, kind: r.t === 'SOLD' ? 'Sold to' : 'Bought from', loans: Number(r.n), amount: Number(r.part) }));
    const p = (t: string) => parts.find((x) => x.t === t);
    const balance = categories.reduce((s, c) => s + c.balance, 0);
    const eligible = categories.reduce((s, c) => s + c.eligible, 0);
    return {
      categories,
      balance,
      eligible,
      eligiblePct: balance ? (eligible / balance) * 100 : 0,
      lendable: categories.reduce((s, c) => s + c.lendable, 0),
      reasons,
      fixable: fixableOnly,
      fixableBalance: fixableOnly.reduce((s, f) => s + f.balance, 0),
      fixableLendable: fixableOnly.reduce((s, f) => s + f.balance * (FHLB_LENDABLE[f.category] ?? 0.5), 0),
      participations: {
        sold: p('SOLD') ? { loans: Number(p('SOLD')!.n), gross: Number(p('SOLD')!.gross), kept: Number(p('SOLD')!.kept), sold: Number(p('SOLD')!.gross) - Number(p('SOLD')!.kept) } : null,
        purchased: p('PURCHASED') ? { loans: Number(p('PURCHASED')!.n), balance: Number(p('PURCHASED')!.kept) } : null,
        byInvestor,
      },
    };
  }
}
