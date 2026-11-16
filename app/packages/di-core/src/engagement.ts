// Membership applications, alerts and marketing touches (ESP phase 7): how applications move from started
// to opened and where they drop out, who is already a member, the events on accounts and people this
// week or month, and how often campaigns reach each person. Every figure is worked out here; the agents
// only word it.
import type { Pool } from '@dinext/tenant-db';
import { memberNumber } from './relationship.ts';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export class EngagementService {
  constructor(private readonly pool: Pool) {}

  private async asOf() {
    const [b] = await rows<{ d: unknown }>(this.pool, 'SELECT MAX(as_of_date) AS d FROM meta_build').catch(() => []);
    return b?.d ? day(b.d) : null;
  }

  /**
   * Applications to join over the last `months`: how many were started, submitted, approved and opened,
   * by channel and branch; why the rest didn't open; how long opening took; the ones still waiting; and
   * applicants who are already members. Null where applications aren't loaded.
   */
  async applications(months = 12, branches?: string[]) {
    const asOf = await this.asOf();
    const has = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM cdm_membership_application').catch(() => null);
    if (!asOf || !has?.[0] || !Number(has[0].n)) return null;
    const where = branches?.length ? ` AND l.name IN (${branches.map(() => '?').join(', ')})` : '';
    const found = await rows<{ application_id: number; applied: unknown; channel: string; branch: string; status: string; booked: number; denied: number; withdrawn: number; opened_date: unknown; denial_reason: string | null; status_date: unknown }>(
      this.pool,
      `SELECT a.application_id, a.applied, a.channel, l.name AS branch, s.name AS status, s.booked, s.denied, s.withdrawn, a.opened_date, a.denial_reason, a.status_date
         FROM cdm_membership_application a JOIN cdm_application_status s ON s.status_id = a.status_id JOIN cdm_location l ON l.int_id = a.branch_id
        WHERE a.applied > DATE_SUB(?, INTERVAL ? MONTH)${where}`,
      [asOf, months, ...(branches ?? [])],
    );
    const total = found.length;
    const opened = found.filter((r) => Number(r.booked));
    const tally = (key: (r: (typeof found)[number]) => string) => {
      const by = new Map<string, { started: number; opened: number; denied: number; withdrawn: number; abandoned: number; waiting: number }>();
      for (const r of found) {
        const k = key(r);
        const v = by.get(k) ?? { started: 0, opened: 0, denied: 0, withdrawn: 0, abandoned: 0, waiting: 0 };
        v.started++;
        if (Number(r.booked)) v.opened++;
        else if (Number(r.denied)) v.denied++;
        else if (r.status === 'Abandoned') v.abandoned++;
        else if (Number(r.withdrawn)) v.withdrawn++;
        else v.waiting++;
        by.set(k, v);
      }
      return [...by].map(([name, v]) => ({ name, ...v, openedPct: pct(v.opened, v.started) })).sort((a, b) => b.started - a.started);
    };
    const days = opened.map((r) => Math.round((Date.parse(day(r.opened_date)) - Date.parse(day(r.applied))) / 86_400_000)).sort((a, b) => a - b);
    const reasons = new Map<string, number>();
    for (const r of found) if (r.denial_reason) reasons.set(r.denial_reason, (reasons.get(r.denial_reason) ?? 0) + 1);
    const waiting = found.filter((r) => !Number(r.booked) && !Number(r.denied) && !Number(r.withdrawn));
    const matched = await rows<{ status: string; n: number }>(
      this.pool,
      `SELECT m.status, COUNT(*) AS n FROM cdm_person_match m JOIN cdm_membership_applicant ap ON ap.applicant_id = m.source_id JOIN cdm_membership_application a ON a.application_id = ap.application_id
        WHERE m.source_table = 'cdm_membership_applicant' AND a.applied > DATE_SUB(?, INTERVAL ? MONTH) GROUP BY m.status`,
      [asOf, months],
    ).catch(() => []);
    const byMonth = await rows<{ m: string; started: number; opened: number }>(
      this.pool,
      `SELECT DATE_FORMAT(a.applied, '%Y-%m') AS m, COUNT(*) AS started, SUM(s.booked) AS opened FROM cdm_membership_application a JOIN cdm_application_status s ON s.status_id = a.status_id JOIN cdm_location l ON l.int_id = a.branch_id
        WHERE a.applied > DATE_SUB(?, INTERVAL ? MONTH)${where} GROUP BY DATE_FORMAT(a.applied, '%Y-%m') ORDER BY 1`,
      [asOf, months, ...(branches ?? [])],
    );
    return {
      asOf,
      months,
      total,
      opened: opened.length,
      openedPct: pct(opened.length, total),
      medianDays: days.length ? days[Math.floor(days.length / 2)]! : null,
      byChannel: tally((r) => r.channel),
      byBranch: tally((r) => r.branch),
      byMonth: byMonth.map((r) => ({ month: r.m, started: Number(r.started), opened: Number(r.opened) })),
      denials: [...reasons].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count),
      waiting: waiting.map((r) => ({ applicationId: Number(r.application_id), applied: day(r.applied), status: r.status, channel: r.channel, branch: r.branch })).sort((a, b) => a.applied.localeCompare(b.applied)),
      alreadyMembers: Object.fromEntries(matched.map((m) => [m.status, Number(m.n)])) as Record<string, number>,
    };
  }

  /** Alerts over the last `days`: by type, and the latest, with whose they are. Limited to the branches given. */
  async alerts(days = 7, branches?: string[]) {
    const asOf = await this.asOf();
    const has = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM cdm_alert_type').catch(() => null);
    if (!asOf || !has?.[0] || !Number(has[0].n)) return null;
    const where = branches?.length ? ` AND l.name IN (${branches.map(() => '?').join(', ')})` : '';
    const found = await rows<{ party_id: number; first_name: string; last_name: string; branch: string; type: string; code: string; description: string; event_date: unknown }>(
      this.pool,
      `SELECT x.party_id, p.first_name, p.last_name, l.name AS branch, t.name AS type, t.code, x.description, x.event_date FROM (
          SELECT a.primary_party_id AS party_id, aa.type_id, aa.description, aa.event_date FROM cdm_account_alert aa JOIN cdm_account a ON a.account_number = aa.account_number
          UNION ALL SELECT pa.party_id, pa.type_id, pa.description, pa.event_date FROM cdm_person_alert pa) x
         JOIN cdm_alert_type t ON t.type_id = x.type_id JOIN cdm_party p ON p.party_id = x.party_id JOIN cdm_location l ON l.int_id = p.primary_branch_id
        WHERE x.event_date > DATE_SUB(?, INTERVAL ? DAY) AND x.event_date <= DATE_ADD(?, INTERVAL 30 DAY)${where}
        ORDER BY x.event_date DESC, x.party_id`,
      [asOf, days, asOf, ...(branches ?? [])],
    );
    const by = new Map<string, { type: string; code: string; count: number; people: Set<number> }>();
    for (const r of found) {
      const v = by.get(r.code) ?? { type: r.type, code: r.code, count: 0, people: new Set<number>() };
      v.count++;
      v.people.add(Number(r.party_id));
      by.set(r.code, v);
    }
    return {
      asOf,
      days,
      total: found.length,
      byType: [...by.values()].map((v) => ({ type: v.type, code: v.code, count: v.count, people: v.people.size })).sort((a, b) => b.count - a.count),
      items: found.map((r) => ({ partyId: Number(r.party_id), name: `${r.first_name} ${r.last_name}`, memberNumber: memberNumber(Number(r.party_id)), branch: r.branch, type: r.type, code: r.code, description: r.description, date: day(r.event_date) })),
    };
  }

  /**
   * How campaigns reached people: each campaign's sends to members and to addresses of people who weren't
   * members, how many of those joined within 90 days, and the members reached most often over the last
   * `days`.
   */
  async touches(days = 365) {
    const asOf = await this.asOf();
    const has = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM cmp_touch').catch(() => null);
    if (!asOf || !has?.[0] || !Number(has[0].n)) return null;
    const campaigns = await rows<{ campaign_id: number; name: string; channel: string; launched: unknown; sends: number; members: number; non_members: number; joined: number; credited: number }>(
      this.pool,
      `SELECT c.campaign_id, c.name, c.channel, c.launched,
              SUM(t.action <> 'Reminder') AS sends, COUNT(DISTINCT CASE WHEN t.was_member = 1 THEN t.party_id END) AS members,
              SUM(t.was_member = 0) AS non_members, COUNT(DISTINCT CASE WHEN t.was_member = 0 THEN t.party_id END) AS joined,
              (SELECT COUNT(DISTINCT a.party_id) FROM cmp_attribution a WHERE a.campaign_id = c.campaign_id) AS credited
         FROM cmp_campaign c JOIN cmp_touch t ON t.campaign_id = c.campaign_id
        WHERE c.launched > DATE_SUB(?, INTERVAL ? DAY) GROUP BY c.campaign_id, c.name, c.channel, c.launched ORDER BY c.launched DESC`,
      [asOf, days],
    );
    const frequency = await rows<{ n: number; people: number }>(
      this.pool,
      `SELECT x.n, COUNT(*) AS people FROM (SELECT party_id, COUNT(DISTINCT campaign_id) AS n FROM cmp_touch WHERE party_id IS NOT NULL AND was_member = 1 AND touched > DATE_SUB(?, INTERVAL ? DAY) GROUP BY party_id) x GROUP BY x.n ORDER BY x.n`,
      [asOf, days],
    );
    const most = await rows<{ party_id: number; first_name: string; last_name: string; branch: string; n: number; sends: number }>(
      this.pool,
      `SELECT t.party_id, p.first_name, p.last_name, l.name AS branch, COUNT(DISTINCT t.campaign_id) AS n, COUNT(*) AS sends
         FROM cmp_touch t JOIN cdm_party p ON p.party_id = t.party_id JOIN cdm_location l ON l.int_id = p.primary_branch_id
        WHERE t.was_member = 1 AND t.touched > DATE_SUB(?, INTERVAL ? DAY) GROUP BY t.party_id, p.first_name, p.last_name, l.name ORDER BY COUNT(DISTINCT t.campaign_id) DESC, COUNT(*) DESC, t.party_id LIMIT 15`,
      [asOf, days],
    );
    const reached = frequency.reduce((s, f) => s + Number(f.people), 0);
    const heavy = frequency.filter((f) => Number(f.n) >= 5).reduce((s, f) => s + Number(f.people), 0);
    return {
      asOf,
      days,
      campaigns: campaigns.map((c) => ({ campaignId: Number(c.campaign_id), name: c.name, channel: c.channel, launched: day(c.launched), sends: Number(c.sends), members: Number(c.members), nonMembers: Number(c.non_members), joined: Number(c.joined), credited: Number(c.credited) })),
      reached,
      heavy,
      frequency: frequency.map((f) => ({ campaigns: Number(f.n), people: Number(f.people) })),
      most: most.map((m) => ({ partyId: Number(m.party_id), name: `${m.first_name} ${m.last_name}`, memberNumber: memberNumber(Number(m.party_id)), branch: m.branch, campaigns: Number(m.n), sends: Number(m.sends) })),
    };
  }
}
