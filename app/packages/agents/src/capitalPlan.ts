// Capital plan (banks): how much the bank can return in dividends and buybacks over the next year without
// falling below the floor the board sets (the internal target, or the regulatory minimum plus the stress
// test's decline, whichever is higher), what a buyback does per share, and the CFO's targets, each change
// approved. As answers and as the Capital plan report's sections.
import type { Block, DiTake } from '@dinext/block-schemas';
import { z } from 'zod';
import { CoreError, type CapitalPlanService, type CapitalPlanSettings } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

export const CAPITAL_PLAN_REQUEST = /\bcapital plan\w*\b|\bbuy ?backs?\b|\bshare repurchases?\b|\brepurchas\w*\b[^.?!]*\b(?:shares?|stock)\b|\breturn (?:capital|cash|money) to shareholders\b|\bdividend (?:capacity|policy|increase|cut|limit)\b|\braise (?:the|our) dividend\b|\bspecial dividend\b|\bexcess capital\b|\bcapital return\b|\bpayout capacity\b|\bstress (?:capital )?buffer\b|\binternal (?:cet1|capital|leverage) target\b|\bcet1 target\b|\bleverage (?:ratio )?target\b|\bhow much (?:capital )?can we (?:return|pay out|distribute)\b|\bdividends? without (?:regulatory )?approval\b|\bcapital floors?\b|\b(?:dividend|buyback) capacity\b/i;
export type CapitalPlanQuestion = 'overview' | 'capacity' | 'buyback' | 'dividends' | 'stress' | 'method';
export function capitalPlanQuestion(text: string): CapitalPlanQuestion {
  const t = text.toLowerCase();
  if (/how (?:is|are|do you) .*(?:calculat|measur|work)|assum|\bmethod/.test(t)) return 'method';
  if (/dividend/.test(t) && /buy ?back|repurchas/.test(t)) return 'overview';
  if (/buy ?back|repurchas/.test(t) && !/dividend/.test(t)) return 'buyback';
  if (/dividend/.test(t) && !/buy ?back|repurchas/.test(t)) return 'dividends';
  if (/stress|buffer|floor|target/.test(t) && !/how much|capacity|return/.test(t)) return 'stress';
  if (/how much|capacity|excess|room/.test(t)) return 'capacity';
  return 'overview';
}

/** "$10M", "10 million", "$7,500,000", "$2.5 million": dollars. */
export function amountFrom(text: string): number | null {
  const m = /\$\s*([\d,]+(?:\.\d+)?)\s*(m\b|mm\b|million\b|k\b|thousand\b)?|([\d,]+(?:\.\d+)?)\s*(m\b|mm\b|million\b)/i.exec(text);
  if (!m) return null;
  const v = Number((m[1] ?? m[3])!.replace(/,/g, ''));
  const unit = (m[2] ?? m[4] ?? '').toLowerCase();
  return unit.startsWith('m') ? v * 1e6 : unit.startsWith('k') || unit.startsWith('t') ? v * 1e3 : v;
}

/** Targets and plans from "Set our CET1 target to 10.5%", "Plan a $5M buyback", "Raise the dividend to $0.25 a quarter". */
export function parseCapitalPlan(text: string): Partial<Record<'cet1_target' | 'leverage_target' | 'rwa_growth' | 'asset_growth' | 'dividend_per_share_q' | 'buyback_planned', number>> | null {
  if (!/\b(?:set|change|make|update|raise|lower|cut|plan|authori[sz]e|increase|decrease)\b/i.test(text)) return null;
  const out: Record<string, number> = {};
  const pct = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const cet1 = pct(/cet1 target[^\d]{0,12}(\d{1,2}(?:\.\d+)?)\s*%/i);
  const lev = pct(/leverage (?:ratio )?target[^\d]{0,12}(\d{1,2}(?:\.\d+)?)\s*%/i);
  const div = /dividend[^$]{0,30}\$\s*(\d+(?:\.\d+)?)/i.exec(text);
  const bb = /buy ?back|repurchas/i.test(text) && /\b(?:plan|authori[sz]e|set)\b/i.test(text) ? amountFrom(text) : null;
  if (cet1 !== undefined) out.cet1_target = cet1;
  if (lev !== undefined) out.leverage_target = lev;
  if (div) out.dividend_per_share_q = Number(div[1]);
  if (bb !== null) out.buyback_planned = bb;
  return Object.keys(out).length ? out : null;
}

const NO_ACCESS = 'The capital plan isn’t part of your DI access. It is for a bank’s finance leaders.';
const AGENT = 'Capital Plan';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const mm = (n: number) => `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(1)}M`;
const p2 = (n: number) => `${n.toFixed(2)}%`;
const p1 = (n: number) => `${n.toFixed(1)}%`;
const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`);
const count = (n: number) => Math.round(n).toLocaleString('en-US');
type Analysis = NonNullable<Awaited<ReturnType<CapitalPlanService['analysis']>>>;
type Who = Pick<ModuleSpec, 'agent' | 'sources'>;
const SOURCES: ModuleSpec['sources'] = [
  { kind: 'table', label: 'FFIEC 051 Call Report values', ref: 'table:cr_value' },
  { kind: 'table', label: 'Capital plan, as the CFO set it', ref: 'table:fin_capital_plan' },
];

function tables(who: Who, runId: string, a: Analysis) {
  const t = (title: string, op: string, cols: ReturnType<typeof text>[], rows: Record<string, string>[], subtitle?: string) => ({ ...moduleTable(who, title, runId, op, cols, rows), ...(subtitle ? { subtitle } : {}) }) as Block;
  const c = a.capacity;
  const sizes = [...new Set([5e6, 10e6, Math.round(c.buybackRoom / 1e5) * 1e5].filter((x) => x > 0))].sort((x, y) => x - y);
  return {
    capacity: t('What the bank can return over the next four quarters', 'cap.capacity', [text('item', ''), text('cet1', 'CET1'), text('lev', 'Leverage ratio')], [
      { item: 'Today', cet1: p2(a.now.cet1Pct), lev: p2(a.now.levPct) },
      { item: 'Board’s internal target', cet1: p2(a.settings.cet1Target), lev: p2(a.settings.leverageTarget) },
      { item: 'Severe stress decline (the stress buffer)', cet1: `−${p2(a.stress.cet1Stress)}`, lev: `−${p2(a.stress.levStress)}` },
      { item: 'Floor: higher of the target and minimum plus buffer', cet1: p2(a.floors.cet1), lev: p2(a.floors.leverage) },
      { item: 'Capital above the floor today', cet1: mm(c.excessNowCet1), lev: mm(c.excessNowLev) },
      { item: 'Capacity over the next four quarters', cet1: mm(c.cet1), lev: mm(c.leverage) },
      { item: 'Binding', cet1: c.binding === 'cet1' ? 'Yes' : '', lev: c.binding === 'leverage' ? 'Yes' : '' },
    ], `Earnings of ${mm(a.year.ni)} a year; risk-weighted assets up ${a.settings.rwaGrowth}% and assets up ${a.settings.assetGrowth}% at plan.${a.cblr ? ' In the CBLR framework, the leverage ratio is the one that counts.' : ''}`),
    ahead: t('Ratios a year ahead', 'cap.ahead', [text('case', 'Payout over the year'), text('amount', 'Amount'), text('cet1', 'CET1'), text('lev', 'Leverage'), text('cet1s', 'CET1 after severe stress'), text('levs', 'Leverage after severe stress')], [
      { case: 'Nothing paid out', amount: mm(0), cet1: p2(a.noPayout.cet1Pct), lev: p2(a.noPayout.levPct), cet1s: p2(a.noPayout.cet1Stressed), levs: p2(a.noPayout.levStressed) },
      { case: `Dividends at $${a.settings.dividendPerShareQ.toFixed(2)} a quarter${a.settings.buybackPlanned ? ` and the planned ${mm(a.settings.buybackPlanned)} buyback` : ''}`, amount: mm(a.plan.payout), cet1: p2(a.plan.cet1Pct), lev: p2(a.plan.levPct), cet1s: p2(a.plan.cet1Stressed), levs: p2(a.plan.levStressed) },
      { case: 'Everything up to the floor', amount: mm(a.atCapacity.payout), cet1: p2(a.atCapacity.cet1Pct), lev: p2(a.atCapacity.levPct), cet1s: p2(a.atCapacity.cet1Stressed), levs: p2(a.atCapacity.levStressed) },
    ]),
    buybacks: t('Buybacks at today’s price', 'cap.buyback', [text('amount', 'Buyback'), text('shares', 'Shares retired'), text('eps', 'EPS'), text('tbv', 'Tangible book value a share'), text('earnback', 'Earn-back'), text('lev', 'Leverage a year ahead'), text('ok', 'Within the floor')], sizes.map((x) => a.buyback(x)).filter((b): b is NonNullable<ReturnType<Analysis['buyback']>> => b !== null).map((b) => ({ amount: mm(b.amount), shares: `${count(b.retired)} (${p1(b.pctOfShares)})`, eps: `${usd(b.epsAfter)} (+${p1(b.accretionPct)})`, tbv: `${usd(b.tbvAfter)} (−${p1(b.dilutionPct)})`, earnback: b.earnbackYears === null ? '—' : `${b.earnbackYears.toFixed(1)} years`, lev: p2(b.levPct), ok: b.levOk && b.cet1Ok ? 'Yes' : 'No' })), a.perShare ? `At $${a.perShare.price?.toFixed(2)}, ${a.perShare.ptbv?.toFixed(2)}× tangible book, with dividends at the current rate alongside.` : undefined),
    dividends: t('Dividends without regulatory approval', 'cap.dividends', [text('item', ''), text('amount', 'Amount')], [
      { item: `Net income, ${a.dividendRule.year} to date`, amount: mm(a.dividendRule.ytdNi) },
      ...a.dividendRule.retainedPrior.map((r) => ({ item: `Retained net income, ${r.year}`, amount: Number.isFinite(r.retained) ? mm(r.retained) : 'Not on file' })),
      { item: 'Limit without approval', amount: mm(a.dividendRule.limit) },
      { item: `Declared in ${a.dividendRule.year}`, amount: mm(a.dividendRule.declaredYtd) },
      { item: 'Room left this year', amount: mm(a.dividendRule.room) },
    ], `12 CFR 5.64 for national banks; Regulation H 208.5 for state member banks.${a.dividendRule.missingYears.length ? ` ${a.dividendRule.missingYears.join(', ')} isn’t on file, so the limit shown is lower than the real one.` : ''}`),
    settings: t('The capital plan’s targets', 'cap.settings', [text('item', 'Setting'), text('value', 'Value'), text('note', 'Why')], [
      { item: 'Internal CET1 target', value: p2(a.settings.cet1Target), note: a.settings.notes.cet1_target ?? '' },
      { item: 'Internal leverage ratio target', value: p2(a.settings.leverageTarget), note: a.settings.notes.leverage_target ?? '' },
      { item: 'Risk-weighted asset growth', value: p1(a.settings.rwaGrowth), note: a.settings.notes.rwa_growth ?? '' },
      { item: 'Total asset growth', value: p1(a.settings.assetGrowth), note: a.settings.notes.asset_growth ?? '' },
      { item: 'Dividend a share, quarterly', value: usd(a.settings.dividendPerShareQ), note: a.settings.notes.dividend_per_share_q ?? '' },
      { item: 'Buyback planned', value: mm(a.settings.buybackPlanned), note: a.settings.notes.buyback_planned ?? '' },
    ]),
  };
}

function headline(a: Analysis) {
  const c = a.capacity;
  const room = a.buyback(c.buybackRoom);
  const which = c.binding === 'leverage' ? 'leverage ratio' : 'CET1 ratio';
  const floor = c.binding === 'leverage' ? a.floors.leverage : a.floors.cet1;
  const fromTarget = c.binding === 'leverage' ? a.floors.levFromTarget : a.floors.cet1FromTarget;
  return [
    `Over the next four quarters the bank can return about **${mm(c.total)}** without its ${which} falling below **${p2(floor)}**: ${fromTarget ? 'the board’s internal target' : `the ${c.binding === 'leverage' ? (a.cblr ? 'CBLR’s 8%' : '4% minimum') : '7% (minimum plus conservation buffer)'} plus the ${p2(c.binding === 'leverage' ? a.stress.levStress : a.stress.cet1Stress)} a severe recession would take off it, which is above the board’s ${p2(c.binding === 'leverage' ? a.settings.leverageTarget : a.settings.cet1Target)} target`}.`,
    `The ${which} binds${a.cblr && c.binding === 'leverage' ? ' because the bank is in the CBLR framework' : ''}; CET1 alone would allow ${mm(c.cet1)}.`,
    `Dividends at $${a.settings.dividendPerShareQ.toFixed(2)} a quarter take **${mm(c.dividends)}** (${p1(c.payoutPct ?? 0)} of earnings), leaving **${mm(c.buybackRoom)}** for buybacks${room ? `: about ${count(room.retired)} shares (${p1(room.pctOfShares)}) at $${a.perShare?.price?.toFixed(2)}, lifting EPS ${p1(room.accretionPct)} and taking ${p1(room.dilutionPct)} off tangible book value a share, earned back in ${room.earnbackYears?.toFixed(1)} years` : ''}.`,
  ].join(' ');
}

export const CAPITAL_PLAN_SECTIONS = ['cap.capacity', 'cap.ahead', 'cap.buyback', 'cap.dividends', 'cap.settings', 'cap.assumptions'] as const;

export function capitalPlanAnalyses(svc: CapitalPlanService): ReportAnalyses {
  const runs = new Map<string, ReturnType<CapitalPlanService['analysis']>>();
  const once = (runId: string) => {
    if (!runs.has(runId)) {
      runs.set(runId, svc.analysis());
      if (runs.size > 8) runs.delete(runs.keys().next().value!);
    }
    return runs.get(runId)!;
  };
  const who = { agent: AGENT, sources: SOURCES };
  return {
    keys: [...CAPITAL_PLAN_SECTIONS],
    async run(key, runId): Promise<{ block: Block; take?: DiTake }> {
      const a = await once(runId);
      if (!a) throw new CoreError('NOT_FOUND', 'The capital plan is built from a bank’s FFIEC Call Report, and none is on file yet.');
      const b = tables(who, runId, a);
      switch (key) {
        case 'cap.capacity':
          return { block: b.capacity, take: { headline: `About ${mm(a.capacity.total)} can be returned over four quarters, held by the ${a.capacity.binding === 'leverage' ? 'leverage ratio' : 'CET1 ratio'} at ${p2(a.capacity.binding === 'leverage' ? a.floors.leverage : a.floors.cet1)}; after dividends of ${mm(a.capacity.dividends)}, ${mm(a.capacity.buybackRoom)} is left for buybacks.`, action: { label: 'What would a $10M buyback do?', ask: 'What would a $10M buyback do?' } } };
        case 'cap.ahead':
          return { block: b.ahead };
        case 'cap.buyback':
          return { block: b.buybacks };
        case 'cap.dividends':
          return { block: b.dividends };
        case 'cap.settings':
          return { block: b.settings };
        default:
          return { block: moduleTable(who, 'How DI works out capital capacity', runId, 'cap.assumptions', [text('item', 'Assumption'), text('detail', 'What DI uses')], svc.assumptions().map(([item, detail]) => ({ item, detail }))) };
      }
    },
  };
}

type SettingArgs = { cet1_target?: number; leverage_target?: number; rwa_growth?: number; asset_growth?: number; dividend_per_share_q?: number; buyback_planned?: number };
const toSettings = (a: SettingArgs): Partial<Omit<CapitalPlanSettings, 'notes' | 'by'>> => ({
  ...(a.cet1_target !== undefined ? { cet1Target: a.cet1_target } : {}),
  ...(a.leverage_target !== undefined ? { leverageTarget: a.leverage_target } : {}),
  ...(a.rwa_growth !== undefined ? { rwaGrowth: a.rwa_growth } : {}),
  ...(a.asset_growth !== undefined ? { assetGrowth: a.asset_growth } : {}),
  ...(a.dividend_per_share_q !== undefined ? { dividendPerShareQ: a.dividend_per_share_q } : {}),
  ...(a.buyback_planned !== undefined ? { buybackPlanned: a.buyback_planned } : {}),
});

export function capitalPlanModule(svc: CapitalPlanService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('capplan')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: 'capplan',
    prefix: 'cap',
    agent: AGENT,
    request: CAPITAL_PLAN_REQUEST,
    noAccess: NO_ACCESS,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You are the Capital Plan agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) decides how much capital to return to shareholders. The floor for each ratio is the higher of the board's internal target and the regulatory minimum plus the stress test's decline (a stress buffer). DI works out the capacity over the next four quarters, what dividends take, the room left for buybacks, and what a buyback does per share. The board declares dividends and authorizes buybacks; DI doesn't advise on the stock.

- cap_view, with question overview, capacity, buyback, dividends, stress or method.
- cap_buyback with amount: what a buyback of that size does (a what-if; nothing is saved).
- cap_set: change the internal targets, the growth plan, the quarterly dividend or the planned buyback. It needs approval.`,
    plan: (t) => {
      const set = parseCapitalPlan(t);
      if (set) return { tool: 'cap_set', args: set };
      const amount = amountFrom(t);
      if (amount !== null && /buy ?back|repurchas/i.test(t)) return { tool: 'cap_buyback', args: { amount } };
      return { tool: 'cap_view', args: { question: capitalPlanQuestion(t) } };
    },
    tools: [
      {
        name: 'cap_view',
        description: 'Capital return capacity over the next four quarters against the board’s floors (internal target, or minimum plus the stress decline), what dividends take, the buyback room and what buybacks do per share, the dividend approval limit, and the CFO’s targets.',
        input: z.object({ question: z.enum(['overview', 'capacity', 'buyback', 'dividends', 'stress', 'method']).optional() }).strict(),
        run: async (a0: { question?: CapitalPlanQuestion }, ctx) => {
          need(ctx);
          if (a0.question === 'method') return { text: `How DI works out capital capacity:\n\n${svc.assumptions().map(([k, v]) => `- **${k}:** ${v}`).join('\n')}` };
          const a = await svc.analysis();
          if (!a) throw new CoreError('INVALID', 'The capital plan is built from a bank’s FFIEC Call Report, and none is on file yet.');
          const b = tables(spec, ctx.runId, a);
          const q = a0.question ?? 'overview';
          const r = a.dividendRule;
          const answers: Record<Exclude<CapitalPlanQuestion, 'method'>, [string, Block[]]> = {
            overview: [headline(a), [b.capacity, b.buybacks, b.ahead]],
            capacity: [headline(a), [b.capacity, b.ahead]],
            buyback: [headline(a).split('. ').slice(-1)[0]!.replace(/^Dividends/, `Of the ${mm(a.capacity.total)} the bank can return, dividends`) + ' Buying above tangible book dilutes it a little; the EPS lift earns it back. Most banks buy back at the holding company; a bank buying back its own stock needs its regulator’s approval.', [b.buybacks, b.capacity]],
            dividends: [`Dividends at $${a.settings.dividendPerShareQ.toFixed(2)} a quarter come to **${mm(a.capacity.dividends)}** a year, ${p1(a.capacity.payoutPct ?? 0)} of earnings, well inside the ${mm(a.capacity.total)} the capital floors allow. Without regulatory approval the bank can declare up to ${mm(r.limit)} this year (this year’s net income plus the last two years’ retained); ${mm(r.declaredYtd)} has been declared, leaving ${mm(r.room)}.${r.missingYears.length ? ` ${r.missingYears.join(', ')}’s retained income isn’t on file, so the real limit is higher.` : ''}`, [b.dividends, b.capacity]],
            stress: [`The floor for each ratio is the higher of the board’s target and the regulatory minimum plus what a severe recession takes off it. CET1: target ${p2(a.settings.cet1Target)}, or 7% plus a ${p2(a.stress.cet1Stress)} decline, so **${p2(a.floors.cet1)}**. Leverage: target ${p2(a.settings.leverageTarget)}, or ${a.cblr ? 'the CBLR’s 8%' : '4%'} plus a ${p2(a.stress.levStress)} decline, so **${p2(a.floors.leverage)}**. Today CET1 is ${p2(a.now.cet1Pct)} and leverage ${p2(a.now.levPct)}; in the severe scenario they’d bottom at ${p2(a.stress.cet1Low)} (${a.stress.quarterCet1}) and ${p2(a.stress.levLow)} (${a.stress.quarterLev}).`, [b.capacity, b.settings]],
          };
          const [reply, blocks] = answers[q];
          return { text: reply, blocks, sources: SOURCES, suggestions: ['What would a $10M buyback do?', 'How much can we pay in dividends without approval?', 'What sets our capital floor?', 'Set our CET1 target to 10.5%'].filter((s) => capitalPlanQuestion(s) !== q).slice(0, 3) };
        },
      },
      {
        name: 'cap_buyback',
        description: 'What a buyback of a given size does: shares retired, EPS accretion, tangible book value dilution and earn-back, the ratios a year ahead and after severe stress, and whether it stays within the floors. A what-if; nothing is saved.',
        input: z.object({ amount: z.number().positive().max(1e9) }).strict(),
        run: async (a0: { amount: number }, ctx) => {
          need(ctx);
          const a = await svc.analysis();
          if (!a) throw new CoreError('INVALID', 'The capital plan is built from a bank’s FFIEC Call Report, and none is on file yet.');
          const x = a.buyback(a0.amount);
          if (!x) return { text: 'A buyback needs shares outstanding and a share price, which aren’t entered for the latest quarter.' };
          const ok = x.cet1Ok && x.levOk;
          const b = tables(spec, ctx.runId, a);
          return {
            text: `A **${mm(a0.amount)}** buyback at $${a.perShare!.price!.toFixed(2)} would retire about **${count(x.retired)} shares** (${p1(x.pctOfShares)}). EPS would rise to ${usd(x.epsAfter)} (+${p1(x.accretionPct)}) after the cash’s lost interest, and tangible book value a share would fall to ${usd(x.tbvAfter)} (−${p1(x.dilutionPct)}), earned back in ${x.earnbackYears?.toFixed(1) ?? '—'} years. With dividends at the current rate, a year from now the leverage ratio would be **${p2(x.levPct)}** against a ${p2(a.floors.leverage)} floor and CET1 ${p2(x.cet1Pct)} against ${p2(a.floors.cet1)}: ${ok ? '**within the floors**' : '**below a floor**'}${ok ? `, with ${mm(a.capacity.buybackRoom - a0.amount)} of room left` : `; the most it can be is ${mm(a.capacity.buybackRoom)}`}. In a severe recession from there, leverage would bottom near ${p2(x.levStressed)}.`,
            blocks: [b.buybacks, b.capacity],
            sources: SOURCES,
            suggestions: ['Plan a $5M buyback', 'What sets our capital floor?'],
          };
        },
      },
      {
        name: 'cap_set',
        description: 'Change the capital plan: internal CET1 or leverage target (percent), risk-weighted or total asset growth (percent), the quarterly dividend a share, or the planned buyback (dollars). Saving it needs approval.',
        input: z.object({ cet1_target: z.number().min(6.5).max(20).optional(), leverage_target: z.number().min(4).max(15).optional(), rwa_growth: z.number().min(-20).max(40).optional(), asset_growth: z.number().min(-20).max(40).optional(), dividend_per_share_q: z.number().min(0).max(10).optional(), buyback_planned: z.number().min(0).max(1e9).optional() }).strict(),
        run: async (a0: SettingArgs, ctx) => {
          need(ctx);
          const change = toSettings(a0);
          if (!Object.keys(change).length) return { text: 'Tell me what to change, for example “Set our CET1 target to 10.5%” or “Plan a $5M buyback”.' };
          const before = await svc.analysis();
          const after = await svc.analysis(change);
          if (!before || !after) throw new CoreError('INVALID', 'The capital plan is built from a bank’s FFIEC Call Report, and none is on file yet.');
          const labels: [keyof typeof change, string, (n: number) => string][] = [['cet1Target', 'Internal CET1 target', p2], ['leverageTarget', 'Internal leverage target', p2], ['rwaGrowth', 'Risk-weighted asset growth', p1], ['assetGrowth', 'Total asset growth', p1], ['dividendPerShareQ', 'Dividend a share, quarterly', (n) => usd(n)], ['buybackPlanned', 'Buyback planned', mm]];
          return {
            change: {
              summary: 'Change the capital plan',
              changes: [
                ...labels.filter(([k]) => change[k] !== undefined).map(([k, label, f]) => ({ label, before: f(before.settings[k] as number), after: f(change[k] as number) })),
                { label: 'Capacity over four quarters', before: mm(before.capacity.total), after: mm(after.capacity.total) },
                { label: 'Room for buybacks after dividends', before: mm(before.capacity.buybackRoom), after: mm(after.capacity.buybackRoom) },
              ],
              text: `The bank could return ${mm(after.capacity.total)} over the next four quarters (${mm(after.capacity.total) === mm(before.capacity.total) ? 'unchanged: the leverage floor still binds' : `was ${mm(before.capacity.total)}`}), with ${mm(after.capacity.buybackRoom)} left for buybacks after dividends. ${after.plan.levOk && after.plan.cet1Ok ? 'The plan stays within the floors.' : '**The plan would fall below a floor.**'} This changes DI’s plan, not a board decision: the board declares dividends and authorizes buybacks.`,
              done: 'Saved. DI’s capital plan uses the new figures from now on.',
              risk: 'low',
              apply: change,
            },
          };
        },
        apply: async (p: Partial<Omit<CapitalPlanSettings, 'notes' | 'by'>>, meta, ctx) => svc.record(p, { approvalId: meta.approvalId, by: ctx.user.name }),
      },
    ],
  };
  return spec;
}
