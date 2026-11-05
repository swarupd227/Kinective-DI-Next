// The branch scorecard a branch manager runs the month on: balances and their 12-month growth,
// accounts opened and closed, new loans funded, members joined and lost, 60+ delinquency, referrals
// sold, onboarding touchpoints done on time and results per person, for each branch in view, with
// the institution alongside. The team's goals come from Goals & Incentives.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);

export interface BranchLine {
  branch: string;
  loans: number;
  loanGrowthPct: number;
  deposits: number;
  depositGrowthPct: number;
  accountsOpened: number;
  accountsClosed: number;
  checkingOpened: number;
  loansFunded: number;
  loanDollarsFunded: number;
  joined: number;
  left: number;
  attritionPct: number;
  dq60Pct: number;
  referralsSold: number;
  referralsOpen: number;
  /** Touchpoints due by the build that are done. */
  onboardingOnTimePct: number;
  onboardingOverdue: number;
  staff: number;
  accountsPerStaff: number;
}

export class BranchScorecardService {
  constructor(private readonly pool: Pool) {}

  async scorecard(scope: { branches?: string[] } = {}) {
    const [m] = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_loan_month');
    const end = day(m!.m);
    const start = `${end.slice(0, 7)}-01`;
    const yearAgo = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_loan_month WHERE month_end <= DATE_SUB(?, INTERVAL 12 MONTH)', [end]);
    const then = day(yearAgo[0]?.m ?? end);
    const [period] = await rows<{ p: unknown }>(this.pool, 'SELECT MAX(period_end) AS p FROM mod_gi_period').catch(() => [{ p: null }]);
    const gi = period?.p ? day(period.p) : null;
    const [build] = await rows<{ d: unknown }>(this.pool, "SELECT MAX(as_of_date) AS d FROM meta_build WHERE state = 'completed'");
    const asOf = day(build?.d ?? end);
    const by = async <T extends { b: string }>(sql: string, params: unknown[] = []) => new Map((await rows<T>(this.pool, sql, params)).map((r) => [r.b, r]));

    const branches = (await rows<{ b: string; id: number }>(this.pool, 'SELECT name AS b, int_id AS id FROM cdm_location ORDER BY int_id')).filter((x) => !scope.branches || scope.branches.includes(x.b));
    const loans = await by<{ b: string; now: number; was: number; dq: number; n: number; amt: number }>(
      `SELECT l.name AS b, SUM(CASE WHEN h.month_end = ? THEN h.balance ELSE 0 END) AS now, SUM(CASE WHEN h.month_end = ? THEN h.balance ELSE 0 END) AS was,
         SUM(CASE WHEN h.month_end = ? THEN h.delinquent_60_balance ELSE 0 END) AS dq, SUM(CASE WHEN h.month_end = ? THEN h.new_loan_count ELSE 0 END) AS n, SUM(CASE WHEN h.month_end = ? THEN h.new_loan_amount ELSE 0 END) AS amt
       FROM hist_loan_month h JOIN cdm_location l ON l.int_id = h.branch_id GROUP BY l.name`,
      [end, then, end, end, end],
    );
    const deps = await by<{ b: string; now: number; was: number }>(`SELECT l.name AS b, SUM(CASE WHEN h.month_end = ? THEN h.balance ELSE 0 END) AS now, SUM(CASE WHEN h.month_end = ? THEN h.balance ELSE 0 END) AS was FROM hist_deposit_month h JOIN cdm_location l ON l.int_id = h.branch_id GROUP BY l.name`, [end, then]);
    const accounts = await by<{ b: string; opened: number; closed: number; checking: number }>(
      `SELECT l.name AS b, SUM(d.open_date BETWEEN ? AND ?) AS opened, SUM(d.close_date BETWEEN ? AND ?) AS closed, SUM(d.open_date BETWEEN ? AND ? AND d.deposit_category = 'Checking') AS checking
       FROM cdm_deposit_account d JOIN cdm_location l ON l.int_id = d.branch_id GROUP BY l.name`,
      [start, end, start, end, start, end],
    );
    const members = await by<{ b: string; joined: number; left: number; left12: number; avg: number }>(
      `SELECT l.name AS b, SUM(CASE WHEN h.month_end = ? THEN h.new_member_count ELSE 0 END) AS joined, SUM(CASE WHEN h.month_end = ? THEN h.closed_member_count ELSE 0 END) AS \`left\`,
         SUM(CASE WHEN h.month_end > ? THEN h.closed_member_count ELSE 0 END) AS left12, AVG(CASE WHEN h.month_end > ? THEN h.member_count END) AS avg
       FROM hist_party_month h JOIN cdm_location l ON l.int_id = h.branch_id GROUP BY l.name`,
      [end, end, then, then],
    );
    const referrals = gi
      ? await by<{ b: string; sold: number; open: number }>(
          `SELECT l.name AS b, SUM(CASE WHEN c.state = 'counted' THEN c.value ELSE 0 END) AS sold, SUM(CASE WHEN c.state = 'active' THEN c.value ELSE 0 END) AS open
           FROM cdm_gi_credit c JOIN cdm_employee e ON e.employee_id = c.employee_id JOIN cdm_location l ON l.int_id = e.branch_id WHERE c.goal_id = 'REFERRALS' AND c.period_end = ? GROUP BY l.name`,
          [gi],
        ).catch(() => new Map())
      : new Map();
    const onboarding = await by<{ b: string; due: number; onTime: number; overdue: number }>(
      `SELECT l.name AS b, SUM(t.due <= ?) AS due, SUM(t.due <= ? AND t.status = 'Done') AS onTime, SUM(t.due < ? AND t.status <> 'Done') AS overdue
       FROM onb_task t JOIN cdm_location l ON l.int_id = t.branch_id GROUP BY l.name`,
      [asOf, asOf, asOf],
    ).catch(() => new Map());
    const staff = await by<{ b: string; n: number }>('SELECT l.name AS b, COUNT(*) AS n FROM cdm_employee e JOIN cdm_location l ON l.int_id = e.branch_id GROUP BY l.name');

    const n = (v: unknown) => Number(v ?? 0);
    const lines: BranchLine[] = branches.map(({ b }) => {
      const L = loans.get(b);
      const D = deps.get(b);
      const A = accounts.get(b);
      const M = members.get(b);
      const R = referrals.get(b) as { sold: number; open: number } | undefined;
      const O = onboarding.get(b) as { due: number; onTime: number; overdue: number } | undefined;
      const s = n(staff.get(b)?.n);
      return {
        branch: b,
        loans: n(L?.now),
        loanGrowthPct: pct(n(L?.now) - n(L?.was), n(L?.was)),
        deposits: n(D?.now),
        depositGrowthPct: pct(n(D?.now) - n(D?.was), n(D?.was)),
        accountsOpened: n(A?.opened),
        accountsClosed: n(A?.closed),
        checkingOpened: n(A?.checking),
        loansFunded: n(L?.n),
        loanDollarsFunded: n(L?.amt),
        joined: n(M?.joined),
        left: n(M?.left),
        attritionPct: pct(n(M?.left12), n(M?.avg)),
        dq60Pct: pct(n(L?.dq), n(L?.now)),
        referralsSold: n(R?.sold),
        referralsOpen: n(R?.open),
        onboardingOnTimePct: pct(n(O?.onTime), n(O?.due)),
        onboardingOverdue: n(O?.overdue),
        staff: s,
        accountsPerStaff: s ? n(A?.opened) / s : 0,
      };
    });
    const sum = (k: keyof BranchLine) => lines.reduce((t, l) => t + (l[k] as number), 0);
    const monthLabel = new Date(`${end}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    return { end, monthLabel, lines, totals: { accountsOpened: sum('accountsOpened'), accountsClosed: sum('accountsClosed'), loansFunded: sum('loansFunded'), joined: sum('joined'), left: sum('left') } };
  }
}
