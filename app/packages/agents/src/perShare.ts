// Shareholder Value: a bank's earnings per share and tangible book value per share, what analysts value a
// bank on. Earnings, dividends, equity, AOCI and intangibles come from the Call Report; shares outstanding
// and the share price aren't on it, so the CFO enters them each quarter, and each entry is approved.
import { z } from 'zod';
import { CoreError, type PerShareService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const SHARE_REQUEST = /\beps\b|\bearnings per share\b|\btangible book\b|\bbook value per share\b|\bbook value\b[^.?!]*\b(?:share|falling|fall|fell|grow\w*|stock)\b|\btbv(?:ps)?\b|\btangible common equity\b|\bprice[- ]to[- ](?:tangible )?book\b|\bp\/tbv\b|\bp\/e\b|\bprice[- ]to[- ]earnings\b|\bshares outstanding\b|\bshare (?:count|price)\b|\bstock price\b|\bdividends? per share\b|\bpayout ratio\b|\brotce\b|\breturn on tangible\b|\banalysts?\b[^.?!]*\bvalue\b|\bshareholder value\b/i;
export type ShareQuestion = 'overview' | 'tbv' | 'why' | 'eps' | 'valuation' | 'dividends' | 'rates' | 'method';

export function shareQuestion(text: string): ShareQuestion {
  const t = text.toLowerCase();
  if (/calculat|assum|method|worked out|how do you (?:measure|work)/.test(t)) return 'method';
  if (/\brates?\b|\bbp\b|basis points|shock/.test(t)) return 'rates';
  const eps = /\beps\b|earnings per share/.test(t);
  const tbv = /tangible|book value|\btbv/.test(t);
  if (eps && tbv) return 'overview';
  if (/\bwhy\b|what moved|\bdr[io]ve|driv|bridge|explain|falling|\bfell\b|\bfall\b|\bdown\b/.test(t) && !eps) return 'why';
  if (/dividend|payout/.test(t)) return 'dividends';
  if (!eps && (/price|p\/tbv|p\/e\b|multiple|analyst|\bstock\b|\btrades?\b/.test(t) || (/valu/.test(t) && !tbv))) return 'valuation';
  if (eps) return 'eps';
  if (tbv) return 'tbv';
  return 'overview';
}

/** Shares, weighted shares and a price from "shares outstanding were 4,886,500, weighted 4,885,300, price $27.90". */
export function parseShares(text: string): { shares?: number; weighted?: number; price?: number } | null {
  if (!/\b(?:set|record|enter|update|change|were|was|are|is|closed|now)\b/i.test(text)) return null;
  const num = (s: string, unit?: string) => Number(s.replace(/,/g, '')) * (unit && /^m/i.test(unit) ? 1e6 : 1);
  const out: { shares?: number; weighted?: number; price?: number } = {};
  const w = /weighted(?: average)?(?: shares)?[^\d$]{0,20}([\d][\d,]*(?:\.\d+)?)\s*(million|m\b)?/i.exec(text);
  if (w) out.weighted = num(w[1]!, w[2]);
  const s = /shares(?: outstanding)?(?: for q[1-4] \d{4})?\s*(?:are|were|is|was|of|at|to|=|:)?\s*([\d][\d,]*(?:\.\d+)?)\s*(million|m\b)?/i.exec(text) ?? /([\d][\d,]*(?:\.\d+)?)\s*(million|m)?\s+shares\b/i.exec(text);
  if (s) out.shares = num(s[1]!, s[2]);
  const p = /(?:price|close[ds]?|closing|stock)[^$\d]{0,20}\$?\s*(\d+(?:\.\d{1,2})?)\b/i.exec(text) ?? /\$\s*(\d+(?:\.\d{1,2})?)\b/.exec(text);
  if (p) out.price = Number(p[1]);
  if (out.shares !== undefined && out.shares < 1000) delete out.shares;
  return out.shares !== undefined || out.price !== undefined ? out : null;
}

const NO_ACCESS = 'Shareholder value isn’t part of your DI access. It is for a bank’s finance leaders.';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const usd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`);
const sd = (n: number) => (n >= 0 ? `+$${n.toFixed(2)}` : `−$${Math.abs(n).toFixed(2)}`);
const mm = (n: number) => `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(2)}M`;
const p1 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);
const x2 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(2)}×`);
const x1 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(1)}×`);
const count = (n: number) => Math.round(n).toLocaleString('en-US');
const qLabel = (end: string) => `Q${Math.ceil(Number(end.slice(5, 7)) / 3)} ${end.slice(0, 4)}`;

export function shareModule(svc: PerShareService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('pershare')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const sources: ModuleSpec['sources'] = [
    { kind: 'table', label: 'FFIEC 051 Call Report values', ref: 'table:cr_value' },
    { kind: 'table', label: 'Share register, as the CFO entered it', ref: 'table:fin_share' },
  ];
  const spec: ModuleSpec = {
    id: 'pershare',
    prefix: 'pershare',
    agent: 'Shareholder Value',
    request: SHARE_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the Shareholder Value agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) runs the bank's finances. Analysts value a bank on earnings per share and tangible book value per share; a falling tangible book value per share pulls the stock down. Earnings, dividends, equity, AOCI, goodwill and intangibles come from the Call Report; shares outstanding and the share price are entered by the CFO each quarter.

- pershare_view, with question overview (any question about both EPS and tangible book value, such as "EPS and TBV: is TBV falling?", and general questions about shareholder value), tbv ("what's our tangible book value per share?"), why ("what moved TBV?", "is TBV falling?"), eps ("what's our EPS?"), valuation ("what's our price to tangible book?", "how do analysts value us?"), dividends ("dividends per share and payout"), rates ("what happens to TBV if rates rise?") or method ("how is it calculated?").
- pershare_set: record this quarter's shares outstanding, weighted average shares or share price. It needs approval.`,
    plan: (t) => {
      const set = parseShares(t);
      if (set && (/\b(?:set|record|enter|update|change)\b/i.test(t) || /\bshares outstanding\b[^.?!]*\b(?:were|was|are|is)\b/i.test(t) || /\bclosed at\b/i.test(t))) return { tool: 'pershare_set', args: set };
      return { tool: 'pershare_view', args: { question: shareQuestion(t) } };
    },
    tools: [
      {
        name: 'pershare_view',
        description: 'A bank’s EPS and tangible book value per share: by quarter, what moved TBV per share over the year, price to tangible book and earnings against peers, dividends, and what a rate rise does to TBV through AOCI.',
        input: z.object({ question: z.enum(['overview', 'tbv', 'why', 'eps', 'valuation', 'dividends', 'rates', 'method']).optional() }).strict(),
        run: async (a: { question?: ShareQuestion }, ctx) => {
          need(ctx);
          if (a.question === 'method') return { text: `How DI works out EPS and tangible book value per share:\n\n${svc.assumptions().map(([k, v]) => `- **${k}:** ${v}`).join('\n')}` };
          const f = await svc.figures();
          if (!f) throw new CoreError('INVALID', 'EPS and tangible book value are built from a bank’s FFIEC Call Report, and none is loaded yet.');
          const n = f.now;
          const q = qLabel(f.asOf);
          const ya = f.yearAgo;
          if (f.missing) {
            const growth = ya ? ((n.tce - ya.tce) / ya.tce) * 100 : null;
            return {
              text: `Tangible common equity is ${mm(n.tce)} at ${q} (equity ${mm(n.equity)} less ${mm(n.goodwill + n.intangibles)} of goodwill and intangibles)${growth !== null ? `, ${growth >= 0 ? 'up' : 'down'} ${p1(Math.abs(growth))} on a year ago` : ''}. Net income is ${mm(n.niYtd)} so far this year. Per-share figures need ${q}’s shares outstanding, which aren’t on the Call Report. Tell me them from the transfer agent’s report, for example: “Shares outstanding for ${q} were 4,886,500, weighted 4,885,300, price $27.90”.`,
              suggestions: [`Shares outstanding for ${q} were `, 'How is tangible book value per share calculated?'],
            };
          }
          const question = a.question ?? 'overview';
          const b = f.bridge;
          const parts: Record<string, string> = {};
          const yearMove = f.tbvChangeYear;
          const dir = (v: number) => (v >= 0 ? 'up' : 'down');
          const vsRef = (who: string, v: number | null) => (v === null || f.tbvGrowth === null ? '' : `${f.tbvGrowth >= v ? (f.tbvGrowth > v + 0.05 ? 'above' : 'on') : 'below'} ${who === 'peers' ? 'peers’' : `${who}’s`} ${p1(v)}`);
          const refs = [vsRef('plan', f.plan.tbvGrowth), vsRef('peers', f.peer.tbvGrowth)].filter(Boolean);
          parts.tbv = `Tangible book value per share is ${usd(n.tbvps)} at ${q}${yearMove !== null ? `, ${dir(yearMove)} ${usd(Math.abs(yearMove))} (${p1(Math.abs(f.tbvGrowth!))}) on a year ago` : ''}${f.tbvChangeQuarter !== null ? ` and ${dir(f.tbvChangeQuarter)} ${usd(Math.abs(f.tbvChangeQuarter))} on the quarter` : ''}${yearMove !== null ? (yearMove >= 0 ? ', so it is growing, not falling' : ': falling, which is what analysts mark a bank’s stock down for') : ''}.${refs.length ? ` That growth is ${refs.join(' and ')}.` : ''}`;
          if (b) {
            const bits = [`earnings added ${usd(b.earnings)} a share`, `dividends took ${usd(-b.dividends)}`];
            if (Math.abs(b.aoci) >= 0.005) bits.push(`AOCI ${b.aoci >= 0 ? `added ${usd(b.aoci)} as bond losses narrowed` : `took ${usd(-b.aoci)} as bond losses grew`}`);
            if (Math.abs(b.intangibles) >= 0.005) bits.push(`intangibles ${b.intangibles >= 0 ? `amortizing added ${usd(b.intangibles)}` : `from an acquisition took ${usd(-b.intangibles)}`}`);
            if (Math.abs(b.shares) >= 0.005) bits.push(`${b.shares < 0 ? `new shares from vesting stock took ${usd(-b.shares)}` : `fewer shares added ${usd(b.shares)}`}`);
            if (Math.abs(b.other) >= 0.005) bits.push(`other equity changes ${b.other >= 0 ? 'added' : 'took'} ${usd(Math.abs(b.other))}`);
            parts.why = `Over the year, ${bits.slice(0, -1).join(', ')} and ${bits.at(-1)}.`;
          }
          parts.eps = `EPS is ${usd(f.epsTtm)} over the last twelve months${f.epsGrowth !== null ? `, ${dir(f.epsGrowth)} ${p1(Math.abs(f.epsGrowth))} on a year ago’s annualized ${usd(f.epsTtmBefore)}` : ''}${n.epsQuarter !== null ? `, and ${usd(n.epsQuarter)} in ${q}` : ''}.`;
          parts.dividends = `Dividends are ${usd(f.dpsTtm)} a share over the last twelve months, ${p1(f.payoutPct)} of earnings; return on tangible common equity is ${p1(f.rotcePct)}.`;
          parts.valuation = n.price !== null
            ? `At ${usd(n.price)} the stock trades at ${x2(n.ptbv)} tangible book and ${x1(f.pe)} earnings${f.peer.ptbv !== null ? `, against peers’ ${x2(f.peer.ptbv)} and ${x1(f.peer.pe)}` : ''}.${f.peer.ptbv !== null && n.ptbv !== null ? ` Priced at peers’ multiple of tangible book, the stock would be ${usd(f.peer.ptbv * n.tbvps!)}.` : ''}`
            : `No share price is entered for ${q}, so DI can’t give price to tangible book or earnings.`;
          const r100 = f.rates.find((r) => r.bp === 100);
          const r200 = f.rates.find((r) => r.bp === 200);
          parts.rates = r100 && r200
            ? `If rates rise 100 bp, the larger loss on available-for-sale bonds takes ${usd(-r100.change)} a share off tangible book value through AOCI (${p1(Math.abs(r100.pct))}); 200 bp takes ${usd(-r200.change)} (${p1(Math.abs(r200.pct))}). Regulatory capital doesn’t move under the AOCI opt-out, but tangible book value, and the stock, does.${f.htmMarked !== null ? ` Marked for held-to-maturity losses too, as some analysts do, it is ${usd(f.htmMarked)} today.` : ''}`
            : '';
          const reg = (await svc.register()).find((x) => x.end === f.asOf);
          parts.src = reg ? `Shares and price are as ${reg.by} entered them (${reg.source.charAt(0).toLowerCase()}${reg.source.slice(1)}) for ${q}; the rest is the Call Report.` : '';
          const order: Record<ShareQuestion, string[]> = {
            overview: ['tbv', 'why', 'eps', 'valuation', 'rates', 'src'],
            tbv: ['tbv', 'why', 'rates', 'src'],
            why: ['tbv', 'why', 'rates', 'src'],
            eps: ['eps', 'dividends', 'valuation', 'src'],
            valuation: ['valuation', 'tbv', 'eps', 'src'],
            dividends: ['dividends', 'eps', 'tbv', 'src'],
            rates: ['rates', 'tbv', 'src'],
            method: [],
          };
          const reply = order[question].map((k) => parts[k]).filter(Boolean).join(' ');
          const t = (title: string, op: string, cols: ReturnType<typeof text>[], rows: Record<string, string>[]) => moduleTable(spec, title, ctx.runId, op, cols, rows);
          const byQuarter = t('Per share by quarter', 'pershare.quarters', [text('quarter', 'Quarter'), text('eps', 'EPS in the quarter'), text('epsAnn', 'EPS, annualized'), text('dps', 'Dividends a share'), text('bv', 'Book value a share'), text('tbv', 'Tangible book value a share'), text('price', 'Price'), text('ptbv', 'Price to tangible book')], f.trend.map((r) => ({ quarter: qLabel(r.end), eps: usd(r.epsQuarter), epsAnn: usd(r.epsAnnualized), dps: usd(r.dpsQuarter), bv: usd(r.bvps), tbv: usd(r.tbvps), price: usd(r.price), ptbv: x2(r.ptbv) })));
          const bridgeTable = b && ya ? t(`What moved tangible book value per share, ${qLabel(ya.end)} to ${q}`, 'pershare.bridge', [text('item', ''), text('amount', 'A share')], [
            { item: `Tangible book value a share, ${qLabel(ya.end)}`, amount: usd(b.start) },
            { item: 'Earnings, last twelve months', amount: sd(b.earnings) },
            { item: 'Common dividends', amount: sd(b.dividends) },
            { item: 'AOCI (bond losses after tax)', amount: sd(b.aoci) },
            { item: 'Goodwill and intangibles', amount: sd(b.intangibles) },
            ...(Math.abs(b.other) >= 0.005 ? [{ item: 'Other changes in equity', amount: sd(b.other) }] : []),
            { item: 'Share count', amount: sd(b.shares) },
            { item: `Tangible book value a share, ${q}`, amount: usd(b.end) },
          ]) : null;
          const ratesTable = f.rates.length ? t('Tangible book value per share if rates rise', 'pershare.rates', [text('rise', 'Rates rise'), text('aoci', 'AOCI change'), text('tbv', 'Tangible book value a share'), text('change', 'Change')], [{ rise: 'Today', aoci: '—', tbv: usd(n.tbvps), change: '—' }, ...f.rates.map((r) => ({ rise: `+${r.bp} bp`, aoci: mm(r.aociChange), tbv: usd(r.tbvps), change: `${sd(r.change)} (${p1(r.pct)})` }))]) : null;
          const peers = t('Against plan and peers', 'pershare.peers', [text('measure', 'Measure'), text('us', 'Us'), text('plan', 'Plan'), text('peer', 'Peers')], [
            { measure: 'Tangible book value a share, growth on a year ago', us: p1(f.tbvGrowth), plan: p1(f.plan.tbvGrowth), peer: p1(f.peer.tbvGrowth) },
            { measure: 'Price to tangible book', us: x2(n.ptbv), plan: '—', peer: x2(f.peer.ptbv) },
            { measure: 'Price to earnings', us: x1(f.pe), plan: '—', peer: x1(f.peer.pe) },
            { measure: 'EPS, last twelve months', us: usd(f.epsTtm), plan: '—', peer: '—' },
            { measure: 'Dividend payout', us: p1(f.payoutPct), plan: '—', peer: '—' },
            { measure: 'Return on tangible common equity', us: p1(f.rotcePct), plan: '—', peer: '—' },
          ]);
          const blocksFor: Record<ShareQuestion, (ReturnType<typeof t> | null)[]> = {
            overview: [byQuarter, bridgeTable, peers, ratesTable],
            tbv: [bridgeTable, byQuarter, ratesTable],
            why: [bridgeTable, byQuarter, ratesTable],
            eps: [byQuarter, peers],
            valuation: [peers, byQuarter],
            dividends: [byQuarter, peers],
            rates: [ratesTable, bridgeTable],
            method: [],
          };
          return {
            text: reply,
            blocks: blocksFor[question].filter((x): x is ReturnType<typeof t> => x !== null),
            sources,
            suggestions: ['What happens to tangible book value if rates rise 200 bp?', 'What moved our tangible book value per share?', 'How is tangible book value per share calculated?'].filter((s) => shareQuestion(s) !== question).slice(0, 3),
          };
        },
      },
      {
        name: 'pershare_set',
        description: 'Record the latest quarter’s shares outstanding, weighted average shares or closing share price, from the transfer agent’s report and the market. Saving it needs approval.',
        input: z.object({ shares: z.number().int().min(1000).max(5_000_000_000).optional(), weighted: z.number().int().min(1000).max(5_000_000_000).optional(), price: z.number().positive().max(100_000).optional() }).strict(),
        run: async (a: { shares?: number; weighted?: number; price?: number }, ctx) => {
          need(ctx);
          const end = await svc.latestQuarter();
          if (!end) throw new CoreError('INVALID', 'There is no Call Report quarter to record shares against yet.');
          const q = qLabel(end);
          const was = (await svc.register()).find((x) => x.end === end) ?? null;
          const shares = a.shares ?? was?.shares;
          if (!shares) return { text: `DI has no shares outstanding for ${q} yet. Tell me them with the price, for example: “Shares outstanding for ${q} were 4,886,500, price $27.90”.` };
          // A price alone leaves the share counts as they were; new shares without a weighted figure use the new count.
          const weighted = a.weighted ?? (a.shares === undefined && was ? was.weighted : shares);
          const price = a.price ?? was?.price ?? null;
          const f = await svc.figures();
          const tbv = f ? f.now.tce / shares : null;
          return {
            change: {
              summary: a.shares === undefined && a.weighted === undefined ? `Record ${q}’s share price` : `Record ${q}’s shares${a.price !== undefined ? ' and share price' : ''}`,
              changes: [
                { label: 'Shares outstanding', before: was ? count(was.shares) : 'Not entered', after: count(shares) },
                { label: 'Weighted average shares', before: was ? count(was.weighted) : 'Not entered', after: count(weighted) },
                { label: 'Share price', before: was?.price !== null && was?.price !== undefined ? usd(was.price) : 'Not entered', after: price !== null ? usd(price) : 'Not entered' },
              ],
              text: `For **${q}**: ${count(shares)} shares outstanding, ${count(weighted)} weighted average${price !== null ? `, price ${usd(price)}` : ''}.${tbv !== null ? ` Tangible book value per share would be **${usd(tbv)}**${price !== null ? `, ${x2(price / tbv)} tangible book` : ''}.` : ''} These come from the transfer agent’s report and the market close; the Call Report doesn’t carry them.`,
              done: `Recorded ${q}’s shares${price !== null ? ' and price' : ''}. EPS and tangible book value per share use them from now on.`,
              risk: 'low',
              apply: { end, shares, weighted, price },
            },
          };
        },
        apply: async (p: { end: string; shares: number; weighted: number; price: number | null }, meta, ctx) => svc.record(p, { approvalId: meta.approvalId, by: ctx.user.name }),
      },
    ],
  };
  return spec;
}
