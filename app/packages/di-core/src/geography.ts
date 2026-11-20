// Census geography and business relationships (ESP phase 8): where the institution lends by the income
// level of the census tract (the measure CRA and fair-lending reviews use), and its SEGs: how many of
// their people bank with us, who to call, and who receives their statements. Every figure is worked out
// here; the agents only word it.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const LEVELS = ['Low', 'Moderate', 'Middle', 'Upper'] as const;

export class GeographyService {
  constructor(private readonly pool: Pool) {}

  /**
   * Loans made over the last `months` by the income level of the borrower's census tract, against the
   * share of the market's households living in tracts of that level; by branch, the share in low- and
   * moderate-income (LMI) tracts. Null where the geography isn't loaded.
   */
  async lmi(months = 12, branches?: string[]) {
    const has = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM cen_tract').catch(() => null);
    if (!has?.[0] || !Number(has[0].n)) return null;
    const [b] = await rows<{ d: unknown }>(this.pool, 'SELECT MAX(as_of_date) AS d FROM meta_build');
    const asOf = day(b?.d);
    const where = branches?.length ? ` AND l.name IN (${branches.map(() => '?').join(', ')})` : '';
    const loans = await rows<{ level: string | null; branch: string; category: string; n: number; amt: number }>(
      this.pool,
      `SELECT t.income_level AS level, l.name AS branch, ln.loan_category AS category, COUNT(*) AS n, SUM(ln.original_amount) AS amt
         FROM cdm_loan ln JOIN cdm_location l ON l.int_id = ln.branch_id
         LEFT JOIN cen_address_map m ON m.party_id = ln.party_id LEFT JOIN cen_tract t ON t.geoid = m.tract
        WHERE ln.open_date > DATE_SUB(?, INTERVAL ? MONTH)${where}
        GROUP BY t.income_level, l.name, ln.loan_category`,
      [asOf, months, ...(branches ?? [])],
    );
    const market = await rows<{ level: string; tracts: number; households: number; population: number }>(this.pool, 'SELECT income_level AS level, COUNT(*) AS tracts, SUM(households) AS households, SUM(population) AS population FROM cen_tract GROUP BY income_level');
    const households = market.reduce((s, m) => s + Number(m.households), 0);
    const total = loans.reduce((s, r) => s + Number(r.n), 0);
    const totalAmt = loans.reduce((s, r) => s + Number(r.amt), 0);
    const geocoded = loans.filter((r) => r.level).reduce((s, r) => s + Number(r.n), 0);
    const byLevel = LEVELS.map((level) => {
      const m = market.find((x) => x.level === level);
      const n = loans.filter((r) => r.level === level).reduce((s, r) => s + Number(r.n), 0);
      const amt = loans.filter((r) => r.level === level).reduce((s, r) => s + Number(r.amt), 0);
      return { level, tracts: Number(m?.tracts ?? 0), householdsPct: pct(Number(m?.households ?? 0), households), loans: n, loansPct: pct(n, geocoded), amount: Math.round(amt), amountPct: pct(amt, loans.filter((r) => r.level).reduce((s, r) => s + Number(r.amt), 0)) };
    });
    const lmiOf = (list: typeof loans) => {
      const g = list.filter((r) => r.level);
      const n = g.reduce((s, r) => s + Number(r.n), 0);
      const lmi = g.filter((r) => r.level === 'Low' || r.level === 'Moderate').reduce((s, r) => s + Number(r.n), 0);
      return { loans: n, lmi, lmiPct: pct(lmi, n) };
    };
    const group = (key: (r: (typeof loans)[number]) => string) => {
      const by = new Map<string, typeof loans>();
      for (const r of loans) by.set(key(r), [...(by.get(key(r)) ?? []), r]);
      return [...by].map(([name, list]) => ({ name, ...lmiOf(list) })).sort((a, b) => b.loans - a.loans);
    };
    const lmiHouseholds = byLevel.filter((l) => l.level === 'Low' || l.level === 'Moderate').reduce((s, l) => s + l.householdsPct, 0);
    return {
      asOf,
      months,
      loans: total,
      amount: Math.round(totalAmt),
      geocoded,
      byLevel,
      lmi: { ...lmiOf(loans), householdsPct: Math.round(lmiHouseholds * 10) / 10 },
      byBranch: group((r) => r.branch),
      byProduct: group((r) => r.category),
    };
  }

  /** SEGs: how many of their people bank with us and get paid by direct deposit, their contact, and who receives their statements. */
  async segs() {
    const found = await rows<{ business_id: number; name: string; status: string; seg: string | null; branch: string | null; bdo: string | null; employees: number | null; with_us: number | null; dd: number | null; contact: string | null; title: string | null; statements: string | null; payroll_bank: string | null }>(
      this.pool,
      `SELECT b.business_id, b.name, s.name AS status, b.seg_group_number AS seg, l.name AS branch, b.assigned_bdo AS bdo, b.total_employees AS employees, b.employees_with_us AS with_us, b.employees_direct_deposit AS dd,
              (SELECT CONCAT(c.first_name, ' ', c.last_name) FROM brm_contact c WHERE c.business_id = b.business_id AND c.is_primary = 1 LIMIT 1) AS contact,
              (SELECT c.title FROM brm_contact c WHERE c.business_id = b.business_id AND c.is_primary = 1 LIMIT 1) AS title,
              (SELECT GROUP_CONCAT(CONCAT(c.first_name, ' ', c.last_name, ' (', ch.name, ')') SEPARATOR ', ') FROM brm_recipient r JOIN brm_contact c ON c.contact_id = r.contact_id JOIN brm_channel ch ON ch.channel_id = r.channel_id WHERE r.business_id = b.business_id AND r.kind = 'Statement') AS statements,
              (SELECT d.originating_bank FROM brm_direct_deposit d WHERE d.business_id = b.business_id) AS payroll_bank
         FROM brm_business b JOIN brm_status s ON s.status_id = b.status_id LEFT JOIN cdm_location l ON l.int_id = b.assigned_branch_id
        WHERE b.kind = 'SEG' ORDER BY b.employees_with_us DESC, b.name`,
    ).catch(() => null);
    if (!found?.length) return null;
    return found.map((r) => ({ businessId: Number(r.business_id), name: r.name, status: r.status, segNumber: r.seg, branch: r.branch, bdo: r.bdo, employees: r.employees === null ? null : Number(r.employees), withUs: Number(r.with_us ?? 0), directDeposit: Number(r.dd ?? 0), withUsPct: r.employees ? pct(Number(r.with_us ?? 0), Number(r.employees)) : null, ddPct: pct(Number(r.dd ?? 0), Number(r.with_us ?? 0)), contact: r.contact, title: r.title, statements: r.statements, payrollBank: r.payroll_bank }));
  }

  /** How many businesses DI knows, by kind. */
  async businesses() {
    const found = await rows<{ kind: string; n: number }>(this.pool, 'SELECT kind, COUNT(*) AS n FROM brm_business GROUP BY kind ORDER BY COUNT(*) DESC').catch(() => null);
    return found?.map((r) => ({ kind: r.kind, count: Number(r.n) })) ?? null;
  }

  /**
   * DI's SEG map: the branches (each at the middle of its own members' geocoded addresses), the SEGs and
   * prospect companies (at their physical address's ZIP centre, spread a little so neighbours don't hide
   * each other), and where members live, counted on a grid of about a mile and a half for the heatmap.
   * Everything comes from the institution's own geography, so it fits its market. Within the branches
   * given, where a person's purview is limited. Null where the geography isn't loaded.
   */
  async marketMap(branches?: string[]) {
    const scope = branches ? { sql: ' AND l.name IN (?)', params: [branches.length ? branches : ['']] } : { sql: '', params: [] as unknown[] };
    // A branch sits in the ZIP most of its own members live in (members of every branch live all over the
    // market, so their average would put every branch in the middle).
    const byZip = await rows<{ name: string; zcta: string; lat: number; lng: number; n: number }>(
      this.pool,
      `SELECT l.name, m.zcta, z.centroid_latitude AS lat, z.centroid_longitude AS lng, COUNT(*) AS n FROM cdm_party p JOIN cen_address_map m ON m.party_id = p.party_id JOIN cdm_location l ON l.int_id = p.primary_branch_id JOIN cen_zcta z ON z.zcta = m.zcta
        WHERE m.latitude IS NOT NULL${scope.sql} GROUP BY l.name, m.zcta, z.centroid_latitude, z.centroid_longitude ORDER BY l.name, n DESC, m.zcta`,
      scope.params,
    ).catch(() => null);
    if (!byZip?.length) return null;
    const branchRows: { name: string; lat: number; lng: number; n: number }[] = [];
    const taken = new Set<string>();
    for (const name of [...new Set(byZip.map((r) => r.name))]) {
      const mine = byZip.filter((r) => r.name === name);
      // Two branches whose members mostly share a ZIP each take the first one not taken.
      const top = mine.find((r) => !taken.has(r.zcta)) ?? mine[0]!;
      taken.add(top.zcta);
      branchRows.push({ name, lat: Number(top.lat), lng: Number(top.lng), n: mine.reduce((s, r) => s + Number(r.n), 0) });
    }
    const cells = await rows<{ lat: number; lng: number; n: number }>(
      this.pool,
      `SELECT ROUND(m.latitude / ${GRID}) * ${GRID} AS lat, ROUND(m.longitude / ${GRID}) * ${GRID} AS lng, COUNT(*) AS n FROM cdm_party p JOIN cen_address_map m ON m.party_id = p.party_id JOIN cdm_location l ON l.int_id = p.primary_branch_id
        WHERE m.latitude IS NOT NULL AND p.is_member = 1${scope.sql} GROUP BY 1, 2`,
      scope.params,
    );
    const companies = await rows<{ business_id: number; name: string; kind: string; branch: string | null; with_us: number | null; employees: number | null; lat: number | null; lng: number | null }>(
      this.pool,
      `SELECT b.business_id, b.name, b.kind, l.name AS branch, b.employees_with_us AS with_us, b.total_employees AS employees, z.centroid_latitude AS lat, z.centroid_longitude AS lng
         FROM brm_business b LEFT JOIN cdm_location l ON l.int_id = b.assigned_branch_id
         JOIN brm_location a ON a.location_id = (SELECT MIN(x.location_id) FROM brm_location x WHERE x.business_id = b.business_id AND x.is_physical = 1)
         JOIN cen_zcta z ON z.zcta = a.zip
        WHERE b.kind IN ('SEG', 'Prospect')${branches ? ' AND (l.name IS NULL OR l.name IN (?))' : ''} ORDER BY b.kind, b.name`,
      branches ? [branches.length ? branches : ['']] : [],
    ).catch(() => []);
    const near = (id: number, salt: number) => (((id * 9301 + salt * 49297) % 233280) / 233280 - 0.5) * 0.03;
    return {
      branches: branchRows.map((b) => ({ name: b.name, lat: Number(b.lat), lng: Number(b.lng), members: Number(b.n) })),
      density: cells.map((c) => ({ lat: Number(c.lat), lng: Number(c.lng), members: Number(c.n) })),
      companies: companies.filter((c) => c.lat !== null).map((c) => ({ id: Number(c.business_id), name: c.name, kind: c.kind === 'SEG' ? ('SEG' as const) : ('Prospect' as const), branch: c.branch, withUs: Number(c.with_us ?? 0), employees: c.employees === null ? null : Number(c.employees), lat: Number(c.lat) + near(Number(c.business_id), 1), lng: Number(c.lng) + near(Number(c.business_id), 2) * 1.4 })),
    };
  }

  /**
   * Directions to a SEG or prospect company, from its branch (or the nearest one), as a Google Maps link
   * between the map's points, with the straight-line distance. Null where it isn't on the map.
   */
  async directions(company: string, branches?: string[]) {
    const map = await this.marketMap(branches);
    if (!map) return null;
    const words = company.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
    const hits = map.companies.filter((c) => words.every((w) => c.name.toLowerCase().includes(w)));
    const c = hits.find((x) => x.name.toLowerCase() === company.toLowerCase()) ?? hits[0];
    if (!c) return { found: false as const, names: map.companies.map((x) => x.name) };
    const from = map.branches.find((b) => b.name === c.branch) ?? [...map.branches].sort((a, b) => miles(a, c) - miles(b, c))[0]!;
    const fix = (n: number) => n.toFixed(5);
    return {
      found: true as const,
      company: c,
      from: from.name,
      assigned: from.name === c.branch,
      miles: Math.round(miles(from, c) * 10) / 10,
      link: `https://www.google.com/maps/dir/?api=1&origin=${fix(from.lat)},${fix(from.lng)}&destination=${fix(c.lat)},${fix(c.lng)}&travelmode=driving`,
    };
  }
}

/** The heatmap's grid: about a mile and a half in latitude. */
const GRID = 0.02;

/** Straight-line miles between two points (haversine). */
function miles(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}
