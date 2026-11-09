// Liquidity on the shared module agent: the liquidity ratios, the cash-flow ladder, borrowing capacity by
// source and survival under share runoff. Read-only, and honest that capacity is DI's estimate.
import { z } from 'zod';
import { CoreError, pctAgainst, type FundingRiskService, type LiquidityService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const NO_ACCESS = 'Liquidity isn’t part of your DI access. It is for the finance team and executives.';
const guard = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('liquidity')) throw new CoreError('NO_ACCESS', NO_ACCESS);
};
const m = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);
const p1 = (n: number) => `${n.toFixed(1)}%`;

/** "a 20% run", "if 30 percent of shares leave": the runoff, nearest modelled (10, 20 or 30). */
export function runoffFrom(text: string): number | null {
  const n = /(\d{1,2})\s*(%|percent)/.exec(text.toLowerCase());
  if (!n) return null;
  const v = Number(n[1]);
  return [10, 20, 30].reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), 20);
}

/** "if 50% of uninsured and 10% of insured deposits leave": the two percentages, when given. */
export function uninsuredRunFrom(text: string): { uninsured: number; insured: number } | null {
  const u = /(\d{1,3})\s*(?:%|percent)\s*(?:of\s+(?:our\s+|the\s+)?)?uninsured/i.exec(text);
  if (!u) return null;
  const i = /(\d{1,3})\s*(?:%|percent)\s*(?:of\s+(?:our\s+|the\s+)?)?insured/i.exec(text.replace(u[0], ''));
  return { uninsured: Math.min(100, Number(u[1])), insured: Math.min(100, i ? Number(i[1]) : 5) };
}

// A source's name inside a sentence: only its first letter is lowered, so the Federal Reserve keeps its capitals and an opening acronym (FHLB) stays as it is.
const inSentence = (name: string): string => (/^[A-Z]{2}/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1));

/** A bank's loan-to-deposit questions, and the wholesale funding behind them. Charts and targets stay with Analytics and Budget. */
export const LTD_REQUEST = /^(?![\s\S]*\b(?:chart|graph|plot|trend|by month|over time|by branch|target|goal|budget)\b)[\s\S]*(?:\bloan[- ]to[- ]deposits?\b|\bltd ratio\b|\bwholesale (?:funding|borrowing|borrowings|money)\b|\bbrokered (?:deposits?|cds?|certificates)\b|\bfunding gap\b|\b(?:money|cash|deposits?|funds?) (?:sitting |is |are )?idle\b|\bidle (?:money|cash|deposits|funds)\b|\blend before\b|\bdeposits? (?:cover|fund) (?:our |the )?loans\b)/i;

/** A bank's deposit questions after SVB: the mix, how much is uninsured, and what rising rates do to deposits. */
export const DEPOSIT_REQUEST = /\bdeposit (?:mix|composition|franchise|concentration)\b|\bmix of (?:our )?deposits\b|\b(?:deposits?|money) (?:are|is) uninsured\b|\buninsured\b(?![\s\S]*\b(?:report|rc-o|schedule|call report)\b)|\blargest depositors\b|\bnoninterest[- ]bearing deposits\b|(?:\brates? (?:rise|rises|go up|goes up|increase|climb|keep rising)|\brising rates\b|\bhigher rates\b|\brate (?:hikes?|increases?)\b)[\s\S]*\b(?:deposits?|leave|outflows?|run ?off|runoff|flight)\b|\b(?:deposits?|money)\b[\s\S]*\b(?:leave|run ?off|flee)\b[\s\S]*\b(?:rates? (?:rise|go up|increase)|rising rates|higher rates)\b/i;
const RATES_UP = /\brates? (?:rise|rises|go up|goes up|increase|climb|keep rising)|\brising rates\b|\bhigher rates\b|\brate (?:hikes?|increases?)\b|\bif rates\b/;

export function liquidityModule(liq: LiquidityService, funding?: FundingRiskService | null): ModuleSpec {
  const bankOnly = () => {
    if (!funding) throw new CoreError('INVALID', 'The 30-day funding test, LCR and NSFR are built from a bank’s FFIEC Call Report (uninsured deposits and the securities’ fair values). For a credit union, ask how long we’d last if shares ran off.');
    return funding;
  };
  const spec: ModuleSpec = {
    id: 'liquidity',
    prefix: 'liq',
    agent: 'Liquidity',
    request: new RegExp(`${funding ? `${LTD_REQUEST.source}|${DEPOSIT_REQUEST.source}|` : ''}${/\blcr\b|\bnsfr\b|\bliquidity coverage\b|\bnet stable funding\b|\bsvb\b|\bsilicon valley\b|\bwithout selling\b|\bsell(?:ing)? (?:assets|securities|bonds|investments) at a loss\b|\bunrealized loss|\buninsured (?:deposits? )?(?:run|runoff|run-off|outflows?|leave|flight)\b|\buninsured deposits?\b[^.?!]*\b(?:leave|left|run|withdraw)|\bliquidity\b|\bborrowing capacity\b|\bhow much (could|can) we borrow\b|\bfhlb\b|\bdiscount window\b|\bcontingency funding\b|\b(deposit|share) (run|runoff|run-off|outflows?)\b|\brun on (deposits|shares)\b|\bclf\b|\bcorporate (credit union )?line\b|\bcash.flow ladder\b|\bliquid assets\b|\bsurvive\b.*\b(run|outflow|leave)/.source}`, 'i'),
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'Loans, investments, deposits and borrowings', ref: 'table:cdm_loan' }],
    prompt: ({ tenant, user, title }) => `You are the Liquidity agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) manages liquidity for the ALCO and the contingency funding plan. DI estimates on-balance-sheet liquidity, a 30/90/180/365-day cash-flow ladder, borrowing capacity (FHLB, the Federal Reserve discount window, unpledged securities, the corporate or correspondent line) and survival under share runoff. Capacity uses typical lendable values; the FHLB's and Reserve Bank's own collateral rules set the real figures, so say it is an estimate.

- "How is our liquidity?", "are we within policy?": liq_summary.
- "How much could we borrow tomorrow?", "what's our FHLB capacity?": liq_capacity.
- "Can we survive a 20% deposit run?": liq_stress with runoff_pct.
- "Show the cash-flow ladder": liq_ladder.
- "What assumptions?": liq_assumptions.
- For a bank, the loan-to-deposit ratio against its 80% to 100% band and the wholesale funding behind it: liq_ltd, with question band ("What's our loan-to-deposit ratio?", "is it too low or too high?"), wholesale ("are we funding loans with wholesale borrowing?"), room ("how much could we lend before 80%?") or cost ("what does our wholesale funding cost?"). Its answer already leads with the direct reply; don't add another.
- For a bank, the deposit book: "What's our deposit mix?", "how much of our deposits are uninsured?", "who are our largest depositors?": liq_deposits. "How fast will deposits leave if rates rise?", "what does a 200 bp rise do to our deposits?": liq_rates_up with shock_bp (100, 200 or 300; 200 if none is given). Each answer leads with the direct reply; don't add another.
- For a bank, after SVB: "Can we survive 30 days of withdrawals without selling assets at a loss?": liq_funding. "What if 50% of uninsured deposits leave?": liq_run with uninsured_pct and insured_pct. "What's our LCR?", "NSFR?": liq_lcr. "What are our unrealized losses?", "what if we had to sell our securities?": liq_unrealized.
- You only read, and give no investment advice.`,
    plan: (text) => {
      const t = text.toLowerCase();
      // After SVB, a bank's board asks about the run, selling at a loss, and the LCR and NSFR.
      if (/\blcr\b|\bnsfr\b|liquidity coverage|net stable funding/.test(t)) return { tool: 'liq_lcr', args: {} };
      // A bank's deposit book: rising rates first, then a run by share (below), then the mix and uninsured.
      if (funding && RATES_UP.test(t) && /\bdeposits?\b|\bleave\b|\boutflows?\b|\brun ?off\b|\bflight\b|\bbetas?\b|\buninsured\b/.test(t) && !uninsuredRunFrom(text)) {
        const bp = Number(/(\d{3})\s*(?:bp|basis)/.exec(t)?.[1] ?? (/(\d)(?:\.0)?\s*%/.exec(t) ? Number(/(\d)(?:\.0)?\s*%/.exec(t)![1]) * 100 : 200));
        return { tool: 'liq_rates_up', args: { shock_bp: [100, 200, 300].includes(bp) ? bp : 200 } };
      }
      if (funding && DEPOSIT_REQUEST.test(text) && !uninsuredRunFrom(text) && !/survive|withdraw|at a loss|\bsvb\b|silicon valley/.test(t)) return { tool: 'liq_deposits', args: { question: /uninsured/.test(t) ? 'uninsured' : 'mix' } };
      if (funding && LTD_REQUEST.test(text)) return { tool: 'liq_ltd', args: { question: /\b(?:cost|expensive|pay|rate)\b/.test(t) ? 'cost' : /\blend\b|\bidle\b|\broom\b|how much (?:more )?could/.test(t) ? 'room' : /\bwholesale\b|\bbrokered\b|\bfunding (?:our |the )?loans\b|\bfund(?:ing)? loans\b|\bcover\b/.test(t) ? 'wholesale' : 'band' } };
      const run = uninsuredRunFrom(text);
      if (run) return { tool: 'liq_run', args: { uninsured_pct: run.uninsured, insured_pct: run.insured } };
      if (/unrealized loss|underwater|(?:sell|selling|sold) (?:our |the )?(?:securities|bonds|investments)\b(?![^.?!]*without)/.test(t) && !/survive|30 days|withdraw/.test(t)) return { tool: 'liq_unrealized', args: {} };
      if (/\bsvb\b|silicon valley|without selling|at a loss|uninsured/.test(t)) return { tool: 'liq_funding', args: {} };
      if (/assumption|haircut|lendable|how (is|does) (this|it|the model)/.test(t)) return { tool: 'liq_assumptions', args: {} };
      if (/ladder|cash.flow|maturit|next (30|90) days/.test(t)) return { tool: 'liq_ladder', args: {} };
      if (/\brun\b|runoff|run-off|outflow|survive|stress|leave/.test(t)) return { tool: 'liq_stress', args: { runoff_pct: runoffFrom(t) ?? 20 } };
      if (/borrow|capacity|fhlb|discount window|corporate|correspondent|clf|line/.test(t)) return { tool: 'liq_capacity', args: {} };
      return { tool: 'liq_summary', args: {} };
    },
    tools: [
      {
        name: 'liq_summary',
        description: 'On-balance-sheet liquidity ratios against policy, total available liquidity (liquid assets plus borrowing capacity) as a share of shares, and survival under share runoff.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const a = await liq.analysis();
          const la = a.ratios[0]!;
          const s20 = a.stress.find((x) => x.pct === 20)!;
          return {
            text: `Liquid assets are **${m(a.liquid)}**, ${pctAgainst(la.value, a.policy.liquidToAssetsMinPct)} of total assets (policy: at least ${a.policy.liquidToAssetsMinPct}%${la.value < a.policy.liquidToAssetsMinPct ? ', **below policy**' : ''}). With borrowing capacity of **${m(a.contingent)}**, available liquidity is **${m(a.available)}**, ${p1(a.availableToShares)} of shares (policy: at least ${a.policy.availableToSharesMinPct}%). If 20% of shares left within 30 days, available liquidity would cover it **${s20.coverage.toFixed(1)} times**. Capacity is DI’s estimate from loan and investment data.`,
            blocks: [moduleTable(spec, 'Liquidity ratios', ctx.runId, 'liq.ratios', [{ field: 'name', headerName: 'Ratio', type: 'text' }, { field: 'value', headerName: 'Value', type: 'text' }, { field: 'note', headerName: 'What it shows', type: 'text' }], a.ratios.map((r) => ({ name: r.name, value: r.limit ? pctAgainst(r.value, r.limit) : p1(r.value), note: r.note })))],
            suggestions: ['How much could we borrow tomorrow?', 'Can we survive a 30% deposit run?'],
          };
        },
      },
      {
        name: 'liq_capacity',
        description: 'Borrowing capacity by source: collateral, lendable value, amount already used and amount available, with CLF access.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const a = await liq.analysis();
          const top = [...a.capacity].sort((x, y) => y.available - x.available)[0]!;
          return {
            text: `DI estimates **${m(a.contingent)}** could be raised quickly beyond liquid assets. The largest source is ${inSentence(top.source)}, **${m(top.available)}** available${top.used ? ` after ${m(top.used)} already drawn` : ''}.${a.clf ? ` ${a.clf}` : ''} These are estimates at typical lendable values; the FHLB’s and the Reserve Bank’s collateral rules and actual pledges set the real figures.`,
            blocks: [moduleTable(spec, 'Borrowing capacity', ctx.runId, 'liq.capacity', [{ field: 'source', headerName: 'Source', type: 'text' }, { field: 'collateral', headerName: 'Collateral', type: 'text' }, { field: 'value', headerName: 'Collateral value', type: 'currency' }, { field: 'lendable', headerName: 'Lendable value', type: 'currency' }, { field: 'used', headerName: 'Used', type: 'currency' }, { field: 'available', headerName: 'Available', type: 'currency' }], a.capacity.map((c) => ({ source: c.source, collateral: c.collateral, value: Math.round(c.collateralValue), lendable: Math.round(c.lendable), used: Math.round(c.used), available: Math.round(c.available) })))],
          };
        },
      },
      {
        name: 'liq_stress',
        description: 'Survival if 10%, 20% or 30% of shares leave within 30 days: the runoff, sources used in order, coverage and days covered.',
        input: z.object({ runoff_pct: z.number().int().min(5).max(50).default(20) }).strict(),
        run: async (a0: { runoff_pct: number }, ctx) => {
          guard(ctx);
          const a = await liq.analysis();
          const s = a.stress.find((x) => x.pct === a0.runoff_pct) ?? a.stress.find((x) => x.pct === 20)!;
          return {
            text: `If ${s.pct}% of shares (**${m(s.runoff)}**) left within 30 days, ${s.covered ? `available liquidity of ${m(s.available)} would cover it **${s.coverage.toFixed(1)} times**, for about **${s.days} days** at that pace` : `available liquidity would fall **${m(s.shortfall)} short**`}. It would draw on ${s.used.map((u) => `${inSentence(u.name)} (${m(u.amount)})`).join(', then ')}.`,
            blocks: [moduleTable(spec, 'Share runoff within 30 days', ctx.runId, 'liq.stress', [{ field: 'pct', headerName: 'Runoff', type: 'text' }, { field: 'runoff', headerName: 'Shares leaving', type: 'currency' }, { field: 'available', headerName: 'Available liquidity', type: 'currency' }, { field: 'coverage', headerName: 'Coverage', type: 'text' }, { field: 'days', headerName: 'Days covered', type: 'number' }, { field: 'result', headerName: 'Result', type: 'text' }], a.stress.map((x) => ({ pct: `${x.pct}%`, runoff: Math.round(x.runoff), available: Math.round(x.available), coverage: `${x.coverage.toFixed(2)}×`, days: x.days, result: x.covered ? 'Covered' : `Short ${m(x.shortfall)}` })))],
          };
        },
      },
      {
        name: 'liq_ladder',
        description: 'The cash-flow ladder: inflows (loan payments, investment maturities) and outflows (share runoff, certificates that don’t renew, borrowings) over 30, 90, 180 and 365 days, with the cumulative position.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const a = await liq.analysis();
          const year = a.ladder[a.ladder.length - 1]!;
          const low = [...a.ladder].sort((x, y) => x.cumulative - y.cumulative)[0]!;
          return {
            text: `Over the next year, **${m(a.ladder.reduce((s, l) => s + l.inflows, 0))}** comes in from loan payments and maturing investments and **${m(a.ladder.reduce((s, l) => s + l.outflows, 0))}** goes out in share runoff, certificates that don’t renew and borrowings. Starting from cash, the cumulative position stays positive, at its lowest **${m(low.cumulative)}** (${low.label}) and **${m(year.cumulative)}** at a year.`,
            blocks: [moduleTable(spec, 'Cash-flow ladder', ctx.runId, 'liq.ladder', [{ field: 'band', headerName: 'Band', type: 'text' }, { field: 'inflows', headerName: 'Inflows', type: 'currency' }, { field: 'outflows', headerName: 'Outflows', type: 'currency' }, { field: 'net', headerName: 'Net', type: 'currency' }, { field: 'cumulative', headerName: 'Cumulative, from cash', type: 'currency' }], a.ladder.map((l) => ({ band: l.label, inflows: Math.round(l.inflows), outflows: Math.round(l.outflows), net: Math.round(l.net), cumulative: Math.round(l.cumulative) })))],
          };
        },
      },
      {
        name: 'liq_funding',
        description: 'For a bank, after SVB: can it survive 30 days of withdrawals without selling assets at a loss? Uninsured, severe and even runs met from loss-free sources (cash, loan payments, borrowing against loans and securities), the loss if securities were sold instead, and the LCR and NSFR estimates.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const f = await bankOnly().analysis();
          if (!f) throw new CoreError('NOT_FOUND', 'There’s no FFIEC Call Report on file yet.');
          const [u, sev] = f.scenarios;
          const yes = f.scenarios.every((x) => x.covered);
          return {
            text: `${yes ? '**Yes.**' : '**Not in every scenario.**'} If ${u!.uninsuredPct}% of uninsured and ${u!.insuredPct}% of insured deposits left within 30 days (**${m(u!.runoff)}**), the bank could meet it from sources that realize no loss: ${m(f.lossFreeTotal)} in cash, loan payments and borrowing against loans and securities, enough for about ${u!.days} days at that pace. In a severe, SVB-like run (${sev!.uninsuredPct}% and ${sev!.insuredPct}%, ${m(sev!.runoff)}) ${sev!.covered ? 'it still could' : `it would be ${m(sev!.shortfall)} short`}. Selling securities instead, as SVB did, would realize **${m(sev!.sale.loss)}** of the **${m(f.unrealized.total)}** unrealized loss, ${p1(sev!.sale.capitalPct)} of tier 1 after tax. ${p1(f.uninsuredPct)} of deposits are uninsured. Estimated LCR **${f.lcr.pct.toFixed(0)}%** and NSFR **${f.nsfr.pct.toFixed(0)}%** (100% is the minimum where the rules apply). DI’s estimates from the Call Report.`,
            blocks: [
              moduleTable(spec, 'Thirty days of withdrawals, without selling at a loss', ctx.runId, 'liquidity.funding', [{ field: 'scenario', headerName: 'Scenario', type: 'text' }, { field: 'runoff', headerName: 'Leaves in 30 days', type: 'currency' }, { field: 'covered', headerName: 'Met without a sale?', type: 'text' }, { field: 'days', headerName: 'Days the sources last', type: 'text' }, { field: 'loss', headerName: 'Loss if sold instead', type: 'currency' }, { field: 'capital', headerName: 'Of tier 1', type: 'text' }], f.scenarios.map((x) => ({ scenario: `${x.name} (${x.uninsuredPct}% uninsured, ${x.insuredPct}% insured)`, runoff: Math.round(x.runoff), covered: x.covered ? 'Yes' : `No, ${m(x.shortfall)} short`, days: x.days >= 365 ? 'A year or more' : `${x.days} days`, loss: Math.round(x.sale.loss), capital: p1(x.sale.capitalPct) }))),
              moduleTable(spec, 'Sources that realize no loss, in order', ctx.runId, 'liquidity.funding.sources', [{ field: 'source', headerName: 'Source', type: 'text' }, { field: 'available', headerName: 'Available', type: 'currency' }, { field: 'used', headerName: `Used in the ${u!.name.toLowerCase()}`, type: 'currency' }], u!.used.map((x) => ({ source: x.source, available: Math.round(x.available), used: Math.round(x.used) }))),
            ],
            suggestions: ['What if 60% of uninsured deposits leave?', 'What’s our LCR and NSFR?', 'What are our unrealized losses?'],
          };
        },
      },
      {
        name: 'liq_run',
        description: 'A bank’s deposit run with the shares given: uninsured_pct of uninsured and insured_pct of insured deposits leave in 30 days (insured_pct is 5 when the user gives none; never ask for it). Whether loss-free sources meet it, how long they last, and the loss if securities were sold instead.',
        input: z.object({ uninsured_pct: z.number().min(1).max(100), insured_pct: z.number().min(0).max(100).optional() }).strict(),
        run: async (given: { uninsured_pct: number; insured_pct?: number }, ctx) => {
          guard(ctx);
          // A question that names only the uninsured share keeps the standard 5% of insured deposits.
          const a = { uninsured_pct: given.uninsured_pct, insured_pct: given.insured_pct ?? 5 };
          const f = await bankOnly().analysis({ uninsuredPct: a.uninsured_pct, insuredPct: a.insured_pct });
          if (!f) throw new CoreError('NOT_FOUND', 'There’s no FFIEC Call Report on file yet.');
          const x = f.scenarios.find((s) => s.key === 'custom')!;
          const short = x.used.filter((s) => s.used > 0);
          return {
            text: `If ${a.uninsured_pct}% of uninsured and ${a.insured_pct}% of insured deposits left within 30 days, **${m(x.runoff)}** would go. ${x.covered ? `The bank could meet it without selling anything at a loss, using ${short.map((s) => `${inSentence(s.source)} (${m(s.used)})`).join(', ')}; the loss-free sources would last about ${x.days >= 365 ? 'a year or more' : `${x.days} days`} at that pace.` : `Loss-free sources (${m(x.lossFree)}) fall **${m(x.shortfall)} short**, so securities would have to be sold.`} Selling securities instead would realize about **${m(x.sale.loss)}** of loss, ${p1(x.sale.capitalPct)} of tier 1 after tax.`,
            blocks: [moduleTable(spec, `Run: ${a.uninsured_pct}% of uninsured, ${a.insured_pct}% of insured`, ctx.runId, 'liquidity.funding.run', [{ field: 'source', headerName: 'Source, in order', type: 'text' }, { field: 'available', headerName: 'Available', type: 'currency' }, { field: 'used', headerName: 'Used', type: 'currency' }], x.used.map((s) => ({ source: s.source, available: Math.round(s.available), used: Math.round(s.used) })))],
            suggestions: ['Can we survive 30 days of withdrawals without selling assets at a loss?', 'What are our unrealized losses?'],
          };
        },
      },
      {
        name: 'liq_deposits',
        description: 'A bank’s deposit book: the mix by product (balance, share, rate, measured and rising-rate beta), uninsured deposits from the Call Report and their trend against DI’s watch levels, noninterest-bearing deposits, brokered deposits and the largest depositors.',
        input: z.object({ question: z.enum(['mix', 'uninsured']).optional().describe('What was asked: mix (the default) or uninsured (how much of our deposits are uninsured?)') }).strict(),
        run: async (a: { question?: 'mix' | 'uninsured' }, ctx) => {
          guard(ctx);
          const d = await bankOnly().deposits();
          if (!d) throw new CoreError('NOT_FOUND', 'There’s no FFIEC Call Report on file yet.');
          const level = d.uninsuredPct >= d.levels.concern ? `at or above ${d.levels.concern}%, a concern` : d.uninsuredPct >= d.levels.watch ? `above DI’s ${d.levels.watch}% watch level` : `below DI’s ${d.levels.watch}% watch level`;
          const lead = a.question === 'uninsured' ? `**${p1(d.uninsuredPct)} of deposits are uninsured: ${m(d.uninsured)}.**` : `**${d.mix.map((x) => `${x.product.replace(/ of Deposit$/, 's').toLowerCase()} ${p1(x.sharePct)}`).join(', ')}.**`;
          const trend = d.uninsuredYearAgo ? ` A year ago it was ${p1(d.uninsuredYearAgo.pct)} (${m(d.uninsuredYearAgo.uninsured)}).` : '';
          const rateSensitive = d.mix.filter((x) => x.term || x.betaRising >= 0.5).reduce((s, x) => s + x.sharePct, 0);
          return {
            text: `${lead} ${a.question === 'uninsured' ? `That’s the Call Report’s estimate of deposits over the $250,000 insurance limit, out of **${m(d.deposits)}**, ${level}; SVB’s was about 90%.` : `Deposits are **${m(d.deposits)}** on the Call Report; **${m(d.uninsured)}** (${p1(d.uninsuredPct)}) is over the $250,000 insurance limit, ${level}; SVB’s was about 90%.`}${trend} By product, ${d.mix.map((x) => `${x.product.toLowerCase()} ${m(x.balance)} (${p1(x.sharePct)}) at ${x.ratePct.toFixed(2)}%`).join(', ')}, an average cost of ${d.costNowPct.toFixed(2)}%. ${p1(rateSensitive)} is rate-sensitive (certificates and money market), and ${p1(d.noInterestPct)} pays no interest. Brokered deposits are ${m(d.brokered)}; the 20 largest depositors hold ${m(d.top20)}, ${p1(d.top20Pct)} of deposits.${d.measuredBeta !== null ? ` On the last rate move the deposit beta was ${d.measuredBeta.toFixed(2)}; on the way up the model uses a higher one for money market (0.55), and certificates reprice in full as they mature.` : ''}`,
            blocks: [
              moduleTable(spec, 'Deposit mix', ctx.runId, 'liquidity.deposits.mix', [{ field: 'product', headerName: 'Product', type: 'text' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'share', headerName: 'Share', type: 'text' }, { field: 'rate', headerName: 'Rate paid', type: 'text' }, { field: 'measured', headerName: 'Beta, last move', type: 'text' }, { field: 'rising', headerName: 'Beta if rates rise', type: 'text' }, { field: 'due', headerName: 'Maturing in 12 months', type: 'currency' }], d.mix.map((x) => ({ product: x.product, balance: Math.round(x.balance), share: p1(x.sharePct), rate: `${x.ratePct.toFixed(2)}%`, measured: x.betaMeasured === null ? '—' : x.betaMeasured.toFixed(2), rising: x.term ? 'At maturity' : x.betaRising.toFixed(2), due: Math.round(x.dueIn12) }))),
              moduleTable(spec, 'Uninsured deposits, by quarter', ctx.runId, 'liquidity.deposits.uninsured', [{ field: 'quarter', headerName: 'Quarter', type: 'text' }, { field: 'deposits', headerName: 'Deposits', type: 'currency' }, { field: 'uninsured', headerName: 'Uninsured', type: 'currency' }, { field: 'pct', headerName: 'Of deposits', type: 'text' }], [...d.uninsuredTrend].reverse().map((q) => ({ quarter: `Q${Math.ceil(Number(q.end.slice(5, 7)) / 3)} ${q.end.slice(0, 4)}`, deposits: Math.round(q.deposits), uninsured: Math.round(q.uninsured), pct: p1(q.pct) }))),
            ],
            suggestions: ['How fast will deposits leave if rates rise?', 'Can we survive 30 days of withdrawals without selling assets at a loss?'],
          };
        },
      },
      {
        name: 'liq_rates_up',
        description: 'A bank’s deposits if rates rise 100, 200 or 300 bp over the next 12 months: how much leaves (usual decay plus rate-driven outflow, uninsured fastest), how much more the rest costs, and whether loss-free sources cover the outflow.',
        input: z.object({ shock_bp: z.number().int().refine((n) => [100, 200, 300].includes(n), 'Use 100, 200 or 300.').optional() }).strict(),
        run: async (a: { shock_bp?: number }, ctx) => {
          guard(ctx);
          const d = await bankOnly().deposits();
          if (!d) throw new CoreError('NOT_FOUND', 'There’s no FFIEC Call Report on file yet.');
          const bp = a.shock_bp ?? 200;
          const x = d.scenarios.find((s) => s.bp === bp)!;
          const fastest = [...x.lines].sort((p, q) => q.rate - p.rate)[0]!;
          return {
            text: `**About ${m(x.leaves)} (${p1(x.leavesPct)}) within 12 months if rates rise ${bp} bp**, against ${m(d.base.leaves)} in a year with no rise: ${m(x.rateDriven)} more leaves because rates rose, ${m(x.uninsuredLeaves)} of it uninsured money chasing yield, and the most from ${fastest.product.toLowerCase()} (${m(fastest.rate)}). The deposits that stay would cost about **${x.costAfterPct.toFixed(2)}%**, up from ${d.costNowPct.toFixed(2)}%, ${m(x.added)} more interest in the year. ${x.covered ? `Loss-free sources (${m(x.lossFree)}: cash, loan payments and borrowing) cover that outflow without selling securities.` : `That outflow is more than the ${m(x.lossFree)} of loss-free sources, so securities would have to be sold or more borrowed.`} ${p1(d.uninsuredPct)} of deposits are uninsured. These are DI’s estimates with the rate-risk model’s decay and betas, shown in the assumptions.`,
            blocks: [
              moduleTable(spec, 'Deposits if rates rise, over 12 months', ctx.runId, 'liquidity.deposits.ratesUp', [{ field: 'shock', headerName: 'Rates rise', type: 'text' }, { field: 'leaves', headerName: 'Deposits leaving', type: 'currency' }, { field: 'pct', headerName: 'Of deposits', type: 'text' }, { field: 'rate', headerName: 'Because rates rose', type: 'currency' }, { field: 'cost', headerName: 'Cost of the rest', type: 'text' }, { field: 'added', headerName: 'Added interest', type: 'currency' }, { field: 'covered', headerName: 'Covered without a sale?', type: 'text' }], [d.base, ...d.scenarios].map((s) => ({ shock: s.bp ? `+${s.bp} bp` : 'No change', leaves: Math.round(s.leaves), pct: p1(s.leavesPct), rate: Math.round(s.rateDriven), cost: `${s.costAfterPct.toFixed(2)}%`, added: Math.round(s.added), covered: s.covered ? 'Yes' : 'No' }))),
              moduleTable(spec, `By product, +${bp} bp`, ctx.runId, 'liquidity.deposits.ratesUp.products', [{ field: 'product', headerName: 'Product', type: 'text' }, { field: 'base', headerName: 'Usual decay', type: 'currency' }, { field: 'rate', headerName: 'Because rates rose', type: 'currency' }, { field: 'added', headerName: 'Added interest', type: 'currency' }], [...x.lines.map((l) => ({ product: l.product, base: Math.round(l.base), rate: Math.round(l.rate), added: Math.round(l.added) })), { product: 'Uninsured, on top', base: 0, rate: Math.round(x.uninsuredLeaves), added: 0 }]),
            ],
            suggestions: ['What’s our deposit mix?', 'Can we survive 30 days of withdrawals without selling assets at a loss?'],
          };
        },
      },
      {
        name: 'liq_ltd',
        description: 'A bank’s loan-to-deposit ratio from the Call Report against the 80% to 100% band (below: deposits sit idle; above: loans funded with wholesale borrowing), the wholesale funding (FHLB and other borrowings, brokered deposits) and its cost against deposits, plan, peers and five quarters.',
        input: z.object({ question: z.enum(['band', 'wholesale', 'room', 'cost']).optional().describe('What was asked: band (too low or too high?, the default), wholesale (are loans funded with wholesale borrowing?), room (how much could we lend?), cost (what does wholesale funding cost?)') }).strict(),
        run: async (a: { question?: 'band' | 'wholesale' | 'room' | 'cost' }, ctx) => {
          guard(ctx);
          const l = await bankOnly().loanToDeposit();
          if (!l) throw new CoreError('NOT_FOUND', 'There’s no FFIEC Call Report on file yet.');
          const quarter = new Date(`${l.asOf}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
          const where =
            l.band.zone === 'idle'
              ? `below the ${l.band.low}% to ${l.band.high}% band: about **${m(l.idle)}** of deposits could be lent before reaching ${l.band.low}%, money now sitting in cash and securities at lower yields`
              : l.band.zone === 'wholesale'
                ? `above ${l.band.high}%: deposits don’t cover **${m(l.gap)}** of loans, so wholesale borrowing funds them, which costs more and can be pulled`
                : `within the ${l.band.low}% to ${l.band.high}% band, with **${m(l.roomTo100)}** of room to lend before loans pass deposits`;
          const refs = [l.plan !== null ? `plan ${p1(l.plan)}` : '', l.peer !== null ? `peers ${p1(l.peer)}` : ''].filter(Boolean).join(', ');
          const cost = l.borrowingCostPct !== null && l.depositCostPct !== null ? ` Borrowings cost about **${l.borrowingCostPct.toFixed(2)}%** against **${l.depositCostPct.toFixed(2)}%** for deposits.` : '';
          const core = l.beyondCore > 0 ? ` Against core deposits (excluding brokered), it is ${p1(l.corePct)}: ${m(l.beyondCore)} of loans rest on wholesale funding.` : ` Against core deposits (excluding brokered), it is ${p1(l.corePct)}, so core deposits cover every loan.`;
          // The direct answer to what was asked comes first, then the figures behind it.
          const lead = {
            band: l.band.zone === 'idle' ? '**Too low.**' : l.band.zone === 'wholesale' ? '**Too high.**' : '**Within the band.**',
            wholesale: l.beyondCore > 0 ? `**Yes, for ${m(l.beyondCore)} of loans.**` : '**No.** Core deposits cover every loan.',
            room: `**About ${m(l.idle)} before 80%**, and ${m(l.roomTo100)} before loans pass deposits.`,
            cost: l.borrowingCostPct !== null && l.depositCostPct !== null ? `**About ${l.borrowingCostPct.toFixed(2)}%**, against ${l.depositCostPct.toFixed(2)}% for deposits.` : '',
          }[a.question ?? 'band'];
          return {
            text: `${lead ? `${lead} ` : ''}Loan-to-deposit is **${p1(l.pct)}** on the ${quarter} Call Report (${m(l.loans)} of loans, ${m(l.deposits)} of deposits), ${where}.${refs ? ` ${refs.charAt(0).toUpperCase()}${refs.slice(1)}.` : ''}${l.yearAgo ? ` A year ago it was ${p1(l.yearAgo.pct)}.` : ''} Wholesale funding is **${m(l.wholesale)}**, ${p1(l.wholesaleSharePct)} of funding: ${m(l.borrowings)} of FHLB advances and other borrowings and ${m(l.brokered)} of brokered deposits.${cost}${core}`,
            blocks: [
              moduleTable(
                spec,
                'Loan-to-deposit and wholesale funding, by quarter',
                ctx.runId,
                'liquidity.ltd',
                [
                  { field: 'quarter', headerName: 'Quarter', type: 'text' },
                  { field: 'loans', headerName: 'Loans', type: 'currency' },
                  { field: 'deposits', headerName: 'Deposits', type: 'currency' },
                  { field: 'ltd', headerName: 'Loan-to-deposit', type: 'text' },
                  { field: 'core', headerName: 'On core deposits', type: 'text' },
                  { field: 'wholesale', headerName: 'Wholesale funding', type: 'currency' },
                  { field: 'share', headerName: 'Of funding', type: 'text' },
                ],
                [...l.trend].reverse().map((q) => ({ quarter: `Q${Math.ceil(Number(q.end.slice(5, 7)) / 3)} ${q.end.slice(0, 4)}`, loans: Math.round(q.loans), deposits: Math.round(q.deposits), ltd: p1(q.pct), core: p1(q.corePct), wholesale: Math.round(q.wholesale), share: p1(q.wholesaleSharePct) })),
              ),
            ],
            suggestions: l.band.zone === 'idle' ? ['How much could we borrow tomorrow?', 'Chart our loan-to-deposit ratio by quarter'] : ['Can we survive 30 days of withdrawals without selling assets at a loss?', 'What’s our cost of funds?'],
          };
        },
      },
      {
        name: 'liq_lcr',
        description: 'A bank’s liquidity coverage ratio (high-quality liquid assets over 30 days of stressed net outflows) and net stable funding ratio (available over required stable funding), estimated with the standard weights from the Call Report, with their parts.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const svc = bankOnly();
          const f = await svc.analysis();
          if (!f) throw new CoreError('NOT_FOUND', 'There’s no FFIEC Call Report on file yet.');
          const l = f.lcr;
          return {
            text: `Estimated **LCR ${l.pct.toFixed(0)}%**: ${m(l.hqla)} of high-quality liquid assets (${m(l.level1)} level 1, ${m(l.level2)} level 2) against ${m(l.net)} of net outflows over a 30-day stress. Estimated **NSFR ${f.nsfr.pct.toFixed(0)}%**: ${m(f.nsfr.asf)} of available stable funding against ${m(f.nsfr.rsf)} required. Both are above the 100% minimum. The US rules apply from $100 billion of assets, so this bank doesn’t file them; these are DI’s estimates with the standard weights, shown in the assumptions.`,
            blocks: [
              moduleTable(spec, 'LCR: 30 days of stressed outflows', ctx.runId, 'liquidity.lcr', [{ field: 'item', headerName: 'Item', type: 'text' }, { field: 'amount', headerName: 'Amount', type: 'currency' }], [
                { item: 'Level 1: currency, Federal Reserve balances, Treasuries, Ginnie Mae', amount: Math.round(l.level1) },
                { item: 'Level 2: agency MBS at 85%, GO munis at 50%, after the caps', amount: Math.round(l.level2) },
                { item: 'High-quality liquid assets', amount: Math.round(l.hqla) },
                { item: 'Outflow: insured deposits, 3%', amount: Math.round(l.lines.insured) },
                { item: 'Outflow: uninsured retail deposits, 10%', amount: Math.round(l.lines.uninsuredRetail) },
                { item: 'Outflow: operational business deposits, 25%', amount: Math.round(l.lines.operational) },
                { item: 'Outflow: other business deposits, 40%', amount: Math.round(l.lines.nonOperational) },
                { item: 'Outflow: unused lines drawn', amount: Math.round(l.lines.retailLines + l.lines.creditLines) },
                { item: 'Inflow: half of 30 days’ loan payments', amount: Math.round(l.inflows) },
                { item: 'Net outflows', amount: Math.round(l.net) },
              ]),
              moduleTable(spec, 'NSFR: a year out', ctx.runId, 'liquidity.nsfr', [{ field: 'item', headerName: 'Item', type: 'text' }, { field: 'amount', headerName: 'Weighted amount', type: 'currency' }], [
                { item: 'Available: equity, 100%', amount: Math.round(f.nsfr.asfLines.capital) },
                { item: 'Available: insured deposits, 95%', amount: Math.round(f.nsfr.asfLines.insured) },
                { item: 'Available: uninsured retail deposits, 90%', amount: Math.round(f.nsfr.asfLines.uninsuredRetail) },
                { item: 'Available: business deposits, 50%', amount: Math.round(f.nsfr.asfLines.wholesale) },
                { item: 'Available: borrowings, 50%', amount: Math.round(f.nsfr.asfLines.borrowings) },
                { item: 'Required: loans (mortgages 65%, others 85%, nonperforming 100%)', amount: Math.round(f.nsfr.rsfLines.mortgages + f.nsfr.rsfLines.otherLoans + f.nsfr.rsfLines.nonperforming) },
                { item: 'Required: securities (agency 15%, munis 50%)', amount: Math.round(f.nsfr.rsfLines.level2a + f.nsfr.rsfLines.level2b) },
                { item: 'Required: premises, other assets and unused commitments', amount: Math.round(f.nsfr.rsfLines.fixedAndOther + f.nsfr.rsfLines.commitments) },
              ]),
              moduleTable(spec, 'Funding test assumptions', ctx.runId, 'liquidity.funding.assumptions', [{ field: 'item', headerName: 'Assumption', type: 'text' }, { field: 'detail', headerName: 'Detail', type: 'text' }], svc.assumptions().map(([item, detail]) => ({ item, detail }))),
            ],
            suggestions: ['Can we survive 30 days of withdrawals without selling assets at a loss?'],
          };
        },
      },
      {
        name: 'liq_unrealized',
        description: 'A bank’s unrealized securities losses, held-to-maturity and available-for-sale, against tier 1 capital, and the leverage ratio if they were realized by selling.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const f = await bankOnly().analysis();
          if (!f) throw new CoreError('NOT_FOUND', 'There’s no FFIEC Call Report on file yet.');
          return {
            text: `The securities are worth **${m(f.securities.fair)}** against a book value of ${m(f.securities.book)}: an unrealized loss of **${m(f.unrealized.total)}** (${m(f.unrealized.afs)} available for sale, ${m(f.unrealized.htm)} held to maturity), **${p1(f.capital.lossToTier1Pct)} of tier 1 capital**. Sold today, the loss after tax would take the tier 1 leverage ratio from ${p1(f.capital.leveragePct)} to **${p1(f.capital.leverageIfRealizedPct)}**. Borrowing against them instead realizes nothing: ${m(f.securities.unpledgedFair)} of them are unpledged.`,
            blocks: [moduleTable(spec, 'Unrealized losses against capital', ctx.runId, 'liquidity.unrealized', [{ field: 'item', headerName: 'Item', type: 'text' }, { field: 'value', headerName: 'Value', type: 'text' }], [
              { item: 'Securities at book value', value: m(f.securities.book) },
              { item: 'At fair value', value: m(f.securities.fair) },
              { item: 'Unrealized loss: available for sale', value: m(f.unrealized.afs) },
              { item: 'Unrealized loss: held to maturity', value: m(f.unrealized.htm) },
              { item: 'Total, as a share of tier 1', value: `${m(f.unrealized.total)} (${p1(f.capital.lossToTier1Pct)})` },
              { item: 'Tier 1 leverage ratio now', value: p1(f.capital.leveragePct) },
              { item: 'If every loss were realized, after tax', value: p1(f.capital.leverageIfRealizedPct) },
              { item: 'Pledged already', value: m(f.securities.pledged) },
            ])],
            suggestions: ['Can we survive 30 days of withdrawals without selling assets at a loss?'],
          };
        },
      },
      {
        name: 'liq_assumptions',
        description: 'The assumptions: what counts as liquid, the ladder’s behaviour, lendable values for each source, the stress order.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          guard(ctx);
          const a = await liq.analysis();
          return { text: 'DI uses typical lendable values and the IRR model’s cash flows. Your FHLB statement and Reserve Bank pledges give the actual capacity.', blocks: [moduleTable(spec, 'Assumptions', ctx.runId, 'liq.assumptions', [{ field: 'item', headerName: 'Assumption', type: 'text' }, { field: 'detail', headerName: 'What DI uses', type: 'text' }], a.assumptions.map(([item, detail]) => ({ item, detail })))] };
        },
      },
    ],
  };
  return spec;
}
