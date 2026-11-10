// The ALCO package's sections as report blocks: policy compliance, earnings, rate risk, liquidity,
// capital, funding and the loan book, from the AlcoService. A report widget of kind "analysis" names
// one, and the report runner fills it on each run, so the ALCO monthly pack carries the committee's
// whole review, not only the balances. One analysis per run serves every section.
import type { Block, DiTake, TableBlock } from '@dinext/block-schemas';
import type { AlcoService } from '@dinext/di-core';
import { RAMP_COLUMNS, rampRows } from './irr.ts';
import { moduleTable } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

type Cols = TableBlock['data']['columns'];
const p1 = (n: number) => `${n.toFixed(1)}%`;
const p2 = (n: number) => `${n.toFixed(2)}%`;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
const shock = (bp: number) => (bp === 0 ? 'Base' : `${bp > 0 ? '+' : ''}${bp} bp`);

export const ALCO_SECTIONS = ['alco.policy', 'alco.earnings', 'alco.irr', 'alco.ramps', 'alco.liquidity', 'alco.capital', 'alco.funding', 'alco.pricing', 'alco.loans', 'alco.newloans'] as const;

export function alcoAnalyses(svc: AlcoService): ReportAnalyses {
  const runs = new Map<string, ReturnType<AlcoService['analysis']>>();
  const once = (runId: string) => {
    if (!runs.has(runId)) {
      runs.set(runId, svc.analysis());
      // Keep only the last few runs.
      if (runs.size > 8) runs.delete(runs.keys().next().value!);
    }
    return runs.get(runId)!;
  };
  const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
  const money = (field: string, headerName: string) => ({ field, headerName, type: 'currency' as const });

  return {
    keys: [...ALCO_SECTIONS],
    async run(key, runId): Promise<{ block: Block; take?: DiTake }> {
      const a = await once(runId);
      const who = { agent: 'ALCO', sources: [{ kind: 'table' as const, label: a.bank ? 'Loans, deposits and the balance sheet' : 'Loans, shares and the latest 5300', ref: 'table:cdm_loan' }] };
      const t = (title: string, op: string, cols: Cols, rows: Record<string, string | number>[], subtitle?: string) => ({ ...moduleTable(who, title, runId, op, cols, rows, a.asOf), ...(subtitle ? { subtitle } : {}) }) as Block;
      const deposits = a.bank ? 'Deposits' : 'Shares';
      switch (key) {
        case 'alco.policy': {
          const order = { Breach: 0, Watch: 1, Within: 2 } as const;
          const lines = [...a.policy].sort((x, y) => order[x.status] - order[y.status] || y.closeness - x.closeness);
          const first = a.breaches[0];
          const ask = first ? (/nev|net interest/i.test(first.measure) ? 'What drives our rate risk?' : /liquid/i.test(first.measure) ? 'How is our liquidity?' : /commercial real estate|business loans/i.test(first.measure) ? 'Show loan balance by loan category' : 'What changed since last month-end?') : 'What drives our rate risk?';
          return {
            block: t('Policy compliance', 'alco.policy', [text('status', 'Status'), text('area', 'Area'), text('measure', 'Measure'), text('actual', 'Actual'), text('policy', 'Policy')], lines.map((l) => ({ status: l.status, area: l.area, measure: l.measure, actual: l.actual, policy: l.policy })), `Every board limit at the ${new Date(`${a.asOf}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} build, breaches first. Rate risk and liquidity are DI’s estimates; the ALM vendor’s model is the one of record.`),
            take: { headline: a.headline, action: { label: first ? 'Why is it outside policy?' : 'What drives our rate risk?', ask } },
          };
        }
        case 'alco.earnings': {
          const e = a.earnings;
          const rows = [
            { item: 'Yield on earning assets', value: p2(e.yieldPct) },
            { item: a.bank ? 'Cost of funds' : 'Cost of funds (shares and borrowings)', value: p2(e.costPct) },
            { item: 'Spread', value: p2(e.spreadPct) },
            { item: 'Net interest margin', value: p2(e.nimPct) },
            { item: 'Net interest income, next 12 months', value: `$${(e.nii / 1e6).toFixed(1)}M` },
            ...e.lines.map((l) => ({ item: `${l.side === 'asset' ? 'Yield' : 'Cost'}: ${l.name}`, value: p2(l.ratePct) })),
          ];
          return { block: t('Earnings: yields, cost of funds and margin', 'alco.earnings', [text('item', 'Measure'), text('value', 'Annualized')], rows) };
        }
        case 'alco.irr': {
          const s = a.irr.scenarios;
          if (a.bank) {
            return {
              block: t('Interest rate risk: NII and EVE under rate shocks', 'alco.irr', [text('shock', 'Shock'), text('nii', 'NII change'), text('niiLimit', 'NII limit'), text('eve', 'EVE change'), text('eveLimit', 'EVE limit'), text('limits', 'Status')], s.map((x) => ({ shock: shock(x.shockBp), nii: x.shockBp ? signed(x.niiPct) : '—', niiLimit: x.shockBp ? `−${x.niiLimitPct}%` : '', eve: x.shockBp ? signed(x.nevPct) : '—', eveLimit: x.shockBp ? `−${x.nevLimitPct}%` : '', limits: x.shockBp ? x.status : '' })), `NII over the next 12 months and the economic value of equity (EVE), each against the board’s limit for that shock. EVE is $${(a.irr.base.nev / 1e6).toFixed(1)}M at today’s rates.`),
            };
          }
          return {
            block: t('Interest rate risk: NII and NEV under rate shocks', 'alco.irr', [text('shock', 'Shock'), text('nii', 'NII change'), text('nev', 'NEV change'), text('ratio', 'NEV ratio'), text('limits', 'Board limits')], s.map((x) => ({ shock: shock(x.shockBp), nii: x.shockBp ? signed(x.niiPct) : '—', nev: x.shockBp ? signed(x.nevPct) : '—', ratio: p1(x.nevRatio), limits: x.withinLimits ? 'Within' : 'Breach' }))),
          };
        }
        case 'alco.ramps': {
          return { block: t('Net interest income over two years: rates moving at once or over a year', 'alco.ramps', RAMP_COLUMNS, rampRows(a.irr), 'Change in NII against rates held flat, static balance sheet. The Fed usually moves step by step; by year two rates are at the same level either way, and more of the book has repriced.') };
        }
        case 'alco.liquidity': {
          const l = a.liq;
          return {
            block: t('Liquidity: available funds and a deposit run', 'alco.liquidity', [text('item', 'Measure'), text('value', 'Value')], [
              { item: 'On balance sheet (cash and investments within a year)', value: `$${(l.liquid / 1e6).toFixed(1)}M` },
              { item: 'Borrowing capacity (FHLB, discount window, securities, lines)', value: `$${(l.contingent / 1e6).toFixed(1)}M` },
              { item: `Available liquidity to ${deposits.toLowerCase()}`, value: p1(l.availableToShares) },
              ...l.stress.map((x) => ({ item: `${x.pct}% of ${deposits.toLowerCase()} leave in 30 days`, value: x.covered ? `Covered ${x.coverage.toFixed(1)}×, ${x.days} days` : `Short $${(x.shortfall / 1e6).toFixed(1)}M` })),
            ]),
          };
        }
        case 'alco.capital': {
          const c = a.capital;
          return {
            block: t('Capital', 'alco.capital', [text('item', 'Measure'), text('value', 'Actual'), text('min', 'Well capitalized')], [
              ...c.lines.map((x) => ({ item: x.name, value: p1(x.value), min: `${x.limit}%` })),
              { item: a.bank ? 'Equity capital' : 'Net worth', value: `$${(c.equity / 1e6).toFixed(1)}M`, min: '—' },
            ], c.basis),
          };
        }
        case 'alco.funding': {
          const f = a.funding;
          const mix = f.mix.map((m) => ({ group: 'Mix', item: m.category, balance: Math.round(m.balance), share: p1(m.sharePct), rate: p2(m.ratePct) }));
          const ladder = f.ladder.map((l) => ({ group: 'Certificates maturing', item: l.band, balance: Math.round(l.balance), share: p1(l.sharePct), rate: p2(l.ratePct) }));
          return {
            block: t('Funding', 'alco.funding', [text('group', ''), text('item', 'Product or maturity'), money('balance', 'Balance'), text('share', 'Share'), text('rate', 'Rate paid')], [...mix, ...ladder], `Cost of ${deposits.toLowerCase()} ${p2(f.costOfDepositsPct)}; certificates and money market are ${p1(f.rateSensitivePct)} of ${deposits.toLowerCase()}, the funding most likely to move with rates.`),
          };
        }
        case 'alco.loans': {
          const l = a.loans;
          const c = l.concentration;
          return {
            block: t('Loans', 'alco.loans', [text('category', 'Loan type'), money('balance', 'Balance'), text('share', 'Share'), text('rate', 'Yield'), text('growth', '12-month growth'), text('dq', '60+ delinquent')], l.lines.map((x) => ({ category: x.category, balance: Math.round(x.balance), share: p1(x.sharePct), rate: p2(x.ratePct), growth: x.growthPct === null ? '—' : signed(x.growthPct), dq: p2(x.dq60Pct) })), `Loan yield ${p2(l.yieldPct)}; ${c.name.charAt(0).toLowerCase()}${c.name.slice(1)} is ${c.unit === '%' ? `${Math.round(c.value)}%` : `${c.value.toFixed(2)}×`} (limit ${c.unit === '%' ? `${c.limit}%` : `${c.limit}×`}).`),
          };
        }
        case 'alco.pricing':
        case 'alco.newloans': {
          const pr = await svc.pricing();
          if (!pr) throw new Error('No market rate history is loaded.');
          const when = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
          const bp = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} bp`;
          const b2 = (n: number | null) => (n === null ? '—' : n.toFixed(2));
          const mm = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);
          if (key === 'alco.pricing') {
            const rows = [...pr.products.map((p) => ({ item: p.category, balance: mm(p.balance), then: p2(p.rateThen), now: p2(p.rateNow), change: bp(p.changeBp), beta: b2(p.beta) })), { item: `All ${deposits.toLowerCase()}: repricing`, balance: mm(pr.products.reduce((s, p) => s + p.balance, 0)), then: '', now: '', change: bp(pr.total.repricingBp), beta: b2(pr.total.repricingBeta) }, { item: 'Mix moving to higher-rate products', balance: '', then: '', now: '', change: bp(pr.total.mixBp), beta: '' }, { item: `All ${deposits.toLowerCase()}: cost`, balance: mm(pr.products.reduce((s, p) => s + p.balance, 0)), then: p2(pr.total.rateThen), now: p2(pr.total.rateNow), change: bp(pr.total.changeBp), beta: b2(pr.total.beta) }];
            return {
              block: t('Deposit pricing and beta', 'alco.pricing', [text('item', 'Product'), text('balance', 'Balance'), text('then', `Rate, ${when(pr.start)}`), text('now', `Rate, ${when(pr.end)}`), text('change', 'Change'), text('beta', 'Beta')], rows, `Fed funds ${bp(pr.marketMoveBp)} since ${when(pr.start)}. Rates paid repriced ${bp(pr.total.repricingBp)} (beta ${b2(pr.total.repricingBeta)}); the mix ${pr.total.mixBp > 0 ? 'took back' : 'added'} ${Math.abs(pr.total.mixBp)} bp, so cost moved ${bp(pr.total.changeBp)}.`),
            };
          }
          const rows = pr.loans.filter((l) => l.newAmount > 0).map((l) => ({ item: l.category, amount: Math.round(l.newAmount), fresh: l.newYield === null ? '—' : p2(l.newYield), book: p2(l.bookYield), spread: l.spreadBp === null ? '—' : bp(l.spreadBp) }));
          return {
            block: t('New loans against the book', 'alco.newloans', [text('item', 'Loan type'), money('amount', 'Made, last 3 months'), text('fresh', 'Yield on new loans'), text('book', 'Yield on the book'), text('spread', 'Difference')], rows, pr.newYield === null || pr.likeForLikeBp === null ? 'No loans were made in the last three months.' : `New loans yield ${p2(pr.newYield)} against ${p2(pr.bookYield)} on the book, a gap that is mostly mix. Type for type, new loans price ${bp(pr.likeForLikeBp)} against the book.`),
          };
        }
        default:
          throw new Error(`Unknown ALCO section ${key}`);
      }
    },
  };
}
