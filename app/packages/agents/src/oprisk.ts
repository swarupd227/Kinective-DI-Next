// Operational and cyber risk (banks): incidents and regulator notification, critical vendors, controls by
// NIST CSF 2.0 function, security measures, resilience tests and cyber insurance against a ransomware
// event, as answers and as the Operational and cyber risk report's sections.
import type { Block, DiTake } from '@dinext/block-schemas';
import { z } from 'zod';
import { CoreError, NOTIFY_HOURS, type OpRiskService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

export const OPRISK_REQUEST = /\bcyber\w*\b|\bransomware\b|\boperational risk\b|\bop risk\b|\bresilien\w*\b|\bincidents?\b[^.?!]*\b(?:security|cyber|outage|notif)|\boutages?\b|\bvendors?\b[^.?!]*\b(?:risk|review|critical|soc)\b|\bthird[- ]party risk\b|\bcritical vendors?\b|\b(?:security|cyber) incidents?\b|\bsoc (?:1|2|report)\b|\bbusiness continuity\b|\bdisaster recovery\b|\b(?:rto|recovery time)\b|\bphishing\b|\bpatch\w*\b|\bmulti-?factor\b|\bmfa\b|\bnist\b|\bcsf\b|\bpenetration test\b|\bcyber insurance\b|\binformation security\b/i;
export type OpRiskQuestion = 'overview' | 'incidents' | 'vendors' | 'controls' | 'resilience' | 'insurance' | 'method';
export function opRiskQuestion(text: string): OpRiskQuestion {
  const t = text.toLowerCase();
  if (/how (?:is|are|do you) .*(?:calculat|measur|estimat)|assum|\bmethod/.test(t)) return 'method';
  if (/insur|policy|coverage|covered|retention/.test(t)) return 'insurance';
  if (/vendor|third[- ]party|soc /.test(t)) return 'vendors';
  if (/resilien|recover|failover|continuity|disaster|rto|backup|tabletop/.test(t)) return 'resilience';
  if (/control|nist|csf|mfa|multi-?factor|patch|phishing|privileged/.test(t)) return 'controls';
  if (/incident|outage|breach|attack|notif/.test(t)) return 'incidents';
  return 'overview';
}

const NO_ACCESS = 'Operational and cyber risk reporting isn’t part of your DI access. It is for the bank’s senior management.';
const AGENT = 'Operational and Cyber Risk';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const mm = (n: number) => `$${(n / 1e6).toFixed(2)}M`;
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const hrs = (n: number) => (n >= 24 ? `${(n / 24).toFixed(1)} days` : `${n.toFixed(1)} hours`);
type Analysis = NonNullable<Awaited<ReturnType<OpRiskService['analysis']>>>;
type Who = Pick<ModuleSpec, 'agent' | 'sources'>;
const SOURCES: ModuleSpec['sources'] = [{ kind: 'table', label: 'Information security register', ref: 'table:ops_incident' }];

function tables(who: Who, runId: string, a: Analysis) {
  const t = (title: string, op: string, cols: ReturnType<typeof text>[], rows: Record<string, string>[], subtitle?: string) => ({ ...moduleTable(who, title, runId, op, cols, rows, a.asOf), ...(subtitle ? { subtitle } : {}) }) as Block;
  const s = a.scenarios;
  return {
    attention: t('What needs attention', 'ops.attention', [text('read', 'DI’s read'), text('area', 'Area'), text('item', 'Requirement'), text('detail', 'Where it stands')], a.items.map((i) => ({ read: i.read, area: i.area, item: i.item, detail: i.detail }))),
    incidents: t('Incidents', 'ops.incidents', [text('opened', 'Opened'), text('category', 'Category'), text('severity', 'Severity'), text('summary', 'What happened'), text('down', 'Down'), text('customers', 'Customers affected'), text('loss', 'Cost'), text('notified', 'Regulator notified')], [...a.incidents].reverse().map((i) => ({ opened: i.opened, category: i.category, severity: String(i.severity), summary: i.summary, down: i.downtimeHours ? hrs(i.downtimeHours) : '—', customers: i.customers ? i.customers.toLocaleString('en-US') : '—', loss: i.loss ? usd(i.loss) : '—', notified: i.notification ? `${i.hoursToNotify!.toFixed(0)} hours${i.late ? ' (late)' : ''}` : 'Not required' })), `Severity 1 is the most serious. A notification incident must reach the regulator within ${NOTIFY_HOURS} hours.`),
    quarters: t('Incidents by quarter', 'ops.quarters', [text('quarter', 'Quarter'), text('incidents', 'Incidents'), text('serious', 'Severity 1 or 2'), text('down', 'Downtime'), text('customers', 'Customers affected'), text('loss', 'Cost')], a.byQuarter.map((q) => ({ quarter: q.quarter, incidents: String(q.incidents), serious: String(q.serious), down: q.downtimeHours ? hrs(q.downtimeHours) : '—', customers: q.customers.toLocaleString('en-US'), loss: usd(q.loss) }))),
    vendors: t('Critical and high vendors', 'ops.vendors', [text('vendor', 'Vendor'), text('service', 'Service'), text('criticality', 'Criticality'), text('next', 'Next review'), text('soc', 'SOC report'), text('exit', 'Exit plan'), text('note', 'Note')], a.vendors.map((v) => ({ vendor: v.vendor, service: v.service, criticality: v.criticality, next: `${v.nextReview}${v.overdue ? ' (overdue)' : ''}`, soc: v.soc ? `${v.soc}, ${v.opinion?.toLowerCase()}` : 'None', exit: v.exitPlan ? 'Yes' : 'No', note: v.note ?? '' }))),
    controls: t('Controls by NIST CSF 2.0 function', 'ops.controls', [text('fn', 'Function'), text('control', 'Control'), text('status', 'Status'), text('target', 'Target date'), text('note', 'Note')], a.controls.map((c) => ({ fn: c.fn, control: c.control, status: c.status, target: c.target ?? '—', note: c.note ?? '' }))),
    measures: t('Security measures', 'ops.measures', [text('measure', 'Measure'), text('now', 'Latest month'), text('yearAgo', 'Twelve months earlier'), text('target', 'Target'), text('met', 'Met')], a.measures.map((m) => ({ measure: m.label, now: `${m.now}%`, yearAgo: m.yearAgo === null ? '—' : `${m.yearAgo}%`, target: `${m.better === 'down' ? '≤' : '≥'} ${m.target}%`, met: m.met ? 'Yes' : 'No' }))),
    tests: t('Resilience tests', 'ops.tests', [text('test', 'Test'), text('kind', 'Kind'), text('on', 'Tested'), text('result', 'Result'), text('rto', 'Recovery: target and actual'), text('findings', 'Findings open')], a.tests.map((x) => ({ test: x.test, kind: x.kind, on: x.testedOn, result: x.result, rto: x.rtoTarget === null ? '—' : `${x.rtoTarget} h target, ${x.rtoActual} h actual${x.metRto === false ? ' (missed)' : ''}`, findings: String(x.findings) }))),
    insurance: t('Cyber insurance against a ransomware event', 'ops.insurance', [text('item', ''), ...s.map((x, i) => text(`s${i}`, `${x.daysDown} day${x.daysDown === 1 ? '' : 's'} down${x.dataStolen ? ', data stolen' : ''}`))], [
      ...s[s.length - 1]!.lines.map((l) => ({ item: l.item.replace(/ \(\d+ days?\)/, ''), ...Object.fromEntries(s.map((x, i) => [`s${i}`, mm(x.lines.find((y) => y.item.split(' (')[0] === l.item.split(' (')[0])?.cost ?? 0)])) })),
      { item: 'Total cost', ...Object.fromEntries(s.map((x, i) => [`s${i}`, mm(x.total)])) },
      { item: 'The policy pays', ...Object.fromEntries(s.map((x, i) => [`s${i}`, mm(x.covered)])) },
      { item: 'Left to the bank', ...Object.fromEntries(s.map((x, i) => [`s${i}`, mm(x.retained)])) },
    ], 'Estimated costs for a bank this size; no ransom is assumed paid. The policy pays above its retention, within the ransomware sublimit plus business interruption.'),
    policies: t('Insurance in force', 'ops.policies', [text('coverage', 'Coverage'), text('carrier', 'Carrier'), text('limit', 'Limit'), text('retention', 'Retention'), text('premium', 'Premium'), text('renewal', 'Renews'), text('note', 'Note')], a.insurance.map((p) => ({ coverage: p.coverage, carrier: p.carrier, limit: mm(p.limit), retention: usd(p.retention), premium: p.premium ? usd(p.premium) : 'Included', renewal: p.renewal, note: p.note ?? '' }))),
  };
}

function headline(a: Analysis) {
  const concerns = a.items.filter((i) => i.read === 'Concern');
  const watch = a.items.filter((i) => i.read === 'Watch');
  const serious = a.incidents.filter((i) => i.severity === 1);
  const down = a.incidents.reduce((t, i) => t + i.downtimeHours, 0);
  const worst = a.scenarios.at(-1)!;
  return [
    `**${a.incidents.length} incidents** since ${a.incidents[0]!.opened.slice(0, 7)}, ${serious.length} of them severity 1: ${serious.map((i) => `${i.category.toLowerCase()} (${i.opened.slice(0, 7)})`).join(' and ')}, ${hrs(down)} of downtime in all.`,
    concerns.length ? `For the board: ${concerns.map((c) => c.brief).join('; ')}.` : 'Nothing is a concern.',
    watch.length ? `To watch: ${watch.map((w) => w.brief).join('; ')}.` : '',
    a.items.some((i) => i.area === 'Insurance' && i.read !== 'Met') ? '' : `A ${worst.daysDown}-day ransomware outage with customer data stolen would cost about **${mm(worst.total)}**; the cyber policy would pay ${mm(worst.covered)}.`,
  ].filter(Boolean).join(' ');
}

export const OPRISK_SECTIONS = ['ops.attention', 'ops.incidents', 'ops.quarters', 'ops.vendors', 'ops.controls', 'ops.measures', 'ops.tests', 'ops.insurance', 'ops.policies', 'ops.assumptions'] as const;

export function opRiskAnalyses(svc: OpRiskService): ReportAnalyses {
  const runs = new Map<string, ReturnType<OpRiskService['analysis']>>();
  const once = (runId: string) => {
    if (!runs.has(runId)) {
      runs.set(runId, svc.analysis());
      if (runs.size > 8) runs.delete(runs.keys().next().value!);
    }
    return runs.get(runId)!;
  };
  const who = { agent: AGENT, sources: SOURCES };
  return {
    keys: [...OPRISK_SECTIONS],
    async run(key, runId): Promise<{ block: Block; take?: DiTake }> {
      const a = await once(runId);
      if (!a) throw new CoreError('NOT_FOUND', 'No information security register is loaded for this institution.');
      const b = tables(who, runId, a);
      const concerns = a.items.filter((i) => i.read === 'Concern');
      switch (key) {
        case 'ops.attention':
          return { block: b.attention, take: { headline: `${concerns.length ? `${concerns.length} item${concerns.length === 1 ? '' : 's'} for the board: ${concerns.map((c) => c.brief).join('; ')}.` : 'Nothing for the board.'}`.slice(0, 300), action: { label: 'Are we insured enough?', ask: 'Would our cyber insurance cover a ransomware attack?' } } };
        case 'ops.incidents':
          return { block: b.incidents };
        case 'ops.quarters':
          return { block: b.quarters };
        case 'ops.vendors':
          return { block: b.vendors };
        case 'ops.controls':
          return { block: b.controls };
        case 'ops.measures':
          return { block: b.measures };
        case 'ops.tests':
          return { block: b.tests };
        case 'ops.insurance':
          return { block: b.insurance };
        case 'ops.policies':
          return { block: b.policies };
        default:
          return { block: moduleTable(who, 'How DI measures operational and cyber risk', runId, 'ops.assumptions', [text('item', 'Assumption'), text('detail', 'What DI uses')], svc.assumptions().map(([item, detail]) => ({ item, detail })), a.asOf) };
      }
    },
  };
}

export function opRiskModule(svc: OpRiskService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('oprisk')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: 'oprisk',
    prefix: 'ops',
    agent: AGENT,
    request: OPRISK_REQUEST,
    noAccess: NO_ACCESS,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You are the Operational and Cyber Risk agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) answers to the board on operational and cyber risk: incidents and whether the regulator heard within ${NOTIFY_HOURS} hours, critical vendors, controls by NIST CSF 2.0 function, security measures, resilience tests against recovery targets, and whether cyber insurance would cover a ransomware event that stopped the bank.

- ops_view, with question overview, incidents, vendors, controls, resilience, insurance or method.`,
    plan: (t) => ({ tool: 'ops_view', args: { question: opRiskQuestion(t) } }),
    tools: [
      {
        name: 'ops_view',
        description: 'Operational and cyber risk: incidents and regulator notification, critical vendors and SOC reports, controls by NIST CSF function, security measures against targets, resilience tests, and cyber insurance against ransomware scenarios.',
        input: z.object({ question: z.enum(['overview', 'incidents', 'vendors', 'controls', 'resilience', 'insurance', 'method']).optional() }).strict(),
        run: async (a0: { question?: OpRiskQuestion }, ctx) => {
          need(ctx);
          if (a0.question === 'method') return { text: `How DI measures operational and cyber risk:\n\n${svc.assumptions().map(([k, v]) => `- **${k}:** ${v}`).join('\n')}` };
          const a = await svc.analysis();
          if (!a) throw new CoreError('INVALID', 'No information security register is loaded for this institution.');
          const b = tables(spec, ctx.runId, a);
          const q = a0.question ?? 'overview';
          const item = (k: string) => a.items.find((i) => i.item.startsWith(k));
          const [s1, s5, s10] = a.scenarios as [Analysis['scenarios'][number], Analysis['scenarios'][number], Analysis['scenarios'][number]];
          const cyber = a.insurance.find((p) => /^Cyber liability/.test(p.coverage));
          const ransom = a.insurance.find((p) => /^Ransomware/.test(p.coverage));
          const failed = a.tests.filter((t) => t.metRto === false);
          const answers: Record<Exclude<OpRiskQuestion, 'method'>, [string, Block[]]> = {
            overview: [headline(a), [b.attention, b.insurance, b.incidents]],
            incidents: [`${a.byQuarter.map((x) => `${x.incidents} in ${x.quarter}`).join(', ')}. The serious ones: ${a.incidents.filter((i) => i.severity === 1).map((i) => `**${i.category.toLowerCase()}** on ${i.opened} (${i.summary.toLowerCase()})`).join('; ')}. ${item('Regulator notified')!.detail}`, [b.incidents, b.quarters]],
            vendors: [`${a.vendors.filter((v) => v.criticality === 'Critical').length} critical vendors. ${item('Critical vendors')!.detail} ${a.vendors.filter((v) => !v.exitPlan && v.criticality !== 'Moderate').length} critical or high vendors have no exit plan; core processing alone stopped the bank for 7 hours in April.`, [b.vendors]],
            controls: [`By NIST CSF 2.0 function: ${a.functions.map((f) => `${f.fn} ${f.met} met${f.partial ? `, ${f.partial} partial` : ''}`).join('; ')}. Below target this month: ${a.measures.filter((m) => !m.met).map((m) => `${m.label.toLowerCase()} ${m.now}% (target ${m.target}%)`).join(', ')}. The phishing click rate fell from ${a.measures.find((m) => m.metric === 'phishing_click_pct')!.yearAgo}% to ${a.measures.find((m) => m.metric === 'phishing_click_pct')!.now}% over the year.`, [b.controls, b.measures]],
            resilience: [`${failed.length ? `${failed.map((t) => `**${t.test}** took ${t.rtoActual} hours against a ${t.rtoTarget}-hour target`).join('; ')}, retest due.` : 'Every recovery test met its target.'} Backups held when it mattered: the August ransomware was contained and the servers restored from immutable backups in about 5 hours. ${a.tests.filter((t) => t.findings).map((t) => `${t.test}: ${t.findings} finding${t.findings === 1 ? '' : 's'} open`).join('; ')}.`, [b.tests]],
            insurance: [`${cyber ? `The cyber policy (${cyber.carrier}) has a **${mm(cyber.limit)}** aggregate limit with a ${usd(cyber.retention)} retention, ` : ''}${ransom ? `a ${mm(ransom.limit)} ransomware sublimit, ` : ''}and business interruption after 12 hours. A one-day outage with no data taken would cost about ${mm(s1.total)}, covered above the retention. A ${s5.daysDown}-day core outage with customer data stolen would cost about **${mm(s5.total)}**, ${mm(s5.retained)} of it the bank’s. At ${s10.daysDown} days it would be about **${mm(s10.total)}**, leaving **${mm(s10.retained)}** uninsured, because the ransomware sublimit caps what the policy pays. Worth raising the sublimit at the March renewal.`, [b.insurance, b.policies]],
          };
          const [reply, blocks] = answers[q];
          return { text: reply, blocks, sources: SOURCES, suggestions: ['Would our cyber insurance cover a ransomware attack?', 'Which critical vendors need attention?', 'How resilient are we if the core goes down?', 'How are our cyber controls?'].filter((s) => opRiskQuestion(s) !== q).slice(0, 3) };
        },
      },
    ],
  };
  return spec;
}
