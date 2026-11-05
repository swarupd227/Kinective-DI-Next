// Drill to records: "Show the loans behind delinquency 60+ at Eastgate" lists the loans, accounts or
// members a metric counts, under the same filters and the person's purview, largest first. Every
// table, chart and tile built from such a metric offers it, so any number leads to its records.
import { z } from 'zod';
import { CoreError } from '@dinext/di-core';
import type { SemanticService } from '@dinext/semantic';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const NO_ACCESS = 'Listing the records behind a number isn’t part of your DI access.';
const guard = (ctx: ModuleContext) => {
  if (!ctx.modules.includes('records')) throw new CoreError('NO_ACCESS', NO_ACCESS);
};
const usd = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n).toLocaleString('en-US')}`);
/** Dimensions a request may name by value: "at Eastgate", "for auto loans". */
const NAMED = ['branch', 'region', 'loan_category', 'deposit_category', 'segment', 'delinquency_bucket', 'origination_channel'];

/** The words that ask for the records behind a figure. */
export const RECORDS_REQUEST = /\b(show|list|give)( me)?( the| all)? (loans|accounts|members|customers|records|certificates)( that are| that make up)? (behind|making up|in)\b/i;

/** The metric and filters a request names, from the governed catalog: the longest label or synonym wins. */
export function parseRecordsRequest(svc: SemanticService, text: string) {
  const after = text.replace(/^.*?\b(behind|making up|make up)\b/i, '').toLowerCase();
  const t = ` ${after.replace(/[^a-z0-9+% -]/g, ' ')} `;
  let best: { metric: string; len: number } | null = null;
  for (const [name, m] of Object.entries(svc.model.metrics)) {
    if (!svc.recordKind(name)) continue;
    const words = [m.label.replace(/\s*\(.*\)$/, ''), ...(m.synonyms ?? [])].map((w) => w.toLowerCase());
    for (const w of words) if (w.length > 2 && t.includes(` ${w} `) && (!best || w.length > best.len)) best = { metric: name, len: w.length };
  }
  if (!best && /delinquen|past due|60\+/.test(t)) best = { metric: 'delinquency_ratio_60_plus', len: 0 };
  const filters = NAMED.flatMap((d) => {
    const values = (svc.dimensionValues[d] ?? []).filter((v) => new RegExp(`\\b${v.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`).test(after));
    return values.length ? [{ dimension: d, values }] : [];
  });
  return { metric: best?.metric ?? null, filters };
}

export function recordsModule(svc: SemanticService): ModuleSpec {
  const spec: ModuleSpec = {
    id: 'records',
    prefix: 'rec',
    agent: 'Records',
    request: RECORDS_REQUEST,
    noAccess: NO_ACCESS,
    sources: [{ kind: 'table', label: 'Loans, accounts and members', ref: 'table:cdm_loan' }],
    prompt: ({ tenant, user, title }) => `You are the Records agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) asks for the loans, accounts or members behind a figure. Call rec_list with the governed metric name and any filters (dimension and values), such as delinquency_ratio_60_plus with branch Eastgate. Records follow the same definition as the figure and the person's purview. You only read.`,
    plan: (text) => {
      const p = parseRecordsRequest(svc, text);
      if (!p.metric) return { say: 'Which figure? For example, “Show the loans behind delinquency 60+ at Eastgate” or “Show the accounts behind certificates maturing in 90 days”.' };
      return { tool: 'rec_list', args: { metric: p.metric, filters: p.filters, limit: 50 } };
    },
    tools: [
      {
        name: 'rec_list',
        description: 'The loans, accounts or members a governed metric counts, with filters by dimension value, largest first: count, total balance and the records.',
        input: z.object({ metric: z.string().min(2).max(60), filters: z.array(z.object({ dimension: z.string().max(40), values: z.array(z.string().max(60)).min(1).max(10) })).max(4).default([]), limit: z.number().int().min(1).max(200).default(50) }).strict(),
        run: async (a: { metric: string; filters: { dimension: string; values: string[] }[]; limit: number }, ctx) => {
          guard(ctx);
          const r = await svc.records({ metric: a.metric, filters: a.filters, limit: a.limit }, { purviewBranches: ctx.purviewBranches, memberDetails: ctx.modules.includes('records-members') });
          const where = r.conditions.slice(1).map((c) => c.replace(/^.* is /, '')).join(', ');
          const noun = r.kind === 'members' ? (svc.model.institutionType === 'bank' ? 'customers' : 'members') : r.kind;
          const first = r.rows[0];
          const lead = r.count
            ? `**${r.count.toLocaleString('en-US')} ${noun}**${where ? ` (${where})` : ''} make up ${r.label.toLowerCase()}${r.total !== null ? `, **${usd(r.total)}** in all` : ''}.${first && r.kind !== 'members' ? ` The largest is ${first.member}’s ${String(first.category).toLowerCase()} ${r.kind === 'loans' ? 'loan' : 'account'}, ${usd(Number(first.balance))}${r.kind === 'loans' && Number(first.days_past_due) ? `, ${first.days_past_due} days past due` : ''}.` : ''}${r.count > r.rows.length ? ` Showing the ${r.rows.length} largest.` : ''}`
            : `No ${noun} make up ${r.label.toLowerCase()}${where ? ` for ${where}` : ''}.`;
          const cols =
            r.kind === 'loans'
              ? [{ field: 'id', headerName: 'Loan', type: 'text' as const }, { field: 'member', headerName: 'Member', type: 'text' as const }, { field: 'branch', headerName: 'Branch', type: 'text' as const }, { field: 'category', headerName: 'Type', type: 'text' as const }, { field: 'balance', headerName: 'Balance', type: 'currency' as const }, { field: 'rate', headerName: 'Rate', type: 'text' as const }, { field: 'days_past_due', headerName: 'Days past due', type: 'count' as const }, { field: 'opened', headerName: 'Opened', type: 'date' as const }]
              : r.kind === 'accounts'
                ? [{ field: 'id', headerName: 'Account', type: 'text' as const }, { field: 'member', headerName: 'Member', type: 'text' as const }, { field: 'branch', headerName: 'Branch', type: 'text' as const }, { field: 'category', headerName: 'Product', type: 'text' as const }, { field: 'balance', headerName: 'Balance', type: 'currency' as const }, { field: 'rate', headerName: 'Rate', type: 'text' as const }, { field: 'matures', headerName: 'Matures', type: 'date' as const }, { field: 'opened', headerName: 'Opened', type: 'date' as const }]
                : [{ field: 'member', headerName: 'Member', type: 'text' as const }, { field: 'branch', headerName: 'Branch', type: 'text' as const }, { field: 'category', headerName: 'Segment', type: 'text' as const }, { field: 'opened', headerName: 'Joined', type: 'date' as const }];
          const rows = r.rows.map((x) => ({ ...x, id: String(x.id), ...(x.rate !== undefined ? { rate: `${Number(x.rate).toFixed(2)}%` } : {}) })) as Record<string, string | number>[];
          return {
            text: `${lead}${ctx.modules.includes('records-members') ? '' : ' Member names are hidden for your access.'}`,
            blocks: [moduleTable(spec, `${r.label}${where ? `, ${where}` : ''}: the ${noun}`, ctx.runId, 'records.list', cols, rows)],
          };
        },
      },
    ],
  };
  return spec;
}
