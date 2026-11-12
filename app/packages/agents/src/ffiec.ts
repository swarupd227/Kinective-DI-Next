// The FFIEC 051 Call Report on the shared module agent, for a bank: readiness (validity edits block, quality
// edits need an explanation), the GL accounts with no item yet, any item by its MDRM code with what makes it
// up, what moved since last quarter, a schedule, RC-R capital under the community bank leverage ratio, and
// commercial real estate concentration against the interagency guidance. DI prepares and checks the report;
// a person files it in the FFIEC's Central Data Repository. Read-only.
import { z } from 'zod';
import { CoreError, type CallReportLine, type CallReportService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const NO_ACCESS = 'The Call Report is for the finance team and executives.';
const need = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('callreport')) throw new CoreError('NO_ACCESS', NO_ACCESS);
};
const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/’/g, "'");
const dollars = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const m = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);
/** "Can you create this report?", "are you able to prepare the Call Report?" */
const CAN_YOU = /\b(can|could|are|will) (you|di)\b|\babilit|\bable to\b|\bdo you\b|\bis it possible\b/i;
const MAKE = /\b(create|prepare|produce|build|generate|make|fill out|fill in)\b/i;
const READ_ONLY = 'I can’t submit the Call Report or change GL mappings. Submitting it in the FFIEC’s Central Data Repository (CDR), with the officer’s attestation, stays a person’s action. To take it there, download the data file from the Call Report page.';
/** Where the files are: the person downloads them and loads them into their Call Report software or CDR. */
const DOWNLOAD = 'Yes. On the **Call Report** page there are two downloads: the **data file** (CSV), each MDRM item and its value in thousands of dollars, for your Call Report software or for keying into CDR; and the **review workbook** (Excel), every schedule with the prior quarter, the edits and the explanations, for sign-off. While edits are open the files are marked DRAFT. Submitting in CDR, with the officer’s attestation, stays with you.';
const CODE = /\b(RCON|RIAD)[A-Z0-9]{4}\b/i;
const SCHEDULES: [RegExp, string][] = [
  [/\brc-?c\b|loans by type|loan types|loans and leases/i, 'RC-C'],
  [/\brc-?n\b|past due|nonaccrual|noncurrent/i, 'RC-N'],
  [/\brc-?e\b|deposits by|transaction accounts|time deposits/i, 'RC-E'],
  [/\brc-?b\b|securities|investments/i, 'RC-B'],
  [/\brc-?k\b|averages/i, 'RC-K'],
  [/\brc-?o\b|uninsured|deposit insurance/i, 'RC-O'],
  [/\bri-?b\b|charge-?offs?|recover|allowance/i, 'RI-B'],
  [/\bri-?a\b|changes in equity|dividends/i, 'RI-A'],
  [/\bri\b|income statement|income|expense|earnings/i, 'RI'],
  [/\brc\b|balance sheet|assets|liabilit/i, 'RC'],
];

export function ffiecModule(cr: CallReportService): ModuleSpec {
  const change = (l: CallReportLine) => (l.change === null ? '' : `${l.change >= 0 ? 'up' : 'down'} ${dollars(Math.abs(l.change))}${l.pct !== null ? ` (${Math.abs(l.pct)}%)` : ''}`);
  const lineRows = (ls: CallReportLine[]) => ls.map((l) => ({ code: l.code, name: l.name, prior: l.prior ?? 0, current: l.current ?? 0, change: l.pct === null ? '' : `${l.pct}%` }));
  const lineCols = (prior: string, current: string) => [{ field: 'code', headerName: 'Item', type: 'text' as const }, { field: 'name', headerName: 'Caption', type: 'text' as const }, { field: 'prior', headerName: prior, type: 'currency' as const }, { field: 'current', headerName: current, type: 'currency' as const }, { field: 'change', headerName: 'Change', type: 'text' as const }];
  const glCols = [{ field: 'gl', headerName: 'GL account', type: 'text' as const }, { field: 'name', headerName: 'Name', type: 'text' as const }, { field: 'balance', headerName: 'Balance', type: 'currency' as const }, { field: 'lastPosted', headerName: 'Last posted', type: 'text' as const }, { field: 'likely', headerName: 'Likely schedule', type: 'text' as const }, { field: 'note', headerName: 'Why it is open', type: 'text' as const }];
  const value = async (code: string) => (await cr.lines()).find((l) => l.code === code);
  const spec: ModuleSpec = {
    id: 'callreport',
    prefix: 'cr',
    agent: 'Call Report',
    request: /^(?![\s\S]*\b(?:unrealized|aoci|accumulated other comprehensive|underwater|bond portfolio|securities portfolio)\b)[\s\S]*?(?:\bffiec\b|\bcall report\b|\b051\b|\bready to file\b|\b(rc|ri)-[a-z]\b|\bschedule (rc|ri)\b|\b(rcon|riad)[a-z0-9]{4}\b|\bcblr\b|\bcommunity bank leverage\b|\bleverage ratio\b|\btier 1\b|\bcre concentration\b|\bcommercial real estate concentration\b|\buncategori[sz]ed gl\b|\bnonaccrual\b)/i,
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'FFIEC 051 Call Report', ref: 'table:cr_line' }],
    // The filing leads a finance leader's day while anything blocks it: edits to correct, then changes to explain.
    today: async () => {
      const r = await cr.readiness();
      const needed = r.explanations.filter((e) => e.status === 'Needed').length;
      if (!r.errors.length && !r.warnings.length && !needed) return null;
      const parts = [r.errors.length ? `${r.errors.length} ${r.errors.length === 1 ? 'edit' : 'edits'} to correct` : '', r.warnings.length ? `${r.warnings.length} ${r.warnings.length === 1 ? 'warning' : 'warnings'} to review` : '', needed ? `${needed} ${needed === 1 ? 'change' : 'changes'} to explain` : ''].filter(Boolean);
      return { id: 'callreport', title: `Call Report: ${parts.join(', ')}`, why: r.errors.length ? `It can’t be filed in CDR until “${r.errors[0]!.name}” passes.` : 'Quality edits and large changes need an explanation before filing in CDR.', badge: r.errors.length ? 'Blocks filing' : 'Before filing', ask: 'Are we ready to file the Call Report?', weight: r.errors.length ? 240 : 220 };
    },
    prompt: ({ tenant, user, title }) => `You are the Call Report agent inside Kinective Data Intelligence (DI) for ${tenant}, a bank. ${user} (${title}) prepares the quarterly FFIEC 051 Call Report (domestic offices, under $5B), on the June 2026 forms. Items are MDRM codes: RCON for the balance sheet (RCON2170 total assets, RCON2122 total loans, RCON2200 deposits, RCON3210 equity, RCON1403 nonaccrual, RCON5597 uninsured deposits) and RIAD for income (RIAD4074 net interest income, RIAD4340 net income). FFIEC validity edits must be corrected; quality and intraseries edits need an explanation. The bank elects the community bank leverage ratio (8% from July 1, 2026), so RC-R Part II isn't needed. It's due 30 days after quarter end in the FFIEC's Central Data Repository (CDR).

- "Can you create this report?", "are you able to prepare the Call Report?": cr_overview.
- "Are we ready to file the Call Report?", "what's blocking it?", "when is it due?": cr_readiness.
- "Which GL accounts are uncategorized?": cr_uncategorized.
- "How is RCON2122 built?", "why did RCON1403 go up?": cr_line_explain with the MDRM code.
- "What moved more than 10% since last quarter?", "which items need an explanation?": cr_variance.
- "Show RC-C", "show the income statement", "show past due and nonaccrual": cr_schedule.
- "What's our leverage ratio?", "are we on the CBLR?", "show capital": cr_capital.
- "What's our CRE concentration?": cr_concentration.
- You are read-only. If asked to submit or change a mapping, say a person does that in CDR or the GL.`,
    plan: (text) => {
      const t = clean(text);
      if (/\b(download|export|excel|csv|spreadsheet|workbook|xbrl|file for cdr|upload file|send (it )?to cdr|get it (in)?to cdr)\b/i.test(t)) return { say: DOWNLOAD };
      if (CAN_YOU.test(t) && MAKE.test(t)) return { tool: 'cr_overview', args: {} };
      if (/\b(submit|file it|upload|change|edit|remap|map)\b/i.test(t) && !/\bready\b|\bdue\b/i.test(t)) return { say: READ_ONLY };
      if (/\buncategori[sz]ed\b|\bunmapped\b|\bgl accounts?\b/i.test(t)) return { tool: 'cr_uncategorized', args: {} };
      if (/concentration|\bcre\b|commercial real estate/i.test(t)) return { tool: 'cr_concentration', args: {} };
      if (/capital|leverage|cblr|tier 1|\brc-?r\b|well capitali[sz]ed/i.test(t)) return { tool: 'cr_capital', args: {} };
      if (/\bready\b|\bdue\b|\bblock|\bfiling\b/i.test(t)) return { tool: 'cr_readiness', args: {} };
      const code = CODE.exec(t)?.[0];
      if (code) return { tool: 'cr_line_explain', args: { code: code.toUpperCase() } };
      if (/\bmoved|\bchanged?|\bvariance|\bexplanation|\b\d+(\.\d+)?\s*%/i.test(t)) return { tool: 'cr_variance', args: { min_pct: Number(/(\d+(?:\.\d+)?)\s*%/.exec(t)?.[1] ?? 10) } };
      const s = SCHEDULES.find(([re]) => re.test(t));
      if (s) return { tool: 'cr_schedule', args: { schedule: s[1] } };
      return { tool: 'cr_readiness', args: {} };
    },
    tools: [
      {
        name: 'cr_overview',
        description: 'What DI does with the Call Report: it prepares every schedule from the warehouse and GL and runs the FFIEC edits; a person submits. With the quarter’s state and the schedules it covers.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const [lines, r, f] = await Promise.all([cr.lines(), cr.readiness(), cr.form()]);
          const schedules = [...new Set(lines.map((l) => l.schedule))];
          const rows = schedules.map((sc) => ({ schedule: sc, items: lines.filter((l) => l.schedule === sc).length }));
          const open = [...r.errors.map((c) => c.detail.replace(/\.$/, '')), ...(r.warnings.length ? [`${r.warnings.length} quality ${r.warnings.length === 1 ? 'edit needs' : 'edits need'} an explanation`] : [])];
          const state = open.length ? `it isn’t ready yet: ${open.join('; ')}` : 'every edit passes, so it’s ready to review';
          return {
            text: `Yes. DI prepares the ${r.quarter.label} ${f.form} from the warehouse and the general ledger: **${lines.length} items on ${schedules.length} schedules** (${schedules.join(', ')}), with the prior quarter beside each, and runs the FFIEC validity and quality edits before it goes to CDR. Right now ${state}. Submitting it, with the officer’s attestation, stays with you.`,
            blocks: [moduleTable(spec, `${f.form} schedules`, ctx.runId, 'callreport.schedules', [{ field: 'schedule', headerName: 'Schedule', type: 'text' }, { field: 'items', headerName: 'Items', type: 'count' }], rows)],
            suggestions: ['Are we ready to file the Call Report?', 'Show RC-C', 'How is RCON2122 built?'],
          };
        },
      },
      {
        name: 'cr_readiness',
        description: 'Whether the quarter can be filed: validity edits that failed (they block submission), quality edits that need an explanation, the uncategorized GL accounts, explanations still needed, and the due date in CDR.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const [r, f] = await Promise.all([cr.readiness(), cr.form()]);
          const q = r.quarter;
          const due = new Date(`${q.dueDate}T00:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
          const gl = r.uncategorized;
          const glText = gl.length ? ` The uncategorized GL accounts are ${gl.map((g) => `**${g.glNumber}** ${g.name} (${dollars(g.balance)})`).join(', ')}.` : '';
          const errText = r.errors.length ? ` ${r.errors.length} ${r.errors.length === 1 ? 'edit blocks' : 'edits block'} submission: ${r.errors.map((c) => `${c.name}: ${c.detail}`).join(' ')}${glText}` : '';
          const warnText = r.warnings.length ? ` ${r.warnings.length} quality ${r.warnings.length === 1 ? 'edit needs' : 'edits need'} an explanation or attention: ${r.warnings.map((c) => c.detail).join(' ')}` : '';
          const checks = moduleTable(spec, 'Edits', ctx.runId, 'dq.status_report', [{ field: 'name', headerName: 'Edit', type: 'text' }, { field: 'severity', headerName: 'Type', type: 'text' }, { field: 'result', headerName: 'Result', type: 'text' }, { field: 'detail', headerName: 'Detail', type: 'text' }], r.checks.map((c) => ({ name: c.editCode ? `${c.editCode}: ${c.name}` : c.name, severity: c.severity === 'Error' ? 'Validity' : 'Quality', result: c.passed ? 'Passed' : 'Failed', detail: c.detail })));
          const accounts = gl.length ? [moduleTable(spec, 'Uncategorized GL accounts', ctx.runId, 'callreport.gl_uncategorized', glCols, gl.map((g) => ({ gl: g.glNumber, name: g.name, balance: g.balance, lastPosted: g.lastPosted, likely: g.likelyLine ?? 'Not suggested', note: g.note ?? '' })))] : [];
          return {
            text: r.ready && !r.warnings.length ? `The ${q.label} ${f.form} is **ready to review**: every edit passed. It’s due **${due}** in ${f.filedIn}, and submitting it stays with you.` : r.ready ? `The ${q.label} ${f.form} has no blocking edits.${warnText} It’s due **${due}** in ${f.filedIn}.` : `The ${q.label} ${f.form} **isn’t ready yet**.${errText}${warnText} It’s due **${due}** in ${f.filedIn}.`,
            blocks: [checks, ...accounts],
            suggestions: [...(gl.length ? ['Which GL accounts are uncategorized?'] : []), ...(r.warnings.length ? ['Which items need an explanation?'] : []), 'What’s our CRE concentration?', 'Show capital'],
          };
        },
      },
      {
        name: 'cr_uncategorized',
        description: 'The GL accounts with no Call Report item yet: balance, last posting, the schedule they most likely belong on, and why they are open.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const gl = await cr.uncategorized();
          if (!gl.length) return { text: 'Every GL account is mapped to a Call Report item.' };
          const total = gl.reduce((n, g) => n + g.balance, 0);
          return {
            text: `**${gl.length} GL ${gl.length === 1 ? 'account has' : 'accounts have'}** no Call Report item yet, totalling **${dollars(total)}**. The largest is **${gl[0]!.glNumber}** ${gl[0]!.name} at ${dollars(gl[0]!.balance)}. Mapping them is a person’s change in the general ledger; DI only reads them.`,
            blocks: [moduleTable(spec, 'Uncategorized GL accounts', ctx.runId, 'callreport.gl_uncategorized', glCols, gl.map((g) => ({ gl: g.glNumber, name: g.name, balance: g.balance, lastPosted: g.lastPosted, likely: g.likelyLine ?? 'Not suggested', note: g.note ?? '' })))],
          };
        },
      },
      {
        name: 'cr_line_explain',
        description: 'One Call Report item by its MDRM code (RCON or RIAD): this quarter against last, and what makes it up (its GL accounts, or for a total the items its formula adds).',
        input: z.object({ code: z.string().min(6).max(12) }).strict(),
        run: async (a: { code: string }, ctx) => {
          need(ctx);
          const q = await cr.quarters();
          const l = await cr.line(a.code.toUpperCase());
          const shown = l.text ?? (l.code === 'RCON7204' ? `${l.current}%` : dollars(l.current ?? 0));
          const how = l.gl.length ? ` It comes from the general ledger: ${l.gl.map((g) => `GL ${g.glNumber} ${g.name}`).join(', ')}.` : l.parts.length ? ` It adds ${l.parts.length} ${l.parts.length === 1 ? 'item' : 'items'}${l.formula ? ` (${l.formula})` : ''}.` : ` It comes from the ${l.source.toLowerCase()}.`;
          const top = [...l.parts].filter((p) => p.change !== null).sort((x, y) => Math.abs(y.change!) - Math.abs(x.change!))[0];
          const block = l.gl.length
            ? moduleTable(spec, `GL accounts in ${l.code}`, ctx.runId, 'callreport.line.explain', [{ field: 'gl', headerName: 'GL account', type: 'text' }, { field: 'name', headerName: 'Name', type: 'text' }, { field: 'prior', headerName: q.priorLabel ?? 'Prior', type: 'currency' }, { field: 'current', headerName: q.label, type: 'currency' }], l.gl.map((g) => ({ gl: g.glNumber, name: g.name, prior: g.prior, current: g.current })))
            : l.parts.length
              ? moduleTable(spec, `How ${l.code} is built`, ctx.runId, 'callreport.line.explain', lineCols(q.priorLabel ?? 'Prior', q.label), lineRows(l.parts))
              : null;
          return {
            text: `**${l.code}** (${l.schedule}), ${l.name}, is **${shown}** at ${q.label}${l.change !== null && l.code !== 'RCON7204' ? `, ${change(l)} from ${q.priorLabel}` : ''}.${how}${top && top.change ? ` **${top.code}** ${top.name} moved most, ${change(top)}.` : ''}`,
            ...(block ? { blocks: [block] } : {}),
          };
        },
      },
      {
        name: 'cr_variance',
        description: 'Items that moved by at least a percentage (and $100,000) since last quarter, largest first, with whether each has the explanation an intraseries edit needs. Excludes the year-to-date income statement.',
        input: z.object({ min_pct: z.number().min(0).max(1000).default(10) }).strict(),
        run: async (a: { min_pct: number }, ctx) => {
          need(ctx);
          const q = await cr.quarters();
          const v = await cr.variance(a.min_pct);
          if (!v.length) return { text: `No items moved ${a.min_pct}% or more from ${q.priorLabel}.` };
          const needed = v.filter((l) => l.explanation?.status === 'Needed');
          return {
            text: `**${v.length} ${v.length === 1 ? 'item' : 'items'}** moved ${a.min_pct}% or more from ${q.priorLabel}. The largest is **${v[0]!.code}**, ${v[0]!.name}, ${change(v[0]!)}.${needed.length ? ` ${needed.length} still ${needed.length === 1 ? 'needs' : 'need'} an explanation before submission: ${needed.map((l) => `**${l.code}**`).join(', ')}.` : ''}`,
            blocks: [moduleTable(spec, `Changes from ${q.priorLabel}`, ctx.runId, 'callreport.variance', [...lineCols(q.priorLabel ?? 'Prior', q.label), { field: 'explanation', headerName: 'Explanation', type: 'text' }], v.map((l) => ({ ...lineRows([l])[0]!, explanation: l.explanation ? (l.explanation.explanation ?? 'Needed') : '' })))],
            suggestions: [`How is ${v[0]!.code} built?`],
          };
        },
      },
      {
        name: 'cr_schedule',
        description: 'One schedule: RC, RC-B, RC-C, RC-E, RC-K, RC-N, RC-O, RC-R, RI, RI-A or RI-B, this quarter against last.',
        input: z.object({ schedule: z.string().min(2).max(6) }).strict(),
        run: async (a: { schedule: string }, ctx) => {
          need(ctx);
          const q = await cr.quarters();
          const ls = (await cr.schedule(a.schedule.toUpperCase())).filter((l) => l.schedule.toUpperCase() === a.schedule.toUpperCase());
          if (!ls.length) throw new CoreError('NOT_FOUND', `There’s no schedule ${a.schedule}. The schedules are RC, RC-B, RC-C, RC-E, RC-K, RC-N, RC-O, RC-R, RI, RI-A and RI-B.`);
          const total = [...ls].reverse().find((l) => l.kind === 'total') ?? ls.at(-1)!;
          return {
            text: `Schedule **${ls[0]!.schedule}**, ${ls[0]!.scheduleName}, at ${q.label}: ${total.name.toLowerCase()} **${total.text ?? dollars(total.current ?? 0)}**${total.change !== null ? `, ${change(total)} from ${q.priorLabel}` : ''}.${ls[0]!.schedule.startsWith('RI') ? ' Income statement items are year to date.' : ''}`,
            blocks: [moduleTable(spec, `Schedule ${ls[0]!.schedule}: ${ls[0]!.scheduleName}`, ctx.runId, 'callreport.schedule', lineCols(q.priorLabel ?? 'Prior', q.label), lineRows(ls))],
          };
        },
      },
      {
        name: 'cr_capital',
        description: 'RC-R Part I under the community bank leverage ratio: the election, Tier 1 and CET1 capital, total assets for the leverage ratio, the ratio against 8%, and equity with AOCI.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const [lev, t1, avg, eq, aoci, elect] = await Promise.all(['RCON7204', 'RCON8274', 'RCONA224', 'RCON3210', 'RCONB530', 'RCONLE74'].map((c) => value(c)));
          const ratio = lev?.current ?? 0;
          return {
            text: `The bank ${elect?.text === 'Yes' ? 'elects the **community bank leverage ratio**' : 'reports risk-based capital'}: Tier 1 capital of **${m(t1?.current ?? 0)}** on **${m(avg?.current ?? 0)}** of average assets is a leverage ratio of **${ratio.toFixed(2)}%**, against the 8% required from July 1, 2026${lev?.prior ? ` (${lev.prior.toFixed(2)}% last quarter)` : ''}. That makes it **well capitalized** with ${(ratio - 8).toFixed(2)} points to spare. Equity is ${m(eq?.current ?? 0)} after ${m(Math.abs(aoci?.current ?? 0))} of unrealized securities losses in AOCI, which the AOCI opt-out keeps out of Tier 1.`,
            blocks: [moduleTable(spec, 'RC-R Part I: regulatory capital', ctx.runId, 'callreport.capital', [{ field: 'item', headerName: 'Item', type: 'text' }, { field: 'name', headerName: 'Caption', type: 'text' }, { field: 'value', headerName: 'Q3 2026', type: 'text' }], [lev, t1, avg, eq, aoci, elect].filter((l): l is CallReportLine => !!l).map((l) => ({ item: l.code, name: l.name, value: l.text ?? (l.code === 'RCON7204' ? `${l.current?.toFixed(2)}%` : dollars(l.current ?? 0)) })))],
            suggestions: ['What’s our CRE concentration?'],
          };
        },
      },
      {
        name: 'cr_concentration',
        description: 'Commercial real estate concentration against the 2006 interagency guidance: non-owner-occupied CRE (construction, multifamily, other nonfarm nonresidential) over Tier 1 capital plus the allowance against 300%, construction against 100%, and growth over the year.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const codes = ['RCONF159', 'RCON1460', 'RCONF161', 'RCONF160', 'RCON8274', 'RCON3123'];
          const all = await cr.lines();
          const get = (c: string) => all.find((l) => l.code === c);
          const [construction, multifamily, other, owner, t1, acl] = codes.map((c) => get(c)!) as [CallReportLine, CallReportLine, CallReportLine, CallReportLine, CallReportLine, CallReportLine];
          const capital = (t1.current ?? 0) + (acl.current ?? 0);
          const cre = (construction.current ?? 0) + (multifamily.current ?? 0) + (other.current ?? 0);
          const crePct = (cre / capital) * 100;
          const conPct = ((construction.current ?? 0) / capital) * 100;
          const priorCre = (construction.prior ?? 0) + (multifamily.prior ?? 0) + (other.prior ?? 0);
          return {
            text: `Non-owner-occupied commercial real estate is **${m(cre)}**, **${crePct.toFixed(0)}%** of Tier 1 capital plus the allowance (${m(capital)}), against the interagency guidance of 300%. Construction and land development is **${conPct.toFixed(0)}%** against 100%. ${crePct >= 300 ? 'That is over the guidance, so examiners expect heightened risk management.' : crePct >= 250 ? 'That is close to the guidance: worth a board discussion of limits.' : 'That is within the guidance.'} CRE moved ${priorCre ? `${(((cre - priorCre) / priorCre) * 100).toFixed(1)}%` : '—'} since last quarter; the guidance's second test is growth of 50% or more over 36 months. Owner-occupied CRE (${m(owner.current ?? 0)}) doesn't count toward it.`,
            blocks: [moduleTable(spec, 'CRE concentration', ctx.runId, 'callreport.concentration', [{ field: 'item', headerName: 'Item', type: 'text' }, { field: 'name', headerName: 'Caption', type: 'text' }, { field: 'value', headerName: 'Q3 2026', type: 'currency' }, { field: 'pct', headerName: 'Of capital', type: 'text' }], [construction, multifamily, other, owner].map((l) => ({ item: l.code, name: l.name, value: Math.round(l.current ?? 0), pct: l === owner ? 'Excluded' : `${(((l.current ?? 0) / capital) * 100).toFixed(0)}%` })))],
          };
        },
      },
    ],
  };
  return spec;
}
