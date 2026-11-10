// BSA/AML and fraud (banks): what a BSA examination tests and the board should see, as answers and as the
// BSA/AML and fraud report's sections. SARs appear only in aggregate: their confidentiality is the law.
import type { Block, DiTake } from '@dinext/block-schemas';
import { z } from 'zod';
import { CoreError, type BsaService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

export const BSA_REQUEST = /\bbsa\b|\baml\b|anti-?money laundering|money laundering|\bsars?\b|suspicious activity|\bctrs?\b|currency transaction|\bofac\b|sanctions? (?:screening|hits?|matches)|\bfraud\b|\bscams?\b|elder (?:financial )?(?:abuse|exploitation)|check kiting|high-risk customers?|\b314\(a\)|beneficial ownership|transaction monitoring|\bfincen\b|\balert backlog\b|\bbsa alerts?\b/i;
export type BsaQuestion = 'overview' | 'sars' | 'alerts' | 'ofac' | 'ctr' | 'customers' | 'fraud' | 'program' | 'method';
export function bsaQuestion(text: string): BsaQuestion {
  const t = text.toLowerCase();
  if (/how (?:is|are|do you) .*(?:calculat|measur|count)|assum|\bmethod/.test(t)) return 'method';
  const fraud = /fraud|scam|elder|kiting|loss(?:es)?\b/.test(t);
  const aml = /\bbsa\b|\baml\b|money laundering|\bsars?\b|suspicious|\bofac\b|\bctrs?\b/.test(t);
  if (fraud && aml) return 'overview';
  if (fraud) return 'fraud';
  if (/\bofac\b|sanction/.test(t)) return 'ofac';
  if (/\bctrs?\b|currency transaction/.test(t)) return 'ctr';
  if (/high-risk|due diligence|beneficial|\bcdd\b|\bedd\b/.test(t)) return 'customers';
  if (/alert|backlog|monitoring/.test(t)) return 'alerts';
  if (/\bsars?\b|suspicious/.test(t)) return 'sars';
  if (/independent test|training|risk assessment|program|exam/.test(t)) return 'program';
  return 'overview';
}

const NO_ACCESS = 'BSA/AML and fraud reporting isn’t part of your DI access. It is for the BSA officer and the bank’s senior management.';
const AGENT = 'BSA/AML and Fraud';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const mm = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000).toLocaleString('en-US')}K`);
const count = (n: number) => n.toLocaleString('en-US');
/** Lowercases a leading word, leaving acronyms (SARs, ACH, OFAC) alone. */
const lower = (s: string) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
type Analysis = NonNullable<Awaited<ReturnType<BsaService['analysis']>>>;
type Who = Pick<ModuleSpec, 'agent' | 'sources'>;
const SOURCES: ModuleSpec['sources'] = [
  { kind: 'table', label: 'BSA case system: alerts, SARs, CTRs, OFAC', ref: 'table:bsa_alert' },
  { kind: 'table', label: 'Fraud case log', ref: 'table:fraud_case' },
];
const CONFIDENTIAL = 'SARs are shown only in aggregate: a SAR, or anything that would reveal one, can’t be disclosed (31 U.S.C. 5318(g)(2)).';

function tables(who: Who, runId: string, a: Analysis) {
  const t = (title: string, op: string, cols: ReturnType<typeof text>[], rows: Record<string, string>[], subtitle?: string) => ({ ...moduleTable(who, title, runId, op, cols, rows, a.asOf), ...(subtitle ? { subtitle } : {}) }) as Block;
  const q = (s: string) => (s === a.latest ? `${s} to date` : s);
  return {
    attention: t('What needs attention', 'bsa.attention', [text('read', 'DI’s read'), text('area', 'Area'), text('item', 'Requirement'), text('detail', 'Where it stands')], a.items.map((i) => ({ read: i.read, area: i.area, item: i.item, detail: i.detail }))),
    sars: t('SARs by quarter', 'bsa.sars', [text('quarter', 'Quarter'), text('filed', 'SARs filed'), text('amount', 'Amount'), text('days', 'Average days to file'), text('late', 'Over 30 days'), text('alerts', 'Alerts opened'), text('conversion', 'Alerts ending in a SAR')], a.sars.byQuarter.map((s, i) => ({ quarter: q(s.quarter), filed: String(s.filed), amount: mm(s.amount), days: s.avgDays === null ? '—' : s.avgDays.toFixed(0), late: String(s.late), alerts: count(a.alerts.byQuarter[i]!.opened), conversion: a.alerts.byQuarter[i]!.conversionPct === null ? '—' : `${a.alerts.byQuarter[i]!.conversionPct!.toFixed(1)}%` })), CONFIDENTIAL),
    typologies: t('SARs by activity, last four quarters', 'bsa.typologies', [text('typology', 'Activity'), text('filed', 'SARs'), text('amount', 'Amount')], a.sars.typologies.map((x) => ({ typology: x.typology, filed: String(x.filed), amount: mm(x.amount) }))),
    alerts: t('Open alerts by age', 'bsa.alerts', [text('age', 'Open for'), text('alerts', 'Alerts')], [{ age: '30 days or less', alerts: String(a.alerts.aging.under30) }, { age: '31 to 60 days', alerts: String(a.alerts.aging.d31to60) }, { age: 'Over 60 days', alerts: String(a.alerts.aging.over60) }, { age: 'All open', alerts: String(a.alerts.open) }]),
    ctrOfac: t('CTRs and OFAC screening', 'bsa.ofac', [text('quarter', 'Quarter'), text('ctr', 'CTRs filed'), text('late', 'CTRs late'), text('screened', 'Screened for OFAC'), text('potential', 'Potential matches'), text('true', 'True matches'), text('blocked', 'Blocked or rejected')], a.ctr.map((c, i) => ({ quarter: q(c.quarter), ctr: count(c.filed), late: String(c.late), screened: count(a.ofac[i]!.screened), potential: String(a.ofac[i]!.potential), true: String(a.ofac[i]!.trueMatches), blocked: a.ofac[i]!.blocked + a.ofac[i]!.rejected ? usd(a.ofac[i]!.blocked + a.ofac[i]!.rejected) : '—' }))),
    customers: t('High-risk customers', 'bsa.customers', [text('category', 'Category'), text('customers', 'Customers'), text('overdue', 'Review overdue')], a.customers.categories.map((c) => ({ category: c.category, customers: String(c.customers), overdue: String(c.overdue) })), `${a.customers.ratings.map((r) => `${r.rating}: ${r.customers} customers, ${r.overdue} overdue`).join('; ')}. High-risk customers are reviewed every 12 months, elevated every 24.`),
    fraudQ: t('Fraud losses by quarter', 'bsa.fraudq', [text('quarter', 'Quarter'), text('cases', 'Cases'), text('gross', 'Gross loss'), text('recovered', 'Recovered'), text('net', 'Net loss'), text('prevented', 'Stopped before loss'), text('elder', 'Net loss to elder fraud')], a.fraud.byQuarter.map((f) => ({ quarter: q(f.quarter), cases: String(f.cases), gross: mm(f.gross), recovered: mm(f.recovered), net: mm(f.net), prevented: mm(f.prevented), elder: mm(f.elderNet) }))),
    fraudTypes: t('Fraud by type, last four quarters', 'bsa.fraudtypes', [text('type', 'Type'), text('channel', 'Channel'), text('cases', 'Cases'), text('net', 'Net loss'), text('prevented', 'Stopped'), text('change', `${a.lastFull} against ${a.quarters[0]}`)], a.fraud.types.map((f) => ({ type: f.type, channel: f.channel, cases: String(f.cases), net: mm(f.net), prevented: mm(f.prevented), change: f.changePct === null ? '—' : `${f.changePct >= 0 ? '+' : '−'}${Math.abs(f.changePct).toFixed(0)}%` }))),
    program: t('BSA program', 'bsa.program', [text('item', 'Item'), text('status', 'Status'), text('asOf', 'As of'), text('due', 'Due'), text('detail', 'Detail')], a.program.map((p) => ({ item: p.item, status: p.status, asOf: p.asOf, due: p.due ?? '—', detail: p.detail }))),
  };
}

function headline(a: Analysis) {
  const concerns = a.items.filter((i) => i.read === 'Concern');
  const watch = a.items.filter((i) => i.read === 'Watch');
  const lastQ = a.sars.byQuarter.find((s) => s.quarter === a.lastFull)!;
  const top = a.fraud.types[0];
  return [
    `**${a.sars.total12} SARs** were filed over the last four quarters (${lastQ.filed} in ${a.lastFull}, an average ${lastQ.avgDays?.toFixed(0)} days from detection).`,
    concerns.length ? `For the board: ${concerns.map((c) => c.brief).join('; ')}.` : 'Nothing in the BSA program is a concern.',
    watch.length ? `To watch: ${watch.map((w) => w.brief).join('; ')}.` : '',
    `Fraud cost **${mm(a.fraud.net12)}** net over the last four quarters${a.fraud.net12BpOfDeposits !== null ? ` (${a.fraud.net12BpOfDeposits.toFixed(1)} basis points of deposits)` : ''}, after stopping ${mm(a.fraud.prevented12)}${top ? `; ${lower(top.type)} is the largest at ${mm(top.net)}${top.changePct !== null ? `, ${top.changePct >= 0 ? 'up' : 'down'} ${Math.abs(top.changePct).toFixed(0)}% from ${a.quarters[0]} to ${a.lastFull}` : ''}` : ''}. Elder fraud took ${mm(a.fraud.elderNet12)}.`,
  ].filter(Boolean).join(' ');
}

export const BSA_SECTIONS = ['bsa.attention', 'bsa.sars', 'bsa.typologies', 'bsa.alerts', 'bsa.ofac', 'bsa.customers', 'bsa.fraudq', 'bsa.fraudtypes', 'bsa.program', 'bsa.assumptions'] as const;

export function bsaAnalyses(svc: BsaService): ReportAnalyses {
  const runs = new Map<string, ReturnType<BsaService['analysis']>>();
  const once = (runId: string) => {
    if (!runs.has(runId)) {
      runs.set(runId, svc.analysis());
      if (runs.size > 8) runs.delete(runs.keys().next().value!);
    }
    return runs.get(runId)!;
  };
  const who = { agent: AGENT, sources: SOURCES };
  return {
    keys: [...BSA_SECTIONS],
    async run(key, runId): Promise<{ block: Block; take?: DiTake }> {
      const a = await once(runId);
      if (!a) throw new CoreError('NOT_FOUND', 'No BSA case system data is loaded for this institution.');
      const b = tables(who, runId, a);
      const concerns = a.items.filter((i) => i.read === 'Concern');
      switch (key) {
        case 'bsa.attention':
          return { block: b.attention, take: { headline: `${a.sars.total12} SARs in four quarters; ${concerns.length ? `${concerns.length} item${concerns.length === 1 ? '' : 's'} for the board: ${concerns.map((c) => c.brief).join('; ')}` : 'nothing for the board'}. Fraud cost ${mm(a.fraud.net12)} net.`.slice(0, 300), action: { label: 'Where is fraud rising?', ask: 'Which fraud types are rising?' } } };
        case 'bsa.sars':
          return { block: b.sars };
        case 'bsa.typologies':
          return { block: b.typologies };
        case 'bsa.alerts':
          return { block: b.alerts };
        case 'bsa.ofac':
          return { block: b.ctrOfac };
        case 'bsa.customers':
          return { block: b.customers };
        case 'bsa.fraudq':
          return { block: b.fraudQ };
        case 'bsa.fraudtypes':
          return { block: b.fraudTypes };
        case 'bsa.program':
          return { block: b.program };
        default:
          return { block: moduleTable(who, 'How DI measures BSA and fraud', runId, 'bsa.assumptions', [text('item', 'Assumption'), text('detail', 'What DI uses')], svc.assumptions().map(([item, detail]) => ({ item, detail })), a.asOf) };
      }
    },
  };
}

export function bsaModule(svc: BsaService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('bsa')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: 'bsa',
    prefix: 'bsa',
    agent: AGENT,
    request: BSA_REQUEST,
    noAccess: NO_ACCESS,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You are the BSA/AML and Fraud agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) oversees the bank's BSA/AML program and fraud losses: SARs (filed within 30 days of detection), CTRs, OFAC screening, the alert backlog, high-risk customers, the program's open items, and fraud losses by type. A BSA failure can bring a consent order and a large penalty. SARs are confidential by law: never name a customer or say whether one was the subject of a SAR.

- bsa_view, with question overview, sars, alerts, ofac, ctr, customers, fraud, program or method.`,
    plan: (t) => ({ tool: 'bsa_view', args: { question: bsaQuestion(t) } }),
    tools: [
      {
        name: 'bsa_view',
        description: 'BSA/AML and fraud: SARs and their timeliness, the alert backlog, CTRs and OFAC, high-risk customer reviews, the BSA program’s open items, and fraud losses by quarter and type. Aggregates only.',
        input: z.object({ question: z.enum(['overview', 'sars', 'alerts', 'ofac', 'ctr', 'customers', 'fraud', 'program', 'method']).optional() }).strict(),
        run: async (a0: { question?: BsaQuestion }, ctx) => {
          need(ctx);
          if (a0.question === 'method') return { text: `How DI measures BSA/AML and fraud:\n\n${svc.assumptions().map(([k, v]) => `- **${k}:** ${v}`).join('\n')}` };
          const a = await svc.analysis();
          if (!a) throw new CoreError('INVALID', 'No BSA case system data is loaded for this institution.');
          const b = tables(spec, ctx.runId, a);
          const q = a0.question ?? 'overview';
          const item = (k: string) => a.items.find((i) => i.item.startsWith(k));
          const sarLate = item('SARs filed within 30 days')!;
          const reviews = item('Continuing activity')!;
          const top = a.fraud.types.slice(0, 3);
          const rising = a.fraud.types.filter((f) => (f.changePct ?? 0) > 25).slice(0, 3);
          const answers: Record<Exclude<BsaQuestion, 'method'>, [string, Block[]]> = {
            overview: [headline(a), [b.attention, b.sars, b.fraudQ]],
            sars: [`**${a.sars.total12} SARs** over the last four quarters, ${a.sars.byQuarter.filter((s) => s.quarter !== a.latest).map((s) => `${s.filed} in ${s.quarter}`).join(', ')}. ${sarLate.detail} ${reviews.detail} The most common activity: ${a.sars.typologies.slice(0, 3).map((x) => `${lower(x.typology)} (${x.filed})`).join(', ')}. ${CONFIDENTIAL}`, [b.sars, b.typologies]],
            alerts: [`**${a.alerts.open} alerts** are open: ${a.alerts.aging.under30} within 30 days, ${a.alerts.aging.d31to60} from 31 to 60 and **${a.alerts.aging.over60} over 60**. Last quarter ${count(a.alerts.byQuarter.find((x) => x.quarter === a.lastFull)!.opened)} were generated and ${a.alerts.byQuarter.find((x) => x.quarter === a.lastFull)!.conversionPct?.toFixed(1)}% of those closed ended in a SAR. An alert left open past 30 days is how a SAR ends up late, and the independent test already cited it.`, [b.alerts, b.sars]],
            ofac: [`${item('OFAC')!.detail} Every new account, wire and ACH is screened against the SDN list; a true match is blocked or rejected and reported to OFAC within 10 business days.`, [b.ctrOfac]],
            ctr: [`${item('CTRs')!.detail} ${a.ctr.find((c) => c.quarter === a.lastFull)?.filed} were filed in ${a.lastFull}. Structuring (keeping deposits under $10,000 to avoid a CTR) is among the most common SAR activities.`, [b.ctrOfac]],
            customers: [`${item('High-risk customer')!.detail} The largest groups are ${a.customers.categories.slice(0, 3).map((c) => `${lower(c.category)} (${c.customers})`).join(', ')}. ${item('Beneficial ownership')?.detail ?? ''}`, [b.customers]],
            fraud: [`Fraud cost **${mm(a.fraud.net12)}** net over the last four quarters${a.fraud.net12BpOfDeposits !== null ? `, ${a.fraud.net12BpOfDeposits.toFixed(1)} basis points of deposits` : ''}, after recoveries and ${mm(a.fraud.prevented12)} stopped before it left. The largest: ${top.map((f) => `${lower(f.type)} ${mm(f.net)}`).join(', ')}.${rising.length ? ` Rising from ${a.quarters[0]} to ${a.lastFull}: ${rising.map((f) => `${lower(f.type)} ${f.changePct!.toFixed(0)}%`).join(', ')}.` : ''} Elder fraud took ${mm(a.fraud.elderNet12)}; scams that talk a customer into sending money are hard to recover and are where the losses are growing.`, [b.fraudTypes, b.fraudQ]],
            program: [`${a.program.filter((p) => p.status !== 'Current').map((p) => `**${p.item}**: ${lower(p.detail)}`).join(' ')}`, [b.program, b.attention]],
          };
          const [reply, blocks] = answers[q];
          return { text: reply, blocks, sources: SOURCES, suggestions: ['Which fraud types are rising?', 'How old is our alert backlog?', 'Are our SARs filed on time?', 'What’s open in the BSA program?'].filter((s) => bsaQuestion(s) !== q).slice(0, 3) };
        },
      },
    ],
  };
  return spec;
}
