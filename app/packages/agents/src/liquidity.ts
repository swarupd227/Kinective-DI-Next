// Liquidity on the shared module agent: the liquidity ratios, the cash-flow ladder, borrowing capacity by
// source and survival under share runoff. Read-only, and honest that capacity is DI's estimate.
import { z } from 'zod';
import { CoreError, pctAgainst, type LiquidityService } from '@dinext/di-core';
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

export function liquidityModule(liq: LiquidityService): ModuleSpec {
  const spec: ModuleSpec = {
    id: 'liquidity',
    prefix: 'liq',
    agent: 'Liquidity',
    request: /\bliquidity\b|\bborrowing capacity\b|\bhow much (could|can) we borrow\b|\bfhlb\b|\bdiscount window\b|\bcontingency funding\b|\b(deposit|share) (run|runoff|run-off|outflows?)\b|\brun on (deposits|shares)\b|\bclf\b|\bcorporate (credit union )?line\b|\bcash.flow ladder\b|\bliquid assets\b|\bsurvive\b.*\b(run|outflow|leave)/i,
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'Loans, shares, investments and borrowings', ref: 'table:cdm_loan' }],
    prompt: ({ tenant, user, title }) => `You are the Liquidity agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) manages liquidity for the ALCO and the contingency funding plan. DI estimates on-balance-sheet liquidity, a 30/90/180/365-day cash-flow ladder, borrowing capacity (FHLB, the Federal Reserve discount window, unpledged securities, the corporate or correspondent line) and survival under share runoff. Capacity uses typical lendable values; the FHLB's and Reserve Bank's own collateral rules set the real figures, so say it is an estimate.

- "How is our liquidity?", "are we within policy?": liq_summary.
- "How much could we borrow tomorrow?", "what's our FHLB capacity?": liq_capacity.
- "Can we survive a 20% deposit run?": liq_stress with runoff_pct.
- "Show the cash-flow ladder": liq_ladder.
- "What assumptions?": liq_assumptions.
- You only read, and give no investment advice.`,
    plan: (text) => {
      const t = text.toLowerCase();
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
            text: `DI estimates **${m(a.contingent)}** could be raised quickly beyond liquid assets. The largest source is ${top.source.toLowerCase()}, **${m(top.available)}** available${top.used ? ` after ${m(top.used)} already drawn` : ''}.${a.clf ? ` ${a.clf}` : ''} These are estimates at typical lendable values; the FHLB’s and the Reserve Bank’s collateral rules and actual pledges set the real figures.`,
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
            text: `If ${s.pct}% of shares (**${m(s.runoff)}**) left within 30 days, ${s.covered ? `available liquidity of ${m(s.available)} would cover it **${s.coverage.toFixed(1)} times**, for about **${s.days} days** at that pace` : `available liquidity would fall **${m(s.shortfall)} short**`}. It would draw on ${s.used.map((u) => `${u.name.toLowerCase()} (${m(u.amount)})`).join(', then ')}.`,
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
