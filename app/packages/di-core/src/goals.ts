// Goals & Incentives (spec 8.26, 17.4, 24.17). Scores and payouts are worked out here from the
// credited records, so the same inputs give the same amounts to the cent (BE-GI-002). No client or
// model ever recomputes one (AI-AGT-170). Employees see their own; managers see their purview.
import type { Pool } from '@dinext/tenant-db';
import { CoreError, type CoreContext } from './referrals.ts';

export interface GoalsWho {
  employeeId?: number;
  /** Looks after a team: sees their scorecards. */
  leads?: boolean;
  /** Approve Incentives in the module's access matrix. */
  approves?: boolean;
}

export interface IncentiveRule {
  name: string;
  kind: 'per_unit' | 'tiered';
  perUnit: number | null;
  cap: number | null;
  tiers: { tier: number; lowerPct: number; amount: number }[];
}

export interface GoalScore {
  goalId: string;
  name: string;
  unit: 'count' | 'currency' | 'score';
  unitLabel: string;
  actual: number;
  target: number;
  /** Where the target came from, most specific first (BE-GI-001). */
  targetFrom: string;
  pct: number;
  /** Records that will count once they complete, such as active referrals. */
  pending: number;
  qualifier: boolean;
  rule: IncentiveRule | null;
  earned: number;
  capped: boolean;
  tier: number | null;
  next: { need: number; amount: number; pct: number } | null;
}

export interface Scorecard {
  employeeId: number;
  name: string;
  role: string;
  branch: string;
  periodEnd: string;
  period: string;
  /** The nightly build the figures come from (spec 8.26). */
  asOf: string;
  goals: GoalScore[];
  qualified: boolean;
  total: number;
  /** Below target on at least one scored goal. */
  behind: boolean;
}

export interface PayoutLine {
  employeeId: number;
  name: string;
  role: string;
  calculated: number;
  adjustments: { amount: number; reasonCode: string; note: string }[];
  amount: number;
  incentives: string;
  /** Things to look at before approving, in plain words. */
  flags: string[];
  own: boolean;
  /** Set once decided, with the amount as approved. */
  status: string | null;
}

export interface PayoutBatch {
  periodEnd: string;
  period: string;
  branch: string;
  lines: PayoutLine[];
  total: number;
  flagged: number;
  /** Lines still waiting for a decision. */
  waiting: number;
}

export interface ScoreExplanation {
  score: GoalScore;
  card: Pick<Scorecard, 'employeeId' | 'name' | 'period' | 'qualified'>;
  records: { date: string; label: string; value: number; counted: boolean }[];
  rule: string;
  asOf: string;
}

export const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

/** One goal's payout, before any qualifier: the tier reached, or units paid up to the cap. */
export function payFor(rule: IncentiveRule, actual: number, target: number): Pick<GoalScore, 'earned' | 'capped' | 'tier' | 'next'> {
  if (rule.kind === 'per_unit') {
    const raw = actual * (rule.perUnit ?? 0);
    const capped = rule.cap !== null && raw >= rule.cap;
    return { earned: capped ? rule.cap! : raw, capped, tier: null, next: capped ? null : { need: 1, amount: rule.perUnit ?? 0, pct: 0 } };
  }
  const pct = target ? (actual / target) * 100 : 0;
  const reached = rule.tiers.filter((t) => pct >= t.lowerPct).at(-1) ?? null;
  const higher = rule.tiers.find((t) => pct < t.lowerPct) ?? null;
  return { earned: reached?.amount ?? 0, capped: false, tier: reached?.tier ?? null, next: higher ? { need: Math.ceil((target * higher.lowerPct) / 100 - actual), amount: higher.amount, pct: higher.lowerPct } : null };
}

export function ruleText(r: IncentiveRule, unitLabel: string) {
  const whole = (n: number) => `$${n.toLocaleString('en-US')}`;
  if (r.kind === 'per_unit') return `${whole(r.perUnit ?? 0)} per ${unitLabel.replace(/s$/, '')}${r.cap !== null ? `, capped at ${whole(r.cap)}` : ''}`;
  return r.tiers.map((t) => `${whole(t.amount)} at ${t.lowerPct}%`).join(', ');
}

/** Worth a second look: a large jump on last month, in dollars and in proportion. */
const unusual = (amount: number, prior: number) => amount - prior >= 100 && (prior === 0 || amount >= prior * 1.5);

const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const monthName = (end: string) => new Date(`${end}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const num = (v: unknown) => Number(v);
const money2 = (n: number) => Math.round(n * 100) / 100;

interface Staff {
  employeeId: number;
  name: string;
  role: string;
  branch: string;
}

export class GoalsService {
  constructor(private readonly pool: Pool) {}

  /** The period waiting for approval, and the one before it. */
  private async periods() {
    const [rows] = await this.pool.query('SELECT period_end, state FROM mod_gi_period ORDER BY period_end DESC');
    const all = (rows as { period_end: unknown; state: string }[]).map((p) => ({ end: day(p.period_end), state: p.state }));
    const current = all[0];
    if (!current) throw new CoreError('NOT_FOUND', 'Goals and incentives aren’t loaded here.');
    return { current, prior: all[1] ?? null };
  }

  private async staff(): Promise<Staff[]> {
    const [rows] = await this.pool.query('SELECT e.employee_id, e.display_name, e.role, b.name AS branch FROM cdm_employee e JOIN cdm_location b ON b.int_id = e.branch_id ORDER BY b.name, e.employee_id');
    return (rows as Record<string, unknown>[]).map((r) => ({ employeeId: r.employee_id as number, name: r.display_name as string, role: r.role as string, branch: r.branch as string }));
  }

  private async cards(period: string, staff: Staff[]): Promise<Scorecard[]> {
    const [goals] = await this.pool.query('SELECT * FROM mod_gi_goal');
    const [incentives] = await this.pool.query('SELECT * FROM mod_gi_incentive');
    const [tiers] = await this.pool.query('SELECT * FROM mod_gi_tier ORDER BY incentive_id, tier');
    const [targets] = await this.pool.query('SELECT * FROM mod_gi_target');
    const [credits] = await this.pool.query('SELECT employee_id, goal_id, state, SUM(value) AS total FROM cdm_gi_credit WHERE period_end = ? GROUP BY employee_id, goal_id, state', [period]);
    const rules = new Map(
      (incentives as Record<string, unknown>[]).map((i) => [
        i.goal_id as string,
        { name: i.name as string, kind: i.payout_type as IncentiveRule['kind'], perUnit: i.per_unit === null ? null : num(i.per_unit), cap: i.cap_amount === null ? null : num(i.cap_amount), tiers: (tiers as Record<string, unknown>[]).filter((t) => t.incentive_id === i.incentive_id).map((t) => ({ tier: t.tier as number, lowerPct: t.lower_pct as number, amount: num(t.amount) })) } as IncentiveRule,
      ]),
    );
    const total = (emp: number, goal: string, state: string) => num((credits as Record<string, unknown>[]).find((c) => c.employee_id === emp && c.goal_id === goal && c.state === state)?.total ?? 0);
    const label = monthName(period);
    const [build] = await this.pool.query("SELECT as_of_date FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
    const asOf = day((build as { as_of_date: unknown }[])[0]?.as_of_date);
    return staff.map((s) => {
      const scored = (goals as Record<string, unknown>[])
        .filter((g) => g.role === s.role || g.role === '*')
        .map((g): GoalScore => {
          const goalId = g.goal_id as string;
          const own = (targets as Record<string, unknown>[]).find((t) => t.goal_id === goalId && t.employee_id === s.employeeId);
          const target = own ? num(own.target) : num(g.target);
          // The manager's goal is the branch's lenders added together (spec 17.4 team incentives).
          const actual = goalId === 'BRANCH_FUNDED' ? staff.filter((x) => x.branch === s.branch && x.role === 'Loan officer').reduce((n, x) => n + total(x.employeeId, 'FUNDED', 'counted'), 0) : total(s.employeeId, goalId, 'counted');
          const rule = rules.get(goalId) ?? null;
          const pay = rule ? payFor(rule, actual, target) : { earned: 0, capped: false, tier: null, next: null };
          return { goalId, name: g.name as string, unit: g.unit as GoalScore['unit'], unitLabel: g.unit_label as string, actual, target, targetFrom: own ? `Set for this person: ${String(own.reason)}` : g.role === '*' ? 'Set for the organization' : `Set for the ${String(g.role)} role`, pct: target ? Math.round((actual / target) * 100) : 0, pending: total(s.employeeId, goalId, 'active'), qualifier: g.goal_kind === 'qualifier', rule, ...pay };
        });
      const qualified = scored.filter((g) => g.qualifier).every((g) => g.actual >= g.target);
      const measured = scored.filter((g) => !g.qualifier);
      // A missed qualifier takes every other incentive for the period to zero (spec 17.4).
      const goalsOut = qualified ? scored : scored.map((g) => ({ ...g, earned: 0 }));
      return { employeeId: s.employeeId, name: s.name, role: s.role, branch: s.branch, periodEnd: period, period: label, asOf, goals: goalsOut, qualified, total: money2(goalsOut.reduce((n, g) => n + g.earned, 0)), behind: measured.some((g) => g.pct < 100) || !qualified };
    });
  }

  private inPurview = (s: Staff, ctx: CoreContext) => !ctx.purviewBranches || ctx.purviewBranches.includes(s.branch);

  /** Employees see themselves, leads and approvers their purview. Anyone else reads as not found (BE-GI-004). */
  private visible(staff: Staff[], who: GoalsWho, ctx: CoreContext) {
    const manages = who.leads || who.approves;
    return staff.filter((s) => s.employeeId === who.employeeId || (manages && this.inPurview(s, ctx)));
  }

  private find(staff: Staff[], name: string | undefined, who: GoalsWho, ctx: CoreContext) {
    if (!name) {
      const me = staff.find((s) => s.employeeId === who.employeeId);
      if (!me) throw new CoreError('NOT_FOUND', 'You don’t have a scorecard of your own. Ask about a branch or a person instead.');
      return me;
    }
    const words = name.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = this.visible(staff, who, ctx).filter((s) => words.every((w) => s.name.toLowerCase().replace(/\./g, '').includes(w.replace(/\./g, ''))));
    if (hit.length !== 1) throw new CoreError('NOT_FOUND', hit.length ? `More than one person matches “${name}”.` : `There’s nobody called “${name}” whose scorecard you can see.`);
    return hit[0]!;
  }

  /** gi.scorecard.get: only goals the person is eligible for (FE-GI-001). */
  async scorecard(name: string | undefined, who: GoalsWho, ctx: CoreContext): Promise<Scorecard> {
    const { current } = await this.periods();
    const staff = await this.staff();
    const s = this.find(staff, name, who, ctx);
    return (await this.cards(current.end, staff)).find((c) => c.employeeId === s.employeeId)!;
  }

  /** A branch's scorecards, those behind first. */
  async team(branch: string | undefined, who: GoalsWho, ctx: CoreContext): Promise<Scorecard[]> {
    if (!who.leads && !who.approves) throw new CoreError('NO_ACCESS', 'Team scorecards are for managers.');
    const { current } = await this.periods();
    const staff = await this.staff();
    const seen = this.visible(staff, who, ctx).filter((s) => !branch || s.branch.toLowerCase() === branch.toLowerCase());
    if (!seen.length) throw new CoreError('NOT_FOUND', branch ? `There’s no branch called “${branch}” that you can see.` : 'There’s nobody to show.');
    const wanted = new Set(seen.map((s) => s.employeeId));
    return (await this.cards(current.end, staff)).filter((c) => wanted.has(c.employeeId)).sort((a, b) => Number(b.behind) - Number(a.behind) || a.name.localeCompare(b.name));
  }

  /** gi.score.explain: the qualifying records, the rule and where the target came from (AI-AGT-170). */
  async explain(goal: string | undefined, name: string | undefined, who: GoalsWho, ctx: CoreContext): Promise<ScoreExplanation> {
    const { current } = await this.periods();
    const staff = await this.staff();
    const s = this.find(staff, name, who, ctx);
    const card = (await this.cards(current.end, staff)).find((c) => c.employeeId === s.employeeId)!;
    const paid = card.goals.filter((g) => g.rule);
    const asked = goal?.toLowerCase().replace(/s$/, '');
    const score = paid.find((g) => asked && `${g.name} ${g.rule!.name}`.toLowerCase().includes(asked)) ?? paid[0];
    if (!score) throw new CoreError('NOT_FOUND', 'That person has no incentive to explain.');
    const owners = score.goalId === 'BRANCH_FUNDED' ? staff.filter((x) => x.branch === s.branch && x.role === 'Loan officer').map((x) => x.employeeId) : [s.employeeId];
    const [rows] = await this.pool.query('SELECT occurred, label, value, state FROM cdm_gi_credit WHERE period_end = ? AND goal_id = ? AND employee_id IN (?) ORDER BY occurred DESC', [current.end, score.goalId === 'BRANCH_FUNDED' ? 'FUNDED' : score.goalId, owners]);
    const [build] = await this.pool.query("SELECT as_of_date FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
    return { score, card, records: (rows as Record<string, unknown>[]).map((r) => ({ date: day(r.occurred), label: r.label as string, value: num(r.value), counted: r.state === 'counted' })), rule: ruleText(score.rule!, score.unitLabel), asOf: day((build as { as_of_date: unknown }[])[0]?.as_of_date) };
  }

  /** gi.incentive.list_pending for one branch: each person's amount, adjustments and flags (FE-GI-002). */
  async batch(branch: string, who: GoalsWho, ctx: CoreContext): Promise<PayoutBatch> {
    if (!who.approves) throw new CoreError('NO_ACCESS', 'Approving incentives isn’t part of your access.');
    const { current, prior } = await this.periods();
    const staff = await this.staff();
    const inBranch = staff.filter((s) => s.branch.toLowerCase() === branch.toLowerCase() && this.inPurview(s, ctx));
    if (!inBranch.length) throw new CoreError('NOT_FOUND', `There’s no branch called “${branch}” that you can approve.`);
    const cards = (await this.cards(current.end, staff)).filter((c) => inBranch.some((s) => s.employeeId === c.employeeId));
    const before = prior ? await this.cards(prior.end, staff) : [];
    const [adjustments] = await this.pool.query('SELECT * FROM mod_gi_adjustment WHERE period_end = ?', [current.end]);
    const [decided] = await this.pool.query('SELECT employee_id, amount, status FROM mod_gi_payout WHERE period_end = ?', [current.end]);
    const adj = adjustments as Record<string, unknown>[];
    const lines = cards.map((c): PayoutLine => {
      const mine = adj.filter((a) => a.employee_id === c.employeeId);
      const approved = mine.filter((a) => a.status === 'Approved').map((a) => ({ amount: num(a.amount), reasonCode: a.reason_code as string, note: a.note as string }));
      const pending = mine.filter((a) => a.status === 'Pending');
      const amount = money2(c.total + approved.reduce((n, a) => n + a.amount, 0));
      const was = before.find((b) => b.employeeId === c.employeeId)?.total ?? 0;
      const failed = c.goals.find((g) => g.qualifier && g.actual < g.target);
      const own = c.employeeId === who.employeeId;
      const flags = [
        ...(failed ? [`${failed.name} ${failed.actual}, under ${failed.target}: no incentive this period`] : []),
        ...(unusual(amount, was) ? [`Up from ${usd(was)} last month`] : []),
        ...pending.map((a) => `${usd(num(a.amount))} adjustment (${String(a.reason_code)}) waiting for review, not included`),
        ...(c.goals.some((g) => g.capped) ? [`Capped: ${c.goals.find((g) => g.capped)!.name}`] : []),
        ...(own ? ['Your own payout: someone else has to approve it'] : []),
      ];
      const earning = c.goals.filter((g) => g.earned > 0);
      const row = (decided as Record<string, unknown>[]).find((d) => d.employee_id === c.employeeId);
      return { employeeId: c.employeeId, name: c.name, role: c.role, calculated: c.total, adjustments: approved, amount: row ? num(row.amount) : amount, incentives: earning.map((g) => `${g.rule!.name} ${usd(g.earned)}`).join(', ') || 'None earned', flags, own, status: row ? (row.status as string) : null };
    });
    // What this user can approve: their own never counts, and nothing is owed on a line at $0.
    const open = lines.filter((l) => !l.status && !l.own);
    const owed = open.filter((l) => l.amount > 0);
    return { periodEnd: current.end, period: monthName(current.end), branch: inBranch[0]!.branch, lines, total: money2(owed.reduce((n, l) => n + l.amount, 0)), flagged: open.filter((l) => l.flags.length).length, waiting: owed.length };
  }

  /** Every branch in the user's purview, for "show the October payouts". */
  async batches(who: GoalsWho, ctx: CoreContext): Promise<PayoutBatch[]> {
    const branches = [...new Set((await this.staff()).filter((s) => this.inPurview(s, ctx)).map((s) => s.branch))];
    return Promise.all(branches.map((b) => this.batch(b, who, ctx)));
  }

  /**
   * gi.incentive.approve, from an approved card. Amounts are checked against a fresh calculation, so
   * a late change stops the approval rather than paying a figure nobody saw. Nobody approves their own.
   */
  async approve(p: { branch: string; periodEnd: string; lines: { employeeId: number; name: string; amount: number }[] }, meta: { approvalId: string; userId: string }, who: GoalsWho, ctx: CoreContext) {
    const fresh = await this.batch(p.branch, who, ctx);
    if (fresh.periodEnd !== p.periodEnd) throw new CoreError('INVALID', 'That period has closed.');
    const [done] = await this.pool.query('SELECT 1 FROM mod_gi_payout WHERE approval_id = ? LIMIT 1', [meta.approvalId]);
    if ((done as unknown[]).length) return { replayed: true };
    for (const l of p.lines) {
      const now = fresh.lines.find((x) => x.employeeId === l.employeeId);
      if (!now || now.own) throw new CoreError('NO_ACCESS', 'A manager can’t approve their own incentive.');
      if (now.status) throw new CoreError('INVALID', `${l.name}’s payout has already been decided.`);
      if (now.amount !== l.amount) throw new CoreError('INVALID', `${l.name}’s amount has changed since this was prepared. Nothing was approved.`);
    }
    await this.pool.query('INSERT INTO mod_gi_payout (employee_id, period_end, amount, status, approver_user_id, approval_id, approved_at) VALUES ?', [p.lines.map((l) => [l.employeeId, p.periodEnd, l.amount, 'Approved', meta.userId, meta.approvalId, new Date()])]);
    return { replayed: false };
  }
}
