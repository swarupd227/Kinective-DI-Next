// DI Core for Indirect Lending (spec 8.28) and Outbound Prospecting (8.31). Every figure, distance and
// visit order is worked out here; an agent only chooses what to ask for. Purview filters by the
// branch a dealer or prospect belongs to, and outside it a record reads as not found.
import { branchPlace } from '@dinext/tenant-db';
import type { Pool } from '@dinext/tenant-db';
import { CoreError, type CoreContext } from './referrals.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
const scope = (ctx: CoreContext, column: string) => (ctx.purviewBranches ? { sql: ` AND ${column} IN (?)`, params: [ctx.purviewBranches.length ? ctx.purviewBranches : ['']] } : { sql: '', params: [] as unknown[] });

/** Miles between two points, as the crow flies. */
export function miles(a: readonly [number, number], b: readonly [number, number]) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

/** Nearest stop next, from a start point. Good enough for a day's visits. */
export function visitOrder<T extends { at: readonly [number, number] }>(start: readonly [number, number], stops: T[]) {
  const left = [...stops];
  const out: (T & { leg: number })[] = [];
  let here = start;
  while (left.length) {
    left.sort((x, y) => miles(here, x.at) - miles(here, y.at));
    const next = left.shift()!;
    out.push({ ...next, leg: Math.round(miles(here, next.at) * 10) / 10 });
    here = next.at;
  }
  return out;
}

export const directionsLink = (start: readonly [number, number], stops: readonly (readonly [number, number])[]) => {
  const p = (x: readonly [number, number]) => `${x[0]},${x[1]}`;
  const last = stops.at(-1);
  if (!last) return null;
  return `https://www.google.com/maps/dir/?api=1&origin=${p(start)}&destination=${p(last)}${stops.length > 1 ? `&waypoints=${stops.slice(0, -1).map(p).join('%7C')}` : ''}`;
};

async function branchAt(pool: Pool, name: string) {
  const list = await rows<{ name: string }>(pool, 'SELECT name FROM cdm_location ORDER BY int_id');
  const i = list.findIndex((b) => b.name.toLowerCase() === name.toLowerCase());
  if (i < 0) throw new CoreError('NOT_FOUND', `There’s no branch called ${name}. They are: ${list.map((b) => b.name).join(', ')}.`);
  return { name: list[i]!.name, at: branchPlace(i) };
}

const latestMonth = async (pool: Pool) => (await rows<{ m: string }>(pool, 'SELECT MAX(month) AS m FROM ind_dealer_month'))[0]?.m ?? '';
const shift = (month: string, by: number) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const quarterOf = (month: string) => Math.floor((Number(month.slice(5, 7)) - 1) / 3);
const monthsOfQuarter = (year: number, q: number) => [1, 2, 3].map((k) => `${year}-${String(q * 3 + k).padStart(2, '0')}`);

// ---- indirect lending ---------------------------------------------------------------------------

export interface DealerFigures {
  dealerId: number;
  name: string;
  branch: string;
  rep: string;
  status: string;
  received: number;
  approved: number;
  declined: number;
  countered: number;
  funded: number;
  fundedAmount: number;
  avgFico: number;
  prior: { received: number; funded: number; fundedAmount: number };
}

export class IndirectService {
  constructor(private readonly pool: Pool) {}

  /** This period and the one before: a month against the month before, or a quarter to date against the last quarter. */
  async periods(period: 'month' | 'quarter') {
    const m = await latestMonth(this.pool);
    // The last build may fall mid-month: then the period so far is set against a whole one.
    const [b] = await rows<{ d: unknown }>(this.pool, "SELECT MAX(as_of_date) AS d FROM meta_build WHERE state = 'completed'");
    const asOf = day(b?.d);
    const monthDone = asOf >= new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
    if (period === 'month') return { label: `${monthLabel(m)}${monthDone ? '' : ' to date'}`, partial: !monthDone, months: [m], priorLabel: monthLabel(shift(m, -1)), priorMonths: [shift(m, -1)] };
    const year = Number(m.slice(0, 4));
    const q = quarterOf(m);
    const months = monthsOfQuarter(year, q).filter((x) => x <= m);
    const partial = months.length < 3 || !monthDone;
    const prior = q ? monthsOfQuarter(year, q - 1) : monthsOfQuarter(year - 1, 3);
    return { label: `Q${q + 1} ${year}${partial ? ' to date' : ''}`, partial, months, priorLabel: `Q${q ? q : 4} ${q ? year : year - 1}`, priorMonths: prior };
  }

  async performance(period: 'month' | 'quarter', ctx: CoreContext) {
    const p = await this.periods(period);
    const s = scope(ctx, 'd.branch');
    const sum = (months: string[]) => `SUM(CASE WHEN m.month IN (${months.map(() => '?').join(', ')}) THEN `;
    const list = await rows<Record<string, unknown>>(
      this.pool,
      `SELECT d.dealer_id, d.name, d.branch, d.rep, d.status,
        COALESCE(${sum(p.months)}m.received END), 0) AS received, COALESCE(${sum(p.months)}m.approved END), 0) AS approved, COALESCE(${sum(p.months)}m.declined END), 0) AS declined, COALESCE(${sum(p.months)}m.countered END), 0) AS countered,
        COALESCE(${sum(p.months)}m.funded END), 0) AS funded, COALESCE(${sum(p.months)}m.funded_amount END), 0) AS funded_amount, COALESCE(ROUND(${sum(p.months)}m.avg_fico * m.funded END) / NULLIF(${sum(p.months)}m.funded END), 0)), 0) AS fico,
        COALESCE(${sum(p.priorMonths)}m.received END), 0) AS p_received, COALESCE(${sum(p.priorMonths)}m.funded END), 0) AS p_funded, COALESCE(${sum(p.priorMonths)}m.funded_amount END), 0) AS p_amount
       FROM ind_dealer d LEFT JOIN ind_dealer_month m ON m.dealer_id = d.dealer_id WHERE 1 = 1${s.sql} GROUP BY d.dealer_id ORDER BY received DESC`,
      [...Array(8).fill(p.months).flat(), ...Array(3).fill(p.priorMonths).flat(), ...s.params],
    );
    const dealers = list.map((r): DealerFigures => ({ dealerId: r.dealer_id as number, name: r.name as string, branch: r.branch as string, rep: r.rep as string, status: r.status as string, received: Number(r.received), approved: Number(r.approved), declined: Number(r.declined), countered: Number(r.countered), funded: Number(r.funded), fundedAmount: Number(r.funded_amount), avgFico: Number(r.fico), prior: { received: Number(r.p_received), funded: Number(r.p_funded), fundedAmount: Number(r.p_amount) } }));
    return { ...p, dealers };
  }

  /**
   * How each dealer's loans are performing, from each indirect loan's dealer (ESP phase 1b): open balance,
   * the share 30 and 60+ days late, loans charged off and the average credit score at origination. Worst
   * 60+ share first. Null where loan terms aren't loaded.
   */
  async loanQuality(ctx: CoreContext) {
    const s = scope(ctx, 'd.branch');
    const list = await rows<Record<string, unknown>>(
      this.pool,
      `SELECT d.dealer_id, d.name, d.branch, d.status,
              SUM(l.close_date IS NULL AND l.charge_off_date IS NULL) AS open_loans,
              SUM(CASE WHEN l.close_date IS NULL AND l.charge_off_date IS NULL THEN l.balance ELSE 0 END) AS balance,
              SUM(CASE WHEN l.close_date IS NULL AND l.charge_off_date IS NULL AND l.days_delinquent >= 30 THEN l.balance ELSE 0 END) AS dq30,
              SUM(CASE WHEN l.close_date IS NULL AND l.charge_off_date IS NULL AND l.days_delinquent >= 60 THEN l.balance ELSE 0 END) AS dq60,
              SUM(l.charge_off_date IS NOT NULL) AS charged_off, ROUND(AVG(l.credit_score)) AS score
         FROM ind_dealer d JOIN cdm_loan_terms t ON t.dealer_id = d.dealer_id JOIN cdm_loan l ON l.loan_id = t.loan_id
        WHERE l.is_indirect = 1${s.sql} GROUP BY d.dealer_id`,
      s.params,
    ).catch(() => null);
    if (!list) return null;
    const dealers = list
      .map((r) => {
        const balance = Number(r.balance);
        return { dealerId: Number(r.dealer_id), name: String(r.name), branch: String(r.branch), status: String(r.status), openLoans: Number(r.open_loans), balance, dq30Pct: balance ? (Number(r.dq30) / balance) * 100 : 0, dq60Pct: balance ? (Number(r.dq60) / balance) * 100 : 0, chargedOff: Number(r.charged_off), avgScore: r.score === null ? null : Number(r.score) };
      })
      .sort((a, b) => b.dq60Pct - a.dq60Pct || b.balance - a.balance);
    const total = dealers.reduce((t, d) => t + d.balance, 0);
    const dq60 = dealers.reduce((t, d) => t + (d.dq60Pct / 100) * d.balance, 0);
    return { dealers, balance: total, dq60Pct: total ? (dq60 / total) * 100 : 0 };
  }

  async dealer(name: string, ctx: CoreContext) {
    const s = scope(ctx, 'branch');
    const words = name.toLowerCase().split(/\s+/).filter(Boolean);
    const all = await rows<Record<string, unknown>>(this.pool, `SELECT * FROM ind_dealer WHERE 1 = 1${s.sql}`, s.params);
    const hits = all.filter((d) => words.every((w) => String(d.name).toLowerCase().includes(w)));
    if (hits.length !== 1) throw new CoreError('NOT_FOUND', hits.length ? `More than one dealer matches “${name}”.` : `There’s no dealer called “${name}” that you can see.`);
    const d = hits[0]!;
    const visits = await rows<Record<string, unknown>>(this.pool, 'SELECT on_date, note, by_name FROM ind_visit WHERE dealer_id = ? ORDER BY visit_id DESC LIMIT 3', [d.dealer_id]);
    return { dealerId: d.dealer_id as number, name: d.name as string, branch: d.branch as string, rep: d.rep as string, status: d.status as string, ytdVisits: d.ytd_visits as number, lastVisited: d.last_visited ? day(d.last_visited) : null, ids: { cudl: d.cudl_id as string, dealertrack: d.dealertrack_id as string, routeone: d.routeone_id as string }, at: [Number(d.lat), Number(d.lng)] as [number, number], visits: visits.map((v) => ({ on: day(v.on_date), note: v.note as string, by: v.by_name as string })) };
  }

  /** The busiest active dealers this month, in visit order from a branch. */
  async planVisits(count: number, near: string, ctx: CoreContext) {
    const start = await branchAt(this.pool, near);
    const { dealers } = await this.performance('month', ctx);
    const chosen = dealers.filter((d) => d.status === 'Active').slice(0, count);
    const places = await rows<{ dealer_id: number; lat: string; lng: string }>(this.pool, 'SELECT dealer_id, lat, lng FROM ind_dealer');
    const at = (id: number) => { const p = places.find((x) => x.dealer_id === id)!; return [Number(p.lat), Number(p.lng)] as const; };
    const stops = visitOrder(start.at, chosen.map((d) => ({ ...d, at: at(d.dealerId) })));
    return { start: start.name, stops, total: Math.round(stops.reduce((n, s) => n + s.leg, 0) * 10) / 10, directions: directionsLink(start.at, stops.map((s) => s.at)) };
  }

  async logVisit(dealerId: number, note: string, meta: { approvalId: string; actor: string; on: string }) {
    const [r] = (await this.pool.query('INSERT IGNORE INTO ind_visit (dealer_id, on_date, note, by_name, approval_id) VALUES (?, ?, ?, ?, ?)', [dealerId, meta.on, note.slice(0, 300), meta.actor, meta.approvalId])) as unknown as [{ affectedRows: number }];
    if (r.affectedRows) await this.pool.query('UPDATE ind_dealer SET ytd_visits = ytd_visits + 1, last_visited = ? WHERE dealer_id = ?', [meta.on, dealerId]);
  }

  async setRep(dealerId: number, rep: string) {
    await this.pool.query('UPDATE ind_dealer SET rep = ? WHERE dealer_id = ?', [rep, dealerId]);
  }

  /** Indirect borrowers who later opened a deposit account with the institution, by the year of that account. */
  async directConversion(year: number, ctx: CoreContext) {
    const s = scope(ctx, 'b.name');
    const [r] = await rows<{ borrowers: number; converted: number }>(this.pool, `SELECT COUNT(DISTINCT l.party_id) AS borrowers, COUNT(DISTINCT CASE WHEN d.account_id IS NOT NULL THEN l.party_id END) AS converted FROM cdm_loan l JOIN cdm_location b ON b.int_id = l.branch_id LEFT JOIN cdm_deposit_account d ON d.party_id = l.party_id AND d.open_date > l.open_date AND YEAR(d.open_date) = ? WHERE l.is_indirect = 1${s.sql}`, [year, ...s.params]);
    return { year, borrowers: Number(r?.borrowers ?? 0), converted: Number(r?.converted ?? 0) };
  }
}

const monthLabel = (m: string) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-15T00:00:00Z`));

// ---- outbound prospecting -----------------------------------------------------------------------

export interface Prospect {
  prospectId: number;
  company: string;
  contact: string;
  branch: string;
  assets: number;
  grade: string;
  stage: string;
  disposition: string;
  owner: string;
  nextFollowUp: string | null;
  at: [number, number];
}

export class ProspectService {
  constructor(private readonly pool: Pool) {}

  /** The tenant's stages, in order, and its dispositions (FE-OBP-001). */
  async config() {
    const stages = (await rows<{ name: string }>(this.pool, 'SELECT name FROM prs_stage ORDER BY position')).map((s) => s.name);
    const dispositions = (await rows<{ name: string }>(this.pool, 'SELECT name FROM prs_disposition ORDER BY name')).map((d) => d.name);
    return { stages, dispositions };
  }

  private toProspect = (r: Record<string, unknown>): Prospect => ({ prospectId: r.prospect_id as number, company: r.company as string, contact: r.contact as string, branch: r.branch as string, assets: Number(r.assets), grade: r.grade as string, stage: r.stage as string, disposition: r.disposition as string, owner: r.owner as string, nextFollowUp: r.next_follow_up ? day(r.next_follow_up) : null, at: [Number(r.lat), Number(r.lng)] });

  async list(f: { stage?: string; minAssets?: number }, ctx: CoreContext) {
    const s = scope(ctx, 'branch');
    const all = (await rows<Record<string, unknown>>(this.pool, `SELECT * FROM prs_prospect WHERE 1 = 1${s.sql} ORDER BY assets DESC`, s.params)).map(this.toProspect);
    return all.filter((p) => (!f.stage || p.stage.toLowerCase() === f.stage.toLowerCase()) && (f.minAssets === undefined || p.assets >= f.minAssets));
  }

  async funnel(ctx: CoreContext) {
    const { stages } = await this.config();
    const all = await this.list({}, ctx);
    return stages.map((stage) => ({ stage, count: all.filter((p) => p.stage === stage).length }));
  }

  async find(name: string, ctx: CoreContext) {
    const words = name.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = (await this.list({}, ctx)).filter((p) => words.every((w) => p.company.toLowerCase().includes(w)));
    if (hits.length !== 1) throw new CoreError('NOT_FOUND', hits.length ? `More than one prospect matches “${name}”.` : `There’s no prospect called “${name}” that you can see.`);
    return hits[0]!;
  }

  async timeline(prospectId: number) {
    const list = await rows<Record<string, unknown>>(this.pool, 'SELECT on_date, kind, note, by_name FROM prs_activity WHERE prospect_id = ? ORDER BY on_date DESC, activity_id DESC LIMIT 5', [prospectId]);
    return list.map((a) => ({ on: day(a.on_date), kind: a.kind as string, note: a.note as string, by: a.by_name as string }));
  }

  /** Prospects within a radius of a branch, in visit order, with a directions link (FE-OBP-002). */
  async route(near: string, radius: number, ctx: CoreContext) {
    const start = await branchAt(this.pool, near);
    const inside = (await this.list({}, ctx)).filter((p) => !['Approved'].includes(p.stage)).map((p) => ({ ...p, away: Math.round(miles(start.at, p.at) * 10) / 10 })).filter((p) => p.away <= radius);
    const stops = visitOrder(start.at, inside);
    return { start: start.name, radius, stops, total: Math.round(stops.reduce((n, s) => n + s.leg, 0) * 10) / 10, directions: directionsLink(start.at, stops.map((s) => s.at)) };
  }

  async logCall(prospectId: number, p: { note: string; disposition: string | null }, meta: { approvalId: string; actor: string; on: string }) {
    const [r] = (await this.pool.query("INSERT IGNORE INTO prs_activity (prospect_id, on_date, kind, note, by_name, approval_id) VALUES (?, ?, 'Call', ?, ?, ?)", [prospectId, meta.on, p.note.slice(0, 300), meta.actor, meta.approvalId])) as unknown as [{ affectedRows: number }];
    if (r.affectedRows && p.disposition) await this.pool.query('UPDATE prs_prospect SET disposition = ? WHERE prospect_id = ?', [p.disposition, prospectId]);
  }

  /** A stage change goes on the prospect's timeline (FE-OBP-003). */
  async setStage(prospectId: number, from: string, to: string, meta: { approvalId: string; actor: string; on: string }) {
    const [r] = (await this.pool.query("INSERT IGNORE INTO prs_activity (prospect_id, on_date, kind, from_stage, to_stage, note, by_name, approval_id) VALUES (?, ?, 'Stage change', ?, ?, ?, ?, ?)", [prospectId, meta.on, from, to, `Moved to ${to}.`, meta.actor, meta.approvalId])) as unknown as [{ affectedRows: number }];
    if (r.affectedRows) await this.pool.query('UPDATE prs_prospect SET stage = ? WHERE prospect_id = ?', [to, prospectId]);
  }

  /** Of the prospects that entered one stage in a quarter, how many have since reached another. */
  async conversion(from: string, to: string, quarter: { start: string; end: string }, ctx: CoreContext) {
    const { stages } = await this.config();
    const a = stages.findIndex((s) => s.toLowerCase() === from.toLowerCase());
    const b = stages.findIndex((s) => s.toLowerCase() === to.toLowerCase());
    if (a < 0 || b < 0) throw new CoreError('INVALID', `Which stages? They are: ${stages.join(', ')}.`);
    if (b <= a) throw new CoreError('INVALID', `${stages[b]} comes before ${stages[a]}. Ask for an earlier stage first.`);
    const s = scope(ctx, 'p.branch');
    const entered = await rows<{ prospect_id: number }>(this.pool, `SELECT DISTINCT a.prospect_id FROM prs_activity a JOIN prs_prospect p ON p.prospect_id = a.prospect_id WHERE a.kind = 'Stage change' AND a.to_stage = ? AND a.on_date BETWEEN ? AND ?${s.sql}`, [stages[a], quarter.start, quarter.end, ...s.params]);
    const ids = entered.map((e) => e.prospect_id);
    const reached = ids.length ? await rows<{ prospect_id: number }>(this.pool, 'SELECT DISTINCT prospect_id FROM prs_activity WHERE kind = \'Stage change\' AND to_stage IN (?) AND prospect_id IN (?)', [stages.slice(b), ids]) : [];
    return { from: stages[a]!, to: stages[b]!, entered: ids.length, reached: reached.length, pct: ids.length ? Math.round((reached.length / ids.length) * 1000) / 10 : 0 };
  }
}
