// Predictive Analytics across the book: the products the next-best-product model suggests, by deposit
// balance band (DI's "Products to Suggest"), the people behind any count ("Accounts $10,000+ likely to
// open a mortgage"), and whether earlier suggestions were taken up ("Successful Suggestions"). One
// member's suggestions stay with Relationship Manager.
import { z } from 'zod';
import { BALANCE_BANDS, CoreError, HIGH_LIKELIHOOD, PredictiveService, type BalanceBand, type ProfitabilityService } from '@dinext/di-core';
import type { Pool } from '@dinext/tenant-db';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const PREDICTIVE_REQUEST =
  /\bproducts? to suggest\b|\bsuccessful suggestions?\b|\bsuggestions? (?:that |which )?(?:worked|converted|were (?:taken up|accepted|opened)|paid off|led to)\b|\b(?:were|are) (?:our |the )?suggestions? (?:taken up|working|converting)\b|\b(?:take|took)-?up (?:of|on) (?:our |the )?suggestions?\b|\b(?:how (?:accurate|good|well)|does) (?:is |are )?(?:the |our )?(?:next[- ]best[- ]product|suggestion|propensity) (?:model|scores?)\b|\bnext[- ]best[- ]products? (?:across|for (?:the|our) (?:book|members|customers)|by (?:balance|product)|report|rollup)\b|\b(?:members|customers|accounts|who)(?: with [^.?!]{0,30})? (?:are )?(?:most )?likely to (?:open|buy|take|get)\b|\bpropensity (?:scores?|list|report)\b|\bconversion (?:rate )?(?:of|on|for) (?:our |the )?suggestions?\b|\b(?:member|customer) profitab(?:le|ility)\b|\b(?:most|least) profitable (?:members|customers|people)\b|\bprofitability (?:per|by) (?:member|customer)\b|\bunprofitable (?:members|customers)\b|\broot causes? of (?:attrition|attrition risk)\b|\bwhy (?:are )?(?:people|members|customers) at risk\b|\b(?:attrition|attrition risk) (?:reasons|drivers|causes)\b|\breasons for attrition risk\b/i;

const NO_ACCESS = 'Predictive Analytics isn’t part of your DI access.';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const count = (n: number) => Math.round(n).toLocaleString('en-US');
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const p1 = (n: number) => `${n.toFixed(1)}%`;
const longDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const monthOf = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The product a question names, as the model names it. */
const PRODUCTS: [RegExp, string][] = [
  [/heloc|home equity/i, 'HELOC'],
  [/mortgage/i, 'First mortgage'],
  [/auto|car loan/i, 'Auto loan'],
  [/credit card|\bcards?\b/i, 'Credit card'],
  [/certificate|\bcds?\b|share certificate/i, 'Certificate'],
  [/business account/i, 'Business account'],
  [/checking/i, 'Checking'],
];
export const productIn = (t: string) => PRODUCTS.find(([re]) => re.test(t))?.[1];

/** A balance band a question names: "$10,000+", "over $1,000", "10k plus". */
export function bandIn(t: string): BalanceBand | undefined {
  const s = t.toLowerCase().replace(/,/g, '');
  if (/(?:\$?10(?:000|k)\s*(?:\+|plus|or more)|over \$?10(?:000|k)|more than \$?10(?:000|k))/.test(s)) return '$10,000+';
  if (/(?:\$?1(?:000|k)\s*(?:\+|plus|or more|to)|over \$?1(?:000|k)\b)/.test(s)) return '$1,000 to $9,999';
  if (/\$?100\s*(?:\+|plus|to)/.test(s)) return '$100 to $999';
  if (/negative|below \$?0|overdrawn/.test(s)) return 'Below $0';
  return undefined;
}

export type PredictiveQuestion = 'suggest' | 'people' | 'success';
export function predictiveQuestion(t: string): PredictiveQuestion {
  if (/success|worked|converted|taken up|take-?up|accepted|paid off|led to|how (?:accurate|good|well)|conversion/i.test(t)) return 'success';
  if (productIn(t) && /\b(?:who|which|list|show|members|customers|accounts|likely)\b/i.test(t) && !/products? to suggest/i.test(t)) return 'people';
  return 'suggest';
}

export function predictiveModule(svc: PredictiveService, person: 'member' | 'customer' = 'member', profit?: { svc: ProfitabilityService; pool: Pool } | null): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('predictive')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const sources: ModuleSpec['sources'] = [
    { kind: 'table', label: 'Next best product scores', ref: 'table:cdm_suggestion' },
    { kind: 'table', label: 'Suggestion history', ref: 'table:cdm_suggestion_history' },
    { kind: 'table', label: 'Deposit accounts', ref: 'table:cdm_deposit_account' },
  ];
  const spec: ModuleSpec = {
    id: 'predictive',
    prefix: 'pred',
    agent: 'Predictive Analytics',
    request: PREDICTIVE_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the Predictive Analytics agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) uses the next-best-product model across the book: which products to suggest to whom, and whether earlier suggestions were taken up. A suggestion scored ${HIGH_LIKELIHOOD} or more (out of 10) is high-scoring. One person's suggestions belong to Relationship Manager.

- pred_suggest: high-scoring suggestions by product and deposit balance band.
- pred_people (product, optional band): the people behind one count, highest score first.
- pred_success: suggestions from earlier monthly runs and how many were opened within about 90 days, by product, by run and by score.
- pred_profit (show deciles, top or bottom): profitability per ${person}, yearly contribution before overhead from every account they own.
- pred_root_causes: why ${person}s are at risk of leaving, each attrition reason rolled up across the High and Medium bands.`,
    plan: (t) => {
      if (/\broot causes? of (?:attrition|attrition risk)\b|\bwhy (?:are )?(?:people|members|customers) at risk\b|\b(?:attrition|attrition risk) (?:reasons|drivers|causes)\b|\breasons for attrition risk\b/i.test(t)) return { tool: 'pred_root_causes', args: {} };
      if (profit && /\b(?:member|customer) profitab|\b(?:most|least) profitable (?:members|customers|people)\b|\bprofitability (?:per|by) (?:member|customer)\b|\bunprofitable (?:members|customers)\b/i.test(t)) return { tool: 'pred_profit', args: { show: /\bleast|unprofitable|lose money|losing\b/i.test(t) ? 'bottom' : /\bmost\b|\btop\b/i.test(t) ? 'top' : 'deciles' } };
      const q = predictiveQuestion(t);
      if (q === 'success') return { tool: 'pred_success', args: {} };
      if (q === 'people') {
        const band = bandIn(t);
        return { tool: 'pred_people', args: { product: productIn(t)!, ...(band ? { band } : {}) } };
      }
      return { tool: 'pred_suggest', args: {} };
    },
    tools: [
      ...(profit
        ? [
            {
              name: 'pred_profit',
              description: `Profitability per ${person}: each one's yearly contribution before overhead (interest, funding, expected loss, servicing and fees on every account they own), shown as the most and least profitable and as deciles, with the share of ${person}s who lose money.`,
              input: z.object({ show: z.enum(['top', 'bottom', 'deciles']).default('deciles') }).strict(),
              run: async (a: { show: 'top' | 'bottom' | 'deciles' }, ctx: ModuleContext) => {
                need(ctx);
                const all = (await profit.svc.members(ctx.purviewBranches ?? undefined)).sort((x, y) => y.contribution - x.contribution);
                if (!all.length) return { text: `No ${person}s with balances in your branches.` };
                const total = all.reduce((s, m) => s + m.contribution, 0);
                const losers = all.filter((m) => m.contribution < 0);
                const top10 = all.slice(0, Math.ceil(all.length / 10)).reduce((s, m) => s + m.contribution, 0);
                const lead = `Across **${count(all.length)} ${person}s**, yearly contribution before overhead is **${usd(total)}**. The top 10% bring **${p1((top10 / total) * 100)}** of it; **${count(losers.length)}** (${p1((losers.length / all.length) * 100)}) lose money, ${usd(-losers.reduce((s, m) => s + m.contribution, 0))} a year in all.`;
                if (a.show === 'deciles') {
                  const size = Math.ceil(all.length / 10);
                  const deciles = Array.from({ length: 10 }, (_, i) => all.slice(i * size, (i + 1) * size)).filter((d) => d.length).map((d, i) => ({ decile: `${i * 10 + 1} to ${Math.min(100, (i + 1) * 10)}%`, people: d.length, contribution: d.reduce((s, m) => s + m.contribution, 0), average: Math.round(d.reduce((s, m) => s + m.contribution, 0) / d.length), deposits: d.reduce((s, m) => s + m.deposits, 0), loans: d.reduce((s, m) => s + m.loans, 0) }));
                  return { text: lead, blocks: [moduleTable(spec, `Contribution by ${person} decile, most profitable first`, ctx.runId, 'predictive.profit.deciles', [text('decile', 'Decile'), { field: 'people', headerName: 'People', type: 'count' }, { field: 'contribution', headerName: 'Contribution a year', type: 'currency' }, { field: 'average', headerName: 'Average', type: 'currency' }, { field: 'deposits', headerName: 'Deposits', type: 'currency' }, { field: 'loans', headerName: 'Loans', type: 'currency' }], deciles)], suggestions: [`Who are our least profitable ${person}s?`, `Who are our most profitable ${person}s?`] };
                }
                const pick = (a.show === 'top' ? all.slice(0, 50) : all.slice(-50).reverse());
                const [names] = (await profit.pool.query('SELECT p.party_id, p.first_name, p.last_name, b.name AS branch, p.segment_code FROM cdm_party p JOIN cdm_location b ON b.int_id = p.primary_branch_id WHERE p.party_id IN (?)', [pick.map((m) => m.partyId)])) as unknown as [{ party_id: number; first_name: string; last_name: string; branch: string; segment_code: string }[]];
                const nameOf = new Map(names.map((n) => [n.party_id, n]));
                return {
                  text: lead,
                  blocks: [moduleTable(spec, a.show === 'top' ? `Most profitable ${person}s` : `Least profitable ${person}s`, ctx.runId, 'predictive.profit.members', [text('name', person === 'member' ? 'Member' : 'Customer'), text('branch', 'Branch'), text('segment', 'Segment'), { field: 'contribution', headerName: 'Contribution a year', type: 'currency' }, { field: 'deposits', headerName: 'Deposits', type: 'currency' }, { field: 'loans', headerName: 'Loans', type: 'currency' }, { field: 'accounts', headerName: 'Accounts', type: 'count' }], pick.map((m) => ({ name: nameOf.get(m.partyId) ? `${nameOf.get(m.partyId)!.first_name} ${nameOf.get(m.partyId)!.last_name}` : `#${m.partyId}`, branch: nameOf.get(m.partyId)?.branch ?? '', segment: nameOf.get(m.partyId)?.segment_code ?? '', contribution: m.contribution, deposits: m.deposits, loans: m.loans, accounts: m.accounts })))],
                };
              },
            },
          ]
        : []),
      {
        name: 'pred_root_causes',
        description: `Why ${person}s are at risk of leaving, rolled up across them: each attrition factor, how many in the High band (7+) and Medium band (5 to 6) it applies to, the share of the High band it explains, and the deposits they hold.`,
        input: z.object({}).strict(),
        run: async (_: unknown, ctx: ModuleContext) => {
          need(ctx);
          const x = await svc.rootCauses(ctx);
          if (!x.rows.length) return { text: `No ${person}s you can see score 5 or more for attrition.` };
          const top = x.rows[0]!;
          return {
            text: `**${count(x.highBand)} ${person}s** are in the High band and ${count(x.mediumBand)} in the Medium band. The most common reason in the High band is **${top.factor.toLowerCase()}**, for ${p1(top.highSharePct)} of them${x.rows[1] ? `, then ${x.rows[1].factor.toLowerCase()} (${p1(x.rows[1].highSharePct)})` : ''}.`,
            blocks: [moduleTable(spec, 'Reasons for attrition risk, across people', ctx.runId, 'predictive.root_causes', [text('factor', 'Reason'), { field: 'high', headerName: 'High band', type: 'count' }, { field: 'medium', headerName: 'Medium band', type: 'count' }, text('share', 'Share of High band'), { field: 'deposits', headerName: 'Deposits held', type: 'currency' }], x.rows.map((r) => ({ ...r, share: p1(r.highSharePct) })))],
          };
        },
      },
      {
        name: 'pred_suggest',
        description: 'Products to suggest: how many high-scoring next-best-product suggestions there are for each product, split by the person’s deposit balance band.',
        input: z.object({}).strict(),
        run: async (_a: Record<string, never>, ctx) => {
          need(ctx);
          const x = await svc.suggestions(ctx);
          const top = x.products[0]!;
          const rich = [...x.products].sort((a, b) => b.byBand['$10,000+'] - a.byBand['$10,000+'])[0]!;
          const cols = [text('product', 'Product'), ...BALANCE_BANDS.map((b, i) => text(`b${i}`, b)), text('total', 'Total')];
          const rows = x.products.map((p) => ({ product: p.product, ...Object.fromEntries(BALANCE_BANDS.map((b, i) => [`b${i}`, count(p.byBand[b])])), total: count(p.total) }));
          return {
            text: `The model has **${count(x.total)} high-scoring suggestions** (${HIGH_LIKELIHOOD} or more out of 10) from its run on ${longDay(x.run)}. **${top.product}** leads with ${count(top.total)}. Among people with $10,000 or more on deposit, ${rich.product} is suggested most (${count(rich.byBand['$10,000+'])}). Ask for any count to see the people behind it.`,
            blocks: [moduleTable(spec, 'Products to suggest, by deposit balance', ctx.runId, 'pred.suggest', cols, rows, x.run)],
            sources,
            suggestions: [`Who with $10,000+ is likely to open a ${rich.product === 'First mortgage' ? 'mortgage' : rich.product}?`, 'Which suggestions were taken up?', `Show ${top.product} suggestions by balance`],
          };
        },
      },
      {
        name: 'pred_people',
        description: 'The people behind one count in Products to suggest: one product, optionally one deposit balance band, highest score first, with the reason the model gives.',
        input: z.object({ product: z.string().min(2).max(60), band: z.enum(BALANCE_BANDS).optional() }).strict(),
        run: async (a: { product: string; band?: BalanceBand }, ctx) => {
          need(ctx);
          const product = productIn(a.product) ?? a.product;
          const x = await svc.people(product, a.band ?? null, ctx, 100);
          if (!x.total) return { text: `No one${a.band ? ` with ${a.band} on deposit` : ''} has a high-scoring ${product} suggestion right now.` };
          return {
            text: `**${count(x.total)} ${person}s**${a.band ? ` with ${a.band} on deposit` : ''} have a high-scoring **${product}** suggestion. ${x.total > x.items.length ? `The ${x.items.length} highest scores are below.` : 'They’re below, highest score first.'} I can refer any of them, or build a campaign audience from the list.`,
            blocks: [moduleTable(spec, `Likely to open ${product}${a.band ? `, ${a.band} on deposit` : ''}`, ctx.runId, 'pred.people', [text('name', 'Name'), text('number', 'Number'), text('branch', 'Branch'), text('score', 'Score'), text('balance', 'On deposit'), text('reason', 'Why')], x.items.map((p) => ({ name: p.name, number: `…${p.last4}`, branch: p.branch, score: `${p.likelihood}/10`, balance: usd(p.balance), reason: p.reason })))],
            sources,
            suggestions: ['Which suggestions were taken up?', 'Show products to suggest by balance'],
          };
        },
      },
      {
        name: 'pred_success',
        description: 'Successful suggestions: suggestions from earlier monthly runs and how many were opened within about 90 days, by product, by run, and by score band.',
        input: z.object({}).strict(),
        run: async (_a: Record<string, never>, ctx) => {
          need(ctx);
          const x = await svc.successes(ctx);
          const best = [...x.products].sort((a, b) => b.ratePct - a.ratePct)[0]!;
          const hi = x.scores[0]!;
          const lo = x.scores.at(-1)!;
          const t = (title: string, op: string, first: string, rows: typeof x.runs) => moduleTable(spec, title, ctx.runId, op, [text('label', first), text('suggested', 'Suggested'), text('opened', 'Opened'), text('rate', 'Taken up')], rows.map((r) => ({ label: op === 'pred.success.runs' ? monthOf(r.label) : r.label, suggested: count(r.suggested), opened: count(r.opened), rate: p1(r.ratePct) })));
          return {
            text: `Of **${count(x.total.suggested)} suggestions** in the ${x.runs.length} monthly runs from ${monthOf(x.runs[0]!.label)} to ${monthOf(x.runs.at(-1)!.label)}, **${count(x.total.opened)}** were opened within about 90 days (${p1(x.total.ratePct)}). The score works: ${p1(hi.ratePct)} of suggestions scored ${hi.label} were taken up, against ${p1(lo.ratePct)} of those scored ${lo.label}. ${best.label} converts best, at ${p1(best.ratePct)}. Opened means the product was opened after the run; DI can’t tell whether the suggestion itself was the reason.`,
            blocks: [t('Taken up, by product', 'pred.success.products', 'Product', x.products), t('Taken up, by score', 'pred.success.scores', 'Score', x.scores), t('Taken up, by monthly run', 'pred.success.runs', 'Run', x.runs)],
            sources,
            suggestions: ['Show products to suggest by balance', `Who is likely to open a ${best.label === 'First mortgage' ? 'mortgage' : best.label}?`],
          };
        },
      },
    ],
  };
  return spec;
}
