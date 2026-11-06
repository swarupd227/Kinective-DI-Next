// CAMELS view and stress test (Board / regulatory pack). Examiners assign CAMELS ratings, and the
// ratings are confidential supervisory information, so DI never produces one. What DI shows is each
// component's measures, the way examiners read them: where the institution stands, against its
// minimums, policy and peers, with DI's read (Strong, Satisfactory, Watch or Concern) and why.
// Capital is read with the stress test: how low the capital ratio goes in a severe downturn.
import { z } from 'zod';
import type { Block, DiTake, TableBlock } from '@dinext/block-schemas';
import { AlcoService, CoreError, ProfitabilityService, StressService, type ScenarioKey } from '@dinext/di-core';
import type { SemanticService } from '@dinext/semantic';
import type { Pool } from '@dinext/tenant-db';
import { moduleTable, type ModuleContext, type ModuleSpec, type ModuleView } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';
import { boardScorecard } from './scorecard.ts';

export type Read = 'Strong' | 'Satisfactory' | 'Watch' | 'Concern';
const ORDER: Read[] = ['Strong', 'Satisfactory', 'Watch', 'Concern'];
export interface Measure {
  label: string;
  value: string;
  against: string;
  read: Read;
  why: string;
}
export interface Component {
  letter: 'C' | 'A' | 'M' | 'E' | 'L' | 'S';
  name: string;
  read: Read;
  summary: string;
  measures: Measure[];
}

const p1 = (n: number) => `${n.toFixed(1)}%`;
const p2 = (n: number) => `${n.toFixed(2)}%`;
const m = (n: number) => `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(1)}M`;
/** "Tier 1 leverage ratio" keeps its capital; "Net worth ratio" reads "net worth ratio" mid-sentence. */
const ratioLower = (name: string) => (/^Tier 1/.test(name) ? name : name.toLowerCase());
/** "Net charge-offs" to "net charge-offs" mid-sentence, leaving acronyms such as NEV and CRE alone. */
const lower = (label: string) => (/^[A-Z][a-z]/.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label);
const worst = (rs: Read[]) => rs.reduce((w, r) => (ORDER.indexOf(r) > ORDER.indexOf(w) ? r : w), 'Strong' as Read);
/** A component reads Strong only when every measure does; otherwise its weakest measure, at best Satisfactory. */
const componentRead = (ms: Measure[]) => {
  const w = worst(ms.map((x) => x.read));
  return w === 'Strong' && ms.some((x) => x.read !== 'Strong') ? 'Satisfactory' : w;
};
const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

export interface CamelsDeps {
  pool: Pool;
  institutionType: 'credit_union' | 'bank';
  semantic: () => Promise<SemanticService>;
}

/** Every component's measures and DI's read, with the stress test that capital is read against. */
export async function camelsView(d: CamelsDeps) {
  const bank = d.institutionType === 'bank';
  const [alco, stress, allowance, board] = await Promise.all([new AlcoService(d.pool, d.institutionType).analysis(), new StressService(d.pool, d.institutionType).analysis(), new ProfitabilityService(d.pool, d.institutionType).allowance(), d.semantic().then((s) => boardScorecard(s, d.pool, d.institutionType))]);
  if (!stress) throw new CoreError('NOT_FOUND', `There’s no ${bank ? 'FFIEC Call Report' : '5300'} on file yet, so DI can’t read capital or run the stress test.`);
  const s = stress.start;
  const ratio = (s.capital / s.assets) * 100;
  const severe = stress.runs.find((r) => r.scenario.key === 'severe')!;
  const sc = (key: string) => board.rows.find((r) => r.key === key);
  const vsPeer = (key: string): Read => {
    const r = sc(key);
    return !r || r.vsPeer === '—' ? 'Satisfactory' : r.vsPeer === 'Better' ? 'Strong' : r.vsPeer === 'Worse' ? 'Watch' : 'Satisfactory';
  };
  const peerText = (key: string, places = 2) => {
    const r = sc(key);
    return r?.peer === null || r?.peer === undefined ? 'No peer figure' : `Peers ${r.peer.toFixed(places)}%`;
  };
  const policyRead = (st: string): Read => (st === 'Breach' ? 'Concern' : st === 'Watch' ? 'Watch' : 'Strong');

  // ---- Capital ----
  const history = await rows<{ q: unknown; v: number }>(d.pool, bank ? "SELECT quarter_end AS q, amount AS v FROM cr_value WHERE code = 'RCON7204' ORDER BY quarter_end" : "SELECT a.quarter_end AS q, a.amount / b.amount * 100 AS v FROM cr_value a JOIN cr_value b ON b.quarter_end = a.quarter_end AND b.code = '010' WHERE a.code = '997' ORDER BY a.quarter_end");
  const first = history.length ? Number(history[0]!.v) : ratio;
  const cushion = ratio - s.minimumPct;
  const capital: Measure[] = [
    { label: s.ratioName, value: p2(ratio), against: `Minimum ${s.minimumPct}%`, read: cushion >= 3 ? 'Strong' : cushion >= 1.5 ? 'Satisfactory' : cushion > 0 ? 'Watch' : 'Concern', why: `${cushion.toFixed(2)} points above ${s.minimumName}.` },
    { label: 'Trend, last 5 quarters', value: `${p2(first)} to ${p2(ratio)}`, against: 'Steady or rising', read: ratio >= first - 0.25 ? 'Strong' : 'Watch', why: ratio >= first ? 'Capital has kept pace with growth.' : 'Capital has grown more slowly than assets.' },
    { label: 'Lowest point, severely adverse', value: `${p2(severe.trough.ratioPct)} (${severe.trough.quarter})`, against: `Minimum ${s.minimumPct}%`, read: severe.cushionPct >= 2 ? 'Strong' : severe.cushionPct >= 1 ? 'Satisfactory' : severe.cushionPct > 0 ? 'Watch' : 'Concern', why: severe.cushionPct > 0 ? `Stays ${severe.cushionPct.toFixed(2)} points above the minimum through nine quarters of a severe downturn.` : `Falls ${Math.abs(severe.cushionPct).toFixed(2)} points below the minimum in a severe downturn.` },
    { label: 'Losses that would reach the minimum', value: `${m(stress.reverse.losses)}, ${p1(stress.reverse.lossPct)} of loans`, against: `${stress.reverse.multiple.toFixed(2)}× severely adverse`, read: stress.reverse.multiple >= 2 ? 'Strong' : stress.reverse.multiple >= 1.25 ? 'Satisfactory' : stress.reverse.multiple >= 1 ? 'Watch' : 'Concern', why: 'The reverse stress test: how much worse than severely adverse losses would have to be.' },
  ];

  // ---- Asset quality ----
  const [rated] = await rows<{ sub: number; sm: number }>(d.pool, 'SELECT SUM(CASE WHEN risk_rating >= 7 THEN balance ELSE 0 END) AS sub, SUM(CASE WHEN risk_rating = 6 THEN balance ELSE 0 END) AS sm FROM cdm_loan WHERE close_date IS NULL AND charge_off_date IS NULL');
  const classified = Number(rated?.sub ?? 0);
  const classifiedRatio = (classified / (s.capital + s.allowance)) * 100;
  const dq = sc('delinquency_ratio_60_plus');
  const nco = sc('net_charge_off_ratio');
  const dq60 = alco.loans.lines.reduce((x, l) => x + (l.balance * l.dq60Pct) / 100, 0);
  const conc = alco.loans.concentration;
  const concLine = alco.policy.find((p) => p.area === 'Concentration');
  const asset: Measure[] = [
    { label: 'Classified loans to capital and allowance', value: p1(classifiedRatio), against: 'Under 25% is typical', read: classifiedRatio < 15 ? 'Strong' : classifiedRatio < 25 ? 'Satisfactory' : classifiedRatio < 40 ? 'Watch' : 'Concern', why: `${m(classified)} rated substandard or worse${rated?.sm ? `, and ${m(Number(rated.sm))} special mention` : ''}.` },
    { label: 'Delinquency 60+', value: dq?.actual === null || dq?.actual === undefined ? '—' : p2(dq.actual), against: peerText('delinquency_ratio_60_plus'), read: vsPeer('delinquency_ratio_60_plus'), why: dq?.vsPeer === 'Worse' ? 'Above peers.' : 'In line with or better than peers.' },
    { label: 'Net charge-offs to average loans', value: nco?.actual === null || nco?.actual === undefined ? '—' : p2(nco.actual), against: peerText('net_charge_off_ratio'), read: vsPeer('net_charge_off_ratio'), why: nco?.vsPeer === 'Worse' ? 'Above peers.' : 'In line with or better than peers.' },
    { label: 'Allowance to loans', value: p2(allowance.coveragePct), against: `${(allowance.allowance / Math.max(dq60, 1)).toFixed(1)}× loans 60+ days past due`, read: allowance.allowance >= dq60 ? 'Strong' : allowance.allowance >= dq60 * 0.6 ? 'Satisfactory' : 'Watch', why: `${m(allowance.allowance)} reserved against ${m(dq60)} of loans 60+ days past due.` },
    { label: conc.name, value: conc.unit === '%' ? `${Math.round(conc.value)}%` : `${conc.value.toFixed(2)}×`, against: conc.unit === '%' ? `Guidance ${conc.limit}%` : `Limit ${conc.limit}×`, read: concLine ? policyRead(concLine.status) : 'Satisfactory', why: bank ? `${Math.round(conc.value)}% of capital against the 300% the interagency guidance names; above it, examiners look harder at commercial real estate risk management.` : `Member business loans are ${conc.value.toFixed(2)} times net worth, against the ${conc.limit}× limit.` },
  ];

  // ---- Management ----
  const [build] = await rows<{ d: unknown }>(d.pool, 'SELECT MAX(as_of_date) AS d FROM meta_build');
  const asOf = String(build?.d ?? s.end).slice(0, 10);
  const [iss] = await rows<{ n: number; late: number; oldest: number | null }>(d.pool, "SELECT COUNT(*) AS n, SUM(resolve_by < ?) AS late, MAX(DATEDIFF(?, opened)) AS oldest FROM cpm_issue WHERE kind = 'regulatory' AND closed IS NULL", [asOf, asOf]);
  const open = Number(iss?.n ?? 0);
  const late = Number(iss?.late ?? 0);
  const behind = board.rows.filter((r) => r.vsPlan === 'Behind');
  const management: Measure[] = [
    { label: 'Policy limits met', value: `${alco.policy.length - alco.breaches.length} of ${alco.policy.length}`, against: 'All', read: alco.breaches.length ? (alco.breaches.length > 1 ? 'Concern' : 'Watch') : alco.watch.length ? 'Satisfactory' : 'Strong', why: alco.breaches.length ? `Outside policy: ${alco.breaches.map((b) => b.measure).join('; ')}.` : alco.watch.length ? `Close to a limit: ${alco.watch.map((w) => w.measure).join('; ')}.` : 'Every ALCO policy limit is met.' },
    { label: 'Open regulatory issues', value: String(open), against: late ? `${late} past their resolve-by date` : 'None past due', read: late > 2 ? 'Concern' : late ? 'Watch' : open ? 'Satisfactory' : 'Strong', why: iss?.oldest ? `The oldest has been open ${iss.oldest} days.` : 'No regulatory issue is open.' },
    { label: 'Measures behind the board’s plan', value: `${behind.length} of ${board.rows.filter((r) => r.vsPlan !== '—').length}`, against: 'Board plan', read: behind.length > 3 ? 'Watch' : 'Satisfactory', why: behind.length ? `Behind: ${behind.map((b) => lower(b.label.replace(/, 12 months$/, ''))).join('; ')}.` : 'On or ahead of plan on every measure.' },
  ];

  // ---- Earnings ----
  const roa = sc('return_on_assets');
  const nim = sc('net_interest_margin');
  const eff = sc('efficiency_ratio');
  const earnings: Measure[] = [
    { label: 'Return on assets', value: roa?.actual === null || roa?.actual === undefined ? '—' : p2(roa.actual), against: peerText('return_on_assets'), read: roa?.actual !== null && roa?.actual !== undefined && roa.actual < 0.5 ? 'Concern' : vsPeer('return_on_assets'), why: roa?.vsPeer === 'Worse' ? 'Below peers.' : 'In line with or better than peers.' },
    { label: 'Net interest margin', value: nim?.actual === null || nim?.actual === undefined ? '—' : p2(nim.actual), against: peerText('net_interest_margin'), read: vsPeer('net_interest_margin'), why: nim?.vsPeer === 'Worse' ? 'Below peers.' : 'In line with or better than peers.' },
    { label: 'Efficiency ratio', value: eff?.actual === null || eff?.actual === undefined ? '—' : p1(eff.actual), against: peerText('efficiency_ratio', 1), read: vsPeer('efficiency_ratio'), why: eff?.vsPeer === 'Worse' ? 'Costs more to earn a dollar than peers.' : 'In line with or better than peers.' },
    { label: 'Pre-provision earnings, severely adverse', value: m(severe.ppnr), against: `Provisions ${m(severe.provisions)}`, read: severe.ppnr >= severe.provisions ? 'Strong' : severe.ppnr >= severe.provisions * 0.7 ? 'Satisfactory' : 'Watch', why: severe.ppnr >= severe.provisions ? 'Earnings would absorb a severe downturn’s provisions.' : `Earnings would cover ${Math.round((severe.ppnr / severe.provisions) * 100)}% of a severe downturn’s provisions; capital takes the rest.` },
  ];

  // ---- Liquidity and Sensitivity, from the ALCO policy lines ----
  const fromPolicy = (area: string): Measure[] => alco.policy.filter((p) => p.area === area).map((p) => ({ label: p.measure, value: p.actual, against: p.policy, read: policyRead(p.status), why: p.status === 'Within' ? 'Within policy.' : p.status === 'Watch' ? 'Close to the policy limit.' : 'Outside policy.' }));
  const liquidity = fromPolicy('Liquidity');
  const sensitivity = fromPolicy('Interest rate risk');

  const summarize = (ms: Measure[]) => {
    const weak = ms.filter((x) => x.read === 'Watch' || x.read === 'Concern').sort((x, y) => ORDER.indexOf(y.read) - ORDER.indexOf(x.read));
    return weak.length ? `${weak.map((x) => `${x.label}: ${x.value}`).join('; ')}.` : 'No measure needs attention.';
  };
  const make = (letter: Component['letter'], name: string, ms: Measure[]): Component => ({ letter, name, read: componentRead(ms), summary: summarize(ms), measures: ms });
  const components = [make('C', 'Capital', capital), make('A', 'Asset quality', asset), make('M', 'Management', management), make('E', 'Earnings', earnings), make('L', 'Liquidity', liquidity), make('S', 'Sensitivity to market risk', sensitivity)];
  const watch = components.flatMap((c) => c.measures.filter((x) => x.read === 'Watch' || x.read === 'Concern').map((x) => ({ component: c.name, ...x }))).sort((x, y) => ORDER.indexOf(y.read) - ORDER.indexOf(x.read));
  const concerns = watch.filter((w) => w.read === 'Concern');
  const toWatch = watch.filter((w) => w.read === 'Watch');
  const capitalLine = `${s.ratioName} is ${p2(ratio)}; in a severe downturn it falls to ${p2(severe.trough.ratioPct)} against ${s.minimumName}.`;
  const named = (ws: typeof watch) => ws.slice(0, 3).map((w) => `${lower(w.label)} (${w.value})`).join('; ');
  const headline = concerns.length
    ? `${concerns.length === 1 ? 'One concern' : `${concerns.length} concerns`}: ${named(concerns)}${toWatch.length ? `, and ${toWatch.length} ${toWatch.length === 1 ? 'measure' : 'measures'} to watch` : ''}. ${capitalLine}`
    : toWatch.length
    ? `No concerns; ${toWatch.length} ${toWatch.length === 1 ? 'measure' : 'measures'} to watch, led by ${named(toWatch.slice(0, 2))}. ${capitalLine}`
    : `No measure needs attention. ${capitalLine}`;
  return { bank, asOf: s.end, components, watch, headline, stress };
}

const READ_TONE: Record<Read, string> = { Strong: 'Strong', Satisfactory: 'Satisfactory', Watch: 'Watch', Concern: 'Concern' };
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const NOTE = 'DI’s read of each measure, not a CAMELS rating: examiners assign ratings, and they are confidential supervisory information.';

export const CAMELS_SECTIONS = ['camels.summary', 'camels.measures', 'stress.capital', 'stress.losses', 'stress.cre'] as const;

type Who = Pick<ModuleSpec, 'agent' | 'sources'>;
const blocksFor = (who: Who, runId: string, v: Awaited<ReturnType<typeof camelsView>>) => {
  const t = (title: string, op: string, cols: TableBlock['data']['columns'], rs: Record<string, string | number>[], subtitle?: string) => ({ ...moduleTable(who, title, runId, op, cols, rs, v.asOf), ...(subtitle ? { subtitle } : {}) }) as Block;
  const s = v.stress;
  const minimum = s.start.minimumPct;
  return {
    summary: t('CAMELS components: DI’s read', 'camels.summary', [text('component', 'Component'), text('read', 'DI’s read'), text('summary', 'What to look at')], v.components.map((c) => ({ component: `${c.letter}: ${c.name}`, read: READ_TONE[c.read], summary: c.summary })), NOTE),
    measures: t('CAMELS measures', 'camels.measures', [text('component', 'Component'), text('measure', 'Measure'), text('value', 'Now'), text('against', 'Against'), text('read', 'DI’s read'), text('why', 'Why')], v.components.flatMap((c) => c.measures.map((x) => ({ component: c.letter, measure: x.label, value: x.value, against: x.against, read: x.read, why: x.why })))),
    capital: t(`Stress test: ${ratioLower(s.start.ratioName)} over nine quarters`, 'stress.capital', [text('quarter', 'Quarter'), ...s.runs.map((r) => text(r.scenario.key, r.scenario.name))], s.runs[0]!.quarters.map((q, i) => ({ quarter: q.quarter, ...Object.fromEntries(s.runs.map((r) => [r.scenario.key, p2(r.quarters[i]!.ratioPct)])) })), `Starting at ${p2((s.start.capital / s.start.assets) * 100)}; the minimum is ${minimum}%. DI’s illustrative scenarios, not the Federal Reserve’s.`),
    summaryByScenario: t('Stress test: what each scenario does', 'stress.scenarios', [text('scenario', 'Scenario'), text('losses', 'Loan losses, 9 quarters'), text('ppnr', 'Pre-provision earnings'), text('provisions', 'Provisions'), text('net', 'Net income'), text('low', 'Lowest ratio'), text('cushion', 'Above the minimum')], s.runs.map((r) => ({ scenario: r.scenario.name, losses: `${m(r.losses)} (${p1(r.lossPct)})`, ppnr: m(r.ppnr), provisions: m(r.provisions), net: m(r.netIncome), low: `${p2(r.trough.ratioPct)}, ${r.trough.quarter}`, cushion: `${r.cushionPct >= 0 ? '' : '−'}${Math.abs(r.cushionPct).toFixed(2)} pts` }))),
    losses: t('Stress test: severely adverse losses by loan type', 'stress.losses', [text('category', 'Loan type'), { field: 'balance', headerName: 'Balance today', type: 'currency' }, text('rate', 'Loss rate, 9 quarters'), { field: 'losses', headerName: 'Losses', type: 'currency' }], s.runs.find((r) => r.scenario.key === 'severe')!.byCategory.map((c) => ({ category: c.category, balance: c.balance, rate: p1(c.lossPct), losses: c.losses }))),
    cre: t(`${s.cre.category === 'Business' ? 'Business loans' : 'Commercial real estate'}: if property values fall`, 'stress.cre', [text('decline', 'Values fall'), text('under', 'Loans owing more than the property nets'), { field: 'losses', headerName: 'Expected losses', type: 'currency' }, text('ratio', `${s.start.ratioName} after`)], s.cre.lines.map((l) => ({ decline: `${l.declinePct}%`, under: `${p1(l.underwaterPct)} of ${m(s.cre.balance)}`, losses: l.losses, ratio: p2(l.ratioPct) })), `${s.cre.loans.toLocaleString('en-US')} loans at an average loan-to-value of ${p1(s.cre.averageLtvPct)}. Selling costs 10%.`),
    assumptions: t('Stress test assumptions', 'stress.assumptions', [text('item', 'Assumption'), text('detail', 'Detail')], s.assumptions.map(([item, detail]) => ({ item, detail }))),
  };
};

/** The CAMELS view and stress test as report sections, for the board report and the ALCO pack. */
export function camelsAnalyses(deps: CamelsDeps): ReportAnalyses {
  const runs = new Map<string, ReturnType<typeof camelsView>>();
  const once = (runId: string) => {
    if (!runs.has(runId)) {
      runs.set(runId, camelsView(deps));
      if (runs.size > 8) runs.delete(runs.keys().next().value!);
    }
    return runs.get(runId)!;
  };
  return {
    keys: [...CAMELS_SECTIONS],
    async run(key, runId): Promise<{ block: Block; take?: DiTake }> {
      const v = await once(runId);
      const who = { agent: 'CAMELS and stress test', sources: [{ kind: 'table' as const, label: v.bank ? 'FFIEC 051, loans and the balance sheet' : '5300, loans and the balance sheet', ref: 'table:cr_value' }] };
      const b = blocksFor(who, runId, v);
      const severe = v.stress.runs.find((r) => r.scenario.key === 'severe')!;
      switch (key) {
        case 'camels.summary':
          return { block: b.summary, take: { headline: v.headline, action: { label: 'What needs attention?', ask: 'Which CAMELS measures need attention?' } } };
        case 'camels.measures':
          return { block: b.measures };
        case 'stress.capital':
          return { block: b.capital, take: { headline: `In a severe downturn the ${ratioLower(v.stress.start.ratioName)} falls to ${p2(severe.trough.ratioPct)} in ${severe.trough.quarter}, ${severe.cushionPct >= 0 ? `${severe.cushionPct.toFixed(2)} points above` : `${Math.abs(severe.cushionPct).toFixed(2)} points below`} the ${v.stress.start.minimumPct}% minimum. Losses would have to be ${v.stress.reverse.multiple.toFixed(2)} times severe to reach it.`, action: { label: 'What drives it?', ask: 'What drives our stress test losses?' } } };
        case 'stress.losses':
          return { block: b.losses };
        default:
          return { block: b.cre };
      }
    },
  };
}

const COMPONENTS: Record<string, Component['letter']> = { capital: 'C', asset: 'A', quality: 'A', credit: 'A', management: 'M', earnings: 'E', profit: 'E', liquidity: 'L', sensitivity: 'S', rate: 'S', interest: 'S' };

export function camelsModule(deps: CamelsDeps): ModuleSpec {
  const noAccess = 'The CAMELS view and stress test are for finance and executives.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('camels')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const spec: ModuleSpec = {
    id: 'camels',
    prefix: 'cam',
    agent: 'CAMELS and stress test',
    // A liquidity stress test ("can we survive a 20% run?") belongs to the Liquidity agent.
    request: /^(?![\s\S]*\bliquidity\b)[\s\S]*?(?:\bcamels\b|\bstress[- ]?test\w*\b|\bdfast\b|\bccar\b|\bseverely adverse\b|\bsevere (?:recession|downturn)\b|\b(?:adverse|recession|downturn) scenario\b|\breverse stress\b|\bexam(?:iner|ination)?s? (?:ready|readiness)\b|\bclassified (?:assets|loans)\b|\b(?:cre|commercial (?:real estate|property)) values? (?:fall|drop|decline)|\bcapital\b[^.?!]*\b(?:recession|downturn|hold up)\b|\bbefore we breach\b)/i,
    noAccess,
    sources: [
      { kind: 'table', label: 'Call Report values', ref: 'table:cr_value' },
      { kind: 'table', label: 'Loans', ref: 'table:cdm_loan' },
    ],
    prompt: ({ tenant, user, title }) => `You are the CAMELS and stress test agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) prepares the board and examiners.

- "Show our CAMELS view", "how do we look for the exam?": cam_view. "Which CAMELS measures need attention?": cam_view with watch_only true. "How is our asset quality?": cam_component with component "asset quality".
- "Run the stress test", "what happens to capital in a severe recession?": cam_stress. A scenario: scenario baseline, adverse or severe.
- "How much could we lose before we breach?": cam_reverse. "What if commercial property values fall 30%?": cam_cre with decline.
- "What does the stress test assume?": cam_assumptions.
- Never produce or guess a CAMELS rating: examiners assign them and they are confidential. DFAST and CCAR apply to much larger institutions; this is a community stress test with DI's illustrative scenarios.`,
    plan: (t) => {
      if (/\bassum/i.test(t)) return { tool: 'cam_assumptions', args: {} };
      if (/\breverse\b|\bbefore we (?:breach|fall below|hit)\b|\bhow much (?:could|can) we lose\b|\bbreak(?:ing)? point\b/i.test(t)) return { tool: 'cam_reverse', args: {} };
      const fall = /\b(?:cre|commercial (?:real estate|property)|property) values? (?:fall|drop|decline)\w*(?: by)? (\d{1,2})\s*%/i.exec(t) ?? /\b(\d{1,2})\s*% (?:fall|drop|decline) in (?:cre|commercial)/i.exec(t);
      if (fall || /\b(?:cre|commercial (?:real estate|property)) values?\b/i.test(t)) return { tool: 'cam_cre', args: fall ? { decline: Number(fall[1]) } : {} };
      if (/\bstress|dfast|ccar|severe|adverse|recession|downturn|baseline\b/i.test(t)) {
        const scenario = /\bseverely adverse\b|\bsevere\b|\bdeep\b/i.test(t) ? 'severe' : /\badverse\b|\bmoderate\b/i.test(t) ? 'adverse' : /\bbaseline\b/i.test(t) ? 'baseline' : undefined;
        return { tool: 'cam_stress', args: scenario ? { scenario } : {} };
      }
      if (/\b(?:need|needs) attention\b|\bwatch\b|\bconcern/i.test(t)) return { tool: 'cam_view', args: { watch_only: true } };
      const comp = Object.keys(COMPONENTS).find((k) => new RegExp(`\\b${k}`, 'i').test(t));
      if (comp && !/\bcamels (?:view|measures?|pack)\b/i.test(t)) return { tool: 'cam_component', args: { component: comp } };
      return { tool: 'cam_view', args: {} };
    },
    tools: [
      {
        name: 'cam_view',
        description: 'Each CAMELS component (capital, asset quality, management, earnings, liquidity, sensitivity) with its measures and DI’s read of each. Not a rating. watch_only for the measures that need attention.',
        input: z.object({ watch_only: z.boolean().optional() }).strict(),
        run: async (a: { watch_only?: boolean }, ctx): Promise<ModuleView> => {
          need(ctx);
          const v = await camelsView(deps);
          const b = blocksFor(spec, ctx.runId, v);
          if (a.watch_only) {
            if (!v.watch.length) return { text: `No CAMELS measure needs attention. ${v.headline}`, blocks: [b.summary], suggestions: ['Run the stress test'] };
            return {
              text: `${v.headline} ${v.watch.slice(0, 6).map((w) => `**${w.component}**, ${lower(w.label)}: ${w.value} (${w.against}). ${w.why}`).join(' ')}${v.watch.length > 6 ? ` And ${v.watch.length - 6} more in the table.` : ''} ${NOTE}`,
              blocks: [moduleTable(spec, 'Measures that need attention', ctx.runId, 'camels.watch', [text('component', 'Component'), text('measure', 'Measure'), text('value', 'Now'), text('against', 'Against'), text('read', 'DI’s read'), text('why', 'Why')], v.watch.map((w) => ({ component: w.component, measure: w.label, value: w.value, against: w.against, read: w.read, why: w.why })))],
              suggestions: ['Run the stress test', 'How much could we lose before we breach the minimum?'],
            };
          }
          return {
            text: `${v.headline} ${NOTE}`,
            blocks: [b.summary, b.measures],
            suggestions: ['Which CAMELS measures need attention?', 'Run the stress test', 'How is our asset quality?'],
          };
        },
      },
      {
        name: 'cam_component',
        description: 'One CAMELS component’s measures in detail: capital, asset quality, management, earnings, liquidity or sensitivity.',
        input: z.object({ component: z.string().min(3).max(40) }).strict(),
        run: async (a: { component: string }, ctx): Promise<ModuleView> => {
          need(ctx);
          const letter = COMPONENTS[Object.keys(COMPONENTS).find((k) => a.component.toLowerCase().includes(k)) ?? ''] ?? null;
          if (!letter) throw new CoreError('INVALID', 'Which component: capital, asset quality, management, earnings, liquidity or sensitivity?');
          const v = await camelsView(deps);
          const c = v.components.find((x) => x.letter === letter)!;
          return {
            text: `**${c.name}: ${c.read}** in DI’s read. ${c.measures.map((x) => `${x.label}: ${x.value} (${x.against}). ${x.why}`).join(' ')}${letter === 'M' ? ' Management is judged by examiners on governance and risk management; these are the measures DI can show.' : ''}`,
            blocks: [moduleTable(spec, `${c.letter}: ${c.name}`, ctx.runId, 'camels.component', [text('measure', 'Measure'), text('value', 'Now'), text('against', 'Against'), text('read', 'DI’s read'), text('why', 'Why')], c.measures.map((x) => ({ measure: x.label, value: x.value, against: x.against, read: x.read, why: x.why })))],
            suggestions: letter === 'C' ? ['Run the stress test'] : ['Show our CAMELS view'],
          };
        },
      },
      {
        name: 'cam_stress',
        description: 'The stress test over nine quarters: loan losses, pre-provision earnings, provisions, net income and the capital ratio under baseline, adverse and severely adverse scenarios. scenario for one in detail.',
        input: z.object({ scenario: z.enum(['baseline', 'adverse', 'severe']).optional() }).strict(),
        run: async (a: { scenario?: ScenarioKey }, ctx): Promise<ModuleView> => {
          need(ctx);
          const v = await camelsView(deps);
          const s = v.stress;
          const b = blocksFor(spec, ctx.runId, v);
          const name = ratioLower(s.start.ratioName);
          if (a.scenario) {
            const r = s.runs.find((x) => x.scenario.key === a.scenario)!;
            return {
              text: `**${r.scenario.name}.** ${r.scenario.story} Loan losses over nine quarters are ${m(r.losses)}, ${p1(r.lossPct)} of loans; pre-provision earnings are ${m(r.ppnr)} against ${m(r.provisions)} of provisions, so net income is ${m(r.netIncome)}. The ${name} goes from ${p2(r.startPct)} to a low of **${p2(r.trough.ratioPct)}** in ${r.trough.quarter}, ${r.cushionPct >= 0 ? `${r.cushionPct.toFixed(2)} points above` : `${Math.abs(r.cushionPct).toFixed(2)} points below`} the ${s.start.minimumPct}% minimum, and ends at ${p2(r.endPct)}.`,
              blocks: [moduleTable(spec, `${r.scenario.name}, quarter by quarter`, ctx.runId, 'stress.quarters', [text('quarter', 'Quarter'), { field: 'ppnr', headerName: 'Pre-provision earnings', type: 'currency' }, { field: 'chargeOffs', headerName: 'Charge-offs', type: 'currency' }, { field: 'provision', headerName: 'Provision', type: 'currency' }, { field: 'net', headerName: 'Net income', type: 'currency' }, { field: 'capital', headerName: 'Capital', type: 'currency' }, text('ratio', s.start.ratioName)], r.quarters.map((q) => ({ quarter: q.quarter, ppnr: Math.round(q.ppnr), chargeOffs: Math.round(q.chargeOffs), provision: Math.round(q.provision), net: Math.round(q.netIncome), capital: Math.round(q.capital), ratio: p2(q.ratioPct) }))), ...(a.scenario === 'severe' ? [b.losses] : [])],
              suggestions: a.scenario === 'severe' ? ['How much could we lose before we breach the minimum?', 'What if commercial property values fall 30%?'] : ['What happens in the severely adverse scenario?'],
            };
          }
          const severe = s.runs.find((x) => x.scenario.key === 'severe')!;
          const top = severe.byCategory[0]!;
          return {
            text: `Over nine quarters, the ${name} starts at ${p2(severe.startPct)}. In the **severely adverse** scenario it falls to **${p2(severe.trough.ratioPct)}** in ${severe.trough.quarter}, ${severe.cushionPct >= 0 ? `${severe.cushionPct.toFixed(2)} points above` : `${Math.abs(severe.cushionPct).toFixed(2)} points below`} the ${s.start.minimumPct}% minimum: loan losses of ${m(severe.losses)} (${p1(severe.lossPct)} of loans), led by ${top.category.toLowerCase()} at ${m(top.losses)}. ${s.runs.filter((x) => x.scenario.key !== 'severe').map((x) => `${x.scenario.name}: low of ${p2(x.trough.ratioPct)}`).join('; ')}. Losses would have to be ${s.reverse.multiple.toFixed(2)} times severe to reach the minimum. These are DI’s illustrative scenarios, not the Federal Reserve’s; DFAST and CCAR apply to much larger institutions.`,
            blocks: [b.summaryByScenario, b.capital],
            suggestions: ['What happens in the severely adverse scenario?', 'What if commercial property values fall 30%?', 'What does the stress test assume?'],
          };
        },
      },
      {
        name: 'cam_reverse',
        description: 'The reverse stress test: how much worse than severely adverse loan losses would have to be for the capital ratio to reach its minimum.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          need(ctx);
          const s = (await camelsView(deps)).stress;
          return {
            text: `The ${ratioLower(s.start.ratioName)} would reach the **${s.start.minimumPct}% minimum** if loan losses over nine quarters were **${m(s.reverse.losses)}**, ${p1(s.reverse.lossPct)} of today’s loans: ${s.reverse.multiple.toFixed(2)} times the severely adverse scenario’s, with its low in ${s.reverse.quarter}. Earnings and the allowance are as in the severely adverse scenario.`,
            suggestions: ['Run the stress test', 'What if commercial property values fall 40%?'],
          };
        },
      },
      {
        name: 'cam_cre',
        description: 'What a fall in commercial property values would cost: loans owing more than the property would net, expected losses and the capital ratio after. decline in percent; all of 10–40% when not given.',
        input: z.object({ decline: z.number().int().min(5).max(60).optional() }).strict(),
        run: async (a: { decline?: number }, ctx): Promise<ModuleView> => {
          need(ctx);
          const v = await camelsView(deps);
          const s = v.stress;
          const b = blocksFor(spec, ctx.runId, v);
          const what = s.cre.category === 'Business' ? 'business loans' : 'commercial real estate loans';
          const pick = s.cre.lines.reduce((best, l) => (Math.abs(l.declinePct - (a.decline ?? 30)) < Math.abs(best.declinePct - (a.decline ?? 30)) ? l : best), s.cre.lines[0]!);
          return {
            text: `If commercial property values fell **${pick.declinePct}%**, ${p1(pick.underwaterPct)} of the ${m(s.cre.balance)} of ${what} would owe more than the property would sell for after costs. Expected losses would be about **${m(pick.losses)}**, taking the ${ratioLower(s.start.ratioName)} to ${p2(pick.ratioPct)} (minimum ${s.start.minimumPct}%). The average loan-to-value today is ${p1(s.cre.averageLtvPct)}.${a.decline && a.decline !== pick.declinePct ? ` DI shows falls of 10% to 40%; ${pick.declinePct}% is the closest.` : ''}`,
            blocks: [b.cre],
            suggestions: ['Run the stress test', 'How much could we lose before we breach the minimum?'],
          };
        },
      },
      {
        name: 'cam_assumptions',
        description: 'The stress test’s assumptions: scenarios, loss rates, the allowance, earnings, balance sheet, tax and dividends, and the minimum.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          need(ctx);
          const v = await camelsView(deps);
          const b = blocksFor(spec, ctx.runId, v);
          return { text: 'The stress test uses DI’s illustrative assumptions, shown below. Each can be replaced with the institution’s own, or the scenarios with the Federal Reserve’s published ones.', blocks: [b.assumptions, moduleTable(spec, 'Scenarios', ctx.runId, 'stress.scenario.list', [text('name', 'Scenario'), text('story', 'Story'), text('rates', 'Short rates'), text('cre', 'Commercial property'), text('homes', 'House prices')], v.stress.runs.map((r) => ({ name: r.scenario.name, story: r.scenario.story, rates: `${r.scenario.rateMoveBp} bp`, cre: `${r.scenario.crePricePct}%`, homes: `${r.scenario.housePricePct > 0 ? '+' : ''}${r.scenario.housePricePct}%` })))] };
        },
      },
    ],
  };
  return spec;
}

