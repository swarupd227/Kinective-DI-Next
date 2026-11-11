// Branch performance for a branch manager and the executives over them: the CEO's six branch measures
// against their targets (deposit growth, net loan growth, new members a month, products per member, NPS
// and 30+ delinquency), delinquency at 30, 60 and 90 days, digital adoption (mobile, e-statements,
// active debit cards), staff productivity per person, and the complaint log by branch.
//
// Each branch in the viewer's purview is shown beside the network: every branch taken together, so a
// branch manager can compare without seeing another branch by name.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const n = (v: unknown) => Number(v ?? 0);

export const NETWORK = 'Network';

/** The CEO's targets for every branch [Assumption: as the CEO set them; one set for all branches]. */
export const BRANCH_TARGETS = {
  depositGrowthPct: { low: 8, high: 12, label: 'Deposit growth, 12 months', target: '+8% to +12% a year' },
  loanGrowthPct: { low: 10, high: 15, label: 'Net loan growth, 12 months', target: '+10% to +15% a year' },
  newMembersPerMonth: { low: 25, high: 40, label: 'New members a month', target: '25 to 40 a month' },
  productsPerMember: { low: 3.5, high: 4.5, label: 'Products per member', target: '3.5 to 4.5' },
  nps: { low: 70, high: null, label: 'Net Promoter Score', target: '70 or more' },
  dq30Pct: { low: null, high: 0.75, label: 'Delinquency 30+', target: 'under 0.75%' },
} as const;
export type BranchMeasure = keyof typeof BRANCH_TARGETS;
export const BRANCH_MEASURES = Object.keys(BRANCH_TARGETS) as BranchMeasure[];
export type TargetStatus = 'below' | 'in range' | 'above';

/** Where a value sits against its target: below the range, in it, or above it. */
export function targetStatus(measure: BranchMeasure, value: number): TargetStatus {
  const t = BRANCH_TARGETS[measure];
  if (t.low !== null && value < t.low) return 'below';
  if (t.high !== null && value > t.high) return 'above';
  return 'in range';
}
/** Whether a status meets the target: above a growth range is met; above a ceiling is not. */
export const meetsTarget = (measure: BranchMeasure, status: TargetStatus) => status === 'in range' || (status === 'above' && BRANCH_TARGETS[measure].low !== null && BRANCH_TARGETS[measure].high !== null);

export interface BranchKpiLine {
  branch: string;
  depositGrowthPct: number;
  loanGrowthPct: number;
  newMembersPerMonth: number;
  newMembersLatest: number;
  productsPerMember: number;
  nps: number;
  npsResponses: number;
  dq30Pct: number;
}

export interface BranchDqLine {
  branch: string;
  balance: number;
  d30: number;
  d60: number;
  d90: number;
  loans30: number;
  ratio30: number;
  ratio60: number;
  ratio90: number;
}

export interface BranchDigitalLine {
  branch: string;
  members: number;
  mobilePct: number;
  onlinePct: number;
  estatementsPct: number;
  billPayPct: number;
  loggedIn90Pct: number;
  activeDebitPct: number;
  debitActivationPct: number;
  debitNotActivated: number;
}

export interface BranchProductivityLine {
  branch: string;
  staff: number;
  lenders: number;
  serviceStaff: number;
  loansFunded: number;
  accountsOpened: number;
  loansPerStaffMonth: number;
  loansPerLenderMonth: number;
  accountsPerStaffMonth: number;
}

export interface BranchComplaintLine {
  branch: string;
  open: number;
  openRegulatory: number;
  pastDue: number;
  closed12: number;
  avgDaysToClose: number | null;
  oldestOpenDays: number | null;
}

export interface OpenComplaint {
  issueId: number;
  branch: string;
  source: string;
  kind: string;
  category: string;
  summary: string;
  status: string;
  opened: string;
  ageDays: number;
  pastDue: boolean;
  owner: string | null;
}

type Scope = { branches?: string[] };

export class BranchKpiService {
  constructor(private readonly pool: Pool) {}

  /** Every branch's name, in branch order. */
  async branchNames() {
    return (await rows<{ b: string }>(this.pool, 'SELECT name AS b FROM cdm_location ORDER BY int_id')).map((r) => r.b);
  }

  private async branchList(scope: Scope) {
    const all = await rows<{ b: string; id: number }>(this.pool, 'SELECT name AS b, int_id AS id FROM cdm_location ORDER BY int_id');
    return all.filter((x) => !scope.branches || scope.branches.includes(x.b));
  }

  private async monthEnds() {
    const [m] = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_loan_month');
    const end = day(m!.m);
    const [y] = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_loan_month WHERE month_end <= DATE_SUB(?, INTERVAL 12 MONTH)', [end]);
    return { end, yearAgo: day(y?.m ?? end), label: new Date(`${end}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) };
  }

  /** The nightly build's date: "today" for surveys, complaints and logins. */
  async asOf() {
    const [b] = await rows<{ d: unknown }>(this.pool, "SELECT MAX(as_of_date) AS d FROM meta_build WHERE state = 'completed'");
    return b?.d ? day(b.d) : (await this.monthEnds()).end;
  }

  /** Lines for the branches in view, then the network (every branch together). */
  private withNetwork<T extends { branch: string }>(byBranch: Map<string, T>, branches: { b: string }[], network: T) {
    return { lines: branches.map(({ b }) => byBranch.get(b)).filter((l): l is T => !!l), network };
  }

  /** The CEO's six measures for each branch in view and for the network, with each one's status. */
  async targets(scope: Scope = {}) {
    const { end, yearAgo, label } = await this.monthEnds();
    const asOf = await this.asOf();
    const branches = await this.branchList(scope);
    type Raw = { b: string; dNow: number; dWas: number; lNow: number; lWas: number; joined12: number; months: number; joinedLatest: number; members: number; products: number; promoters: number; detractors: number; responses: number; dq30: number; open: number };
    const raw = new Map<string, Raw>();
    const get = (b: string) => {
      if (!raw.has(b)) raw.set(b, { b, dNow: 0, dWas: 0, lNow: 0, lWas: 0, joined12: 0, months: 0, joinedLatest: 0, members: 0, products: 0, promoters: 0, detractors: 0, responses: 0, dq30: 0, open: 0 });
      return raw.get(b)!;
    };
    for (const r of await rows<{ b: string; now: number; was: number }>(this.pool, 'SELECT l.name AS b, SUM(CASE WHEN h.month_end = ? THEN h.balance ELSE 0 END) AS now, SUM(CASE WHEN h.month_end = ? THEN h.balance ELSE 0 END) AS was FROM hist_deposit_month h JOIN cdm_location l ON l.int_id = h.branch_id WHERE h.month_end IN (?, ?) GROUP BY l.name', [end, yearAgo, end, yearAgo])) Object.assign(get(r.b), { dNow: n(r.now), dWas: n(r.was) });
    for (const r of await rows<{ b: string; now: number; was: number }>(this.pool, 'SELECT l.name AS b, SUM(CASE WHEN h.month_end = ? THEN h.balance ELSE 0 END) AS now, SUM(CASE WHEN h.month_end = ? THEN h.balance ELSE 0 END) AS was FROM hist_loan_month h JOIN cdm_location l ON l.int_id = h.branch_id WHERE h.month_end IN (?, ?) GROUP BY l.name', [end, yearAgo, end, yearAgo])) Object.assign(get(r.b), { lNow: n(r.now), lWas: n(r.was) });
    for (const r of await rows<{ b: string; joined: number; months: number; latest: number }>(this.pool, 'SELECT l.name AS b, SUM(h.new_member_count) AS joined, COUNT(DISTINCT h.month_end) AS months, SUM(CASE WHEN h.month_end = ? THEN h.new_member_count ELSE 0 END) AS latest FROM hist_party_month h JOIN cdm_location l ON l.int_id = h.branch_id WHERE h.month_end > ? AND h.month_end <= ? GROUP BY l.name', [end, yearAgo, end])) Object.assign(get(r.b), { joined12: n(r.joined), months: n(r.months), joinedLatest: n(r.latest) });
    const [pm] = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_member_month');
    for (const r of await rows<{ b: string; m: number; p: number }>(this.pool, 'SELECT l.name AS b, SUM(h.member_count) AS m, SUM(h.product_count) AS p FROM hist_member_month h JOIN cdm_location l ON l.int_id = h.branch_id WHERE h.month_end = ? GROUP BY l.name', [day(pm!.m)])) Object.assign(get(r.b), { members: n(r.m), products: n(r.p) });
    // NPS from the last 12 months of surveys (0 to 10): promoters score 9 or 10, detractors 0 to 6.
    for (const r of await rows<{ b: string; pro: number; det: number; k: number }>(this.pool, 'SELECT l.name AS b, SUM(s.score >= 9) AS pro, SUM(s.score <= 6) AS det, COUNT(*) AS k FROM cdm_survey s JOIN cdm_party p ON p.party_id = s.party_id JOIN cdm_location l ON l.int_id = p.primary_branch_id WHERE s.survey_date > DATE_SUB(?, INTERVAL 12 MONTH) AND s.survey_date <= ? GROUP BY l.name', [asOf, asOf]).catch(() => [])) Object.assign(get(r.b), { promoters: n(r.pro), detractors: n(r.det), responses: n(r.k) });
    const [dqm] = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_loan_dq_month');
    for (const r of await rows<{ b: string; dq: number; open: number }>(this.pool, "SELECT l.name AS b, SUM(CASE WHEN q.bucket <> 'Current' THEN q.balance ELSE 0 END) AS dq, SUM(q.balance) AS open FROM hist_loan_dq_month q JOIN cdm_location l ON l.int_id = q.branch_id WHERE q.month_end = ? AND q.bucket <> 'Charged off' GROUP BY l.name", [day(dqm!.m)])) Object.assign(get(r.b), { dq30: n(r.dq), open: n(r.open) });

    const line = (r: Raw, branchCount = 1): BranchKpiLine => ({
      branch: r.b,
      depositGrowthPct: pct(r.dNow - r.dWas, r.dWas),
      loanGrowthPct: pct(r.lNow - r.lWas, r.lWas),
      // The network's figure is per branch, so it compares with a branch's target.
      newMembersPerMonth: r.months ? r.joined12 / r.months / branchCount : 0,
      newMembersLatest: r.joinedLatest / branchCount,
      productsPerMember: r.members ? r.products / r.members : 0,
      nps: pct(r.promoters - r.detractors, r.responses),
      npsResponses: r.responses,
      dq30Pct: pct(r.dq30, r.open),
    });
    const all = [...raw.values()];
    const total = all.reduce<Raw>((t, r) => {
      for (const k of Object.keys(t) as (keyof Raw)[]) if (k !== 'b' && k !== 'months') (t[k] as number) += r[k] as number;
      t.months = Math.max(t.months, r.months);
      return t;
    }, { b: NETWORK, dNow: 0, dWas: 0, lNow: 0, lWas: 0, joined12: 0, months: 0, joinedLatest: 0, members: 0, products: 0, promoters: 0, detractors: 0, responses: 0, dq30: 0, open: 0 });
    const { lines, network } = this.withNetwork(new Map(all.map((r) => [r.b, line(r)])), branches, line(total, all.length || 1));
    const scored = (l: BranchKpiLine) => BRANCH_MEASURES.map((m) => ({ measure: m, value: l[m], status: targetStatus(m, l[m]), met: meetsTarget(m, targetStatus(m, l[m])) }));
    return { end, label, asOf, lines: lines.map((l) => ({ ...l, scores: scored(l) })), network: { ...network, scores: scored(network) } };
  }

  /** Delinquency at 30, 60 and 90 days for each branch in view and the network, at the latest month-end. */
  async delinquency(scope: Scope = {}) {
    const branches = await this.branchList(scope);
    const [dqm] = await rows<{ m: unknown }>(this.pool, 'SELECT MAX(month_end) AS m FROM hist_loan_dq_month');
    const month = day(dqm!.m);
    const data = await rows<{ b: string; bal: number; d30: number; d60: number; d90: number; n30: number }>(
      this.pool,
      `SELECT l.name AS b, SUM(q.balance) AS bal,
         SUM(CASE WHEN q.bucket = '30–59 days' THEN q.balance ELSE 0 END) AS d30,
         SUM(CASE WHEN q.bucket = '60–89 days' THEN q.balance ELSE 0 END) AS d60,
         SUM(CASE WHEN q.bucket IN ('90–179 days', '180–359 days', '360+ days') THEN q.balance ELSE 0 END) AS d90,
         SUM(CASE WHEN q.bucket <> 'Current' THEN q.loan_count ELSE 0 END) AS n30
       FROM hist_loan_dq_month q JOIN cdm_location l ON l.int_id = q.branch_id WHERE q.month_end = ? AND q.bucket <> 'Charged off' GROUP BY l.name`,
      [month],
    );
    const line = (b: string, bal: number, d30: number, d60: number, d90: number, loans30: number): BranchDqLine => ({ branch: b, balance: bal, d30, d60, d90, loans30, ratio30: pct(d30 + d60 + d90, bal), ratio60: pct(d60 + d90, bal), ratio90: pct(d90, bal) });
    const by = new Map(data.map((r) => [r.b, line(r.b, n(r.bal), n(r.d30), n(r.d60), n(r.d90), n(r.n30))]));
    const sum = (k: 'bal' | 'd30' | 'd60' | 'd90' | 'n30') => data.reduce((s, r) => s + n(r[k]), 0);
    return { month, label: new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), ...this.withNetwork(by, branches, line(NETWORK, sum('bal'), sum('d30'), sum('d60'), sum('d90'), sum('n30'))) };
  }

  /** Digital adoption by members' home branch: mobile, online banking, e-statements, bill pay, recent logins and debit cards. */
  async digital(scope: Scope = {}) {
    const asOf = await this.asOf();
    const branches = await this.branchList(scope);
    const data = await rows<{ b: string; m: number; mob: number; onl: number; est: number; bp: number; li: number }>(
      this.pool,
      `SELECT l.name AS b, COUNT(*) AS m, SUM(d.mobile_since IS NOT NULL) AS mob, SUM(d.online_banking_since IS NOT NULL) AS onl, SUM(d.estatements_since IS NOT NULL) AS est,
         SUM(d.bill_pay_since IS NOT NULL) AS bp, SUM(d.last_login > DATE_SUB(?, INTERVAL 90 DAY)) AS li
       FROM cdm_digital_usage d JOIN cdm_party p ON p.party_id = d.party_id JOIN cdm_location l ON l.int_id = p.primary_branch_id GROUP BY l.name`,
      [asOf],
    );
    // Debit cards: members holding an active one, and of the cards issued and still open, how many are active.
    const cards = new Map(
      (
        await rows<{ b: string; holders: number; active: number; issued: number; idle: number }>(
          this.pool,
          `SELECT l.name AS b, COUNT(DISTINCT CASE WHEN c.status = 'Active' THEN c.party_id END) AS holders, SUM(c.status = 'Active') AS active,
             SUM(c.status <> 'Closed') AS issued, SUM(c.status = 'Issued, not activated') AS idle
           FROM cdm_card c JOIN cdm_party p ON p.party_id = c.party_id JOIN cdm_location l ON l.int_id = p.primary_branch_id WHERE c.kind = 'Debit' GROUP BY l.name`,
        )
      ).map((r) => [r.b, r]),
    );
    const line = (b: string, r: { m: number; mob: number; onl: number; est: number; bp: number; li: number }, c: { holders: number; active: number; issued: number; idle: number } | undefined): BranchDigitalLine => ({
      branch: b,
      members: n(r.m),
      mobilePct: pct(n(r.mob), n(r.m)),
      onlinePct: pct(n(r.onl), n(r.m)),
      estatementsPct: pct(n(r.est), n(r.m)),
      billPayPct: pct(n(r.bp), n(r.m)),
      loggedIn90Pct: pct(n(r.li), n(r.m)),
      activeDebitPct: pct(n(c?.holders), n(r.m)),
      debitActivationPct: pct(n(c?.active), n(c?.issued)),
      debitNotActivated: n(c?.idle),
    });
    const by = new Map(data.map((r) => [r.b, line(r.b, r, cards.get(r.b))]));
    const tot = (k: 'm' | 'mob' | 'onl' | 'est' | 'bp' | 'li') => data.reduce((s, r) => s + n(r[k]), 0);
    const ctot = (k: 'holders' | 'active' | 'issued' | 'idle') => [...cards.values()].reduce((s, r) => s + n(r[k]), 0);
    return { asOf, ...this.withNetwork(by, branches, line(NETWORK, { m: tot('m'), mob: tot('mob'), onl: tot('onl'), est: tot('est'), bp: tot('bp'), li: tot('li') }, { holders: ctot('holders'), active: ctot('active'), issued: ctot('issued'), idle: ctot('idle') })) };
  }

  /**
   * Results per person over the last 12 months: loans funded and deposit accounts opened, per person and
   * per lender, a month. Each person on the branch roster counts as one full-time person [Assumption:
   * the roster has no hours].
   */
  async productivity(scope: Scope = {}) {
    const { end, yearAgo } = await this.monthEnds();
    const branches = await this.branchList(scope);
    const staff = await rows<{ b: string; k: number; lenders: number; service: number }>(this.pool, "SELECT l.name AS b, COUNT(*) AS k, SUM(e.role = 'Loan officer') AS lenders, SUM(e.role IN ('MSR', 'Teller')) AS service FROM cdm_employee e JOIN cdm_location l ON l.int_id = e.branch_id GROUP BY l.name");
    const loans = new Map((await rows<{ b: string; k: number; months: number }>(this.pool, 'SELECT l.name AS b, SUM(h.new_loan_count) AS k, COUNT(DISTINCT h.month_end) AS months FROM hist_loan_month h JOIN cdm_location l ON l.int_id = h.branch_id WHERE h.month_end > ? AND h.month_end <= ? GROUP BY l.name', [yearAgo, end])).map((r) => [r.b, r]));
    const accounts = new Map((await rows<{ b: string; k: number }>(this.pool, 'SELECT l.name AS b, COUNT(*) AS k FROM cdm_deposit_account d JOIN cdm_location l ON l.int_id = d.branch_id WHERE d.open_date > ? AND d.open_date <= ? GROUP BY l.name', [yearAgo, end])).map((r) => [r.b, r]));
    const months = Math.max(1, ...[...loans.values()].map((r) => n(r.months)));
    const line = (b: string, s: number, lenders: number, service: number, funded: number, opened: number): BranchProductivityLine => ({
      branch: b,
      staff: s,
      lenders,
      serviceStaff: service,
      loansFunded: funded,
      accountsOpened: opened,
      loansPerStaffMonth: s ? funded / s / months : 0,
      loansPerLenderMonth: lenders ? funded / lenders / months : 0,
      accountsPerStaffMonth: s ? opened / s / months : 0,
    });
    const by = new Map(staff.map((r) => [r.b, line(r.b, n(r.k), n(r.lenders), n(r.service), n(loans.get(r.b)?.k), n(accounts.get(r.b)?.k))]));
    const sum = (f: (l: BranchProductivityLine) => number) => [...by.values()].reduce((t, l) => t + f(l), 0);
    return { end, months, ...this.withNetwork(by, branches, line(NETWORK, sum((l) => l.staff), sum((l) => l.lenders), sum((l) => l.serviceStaff), sum((l) => l.loansFunded), sum((l) => l.accountsOpened))) };
  }

  /** The complaint log by branch: open member and regulator complaints (CFPB, NCUA, BBB), past due, and the last 12 months closed. */
  async complaints(scope: Scope = {}) {
    const asOf = await this.asOf();
    const branches = await this.branchList(scope);
    const data = await rows<{ issue_id: number; b: string; source: string; kind: string; category: string; summary: string; status: string; opened: unknown; resolve_by: unknown; closed: unknown; owner: string | null }>(
      this.pool,
      `SELECT i.issue_id, l.name AS b, i.source, i.kind, i.category, i.summary, i.status, i.opened, i.resolve_by, i.closed, e.display_name AS owner
       FROM cpm_issue i JOIN cdm_location l ON l.int_id = i.branch_id LEFT JOIN cdm_employee e ON e.employee_id = i.owner_employee_id
       WHERE i.closed IS NULL OR i.closed > DATE_SUB(?, INTERVAL 12 MONTH) ORDER BY i.opened`,
      [asOf],
    );
    const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    const REGULATORS = ['CFPB', 'NCUA', 'OCC', 'FDIC', 'State regulator'];
    const isOpen = (r: (typeof data)[number]) => r.status !== 'Closed';
    const line = (b: string, rs: typeof data): BranchComplaintLine => {
      const open = rs.filter(isOpen);
      const closed = rs.filter((r) => !isOpen(r) && r.closed);
      const ages = open.map((r) => days(day(r.opened), asOf));
      return {
        branch: b,
        open: open.length,
        openRegulatory: open.filter((r) => REGULATORS.includes(r.source)).length,
        pastDue: open.filter((r) => day(r.resolve_by) < asOf).length,
        closed12: closed.length,
        avgDaysToClose: closed.length ? Math.round(closed.reduce((s, r) => s + days(day(r.opened), day(r.closed)), 0) / closed.length) : null,
        oldestOpenDays: ages.length ? Math.max(...ages) : null,
      };
    };
    const by = new Map([...new Set(data.map((r) => r.b))].map((b) => [b, line(b, data.filter((r) => r.b === b))]));
    for (const { b } of branches) if (!by.has(b)) by.set(b, line(b, []));
    const inView = new Set(branches.map((x) => x.b));
    const open: OpenComplaint[] = data
      .filter((r) => isOpen(r) && inView.has(r.b))
      .map((r) => ({ issueId: n(r.issue_id), branch: r.b, source: r.source, kind: r.kind, category: r.category, summary: r.summary, status: r.status, opened: day(r.opened), ageDays: days(day(r.opened), asOf), pastDue: day(r.resolve_by) < asOf, owner: r.owner }))
      .sort((a, b) => b.ageDays - a.ageDays);
    return { asOf, open, ...this.withNetwork(by, branches, line(NETWORK, data)) };
  }

  // ---- branch operations (the bro_* tables) ------------------------------------------------------

  /** Business days in the window: the last `days` calendar days to the latest teller day. */
  private async opsWindow(days: number) {
    const [r] = await rows<{ d: unknown }>(this.pool, 'SELECT MAX(business_date) AS d FROM bro_teller_day');
    const end = r?.d ? day(r.d) : await this.asOf();
    const start = day(new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * 86_400_000));
    return { start, end };
  }

  /**
   * Daily balancing and the vault over the last `days` days: drawers in balance, net and gross over and
   * short, transactions per teller hour, and the vault against its limit and under dual control.
   */
  async balancing(scope: Scope = {}, days = 30) {
    const { start, end } = await this.opsWindow(days);
    const branches = await this.branchList(scope);
    const tellers = await rows<{ b: string; id: number; name: string; drawers: number; off: number; net: number; gross: number; tx: number; hours: number }>(
      this.pool,
      `SELECT l.name AS b, t.employee_id AS id, e.display_name AS name, COUNT(*) AS drawers, SUM(t.over_short <> 0) AS off, SUM(t.over_short) AS net, SUM(ABS(t.over_short)) AS gross, SUM(t.transactions) AS tx, SUM(t.hours) AS hours
       FROM bro_teller_day t JOIN cdm_location l ON l.int_id = t.branch_id LEFT JOIN cdm_employee e ON e.employee_id = t.employee_id
       WHERE t.business_date BETWEEN ? AND ? GROUP BY l.name, t.employee_id, e.display_name ORDER BY t.employee_id`,
      [start, end],
    );
    const vault = await rows<{ b: string; d: number; over: number; noDual: number; latest: number; lim: number; peak: number }>(
      this.pool,
      `SELECT l.name AS b, COUNT(*) AS d, SUM(v.vault_cash > v.vault_limit) AS \`over\`, SUM(v.dual_control = 0) AS noDual,
         SUM(CASE WHEN v.business_date = ? THEN v.vault_cash ELSE 0 END) AS latest, MAX(v.vault_limit) AS lim, MAX(v.vault_cash) AS peak
       FROM bro_vault_day v JOIN cdm_location l ON l.int_id = v.branch_id WHERE v.business_date BETWEEN ? AND ? GROUP BY l.name`,
      [end, start, end],
    );
    type Line = { branch: string; drawers: number; outOfBalance: number; balancedPct: number; net: number; gross: number; transactions: number; hours: number; txPerHour: number; vaultDays: number; vaultOverLimitDays: number; vaultNoDualDays: number; vaultLatest: number; vaultLimit: number; vaultPeak: number };
    const line = (b: string, ts: typeof tellers, vs: typeof vault): Line => {
      const s = (k: 'drawers' | 'off' | 'net' | 'gross' | 'tx' | 'hours') => ts.reduce((t, r) => t + n(r[k]), 0);
      const v = (k: 'd' | 'over' | 'noDual' | 'latest' | 'lim') => vs.reduce((t, r) => t + n(r[k]), 0);
      return { branch: b, drawers: s('drawers'), outOfBalance: s('off'), balancedPct: pct(s('drawers') - s('off'), s('drawers')), net: s('net'), gross: s('gross'), transactions: s('tx'), hours: s('hours'), txPerHour: s('hours') ? s('tx') / s('hours') : 0, vaultDays: v('d'), vaultOverLimitDays: v('over'), vaultNoDualDays: v('noDual'), vaultLatest: v('latest'), vaultLimit: v('lim'), vaultPeak: Math.max(0, ...vs.map((r) => n(r.peak))) };
    };
    const names = [...new Set([...tellers.map((t) => t.b), ...vault.map((v) => v.b)])];
    const by = new Map(names.map((b) => [b, line(b, tellers.filter((t) => t.b === b), vault.filter((v) => v.b === b))]));
    const inView = new Set(branches.map((x) => x.b));
    const people = tellers.filter((t) => inView.has(t.b)).map((t) => ({ branch: t.b, employeeId: n(t.id), name: t.name ?? `Employee ${t.id}`, drawers: n(t.drawers), outOfBalance: n(t.off), net: n(t.net), gross: n(t.gross), txPerHour: n(t.hours) ? n(t.tx) / n(t.hours) : 0 }));
    return { start, end, days, people, ...this.withNetwork(by, branches, line(NETWORK, tellers, vault)) };
  }

  /** Lobby traffic and waits over the last `days` days, against the 4-minute target, with the busiest times. */
  async lobby(scope: Scope = {}, days = 30) {
    const { start, end } = await this.opsWindow(days);
    const branches = await this.branchList(scope);
    const data = await rows<{ b: string; dow: number; hour: number; arrivals: number; waitSum: number; over: number; hours: number; maxWait: number; days: number }>(
      this.pool,
      `SELECT l.name AS b, DAYOFWEEK(h.business_date) AS dow, h.hour, SUM(h.arrivals) AS arrivals, SUM(h.avg_wait_min * h.arrivals) AS waitSum, SUM(h.avg_wait_min > ?) AS \`over\`, COUNT(*) AS hours, MAX(h.max_wait_min) AS maxWait, COUNT(DISTINCT h.business_date) AS days
       FROM bro_lobby_hour h JOIN cdm_location l ON l.int_id = h.branch_id WHERE h.business_date BETWEEN ? AND ? GROUP BY l.name, DAYOFWEEK(h.business_date), h.hour`,
      [LOBBY_WAIT_TARGET, start, end],
    );
    const openDays = n((await rows<{ k: number }>(this.pool, 'SELECT COUNT(DISTINCT business_date) AS k FROM bro_lobby_hour WHERE business_date BETWEEN ? AND ?', [start, end]))[0]?.k);
    const DOW = ['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const line = (b: string, rs: typeof data, branchCount = 1) => {
      const arrivals = rs.reduce((s, r) => s + n(r.arrivals), 0);
      const hours = rs.reduce((s, r) => s + n(r.hours), 0);
      const busiest = [...rs].sort((p, q) => n(q.waitSum) / n(q.arrivals) - n(p.waitSum) / n(p.arrivals))[0];
      return {
        branch: b,
        visitorsPerDay: openDays ? arrivals / openDays / branchCount : 0,
        avgWait: arrivals ? rs.reduce((s, r) => s + n(r.waitSum), 0) / arrivals : 0,
        hoursOverTargetPct: pct(rs.reduce((s, r) => s + n(r.over), 0), hours),
        longestWait: Math.max(0, ...rs.map((r) => n(r.maxWait))),
        busiest: busiest ? { day: DOW[n(busiest.dow)]!, hour: n(busiest.hour), avgWait: n(busiest.waitSum) / n(busiest.arrivals) } : null,
      };
    };
    const names = [...new Set(data.map((r) => r.b))];
    const by = new Map(names.map((b) => [b, line(b, data.filter((r) => r.b === b))]));
    // The network's busiest time pools every branch's arrivals by weekday and hour.
    const pooled = [...new Set(data.map((r) => `${r.dow}|${r.hour}`))].map((k) => {
      const rs = data.filter((r) => `${r.dow}|${r.hour}` === k);
      return { b: NETWORK, dow: rs[0]!.dow, hour: rs[0]!.hour, arrivals: rs.reduce((s, r) => s + n(r.arrivals), 0), waitSum: rs.reduce((s, r) => s + n(r.waitSum), 0), over: rs.reduce((s, r) => s + n(r.over), 0), hours: rs.reduce((s, r) => s + n(r.hours), 0), maxWait: Math.max(...rs.map((r) => n(r.maxWait))), days: 0 };
    });
    return { start, end, target: LOBBY_WAIT_TARGET, ...this.withNetwork(by, branches, line(NETWORK, pooled, names.length || 1)) };
  }

  /**
   * BSA and fraud by branch over 12 months: CTRs filed and late (15 days), unusual-activity referrals to
   * the BSA officer by kind, and fraud cases and losses by type, with elder exploitation and Reg E claims.
   * SARs are never shown by branch: they stay with the BSA officer (31 U.S.C. 5318(g)(2)).
   */
  async risk(scope: Scope = {}) {
    const asOf = await this.asOf();
    const branches = await this.branchList(scope);
    const since = day(new Date(Date.parse(`${asOf}T00:00:00Z`) - 365 * 86_400_000));
    const ctr = await rows<{ b: string; k: number; late: number }>(this.pool, 'SELECT l.name AS b, COUNT(*) AS k, SUM(DATEDIFF(c.filed_on, c.txn_date) > 15) AS late FROM bro_ctr c JOIN cdm_location l ON l.int_id = c.branch_id WHERE c.txn_date > ? GROUP BY l.name', [since]);
    const refs = await rows<{ b: string; typ: string; k: number }>(this.pool, 'SELECT l.name AS b, r.typology AS typ, COUNT(*) AS k FROM bro_aml_referral r JOIN cdm_location l ON l.int_id = r.branch_id WHERE r.referred_on > ? GROUP BY l.name, r.typology', [since]);
    const fraud = await rows<{ b: string; typ: string; k: number; loss: number; rec: number; elder: number; regE: number; open: number; regELate: number }>(
      this.pool,
      `SELECT l.name AS b, f.fraud_type AS typ, COUNT(*) AS k, SUM(f.gross_loss) AS loss, SUM(f.recovered) AS rec, SUM(f.elder) AS elder, SUM(f.reg_e) AS regE, SUM(f.status = 'Open') AS open,
         SUM(f.reg_e = 1 AND ((f.status = 'Open' AND DATEDIFF(?, f.opened) > ?) OR DATEDIFF(f.resolved, f.opened) > ?)) AS regELate
       FROM bro_fraud_case f JOIN cdm_location l ON l.int_id = f.branch_id WHERE f.opened > ? GROUP BY l.name, f.fraud_type`,
      [asOf, REG_E_DAYS, REG_E_DAYS, since],
    );
    const line = (b: string, c: typeof ctr, r: typeof refs, f: typeof fraud) => {
      const s = <T>(xs: T[], k: keyof T) => xs.reduce((t, x) => t + n(x[k]), 0);
      const byType = [...new Set(f.map((x) => x.typ))].map((typ) => ({ type: typ, cases: s(f.filter((x) => x.typ === typ), 'k'), loss: s(f.filter((x) => x.typ === typ), 'loss') - s(f.filter((x) => x.typ === typ), 'rec') })).sort((p, q) => q.loss - p.loss);
      return {
        branch: b,
        ctrs: s(c, 'k'),
        ctrsLate: s(c, 'late'),
        referrals: s(r, 'k'),
        structuring: s(r.filter((x) => x.typ === 'Structuring'), 'k'),
        fraudCases: s(f, 'k'),
        grossLoss: s(f, 'loss'),
        recovered: s(f, 'rec'),
        netLoss: s(f, 'loss') - s(f, 'rec'),
        elderCases: s(f, 'elder'),
        regEClaims: s(f, 'regE'),
        regELate: s(f, 'regELate'),
        openCases: s(f, 'open'),
        skimming: s(f.filter((x) => x.typ === 'Card skimming'), 'k'),
        checkFraud: s(f.filter((x) => x.typ === 'Check fraud'), 'k'),
        byType,
      };
    };
    const names = [...new Set([...ctr.map((x) => x.b), ...refs.map((x) => x.b), ...fraud.map((x) => x.b)])];
    const by = new Map(names.map((b) => [b, line(b, ctr.filter((x) => x.b === b), refs.filter((x) => x.b === b), fraud.filter((x) => x.b === b))]));
    return { since, asOf, ...this.withNetwork(by, branches, line(NETWORK, ctr, refs, fraud)) };
  }

  /** Audit exceptions (open, past due, high) and surprise cash counts over 12 months, with the open exceptions listed. */
  async audits(scope: Scope = {}) {
    const asOf = await this.asOf();
    const branches = await this.branchList(scope);
    const since = day(new Date(Date.parse(`${asOf}T00:00:00Z`) - 365 * 86_400_000));
    const exc = await rows<{ id: number; b: string; found: unknown; source: string; category: string; severity: string; detail: string; due: unknown; closed: unknown }>(
      this.pool,
      'SELECT a.exception_id AS id, l.name AS b, a.found_on AS found, a.source, a.category, a.severity, a.detail, a.due, a.closed FROM bro_audit_exception a JOIN cdm_location l ON l.int_id = a.branch_id WHERE a.closed IS NULL OR a.found_on > ? ORDER BY a.found_on',
      [since],
    );
    const counts = await rows<{ b: string; k: number; diff: number; noDual: number; off: number }>(
      this.pool,
      'SELECT l.name AS b, COUNT(*) AS k, SUM(ABS(c.counted - c.expected)) AS diff, SUM(c.dual_control = 0) AS noDual, SUM(c.counted <> c.expected) AS off FROM bro_cash_count c JOIN cdm_location l ON l.int_id = c.branch_id WHERE c.count_date > ? GROUP BY l.name',
      [since],
    );
    const line = (b: string, es: typeof exc, cs: typeof counts) => {
      const open = es.filter((e) => !e.closed);
      return {
        branch: b,
        exceptions: es.length,
        open: open.length,
        openHigh: open.filter((e) => e.severity === 'High').length,
        pastDue: open.filter((e) => day(e.due) < asOf).length,
        counts: cs.reduce((t, c) => t + n(c.k), 0),
        countsWithDifference: cs.reduce((t, c) => t + n(c.off), 0),
        countDifference: cs.reduce((t, c) => t + n(c.diff), 0),
        countsWithoutDualControl: cs.reduce((t, c) => t + n(c.noDual), 0),
      };
    };
    const names = [...new Set([...exc.map((e) => e.b), ...counts.map((c) => c.b)])];
    const by = new Map(names.map((b) => [b, line(b, exc.filter((e) => e.b === b), counts.filter((c) => c.b === b))]));
    const inView = new Set(branches.map((x) => x.b));
    const open = exc.filter((e) => !e.closed && inView.has(e.b)).map((e) => ({ id: n(e.id), branch: e.b, found: day(e.found), source: e.source, category: e.category, severity: e.severity, detail: e.detail, due: day(e.due), pastDue: day(e.due) < asOf }));
    return { asOf, since, open, ...this.withNetwork(by, branches, line(NETWORK, exc, counts)) };
  }

  /** People: headcount, turnover and hires over 12 months, the latest engagement score, and required training. */
  async people(scope: Scope = {}) {
    const asOf = await this.asOf();
    const branches = await this.branchList(scope);
    const since = day(new Date(Date.parse(`${asOf}T00:00:00Z`) - 365 * 86_400_000));
    const head = await rows<{ b: string; k: number }>(this.pool, 'SELECT l.name AS b, COUNT(*) AS k FROM cdm_employee e JOIN cdm_location l ON l.int_id = e.branch_id GROUP BY l.name');
    const changes = await rows<{ b: string; kind: string; k: number }>(this.pool, 'SELECT l.name AS b, s.kind, COUNT(*) AS k FROM bro_staff_change s JOIN cdm_location l ON l.int_id = s.branch_id WHERE s.change_date > ? GROUP BY l.name, s.kind', [since]);
    const reasons = await rows<{ reason: string; k: number }>(this.pool, `SELECT s.reason, COUNT(*) AS k FROM bro_staff_change s JOIN cdm_location l ON l.int_id = s.branch_id WHERE s.kind = 'Left' AND s.change_date > ? AND l.name IN (?) GROUP BY s.reason ORDER BY k DESC`, [since, branches.map((x) => x.b).concat([''])]);
    const eng = await rows<{ b: string; q: unknown; score: number; invited: number; responded: number }>(this.pool, 'SELECT l.name AS b, g.quarter_end AS q, g.score, g.invited, g.responded FROM bro_engagement g JOIN cdm_location l ON l.int_id = g.branch_id ORDER BY g.quarter_end');
    const training = await rows<{ b: string; id: number; name: string; course: string; due: unknown; completed: unknown }>(
      this.pool,
      'SELECT l.name AS b, t.employee_id AS id, e.display_name AS name, t.course, t.due, t.completed FROM bro_training t JOIN cdm_employee e ON e.employee_id = t.employee_id JOIN cdm_location l ON l.int_id = e.branch_id WHERE t.required = 1 ORDER BY t.due, t.employee_id',
    );
    const line = (b: string, hs: typeof head, cs: typeof changes, es: typeof eng, ts: typeof training) => {
      const headcount = hs.reduce((t, h) => t + n(h.k), 0);
      const left = cs.filter((c) => c.kind === 'Left').reduce((t, c) => t + n(c.k), 0);
      const quarters = [...new Set(es.map((e) => day(e.q)))].sort();
      const score = (q: string | undefined) => {
        const xs = es.filter((e) => day(e.q) === q);
        const k = xs.reduce((t, e) => t + n(e.responded), 0);
        return k ? xs.reduce((t, e) => t + n(e.score) * n(e.responded), 0) / k : null;
      };
      const byCourse = REQUIRED_TRAINING.map((course) => {
        const xs = ts.filter((t) => t.course === course);
        return { course, assigned: xs.length, completed: xs.filter((t) => t.completed).length, completionPct: pct(xs.filter((t) => t.completed).length, xs.length) };
      });
      return {
        branch: b,
        headcount,
        left,
        joined: cs.filter((c) => c.kind === 'Joined').reduce((t, c) => t + n(c.k), 0),
        turnoverPct: pct(left, headcount),
        engagement: score(quarters.at(-1)),
        engagementPrior: score(quarters.at(-2)),
        engagementQuarter: quarters.at(-1) ?? null,
        training: byCourse,
        trainingPct: pct(byCourse.reduce((t, c) => t + c.completed, 0), byCourse.reduce((t, c) => t + c.assigned, 0)),
        trainingOverdue: ts.filter((t) => !t.completed && day(t.due) < asOf).length,
        trainingOpen: ts.filter((t) => !t.completed).length,
      };
    };
    const names = [...new Set(head.map((h) => h.b))];
    const by = new Map(names.map((b) => [b, line(b, head.filter((x) => x.b === b), changes.filter((x) => x.b === b), eng.filter((x) => x.b === b), training.filter((x) => x.b === b))]));
    const inView = new Set(branches.map((x) => x.b));
    const incomplete = training.filter((t) => !t.completed && inView.has(t.b)).map((t) => ({ branch: t.b, name: t.name, course: t.course, due: day(t.due), overdue: day(t.due) < asOf }));
    return { asOf, since, incomplete, reasons: reasons.map((r) => ({ reason: r.reason, count: n(r.k) })), ...this.withNetwork(by, branches, line(NETWORK, head, changes, eng, training)) };
  }
}

/** The lobby wait the CEO holds branches to, in minutes. */
export const LOBBY_WAIT_TARGET = 4;
/** Reg E: an error claim is resolved within 45 days of notice (12 CFR 1005.11). */
export const REG_E_DAYS = 45;
/** The courses every person finishes each year, held to 100%. */
export const REQUIRED_TRAINING = ['BSA/AML', 'Fair Lending', 'Information Security'];
