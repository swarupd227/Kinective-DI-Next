// Loan officer production: for each loan officer in view, the last 90 days of applications, decisions,
// approvals and their dollars, approval rate and days from application to decision, the pipeline still
// open, the book they originated and its delinquency, and their funded-dollars goal.
// And how long applications spend in each stage, for where the pipeline slows. As of the build.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const n = (v: unknown) => Number(v ?? 0);

export const WINDOW_DAYS = 90;
const DECISIONS = ['APPROVED', 'AUTO_APPROVED', 'DENIED_DM'];

export interface OfficerLine {
  employeeId: number;
  name: string;
  branch: string;
  applications: number;
  decided: number;
  approved: number;
  approvedDollars: number;
  approvalPct: number;
  daysToDecision: number | null;
  open: number;
  openDollars: number;
  funded: number;
  fundedDollars: number;
  portfolio: number;
  dq30Pct: number;
  dq60Pct: number;
}

export class LendingProductionService {
  constructor(private readonly pool: Pool) {}

  private async asOf() {
    const [b] = await rows<{ d: unknown }>(this.pool, "SELECT MAX(as_of_date) AS d FROM meta_build WHERE state = 'completed'");
    return day(b?.d);
  }

  async officers(scope: { branches?: string[] } = {}) {
    const asOf = await this.asOf();
    const since = new Date(Date.parse(`${asOf}T00:00:00Z`) - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const staff = (await rows<{ id: number; name: string; branch: string }>(this.pool, "SELECT e.employee_id AS id, e.display_name AS name, l.name AS branch FROM cdm_employee e JOIN cdm_location l ON l.int_id = e.branch_id WHERE e.role = 'Loan officer' ORDER BY l.int_id, e.employee_id")).filter((s) => !scope.branches || scope.branches.includes(s.branch));
    const ids = staff.map((s) => s.id);
    if (!ids.length) return { asOf, since, lines: [] as OfficerLine[] };
    const apps = new Map((await rows<{ id: number; apps: number; decided: number; approved: number; approvedAmt: number; open: number; openAmt: number }>(
      this.pool,
      `SELECT owner_employee_id AS id, SUM(applied_date >= ?) AS apps, SUM(applied_date >= ? AND decided_date IS NOT NULL) AS decided, SUM(applied_date >= ? AND status_group = 'Approved') AS approved, SUM(CASE WHEN applied_date >= ? AND status_group = 'Approved' THEN amount ELSE 0 END) AS approvedAmt,
         SUM(decided_date IS NULL AND status_group = 'Pending') AS open, SUM(CASE WHEN decided_date IS NULL AND status_group = 'Pending' THEN amount ELSE 0 END) AS openAmt
       FROM cdm_loan_application WHERE owner_employee_id IN (?) AND is_duplicate = 0 GROUP BY owner_employee_id`,
      [since, since, since, since, ids],
    )).map((r) => [r.id, r]));
    // Days from application to its first decision, for applications decided in the window.
    const timing = new Map((await rows<{ id: number; d: number }>(
      this.pool,
      `SELECT a.owner_employee_id AS id, AVG(DATEDIFF(h.entered_date, a.applied_date)) AS d
       FROM cdm_loan_application a JOIN (SELECT application_id, MIN(entered_date) AS entered_date FROM cdm_loan_app_status_history WHERE status_code IN (?) GROUP BY application_id) h ON h.application_id = a.application_id
       WHERE a.owner_employee_id IN (?) AND h.entered_date >= ? GROUP BY a.owner_employee_id`,
      [DECISIONS, ids, since],
    )).map((r) => [r.id, n(r.d)]));
    const book = new Map((await rows<{ id: number; funded: number; fundedAmt: number; bal: number; d30: number; d60: number }>(
      this.pool,
      `SELECT officer_id AS id, SUM(open_date >= ?) AS funded, SUM(CASE WHEN open_date >= ? THEN original_amount ELSE 0 END) AS fundedAmt,
         SUM(CASE WHEN close_date IS NULL AND charge_off_date IS NULL THEN balance ELSE 0 END) AS bal,
         SUM(CASE WHEN close_date IS NULL AND charge_off_date IS NULL AND days_delinquent >= 30 THEN balance ELSE 0 END) AS d30,
         SUM(CASE WHEN close_date IS NULL AND charge_off_date IS NULL AND days_delinquent >= 60 THEN balance ELSE 0 END) AS d60
       FROM cdm_loan WHERE officer_id IN (?) GROUP BY officer_id`,
      [since, since, ids],
    )).map((r) => [r.id, r]));
    const lines: OfficerLine[] = staff.map((s) => {
      const a = apps.get(s.id);
      const b = book.get(s.id);
      return {
        employeeId: s.id,
        name: s.name,
        branch: s.branch,
        applications: n(a?.apps),
        decided: n(a?.decided),
        approved: n(a?.approved),
        approvedDollars: n(a?.approvedAmt),
        approvalPct: pct(n(a?.approved), n(a?.decided)),
        daysToDecision: timing.has(s.id) ? timing.get(s.id)! : null,
        open: n(a?.open),
        openDollars: n(a?.openAmt),
        funded: n(b?.funded),
        fundedDollars: n(b?.fundedAmt),
        portfolio: n(b?.bal),
        dq30Pct: pct(n(b?.d30), n(b?.bal)),
        dq60Pct: pct(n(b?.d60), n(b?.bal)),
      };
    });
    return { asOf, since, lines };
  }

  /** Average days an application spends in each stage before it moves on, over the window. */
  async stages(scope: { branches?: string[] } = {}) {
    const asOf = await this.asOf();
    const since = new Date(Date.parse(`${asOf}T00:00:00Z`) - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const branchIds = scope.branches ? (await rows<{ id: number }>(this.pool, 'SELECT int_id AS id FROM cdm_location WHERE name IN (?)', [scope.branches.length ? scope.branches : ['']])).map((r) => r.id) : null;
    const hist = await rows<{ app: number; code: string; at: unknown }>(
      this.pool,
      `SELECT h.application_id AS app, h.status_code AS code, h.entered_date AS at FROM cdm_loan_app_status_history h JOIN cdm_loan_application a ON a.application_id = h.application_id
       WHERE a.applied_date >= ?${branchIds ? ` AND a.branch_id IN (${branchIds.length ? branchIds.join(',') : '0'})` : ''} ORDER BY h.application_id, h.entered_date`,
      [since],
    );
    const [labels] = await this.pool.query('SELECT status_code, label, stall_days FROM mod_lap_status_map').catch(() => [[]]);
    const label = new Map((labels as { status_code: string; label: string; stall_days: number | null }[]).map((l) => [l.status_code, l]));
    const spent = new Map<string, number[]>();
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i]!;
      const next = hist[i + 1];
      if (DECISIONS.includes(h.code) || h.code === 'WITHDRAWN') continue;
      // A stage ends when the next one starts; one still open runs to the build date.
      const endAt = next && next.app === h.app ? day(next.at) : asOf;
      const days = Math.max(0, (Date.parse(`${endAt}T00:00:00Z`) - Date.parse(`${day(h.at)}T00:00:00Z`)) / 86_400_000);
      (spent.get(h.code) ?? spent.set(h.code, []).get(h.code)!).push(days);
    }
    const ORDER = ['RECEIVED', 'DOCUMENTS', 'UNDERWRITING', 'COUNTER'];
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)]! : 0;
    };
    return {
      asOf,
      since,
      stages: ORDER.filter((c) => spent.has(c)).map((c) => {
        const xs = spent.get(c)!;
        const l = label.get(c);
        return { code: c, label: l?.label ?? c, applications: xs.length, averageDays: xs.reduce((a, b) => a + b, 0) / xs.length, medianDays: median(xs), overThreshold: l?.stall_days ? xs.filter((x) => x > l.stall_days!).length : 0, thresholdDays: l?.stall_days ?? null };
      }),
    };
  }
}
