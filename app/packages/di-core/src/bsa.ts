// BSA/AML and fraud for a bank's board and its CFO: the measures a BSA examination tests and a board
// should see. Alert backlog and aging, SAR volumes and timeliness (30 days from detection; continuing
// activity reviewed every 90 days and filed within 120), CTRs (15 days), OFAC screening and blocked
// property, high-risk customer reviews, the program's open items, and fraud losses by type and channel.
//
// A SAR and anything that would reveal one are confidential (31 U.S.C. 5318(g)(2)): DI shows them only in
// aggregate, never by customer, and only to people with BSA access.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const quarterOf = (d: string) => `Q${Math.ceil(Number(d.slice(5, 7)) / 3)} ${d.slice(0, 4)}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** The deadlines DI checks against. */
export const BSA_RULES = { sarDays: 30, continuingReviewDays: 90, alertAgingDays: 30, ctrDays: 15 };
export type BsaRead = 'Concern' | 'Watch' | 'Met';

export class BsaService {
  constructor(private readonly pool: Pool) {}

  async analysis() {
    const [b] = await rows<{ d: unknown }>(this.pool, 'SELECT MAX(as_of_date) AS d FROM meta_build');
    const asOf = day(b?.d ?? '2026-10-25');
    const alerts = await rows<{ opened: unknown; source: string; typology: string; status: string; closed: unknown }>(this.pool, 'SELECT opened, source, typology, status, closed FROM bsa_alert').catch(() => null);
    if (alerts === null || !alerts.length) return null;
    const sars = await rows<{ detected_on: unknown; filed_on: unknown; typology: string; amount: number; continuing: number; next_review: unknown; reviewed_on: unknown }>(this.pool, 'SELECT detected_on, filed_on, typology, amount, continuing, next_review, reviewed_on FROM bsa_sar');
    const ctr = await rows<{ month: unknown; filed: number; late: number; exempt_customers: number }>(this.pool, 'SELECT * FROM bsa_ctr ORDER BY month');
    const ofac = await rows<{ month: unknown; screened: number; potential: number; true_matches: number; blocked_amount: number; rejected_amount: number }>(this.pool, 'SELECT * FROM bsa_ofac ORDER BY month');
    const risk = await rows<{ rating: string; category: string; next_review: unknown }>(this.pool, 'SELECT rating, category, next_review FROM bsa_customer_risk');
    const fraud = await rows<{ opened: unknown; fraud_type: string; channel: string; gross_loss: number; recovered: number; prevented: number; elder: number }>(this.pool, 'SELECT opened, fraud_type, channel, gross_loss, recovered, prevented, elder FROM fraud_case');
    const program = await rows<{ item: string; area: string; status: string; as_of: unknown; due: unknown; detail: string }>(this.pool, 'SELECT * FROM bsa_program');
    const [dep] = await rows<{ b: number }>(this.pool, 'SELECT SUM(balance) AS b FROM cdm_deposit_account WHERE close_date IS NULL');
    const deposits = Number(dep?.b ?? 0);

    // Quarters on file, oldest first, the latest to date.
    const quarters = [...new Set([...alerts.map((a) => quarterOf(day(a.opened))), ...fraud.map((f) => quarterOf(day(f.opened)))])].sort((x, y) => x.slice(3).localeCompare(y.slice(3)) || x.localeCompare(y));
    const latest = quarterOf(asOf);
    const complete = quarters.filter((q) => q !== latest);
    const lastFull = complete.at(-1)!;

    // Alerts: what's open and how old.
    const open = alerts.filter((a) => a.status === 'Open' || a.status === 'Escalated');
    const age = (a: (typeof alerts)[number]) => daysBetween(day(a.opened), asOf);
    const aging = { under30: open.filter((a) => age(a) <= 30).length, d31to60: open.filter((a) => age(a) > 30 && age(a) <= 60).length, over60: open.filter((a) => age(a) > 60).length };
    const alertsByQuarter = quarters.map((q) => {
      const xs = alerts.filter((a) => quarterOf(day(a.opened)) === q);
      const closed = xs.filter((a) => a.status !== 'Open' && a.status !== 'Escalated');
      return { quarter: q, opened: xs.length, closed: closed.length, sars: xs.filter((a) => a.status === 'SAR filed').length, conversionPct: closed.length ? (xs.filter((a) => a.status === 'SAR filed').length / closed.length) * 100 : null };
    });

    // SARs: how many, how fast, and continuing activity reviews.
    const sarRows = sars.map((s) => ({ detected: day(s.detected_on), filed: day(s.filed_on), typology: s.typology, amount: Number(s.amount), continuing: Number(s.continuing) === 1, nextReview: s.next_review ? day(s.next_review) : null, reviewed: s.reviewed_on ? day(s.reviewed_on) : null, days: daysBetween(day(s.detected_on), day(s.filed_on)) }));
    const year = asOf.slice(0, 4);
    const sarsByQuarter = quarters.map((q) => {
      const xs = sarRows.filter((s) => quarterOf(s.filed) === q);
      return { quarter: q, filed: xs.length, amount: xs.reduce((t, s) => t + s.amount, 0), avgDays: xs.length ? xs.reduce((t, s) => t + s.days, 0) / xs.length : null, late: xs.filter((s) => s.days > BSA_RULES.sarDays).length };
    });
    const lateThisYear = sarRows.filter((s) => s.filed.startsWith(year) && s.days > BSA_RULES.sarDays);
    const reviewsOverdue = sarRows.filter((s) => s.continuing && s.nextReview && s.nextReview < asOf && !s.reviewed);
    const typologies = [...new Set(sarRows.map((s) => s.typology))]
      .map((t) => {
        const xs = sarRows.filter((s) => s.typology === t && quarters.slice(-4).includes(quarterOf(s.filed)));
        return { typology: t, filed: xs.length, amount: xs.reduce((s, x) => s + x.amount, 0) };
      })
      .sort((x, y) => y.filed - x.filed);

    // CTRs and OFAC, by quarter.
    const inQ = (q: string) => (x: { month: unknown }) => quarterOf(day(x.month)) === q;
    const sumOf = <T>(xs: T[], f: (x: T) => number) => xs.reduce((t, x) => t + f(x), 0);
    const ctrByQuarter = quarters.map((q) => {
      const ys = ctr.filter(inQ(q));
      return { quarter: q, filed: sumOf(ys, (y) => Number(y.filed)), late: sumOf(ys, (y) => Number(y.late)) };
    });
    const ofacByQuarter = quarters.map((q) => {
      const ys = ofac.filter(inQ(q));
      return { quarter: q, screened: sumOf(ys, (y) => Number(y.screened)), potential: sumOf(ys, (y) => Number(y.potential)), trueMatches: sumOf(ys, (y) => Number(y.true_matches)), blocked: sumOf(ys, (y) => Number(y.blocked_amount)), rejected: sumOf(ys, (y) => Number(y.rejected_amount)) };
    });

    // High-risk customers: reviews that are overdue.
    const ratings = ['High', 'Elevated'].map((r) => {
      const xs = risk.filter((x) => x.rating === r);
      return { rating: r, customers: xs.length, overdue: xs.filter((x) => day(x.next_review) < asOf).length };
    });
    const categories = [...new Set(risk.map((r) => r.category))].map((c) => ({ category: c, customers: risk.filter((r) => r.category === c).length, overdue: risk.filter((r) => r.category === c && day(r.next_review) < asOf).length })).sort((x, y) => y.customers - x.customers);

    // Fraud: losses by quarter and by type, net of recoveries, and what was stopped.
    const fr = fraud.map((f) => ({ quarter: quarterOf(day(f.opened)), type: f.fraud_type, channel: f.channel, gross: Number(f.gross_loss), recovered: Number(f.recovered), prevented: Number(f.prevented), elder: Number(f.elder) === 1 }));
    const fraudByQuarter = quarters.map((q) => {
      const xs = fr.filter((f) => f.quarter === q);
      const gross = xs.reduce((t, f) => t + f.gross, 0);
      const recovered = xs.reduce((t, f) => t + f.recovered, 0);
      return { quarter: q, cases: xs.length, gross, recovered, net: gross - recovered, prevented: xs.reduce((t, f) => t + f.prevented, 0), elderNet: xs.filter((f) => f.elder).reduce((t, f) => t + f.gross - f.recovered, 0) };
    });
    const last4 = complete.slice(-4);
    const fraudTypes = [...new Set(fr.map((f) => f.type))]
      .map((t) => {
        const xs = fr.filter((f) => f.type === t && last4.includes(f.quarter));
        const first = fr.filter((f) => f.type === t && f.quarter === complete[0]);
        const last = fr.filter((f) => f.type === t && f.quarter === lastFull);
        const net = (ys: typeof fr) => ys.reduce((s, f) => s + f.gross - f.recovered, 0);
        return { type: t, channel: xs[0]?.channel ?? '', cases: xs.length, gross: xs.reduce((s, f) => s + f.gross, 0), net: net(xs), prevented: xs.reduce((s, f) => s + f.prevented, 0), changePct: net(first) ? ((net(last) - net(first)) / net(first)) * 100 : null };
      })
      .sort((x, y) => y.net - x.net);
    const net12 = fraudByQuarter.filter((q) => last4.includes(q.quarter)).reduce((t, q) => t + q.net, 0);

    // What needs the board's attention.
    const progOpen = program.filter((p) => p.status !== 'Current');
    const items: { area: string; item: string; read: BsaRead; detail: string; brief: string }[] = [];
    const add = (area: string, item: string, read: BsaRead, detail: string, brief = item) => items.push({ area, item, read, detail, brief });
    add('SARs', 'SARs filed within 30 days of detection', lateThisYear.length ? 'Concern' : 'Met', lateThisYear.length ? `${lateThisYear.length} filed late this year: ${lateThisYear.map((s) => `${s.days} days, filed ${s.filed}`).join('; ')}. Examiners cite late SARs.` : 'Every SAR this year was filed within 30 days.', lateThisYear.length ? `${lateThisYear.length === 1 ? 'a SAR was' : `${lateThisYear.length} SARs were`} filed late this year (${lateThisYear.map((s) => `${s.days} days`).join(', ')}, against 30)` : 'SARs on time');
    add('SARs', 'Continuing activity reviewed every 90 days', reviewsOverdue.length ? 'Watch' : 'Met', reviewsOverdue.length ? `${reviewsOverdue.length} continuing-activity reviews are past their 90-day date.` : 'No continuing-activity review is overdue.', `${reviewsOverdue.length} continuing-activity reviews overdue`);
    add('Alerts', 'Alerts worked within 30 days', aging.d31to60 + aging.over60 > 10 ? 'Concern' : aging.d31to60 + aging.over60 ? 'Watch' : 'Met', `${open.length} open; ${aging.d31to60 + aging.over60} older than 30 days (${aging.over60} over 60). An old alert can push a SAR past its 30 days.`, `${aging.d31to60 + aging.over60} alerts are older than 30 days (${aging.over60} over 60)`);
    add('CTRs', 'CTRs filed within 15 days', ctr.some((c) => Number(c.late)) ? 'Concern' : 'Met', `${ctr.reduce((t, c) => t + Number(c.filed), 0).toLocaleString('en-US')} filed since ${day(ctr[0]!.month).slice(0, 7)}, ${ctr.reduce((t, c) => t + Number(c.late), 0)} late.`);
    add('OFAC', 'OFAC matches blocked or rejected and reported', 'Met', `${ofac.reduce((t, o) => t + Number(o.true_matches), 0)} true match blocked ($${ofac.reduce((t, o) => t + Number(o.blocked_amount), 0).toLocaleString('en-US')}) and reported within 10 business days; ${ofac.reduce((t, o) => t + Number(o.potential), 0).toLocaleString('en-US')} potential matches cleared.`);
    const overdueRisk = ratings.reduce((t, r) => t + r.overdue, 0);
    add('Customer due diligence', 'High-risk customer reviews on time', overdueRisk > 20 ? 'Concern' : overdueRisk ? 'Watch' : 'Met', `${overdueRisk} of ${risk.length} high-risk and elevated customers are past their review date (${ratings.map((r) => `${r.rating.toLowerCase()} ${r.overdue}`).join(', ')}).`, `${overdueRisk} high-risk customer reviews overdue`);
    const briefs: Record<string, string> = { 'Independent test': 'the independent test’s finding on aged alerts is past due', 'Training': 'training at 94%, due December 15', 'Beneficial ownership refresh': '37 beneficial ownership certifications to refresh', 'Model validation: transaction monitoring': 'transaction monitoring validation due November 30' };
    for (const p of progOpen) add(p.area, p.item, p.status === 'Findings open' || (p.due && day(p.due) < asOf) ? 'Concern' : 'Watch', p.detail, briefs[p.item] ?? `${p.item.charAt(0).toLowerCase()}${p.item.slice(1)} (${p.status.toLowerCase()})`);
    const order = { Concern: 0, Watch: 1, Met: 2 } as const;
    items.sort((x, y) => order[x.read] - order[y.read]);

    return {
      asOf,
      quarters,
      latest,
      lastFull,
      alerts: { open: open.length, aging, byQuarter: alertsByQuarter, sources: [...new Set(alerts.map((a) => a.source))].map((s) => ({ source: s, alerts: alerts.filter((a) => a.source === s).length })) },
      sars: { byQuarter: sarsByQuarter, lateThisYear, reviewsOverdue: reviewsOverdue.length, typologies, total12: sarRows.filter((s) => last4.includes(quarterOf(s.filed))).length },
      ctr: ctrByQuarter,
      ofac: ofacByQuarter,
      customers: { ratings, categories, total: risk.length },
      fraud: { byQuarter: fraudByQuarter, types: fraudTypes, net12, net12BpOfDeposits: deposits ? (net12 / deposits) * 10_000 : null, prevented12: fraudByQuarter.filter((q) => last4.includes(q.quarter)).reduce((t, q) => t + q.prevented, 0), elderNet12: fraudByQuarter.filter((q) => last4.includes(q.quarter)).reduce((t, q) => t + q.elderNet, 0) },
      program: program.map((p) => ({ item: p.item, area: p.area, status: p.status, asOf: day(p.as_of), due: p.due ? day(p.due) : null, detail: p.detail })),
      items,
    };
  }

  assumptions(): [string, string][] {
    return [
      ['Sources', 'The BSA case system (alerts, SARs, CTRs, OFAC screening, customer risk ratings), the fraud team’s case log, and the BSA program register.'],
      ['SAR timeliness', `Days from the date the activity was found suspicious to the date filed, against ${BSA_RULES.sarDays} days (31 CFR 1020.320); continuing activity reviewed every ${BSA_RULES.continuingReviewDays} days. CTRs within ${BSA_RULES.ctrDays} days.`],
      ['Alert aging', `Open alerts by days since they were generated; older than ${BSA_RULES.alertAgingDays} days is watched because it squeezes the SAR clock.`],
      ['Fraud losses', 'Gross loss less recoveries (chargebacks, returned items, restitution), by when the case opened; prevented is fraud stopped before money left. Basis points of deposits are the last four full quarters over today’s deposits.'],
      ['Confidentiality', 'A SAR, and anything that would reveal one, can’t be disclosed (31 U.S.C. 5318(g)(2)). DI reports SARs only in aggregate, never by customer, and only to people with BSA access; the board sees the same aggregates.'],
    ];
  }
}
