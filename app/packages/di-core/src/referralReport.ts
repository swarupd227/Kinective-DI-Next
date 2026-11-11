// Referral reporting (DI's Referral Manager list and reports): every referral with filters, whether a
// sale really opened the product in the core, conversion by type, sender, branch or the person who worked
// it, and the open referrals that have gone stale and expire. Expiring them is a change, on approval.
import { REFERRAL_EXPIRE_DAYS, REFERRAL_PRODUCT, type Pool } from '@dinext/tenant-db';
import { CLOSED_STAGES, LOST_STAGES, WON_STAGES, type CoreContext } from './referrals.ts';

const CLOSED_SQL = CLOSED_STAGES.map((s) => `'${s}'`).join(', ');
const won = (stage: unknown) => WON_STAGES.includes(String(stage));

const day = (v: unknown) => (v === null || v === undefined ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
const r1 = (n: number) => Math.round(n * 10) / 10;

export type RefGroupBy = 'type' | 'sender' | 'branch' | 'assignee';
export interface RefFilters { type?: string; stage?: string; branch?: string; sender?: string; assignee?: string; from?: string; to?: string; open?: boolean }

export interface RefRow {
  comId: number;
  type: string;
  typeId: string;
  member: string;
  branch: string;
  stage: string;
  sender: string;
  assignee: string | null;
  created: string;
  closed: string | null;
  /** For a sale: the matching account opened in the core, or null when none was found. */
  opened: { product: string; date: string } | null;
}

export class ReferralReportService {
  constructor(private readonly pool: Pool) {}

  private async rows(f: RefFilters, ctx: CoreContext): Promise<RefRow[]> {
    const where: string[] = ["c.definition = 'referral'", "c.type_id <> 'loan_follow_up'"];
    const params: unknown[] = [];
    const add = (sql: string, ...v: unknown[]) => (where.push(sql), params.push(...v));
    if (f.type) add('(t.label = ? OR c.type_id = ?)', f.type, f.type);
    if (f.stage) add('c.stage = ?', f.stage);
    if (f.branch) add('b.name = ?', f.branch);
    if (f.sender) add('c.sender_name LIKE ?', `%${f.sender}%`);
    if (f.assignee) add('e.display_name LIKE ?', `%${f.assignee}%`);
    if (f.from) add('c.created_at >= ?', f.from);
    if (f.to) add('c.created_at < DATE_ADD(?, INTERVAL 1 DAY)', f.to);
    if (f.open !== undefined) add(f.open ? `c.stage NOT IN (${CLOSED_SQL})` : `c.stage IN (${CLOSED_SQL})`);
    if (ctx.purviewBranches) add('b.name IN (?)', ctx.purviewBranches.length ? ctx.purviewBranches : ['']);
    const [found] = await this.pool.query(
      `SELECT c.com_id, c.type_id, t.label, c.party_id, p.first_name, p.last_name, b.name AS branch, c.stage, c.sender_name, e.display_name AS assignee, c.created_at, c.closed_at
         FROM esp_com_items c JOIN mod_ref_types t ON t.type_id = c.type_id JOIN cdm_party p ON p.party_id = c.party_id JOIN cdm_location b ON b.int_id = p.primary_branch_id
         LEFT JOIN cdm_employee e ON e.employee_id = c.assignee_employee_id
        WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC`,
      params,
    );
    const list = found as Record<string, unknown>[];
    // Match each sale to an account of the right kind opened from a week before the referral to 30 days after it closed.
    const sold = list.filter((r) => won(r.stage) && REFERRAL_PRODUCT[r.type_id as string]);
    const parties = [...new Set(sold.map((r) => r.party_id as number))];
    const accounts = parties.length
      ? ((await this.pool.query(`SELECT party_id, loan_category AS cat, open_date FROM cdm_loan WHERE party_id IN (?) UNION ALL SELECT party_id, deposit_category, open_date FROM cdm_deposit_account WHERE party_id IN (?)`, [parties, parties]))[0] as { party_id: number; cat: string; open_date: unknown }[])
      : [];
    return list.map((r) => {
      const created = day(r.created_at)!;
      const closed = day(r.closed_at);
      let opened: RefRow['opened'] = null;
      if (won(r.stage) && REFERRAL_PRODUCT[r.type_id as string]) {
        const lo = new Date(new Date(`${created}T00:00:00Z`).getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
        const hi = new Date(new Date(`${closed ?? created}T00:00:00Z`).getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
        const hit = accounts.find((a) => a.party_id === r.party_id && REFERRAL_PRODUCT[r.type_id as string]!.includes(a.cat) && day(a.open_date)! >= lo && day(a.open_date)! <= hi);
        if (hit) opened = { product: hit.cat, date: day(hit.open_date)! };
      }
      return { comId: r.com_id as number, type: r.label as string, typeId: r.type_id as string, member: `${r.first_name} ${r.last_name}`, branch: r.branch as string, stage: r.stage as string, sender: r.sender_name as string, assignee: (r.assignee as string | null) ?? null, created, closed, opened };
    });
  }

  /** Referrals matching the filters, newest first, with the product check for each sale. */
  async list(f: RefFilters, ctx: CoreContext, limit = 200) {
    const all = await this.rows(f, ctx);
    return { total: all.length, items: all.slice(0, limit) };
  }

  /**
   * Conversion over the last months, grouped: referrals made, sold, not interested, expired, still open,
   * the share of closed referrals that sold, days to close, and the share of sales that opened the product.
   */
  async performance(by: RefGroupBy, ctx: CoreContext, months = 12, since?: string) {
    const from = since ?? new Date(Date.now() - months * 30.4 * 86_400_000).toISOString().slice(0, 10);
    const all = await this.rows({ from }, ctx);
    const key = (r: RefRow) => (by === 'type' ? r.type : by === 'sender' ? r.sender : by === 'branch' ? r.branch : (r.assignee ?? 'Unassigned'));
    const groups = new Map<string, RefRow[]>();
    for (const r of all) (groups.get(key(r)) ?? groups.set(key(r), []).get(key(r))!).push(r);
    const summarize = (name: string, rs: RefRow[]) => {
      const n = (s: string) => rs.filter((r) => r.stage === s).length;
      const sold = rs.filter((r) => won(r.stage)).length;
      const closed = rs.filter((r) => r.closed).length;
      const days = rs.filter((r) => r.closed).map((r) => (new Date(`${r.closed}T00:00:00Z`).getTime() - new Date(`${r.created}T00:00:00Z`).getTime()) / 86_400_000);
      const checkable = rs.filter((r) => won(r.stage) && REFERRAL_PRODUCT[r.typeId]);
      return { name, referrals: rs.length, sold, notInterested: rs.filter((r) => LOST_STAGES.includes(r.stage)).length, expired: n('Expired'), open: rs.length - closed, conversionPct: closed ? r1((sold / closed) * 100) : null, avgDaysToClose: days.length ? r1(days.reduce((a, b) => a + b, 0) / days.length) : null, openedPct: checkable.length ? r1((checkable.filter((r) => r.opened).length / checkable.length) * 100) : null };
    };
    const rows = [...groups].map(([k, rs]) => summarize(k, rs)).sort((a, b) => b.referrals - a.referrals);
    return { by, months, from, rows, total: summarize('All referrals', all), notOpened: all.filter((r) => won(r.stage) && REFERRAL_PRODUCT[r.typeId] && !r.opened) };
  }

  /** Open referrals with no activity for the expiry period: what DI would expire. */
  async stale(ctx: CoreContext, days = REFERRAL_EXPIRE_DAYS) {
    const all = await this.rows({ open: true }, ctx);
    const [lines] = await this.pool.query('SELECT com_id, MAX(created_at) AS last FROM esp_com_lines WHERE com_id IN (?) GROUP BY com_id', [all.length ? all.map((r) => r.comId) : [0]]);
    const last = new Map((lines as { com_id: number; last: unknown }[]).map((l) => [l.com_id, day(l.last)!]));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return { days, items: all.filter((r) => (last.get(r.comId) ?? r.created) < cutoff).map((r) => ({ ...r, lastActivity: last.get(r.comId) ?? r.created })) };
  }

  /** Expire stale referrals: closed as Expired with a line on each one's history. */
  async expire(comIds: number[], meta: { userId: string; userName: string }) {
    if (!comIds.length) return 0;
    const [r] = await this.pool.query(`UPDATE esp_com_items SET stage = 'Expired', closed_at = NOW(3) WHERE com_id IN (?) AND stage NOT IN (${CLOSED_SQL})`, [comIds]);
    for (const id of comIds) await this.pool.query("INSERT INTO esp_com_lines (com_id, kind, text, by_user_id, created_at) VALUES (?, 'stage', ?, ?, NOW(3))", [id, `Expired after ${REFERRAL_EXPIRE_DAYS} days with no activity (approved by ${meta.userName}).`, meta.userId]);
    return (r as { affectedRows: number }).affectedRows;
  }
}
