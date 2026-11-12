// @vitest-environment node
// ESP alignment, step 5: who is on each account. Every account has exactly one primary owner, its own
// party; joint owners and co-borrowers come from the household; the Member 360 lists accounts the person
// is on, but its totals still count only what they own as primary.
import { describe, expect, it } from 'vitest';
import { blockSchema } from '@dinext/block-schemas';
import { RelationshipService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { member360 } from '../src/index.ts';

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cdm_account_owner LIMIT 1').then(() => true, () => false));
  describe.skipIf(!up)(`${DB}: account owners`, () => {
    const pool = tenantPool(DB);
    const one = async <T>(sql: string) => ((await pool.query(sql)) as unknown as [T[]])[0][0]!;

    it('gives every account one primary owner, its own party, and others from the household', async () => {
      const prim = await one<{ bad: number }>("SELECT (SELECT COUNT(*) FROM cdm_deposit_account d LEFT JOIN cdm_account_owner o ON o.account_kind = 'deposit' AND o.account_id = d.account_id AND o.role = 'Primary' WHERE o.party_id IS NULL OR o.party_id <> d.party_id) + (SELECT COUNT(*) FROM cdm_loan l LEFT JOIN cdm_account_owner o ON o.account_kind = 'loan' AND o.account_id = l.loan_id AND o.role = 'Primary' WHERE o.party_id IS NULL OR o.party_id <> l.party_id) AS bad");
      expect(Number(prim.bad)).toBe(0);
      const twice = await one<{ n: number }>("SELECT COUNT(*) AS n FROM (SELECT account_kind, account_id FROM cdm_account_owner WHERE role = 'Primary' GROUP BY account_kind, account_id HAVING COUNT(*) > 1) x");
      expect(Number(twice.n)).toBe(0);
      const strangers = await one<{ n: number }>("SELECT COUNT(*) AS n FROM cdm_account_owner o JOIN cdm_account_owner pr ON pr.account_kind = o.account_kind AND pr.account_id = o.account_id AND pr.role = 'Primary' JOIN cdm_party a ON a.party_id = o.party_id JOIN cdm_party b ON b.party_id = pr.party_id WHERE o.role <> 'Primary' AND a.household_id <> b.household_id");
      expect(Number(strangers.n)).toBe(0);
    });

    it('shows shared accounts on the 360 without counting them in the totals', async () => {
      const [[r]] = (await pool.query("SELECT o.party_id FROM cdm_account_owner o JOIN cdm_deposit_account d ON d.account_id = o.account_id AND d.close_date IS NULL WHERE o.account_kind = 'deposit' AND o.role = 'Joint' LIMIT 1")) as unknown as [{ party_id: number }[]];
      const svc = new RelationshipService(pool, DB.replace('dinext_t_', ''), DB.endsWith('bank') ? 'bank' : 'credit_union');
      const p = await svc.profile(r!.party_id, {});
      expect(p.sharedAccounts.length).toBeGreaterThan(0);
      expect(p.totals.deposits).toBeCloseTo(p.deposits.reduce((s, a) => s + a.balance, 0), 2);
      const block = member360(p, 'r');
      expect(blockSchema.safeParse(block).success).toBe(true);
      const acc = block.data.sections.find((s) => s.kind === 'accounts') as Extract<(typeof block.data.sections)[number], { kind: 'accounts' }>;
      expect(acc.deposits.some((d) => d.relationship === 'Joint')).toBe(true);
      expect(acc.deposits.filter((d) => d.relationship === 'Primary')).toHaveLength(Math.min(40, p.deposits.length));
    });
  });
}
