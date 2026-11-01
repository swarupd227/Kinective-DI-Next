// Loan Application Pipeline (spec 17.5, 24.18). Views, summaries, stall detection and the status map
// are decided here, never by a client or an agent. Days in status run to the last LOS load, because
// the feed is nightly. Without Application Details access, answers are counts and dollars only.
import type { Pool } from '@dinext/tenant-db';
import { CoreError, memberNumber, type CoreContext } from './referrals.ts';

export const PIPELINE_VIEWS = ['mine', 'location', 'team', 'institution'] as const;
export type PipelineView = (typeof PIPELINE_VIEWS)[number];

/** How far back finished applications count in the summary [Assumption]: until a tenant sets its default. */
export const SUMMARY_WINDOW_DAYS = 90;

export interface PipelineWho {
  employeeId?: number;
  /** Looks after a team of lenders. */
  leads?: boolean;
  /** Application Details in the module access matrix (FE-LAP-004). */
  details: boolean;
}

export interface PipelineApplication {
  applicationId: number;
  partyId: number;
  name: string;
  lastName: string;
  last4: string;
  product: string;
  amount: number;
  statusCode: string;
  status: string;
  group: string;
  open: boolean;
  applied: string;
  decided: string | null;
  daysInStatus: number;
  /** The stall threshold for this status and product, in days; null when the status has none. */
  threshold: number | null;
  stalled: boolean;
  owner: { employeeId: number; name: string } | null;
  branch: string;
  /** What it's waiting on, when the LOS records it. Only open applications have one. */
  hold: { label: string; waitingOn: string; nextStep: string; days: number } | null;
}

export interface PipelineCell {
  count: number;
  pct: number;
  dollars: number;
  avgDays: number;
}

export interface PipelineSummary {
  view: PipelineView;
  asOf: string;
  /** The LOS feed missed the last build; figures are from this earlier load. */
  stale: boolean;
  windowDays: number;
  /** Reporting groups in the tenant's order, with the tenant's names (FE-LAP-002). */
  groups: string[];
  funnel: (PipelineCell & { group: string })[];
  products: { product: string; total: PipelineCell; cells: Record<string, PipelineCell> }[];
  open: { count: number; dollars: number };
  stalled: { count: number; dollars: number; oldestDays: number };
}

export interface PipelineFilter {
  view: PipelineView;
  status?: string;
  group?: string;
  product?: string;
  stalledOnly?: boolean;
  /** More than this many days in the current status. */
  minDays?: number;
  minAmount?: number;
  /** Part of a hold reason or of who it's waiting on. */
  waitingOn?: string;
  /** Open applications only, unless a finished group or status is asked for. */
  includeFinished?: boolean;
}

export interface PipelineFound {
  asOf: string;
  stale: boolean;
  view: PipelineView;
  count: number;
  dollars: number;
  oldestDays: number;
  byProduct: { product: string; count: number; dollars: number }[];
  /** Counts by who each is waiting on, largest first. Counts only, so totals-only roles see them. */
  holds: { waitingOn: string; count: number }[];
  /** Empty without Application Details access. */
  items: PipelineApplication[];
  detailsHidden: boolean;
}

export interface PipelineStatus {
  code: string;
  label: string;
  definition: string;
  inProgress: boolean;
  visible: boolean;
  group: string;
  stallDays: number | null;
  /** Thresholds that differ by product. */
  products: { product: string; days: number }[];
}

const day = (v: unknown) => String(v).slice(0, 10);
const between = (from: string, to: string) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
const has = (text: string, part: string) => text.toLowerCase().includes(part.toLowerCase());

const APP_SQL = `SELECT a.application_id, a.party_id, a.product, a.amount, a.status_code, a.status_since, a.applied_date, a.decided_date, a.owner_employee_id,
    p.first_name, p.last_name, b.name AS branch, e.display_name AS owner_name, s.label, s.reporting_group, s.in_progress,
    hr.label AS hold_label, hr.waiting_on, hr.next_step, ah.since_date AS hold_since
  FROM cdm_loan_application a JOIN cdm_party p ON p.party_id = a.party_id JOIN cdm_location b ON b.int_id = a.branch_id
  JOIN mod_lap_status_map s ON s.status_code = a.status_code LEFT JOIN cdm_employee e ON e.employee_id = a.owner_employee_id
  LEFT JOIN cdm_loan_app_hold ah ON ah.application_id = a.application_id LEFT JOIN mod_lap_hold_reason hr ON hr.hold_code = ah.hold_code`;

export class PipelineService {
  constructor(private readonly pool: Pool) {}

  /** The view selector: only views the user's purview and role support (FE-LAP-001). */
  async views(who: PipelineWho, ctx: CoreContext): Promise<PipelineView[]> {
    const views: PipelineView[] = [];
    if (who.employeeId !== undefined && !who.leads) {
      const [rows] = await this.pool.query("SELECT 1 FROM cdm_employee WHERE employee_id = ? AND role = 'Loan officer'", [who.employeeId]);
      if ((rows as unknown[]).length) views.push('mine');
    }
    if (ctx.purviewBranches?.length) views.push('location');
    if (who.leads) views.push('team');
    if (!ctx.purviewBranches) views.push('institution');
    return views;
  }

  /** Scope is a filter here, not in the client (BE-LAP-002). A view not offered is refused. */
  private async scope(view: PipelineView, who: PipelineWho, ctx: CoreContext) {
    if (!(await this.views(who, ctx)).includes(view)) throw new CoreError('NO_ACCESS', 'That pipeline view isn’t available to you.');
    const where: string[] = [];
    const params: unknown[] = [];
    if (ctx.purviewBranches) {
      where.push('b.name IN (?)');
      params.push(ctx.purviewBranches.length ? ctx.purviewBranches : ['']);
    }
    if (view === 'mine') {
      where.push('a.owner_employee_id = ?');
      params.push(who.employeeId);
    }
    if (view === 'team') where.push("e.role = 'Loan officer'");
    return { where, params };
  }

  /** The last LOS load, and whether the last build went without it (spec 24.18). */
  async freshness() {
    const [b] = await this.pool.query("SELECT as_of_date FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
    const [l] = await this.pool.query("SELECT load_date FROM meta_lap_load WHERE state = 'completed' ORDER BY load_date DESC LIMIT 1");
    const build = day((b as { as_of_date: unknown }[])[0]?.as_of_date);
    const load = (l as { load_date: unknown }[])[0];
    const asOf = load ? day(load.load_date) : build;
    return { asOf, stale: !load || asOf < build };
  }

  private async thresholds() {
    const [rows] = await this.pool.query('SELECT status_code, product, days FROM mod_lap_stall_threshold');
    return new Map((rows as { status_code: string; product: string; days: number }[]).map((t) => [`${t.status_code}|${t.product}`, t.days]));
  }

  async statuses(): Promise<PipelineStatus[]> {
    const [rows] = await this.pool.query('SELECT * FROM mod_lap_status_map ORDER BY sort_order');
    const [over] = await this.pool.query('SELECT status_code, product, days FROM mod_lap_stall_threshold ORDER BY product');
    return (rows as Record<string, unknown>[]).map((s) => ({
      code: s.status_code as string,
      label: s.label as string,
      definition: s.definition as string,
      inProgress: s.in_progress === 1,
      visible: s.visible === 1,
      group: s.reporting_group as string,
      stallDays: (over as { status_code: string; product: string; days: number }[]).find((t) => t.status_code === s.status_code && !t.product)?.days ?? (s.stall_days as number | null),
      products: (over as { status_code: string; product: string; days: number }[]).filter((t) => t.status_code === s.status_code && t.product).map((t) => ({ product: t.product, days: t.days })),
    }));
  }

  private toApplication(r: Record<string, unknown>, asOf: string, statuses: PipelineStatus[], over: Map<string, number>): PipelineApplication {
    const code = r.status_code as string;
    const product = r.product as string;
    const open = r.in_progress === 1;
    const threshold = open ? (over.get(`${code}|${product}`) ?? over.get(`${code}|`) ?? statuses.find((s) => s.code === code)?.stallDays ?? null) : null;
    const daysInStatus = between(day(r.status_since), asOf);
    return {
      applicationId: r.application_id as number,
      partyId: r.party_id as number,
      name: `${r.first_name} ${r.last_name}`,
      lastName: r.last_name as string,
      last4: memberNumber(r.party_id as number).slice(-4),
      product,
      amount: Number(r.amount),
      statusCode: code,
      status: r.label as string,
      group: r.reporting_group as string,
      open,
      applied: day(r.applied_date),
      decided: r.decided_date ? day(r.decided_date) : null,
      daysInStatus,
      threshold,
      stalled: threshold !== null && daysInStatus > threshold,
      owner: r.owner_employee_id && r.owner_name ? { employeeId: r.owner_employee_id as number, name: r.owner_name as string } : null,
      branch: r.branch as string,
      hold: open && r.hold_label ? { label: r.hold_label as string, waitingOn: r.waiting_on as string, nextStep: r.next_step as string, days: between(day(r.hold_since), asOf) } : null,
    };
  }

  /** Visible, counted applications in a view: duplicates and hidden statuses never appear. */
  private async rows(view: PipelineView, who: PipelineWho, ctx: CoreContext, asOf: string, extra: string[] = [], extraParams: unknown[] = []) {
    const { where, params } = await this.scope(view, who, ctx);
    const [statuses, over] = [await this.statuses(), await this.thresholds()];
    const [rows] = await this.pool.query(`${APP_SQL} WHERE s.visible = 1 AND a.is_duplicate = 0${[...where, ...extra].map((w) => ` AND ${w}`).join('')}`, [...params, ...extraParams]);
    return { statuses, apps: (rows as Record<string, unknown>[]).map((r) => this.toApplication(r, asOf, statuses, over)), asOf };
  }

  private cell(apps: PipelineApplication[], total: number, asOf: string): PipelineCell {
    const days = apps.map((a) => between(a.applied, a.decided ?? asOf));
    return {
      count: apps.length,
      pct: total ? Math.round((apps.length / total) * 1000) / 10 : 0,
      dollars: apps.reduce((s, a) => s + a.amount, 0),
      avgDays: days.length ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : 0,
    };
  }

  /** The funnel and Pipeline By Product (FE-LAP-003): counts, percent, dollars and average days. */
  async summary(view: PipelineView, who: PipelineWho, ctx: CoreContext): Promise<PipelineSummary> {
    const { asOf, stale } = await this.freshness();
    const { apps, statuses } = await this.rows(view, who, ctx, asOf, ['(s.in_progress = 1 OR a.applied_date >= ? - INTERVAL ? DAY)'], [asOf, SUMMARY_WINDOW_DAYS]);
    const groups = [...new Set(statuses.filter((s) => s.visible).map((s) => s.group))];
    const stalled = apps.filter((a) => a.stalled);
    const open = apps.filter((a) => a.open);
    const productNames = [...new Set(apps.map((a) => a.product))].sort((a, b) => apps.filter((x) => x.product === b).length - apps.filter((x) => x.product === a).length || a.localeCompare(b));
    return {
      view,
      asOf,
      stale,
      windowDays: SUMMARY_WINDOW_DAYS,
      groups,
      funnel: groups.map((group) => ({ group, ...this.cell(apps.filter((a) => a.group === group), apps.length, asOf) })),
      products: productNames.map((product) => {
        const mine = apps.filter((a) => a.product === product);
        return { product, total: this.cell(mine, apps.length, asOf), cells: Object.fromEntries(groups.map((g) => [g, this.cell(mine.filter((a) => a.group === g), mine.length, asOf)])) };
      }),
      open: { count: open.length, dollars: open.reduce((s, a) => s + a.amount, 0) },
      stalled: { count: stalled.length, dollars: stalled.reduce((s, a) => s + a.amount, 0), oldestDays: Math.max(0, ...stalled.map((a) => a.daysInStatus)) },
    };
  }

  /** lap.application.list and list_stalled. Stalled first, then longest in status. */
  async find(f: PipelineFilter, who: PipelineWho, ctx: CoreContext): Promise<PipelineFound> {
    const { asOf, stale } = await this.freshness();
    const finished = f.includeFinished || f.group !== undefined;
    const { apps } = await this.rows(f.view, who, ctx, asOf, finished ? ['(s.in_progress = 1 OR a.applied_date >= ? - INTERVAL ? DAY)'] : ['s.in_progress = 1'], finished ? [asOf, SUMMARY_WINDOW_DAYS] : []);
    const hits = apps
      .filter((a) => (!f.status || has(a.status, f.status)) && (!f.group || has(a.group, f.group)) && (!f.product || has(a.product, f.product)) && (!f.stalledOnly || a.stalled) && (f.minDays === undefined || a.daysInStatus > f.minDays) && (f.minAmount === undefined || a.amount > f.minAmount) && (!f.waitingOn || (a.hold !== null && has(`${a.hold.label} ${a.hold.waitingOn}`, f.waitingOn))))
      .sort((a, b) => Number(b.stalled) - Number(a.stalled) || b.daysInStatus - a.daysInStatus);
    const products = new Map<string, { product: string; count: number; dollars: number }>();
    for (const a of hits) {
      const p = products.get(a.product) ?? { product: a.product, count: 0, dollars: 0 };
      p.count += 1;
      p.dollars += a.amount;
      products.set(a.product, p);
    }
    const waiting = new Map<string, number>();
    for (const { hold } of hits) if (hold) waiting.set(hold.waitingOn, (waiting.get(hold.waitingOn) ?? 0) + 1);
    const holds = [...waiting].map(([waitingOn, count]) => ({ waitingOn, count })).sort((a, b) => b.count - a.count);
    return { asOf, stale, view: f.view, holds, count: hits.length, dollars: hits.reduce((s, a) => s + a.amount, 0), oldestDays: Math.max(0, ...hits.map((a) => a.daysInStatus)), byProduct: [...products.values()].sort((a, b) => b.count - a.count), items: who.details ? hits : [], detailsHidden: !who.details };
  }

  /** One application with its path through the statuses. Outside the purview it reads as not found. */
  async application(applicationId: number, who: PipelineWho, ctx: CoreContext) {
    if (!who.details) throw new CoreError('NO_ACCESS', 'Your access shows pipeline totals, not application details.');
    const { asOf, stale } = await this.freshness();
    const [statuses, over] = [await this.statuses(), await this.thresholds()];
    const [rows] = await this.pool.query(`${APP_SQL} WHERE a.application_id = ? AND s.visible = 1`, [applicationId]);
    const row = (rows as Record<string, unknown>[])[0];
    const app = row && this.toApplication(row, asOf, statuses, over);
    if (!app || (ctx.purviewBranches && !ctx.purviewBranches.includes(app.branch))) throw new CoreError('NOT_FOUND', `Application #${applicationId} was not found.`);
    const [hist] = await this.pool.query('SELECT h.status_code, h.entered_date, COALESCE(s.label, h.status_code) AS label FROM cdm_loan_app_status_history h LEFT JOIN mod_lap_status_map s ON s.status_code = h.status_code WHERE h.application_id = ? ORDER BY h.entered_date, h.status_code = ? ', [applicationId, app.statusCode]);
    return { ...app, asOf, stale, history: (hist as { label: string; entered_date: unknown }[]).map((h) => ({ status: h.label, at: day(h.entered_date) })) };
  }

  async products() {
    const [rows] = await this.pool.query('SELECT DISTINCT product FROM cdm_loan_application ORDER BY product');
    return (rows as { product: string }[]).map((r) => r.product);
  }

  /** lap.status_config: sets a threshold from the next read on, for one product or the whole status. */
  async setThreshold(t: { code: string; product?: string; days: number }, meta: { userId: string }) {
    if (!Number.isInteger(t.days) || t.days < 1 || t.days > 90) throw new CoreError('INVALID', 'A threshold is a whole number of days, from 1 to 90.');
    const status = (await this.statuses()).find((s) => s.code === t.code);
    if (!status?.inProgress) throw new CoreError('INVALID', 'Only statuses in progress have a stall threshold.');
    await this.pool.query('INSERT INTO mod_lap_stall_threshold (status_code, product, days, updated_by, updated_at) VALUES (?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE days = VALUES(days), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)', [t.code, t.product ?? '', t.days, meta.userId]);
  }
}
