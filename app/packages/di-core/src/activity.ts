// Account activity from loan and share transactions (ESP's transaction tables, with codes): fee income
// by type, product and branch, and how people transact, by channel. The last 30 days of transactions.
import type { Pool } from '@dinext/tenant-db';
import type { CoreContext } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const scoped = (ctx: CoreContext) => (ctx.purviewBranches ? { sql: ' AND b.name IN (?)', params: [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] } : { sql: '', params: [] as unknown[] });

export class ActivityService {
  constructor(private readonly pool: Pool) {}

  private async loaded() {
    return rows<{ one: number }>(this.pool, 'SELECT 1 AS one FROM cdm_share_transaction LIMIT 1').then((r) => r.length > 0, () => false);
  }

  /** Fees charged in the period: by fee type, by product and by branch, with how many accounts paid one. */
  async fees(ctx: CoreContext = {}) {
    if (!(await this.loaded())) return null;
    const s = scoped(ctx);
    const base = `FROM (SELECT t.account_id, t.party_id, t.amount, c.fee_type, d.branch_id, ap.product_id FROM cdm_share_transaction t JOIN cdm_transaction_code c ON c.code = t.code JOIN cdm_deposit_account d ON d.account_id = t.account_id LEFT JOIN cdm_account_product ap ON ap.account_kind = 'deposit' AND ap.account_id = t.account_id WHERE c.fee_type IS NOT NULL
                   UNION ALL SELECT t.loan_id, t.party_id, t.amount, c.fee_type, l.branch_id, ap.product_id FROM cdm_loan_transaction t JOIN cdm_transaction_code c ON c.code = t.code JOIN cdm_loan l ON l.loan_id = t.loan_id LEFT JOIN cdm_account_product ap ON ap.account_kind = 'loan' AND ap.account_id = t.loan_id WHERE c.fee_type IS NOT NULL) f JOIN cdm_location b ON b.int_id = f.branch_id WHERE 1 = 1${s.sql}`;
    const by = (key: string) => rows<{ k: string | null; n: number; accts: number; amt: unknown }>(this.pool, `SELECT ${key} AS k, COUNT(*) AS n, COUNT(DISTINCT f.account_id) AS accts, -SUM(f.amount) AS amt ${base} GROUP BY k ORDER BY amt DESC`, s.params);
    const [byType, byBranch, byProduct] = await Promise.all([by('f.fee_type'), by('b.name'), by("COALESCE(f.product_id, 'Unknown')")]);
    const [period] = await rows<{ a: unknown; z: unknown }>(this.pool, 'SELECT MIN(posted) AS a, MAX(posted) AS z FROM cdm_share_transaction');
    const d = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
    const map = (list: typeof byType) => list.map((r) => ({ name: r.k ?? 'Other', fees: Number(r.n), accounts: Number(r.accts), amount: Math.round(Number(r.amt) * 100) / 100 }));
    const total = byType.reduce((x, r) => x + Number(r.amt), 0);
    return { from: d(period?.a), to: d(period?.z), total: Math.round(total * 100) / 100, byType: map(byType), byBranch: map(byBranch), byProduct: map(byProduct) };
  }

  /** How people transact: count, people and dollars by channel (branch teller, ATM, card, mobile, online, ACH). */
  async channels(ctx: CoreContext = {}) {
    if (!(await this.loaded())) return null;
    const s = scoped(ctx);
    const list = await rows<{ ch: string; n: number; people: number; amt: unknown }>(
      this.pool,
      `SELECT x.channel AS ch, COUNT(*) AS n, COUNT(DISTINCT x.party_id) AS people, SUM(ABS(x.amount)) AS amt FROM (
          SELECT t.channel, t.party_id, t.amount, d.branch_id FROM cdm_share_transaction t JOIN cdm_deposit_account d ON d.account_id = t.account_id WHERE t.channel <> 'System'
          UNION ALL SELECT t.channel, t.party_id, t.amount, l.branch_id FROM cdm_loan_transaction t JOIN cdm_loan l ON l.loan_id = t.loan_id WHERE t.channel <> 'System') x
        JOIN cdm_location b ON b.int_id = x.branch_id WHERE 1 = 1${s.sql} GROUP BY x.channel ORDER BY n DESC`,
      s.params,
    );
    const total = list.reduce((x, r) => x + Number(r.n), 0);
    return list.map((r) => ({ channel: r.ch, transactions: Number(r.n), people: Number(r.people), amount: Math.round(Number(r.amt)), sharePct: total ? Math.round((Number(r.n) / total) * 1000) / 10 : 0 }));
  }
}
