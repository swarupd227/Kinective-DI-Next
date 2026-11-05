// Membership growth and member penetration: who joined, who left and why, net growth and the annual
// attrition rate over time and by branch; and how deep relationships are, as the share of members with
// checking, a loan, direct deposit and active digital banking, and products per member, by branch and age
// band. From the month-end member history and the closed-membership extract, under the viewer's purview.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const label = (end: string) => new Date(`${end}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);

export const MEMBER_AGE_BANDS = ['18–24', '25–34', '35–49', '50–64', '65+'] as const;
/** Typical ranges for a credit union, used to say whether a figure is ordinary. */
export const MEMBERSHIP_BENCHMARKS = { attritionPct: [5, 8] as [number, number], netGrowthPct: [1, 3] as [number, number] };

export interface MembershipScope {
  purviewBranches?: string[];
}

interface Depth {
  members: number;
  checking: number;
  loan: number;
  directDeposit: number;
  digital: number;
  productsPerMember: number;
}

const depth = (r: { m: number; c: number; l: number; dd: number; dg: number; p: number }): Depth => {
  const m = Number(r.m);
  return { members: m, checking: pct(Number(r.c), m), loan: pct(Number(r.l), m), directDeposit: pct(Number(r.dd), m), digital: pct(Number(r.dg), m), productsPerMember: m ? Number(r.p) / m : 0 };
};
const DEPTH_SQL = 'SUM(member_count) AS m, SUM(with_checking) AS c, SUM(with_loan) AS l, SUM(with_direct_deposit) AS dd, SUM(digital_active) AS dg, SUM(product_count) AS p';

export class MembershipService {
  constructor(private readonly pool: Pool) {}

  private async where(scope: MembershipScope, alias: string) {
    if (!scope.purviewBranches) return '';
    const found = await rows<{ int_id: number }>(this.pool, 'SELECT int_id FROM cdm_location WHERE name IN (?)', [scope.purviewBranches.length ? scope.purviewBranches : ['']]);
    return ` AND ${alias}.branch_id IN (${found.length ? found.map((r) => r.int_id).join(',') : '0'})`;
  }

  /** Joins, exits and members at each month-end, and the year's net growth and attrition. */
  async growth(scope: MembershipScope = {}) {
    const w = await this.where(scope, 'h');
    const data = await rows<{ m: unknown; members: number; joined: number; left: number }>(this.pool, `SELECT h.month_end AS m, SUM(h.member_count) AS members, SUM(h.new_member_count) AS joined, SUM(h.closed_member_count) AS \`left\` FROM hist_party_month h WHERE 1 = 1${w} GROUP BY h.month_end ORDER BY h.month_end`);
    const months = data.map((r) => ({ month: day(r.m), label: label(day(r.m)), members: Number(r.members), joined: Number(r.joined), left: Number(r.left), net: Number(r.joined) - Number(r.left) }));
    const year = months.slice(-12);
    const latest = months.at(-1)!;
    const yearAgo = months.at(-13) ?? months[0]!;
    const avg = year.reduce((s, m) => s + m.members, 0) / Math.max(1, year.length);
    const joined = year.reduce((s, m) => s + m.joined, 0);
    const left = year.reduce((s, m) => s + m.left, 0);
    // The prior twelve months, for whether growth is speeding up or slowing.
    const before = months.slice(-24, -12);
    const priorNet = before.length >= 6 ? (before.reduce((s, m) => s + m.net, 0) * 12) / before.length : null;
    return {
      months,
      latest,
      members: latest.members,
      joined,
      left,
      net: joined - left,
      netGrowthPct: pct(latest.members - yearAgo.members, yearAgo.members),
      attritionPct: pct(left, avg),
      grossAddPct: pct(joined, avg),
      priorNet,
      fromLabel: yearAgo.label,
    };
  }

  /** Net growth and attrition by branch over the last twelve months. */
  async branches(scope: MembershipScope = {}) {
    const w = await this.where(scope, 'h');
    const [last] = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_party_month');
    const end = day(last!.m);
    const data = await rows<{ branch: string; joined: number; left: number; avg: number; now_n: number; then_n: number }>(
      this.pool,
      `SELECT b.name AS branch, SUM(h.new_member_count) AS joined, SUM(h.closed_member_count) AS \`left\`, AVG(h.member_count) AS avg,
         SUM(CASE WHEN h.month_end = ? THEN h.member_count ELSE 0 END) AS now_n,
         (SELECT SUM(x.member_count) FROM hist_party_month x WHERE x.branch_id = h.branch_id AND x.month_end = DATE_SUB(?, INTERVAL 12 MONTH)) AS then_n
       FROM hist_party_month h JOIN cdm_location b ON b.int_id = h.branch_id
       WHERE h.month_end > LAST_DAY(DATE_SUB(?, INTERVAL 12 MONTH))${w}
       GROUP BY b.name, h.branch_id ORDER BY b.int_id`,
      [end, end, end],
    );
    return data.map((r) => ({ branch: r.branch, members: Number(r.now_n), joined: Number(r.joined), left: Number(r.left), net: Number(r.joined) - Number(r.left), netGrowthPct: pct(Number(r.now_n) - Number(r.then_n ?? r.now_n), Number(r.then_n ?? r.now_n)), attritionPct: pct(Number(r.left), Number(r.avg)) }));
  }

  /** Why members left over the last twelve months, and how long they had been members. */
  async exits(scope: MembershipScope = {}) {
    const w = await this.where(scope, 'x');
    const [last] = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_party_month');
    const end = day(last!.m);
    const data = await rows<{ reason: string; n: number; firstYear: number }>(
      this.pool,
      `SELECT x.reason, COUNT(*) AS n, SUM(DATEDIFF(x.close_date, x.join_date) < 366) AS firstYear FROM cdm_membership_exit x
       WHERE x.close_date > LAST_DAY(DATE_SUB(?, INTERVAL 12 MONTH)) AND x.close_date <= ?${w} GROUP BY x.reason ORDER BY n DESC`,
      [end, end],
    );
    const total = data.reduce((s, r) => s + Number(r.n), 0);
    const firstYear = data.reduce((s, r) => s + Number(r.firstYear), 0);
    return { total, firstYearPct: pct(firstYear, total), reasons: data.map((r) => ({ reason: r.reason, count: Number(r.n), pct: pct(Number(r.n), total) })) };
  }

  /** Relationship depth at the latest month-end: overall, by branch and by age band, with a year earlier. */
  async penetration(scope: MembershipScope = {}) {
    const w = await this.where(scope, 'h');
    const [last] = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_member_month');
    const end = day(last!.m);
    type Row = { m: number; c: number; l: number; dd: number; dg: number; p: number };
    const [now] = await rows<Row>(this.pool, `SELECT ${DEPTH_SQL} FROM hist_member_month h WHERE h.month_end = ?${w}`, [end]);
    const [then] = await rows<Row>(this.pool, `SELECT ${DEPTH_SQL} FROM hist_member_month h WHERE h.month_end = LAST_DAY(DATE_SUB(?, INTERVAL 12 MONTH))${w}`, [end]);
    const byBranch = await rows<Row & { branch: string }>(this.pool, `SELECT b.name AS branch, ${DEPTH_SQL} FROM hist_member_month h JOIN cdm_location b ON b.int_id = h.branch_id WHERE h.month_end = ?${w} GROUP BY b.name, b.int_id ORDER BY b.int_id`, [end]);
    const byAge = await rows<Row & { band: string }>(this.pool, `SELECT h.age_band AS band, ${DEPTH_SQL} FROM hist_member_month h WHERE h.month_end = ?${w} GROUP BY h.age_band`, [end]);
    const trend = await rows<Row & { me: unknown }>(this.pool, `SELECT h.month_end AS me, ${DEPTH_SQL} FROM hist_member_month h WHERE 1 = 1${w} GROUP BY h.month_end ORDER BY h.month_end`);
    return {
      month: end,
      label: label(end),
      now: depth(now!),
      yearAgo: then && Number(then.m) ? depth(then) : null,
      branches: byBranch.map((r) => ({ branch: r.branch, ...depth(r) })),
      ages: MEMBER_AGE_BANDS.map((band) => byAge.find((r) => r.band === band)).filter((r): r is Row & { band: string } => !!r).map((r) => ({ band: r.band, ...depth(r) })),
      trend: trend.map((r) => ({ month: day(r.me), label: label(day(r.me)), ...depth(r) })),
    };
  }

  /** Members who joined in the last year: how many already left, and how deep their relationships are. */
  async newMembers(scope: MembershipScope = {}) {
    const w = await this.where(scope, 'p');
    const wx = await this.where(scope, 'x');
    const [last] = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_party_month');
    const end = day(last!.m);
    const [stay] = await rows<{ n: number; checking: number; loan: number; products: number }>(
      this.pool,
      `SELECT COUNT(*) AS n,
         SUM(EXISTS (SELECT 1 FROM cdm_deposit_account d WHERE d.party_id = p.party_id AND d.deposit_category = 'Checking' AND d.close_date IS NULL)) AS checking,
         SUM(EXISTS (SELECT 1 FROM cdm_loan l WHERE l.party_id = p.party_id AND l.close_date IS NULL AND l.charge_off_date IS NULL)) AS loan,
         SUM((SELECT COUNT(DISTINCT d.deposit_category) FROM cdm_deposit_account d WHERE d.party_id = p.party_id AND d.close_date IS NULL) + (SELECT COUNT(DISTINCT l.loan_category) FROM cdm_loan l WHERE l.party_id = p.party_id AND l.close_date IS NULL AND l.charge_off_date IS NULL)) AS products
       FROM cdm_party p WHERE p.is_member = 1 AND p.join_date > DATE_SUB(?, INTERVAL 12 MONTH) AND p.join_date <= ?${w.replace('.branch_id', '.primary_branch_id')}`,
      [end, end],
    );
    const [gone] = await rows<{ n: number }>(this.pool, `SELECT COUNT(*) AS n FROM cdm_membership_exit x WHERE x.join_date > DATE_SUB(?, INTERVAL 12 MONTH) AND x.close_date <= ?${wx}`, [end, end]);
    const n = Number(stay!.n);
    const left = Number(gone!.n);
    return { joined: n + left, stayed: n, left, leftPct: pct(left, n + left), checking: pct(Number(stay!.checking), n), loan: pct(Number(stay!.loan), n), productsPerMember: n ? Number(stay!.products) / n : 0 };
  }
}
