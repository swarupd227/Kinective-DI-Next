// Pipeline Forecast: projected closings for the next 30, 60 and 90 days, each application weighted by
// how often its stage goes on to close, approvals waiting to close, and applications by credit tier
// with how often each tier is approved. Scope follows the pipeline's own views: mine, location, team or
// institution. Working a stalled application stays with the Loan Pipeline agent.
import { z } from 'zod';
import { CoreError, PipelineService, type PipelineView } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const PIPELINE_FORECAST_REQUEST =
  /\bprojected closings?\b|\b(?:expected|projected|forecast(?:ed)?) (?:to )?(?:close|closings?|fundings?)\b|\bclosings? (?:forecast|projection|this month|next (?:\d+ days|month|quarter))\b|\bforecast\b[^.?!]*\b(?:closings?|fundings?|the pipeline)\b|\bwhat(?:'s| is| will) (?:going to )?clos(?:e|ing)\b|\bpull[- ]through\b|\b(?:fico|credit(?: score)?) (?:tiers?|bands?|segments?)\b|\b(?:applications?|apps|pipeline) by (?:fico|credit)\b|\bapproved (?:but|and) not (?:yet )?(?:funded|closed)\b|\bwaiting to (?:close|fund)\b/i;

const NO_ACCESS = 'The loan pipeline isn’t part of your DI access.';
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const mm = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString('en-US')}`);

export function pipelineForecastModule(svc: PipelineService): ModuleSpec {
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('lapforecast')) throw new CoreError('NO_ACCESS', NO_ACCESS);
  };
  const who = (ctx: ModuleContext) => ({ employeeId: ctx.employeeId, leads: ctx.leads, details: true });
  /** The widest view this person has: institution, then team, then location, then their own. */
  const viewFor = async (ctx: ModuleContext): Promise<PipelineView> => {
    const views = await svc.views(who(ctx), ctx);
    const view = (['institution', 'team', 'location', 'mine'] as PipelineView[]).find((v) => views.includes(v));
    if (!view) throw new CoreError('NO_ACCESS', NO_ACCESS);
    return view;
  };
  const scopeName: Record<PipelineView, string> = { mine: 'your pipeline', location: 'your branch', team: 'your team', institution: 'the institution' };
  const sources: ModuleSpec['sources'] = [{ kind: 'table', label: 'Loan applications, from the LOS', ref: 'table:cdm_loan_application' }];
  const spec: ModuleSpec = {
    id: 'lapforecast',
    prefix: 'lapf',
    agent: 'Pipeline Forecast',
    request: PIPELINE_FORECAST_REQUEST,
    noAccess: NO_ACCESS,
    sources,
    prompt: ({ tenant, user, title }) => `You are the Pipeline Forecast agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) wants to know what will close and the credit quality of applications.

- lap_forecast: projected closings for 30, 60 and 90 days, weighted by how often each stage closes, by product, and approvals waiting to close.
- lap_credit_tiers: applications in the last 120 days by credit tier (A 740+, B 680 to 739, C 620 to 679, D below 620), dollars and approval rate.`,
    plan: (t) => (/\b(?:fico|credit)\b/i.test(t) ? { tool: 'lap_credit_tiers', args: {} } : { tool: 'lap_forecast', args: {} }),
    tools: [
      {
        name: 'lap_forecast',
        description: 'Projected closings for the next 30, 60 and 90 days, weighted by stage pull-through, by product, and the approvals scheduled to close.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const view = await viewFor(ctx);
          const x = await svc.forecast(view, who(ctx), ctx);
          const [d30, d60, d90] = x.windows;
          return {
            text: `For ${scopeName[view]}, about **${mm(d30!.expectedDollars)}** should close in the next 30 days (${d30!.expectedCount} of ${d30!.count} applications, weighted by how often each stage closes), ${mm(d60!.expectedDollars)} within 60 and **${mm(d90!.expectedDollars)}** within 90.${x.scheduled.length ? ` ${x.scheduled.length} ${x.scheduled.length === 1 ? 'approval is' : 'approvals are'} waiting to close, ${mm(x.scheduled.reduce((s, a) => s + a.amount, 0))}.` : ''}${x.products[0] ? ` ${x.products[0].product} leads, ${mm(x.products[0].expectedDollars)}.` : ''}`,
            blocks: [
              moduleTable(spec, 'Projected closings', ctx.runId, 'lap.forecast', [text('window', 'Closing within'), { field: 'count', headerName: 'Applications', type: 'count' }, { field: 'dollars', headerName: 'If all close', type: 'currency' }, text('expected', 'Expected to close'), { field: 'expectedDollars', headerName: 'Expected dollars', type: 'currency' }], x.windows.map((w) => ({ window: `${w.days} days`, count: w.count, dollars: w.dollars, expected: String(w.expectedCount), expectedDollars: w.expectedDollars }))),
              moduleTable(spec, 'Expected in 90 days, by product', ctx.runId, 'lap.forecast.products', [text('product', 'Product'), { field: 'count', headerName: 'Applications', type: 'count' }, { field: 'dollars', headerName: 'Expected dollars', type: 'currency' }], x.products.map((p) => ({ product: p.product, count: p.count, dollars: p.expectedDollars }))),
              ...(x.scheduled.length ? [moduleTable(spec, 'Approved, waiting to close', ctx.runId, 'lap.forecast.scheduled', [text('id', 'Application'), text('name', 'Applicant'), text('product', 'Product'), { field: 'amount', headerName: 'Amount', type: 'currency' }, text('close', 'Closing'), text('owner', 'Loan officer')], x.scheduled.slice(0, 50).map((a) => ({ id: `#${a.applicationId}`, name: a.name, product: a.product, amount: a.amount, close: a.expectedClose!, owner: a.owner?.name ?? '' })))] : []),
            ],
            sources,
            suggestions: ['Show applications by credit tier', 'Show my stalled applications'],
          };
        },
      },
      {
        name: 'lap_credit_tiers',
        description: 'Applications in the last 120 days by credit tier (A 740+, B 680 to 739, C 620 to 679, D below 620): how many, dollars, still open, and how often each tier is approved.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const view = await viewFor(ctx);
          const x = await svc.creditTiers(view, who(ctx), ctx);
          const total = x.tiers.reduce((s, t) => s + t.count, 0);
          const low = x.tiers.filter((t) => t.tier === 'C' || t.tier === 'D').reduce((s, t) => s + t.count, 0);
          const a = x.tiers[0]!;
          const d = x.tiers.at(-1)!;
          return {
            text: `Of **${total} applications** in the last 120 days for ${scopeName[view]}, ${a.count} are tier A (740+) and ${low} are C or D (below 680). Tier A is approved ${a.approvalPct ?? '—'}% of the time, tier D ${d.approvalPct ?? '—'}%.`,
            blocks: [moduleTable(spec, 'Applications by credit tier, last 120 days', ctx.runId, 'lap.credit_tiers', [text('tier', 'Credit tier'), { field: 'count', headerName: 'Applications', type: 'count' }, { field: 'dollars', headerName: 'Dollars', type: 'currency' }, { field: 'open', headerName: 'Still open', type: 'count' }, text('approval', 'Approved when decided')], x.tiers.map((t) => ({ tier: t.label, count: t.count, dollars: t.dollars, open: t.open, approval: t.approvalPct === null ? '—' : `${t.approvalPct}%` })))],
            sources,
            suggestions: ['What will close in the next 30 days?', 'Show my stalled applications'],
          };
        },
      },
    ],
  };
  return spec;
}
