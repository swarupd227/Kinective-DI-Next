// Sales scorecards beyond each person's incentives: the Monthly Loan Score Card (production by channel
// against the year's minimum and stretch, month to date and year to date), sales contests with their
// standings, and the incentive scorecards rolled up by region.
import { loanChannel, type Pool } from '@dinext/tenant-db';
import type { GoalsService, GoalsWho } from './goals.ts';
import { CoreError, type CoreContext } from './referrals.ts';

const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const r1 = (n: number) => Math.round(n * 10) / 10;
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

export class SalesScorecardService {
  constructor(private readonly pool: Pool) {}

  private async asOf() {
    const [b] = await this.pool.query("SELECT as_of_date FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
    return day((b as { as_of_date: unknown }[])[0]!.as_of_date);
  }

  /**
   * The loan scorecard for a month (the last complete month by default): for each channel, the year's
   * minimum and stretch, the share due by this month, and production month to date and year to date.
   */
  async loanScorecard(month?: string, ctx: CoreContext = {}) {
    const asOf = await this.asOf();
    const latest = monthEnd(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 1);
    const end = month ?? latest;
    const y = Number(end.slice(0, 4));
    const m = Number(end.slice(5, 7));
    const [goals] = await this.pool.query('SELECT channel, minimum, stretch FROM fin_loan_goal WHERE year = ? ORDER BY sort_order', [y]).catch(() => [[]]);
    const list = goals as { channel: string; minimum: unknown; stretch: unknown }[];
    if (!list.length) throw new CoreError('NOT_FOUND', `No loan goals are set for ${y}.`);
    const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
    const [loans] = await this.pool.query(
      `SELECT l.loan_category, l.is_indirect, l.open_date, l.original_amount FROM cdm_loan l JOIN cdm_location b ON b.int_id = l.branch_id WHERE l.open_date BETWEEN ? AND ?${scope}`,
      [`${y}-01-01`, end, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])],
    );
    const monthStart = `${end.slice(0, 7)}-01`;
    const share = ctx.purviewBranches ? await this.branchShare(ctx.purviewBranches) : 1;
    const rows = list.map((g) => {
      const mine = (loans as { loan_category: string; is_indirect: number; open_date: unknown; original_amount: unknown }[]).filter((l) => loanChannel(l.loan_category, Boolean(l.is_indirect)) === g.channel);
      const ytd = mine.reduce((s, l) => s + Number(l.original_amount), 0);
      const mtd = mine.filter((l) => day(l.open_date) >= monthStart).reduce((s, l) => s + Number(l.original_amount), 0);
      const minYtd = (Number(g.minimum) * share * m) / 12;
      const stretchYtd = (Number(g.stretch) * share * m) / 12;
      return { channel: g.channel, minimum: Number(g.minimum) * share, stretch: Number(g.stretch) * share, minYtd, stretchYtd, ytd, ytdCount: mine.length, mtd, mtdGoal: (Number(g.minimum) * share) / 12, pctToMin: minYtd ? r1((ytd / minYtd) * 100) : 0, pctToStretch: stretchYtd ? r1((ytd / stretchYtd) * 100) : 0 };
    });
    const sum = (k: 'minimum' | 'stretch' | 'minYtd' | 'stretchYtd' | 'ytd' | 'mtd' | 'mtdGoal') => rows.reduce((s, r) => s + r[k], 0);
    const total = { channel: 'Total', minimum: sum('minimum'), stretch: sum('stretch'), minYtd: sum('minYtd'), stretchYtd: sum('stretchYtd'), ytd: sum('ytd'), ytdCount: rows.reduce((s, r) => s + r.ytdCount, 0), mtd: sum('mtd'), mtdGoal: sum('mtdGoal'), pctToMin: r1((sum('ytd') / sum('minYtd')) * 100), pctToStretch: r1((sum('ytd') / sum('stretchYtd')) * 100) };
    return { month: end, year: y, scoped: share !== 1, rows, total };
  }

  /** A branch scope's share of the institution's goals: its share of last year's production. */
  private async branchShare(branches: string[]) {
    const [r] = await this.pool.query("SELECT SUM(CASE WHEN b.name IN (?) THEN l.original_amount ELSE 0 END) / SUM(l.original_amount) AS s FROM cdm_loan l JOIN cdm_location b ON b.int_id = l.branch_id WHERE l.open_date BETWEEN '2025-01-01' AND '2025-12-31'", [branches.length ? branches : ['']]);
    return Number((r as { s: unknown }[])[0]?.s ?? 0) || 0;
  }

  /** Sales contests, running and ended, with the standings: loans counted or dollars, by loan officer or branch. */
  async contests(ctx: CoreContext = {}) {
    const asOf = await this.asOf();
    const [list] = await this.pool.query('SELECT * FROM gi_contest ORDER BY starts DESC').catch(() => [[]]);
    const out = [];
    for (const c of list as Record<string, unknown>[]) {
      const cats = (typeof c.categories === 'string' ? JSON.parse(c.categories) : c.categories) as string[];
      const starts = day(c.starts);
      const ends = day(c.ends);
      const to = ends < asOf ? ends : asOf;
      const byOfficer = c.by_level === 'officer';
      const scope = ctx.purviewBranches ? ' AND b.name IN (?)' : '';
      const [rows] = await this.pool.query(
        `SELECT ${byOfficer ? "COALESCE(e.display_name, 'Unassigned')" : 'b.name'} AS who, b.name AS branch, COUNT(*) AS n, SUM(l.original_amount) AS dollars
           FROM cdm_loan l JOIN cdm_location b ON b.int_id = l.branch_id LEFT JOIN cdm_employee e ON e.employee_id = l.officer_id
          WHERE l.loan_category IN (?) AND l.open_date BETWEEN ? AND ?${scope} GROUP BY who, branch ORDER BY ${c.metric === 'count' ? 'n' : 'dollars'} DESC LIMIT 10`,
        [cats, starts, to, ...(ctx.purviewBranches ? [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] : [])],
      );
      const standings = (rows as { who: string; branch: string; n: unknown; dollars: unknown }[]).map((r, i) => ({ rank: i + 1, name: r.who, branch: r.branch, count: Number(r.n), dollars: Number(r.dollars) }));
      out.push({ id: Number(c.contest_id), name: c.name as string, metric: c.metric as 'count' | 'dollars', by: byOfficer ? 'loan officer' : 'branch', starts, ends, prize: c.prize as string, status: asOf < starts ? 'Upcoming' : asOf > ends ? 'Ended' : 'Running', daysLeft: asOf <= ends ? Math.round((Date.parse(`${ends}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000) : 0, standings });
    }
    return { asOf, contests: out };
  }

  /** The incentive scorecards rolled up by region: each goal's actual against target, people behind, and payouts. */
  async regions(goals: GoalsService, who: GoalsWho, ctx: CoreContext) {
    const cards = await goals.team(undefined, who, ctx);
    const [locs] = await this.pool.query('SELECT name, region FROM cdm_location');
    const regionOf = new Map((locs as { name: string; region: string }[]).map((l) => [l.name, l.region]));
    const byRegion = new Map<string, typeof cards>();
    for (const c of cards) {
      const r = regionOf.get(c.branch) ?? 'Other';
      (byRegion.get(r) ?? byRegion.set(r, []).get(r)!).push(c);
    }
    return [...byRegion].map(([region, cs]) => {
      const goalIds = [...new Set(cs.flatMap((c) => c.goals.filter((g) => !g.qualifier && g.goalId !== 'BRANCH_FUNDED').map((g) => g.goalId)))];
      return {
        region,
        branches: [...new Set(cs.map((c) => c.branch))].sort(),
        people: cs.length,
        behind: cs.filter((c) => c.behind).length,
        payout: Math.round(cs.reduce((s, c) => s + c.total, 0) * 100) / 100,
        goals: goalIds.map((id) => {
          const gs = cs.flatMap((c) => c.goals.filter((g) => g.goalId === id));
          const actual = gs.reduce((s, g) => s + g.actual, 0);
          const target = gs.reduce((s, g) => s + g.target, 0);
          return { goalId: id, name: gs[0]!.name, unit: gs[0]!.unit, actual, target, pct: target ? Math.round((actual / target) * 100) : 0 };
        }),
      };
    }).sort((a, b) => a.region.localeCompare(b.region));
  }
}
