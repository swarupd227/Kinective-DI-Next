// Profitability and the allowance by segment, as report sections and as answers. Contribution is by
// funds transfer pricing, before overhead; the allowance reconciles to the latest filed Call Report.
// Read-only, and plain that the FTP curve, loss rates and costs are DI's standard assumptions until the
// institution's own replace them.
import { z } from 'zod';
import type { Block, TableBlock } from '@dinext/block-schemas';
import { CoreError, type ProfitabilityService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

type Cols = TableBlock['data']['columns'];
const m = (n: number) => `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(2)}M`;
const p2 = (n: number) => `${n.toFixed(2)}%`;
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const money = (field: string, headerName: string) => ({ field, headerName, type: 'currency' as const });
const NO_ACCESS = 'Profitability isn’t part of your DI access. It is for finance and executives.';
const allowed = (modules: string[]) => modules.includes('profitability') || modules.includes('irr');

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
          ...(best ? { take: { headline: `Products contribute ${m(a.total)} a year before overhead. ${best.name} leads at ${m(best.contribution)}, ${p2(best.marginPct)} on its balance${worst && worst.contribution < 0 ? `; ${worst.name} loses ${m(-worst.contribution)} after its credit and servicing costs` : ''}.`, action: { label: 'Which branches contribute most?', ask: 'Which branches contribute the most?' } } } : {}),
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

export function profitabilityModule(svc: ProfitabilityService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!allowed(ctx.modules)) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const spec: ModuleSpec = {
    id: 'profitability',
    prefix: 'profit',
    agent: 'Profitability',
    request: /\bprofitab|\bcontribution\b|\bmost profitable\b|\bmake (the most )?money\b|\blose money\b|\bftp\b|funds transfer pricing|\ballowance by (segment|pool|loan type|product)\b|\bcecl pools?\b|\breserves? by (segment|pool|loan type|product)\b|\bwhere is the allowance\b/i,
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'Loans and deposits, with DI’s FTP assumptions', ref: 'table:cdm_loan' }],
    prompt: ({ tenant, user, title }) => `You are the Profitability agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) asks which products and branches make money and where the allowance sits. Contribution is by funds transfer pricing, before overhead, on today's balances; the FTP curve, loss rates and costs are DI's standard assumptions until the institution's own replace them. The allowance by segment reconciles to the latest filed Call Report.

- "Which products are most profitable?", "what does auto lending contribute?": profit_products.
- "Which branches contribute the most?": profit_branches.
- "Where is the allowance?", "allowance by segment": profit_allowance.
- "How is profitability calculated?": profit_assumptions.
- You are read-only.`,
    plan: (text) => {
      const t = text.toLowerCase();
      if (/allowance|reserve|cecl/.test(t)) return { tool: 'profit_allowance', args: {} };
      if (/how (is|are|do you)|calculat|assum|method|ftp|transfer pric/.test(t)) return { tool: 'profit_assumptions', args: {} };
      if (/branch/.test(t)) return { tool: 'profit_branches', args: {} };
      return { tool: 'profit_products', args: {} };
    },
    tools: [
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
            text: `Products contribute **${m(a.total)} a year** before overhead: ${m(loans.reduce((s, l) => s + l.contribution, 0))} from loans and ${m(deps.reduce((s, l) => s + l.contribution, 0))} from deposits. **${best.name}** contributes the most, ${m(best.contribution)}.${bestMargin ? ` The best margin on balance is ${bestMargin.name.toLowerCase()} at ${p2(bestMargin.marginPct)}.` : ''}${losers.length ? ` ${losers.map((l) => `${l.name} loses ${m(-l.contribution)}`).join('; ')}, after ${losers.length === 1 ? 'its' : 'their'} credit and servicing costs.` : ''} This uses DI’s standard FTP curve, loss rates and costs; your own allocations would replace them.`,
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
