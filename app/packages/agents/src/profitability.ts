// Profitability and the allowance by segment, as report sections and as answers. Contribution is by
// funds transfer pricing, before overhead; the allowance reconciles to the latest filed Call Report.
// Read-only, and plain that the FTP curve, loss rates and costs are DI's standard assumptions until the
// institution's own replace them.
import { z } from 'zod';
import type { Block, TableBlock } from '@dinext/block-schemas';
import { CoreError, type FeeIncomeService, type NiiService, type ProfitabilityService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

type Cols = TableBlock['data']['columns'];
const m = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n) >= 1e9 ? `${(Math.abs(n) / 1e9).toFixed(2)}B` : `${(Math.abs(n) / 1e6).toFixed(2)}M`}`;
const p2 = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`;
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const money = (field: string, headerName: string) => ({ field, headerName, type: 'currency' as const });
const NO_ACCESS = 'Profitability isn’t part of your DI access. It is for finance and executives.';
const allowed = (modules: string[]) => modules.includes('profitability') || modules.includes('irr');

// A bank's net interest income in dollars: growth, why, against plan, by quarter, the next 12 months.
// Rate shocks and NII at risk stay with Interest Rate Risk, which routes first.
export const NII_REQUEST = /\bnii\b(?![^.?!]*\bat risk\b)|\bnet interest income\b(?![^.?!]*\bat risk\b)|\binterest income\b[^.?!]*\b(?:grow|grew|growth|growing|up|down|fell|change[ds]?|dollars)\b|\bspread income\b|\b(?:nim|net interest margin|margin)\b[^.?!]*\bdollars\b|\bdollars\b[^.?!]*\b(?:nim|net interest margin|margin)\b/i;
// A bank's noninterest income: how much, from where, share of revenue, and how much doesn't depend on rates.
export const FEE_REQUEST = /\bnon-?interest income\b|\bfee income\b|\bfee revenue\b|\bfees\b[^.?!]*\b(?:earn|make|bring|revenue|income|share|diversif|grow|grew)\w*|\bservice charges\b|\binterchange\b|\bwealth management\b|\btrust (?:income|fees|department|business)\b|\bfiduciary\b|\bbrokerage\b|\bannuit(?:y|ies)\b|\binsurance (?:income|commissions?|agency)\b|\bmortgage banking\b|\bgains? on (?:the )?(?:sales?|loans? sold)\b|\bservicing (?:fees|income)\b|\btrading revenue\b|\bdiversif\w*\b[^.?!]*\b(?:rates|revenue|income)\b|\brevenue (?:that )?(?:doesn[’']?t|does not|don[’']?t) depend\b/i;
export type FeeQuestion = 'overview' | 'mix' | 'share' | 'rates' | 'growth' | 'method';
export function feeQuestion(text: string): FeeQuestion {
  const t = text.toLowerCase();
  if (/calculat|assum|method|worked out/.test(t)) return 'method';
  if (/\brates?\b|diversif|depend|sensitiv/.test(t)) return 'rates';
  if (/share of revenue|\bshare\b|\bplan\b|\bpeers?\b|percent|%|\brel(?:y|iant)\b/.test(t)) return 'share';
  if (/where|come from|sources?|\bmix\b|breakdown|made up|which (?:lines|businesses)|wealth|mortgage banking|trading|insurance|interchange|service charges|trust|brokerage/.test(t)) return 'mix';
  if (/\bgr[eo]w|growth|\bup\b|\bdown\b|change|trend|quarter/.test(t)) return 'growth';
  return 'overview';
}
export type NiiQuestion = 'growth' | 'why' | 'plan' | 'quarter' | 'forward' | 'method';
export function niiQuestion(text: string): NiiQuestion {
  const t = text.toLowerCase();
  if (/calculat|assum|method|worked out|how do you (measure|work)/.test(t)) return 'method';
  if (/\bplan\b|\bpeers?\b|\btarget|\bbudget|\bshort of\b|\bbehind\b/.test(t)) return 'plan';
  if (/next (12|twelve) months|next year|forecast|project|expect|outlook|keep growing|going forward|\bwill\b/.test(t)) return 'forward';
  if (/\bwhy\b|driv|because|volume|\bmix\b|explain|came from|where did|what (moved|changed)/.test(t)) return 'why';
  if (/quarter|linked/.test(t)) return 'quarter';
  return 'growth';
}
const mm = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n) >= 1e9 ? `${(Math.abs(n) / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e5 ? `${(Math.abs(n) / 1e6).toFixed(2)}M` : `${Math.round(Math.abs(n) / 1e3)}K`}`;
const sm = (n: number) => (n > 0 ? `+${mm(n)}` : mm(n));
const p1 = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`;
const bp = (n: number) => `${Math.round(Math.abs(n) * 100)} bp`;
const qLabel = (end: string) => `Q${Math.ceil(Number(end.slice(5, 7)) / 3)} ${end.slice(0, 4)}`;
const period = (months: number, year: string) => (months === 12 ? `the full year ${year}` : months === 9 ? `the first nine months of ${year}` : months === 6 ? `the first half of ${year}` : `the first quarter of ${year}`);

export const PROFIT_SECTIONS = ['profit.products', 'profit.branches', 'profit.allowance'] as const;

function productRows(lines: Awaited<ReturnType<ProfitabilityService['analysis']>>['byProduct']) {
  return lines.map((l) => ({ name: l.name, side: l.side === 'loan' ? 'Loans' : 'Deposits', balance: Math.round(l.balance), spread: m(l.interest + l.ftp), credit: l.credit ? m(l.credit) : '—', costs: m(l.servicing + l.fees), contribution: m(l.contribution), margin: p2(l.marginPct) }));
}
const productCols: Cols = [text('name', 'Product'), text('side', ''), money('balance', 'Balance'), text('spread', 'Spread after FTP'), text('credit', 'Credit cost'), text('costs', 'Servicing less fees'), text('contribution', 'Contribution'), text('margin', 'On balance')];
const branchCols: Cols = [text('name', 'Branch'), money('balance', 'Loans and deposits'), text('contribution', 'Contribution'), text('margin', 'On balance'), text('loans', 'From loans'), text('deposits', 'From deposits')];

export function profitAnalyses(svc: ProfitabilityService): ReportAnalyses {
  return {
    keys: [...PROFIT_SECTIONS],
    async run(key, runId, scope) {
      const who = { agent: 'Profitability', sources: [{ kind: 'table' as const, label: 'Loans and deposits, with DI’s FTP assumptions', ref: 'table:cdm_loan' }] };
      const t = (title: string, op: string, cols: Cols, rows: Record<string, string | number>[], subtitle: string) => ({ ...moduleTable(who, title, runId, op, cols, rows), subtitle }) as Block;
      const branches = scope?.purviewBranches;
      if (key === 'profit.allowance') {
        const a = await svc.allowance(branches);
        const rows = a.lines.slice(0, 14).map((l) => ({ category: l.category, band: l.band, balance: Math.round(l.balance), allowance: Math.round(l.allowance), coverage: p2(l.coveragePct), dq: p2(l.dq60Pct) }));
        return {
          block: t('Allowance by segment', 'profit.allowance', [text('category', 'Loan type'), text('band', 'Credit band'), money('balance', 'Balance'), money('allowance', 'Allowance'), text('coverage', 'Coverage'), text('dq', '60+ delinquent')], rows, `${m(a.allowance)} on ${m(a.balance)} of loans, ${p2(a.coveragePct)}${a.filed !== null && !branches?.length ? `, reconciled to ${a.filedCode} on the ${a.form}` : ''}. Largest pools first.`),
        };
      }
      const a = await svc.analysis(branches);
      if (key === 'profit.products') {
        const best = a.byProduct[0];
        const worst = a.byProduct.at(-1);
        return {
          block: t('Contribution by product', 'profit.products', productCols, productRows(a.byProduct), `${m(a.total)} a year before overhead. ${best ? `${best.name} contributes the most (${m(best.contribution)})` : ''}${worst && worst.contribution < 0 ? `; ${worst.name.toLowerCase()} loses ${m(-worst.contribution)}` : ''}.`.slice(0, 200)),
          ...(best ? { take: { headline: `Products contribute ${m(a.total)} a year before overhead. ${best.name} leads at ${m(best.contribution)}, ${p2(best.marginPct)} on its balance${worst && worst.contribution < 0 ? `; ${worst.name} loses ${m(-worst.contribution)}${worst.side === 'deposit' ? ', paying more than its funding is worth' : ' after its credit and servicing costs'}` : ''}.`, action: { label: 'Which branches contribute most?', ask: 'Which branches contribute the most?' } } } : {}),
        };
      }
      const rows = a.byBranch.map((b) => ({ name: b.name, balance: Math.round(b.balance), contribution: m(b.contribution), margin: p2(b.marginPct), loans: '', deposits: '' }));
      // The loan and deposit halves of each branch.
      const halves = await Promise.all(a.byBranch.map((b) => svc.analysis([b.name])));
      halves.forEach((h, i) => {
        rows[i]!.loans = m(h.byProduct.filter((l) => l.side === 'loan').reduce((s, l) => s + l.contribution, 0));
        rows[i]!.deposits = m(h.byProduct.filter((l) => l.side === 'deposit').reduce((s, l) => s + l.contribution, 0));
      });
      const top = a.byBranch[0];
      return { block: t('Contribution by branch', 'profit.branches', branchCols, rows, top ? `${top.name} contributes the most, ${m(top.contribution)} (${p2(top.marginPct)} on what it manages).` : 'No branches.') };
    },
  };
}

export function profitabilityModule(svc: ProfitabilityService, nii?: NiiService | null, fees?: FeeIncomeService | null): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!allowed(ctx.modules)) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: 'profitability',
    prefix: 'profit',
    agent: 'Profitability',
    request: new RegExp(`${fees ? `${FEE_REQUEST.source}|` : ''}${nii ? `${NII_REQUEST.source}|` : ''}${/\bprofitab|\bcontribution\b|\bmost profitable\b|\bmake (the most )?money\b|\blose money\b|\bftp\b|funds transfer pricing|\ballowance by (segment|pool|loan type|product)\b|\bcecl pools?\b|\breserves? by (segment|pool|loan type|product)\b|\bwhere is the allowance\b/.source}`, 'i'),
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'Loans and deposits, with DI’s FTP assumptions', ref: 'table:cdm_loan' }],
    prompt: ({ tenant, user, title }) => `You are the Profitability agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) asks which products and branches make money and where the allowance sits. Contribution is by funds transfer pricing, before overhead, on today's balances; the FTP curve, loss rates and costs are DI's standard assumptions until the institution's own replace them. The allowance by segment reconciles to the latest filed Call Report.

- "Which products are most profitable?", "what does auto lending contribute?": profit_products.
- "Which branches contribute the most?": profit_branches.
- "Where is the allowance?", "allowance by segment": profit_allowance.
- "How is profitability calculated?": profit_assumptions.${nii ? `
- For a bank, net interest income in dollars, not just NIM: profit_nii, with question growth ("How much did our NII grow?"), why ("why did it change?", "how much came from growth and how much from the margin?"), plan ("are we short of plan in dollars?"), quarter ("how did NII do this quarter?"), forward ("will NII keep growing?", "what do we expect over the next 12 months?") or method ("how is NII growth calculated?"). Its answer already opens with the direct reply; don't add another. NII under rate shocks is the Interest Rate Risk agent's.` : ''}${fees ? `
- For a bank, noninterest income (fees, wealth management, insurance, mortgage banking, trading): profit_fees, with question overview ("What's our non-interest income?"), mix ("where does our fee income come from?"), share ("what share of revenue is it?", "against plan and peers?"), rates ("how much does it diversify us away from rates?", "how much revenue doesn't depend on rates?"), growth ("how has fee income grown?") or method. Its answer already opens with the direct reply; don't add another.` : ''}
- You are read-only.`,
    plan: (text) => {
      const t = text.toLowerCase();
      if (fees && FEE_REQUEST.test(text) && !/\b(profitab|contribution|ftp|allowance)/.test(t)) return { tool: 'profit_fees', args: { question: feeQuestion(text) } };
      if (nii && NII_REQUEST.test(text) && !/\b(profitab|contribution|ftp|allowance)/.test(t)) return { tool: 'profit_nii', args: { question: niiQuestion(text) } };
      if (/allowance|reserve|cecl/.test(t)) return { tool: 'profit_allowance', args: {} };
      if (/how (is|are|do you)|calculat|assum|method|ftp|transfer pric/.test(t)) return { tool: 'profit_assumptions', args: {} };
      if (/branch/.test(t)) return { tool: 'profit_branches', args: {} };
      return { tool: 'profit_products', args: {} };
    },
    tools: [
      ...(nii ? [niiTool(nii, need, () => spec)] : []),
      ...(fees ? [feeTool(fees, need, () => spec)] : []),
      {
        name: 'profit_products',
        description: 'Contribution before overhead by loan and deposit product: spread after FTP, credit cost, servicing less fees, and the margin on balance.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const a = await svc.analysis(ctx.purviewBranches);
          const loans = a.byProduct.filter((l) => l.side === 'loan');
          const deps = a.byProduct.filter((l) => l.side === 'deposit');
          const best = a.byProduct[0]!;
          const losers = a.byProduct.filter((l) => l.contribution < 0);
          const bestMargin = [...loans].sort((x, y) => y.marginPct - x.marginPct)[0];
          return {
            text: `Products contribute **${m(a.total)} a year** before overhead: ${m(loans.reduce((s, l) => s + l.contribution, 0))} from loans and ${m(deps.reduce((s, l) => s + l.contribution, 0))} from deposits. **${best.name}** contributes the most, ${m(best.contribution)}.${bestMargin ? ` Among loans, ${bestMargin.name.toLowerCase()} earns the most on its balance, ${p2(bestMargin.marginPct)}.` : ''}${losers.length ? ` ${losers.map((l) => `${l.name} loses ${m(-l.contribution)}${l.side === 'deposit' ? ': it pays more than its funding is worth' : ' after its credit and servicing costs'}`).join('; ')}.` : ''} This uses DI’s standard FTP curve, loss rates and costs; your own allocations would replace them.`,
            blocks: [moduleTable(spec, 'Contribution by product', ctx.runId, 'profit.products', productCols, productRows(a.byProduct))],
            suggestions: ['Which branches contribute the most?', 'Where is the allowance?', 'How is profitability calculated?'],
          };
        },
      },
      {
        name: 'profit_branches',
        description: 'Contribution before overhead by branch, from the loans and deposits each branch manages.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const a = await svc.analysis(ctx.purviewBranches);
          const top = a.byBranch[0]!;
          const last = a.byBranch.at(-1)!;
          return {
            text: `**${top.name}** contributes the most, **${m(top.contribution)}** a year before overhead (${p2(top.marginPct)} on the ${m(top.balance)} of loans and deposits it manages).${a.byBranch.length > 1 ? ` ${last.name} contributes the least, ${m(last.contribution)} (${p2(last.marginPct)}).` : ''}`,
            blocks: [moduleTable(spec, 'Contribution by branch', ctx.runId, 'profit.branches', [text('name', 'Branch'), money('balance', 'Loans and deposits'), text('contribution', 'Contribution'), text('margin', 'On balance')], a.byBranch.map((b) => ({ name: b.name, balance: Math.round(b.balance), contribution: m(b.contribution), margin: p2(b.marginPct) })))],
            suggestions: ['Which products are most profitable?', 'Where is the allowance?'],
          };
        },
      },
      {
        name: 'profit_allowance',
        description: 'The allowance for credit losses by pool (loan type and credit band), reconciled to the latest filed Call Report.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const a = await svc.allowance(ctx.purviewBranches);
          const top = a.byCategory[0]!;
          const thin = [...a.byCategory].sort((x, y) => x.coveragePct - y.coveragePct)[0]!;
          return {
            text: `The allowance is **${m(a.allowance)}**, ${p2(a.coveragePct)} of ${m(a.balance)} in loans${a.filed !== null && !ctx.purviewBranches?.length ? `, reconciled to ${a.filedCode} on the latest ${a.form}` : ''}. **${top.category}** carries the most, ${m(top.allowance)} (${p2(top.coveragePct)} of its balance); ${thin.category.toLowerCase()} the least coverage, ${p2(thin.coveragePct)}. Pools are spread by each loan type’s loss rate and credit band, more for loans already 60+ days behind.`,
            blocks: [moduleTable(spec, 'Allowance by loan type', ctx.runId, 'profit.allowance', [text('category', 'Loan type'), money('balance', 'Balance'), money('allowance', 'Allowance'), text('coverage', 'Coverage'), text('dq', '60+ delinquent')], a.byCategory.map((c) => ({ category: c.category, balance: Math.round(c.balance), allowance: Math.round(c.allowance), coverage: p2(c.coveragePct), dq: p2(c.dq60Pct) })))],
            suggestions: ['Which products are most profitable?', 'Show delinquency 60+ by credit score band'],
          };
        },
      },
      {
        name: 'profit_assumptions',
        description: 'How contribution and the allowance by segment are worked out: the FTP curve, loss rates, servicing costs and fees.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          return { text: `Contribution is by funds transfer pricing, on today’s balances, annualized:\n\n${svc.assumptions().map((x) => `- ${x}`).join('\n')}\n\nThe allowance by segment spreads the filed allowance across loan types and credit bands by each pool’s loss rate.` };
        },
      },
    ],
  };
  return spec;
}

function niiTool(svc: NiiService, need: (ctx: ModuleContext) => void, spec: () => ModuleSpec) {
  return {
    name: 'profit_nii',
    description: 'A bank’s net interest income in dollars from the Call Report: growth year to date and on the last quarter, how much came from a bigger balance sheet and how much from the margin (yield and funding cost), which income and expense lines moved, the gap to plan and peers in dollars, and the rate-risk model’s next 12 months.',
    input: z.object({ question: z.enum(['growth', 'why', 'plan', 'quarter', 'forward', 'method']).optional() }).strict(),
    run: async (a: { question?: NiiQuestion }, ctx: ModuleContext) => {
      need(ctx);
      if (a.question === 'method') return { text: `How DI works out net interest income growth:\n\n${svc.assumptions().map((x) => `- ${x}`).join('\n')}` };
      const g = await svc.growth();
      if (!g) throw new CoreError('INVALID', 'Net interest income growth is built from a bank’s FFIEC Call Report, and none is loaded yet.');
      const y = g.ytd;
      const year = g.asOf.slice(0, 4);
      const q = qLabel(g.asOf);
      const lastYear = String(Number(year) - 1);
      const income = y?.lines.filter((l) => l.side === 'income') ?? [];
      const expense = y?.lines.filter((l) => l.side === 'expense') ?? [];
      const moved = (ls: typeof income) => [...ls].filter((l) => Math.abs(l.change) >= 50e3).sort((x, z) => Math.abs(z.change) - Math.abs(x.change)).slice(0, 2);
      const lineText = (ls: typeof income) => moved(ls).map((l) => `${l.name.charAt(0).toLowerCase()}${l.name.slice(1)} ${sm(l.change)}`).join(', ');
      const fwd = g.forward;
      const flat = fwd && Math.abs(fwd.pct ?? 0) < 1;
      const up100 = fwd?.shocks.find((x) => x.bp === 100);

      const lead = {
        growth: y ? `**Net interest income is ${mm(y.now)} for ${period(y.months, year)}, ${y.change >= 0 ? 'up' : 'down'} ${mm(Math.abs(y.change))} (${p1(Math.abs(y.pct ?? 0))})** on the same months of ${lastYear}.` : `**Net interest income is running at ${mm(g.runRate)} a year.**`,
        why: y ? (y.volume >= 0 && y.rate < 0 ? `**A bigger balance sheet added ${mm(y.volume)}; a thinner margin took back ${mm(-y.rate)}.**` : y.volume >= 0 && y.rate >= 0 ? `**Both helped: a bigger balance sheet added ${mm(y.volume)} and a wider margin ${mm(y.rate)}.**` : `**The margin ${y.rate >= 0 ? `added ${mm(y.rate)}` : `cost ${mm(-y.rate)}`} and a smaller balance sheet ${mm(y.volume)}.**`) : '',
        plan: g.plan ? `**${mm(Math.abs(g.plan.gap))} a year ${g.plan.gap < 0 ? 'short of' : 'ahead of'} plan**: at plan’s ${g.plan.nim.toFixed(2)}% NIM, today’s earning assets would earn ${mm(g.plan.nii)} a year against a run rate of ${mm(g.runRate)}.` : '**No NIM plan is set, so there is no plan in dollars.**',
        quarter: g.quarter ? `**${q} earned ${mm(g.quarter.now)}${g.quarter.change !== null ? `, ${g.quarter.change >= 0 ? 'up' : 'down'} ${mm(Math.abs(g.quarter.change))} (${p1(Math.abs(g.quarter.pct ?? 0))}) on the quarter before` : ''}.**` : '',
        forward: fwd ? `**About ${mm(fwd.next12)} over the next 12 months, ${flat ? 'flat on' : fwd.vsNow > 0 ? `${mm(fwd.vsNow)} above` : `${mm(-fwd.vsNow)} below`} today’s run rate of ${mm(g.runRate)}**, if balances and rates hold.` : '**The rate-risk model isn’t available to project the next 12 months.**',
      }[a.question ?? 'growth'];

      const parts: string[] = [];
      if (y) {
        if (a.question !== 'growth' || !lead) parts.push(`Net interest income is ${mm(y.now)} for ${period(y.months, year)}, ${y.change >= 0 ? 'up' : 'down'} ${mm(Math.abs(y.change))} (${p1(Math.abs(y.pct ?? 0))}) on ${lastYear}.`);
        parts.push(`Earning assets grew ${mm(y.earningGrowth)} (${p1(y.earningGrowthPct ?? 0)}), worth **${sm(y.volume)}** at last year’s margin, while NIM ${y.nimNow < y.nimBefore ? 'narrowed' : 'widened'} ${bp(y.nimNow - y.nimBefore)} to ${y.nimNow.toFixed(2)}%, **${sm(y.rate)}**: ${y.yieldNow < y.yieldBefore ? 'a lower' : 'a higher'} yield on earning assets ${sm(y.yieldEffect)} and ${y.costNow > y.costBefore ? 'dearer' : 'cheaper'} funding ${sm(y.costEffect)}.`);
        parts.push(`Interest income rose ${mm(y.incomeChange)}${moved(income).length ? ` (${lineText(income)})` : ''}; interest expense ${y.expenseChange >= 0 ? 'rose' : 'fell'} ${mm(Math.abs(y.expenseChange))}${moved(expense).length ? ` (${lineText(expense)})` : ''}.`);
        if (y.volume > 0 && y.rate < 0) parts.push(`Growth is carrying net interest income while the margin narrows: without the new earning assets it would be ${mm(-y.rate)} lower than a year ago.`);
      }
      if (g.quarter && a.question !== 'quarter') parts.push(`${q} on its own earned ${mm(g.quarter.now)}${g.quarter.change !== null ? `, ${sm(g.quarter.change)} on the quarter before` : ''}.`);
      if (g.plan && a.question !== 'plan') parts.push(`At plan’s ${g.plan.nim.toFixed(2)}% NIM, today’s earning assets would earn ${mm(g.plan.nii)} a year, ${mm(Math.abs(g.plan.gap))} ${g.plan.gap < 0 ? 'more' : 'less'} than the ${mm(g.runRate)} run rate${g.peer ? `; at peers’ ${g.peer.nim.toFixed(2)}%, ${mm(Math.abs(g.peer.gap))} ${g.peer.gap < 0 ? 'more' : 'less'}` : ''}.`);
      else if (g.peer && a.question === 'plan') parts.push(`At peers’ ${g.peer.nim.toFixed(2)}%, it would be ${mm(Math.abs(g.peer.gap))} a year ${g.peer.gap < 0 ? 'more' : 'less'}.`);
      if (fwd) {
        if (a.question !== 'forward') parts.push(`The rate-risk model expects ${mm(fwd.next12)} over the next 12 months on today’s balances${flat ? ', about flat' : ''}.`);
        if (up100) parts.push(`A 100 bp rise would ${up100.change < 0 ? 'cut' : 'add'} ${mm(Math.abs(up100.change))} a year${up100.change < 0 ? ', as deposits reprice faster than loans' : ''}.`);
        if (flat && y && y.rate < 0) parts.push('So more growth has to come from adding earning assets or from repricing deposits; the margin isn’t widening on its own.');
      }

      // These figures are the Call Report's, not the FTP model's.
      const s = { ...spec(), sources: [{ kind: 'table' as const, label: 'FFIEC 051 Call Report: income statement and earning assets', ref: 'table:cr_value' }] };
      const tbl = (title: string, op: string, cols: Cols, rowsIn: Record<string, string | number>[]) => moduleTable(s, title, ctx.runId, op, cols, rowsIn);
      const blocks: Block[] = [];
      if (y) {
        const lineRow = (l: (typeof income)[number]) => ({ item: l.name, now: mm(l.ytd), before: mm(l.before), change: sm(l.change) });
        blocks.push(
          tbl(`Net interest income, ${period(y.months, year).replace(/^the /, '')} against ${lastYear}`, 'profit.nii.lines', [text('item', 'Item'), text('now', year), text('before', lastYear), text('change', 'Change')], [
            ...income.map(lineRow),
            { item: 'Total interest income', now: mm(income.reduce((t, l) => t + l.ytd, 0)), before: mm(income.reduce((t, l) => t + l.before, 0)), change: sm(y.incomeChange) },
            ...expense.map(lineRow),
            { item: 'Total interest expense', now: mm(expense.reduce((t, l) => t + l.ytd, 0)), before: mm(expense.reduce((t, l) => t + l.before, 0)), change: sm(y.expenseChange) },
            { item: 'Net interest income', now: mm(y.now), before: mm(y.before), change: `${sm(y.change)} (${p1(y.pct ?? 0)})` },
          ]),
          tbl('Why it changed: balance sheet and margin', 'profit.nii.why', [text('item', 'Driver'), text('detail', 'What moved'), text('effect', 'Effect')], [
            { item: 'More earning assets', detail: `${mm(y.earningBefore)} to ${mm(y.earningNow)} (${p1(y.earningGrowthPct ?? 0)})`, effect: sm(y.volume) },
            { item: 'Yield on earning assets', detail: `${y.yieldBefore.toFixed(2)}% to ${y.yieldNow.toFixed(2)}%`, effect: sm(y.yieldEffect) },
            { item: 'Funding cost on earning assets', detail: `${y.costBefore.toFixed(2)}% to ${y.costNow.toFixed(2)}%`, effect: sm(y.costEffect) },
            { item: 'Net interest income', detail: `NIM ${y.nimBefore.toFixed(2)}% to ${y.nimNow.toFixed(2)}%`, effect: sm(y.change) },
          ]),
        );
      }
      blocks.push(
        tbl('Net interest income by quarter', 'profit.nii.trend', [text('quarter', 'Quarter'), text('quarterly', 'In the quarter'), text('ytd', 'Year to date'), text('annualized', 'Annualized'), text('earning', 'Earning assets'), text('nim', 'NIM')], g.trend.map((t) => ({ quarter: qLabel(t.end), quarterly: t.quarterly === null ? '—' : mm(t.quarterly), ytd: mm(t.ytd), annualized: mm(t.annualized), earning: mm(t.earning), nim: `${t.nim.toFixed(2)}%` }))),
      );
      const ahead = [
        { item: 'Run rate today', nim: `${g.nim.toFixed(2)}%`, nii: mm(g.runRate), vs: '—' },
        ...(g.plan ? [{ item: 'At plan’s NIM', nim: `${g.plan.nim.toFixed(2)}%`, nii: mm(g.plan.nii), vs: sm(-g.plan.gap) }] : []),
        ...(g.peer ? [{ item: 'At peers’ NIM', nim: `${g.peer.nim.toFixed(2)}%`, nii: mm(g.peer.nii), vs: sm(-g.peer.gap) }] : []),
        ...(fwd ? [{ item: 'Next 12 months, rates unchanged', nim: '—', nii: mm(fwd.next12), vs: sm(fwd.vsNow) }, ...fwd.shocks.map((x) => ({ item: `Next 12 months, ${x.bp > 0 ? '+' : '−'}${Math.abs(x.bp)} bp`, nim: '—', nii: mm(x.nii), vs: sm(x.nii - g.runRate) }))] : []),
      ];
      blocks.push(tbl('Plan, peers and the next 12 months, a year', 'profit.nii.ahead', [text('item', 'Case'), text('nim', 'NIM'), text('nii', 'Net interest income'), text('vs', 'Against today')], ahead));

      return {
        text: [lead, ...parts].filter(Boolean).join(' '),
        sources: s.sources,
        blocks,
        suggestions: [a.question === 'why' ? 'Are we short of plan in dollars?' : 'Why did net interest income change?', 'What happens to NII if rates rise 200 bp?', a.question === 'forward' ? 'How did NII do this quarter?' : 'Will net interest income keep growing?'],
      };
    },
  };
}

function feeTool(svc: FeeIncomeService, need: (ctx: ModuleContext) => void, spec: () => ModuleSpec) {
  return {
    name: 'profit_fees',
    description: 'A bank’s noninterest income from the Call Report: total and growth, the mix by source and business (deposit and card fees, wealth management, insurance, mortgage banking, trading), its share of revenue against plan and peers, and how much of revenue doesn’t depend on rates, with what a rate move does to net interest income and mortgage banking.',
    input: z.object({ question: z.enum(['overview', 'mix', 'share', 'rates', 'growth', 'method']).optional() }).strict(),
    run: async (a: { question?: FeeQuestion }, ctx: ModuleContext) => {
      need(ctx);
      if (a.question === 'method') return { text: `How DI works out noninterest income:\n\n${svc.assumptions().map((x) => `- ${x}`).join('\n')}` };
      const f = await svc.income();
      if (!f) throw new CoreError('INVALID', 'Noninterest income is built from a bank’s FFIEC Call Report, and none is loaded yet.');
      const year = f.asOf.slice(0, 4);
      const lastYear = String(Number(year) - 1);
      const q = qLabel(f.asOf);
      const groups = f.groups.filter((g) => g.ytd > 0).sort((x, y) => y.ytd - x.ytd);
      const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
      const trading = f.groups.find((g) => g.group === 'Trading')!;
      const up100 = f.rates.find((r) => r.bp === 100);
      const sameWay = up100 ? Math.sign(up100.niiChange) === Math.sign(up100.mortgageChange) : false;
      const ref = (r: NonNullable<typeof f.plan>, who: string) => `${who === 'peers' ? 'peers’' : `${who}’s`} ${r.sharePct.toFixed(1)}%`;
      const vs = (r: NonNullable<typeof f.plan>) => (f.sharePct >= r.sharePct - 0.05 ? (f.sharePct > r.sharePct + 0.05 ? 'above' : 'on') : 'below');

      const lead = {
        overview: `**Noninterest income is ${mm(f.total)} for ${period(f.months, year)}${f.change !== null ? `, ${f.change >= 0 ? 'up' : 'down'} ${mm(Math.abs(f.change))} (${p1(Math.abs(f.pct ?? 0))})` : ''}**, ${p1(f.sharePct)} of revenue.`,
        mix: `**Most comes from ${groups.slice(0, 3).map((g, i) => `${i === 2 ? 'and ' : ''}${lower(g.group)} (${p1(g.sharePct)})`).join(groups.length > 2 ? ', ' : ' ')}.**`,
        share: `**${p1(f.sharePct)} of revenue${f.plan ? `, ${vs(f.plan)} ${ref(f.plan, 'plan')}` : ''}${f.peer ? `${f.plan ? ' and' : ','} ${vs(f.peer)} ${ref(f.peer, 'peers')}` : ''}.**${f.peer && f.peer.gap < 0 ? ` Matching peers would mean about ${mm(-f.peer.gap)} a year more.` : ''}`,
        rates: `**${mm(f.steady)} a year, ${p1(f.steadyPct)} of revenue, doesn’t depend on rates.**`,
        growth: f.change !== null ? `**Up ${mm(f.change)} (${p1(f.pct ?? 0)}) on the same months of ${lastYear}**, to ${mm(f.total)}.` : `**${mm(f.total)} so far this year.**`,
      }[a.question ?? 'overview'];

      const parts: string[] = [];
      if (a.question !== 'overview' && a.question !== 'growth') parts.push(`Noninterest income is ${mm(f.total)} for ${period(f.months, year)} (${mm(f.annualized)} a year)${f.change !== null ? `, ${f.change >= 0 ? 'up' : 'down'} ${mm(Math.abs(f.change))} (${p1(Math.abs(f.pct ?? 0))}) on ${lastYear}` : ''}.`);
      if (a.question !== 'mix') parts.push(`It comes from ${groups.map((g) => `${lower(g.group)} ${mm(g.ytd)} (${p1(g.sharePct)})`).join(', ')}.`);
      else parts.push(`In all: ${groups.map((g) => `${lower(g.group)} ${mm(g.ytd)}`).join(', ')}.`);
      if (trading.ytd === 0) parts.push('There’s no trading revenue, which is normal for a community bank: trading is a big-bank business.');
      const movers = f.lines.filter((l) => l.change !== null && Math.abs(l.change) >= 20e3).sort((x, y) => Math.abs(y.change!) - Math.abs(x.change!));
      const ups = movers.filter((l) => l.change! > 0).slice(0, 2);
      const downs = movers.filter((l) => l.change! < 0).slice(0, 1);
      if (ups.length || downs.length) parts.push(`${ups.length ? `Growth came from ${ups.map((l) => `${lower(l.name)} ${sm(l.change!)} (${p1(l.pct ?? 0)})`).join(' and ')}` : ''}${downs.length ? `${ups.length ? ', while ' : ''}${downs.map((l) => `${lower(l.name)} ${l.change! < 0 ? 'fell' : 'rose'} ${mm(Math.abs(l.change!))} (${p1(Math.abs(l.pct ?? 0))})`).join('')}` : ''}.`);
      if (a.question !== 'share') parts.push(`That is ${p1(f.sharePct)} of revenue${f.shareBefore !== null ? ` (${p1(f.shareBefore)} a year ago)` : ''}${f.plan ? `, ${vs(f.plan)} ${ref(f.plan, 'plan')}` : ''}${f.peer ? `${f.plan ? ' and' : ','} ${vs(f.peer)} ${ref(f.peer, 'peers')}${f.peer.gap < 0 ? `, about ${mm(-f.peer.gap)} a year short of them` : ''}` : ''}.`);
      else if (f.shareBefore !== null) parts.push(`A year ago it was ${p1(f.shareBefore)}; it is ${f.toAssetsPct !== null ? `${f.toAssetsPct.toFixed(2)}% of assets` : ''}.`);
      if (up100) {
        const steadyOnly = (up100.niiChange / f.revenue) * 100;
        if (a.question !== 'rates') parts.push(`${mm(f.steady)} a year of it (${p1(f.steadyPct)} of revenue) doesn’t depend on rates.`);
        parts.push(`If rates rise 100 bp, net interest income ${up100.niiChange < 0 ? 'falls' : 'rises'} ${mm(Math.abs(up100.niiChange))} (${p1(Math.abs(up100.niiPct))}). Fees that don’t move with rates would soften that to ${p1(Math.abs(steadyOnly))} of revenue, but mortgage banking ${up100.mortgageChange < 0 ? 'loses' : 'adds'} ${mm(Math.abs(up100.mortgageChange))} too, so revenue ${up100.revenueChange < 0 ? 'falls' : 'rises'} ${mm(Math.abs(up100.revenueChange))} (${p1(Math.abs(up100.revenuePct))}).`);
        parts.push(sameWay ? 'For this bank, mortgage banking moves the same way as net interest income (both gain when rates fall), so it adds to rate risk rather than offsetting it; trust, brokerage, insurance and deposit fees are what diversify revenue.' : 'Mortgage banking moves against net interest income here, so it partly offsets rate risk, alongside trust, brokerage, insurance and deposit fees.');
      }
      if (f.quarter && a.question === 'growth') parts.push(`${q} on its own brought ${mm(f.quarter.now)}${f.quarter.change !== null ? `, ${sm(f.quarter.change)} on the quarter before` : ''}.`);

      const s = { ...spec(), sources: [{ kind: 'table' as const, label: 'FFIEC 051 Call Report: income statement (RI)', ref: 'table:cr_value' }] };
      const tbl = (title: string, op: string, cols: Cols, rowsIn: Record<string, string | number>[]) => moduleTable(s, title, ctx.runId, op, cols, rowsIn);
      const moves = { steady: 'No', rises: 'Yes: up when rates fall', falls: 'Yes: down when rates fall' } as const;
      const blocks: Block[] = [
        tbl(`Noninterest income by source, ${period(f.months, year).replace(/^the /, '')}`, 'profit.fees.lines', [text('name', 'Source'), text('group', 'Business'), text('now', year), text('before', lastYear), text('change', 'Change'), text('share', 'Share'), text('rates', 'Moves with rates')], [
          ...f.lines.map((l) => l.group === 'Trading' && !l.ytd && !l.before ? { name: l.name, group: l.group, now: 'None reported', before: 'None reported', change: '—', share: '—', rates: '—' } : ({ name: l.name, group: l.group, now: mm(l.ytd), before: l.before === null ? '—' : mm(l.before), change: l.change === null ? '—' : `${sm(l.change)}${l.pct !== null ? ` (${p1(l.pct)})` : ''}`, share: p1(l.sharePct), rates: moves[l.rates] })),
          { name: 'Total noninterest income', group: '', now: mm(f.total), before: f.before === null ? '—' : mm(f.before), change: f.change === null ? '—' : `${sm(f.change)} (${p1(f.pct ?? 0)})`, share: '100.0%', rates: '' },
        ]),
        tbl('Share of revenue', 'profit.fees.share', [text('item', ''), text('share', 'Of revenue'), text('fees', 'Noninterest income, a year'), text('vs', 'Against today')], [
          { item: 'Today', share: p1(f.sharePct), fees: mm(f.annualized), vs: '—' },
          ...(f.shareBefore !== null && f.before !== null ? [{ item: 'A year ago', share: p1(f.shareBefore), fees: mm((f.before * 12) / f.months), vs: '—' }] : []),
          ...(f.plan ? [{ item: 'Plan', share: p1(f.plan.sharePct), fees: mm(f.plan.fees), vs: sm(f.plan.fees - f.annualized) }] : []),
          ...(f.peer ? [{ item: 'Peers', share: p1(f.peer.sharePct), fees: mm(f.peer.fees), vs: sm(f.peer.fees - f.annualized) }] : []),
          { item: 'Doesn’t depend on rates', share: p1(f.steadyPct), fees: mm(f.steady), vs: '—' },
        ]),
        ...(f.rates.length
          ? [tbl('If rates move, a year', 'profit.fees.rates', [text('shock', 'Rates'), text('nii', 'Net interest income'), text('mortgage', 'Mortgage banking'), text('revenue', 'Revenue'), text('revPct', 'Revenue change'), text('niiPct', 'NII alone')], [...f.rates].sort((x, y) => y.bp - x.bp).map((r) => ({ shock: `${r.bp > 0 ? '+' : '−'}${Math.abs(r.bp)} bp`, nii: sm(r.niiChange), mortgage: sm(r.mortgageChange), revenue: sm(r.revenueChange), revPct: p1(r.revenuePct), niiPct: p1(r.niiPct) })))]
          : []),
        tbl('Noninterest income by quarter', 'profit.fees.trend', [text('quarter', 'Quarter'), text('quarterly', 'In the quarter'), text('ytd', 'Year to date'), text('annualized', 'Annualized'), text('share', 'Of revenue')], f.trend.map((t) => ({ quarter: qLabel(t.end), quarterly: t.quarterly === null ? '—' : mm(t.quarterly), ytd: mm(t.ytd), annualized: mm(t.annualized), share: p1(t.sharePct) }))),
      ];
      return {
        text: [lead, ...parts].filter(Boolean).join(' '),
        sources: s.sources,
        blocks,
        suggestions: [a.question === 'rates' ? 'What share of revenue is fee income against peers?' : 'How much of our revenue doesn’t depend on rates?', 'How much did our net interest income grow?', 'How is noninterest income calculated?'],
      };
    },
  };
}
