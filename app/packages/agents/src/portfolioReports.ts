// Portfolio Reports: the monthly stock reports DI's Business Intelligence folder carries, as reports in
// the library and as answers. Member growth (new, closed and net month, quarter and year to date, average
// age), the certificate maturity forecast, deposit growth by product, and delinquency by product with
// counts and dollars in each bucket.
import { z } from 'zod';
import type { Block, DiTake } from '@dinext/block-schemas';
import { CoreError, PortfolioService, type CoreContext } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';
import type { ReportAnalyses } from './report.ts';

export const PORTFOLIO_REQUEST =
  /\b(?:member|customer) growth\b|\bnew (?:and|vs\.?|versus) closed (?:members|customers)\b|\b(?:members|customers) (?:joined|added|lost) (?:this|month|quarter|year)|\baverage (?:member|customer) age\b|\b(?:cd|certificate)s? (?:maturity|maturities|maturing) (?:forecast|schedule|by term|by interval)\b|\bmaturing (?:cds?|certificates)\b[^.?!]*\b(?:forecast|by term|by interval)|\b(?:cd|certificate) (?:maturity )?forecast\b|\b(?:how much|what share|what percent(?:age)?)\b[^.?!]*\b(?:will|would|to) renew\b|\b(?:cd|certificate) renewals? (?:forecast|projection)\b|\brenewal (?:forecast|projection)\b|\bdeposit (?:growth|portfolio)\b|\bdeposits? by product\b|\bdelinquency by (?:product|loan type|sub-?product)\b|\bdelinquency buckets?\b[^.?!]*\b(?:product|history|over time)\b|\b(?:loan|deposit|share) products?\b|\b(?:loans|deposits|shares|the book) by (?:loan |deposit |share )?product name\b|\bproduct (?:catalog|list|mix)\b|\bwhat products do we (?:offer|have)\b|\borg (?:hierarchy|tree|chart|structure)\b|\bbranch hierarchy\b|\broll(?:ed)? ?up by (?:region|area|unit)\b|\bunits? under\b/i;

const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const cnt = (field: string, headerName: string) => ({ field, headerName, type: 'count' as const });
const cur = (field: string, headerName: string) => ({ field, headerName, type: 'currency' as const });
const mm = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString('en-US')}`);
const signed = (n: number, f: (x: number) => string) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${f(Math.abs(n))}`;
const monthName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const sourcesFor = (person: string): ModuleSpec['sources'] => [{ kind: 'table', label: `${person === 'customer' ? 'Customers' : 'Members'}, deposits and loans, from the core`, ref: 'table:cdm_party' }, { kind: 'table', label: 'Month-end history', ref: 'table:hist_deposit_month' }];
const whoFor = (person: string) => ({ agent: 'Portfolio Reports', sources: sourcesFor(person) });

export type PortfolioQuestion = 'members' | 'cds' | 'deposits' | 'delinquency';
export function portfolioQuestion(t: string): PortfolioQuestion {
  if (/\b(?:cd|certificate|maturit)/i.test(t)) return 'cds';
  if (/\bdelinquen/i.test(t)) return 'delinquency';
  if (/\bdeposit/i.test(t)) return 'deposits';
  return 'members';
}

/** The tables and takes for each question; reports and answers share them. */
async function build(svc: PortfolioService, q: PortfolioQuestion, runId: string, ctx: CoreContext, person: string) {
  const t = (title: string, op: string, cols: Parameters<typeof moduleTable>[4], rows: Record<string, string | number>[]) => moduleTable(whoFor(person), title, runId, op, cols, rows);
  if (q === 'members') {
    const x = await svc.memberGrowth(ctx);
    const ytd = x.periods.find((p) => p.period === 'YTD')!;
    const P = person.charAt(0).toUpperCase() + person.slice(1);
    return {
      text: `**${x.members.toLocaleString('en-US')} ${person}s** at ${x.asOf}, average age ${x.averageAge}. Year to date ${ytd.joined.toLocaleString('en-US')} joined and ${ytd.left.toLocaleString('en-US')} left, **net ${signed(ytd.net, (n) => n.toLocaleString('en-US'))}**.`,
      blocks: { periods: t(`New and closed ${person}s`, 'portfolio.members.periods', [text('period', 'Period'), cnt('joined', 'Joined'), cnt('left', 'Left'), text('net', 'Net')], x.periods.map((p) => ({ period: p.period === 'MTD' ? 'Month to date' : p.period === 'QTD' ? 'Quarter to date' : 'Year to date', joined: p.joined, left: p.left, net: signed(p.net, (n) => n.toLocaleString('en-US')) }))), months: t(`${P}s, last 13 month-ends`, 'portfolio.members.months', [text('month', 'Month'), cnt('members', `${P}s`), cnt('joined', 'Joined'), cnt('left', 'Left')], x.months.map((m) => ({ month: monthName(m.month), members: m.members, joined: m.joined, left: m.left }))) },
      headline: `${x.members.toLocaleString('en-US')} ${person}s, average age ${x.averageAge}; net ${signed(ytd.net, (n) => n.toLocaleString('en-US'))} this year.`,
    };
  }
  if (q === 'cds') {
    const x = await svc.cdMaturity(ctx);
    const next90 = x.intervals.slice(0, 3).reduce((s, i) => s + i.balance, 0);
    const end = x.projection.at(-1)!;
    return {
      text: `**${mm(x.balance)}** in ${x.count.toLocaleString('en-US')} certificates; **${mm(next90)}** matures in the next 90 days. If ${Math.round(x.renewal * 100)}% of what matures renews, the portfolio is about **${mm(end.balance)}** a year out.`,
      blocks: { intervals: t('Certificates maturing, by interval and term', 'portfolio.cd.intervals', [text('interval', 'Matures in'), cnt('count', 'Certificates'), cur('balance', 'Balance'), ...x.terms.map((tm, i) => cur(`t${i}`, tm))], x.intervals.map((iv) => ({ interval: iv.interval, count: iv.count, balance: iv.balance, ...Object.fromEntries(x.terms.map((tm, i) => [`t${i}`, iv.byTerm[tm] ?? 0])) }))), projection: t(`Projected certificate portfolio at ${Math.round(x.renewal * 100)}% renewal`, 'portfolio.cd.projection', [text('month', 'Month-end'), cur('balance', 'Balance'), cnt('count', 'Certificates')], x.projection.map((p) => ({ month: monthName(p.month), balance: p.balance, count: p.count }))) },
      headline: `${mm(next90)} of certificates mature in the next 90 days; at ${Math.round(x.renewal * 100)}% renewal the portfolio is about ${mm(end.balance)} a year out.`,
    };
  }
  if (q === 'deposits') {
    const x = await svc.depositGrowth(ctx);
    const total = x.rows.reduce((s, r) => s + r.balance, 0);
    const ytd = x.rows.reduce((s, r) => s + r.ytd.balance, 0);
    const best = [...x.rows].sort((a, b) => b.ytd.balance - a.ytd.balance)[0]!;
    return {
      text: `Deposits were **${mm(total)}** at ${monthName(x.marks.latest)}, ${signed(ytd, mm)} year to date. ${best.product} grew most, ${signed(best.ytd.balance, mm)} and ${signed(best.ytd.accounts, (n) => n.toLocaleString('en-US'))} accounts.`,
      blocks: { growth: t(`Deposit growth by product, ${monthName(x.marks.latest)}`, 'portfolio.deposits.growth', [text('product', 'Product'), cur('balance', 'Balance'), cnt('accounts', 'Accounts'), text('mtd', 'Month'), text('qtd', 'Quarter'), text('ytd', 'Year')], x.rows.map((r) => ({ product: r.product, balance: r.balance, accounts: r.accounts, mtd: `${signed(r.mtd.balance, mm)}, ${signed(r.mtd.accounts, String)} accts`, qtd: `${signed(r.qtd.balance, mm)}, ${signed(r.qtd.accounts, String)} accts`, ytd: `${signed(r.ytd.balance, mm)}, ${signed(r.ytd.accounts, String)} accts` }))), trend: t('Total deposits, last 13 month-ends', 'portfolio.deposits.trend', [text('month', 'Month'), cur('balance', 'Balance')], x.trend.map((p) => ({ month: monthName(p.month), balance: p.balance }))) },
      headline: `Deposits ${mm(total)}, ${signed(ytd, mm)} this year; ${best.product} grew most.`,
    };
  }
  const x = await svc.delinquencyByProduct(ctx);
  const worst = x.products[0]!;
  return {
    text: `At ${monthName(x.month)}, **${worst.product}** has the most loans 60 or more days past due, **${worst.dq60Pct}%** of its balance. The table gives counts and dollars in every bucket by product.`,
    blocks: { products: t(`Delinquency by product, ${monthName(x.month)}`, 'portfolio.dq.products', [text('product', 'Product'), cur('balance', 'Balance'), ...x.buckets.slice(1).map((b, i) => text(`b${i}`, b)), text('dq60', '60+ days')], x.products.map((p) => ({ product: p.product, balance: p.balance, ...Object.fromEntries(x.buckets.slice(1).map((b, i) => [`b${i}`, `${p.buckets[b]!.count} · ${mm(p.buckets[b]!.balance)}`])), dq60: `${p.dq60Pct}%` }))), history: t('Delinquent balances by bucket, 24 months', 'portfolio.dq.history', [text('month', 'Month'), ...x.buckets.slice(1).map((b, i) => cur(`h${i}`, b))], x.history.map((h) => ({ month: monthName(h.month), ...Object.fromEntries(x.buckets.slice(1).map((b, i) => [`h${i}`, (h as Record<string, number | string>)[b] as number])) }))) },
    headline: `${worst.product} has the highest share 60+ days past due, ${worst.dq60Pct}% of its balance.`,
  };
}

export const PORTFOLIO_SECTIONS = ['port.members.periods', 'port.members.months', 'port.cd.intervals', 'port.cd.projection', 'port.deposits.growth', 'port.deposits.trend', 'port.dq.products', 'port.dq.history'] as const;

export function portfolioAnalyses(svc: PortfolioService, person: 'member' | 'customer'): ReportAnalyses {
  const KEY: Record<string, [PortfolioQuestion, string, string]> = {
    'port.members.periods': ['members', 'periods', 'Show the membership trend'],
    'port.members.months': ['members', 'months', 'Show the membership trend'],
    'port.cd.intervals': ['cds', 'intervals', 'Which certificates are at risk?'],
    'port.cd.projection': ['cds', 'projection', 'Which certificates are at risk?'],
    'port.deposits.growth': ['deposits', 'growth', 'Show deposit growth by product'],
    'port.deposits.trend': ['deposits', 'trend', 'Show deposit growth by product'],
    'port.dq.products': ['delinquency', 'products', 'Show delinquency by product'],
    'port.dq.history': ['delinquency', 'history', 'Show delinquency by product'],
  };
  return {
    keys: [...PORTFOLIO_SECTIONS],
    async run(key, runId): Promise<{ block: Block; take?: DiTake }> {
      const k = KEY[key];
      if (!k) throw new CoreError('NOT_FOUND', `There’s no portfolio section ${key}.`);
      const r = await build(svc, k[0], runId, {}, person);
      const block = (r.blocks as unknown as Record<string, Block>)[k[1]]!;
      return { block, ...(k[1] === Object.keys(r.blocks)[0] ? { take: { headline: r.headline.slice(0, 300), action: { label: k[2].slice(0, 40), ask: k[2] === 'Which certificates are at risk?' ? 'Which certificates mature in the next 90 days and are at risk?' : k[2] } } } : {}) };
    },
  };
}

export function portfolioModule(svc: PortfolioService, person: 'member' | 'customer' = 'member'): ModuleSpec {
  const SOURCES = sourcesFor(person);
  const who = whoFor(person);
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('portfolio')) throw new CoreError('NO_ACCESS', 'Portfolio reports aren’t part of your DI access.');
  };
  return {
    id: 'portfolio',
    prefix: 'port',
    agent: 'Portfolio Reports',
    request: PORTFOLIO_REQUEST,
    noAccess: 'Portfolio reports aren’t part of your DI access.',
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You are the Portfolio Reports agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) reads the monthly portfolio reports.

- portfolio_report with question members (new, closed and net ${person}s, average age), cds (certificate maturity forecast), deposits (deposit growth by product) or delinquency (by product, counts and dollars per bucket).`,
    plan: (t) => /\borg (?:hierarchy|tree|chart|structure)\b|\bbranch hierarchy\b|\broll(?:ed)? ?up by (?:region|area|unit)\b|\bunits? under\b/i.test(t) ? { tool: 'port_org', args: (/\b(?:under|for|in) (?:the )?([A-Z][\w ]+?)(?: region| unit)?\s*[?.]?$/.exec(t)?.[1] ? { unit: /\b(?:under|for|in) (?:the )?([A-Z][\w ]+?)(?: region| unit)?\s*[?.]?$/.exec(t)![1] } : {}) } : (/\b(?:loan|deposit|share) products?\b|\bby (?:loan |deposit |share )?product name\b|\bproduct (?:catalog|list|mix)\b|\bwhat products do we (?:offer|have)\b/i.test(t) ? { tool: 'port_products', args: { kind: /\b(?:deposit|share|savings|checking)\b/i.test(t) ? 'deposit' : 'loan' } } : { tool: 'portfolio_report', args: { question: portfolioQuestion(t) } }),
    tools: [
      {
        name: 'portfolio_report',
        description: `A monthly portfolio report: members (new, closed and net ${person}s month, quarter and year to date, average age), cds (certificates by maturity interval and term, and the portfolio a year out), deposits (growth by product), or delinquency (by product, counts and dollars in each bucket, and 24 months of history).`,
        input: z.object({ question: z.enum(['members', 'cds', 'deposits', 'delinquency']) }).strict(),
        run: async (a: { question: PortfolioQuestion }, ctx) => {
          need(ctx);
          const r = await build(svc, a.question, ctx.runId, ctx, person);
          return { text: r.text, blocks: Object.values(r.blocks), sources: SOURCES };
        },
      },
      {
        name: 'port_products',
        description: `The loan or deposit book by product (the institution's product list): accounts, balances and share, the balance-weighted rate, and for loans the average term and the share 60+ days past due, with each loan product's 5300 line.`,
        input: z.object({ kind: z.enum(['loan', 'deposit']).default('loan') }).strict(),
        run: async (a: { kind?: 'loan' | 'deposit' }, ctx: ModuleContext) => {
          need(ctx);
          const kind = a.kind ?? 'loan';
          const list = await svc.products(kind, ctx);
          if (list === null) return { text: 'Products aren’t loaded for this institution yet.' };
          if (!list.length) return { text: `No open ${kind} accounts you can see.` };
          const top = list[0]!;
          const isLoan = kind === 'loan';
          return {
            text: `${list.length} ${isLoan ? 'loan' : 'deposit'} products. **${top.name}** is the largest, ${mm(top.balance)} (${top.sharePct}%) in ${top.accounts.toLocaleString('en-US')} accounts${top.ratePct !== null ? ` at ${top.ratePct}%` : ''}.`,
            blocks: [moduleTable(who, isLoan ? 'Loans by product' : 'Deposits by product', ctx.runId, `portfolio.products.${kind}`, [text('name', 'Product'), text('category', 'Category'), cnt('accounts', 'Accounts'), cur('balance', 'Balance'), text('share', 'Share'), text('rate', 'Rate'), ...(isLoan ? [text('term', 'Average term'), text('dq', '60+ days'), ...(list.some((r) => r.regCode) ? [text('reg', '5300 line')] : [])] : [])], list.map((r) => ({ name: r.name, category: r.category, accounts: r.accounts, balance: r.balance, share: `${r.sharePct}%`, rate: r.ratePct === null ? '—' : `${r.ratePct}%`, term: r.termMonths === null ? '—' : `${r.termMonths} months`, dq: r.dq60Pct === null ? '—' : `${r.dq60Pct}%`, reg: r.regCode ?? '—' })))],
          };
        },
      },
      {
        name: 'port_org',
        description: 'The org hierarchy (institution, regions, branches) and one unit’s roll-up: each unit under it with its branches, people, deposits and loans. The institution when no unit is named.',
        input: z.object({ unit: z.string().max(80).optional() }).strict(),
        run: async (a: { unit?: string }, ctx: ModuleContext) => {
          need(ctx);
          const x = await svc.orgRollup(a.unit, ctx);
          if (x === null) return { text: 'The org hierarchy isn’t loaded for this institution yet.' };
          if (!x.children.length) return { text: `${x.unit} has no units under it that you can see.` };
          return {
            text: `**${x.path.join(' › ')}** (${x.level.toLowerCase()}): ${x.total.branches} ${x.total.branches === 1 ? 'branch' : 'branches'}, ${x.total.people.toLocaleString('en-US')} people, ${mm(x.total.deposits)} in deposits and ${mm(x.total.loans)} in loans. Under it: ${x.children.map((c) => c.name).join(', ')}.`,
            blocks: [moduleTable(who, `${x.unit}: units under it`, ctx.runId, 'portfolio.org', [text('name', 'Unit'), text('level', 'Level'), cnt('branches', 'Branches'), cnt('people', 'People'), cur('deposits', 'Deposits'), cur('loans', 'Loans')], x.children)],
            suggestions: x.children.filter((c) => c.level !== 'Branch').slice(0, 2).map((c) => `Show the units under ${c.name}`),
          };
        },
      },
    ],
  };
}
