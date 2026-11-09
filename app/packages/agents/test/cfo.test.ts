// @vitest-environment node
// The CFO Scorecard: capital, earnings and credit from the catalog, judged against minimums, plan and peers.
import { describe, expect, it } from 'vitest';
import { SemanticService } from '@dinext/semantic';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { cfoScorecard } from '../src/index.ts';

const up = await warehouseAvailable('dinext_t_test_bank').then((ok) => ok && tenantPool('dinext_t_test_bank').query('SELECT 1 FROM cr_value LIMIT 1').then(() => true, () => false));

describe.skipIf(!up)('CFO Scorecard', () => {
  it('reads every measure from the catalog and says why each needs attention', async () => {
    const pool = tenantPool('dinext_t_test_bank');
    try {
      const svc = await SemanticService.create(pool, 'test_bank', 'bank');
      const s = await cfoScorecard(svc, pool);
      expect(s.lines.map((l) => l.metric)).toEqual(['cet1_ratio', 'net_worth_ratio', 'unrealized_loss_to_tier1', 'net_interest_margin', 'nii_growth', 'non_interest_income_share', 'return_on_equity', 'return_on_assets', 'efficiency_ratio', 'loan_to_share_ratio', 'uninsured_deposit_ratio', 'npl_ratio', 'net_charge_off_ratio', 'allowance_coverage']);
      for (const l of s.lines) {
        expect(l.now, l.metric).not.toBeNull();
        // A growth line is one figure, this quarter on the same quarter a year ago.
        expect(l.trend.length, l.metric).toBe(l.growth ? 0 : 5);
        expect(l.why.length, l.metric).toBeGreaterThan(5);
      }
      const by = (m: string) => s.lines.find((l) => l.metric === m)!;
      // Net interest income growth is judged in dollars against a year ago: a fall is a concern, slow growth is watched.
      const nii = by('nii_growth');
      expect(nii.now!).toBeCloseTo(((nii.dollars!.now - nii.dollars!.yearAgo) / nii.dollars!.yearAgo) * 100, 6);
      expect(nii.read).toBe(nii.now! < 0 ? 'Concern' : nii.now! < 3 ? 'Watch' : 'Strong');
      expect(nii.why).toMatch(/\$\d+\.\d{2}M to \$\d+\.\d{2}M a year/);
      // Capital is judged against its regulatory floor; the CET1 ratio sits far above it.
      expect(by('cet1_ratio').read).toBe('Strong');
      expect(by('cet1_ratio').why).toMatch(/above well capitalized/);
      // Loan-to-deposit is judged against the 80% to 100% band, not as more-is-better.
      const ltd = by('loan_to_share_ratio');
      expect(ltd.read).toBe(ltd.now! > 100 ? 'Concern' : ltd.now! < 80 ? 'Watch' : 'Strong');
      if (ltd.now! < 80) expect(ltd.why).toMatch(/^Below 80%: deposits sitting idle/);
      // Uninsured deposits are judged by DI's watch levels.
      const un = by('uninsured_deposit_ratio');
      expect(un.read).toBe(un.now! >= 60 ? 'Concern' : un.now! >= 40 ? 'Watch' : 'Strong');
      expect(un.why).toMatch(/SVB/);
      // A measure behind both plan and peers is a concern, and the headline names it once, without nested brackets.
      const nim = by('net_interest_margin');
      if (nim.plan !== null && nim.peer !== null && nim.now! < nim.plan && nim.now! < nim.peer) expect(nim.read).toBe('Concern');
      expect(s.headline).not.toMatch(/\([^)]*\(/);
      expect(s.quarter).toMatch(/^Q[1-4] \d{4}$/);
    } finally {
      await pool.end();
    }
  });
});
