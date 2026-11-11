// Cross-sell across the book (DI's cross-sell stock report): products per person, by branch and age,
// penetration of each product, and attrition risk by branch. Products are distinct open deposit and loan
// categories a person holds.
import type { Pool } from '@dinext/tenant-db';
import type { CoreContext } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const AGE_BANDS: [number, string][] = [[25, 'Under 25'], [35, '25 to 34'], [45, '35 to 44'], [55, '45 to 54'], [65, '55 to 64'], [200, '65 and over']];

export class CrossSellService {
  constructor(private readonly pool: Pool) {}

  private async people(ctx: CoreContext) {
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const [asOfRow] = await rows<{ d: unknown }>(this.pool, "SELECT as_of_date AS d FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
    const asOf = String(asOfRow?.d instanceof Date ? (asOfRow.d as Date).toISOString() : asOfRow?.d).slice(0, 10);
    const list = await rows<{ party_id: number; branch: string; age: number; dep: number | null; loan: number | null }>(
      this.pool,
      `SELECT p.party_id, b.name AS branch, TIMESTAMPDIFF(YEAR, p.birth_date, ?) AS age, d.n AS dep, l.n AS loan
         FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id
         LEFT JOIN (SELECT party_id, COUNT(DISTINCT deposit_category) AS n FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY party_id) d ON d.party_id = p.party_id
         LEFT JOIN (SELECT party_id, COUNT(DISTINCT loan_category) AS n FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL GROUP BY party_id) l ON l.party_id = p.party_id
        WHERE (d.n IS NOT NULL OR l.n IS NOT NULL)${scope}`,
      [asOf, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])],
    );
    return { asOf, people: list.map((r) => ({ partyId: r.party_id, branch: r.branch, age: Number(r.age), products: Number(r.dep ?? 0) + Number(r.loan ?? 0) })) };
  }

  /** Products per person: the spread, by branch and by age band. */
  async summary(ctx: CoreContext) {
    const { asOf, people } = await this.people(ctx);
    const n = people.length;
    const total = people.reduce((s, p) => s + p.products, 0);
    const buckets = ['1', '2', '3', '4', '5 or more'];
    const bucketOf = (k: number) => (k >= 5 ? '5 or more' : String(k));
    const distribution = buckets.map((b) => {
      const c = people.filter((p) => bucketOf(p.products) === b).length;
      return { products: b, people: c, sharePct: pct(c, n) };
    });
    const group = (key: (p: (typeof people)[number]) => string, order?: string[]) => {
      const keys = order ?? [...new Set(people.map(key))].sort();
      return keys.map((k) => {
        const g = people.filter((p) => key(p) === k);
        const sum = g.reduce((s, p) => s + p.products, 0);
        return { name: k, people: g.length, perPerson: g.length ? Math.round((sum / g.length) * 100) / 100 : 0, singlePct: pct(g.filter((p) => p.products === 1).length, g.length), threePlusPct: pct(g.filter((p) => p.products >= 3).length, g.length) };
      }).filter((r) => r.people);
    };
    return {
      asOf,
      people: n,
      perPerson: n ? Math.round((total / n) * 100) / 100 : 0,
      singlePct: pct(people.filter((p) => p.products === 1).length, n),
      distribution,
      byBranch: group((p) => p.branch),
      byAge: group((p) => AGE_BANDS.find(([max]) => p.age < max)![1], AGE_BANDS.map(([, l]) => l)),
    };
  }

  /** How many people hold each product category. */
  async penetration(ctx: CoreContext) {
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const params = ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [];
    const { people } = await this.people(ctx);
    const list = await rows<{ product: string; n: number }>(
      this.pool,
      `SELECT x.product, COUNT(DISTINCT x.party_id) AS n FROM (
          SELECT a.party_id, a.deposit_category AS product FROM cdm_deposit_account a JOIN cdm_party p ON p.party_id = a.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE a.close_date IS NULL${scope}
          UNION ALL SELECT l.party_id, l.loan_category FROM cdm_loan l JOIN cdm_party p ON p.party_id = l.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE l.close_date IS NULL AND l.charge_off_date IS NULL${scope}) x
        GROUP BY x.product ORDER BY n DESC`,
      [...params, ...params],
    );
    return list.map((r) => ({ product: r.product, people: Number(r.n), sharePct: pct(Number(r.n), people.length) }));
  }

  /** Attrition risk by branch: how many are High (7+), Medium (5 to 6) and Low, and the deposits in the High band. */
  async attritionByBranch(ctx: CoreContext) {
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const list = await rows<{ branch: string; high: number; medium: number; low: number; high_deposits: unknown }>(
      this.pool,
      `SELECT b.name AS branch, SUM(s.score >= 7) AS high, SUM(s.score BETWEEN 5 AND 6) AS medium, SUM(s.score < 5) AS low,
              SUM(CASE WHEN s.score >= 7 THEN COALESCE(d.dep, 0) ELSE 0 END) AS high_deposits
         FROM cdm_attrition_score s JOIN cdm_party p ON p.party_id = s.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id
         LEFT JOIN (SELECT party_id, SUM(balance) AS dep FROM cdm_deposit_account WHERE close_date IS NULL GROUP BY party_id) d ON d.party_id = s.party_id
        WHERE 1 = 1${scope} GROUP BY b.name ORDER BY high DESC`,
      ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [],
    );
    return list.map((r) => {
      const all = Number(r.high) + Number(r.medium) + Number(r.low);
      return { branch: r.branch, high: Number(r.high), medium: Number(r.medium), low: Number(r.low), highPct: pct(Number(r.high), all), highDeposits: Math.round(Number(r.high_deposits)) };
    });
  }
}
