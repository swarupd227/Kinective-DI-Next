// Concentration (banks): commercial real estate against the interagency guidance, and property type,
// office, geography, industry and relationships against the board's limits, as answers and as the
// Concentration report's sections.
import type { Block, DiTake } from '@dinext/block-schemas';
import { z } from 'zod';
import { CONCENTRATION_LIMITS, CoreError, type ConcentrationService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

export const CONCENTRATION_REQUEST = /\bconcentrations\b|\bconcentration (?:report|risk|limits?|review|policy)\b|\bover-?exposed\b|\bexposures? to (?:office|cre|commercial real estate|one|a single|hotels?|retail|multifamily|construction|any)\b|\boffice (?:loans?|exposure|cre|properties|property|buildings?|space|portfolio|maturit\w*)\b|\b(?:geographic|geography|county|industry|sector|single[- ]borrower|borrower|relationship|property[- ]type) concentrations?\b|\bconcentrated in\b|\blargest (?:borrowers?|relationships?|exposures?)\b|\blegal lending limit\b|\b(?:cre|commercial real estate) (?:by|mix|book by) (?:property|type)\b|\bproperty types?\b|\bwhich (?:industr|count)\w*\b[^.?!]*\b(?:lend|loans?|exposure)\b/i;
export type ConcentrationQuestion = 'overview' | 'office' | 'property' | 'geography' | 'industry' | 'relationships' | 'method';
export function concentrationQuestion(text: string): ConcentrationQuestion {
  const t = text.toLowerCase();
  if (/how (?:is|are|do you) .*(?:calculat|measur)|assum|\bmethod/.test(t)) return 'method';
  if (/\boffice/.test(t)) return 'office';
  if (/geograph|county|counties|state|market|out of (?:state|market)/.test(t)) return 'geography';
  if (/industr|sector|naics/.test(t)) return 'industry';
  if (/borrower|relationship|lending limit|largest/.test(t)) return 'relationships';
  if (/property|hotel|retail|multifamily|construction|cre mix/.test(t)) return 'property';
  return 'overview';
}

const NO_ACCESS = 'Concentration risk isn’t part of your DI access. It is for a bank’s finance and credit leaders.';
const AGENT = 'Concentration';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const mm = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
const p0 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(0)}%`);
const p1 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(1)}%`);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
type Analysis = NonNullable<Awaited<ReturnType<ConcentrationService['analysis']>>>;
type Who = Pick<ModuleSpec, 'agent' | 'sources'>;
const SOURCES: ModuleSpec['sources'] = [
  { kind: 'table', label: 'FFIEC 051 Call Report values', ref: 'table:cr_value' },
  { kind: 'table', label: 'Commercial loan detail', ref: 'table:cdm_loan_detail' },
];

/** The report's and the answers' tables, from one analysis. */
function tables(who: Who, runId: string, a: Analysis) {
  const t = (title: string, op: string, cols: ReturnType<typeof text>[], rows: Record<string, string>[], subtitle?: string) => ({ ...moduleTable(who, title, runId, op, cols, rows, a.asOf), ...(subtitle ? { subtitle } : {}) }) as Block;
  const r = a.regulatory;
  return {
    policy: t('Concentration limits', 'conc.policy', [text('status', 'Status'), text('area', 'Area'), text('measure', 'Measure'), text('actual', 'Actual'), text('limit', 'Limit')], a.lines.map((l) => ({ status: l.status, area: l.area, measure: l.measure, actual: l.actual, limit: l.limit })), 'Percent of tier 1 capital plus the allowance unless shown as a share of loans; the closest to their limits first.'),
    regulatory: t('Commercial real estate against the interagency guidance', 'conc.regulatory', [text('item', 'Measure'), text('value', 'Balance'), text('pct', 'Of capital'), text('guide', 'Guidance')], [
      { item: 'Construction and land development (RC-C 1.a)', value: mm(r.construction), pct: p0(r.constructionPct), guide: `${CONCENTRATION_LIMITS.constructionGuidancePct}%` },
      { item: 'Multifamily (RC-C 1.d)', value: mm(r.multifamily), pct: p0((r.multifamily / r.capital) * 100), guide: '' },
      { item: 'Other nonfarm nonresidential (RC-C 1.e.2)', value: mm(r.otherNonres), pct: p0((r.otherNonres / r.capital) * 100), guide: '' },
      { item: 'Non-owner-occupied CRE', value: mm(r.nonOwnerCre), pct: p0(r.crePct), guide: `${CONCENTRATION_LIMITS.creGuidancePct}%` },
      { item: 'Owner-occupied nonfarm nonresidential (left out)', value: mm(r.ownerOccupied), pct: p0((r.ownerOccupied / r.capital) * 100), guide: '' },
      { item: `Growth in non-owner-occupied CRE, last ${r.growthMonths} months`, value: '', pct: p1(r.growthPct), guide: `${CONCENTRATION_LIMITS.growthGuidancePct}% over 36 months` },
      { item: 'Tier 1 capital plus the allowance', value: mm(r.capital), pct: '', guide: '' },
    ]),
    property: t('Commercial real estate by property type', 'conc.property', [text('type', 'Property type'), text('balance', 'Balance'), text('ofCre', 'Of CRE'), text('ofCap', 'Of capital'), text('limit', 'Limit'), text('status', 'Status'), text('ltv', 'Loan-to-value'), text('dscr', 'Coverage'), text('maturing', 'Matures in 2 years')], a.property.map((p) => ({ type: p.type, balance: mm(p.balance), ofCre: p1(p.pctOfCre), ofCap: p1(p.pctOfCapital), limit: p.limit === null ? '—' : `${p.limit}%`, status: p.limit === null ? '' : p.status, ltv: p0(p.ltvPct), dscr: p.dscr === null ? '—' : `${p.dscr.toFixed(2)}×`, maturing: mm(p.maturing24) }))),
    office: t('Office loans: when they balloon', 'conc.office', [text('year', 'Matures'), text('loans', 'Loans'), text('balance', 'Balance'), text('thin', 'Coverage under 1.15×')], a.officeMaturities.map((m) => ({ year: m.year === 1 ? 'In the next 12 months' : `In year ${m.year}`, loans: String(m.loans), balance: mm(m.balance), thin: mm(m.thinDscr) })), 'Owner-occupied office included. A loan that balloons into today’s rates and a lower appraisal may not refinance.'),
    stress: t('If property values fall', 'conc.stress', [text('type', 'Property type'), text('fall', 'Values fall'), text('loans', 'Loans then above value'), text('short', 'Balance above value')], a.property.filter((p) => p.stressFallPct >= 15).map((p) => ({ type: p.type, fall: `${p.stressFallPct.toFixed(0)}%`, loans: String(p.stressLoans), short: mm(p.stressShortfall) })), 'From the latest appraisal, before guarantors or other collateral.'),
    geography: t('Loans by county', 'conc.geography', [text('county', 'County'), text('market', 'Market'), text('balance', 'All loans'), text('share', 'Share of loans'), text('commercial', 'Commercial loans'), text('ofCap', 'Commercial to capital')], a.geography.map((g) => ({ county: g.county, market: g.inMarket ? 'In market' : 'Out of state', balance: mm(g.balance), share: p1(g.pctOfLoans), commercial: mm(g.commercial), ofCap: p0(g.pctOfCapital) }))),
    industry: t('Business lending by industry', 'conc.industry', [text('industry', 'Industry (NAICS)'), text('loans', 'Loans'), text('balance', 'Balance'), text('ofCap', 'Of capital'), text('limit', 'Limit'), text('status', 'Status')], a.industry.map((i) => ({ industry: `${i.industry} (${i.naics})`, loans: String(i.loans), balance: mm(i.balance), ofCap: p1(i.pctOfCapital), limit: `${i.limit}%`, status: i.status })), 'C&I loans and owner-occupied commercial real estate, by the borrower’s sector.'),
    relationships: t('Largest relationships', 'conc.relationships', [text('rank', 'Rank'), text('balance', 'Balance'), text('loans', 'Loans'), text('what', 'Secured by or industry'), text('ofCap', 'Of capital'), text('ofLegal', 'Of legal lending limit')], a.relationships.slice(0, 10).map((r, i) => ({ rank: String(i + 1), balance: mm(r.balance), loans: String(r.loans), what: r.what, ofCap: p1(r.pctOfCapital), ofLegal: p0(r.pctOfLegal) })), `Legal lending limit ${mm(a.legal)}; house limit ${mm(a.house)}. The 20 largest add up to ${mm(a.top20)}, ${p0((a.top20 / a.regulatory.capital) * 100)} of capital.`),
  };
}

/** The headline: what's over or close to a limit, office first, then the guidance. */
function headline(a: Analysis) {
  const r = a.regulatory;
  const over = a.lines.filter((l) => l.status === 'Over');
  const watch = a.lines.filter((l) => l.status === 'Watch');
  const office = a.property.find((p) => p.type === 'Office');
  const officeAll = a.property.filter((p) => /office/i.test(p.type));
  const officeBal = officeAll.reduce((s, p) => s + p.balance, 0);
  const due = a.officeMaturities.slice(0, 2).reduce((s, m) => s + m.balance, 0);
  const parts = [
    `Non-owner-occupied CRE is **${p0(r.crePct)}** of tier 1 capital plus the allowance against the guidance’s ${CONCENTRATION_LIMITS.creGuidancePct}%, and construction **${p0(r.constructionPct)}** against ${CONCENTRATION_LIMITS.constructionGuidancePct}%${r.growthPct !== null ? `; CRE grew ${p1(r.growthPct)} over the last ${r.growthMonths} months` : ''}.`,
    office ? `Office is the one to watch: **${mm(office.balance)}** of investor office, **${p1(office.pctOfCapital)}** of capital against the board’s ${office.limit}% limit (${mm(officeBal)} with owner-occupied office), with **${mm(due)}** ballooning in the next two years. If office values fell ${office.stressFallPct.toFixed(0)}%, ${office.stressLoans} loans would owe ${mm(office.stressShortfall)} more than the building is worth.` : '',
    over.length ? `Over a limit: ${over.map((l) => `${lower(l.measure).replace(' (largest)', '')} at ${l.actual} (limit ${l.limit})`).join('; ')}.` : '',
    watch.filter((w) => !/^Office/.test(w.measure)).length ? `Close to a limit: ${watch.filter((w) => !/^Office/.test(w.measure)).map((l) => `${lower(l.measure).replace(' (largest)', '').replace(/ to capital$/, ' to capital')} at ${l.actual} (limit ${l.limit})`).join('; ')}.` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/** The report's one-line take, short enough for its header. */
function take(a: Analysis) {
  const over = a.lines.filter((l) => l.status === 'Over').length;
  const watch = a.lines.filter((l) => l.status === 'Watch');
  const office = a.property.find((p) => p.type === 'Office');
  return `Non-owner-occupied CRE is ${p0(a.regulatory.crePct)} of capital against the guidance’s 300%.${office ? ` Office is ${p1(office.pctOfCapital)} against a ${office.limit}% limit.` : ''} ${over ? `${over} over a limit; ` : 'Nothing over a limit; '}${watch.length} close: ${watch.map((w) => lower(w.measure).replace(' (largest)', '').replace(/ to capital$| share of loans$/, '')).join(', ')}.`.slice(0, 300);
}

export const CONCENTRATION_SECTIONS = ['conc.policy', 'conc.regulatory', 'conc.property', 'conc.office', 'conc.stress', 'conc.geography', 'conc.industry', 'conc.relationships', 'conc.assumptions'] as const;

export function concentrationAnalyses(svc: ConcentrationService): ReportAnalyses {
  const runs = new Map<string, ReturnType<ConcentrationService['analysis']>>();
  const once = (runId: string) => {
    if (!runs.has(runId)) {
      runs.set(runId, svc.analysis());
      if (runs.size > 8) runs.delete(runs.keys().next().value!);
    }
    return runs.get(runId)!;
  };
  const who = { agent: AGENT, sources: SOURCES };
  return {
    keys: [...CONCENTRATION_SECTIONS],
    async run(key, runId): Promise<{ block: Block; take?: DiTake }> {
      const a = await once(runId);
      if (!a) throw new CoreError('NOT_FOUND', 'Concentration is built from a bank’s FFIEC Call Report, and none is on file yet.');
      const b = tables(who, runId, a);
      switch (key) {
        case 'conc.policy':
          return { block: b.policy, take: { headline: take(a), action: { label: 'What about office?', ask: 'How exposed are we to office loans?' } } };
        case 'conc.regulatory':
          return { block: b.regulatory };
        case 'conc.property':
          return { block: b.property };
        case 'conc.office':
          return { block: b.office };
        case 'conc.stress':
          return { block: b.stress };
        case 'conc.geography':
          return { block: b.geography };
        case 'conc.industry':
          return { block: b.industry };
        case 'conc.relationships':
          return { block: b.relationships };
        default:
          return { block: moduleTable(who, 'Concentration assumptions', runId, 'conc.assumptions', [text('item', 'Assumption'), text('detail', 'What DI uses')], svc.assumptions().map(([item, detail]) => ({ item, detail })), a.asOf) };
      }
    },
  };
}

export function concentrationModule(svc: ConcentrationService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('concentration')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: 'concentration',
    prefix: 'conc',
    agent: AGENT,
    request: CONCENTRATION_REQUEST,
    noAccess: NO_ACCESS,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You are the Concentration agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) watches the bank's concentrations: commercial real estate against the 2006 interagency guidance (300% of capital, construction 100%), and property type (office above all), geography, industry and single relationships against the board's limits. Examiners focus on CRE and office now.

- conc_view, with question overview, office, property, geography, industry, relationships or method.`,
    plan: (t) => ({ tool: 'conc_view', args: { question: concentrationQuestion(t) } }),
    tools: [
      {
        name: 'conc_view',
        description: 'Concentrations: CRE against the interagency guidance, property types and office (maturities, coverage, a fall in values), counties, industries and the largest relationships, each against the board’s limits.',
        input: z.object({ question: z.enum(['overview', 'office', 'property', 'geography', 'industry', 'relationships', 'method']).optional() }).strict(),
        run: async (a0: { question?: ConcentrationQuestion }, ctx) => {
          need(ctx);
          if (a0.question === 'method') return { text: `How DI measures concentration:\n\n${svc.assumptions().map(([k, v]) => `- **${k}:** ${v}`).join('\n')}` };
          const a = await svc.analysis();
          if (!a) throw new CoreError('INVALID', 'Concentration is built from a bank’s FFIEC Call Report, and none is on file yet.');
          const b = tables(spec, ctx.runId, a);
          const q = a0.question ?? 'overview';
          const office = a.property.find((p) => p.type === 'Office');
          const top = a.industry[0];
          const g = a.geography[0];
          const rel = a.relationships[0];
          const answers: Record<Exclude<ConcentrationQuestion, 'method'>, [string, Block[]]> = {
            overview: [headline(a), [b.policy, b.property, b.regulatory]],
            office: [
              office
                ? `Investor office is **${mm(office.balance)}** across ${office.loans} loans, **${p1(office.pctOfCapital)}** of tier 1 capital plus the allowance against the board’s ${office.limit}% limit: ${office.status === 'Watch' ? 'close to it' : office.status === 'Over' ? 'over it' : 'within it'}. Loan-to-value on the latest appraisals is ${p0(office.ltvPct)} and coverage ${office.dscr?.toFixed(2)}×, with ${mm(office.thinDscr)} under 1.15×. **${mm(a.officeMaturities[0]!.balance)}** balloons in the next 12 months and ${mm(a.officeMaturities[1]!.balance)} the year after, into higher rates and lower values. If office values fell ${office.stressFallPct.toFixed(0)}% from the appraisals, ${office.stressLoans} loans would owe **${mm(office.stressShortfall)}** more than the building is worth, before guarantors.`
                : 'There are no office loans in the commercial loan detail.',
              [b.office, b.stress, b.property],
            ],
            property: [`Commercial real estate is ${mm(a.creTotal)} by property type: ${a.property.slice(0, 4).map((p) => `${lower(p.type)} ${mm(p.balance)} (${p1(p.pctOfCapital)} of capital${p.limit !== null ? `, limit ${p.limit}%` : ''})`).join(', ')}. ${headline(a).split('. ').slice(0, 1).join('')}.`, [b.property, b.stress]],
            geography: [`${g ? `${g.county} holds **${p1(g.pctOfLoans)}** of loans (limit ${CONCENTRATION_LIMITS.largestCountyPctOfLoans}%)` : ''}${a.geography[1] ? ` and ${a.geography[1].county} ${p1(a.geography[1].pctOfLoans)}` : ''}. Out-of-state loans are **${mm(a.outOfMarket)}**, ${p1((a.outOfMarket / a.totalLoans) * 100)} of loans against a ${CONCENTRATION_LIMITS.outOfMarketPctOfLoans}% limit: ${a.geography.filter((x) => !x.inMarket).map((x) => x.county).join(', ')}. A downturn in the home market would reach most of the book at once, which is the concentration a community bank can’t diversify away.`, [b.geography]],
            industry: [top ? `The largest industry is **${lower(top.industry)}**: ${mm(top.balance)} across ${top.loans} loans, **${p1(top.pctOfCapital)}** of capital against the board’s ${top.limit}% limit for one industry: ${top.status === 'Watch' ? 'close to it' : top.status === 'Over' ? 'over it' : 'within it'}. Next are ${a.industry.slice(1, 3).map((i) => `${lower(i.industry)} ${p1(i.pctOfCapital)}`).join(' and ')}.` : 'No industry is recorded on the business loans.', [b.industry]],
            relationships: [rel ? `The largest relationship is **${mm(rel.balance)}** (${rel.loans} loans, ${rel.what.toLowerCase()}), ${p1(rel.pctOfCapital)} of capital and ${p0(rel.pctOfLegal)} of the legal lending limit of ${mm(a.legal)}; the house limit is ${mm(a.house)}. The 20 largest add up to ${mm(a.top20)}, ${p0((a.top20 / a.regulatory.capital) * 100)} of capital: the book is granular, so single names aren’t the concentration here.` : 'No relationships are recorded.', [b.relationships]],
          };
          const [reply, blocks] = answers[q];
          return { text: reply, blocks, sources: SOURCES, suggestions: ['How exposed are we to office loans?', 'Which industries are we most concentrated in?', 'Show our largest relationships', 'How is concentration measured?'].filter((s) => concentrationQuestion(s) !== q).slice(0, 3) };
        },
      },
    ],
  };
  return spec;
}
