// Operational and cyber risk for a bank's board: incidents and whether regulators heard within 36 hours
// (the computer-security incident notification rule), critical vendors, controls by NIST Cybersecurity
// Framework 2.0 function, the monthly security measures, resilience tests against recovery-time targets,
// and whether the cyber insurance would cover a ransomware event that stopped the bank.
import type { Pool } from '@dinext/tenant-db';

const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];
const day = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const stamp = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d).replace(' ', 'T') + (String(d).includes('Z') ? '' : 'Z'));
const quarterOf = (d: string) => `Q${Math.ceil(Number(d.slice(5, 7)) / 3)} ${d.slice(0, 4)}`;

/** Hours a bank has to notify its primary federal regulator of a notification incident (12 CFR 53, 225, 304). */
export const NOTIFY_HOURS = 36;
/** The board's targets for the monthly measures; lower is better for phishing clicks. */
export const OPRISK_TARGETS: Record<string, { label: string; target: number; better: 'up' | 'down' }> = {
  phishing_click_pct: { label: 'Phishing test click rate', target: 5, better: 'down' },
  critical_patch_30d_pct: { label: 'Critical patches applied within 30 days', target: 95, better: 'up' },
  mfa_coverage_pct: { label: 'Accounts with multifactor authentication', target: 100, better: 'up' },
  edr_coverage_pct: { label: 'Devices with endpoint detection', target: 100, better: 'up' },
  training_complete_pct: { label: 'Security training completed this year', target: 100, better: 'up' },
};
export type OpRead = 'Concern' | 'Watch' | 'Met';

export class OpRiskService {
  constructor(private readonly pool: Pool) {}

  async analysis() {
    const incidents = await rows<{ incident_id: number; opened: unknown; category: string; severity: number; summary: string; downtime_minutes: number; customers_affected: number; loss: number; notification_incident: number; determined_at: unknown; notified_at: unknown; status: string }>(this.pool, 'SELECT * FROM ops_incident ORDER BY opened').catch(() => null);
    if (incidents === null || !incidents.length) return null;
    const [b] = await rows<{ d: unknown }>(this.pool, 'SELECT MAX(as_of_date) AS d FROM meta_build');
    const asOf = day(b?.d ?? '2026-10-25');
    const vendors = await rows<{ vendor: string; service: string; criticality: string; last_review: unknown; next_review: unknown; soc_report_date: unknown; soc_opinion: string | null; exit_plan: number; note: string | null }>(this.pool, 'SELECT * FROM ops_vendor');
    const controls = await rows<{ control: string; csf_function: string; status: string; target_date: unknown; note: string | null }>(this.pool, 'SELECT * FROM ops_control');
    const metrics = await rows<{ month: unknown; metric: string; value: number }>(this.pool, 'SELECT * FROM ops_metric ORDER BY month');
    const tests = await rows<{ test: string; kind: string; tested_on: unknown; result: string; rto_target_hours: number | null; rto_actual_hours: number | null; findings_open: number; note: string | null }>(this.pool, 'SELECT * FROM ops_test ORDER BY tested_on DESC');
    const insurance = await rows<{ coverage: string; carrier: string; limit_amount: number; retention: number; premium: number; renewal: unknown; note: string | null }>(this.pool, 'SELECT * FROM ops_insurance');
    const fee = await rows<{ amount: number; q: unknown }>(this.pool, "SELECT amount, quarter_end AS q FROM cr_value WHERE code = 'RIAD4079' ORDER BY quarter_end DESC LIMIT 1").catch(() => []);
    const [cust] = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM cdm_party WHERE is_member = 1');

    const list = incidents.map((i) => {
      const determined = i.determined_at ? stamp(i.determined_at) : null;
      const notified = i.notified_at ? stamp(i.notified_at) : null;
      const hours = determined && notified ? (Date.parse(notified) - Date.parse(determined)) / 3_600_000 : null;
      return { id: i.incident_id, opened: day(i.opened), quarter: quarterOf(day(i.opened)), category: i.category, severity: Number(i.severity), summary: i.summary, downtimeHours: Number(i.downtime_minutes) / 60, customers: Number(i.customers_affected), loss: Number(i.loss), notification: Number(i.notification_incident) === 1, hoursToNotify: hours, late: hours !== null && hours > NOTIFY_HOURS, status: i.status };
    });
    const quarters = [...new Set(list.map((i) => i.quarter))];
    const byQuarter = quarters.map((q) => {
      const xs = list.filter((i) => i.quarter === q);
      return { quarter: q, incidents: xs.length, serious: xs.filter((i) => i.severity <= 2).length, downtimeHours: xs.reduce((t, i) => t + i.downtimeHours, 0), customers: xs.reduce((t, i) => t + i.customers, 0), loss: xs.reduce((t, i) => t + i.loss, 0) };
    });

    const vend = vendors.map((v) => ({ vendor: v.vendor, service: v.service, criticality: v.criticality, lastReview: day(v.last_review), nextReview: day(v.next_review), overdue: day(v.next_review) < asOf, soc: v.soc_report_date ? day(v.soc_report_date) : null, opinion: v.soc_opinion, exitPlan: Number(v.exit_plan) === 1, note: v.note }));
    const fnOrder = ['Govern', 'Identify', 'Protect', 'Detect', 'Respond', 'Recover'];
    const ctl = controls.map((c) => ({ control: c.control, fn: c.csf_function, status: c.status, target: c.target_date ? day(c.target_date) : null, note: c.note })).sort((x, y) => fnOrder.indexOf(x.fn) - fnOrder.indexOf(y.fn));
    const functions = fnOrder.map((f) => ({ fn: f, met: ctl.filter((c) => c.fn === f && c.status === 'Met').length, partial: ctl.filter((c) => c.fn === f && c.status === 'Partial').length, notMet: ctl.filter((c) => c.fn === f && c.status === 'Not met').length }));

    const months = [...new Set(metrics.map((m) => day(m.month)))];
    const measures = Object.entries(OPRISK_TARGETS).map(([k, t]) => {
      const series = months.map((m) => Number(metrics.find((x) => day(x.month) === m && x.metric === k)?.value ?? NaN));
      const now = series.at(-1)!;
      const ok = t.better === 'down' ? now <= t.target : now >= t.target;
      return { metric: k, ...t, now, yearAgo: series[0] ?? null, met: ok, series };
    });

    const testRows = tests.map((t) => ({ test: t.test, kind: t.kind, testedOn: day(t.tested_on), result: t.result, rtoTarget: t.rto_target_hours === null ? null : Number(t.rto_target_hours), rtoActual: t.rto_actual_hours === null ? null : Number(t.rto_actual_hours), metRto: t.rto_target_hours === null || t.rto_actual_hours === null ? null : Number(t.rto_actual_hours) <= Number(t.rto_target_hours), findings: Number(t.findings_open), note: t.note }));

    // Insurance against a ransomware event that stops the bank: what it would cost and what the policy pays.
    const pol = insurance.map((i) => ({ coverage: i.coverage, carrier: i.carrier, limit: Number(i.limit_amount), retention: Number(i.retention), premium: Number(i.premium), renewal: day(i.renewal), note: i.note }));
    const cyber = pol.find((p) => /^Cyber liability/.test(p.coverage));
    const ransom = pol.find((p) => /^Ransomware/.test(p.coverage));
    const bi = pol.find((p) => /^Business interruption/.test(p.coverage));
    const usedThisYear = list.filter((i) => i.opened >= (cyber ? `${Number(cyber.renewal.slice(0, 4)) - 1}${cyber.renewal.slice(4)}` : '0000')).reduce((t, i) => t + Math.max(0, i.loss - (cyber?.retention ?? 0)), 0);
    const customers = Number(cust?.n ?? 0);
    const feeYear = fee[0] ? (Number(fee[0].amount) * 12) / Number(day(fee[0].q).slice(5, 7)) : 0;
    const scenario = (daysDown: number, dataStolen: boolean) => {
      const lines = [
        { item: 'Forensics and incident response', cost: 450_000 + daysDown * 55_000 },
        { item: 'Outside counsel and regulator response', cost: 250_000 + daysDown * 30_000 },
        { item: 'Restoring systems and extra expense (overtime, temporary systems)', cost: 200_000 + daysDown * 130_000 },
        { item: `Fee income lost while down (${daysDown} days)`, cost: (feeYear * daysDown) / 365 },
        { item: 'Customer reimbursements, waived fees and fraud while down', cost: daysDown * 60_000 },
        ...(dataStolen ? [{ item: `Notifying ${customers.toLocaleString('en-US')} customers and credit monitoring`, cost: customers * 12 }] : []),
      ];
      const total = lines.reduce((t, l) => t + l.cost, 0);
      // The ransomware sublimit and business interruption are inside the cyber policy's aggregate, after one retention.
      const remaining = (cyber?.limit ?? 0) - usedThisYear;
      const bip = Math.min(bi?.limit ?? 0, lines.filter((l) => /Fee income/.test(l.item)).reduce((t, l) => t + l.cost, 0) * (daysDown * 24 > 12 ? 1 : 0));
      const covered = Math.max(0, Math.min(remaining, (ransom?.limit ?? 0) + bip, total - (cyber?.retention ?? 0)));
      return { daysDown, dataStolen, lines, total, covered, retained: total - covered };
    };
    const scenarios = [scenario(1, false), scenario(5, true), scenario(10, true)];

    // What needs the board's attention.
    const items: { area: string; item: string; read: OpRead; detail: string; brief: string }[] = [];
    const add = (area: string, item: string, read: OpRead, detail: string, brief: string) => items.push({ area, item, read, detail, brief });
    const late = list.filter((i) => i.late);
    const notified = list.filter((i) => i.notification);
    add('Incidents', 'Regulator notified within 36 hours', late.length ? 'Concern' : 'Met', notified.map((i) => `${i.opened} (${i.category.toLowerCase()}): ${i.hoursToNotify!.toFixed(0)} hours`).join('; ') + (late.length ? '. The rule allows 36 hours from determining a notification incident occurred.' : '.'), late.length ? `the ${late.map((i) => i.category.toLowerCase()).join(' and ')} in ${late.map((i) => i.opened.slice(0, 7)).join(', ')} reached the regulator after ${late.map((i) => i.hoursToNotify!.toFixed(0)).join(', ')} hours, past the 36 allowed` : 'regulators notified on time');
    const overdueV = vend.filter((v) => v.criticality === 'Critical' && v.overdue);
    const noSoc = vend.filter((v) => v.criticality !== 'Moderate' && !v.soc);
    add('Vendors', 'Critical vendors reviewed on schedule, with a SOC report', overdueV.length || noSoc.length ? 'Concern' : 'Met', [...overdueV.map((v) => `${v.vendor}: review due ${v.nextReview}`), ...noSoc.map((v) => `${v.vendor}: no SOC report${v.note ? ` (${v.note.charAt(0).toLowerCase()}${v.note.slice(1).replace(/\.$/, '')})` : ''}`)].join('; ') + '.', `${[...overdueV.map((v) => `${v.vendor.split(' (')[0]}’s review is overdue`), ...noSoc.map((v) => `${v.vendor.split(' (')[0]}, whose remote access let the August ransomware in, has no SOC report`)].join('; ')}`);
    const failedRto = testRows.filter((t) => t.metRto === false);
    add('Resilience', 'Critical systems recover within their targets', failedRto.length ? 'Watch' : 'Met', failedRto.map((t) => `${t.test}: ${t.rtoActual} hours against ${t.rtoTarget}`).join('; ') || 'Every recovery test met its target.', failedRto.map((t) => `core failover took ${t.rtoActual} hours against ${t.rtoTarget}`).join('; ') || 'recovery on target');
    for (const m of measures.filter((x) => !x.met && x.metric !== 'training_complete_pct')) add('Security measures', m.label, 'Watch', `${m.now}% against a ${m.target}% target.`, `${m.label.toLowerCase()} ${m.now}% against ${m.target}%`);
    const findings = testRows.reduce((t, x) => t + x.findings, 0);
    if (findings) add('Testing', 'Test findings closed', 'Watch', testRows.filter((t) => t.findings).map((t) => `${t.test}: ${t.findings} open`).join('; ') + '.', `${findings} test findings open`);
    const severe = scenarios[2]!;
    add('Insurance', 'Cyber insurance covers a severe ransomware event', severe.retained > 1_000_000 ? 'Concern' : severe.retained > 500_000 ? 'Watch' : 'Met', `A ${severe.daysDown}-day core outage with customer data stolen would cost about $${(severe.total / 1e6).toFixed(1)}M; the policy would pay about $${(severe.covered / 1e6).toFixed(1)}M, leaving $${(severe.retained / 1e6).toFixed(1)}M to the bank.`, `a ${severe.daysDown}-day ransomware outage would leave about $${(severe.retained / 1e6).toFixed(1)}M uninsured`);
    for (const c of ctl.filter((x) => x.status !== 'Met' && /Privileged/.test(x.control))) add('Controls', c.control, 'Watch', c.note ?? '', `${c.control.toLowerCase()}: ${c.note?.replace(/\.$/, '').toLowerCase() ?? 'partial'}`);
    const order = { Concern: 0, Watch: 1, Met: 2 } as const;
    items.sort((x, y) => order[x.read] - order[y.read]);

    return { asOf, incidents: list, byQuarter, vendors: vend, controls: ctl, functions, measures, months, tests: testRows, insurance: pol, usedThisYear, scenarios, items };
  }

  assumptions(): [string, string][] {
    return [
      ['Sources', 'The information security officer’s register: incidents, vendors, controls, monthly measures, resilience tests and the insurance schedule.'],
      ['Notification rule', `A computer-security incident that has materially disrupted, or is reasonably likely to disrupt, the bank’s operations must reach its primary federal regulator as soon as possible and within ${NOTIFY_HOURS} hours of determining it occurred.`],
      ['Controls', 'Grouped by the NIST Cybersecurity Framework 2.0 functions (Govern, Identify, Protect, Detect, Respond, Recover). The FFIEC Cybersecurity Assessment Tool was retired in August 2025; banks now map to frameworks like NIST CSF 2.0 or the CRI Profile.'],
      ['Ransomware scenarios', 'Costs a community bank would face: forensics and response, counsel, restoration and extra expense, fee income lost while down, customer reimbursements, and notification with credit monitoring if data is stolen. A ransom isn’t assumed paid; paying a sanctioned group is prohibited. The policy pays above one retention, within the ransomware sublimit plus business interruption after a 12-hour wait, and within what’s left of the annual aggregate.'],
      ['Targets', Object.values(OPRISK_TARGETS).map((t) => `${t.label} ${t.better === 'down' ? 'at most' : 'at least'} ${t.target}%`).join('; ') + '.'],
    ];
  }
}
