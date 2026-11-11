// The rest of DI's Onboarding Manager around the touch points: the full record list (touch type,
// priority, status, subscribed, account open date, last activity), follow-up rules that staff create,
// group and reuse, and adding people to onboarding one at a time or from an uploaded list.
// Writes happen on approval and are idempotent by the approval.
import { ONB_CONDITIONS, TOUCHES, type Pool } from '@dinext/tenant-db';
import { CoreError, memberNumber, type CoreContext } from './referrals.ts';

const day = (v: unknown) => (v === null || v === undefined ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const inScope = (ctx: CoreContext, column = 'b.name') => (ctx.purviewBranches ? { sql: ` AND ${column} IN (?)`, params: [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] } : { sql: '', params: [] as unknown[] });

export const RULE_CONDITIONS = Object.keys(ONB_CONDITIONS) as (keyof typeof ONB_CONDITIONS)[];
export const TOUCH_TYPES = ['Call', 'Email', 'Letter', 'Secure message', 'Visit'] as const;

export interface OnbRule {
  ruleId: number;
  name: string;
  group: string;
  condition: string;
  conditionLabel: string;
  afterDay: number;
  touch: string;
  touchType: string;
  priority: string;
  active: boolean;
  createdBy: string;
  createdOn: string;
  copiedFrom: number | null;
}

export interface RuleMatch {
  partyId: number;
  name: string;
  branch: string;
  branchId: number;
  day: number;
  assigneeId: number | null;
}

async function buildDate(pool: Pool) {
  const [b] = await rows<{ as_of_date: unknown }>(pool, "SELECT as_of_date FROM meta_build WHERE state = 'completed' ORDER BY as_of_date DESC LIMIT 1");
  return day(b?.as_of_date)!;
}

/** The SQL test for each rule condition, on cdm_digital_usage u and the person p. */
const CONDITION_SQL: Record<string, string> = {
  no_direct_deposit: "u.direct_deposit_status <> 'active'",
  no_digital: 'u.online_banking_since IS NULL AND u.mobile_since IS NULL',
  card_not_activated: "NOT EXISTS (SELECT 1 FROM cdm_card k WHERE k.party_id = p.party_id AND k.kind = 'Debit' AND k.activated IS NOT NULL)",
  single_product: '(SELECT COUNT(DISTINCT a.deposit_category) FROM cdm_deposit_account a WHERE a.party_id = p.party_id AND a.close_date IS NULL) + (SELECT COUNT(*) FROM cdm_loan l WHERE l.party_id = p.party_id AND l.close_date IS NULL AND l.charge_off_date IS NULL) <= 1',
  no_estatements: 'u.estatements_since IS NULL',
};

export class OnboardingDeskService {
  constructor(private readonly pool: Pool) {}

  /** Everyone in onboarding, with each person's next open touch point and DI's record columns. */
  async records(ctx: CoreContext, f: { subscribed?: boolean; priority?: string } = {}) {
    const asOf = await buildDate(this.pool);
    const scope = inScope(ctx);
    const list = await rows<Record<string, unknown>>(
      this.pool,
      `SELECT p.party_id, p.first_name, p.last_name, b.name AS branch, MIN(DATE_SUB(t.due, INTERVAL t.day_offset DAY)) AS started,
              SUM(t.status = 'Done') AS done, COUNT(*) AS total,
              (SELECT x.touch FROM onb_task x WHERE x.party_id = p.party_id AND x.status = 'Open' ORDER BY x.due LIMIT 1) AS next_touch,
              (SELECT x.touch_type FROM onb_task x WHERE x.party_id = p.party_id AND x.status = 'Open' ORDER BY x.due LIMIT 1) AS next_type,
              (SELECT x.priority FROM onb_task x WHERE x.party_id = p.party_id AND x.status = 'Open' ORDER BY x.due LIMIT 1) AS next_priority,
              (SELECT x.due FROM onb_task x WHERE x.party_id = p.party_id AND x.status = 'Open' ORDER BY x.due LIMIT 1) AS next_due,
              (SELECT e.display_name FROM onb_task x JOIN cdm_employee e ON e.employee_id = x.assignee_employee_id WHERE x.party_id = p.party_id ORDER BY x.due LIMIT 1) AS owner,
              s.subscribed, (SELECT MIN(a.open_date) FROM cdm_deposit_account a WHERE a.party_id = p.party_id) AS account_opened,
              GREATEST(COALESCE(u.last_login, '1900-01-01'), COALESCE((SELECT MAX(DATE(i.occurred_at)) FROM cdm_interaction i WHERE i.party_id = p.party_id), '1900-01-01'), COALESCE((SELECT MAX(x.done_on) FROM onb_task x WHERE x.party_id = p.party_id), '1900-01-01')) AS last_activity
         FROM onb_task t JOIN cdm_party p ON p.party_id = t.party_id JOIN cdm_location b ON b.int_id = t.branch_id
         LEFT JOIN onb_subscription s ON s.party_id = p.party_id LEFT JOIN cdm_digital_usage u ON u.party_id = p.party_id
        WHERE 1 = 1${scope.sql}
        GROUP BY p.party_id, p.first_name, p.last_name, b.name, s.subscribed, u.last_login
        ORDER BY started DESC`,
      scope.params,
    );
    const items = list.map((r) => {
      const next = day(r.next_due);
      const status = Number(r.done) === Number(r.total) ? 'Complete' : next && next < asOf ? 'Behind' : 'On track';
      const last = day(r.last_activity);
      return {
        partyId: r.party_id as number,
        name: `${r.first_name} ${r.last_name}`,
        last4: memberNumber(r.party_id as number).slice(-4),
        branch: r.branch as string,
        started: day(r.started)!,
        touchType: (r.next_type as string | null) ?? '—',
        nextTouch: (r.next_touch as string | null) ?? 'All done',
        nextDue: next,
        priority: (r.next_priority as string | null) ?? '—',
        status,
        progress: `${Number(r.done)} of ${Number(r.total)}`,
        owner: (r.owner as string | null) ?? 'Unassigned',
        subscribed: r.subscribed === null || r.subscribed === undefined ? null : Number(r.subscribed) === 1,
        accountOpened: day(r.account_opened),
        lastActivity: last && last > '1900-01-01' ? last : null,
      };
    });
    const filtered = items.filter((i) => (f.subscribed === undefined || i.subscribed === f.subscribed) && (!f.priority || i.priority.toLowerCase() === f.priority.toLowerCase()));
    return { asOf, total: filtered.length, items: filtered };
  }

  private toRule(r: Record<string, unknown>): OnbRule {
    return {
      ruleId: r.rule_id as number,
      name: r.name as string,
      group: r.group_name as string,
      condition: r.condition_code as string,
      conditionLabel: ONB_CONDITIONS[r.condition_code as string] ?? String(r.condition_code),
      afterDay: Number(r.after_day),
      touch: r.touch as string,
      touchType: r.touch_type as string,
      priority: r.priority as string,
      active: Number(r.active) === 1,
      createdBy: r.created_by as string,
      createdOn: day(r.created_on)!,
      copiedFrom: (r.copied_from as number | null) ?? null,
    };
  }

  async rules() {
    return (await rows<Record<string, unknown>>(this.pool, 'SELECT * FROM onb_rule ORDER BY group_name, after_day, rule_id').catch(() => [])).map((r) => this.toRule(r));
  }

  async rule(name: string) {
    const all = await this.rules();
    const n = name.trim().toLowerCase();
    const id = /^#?(\d+)$/.exec(n)?.[1];
    const hit = id ? all.find((r) => r.ruleId === Number(id)) : (all.find((r) => r.name.toLowerCase() === n) ?? all.find((r) => r.name.toLowerCase().includes(n)));
    if (!hit) throw new CoreError('NOT_FOUND', `There’s no follow-up rule called “${name}”.`);
    return hit;
  }

  /** Saves a rule once per approval. */
  async createRule(p: Omit<OnbRule, 'ruleId' | 'conditionLabel' | 'createdOn' | 'active'> & { active?: boolean }, meta: { approvalId: string }) {
    const asOf = await buildDate(this.pool);
    await this.pool.query(
      'INSERT INTO onb_rule (name, group_name, condition_code, after_day, touch, touch_type, priority, active, created_by, created_on, copied_from, approval_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE rule_id = rule_id',
      [p.name.slice(0, 80), p.group.slice(0, 60), p.condition, p.afterDay, p.touch.slice(0, 60), p.touchType, p.priority, p.active === false ? 0 : 1, p.createdBy, asOf, p.copiedFrom, meta.approvalId],
    );
  }

  async setActive(ruleId: number, active: boolean) {
    await this.pool.query('UPDATE onb_rule SET active = ? WHERE rule_id = ?', [active ? 1 : 0, ruleId]);
  }

  /** Who a rule catches today: people in their first 90 days, past the rule's day, meeting its condition, with no task from it yet. */
  async matches(rule: OnbRule, ctx: CoreContext): Promise<RuleMatch[]> {
    const asOf = await buildDate(this.pool);
    const cond = CONDITION_SQL[rule.condition];
    if (!cond) throw new CoreError('INVALID', `Rules can watch for: ${Object.values(ONB_CONDITIONS).join(', ')}.`);
    const scope = inScope(ctx);
    const list = await rows<{ party_id: number; first_name: string; last_name: string; branch: string; branch_id: number; started: unknown; owner: number | null }>(
      this.pool,
      `SELECT p.party_id, p.first_name, p.last_name, b.name AS branch, b.int_id AS branch_id, MIN(DATE_SUB(t.due, INTERVAL t.day_offset DAY)) AS started, MIN(t.assignee_employee_id) AS owner
         FROM onb_task t JOIN cdm_party p ON p.party_id = t.party_id JOIN cdm_location b ON b.int_id = t.branch_id JOIN cdm_digital_usage u ON u.party_id = p.party_id
        WHERE ${cond}${scope.sql} AND NOT EXISTS (SELECT 1 FROM onb_task r WHERE r.party_id = p.party_id AND r.rule_id = ?)
        GROUP BY p.party_id, p.first_name, p.last_name, b.name, b.int_id
       HAVING DATEDIFF(?, started) BETWEEN ? AND 90
        ORDER BY started`,
      [...scope.params, rule.ruleId, asOf, rule.afterDay],
    );
    return list.map((r) => ({ partyId: r.party_id, name: `${r.first_name} ${r.last_name}`, branch: r.branch, branchId: r.branch_id, day: Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${day(r.started)}T00:00:00Z`)) / 86_400_000), assigneeId: r.owner }));
  }

  /** Creates a rule's follow-up tasks, due today, once per person per rule. */
  async runRule(rule: OnbRule, people: RuleMatch[]) {
    const asOf = await buildDate(this.pool);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[m]] = (await conn.query('SELECT COALESCE(MAX(task_id), 0) AS m FROM onb_task FOR UPDATE')) as unknown as [{ m: number }[]];
      let next = Number(m?.m ?? 0) + 1;
      let made = 0;
      for (const p of people) {
        const [dup] = await conn.query('SELECT 1 FROM onb_task WHERE party_id = ? AND rule_id = ? LIMIT 1', [p.partyId, rule.ruleId]);
        if ((dup as unknown[]).length) continue;
        await conn.query("INSERT INTO onb_task (task_id, party_id, touch, day_offset, due, status, assignee_employee_id, branch_id, touch_type, priority, rule_id) VALUES (?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?)", [next++, p.partyId, rule.touch, p.day, asOf, p.assigneeId, p.branchId, rule.touchType, rule.priority, rule.ruleId]);
        made++;
      }
      await conn.commit();
      return made;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Whether someone is already in onboarding. */
  async inOnboarding(partyId: number) {
    return (await rows(this.pool, 'SELECT 1 FROM onb_task WHERE party_id = ? AND rule_id IS NULL LIMIT 1', [partyId])).length > 0;
  }

  /** People by member number or a unique name you can see, for adding to onboarding. */
  async resolve(entries: string[], ctx: CoreContext) {
    const ready: { line: number; partyId: number; name: string; branch: string; branchId: number }[] = [];
    const problems: { line: number; problem: string }[] = [];
    for (const [i, raw] of entries.entries()) {
      const line = i + 1;
      const v = raw.trim();
      if (!v) continue;
      const digits = v.replace(/\D/g, '');
      const parts = v.split(/\s+/);
      const hits = digits.length >= 6
        ? await rows<{ party_id: number; first_name: string; last_name: string; branch: string; branch_id: number }>(this.pool, 'SELECT p.party_id, p.first_name, p.last_name, b.name AS branch, b.int_id AS branch_id FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.party_id = ?', [Number(digits) - 10_004_520])
        : parts.length >= 2
          ? await rows<{ party_id: number; first_name: string; last_name: string; branch: string; branch_id: number }>(this.pool, 'SELECT p.party_id, p.first_name, p.last_name, b.name AS branch, b.int_id AS branch_id FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.first_name = ? AND p.last_name = ? LIMIT 3', [parts[0], parts.slice(1).join(' ')])
          : [];
      const seen = ctx.purviewBranches ? hits.filter((h) => ctx.purviewBranches!.includes(h.branch)) : hits;
      if (!seen.length) problems.push({ line, problem: `No one you can see matches “${v}”.` });
      else if (seen.length > 1) problems.push({ line, problem: `More than one person is named ${v}; use the member number.` });
      else if (await this.inOnboarding(seen[0]!.party_id)) problems.push({ line, problem: `${seen[0]!.first_name} ${seen[0]!.last_name} is already in onboarding.` });
      else if (ready.some((r) => r.partyId === seen[0]!.party_id)) problems.push({ line, problem: 'A repeat of an earlier row.' });
      else ready.push({ line, partyId: seen[0]!.party_id, name: `${seen[0]!.first_name} ${seen[0]!.last_name}`, branch: seen[0]!.branch, branchId: seen[0]!.branch_id });
    }
    return { ready, problems };
  }

  /** Starts each person's touch-point plan from today, with an owner, subscribed to the messages. */
  async add(people: { partyId: number; branchId: number }[], assigneeId: number | null) {
    const asOf = await buildDate(this.pool);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[m]] = (await conn.query('SELECT COALESCE(MAX(task_id), 0) AS m FROM onb_task FOR UPDATE')) as unknown as [{ m: number }[]];
      let next = Number(m?.m ?? 0) + 1;
      let added = 0;
      for (const p of people) {
        const [dup] = await conn.query('SELECT 1 FROM onb_task WHERE party_id = ? AND rule_id IS NULL LIMIT 1', [p.partyId]);
        if ((dup as unknown[]).length) continue;
        for (const [touch, offset] of TOUCHES) {
          const type = touch === 'Digital set-up check' ? 'Secure message' : touch === '60-day review' ? 'Email' : touch === '90-day review' ? 'Visit' : 'Call';
          const priority = touch === 'Welcome call' || touch === '30-day check-in' ? 'High' : 'Normal';
          await conn.query("INSERT INTO onb_task (task_id, party_id, touch, day_offset, due, status, assignee_employee_id, branch_id, touch_type, priority) VALUES (?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?)", [next++, p.partyId, touch, offset, plusDays(asOf, offset), assigneeId, p.branchId, type, priority]);
        }
        await conn.query('INSERT INTO onb_subscription (party_id, subscribed, changed) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE subscribed = 1, changed = VALUES(changed)', [p.partyId, asOf]);
        added++;
      }
      await conn.commit();
      return added;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}
