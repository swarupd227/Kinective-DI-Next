// @vitest-environment node
// ESP alignment, step 4: loan and share transactions with codes. Fees and channels add up, the credit
// union's Member 360 keeps its checking transactions, and the bank's 360 now shows share transactions.
import { describe, expect, it } from 'vitest';
import { ActivityService, RelationshipService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { ACTIVITY_REQUEST, activityModule } from '../src/index.ts';

describe('routing', () => {
  it('sends fee and channel questions to Account Activity', () => {
    for (const q of ['Show overdraft fees by branch', 'What is our channel mix?', 'Show fees by product']) expect(ACTIVITY_REQUEST.test(q), q).toBe(true);
    const m = activityModule({} as never);
    expect(m.plan('Show overdraft fees by branch', {} as never)).toEqual({ tool: 'act_fees', args: {} });
    expect(m.plan('What is our channel mix?', {} as never)).toEqual({ tool: 'act_channels', args: {} });
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cdm_share_transaction LIMIT 1').then(() => true, () => false));
  describe.skipIf(!up)(`${DB}: transactions`, () => {
    const pool = tenantPool(DB);
    it('posts only to open accounts, within 30 days, with known codes', async () => {
      const [[bad]] = (await pool.query("SELECT (SELECT COUNT(*) FROM cdm_share_transaction t LEFT JOIN cdm_transaction_code c ON c.code = t.code WHERE c.code IS NULL) + (SELECT COUNT(*) FROM cdm_share_transaction t JOIN cdm_deposit_account d ON d.account_id = t.account_id WHERE d.close_date IS NOT NULL OR d.party_id <> t.party_id) + (SELECT COUNT(*) FROM cdm_loan_transaction t JOIN cdm_loan l ON l.loan_id = t.loan_id WHERE l.close_date IS NOT NULL OR l.party_id <> t.party_id) AS n")) as unknown as [{ n: number }[]];
      expect(Number(bad!.n)).toBe(0);
      const [[span]] = (await pool.query('SELECT DATEDIFF(MAX(posted), MIN(posted)) AS d FROM cdm_share_transaction')) as unknown as [{ d: number }[]];
      expect(Number(span!.d)).toBeLessThanOrEqual(29);
    });

    it('adds up fees and channels', async () => {
      const svc = new ActivityService(pool);
      const f = (await svc.fees())!;
      const sum = (l: { amount: number }[]) => Math.round(l.reduce((s, r) => s + r.amount, 0));
      expect(sum(f.byType)).toBe(Math.round(f.total));
      expect(sum(f.byBranch)).toBe(Math.round(f.total));
      expect(f.byType.map((t) => t.name)).toContain('Overdraft');
      const c = (await svc.channels())!;
      expect(c.map((x) => x.channel)).toEqual(expect.arrayContaining(['Card', 'ATM', 'Teller', 'ACH']));
    });

    it('fills the bank’s Member 360 transactions, and leaves the credit union’s as they were', async () => {
      const [[p]] = (await pool.query('SELECT party_id FROM cdm_share_transaction GROUP BY party_id HAVING COUNT(*) > 3 LIMIT 1')) as unknown as [{ party_id: number }[]];
      const profile = await new RelationshipService(pool, DB.replace('dinext_t_', ''), DB.endsWith('bank') ? 'bank' : 'credit_union').profile(p!.party_id, {});
      if (DB.endsWith('bank')) {
        expect(profile.transactions).not.toBeNull();
        expect(profile.transactions!.total90d).toBeGreaterThan(3);
      } else {
        // The credit union reads the core's checking transactions (cdm_transaction), as before.
        const [[n]] = (await pool.query('SELECT COUNT(*) AS n FROM cdm_transaction WHERE party_id = ? AND post_date > DATE_SUB((SELECT MAX(as_of_date) FROM meta_build), INTERVAL 90 DAY)', [p!.party_id])) as unknown as [{ n: number }[]];
        expect(profile.transactions?.total90d ?? 0).toBe(Number(n!.n));
      }
    });
  });
}
