// @vitest-environment node
// ESP phase 8: business relationships and census geography. The SEGs, prospects and business members
// each link back to the record they come from; every address geocodes to a tract in its own ZIP, and
// tracts carry the FFIEC income level CRA uses.
import { describe, expect, it } from 'vitest';
import { GeographyService, type IssueService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { incomeLevel } from '../../tenant-db/src/espGeo.ts';
import { complianceModule, LMI_REQUEST } from '../src/compliance.ts';
import { segModule, SEG_REACH_REQUEST } from '../src/moreModules.ts';

describe('routing', () => {
  it('sends CRA and LMI lending to cpm_lmi, and SEG reach to seg_reach', () => {
    const cpm = complianceModule({} as IssueService, {} as never, undefined, undefined, {} as GeographyService);
    for (const q of ['How much do we lend in low- and moderate-income tracts?', 'Show our CRA lending', 'Lending by census tract income', 'Are we lending in underserved areas?']) {
      expect(LMI_REQUEST.test(q), q).toBe(true);
      expect((cpm.plan(q, {} as never) as { tool?: string }).tool, q).toBe('cpm_lmi');
    }
    expect((cpm.plan('Show our insider loans', {} as never) as { tool?: string }).tool).toBe('cpm_insider_loans');
    const seg = segModule({} as never, () => '2026-10-25', {} as GeographyService);
    for (const q of ['Which SEGs have the most employees banking with us?', 'Who receives each SEG’s statements?', 'Show SEG payroll direct deposit']) expect((seg.plan(q, {} as never) as { tool?: string }).tool, q).toBe('seg_reach');
    expect(SEG_REACH_REQUEST.test('Show our SEG sponsorships')).toBe(false);
  });

  it('uses the FFIEC income levels', () => {
    expect([incomeLevel(45), incomeLevel(50), incomeLevel(79.9), incomeLevel(80), incomeLevel(119.9), incomeLevel(120)]).toEqual(['Low', 'Moderate', 'Moderate', 'Middle', 'Middle', 'Upper']);
  });
});

for (const DB of ['dinext_t_test_cu', 'dinext_t_test_bank']) {
  const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cen_address_map LIMIT 1').then(() => true, () => false));
  const cu = !DB.endsWith('bank');
  describe.skipIf(!up)(`${DB}: phase 8`, () => {
    const pool = tenantPool(DB);
    const one = async (sql: string) => Number(((await pool.query(sql)) as unknown as [{ n: unknown }[]])[0][0]!.n ?? 0);
    const ctx = { user: { id: 'user:1', name: 'Test' }, modules: ['compliance', 'seg'], runId: 'r', threadId: 't' };

    it('geocodes every address to a tract in its own ZIP, or says why not', async () => {
      expect(await one('SELECT (SELECT COUNT(*) FROM cdm_party_address) - (SELECT COUNT(*) FROM cen_address_map) AS n')).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM cen_address_map m JOIN cdm_party_address a ON a.party_id = m.party_id WHERE m.zcta <> a.zip")).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM cen_address_map WHERE status = 'Matched' AND (tract IS NULL OR block IS NULL OR latitude IS NULL)")).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM cen_address_map m LEFT JOIN cen_tract t ON t.geoid = m.tract WHERE m.tract IS NOT NULL AND t.geoid IS NULL")).toBe(0);
      expect(await one("SELECT SUM(status = 'Matched') / COUNT(*) * 100 AS n FROM cen_address_map")).toBeGreaterThan(95);
      // Each tract's level follows its income against the area's.
      const tracts = (await pool.query('SELECT income_level, median_family_income_pct FROM cen_tract'))[0] as { income_level: string; median_family_income_pct: number }[];
      for (const t of tracts) expect(t.income_level).toBe(incomeLevel(Number(t.median_family_income_pct)));
      expect(tracts.some((t) => t.income_level === 'Low' || t.income_level === 'Moderate')).toBe(true);
    });

    it('links each business to where it came from', async () => {
      expect(await one("SELECT COUNT(*) AS n FROM prs_prospect p WHERE NOT EXISTS (SELECT 1 FROM brm_business b WHERE b.prospect_id = p.prospect_id AND b.kind = 'Prospect')")).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM seg_company s WHERE NOT EXISTS (SELECT 1 FROM brm_business b WHERE b.seg_company_id = s.company_id AND b.kind = 'SEG')")).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM cdm_party p WHERE (p.segment_code LIKE '%Business%' OR p.segment_code LIKE '%Commercial%') AND NOT EXISTS (SELECT 1 FROM brm_business b WHERE b.party_id = p.party_id)")).toBe(0);
      // Every business has a location and a primary contact; payroll details keep the last four digits only.
      expect(await one('SELECT COUNT(*) AS n FROM brm_business b WHERE NOT EXISTS (SELECT 1 FROM brm_location l WHERE l.business_id = b.business_id) OR NOT EXISTS (SELECT 1 FROM brm_contact c WHERE c.business_id = b.business_id AND c.is_primary = 1)')).toBe(0);
      expect(await one("SELECT COUNT(*) AS n FROM brm_direct_deposit WHERE account_last4 NOT REGEXP '^[0-9]{4}$'")).toBe(0);
      // Made-up contacts use example.com.
      expect(await one("SELECT COUNT(*) AS n FROM brm_contact c JOIN brm_business b ON b.business_id = c.business_id WHERE b.kind IN ('Vendor', 'Prospect') AND c.email NOT LIKE '%example.com'")).toBe(0);
    });

    it('answers LMI lending, and SEG reach where there are SEGs', async () => {
      const x = (await new GeographyService(pool).lmi(12))!;
      expect(x.geocoded).toBeGreaterThan(x.loans * 0.95);
      expect(x.byLevel.reduce((s, l) => s + l.loansPct, 0)).toBeCloseTo(100, 0);
      const tool = complianceModule({} as IssueService, pool, undefined, undefined, new GeographyService(pool)).tools.find((t) => t.name === 'cpm_lmi')!;
      const out = (await tool.run({} as never, ctx as never)) as { text: string };
      expect(out.text).toMatch(/went to borrowers in low- and moderate-income tracts/);
      expect(out.text).toMatch(/compliance officer’s call/);
      const segs = await new GeographyService(pool).segs();
      if (cu) {
        expect(segs!.length).toBe(30);
        expect(segs!.some((s) => s.withUs > 0)).toBe(true);
      }
    });
  });
}
