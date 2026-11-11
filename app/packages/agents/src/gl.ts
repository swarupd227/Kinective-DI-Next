// General Ledger: the balance sheet and income statement for a month or a day of the open month, one
// company or consolidated, with comparisons and several months side by side; budget against actual by
// department, cost center or account; and the journal entries behind a balance, reconciled. Read-only:
// DI never posts to the GL. The board's targets for the year stay with the Budget agent.
import { z } from 'zod';
import { CoreError, GlService, type GlCompare, type GlScope, type GlStatementKind } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const GL_REQUEST =
  /^(?![\s\S]*\b(?:uncategori[sz]ed|unmapped|5300|call report|ffiec|board targets?|next year'?s budget|20\d\d (?:plan|targets?))\b)[\s\S]*?(?:\bgeneral ledger\b|\bgl (?:accounts?|balances?|detail|activity)\b|\bbalance sheet\b|\bincome statement\b|\bp ?& ?l\b|\bfinancial statements?\b|\bstatement of (?:income|financial condition)\b|\btrial balance\b|\bbudget (?:vs\.?|versus|against|to|compared (?:to|with)) actuals?\b|\bactuals? (?:vs\.?|versus|against|to|compared (?:to|with)) budget\b|\b(?:over|under) budget\b|\bbudget variances?\b|\bvariances? (?:to|against) budget\b|\bcost cent(?:er|re)s?\b|\bjournal entr(?:y|ies)\b|\bjournals? (?:for|behind)\b|\bdepartment(?:al)? (?:spend|expenses?|budgets?)\b|\bwhich departments?\b[^.?!]*\b(?:budget|spend|over)\b|\breconcile (?:the |gl |account )|\bdaily balances?\b|\bconsolidat(?:ed|ion|ing)\b)/i;

const NO_ACCESS = 'The general ledger isn’t part of your DI access.';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const short = (n: number) => (Math.abs(n) >= 1e9 ? `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `${n < 0 ? '−' : ''}$${(Math.abs(n) / 1e6).toFixed(1)}M` : money(n));
const pct = (n: number | null) => (n === null ? '' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const END: Record<number, string> = { 1: '31', 2: '28', 3: '31', 4: '30', 5: '31', 6: '30', 7: '31', 8: '31', 9: '30', 10: '31', 11: '30', 12: '31' };

/** A month named in a question ("September", "Sep 2026", "December 2025") as its month end. */
export function monthIn(t: string): string | undefined {
  // Whole names or abbreviations only, so "marketing" isn't March; "may" counts only with a year.
  const m = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may(?=,?\s+20\d\d)|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?(?:\s+(\d{1,2})(?:st|nd|rd|th)?\b)?(?:,?\s+(20\d\d))?/i.exec(t);
  if (!m) return undefined;
  const n = MONTHS.findIndex((x) => x.startsWith(m[1]!.toLowerCase().slice(0, 3))) + 1;
  // Without a year, November and December are 2025; October is 2026's open month.
  const y = m[3] ?? (n > 10 ? '2025' : '2026');
  return `${y}-${String(n).padStart(2, '0')}-${END[n]}`;
}
/** A day of the open month ("October 15", "on the 12th"). */
export function dayIn(t: string): string | undefined {
  const m = /\b(?:oct(?:ober)?\.?\s+(\d{1,2})|(?:on|as of) the (\d{1,2})(?:st|nd|rd|th))\b/i.exec(t);
  const d = m?.[1] ?? m?.[2];
  return d ? `2026-10-${d.padStart(2, '0')}` : undefined;
}

export interface GlPlan { tool: string; args: Record<string, unknown> }
export function glPlan(t: string): GlPlan {
  const s = t.toLowerCase();
  const scope: GlScope | undefined = /\b(?:cuso|subsidiary|insurance (?:services|agency)|title)\b/.test(s) && !/consolidat/.test(s) ? 2 : /\b(?:parent|credit union only|bank only|stand-?alone)\b/.test(s) ? 1 : undefined;
  const month = /\blast month\b/.test(s) ? '2026-09-30' : /\bthis month\b|\bmonth to date\b|\bmtd\b/.test(s) ? '2026-10-31' : monthIn(t);
  const acct = /\b(?:journal entr(?:y|ies)|journals?|entries|postings?|reconcile)\b[^.?!]*?\b(?:for|behind|in|on|to)\s+(?:gl\s+|account\s+)?(\d{4}|[a-z][a-z ,&-]{2,40}?)(?:\s+(?:in|for|during|this|last|on)\b|[?.!]|$)/i.exec(t);
  if (acct && /\bjournal|entries|postings?|reconcile\b/.test(s)) {
    const cc = /\bcost cent(?:er|re) (\d{3})\b/.exec(s)?.[1];
    return { tool: 'gl_journal', args: { account: acct[1]!.trim(), ...(month ? { month } : {}), ...(cc ? { cost_center: cc } : {}) } };
  }
  if (/budget|variance|over spend|overspend/.test(s)) {
    const by = /\bcost cent(?:er|re)s?\b/.test(s) ? 'cost_center' : /\baccounts?\b|\bline items?\b/.test(s) ? 'account' : 'department';
    const dept = /\b(retail|lending|operations|technology|marketing|finance|executive)\b/.exec(s)?.[1];
    return { tool: 'gl_budget', args: { by, ...(/\bytd\b|year to date|this year|so far/.test(s) ? { ytd: true } : {}), ...(month ? { month } : {}), ...(dept ? { department: dept[0]!.toUpperCase() + dept.slice(1) } : {}) } };
  }
  const kind: GlStatementKind = /income statement|p ?& ?l|profit|net income|expenses?\b|revenue/.test(s) && !/balance sheet/.test(s) ? 'IS' : 'BS';
  const many = /\b(?:last|past|trailing)\s+(\d{1,2}|six|twelve|three)\s+months\b|\bmonth by month\b|\bmulti-?period\b|\bover the (?:year|last year)\b|\btrend\b|\bside by side\b/.exec(s);
  if (many) {
    const words: Record<string, number> = { three: 3, six: 6, twelve: 12 };
    const n = many[1] ? (words[many[1]] ?? Number(many[1])) : 6;
    return { tool: 'gl_compare', args: { kind, months: Math.min(13, Math.max(2, n)), ...(scope !== undefined ? { scope } : {}) } };
  }
  const compare: GlCompare | undefined = /prior quarter|last quarter|quarter ago/.test(s) ? 'prior_quarter' : /year[- ]end|december/.test(s) && /compar|against|vs|versus/.test(s) ? 'prior_year_end' : undefined;
  const day = kind === 'BS' && /\bdaily\b|\bas of (?:oct|the\b)|\bon oct/.test(s) ? dayIn(t) ?? '2026-10-25' : undefined;
  return { tool: 'gl_statement', args: { kind, ...(day ? { day } : month ? { month } : {}), ...(compare ? { compare } : {}), ...(scope !== undefined ? { scope } : {}), ...(/\baccounts?\b|\bdetail\b|\bgl lines\b/.test(s) ? { accounts: true } : {}), ...(/\bzeros?\b/.test(s) ? { zeros: true } : {}) } };
}

export function glModule(svc: GlService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('gl')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const sources: ModuleSpec['sources'] = [{ kind: 'table', label: 'General ledger', ref: 'table:gl_balance_month' }, { kind: 'table', label: 'GL budget by cost center', ref: 'table:gl_budget' }, { kind: 'table', label: 'GL journal entries', ref: 'table:gl_journal' }];
  const spec: ModuleSpec = {
    id: 'gl',
    prefix: 'gl',
    agent: 'General Ledger',
    request: GL_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the General Ledger agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) reviews the books. The GL has month-end balances from October 2025, October 2026 open to date with daily balances, income and expense by cost center and department, the 2026 budget by cost center, and journal entries for September and October. September 30 ties to the Call Report. DI never posts to the GL.

- gl_statement (kind BS or IS, month or day, compare prior_month, prior_quarter or prior_year_end, scope consolidated, 1 parent or 2 subsidiary, accounts, zeros).
- gl_compare (kind, months: how many months back, side by side).
- gl_budget (month, ytd, by department, cost_center or account, department).
- gl_journal (account number or name, month, cost_center): the entries and whether opening plus entries equals closing.`,
    plan: (t) => glPlan(t),
    tools: [
      {
        name: 'gl_statement',
        description: 'The balance sheet (BS) or income statement (IS) from the GL for a month end or a day of the open month, consolidated or one company, against a comparison period, by group or with accounts.',
        input: z.object({ kind: z.enum(['BS', 'IS']), month: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional(), day: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional(), compare: z.enum(['prior_month', 'prior_quarter', 'prior_year_end', 'none']).optional(), scope: z.union([z.literal('consolidated'), z.number().int()]).optional(), accounts: z.boolean().optional(), zeros: z.boolean().optional() }).strict(),
        run: async (a: { kind: GlStatementKind; month?: string; day?: string; compare?: GlCompare; scope?: GlScope; accounts?: boolean; zeros?: boolean }, ctx) => {
          need(ctx);
          const x = await svc.statement(a.kind, { month: a.month, day: a.day, compare: a.compare, scope: a.scope, zeros: a.zeros });
          const cols = [text('line', a.accounts ? 'Group / account' : 'Group'), ...x.periods.map((p, i) => ({ field: `v${i}`, headerName: p, type: 'currency' as const })), ...(x.periods.length > 1 && x.kind === 'BS' ? [text('chg', 'Change')] : [])];
          const row = (line: string, values: number[]) => ({ line, ...Object.fromEntries(values.map((v, i) => [`v${i}`, Math.round(v)])), ...(x.periods.length > 1 && x.kind === 'BS' ? { chg: values[1] ? pct(((values[0]! - values[1]!) / Math.abs(values[1]!)) * 100) : '' } : {}) });
          const out: Record<string, string | number>[] = [];
          for (const side of x.kind === 'BS' ? ['Assets', 'Liabilities', 'Equity'] : ['Income', 'Expenses']) {
            for (const g of x.groups.filter((gr) => gr.side === side)) {
              out.push(row(g.group, g.values));
              if (a.accounts) for (const acc of g.accounts) out.push(row(`   ${acc.gl} ${acc.name}${x.scope.startsWith('Consolidated') && acc.company !== 1 ? (acc.company === 9 ? ' (elimination)' : ' (subsidiary)') : ''}`, acc.values));
            }
            const total = x.kind === 'BS' ? (x.totals as { assets: number[]; liabilities: number[]; equity: number[] })[side.toLowerCase() as 'assets'] : (x.totals as { income: number[]; expenses: number[] })[side === 'Income' ? 'income' : 'expenses'];
            out.push(row(`Total ${side.toLowerCase()}`, total));
          }
          let headline: string;
          if (x.kind === 'BS') {
            const t = x.totals as { assets: number[]; liabilities: number[]; equity: number[] };
            const le = t.liabilities.map((l, i) => l + t.equity[i]!);
            out.push(row('Total liabilities and equity', le));
            const off = Math.abs(t.assets[0]! - le[0]!);
            headline = `Total assets were **${short(t.assets[0]!)}** at ${x.periods[0]}${x.periods[1] ? `, ${t.assets[0]! >= t.assets[1]! ? 'up' : 'down'} ${short(Math.abs(t.assets[0]! - t.assets[1]!))} from ${x.periods[1]}` : ''}, with liabilities of ${short(t.liabilities[0]!)} and equity of ${short(t.equity[0]!)}.${off < 1 ? ' The balance sheet balances.' : ` Assets and liabilities plus equity differ by ${money(off)}.`}`;
          } else {
            const t = x.totals as { income: number[]; expenses: number[]; net: number[] };
            const ytd = t.net.length - 1;
            headline = `Net income was **${short(t.net[0]!)}** for ${x.periods[0]} (income ${short(t.income[0]!)}, expenses ${short(t.expenses[0]!)})${t.net.length > 2 ? `, against ${short(t.net[1]!)} for ${x.periods[1]}` : ''}, and **${short(t.net[ytd]!)}** year to date.`;
          }
          return {
            text: `${headline} ${x.scope}.${x.hiddenZeros && !a.zeros ? ` ${x.hiddenZeros} accounts with no balance are hidden.` : ''}`,
            blocks: [moduleTable(spec, `${x.kind === 'BS' ? 'Balance sheet' : 'Income statement'}, ${x.periods[0]}`, ctx.runId, 'gl.statement', cols, out)],
            sources,
            suggestions: x.kind === 'BS' ? ['Show the income statement for September', 'Show the balance sheet for the last six months', 'Show the journal entries for 2040'] : ['Which departments are over budget?', 'Show the income statement for the last six months', 'Show the income statement by account'],
          };
        },
      },
      {
        name: 'gl_compare',
        description: 'The balance sheet or income statement by group across several months side by side, ending with the latest month.',
        input: z.object({ kind: z.enum(['BS', 'IS']), months: z.number().int().min(2).max(13).default(6), scope: z.union([z.literal('consolidated'), z.number().int()]).optional() }).strict(),
        run: async (a: { kind: GlStatementKind; months: number; scope?: GlScope }, ctx) => {
          need(ctx);
          const meta = await svc.meta();
          const list = meta.months.slice(-a.months);
          const x = await svc.compare(a.kind, list, a.scope ?? 'consolidated');
          const cols = [text('line', 'Group'), ...x.labels.map((l, i) => ({ field: `v${i}`, headerName: l, type: 'currency' as const }))];
          const rowsOut = x.groups.map((g) => ({ line: `${g.side}: ${g.group}`, ...Object.fromEntries(g.values.map((v, i) => [`v${i}`, Math.round(v)])) }));
          const mover = [...x.groups].sort((p, q) => Math.abs(q.values.at(-2)! - q.values[0]!) - Math.abs(p.values.at(-2)! - p.values[0]!))[0]!;
          return {
            text: `The ${a.kind === 'BS' ? 'balance sheet' : 'income statement'} for ${x.labels[0]} to ${x.labels.at(-1)}${a.kind === 'IS' ? ', each month’s activity' : ''}. ${mover.side}: ${mover.group} moved most, from ${short(mover.values[0]!)} to ${short(mover.values.at(-2)!)} by ${x.labels.at(-2)}.`,
            blocks: [moduleTable(spec, `${a.kind === 'BS' ? 'Balance sheet' : 'Income statement'}, ${x.labels[0]} to ${x.labels.at(-1)}`, ctx.runId, 'gl.compare', cols, rowsOut)],
            sources,
          };
        },
      },
      {
        name: 'gl_budget',
        description: 'Budget against actual for a month or the year to date, by department, cost center or account, optionally one department: actual, budget, variance and whether it is favorable.',
        input: z.object({ month: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional(), ytd: z.boolean().optional(), by: z.enum(['department', 'cost_center', 'account']).optional(), department: z.string().max(40).optional() }).strict(),
        run: async (a: { month?: string; ytd?: boolean; by?: 'department' | 'cost_center' | 'account'; department?: string }, ctx) => {
          need(ctx);
          const x = await svc.budget(a);
          const worst = x.lines.filter((l) => !l.favorable).sort((p, q) => Math.abs(q.variance) - Math.abs(p.variance));
          const exp = x.totals.expense;
          const inc = x.totals.income;
          const lineText = (l: (typeof x.lines)[number]) => `**${l.name}** ${l.type === 'expense' ? 'spent' : 'earned'} ${short(l.actual)} against ${short(l.budget)} (${pct(l.pct)})`;
          return {
            text: `${x.label}${x.department ? `, ${x.department}` : ''}: expenses were ${short(exp.actual)} against a budget of ${short(exp.budget)} (${pct(exp.budget ? ((exp.actual - exp.budget) / exp.budget) * 100 : null)}), income ${short(inc.actual)} against ${short(inc.budget)}, so net income is ${short(x.totals.net.actual)} against ${short(x.totals.net.budget)}.${worst.length ? ` Most unfavorable: ${worst.slice(0, 3).map(lineText).join('; ')}.` : ' Everything is on or better than budget.'}`,
            blocks: [moduleTable(spec, `Budget against actual by ${x.by.replace('_', ' ')}, ${x.label}`, ctx.runId, 'gl.budget', [text('name', x.by === 'department' ? 'Department' : x.by === 'cost_center' ? 'Cost center' : 'Account'), text('type', 'Type'), { field: 'actual', headerName: 'Actual', type: 'currency' }, { field: 'budget', headerName: 'Budget', type: 'currency' }, { field: 'variance', headerName: 'Variance', type: 'currency' }, text('pct', '%'), text('fav', '')], x.lines.map((l) => ({ name: l.name, type: l.type === 'income' ? 'Income' : 'Expense', actual: Math.round(l.actual), budget: Math.round(l.budget), variance: Math.round(l.variance), pct: pct(l.pct), fav: l.favorable ? 'Favorable' : 'Unfavorable' })))],
            sources,
            suggestions: [x.by === 'department' && worst[0] ? `Show ${worst[0].name} budget by account` : 'Show budget against actual by department', 'Show budget against actual year to date', 'Show budget against actual by cost center'],
          };
        },
      },
      {
        name: 'gl_journal',
        description: 'The journal entries behind one GL account (number or name) for September or the open month, optionally one cost center, with the opening balance, the entries and whether they add to the closing balance.',
        input: z.object({ account: z.string().min(2).max(60), month: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional(), cost_center: z.string().max(8).optional() }).strict(),
        run: async (a: { account: string; month?: string; cost_center?: string }, ctx) => {
          need(ctx);
          const found = await svc.account(a.account);
          if (found.length > 1 && !/^\d{4}$/.test(a.account.trim())) return { text: `More than one account matches “${a.account}”: ${found.slice(0, 6).map((f) => `**${f.gl}** ${f.name}`).join(', ')}. Which one?` };
          const x = await svc.journal(found[0]!.gl, { month: a.month, costCenter: a.cost_center });
          const debits = x.entries.reduce((s, e) => s + e.debit, 0);
          const credits = x.entries.reduce((s, e) => s + e.credit, 0);
          const tie = x.ties === null ? '' : x.ties ? ` Opening ${money(x.opening)} plus the entries (${money(x.net)}) equals the closing balance of **${money(x.closing)}**: it reconciles.` : ` Opening ${money(x.opening)} plus the entries (${money(x.net)}) doesn’t equal the closing ${money(x.closing)}: a ${money(x.closing - x.opening - x.net)} difference to investigate.`;
          const bySource = [...new Set(x.entries.map((e) => e.source))].map((src) => `${x.entries.filter((e) => e.source === src).length} ${src.toLowerCase()}`).join(', ');
          return {
            text: `**${x.account.gl} ${x.account.name}**, ${x.open ? 'October to date' : new Date(`${x.month}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}${a.cost_center ? `, cost center ${a.cost_center}` : ''}: **${x.entries.length} entries** (${bySource}), debits ${money(debits)} and credits ${money(credits)}.${tie}`,
            blocks: [moduleTable(spec, `Journal entries, ${x.account.gl} ${x.account.name}`, ctx.runId, 'gl.journal', [text('posted', 'Posted'), text('je', 'Entry'), text('ticket', 'Ticket'), text('source', 'Source'), text('description', 'Description'), text('cc', 'Cost center'), { field: 'debit', headerName: 'Debit', type: 'currency' }, { field: 'credit', headerName: 'Credit', type: 'currency' }, text('offset', 'Against'), text('by', 'Posted by')], x.entries.slice(0, 200).map((e) => ({ posted: e.posted, je: e.je, ticket: e.ticket, source: e.source, description: e.description, cc: e.costCenter === '-' ? '' : e.costCenter, debit: e.debit, credit: e.credit, offset: e.offset ?? '', by: e.by })))],
            sources,
          };
        },
      },
    ],
  };
  return spec;
}
