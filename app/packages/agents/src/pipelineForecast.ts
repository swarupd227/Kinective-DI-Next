// Pipeline Forecast: projected closings for the next 30, 60 and 90 days, each application weighted by
// how often its stage goes on to close, approvals waiting to close, and applications by credit tier
// with how often each tier is approved. Scope follows the pipeline's own views: mine, location, team or
// institution. Working a stalled application stays with the Loan Pipeline agent.
import { z } from 'zod';
import { CoreError, PipelineService, type PipelineView } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const PIPELINE_FORECAST_REQUEST =
  /\bprojected closings?\b|\b(?:expected|projected|forecast(?:ed)?) (?:to )?(?:close|closings?|fundings?)\b|\bclosings? (?:forecast|projection|this month|next (?:\d+ days|month|quarter))\b|\bforecast\b[^.?!]*\b(?:closings?|fundings?|(?:the |my |our )?(?:loan )?pipeline)\b|\bpipeline forecast\b|\bwhat (?:will|is going to) (?:fund|close)\b|\bfund(?:ings?)? by month\b|\bwhat(?:'s| is| will) (?:going to )?clos(?:e|ing)\b|\bpull[- ]through\b|\b(?:fico|credit(?: score)?) (?:tiers?|bands?|segments?)\b|\b(?:applications?|apps|pipeline) by (?:fico|credit)\b|\bapproved (?:but|and) not (?:yet )?(?:funded|closed)\b|\bwaiting to (?:close|fund)\b|\b(?:application|app) quality\b|\b(?:withdrawal|withdrawn|incomplete) (?:rates?|applications)\b|\b(?:time|days) to decision\b|(?<!\b(?:org|branch) )\b(?:loan )?hierarchy\b|\bsunburst\b|\bbooked loans? by (?:region|loan officer|channel)\b|\bdirect (?:and|vs\.?|versus) indirect\b/i;

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
- lap_credit_tiers: applications in the last 120 days by credit tier (A 740+, B 680 to 739, C 620 to 679, D below 620), dollars and approval rate.
- lap_quality (by officer, product or branch): application quality as rates over 120 days: decided, approved, denied, withdrawn, days to decision, on hold, incomplete, stalled; the hold reasons; duplicates.
- lap_hierarchy (channel Direct or Indirect, region, branch, from): booked loan dollars one level down at a time, institution to direct or indirect, region, branch and loan officer. Drill by passing the level picked.`,
    plan: (t) => {
      const s = t.toLowerCase();
      if (/\b(?:quality|withdrawn|withdrawal|incomplete|time to decision|days to decision|approval rates?|kpis?)\b/.test(s)) return { tool: 'lap_quality', args: { by: /\bby product\b/.test(s) ? 'product' : /\bby branch\b/.test(s) ? 'branch' : 'officer' } };
      if (/\bhierarchy\b|\bdrill\b|\bsunburst\b|\bby (?:region|loan officer)\b|\bdirect (?:and|vs\.?|versus) indirect\b/.test(s)) {
        const channel = /\bindirect\b/.test(s) && !/\bdirect (?:and|vs\.?|versus) indirect\b/.test(s) ? 'Indirect' : /\bdirect\b/.test(s) && !/\bindirect\b/.test(s) ? 'Direct' : undefined;
        return { tool: 'lap_hierarchy', args: channel ? { channel } : {} };
      }
      return /\b(?:fico|credit)\b/i.test(t) ? { tool: 'lap_credit_tiers', args: {} } : { tool: 'lap_forecast', args: {} };
    },
    tools: [
      {
        name: 'lap_quality',
        description: 'Application quality as rates over the last 120 days, by loan officer, product or branch: decided, approved, denied and withdrawn shares, average days to a decision, the share of open applications on hold, incomplete (waiting on the applicant) and stalled, the hold reasons, and duplicates removed.',
        input: z.object({ by: z.enum(['officer', 'product', 'branch']).default('officer') }).strict(),
        run: async (a: { by: 'officer' | 'product' | 'branch' }, ctx) => {
          need(ctx);
          const view = await viewFor(ctx);
          const by = a.by ?? 'officer';
          const q = await svc.quality(view, who(ctx), ctx, by);
          const t = q.total;
          const p = (n: number | null) => (n === null ? '—' : `${n}%`);
          const label = { officer: 'Loan officer', product: 'Product', branch: 'Branch' }[by];
          const slowest = [...q.rows].filter((r) => r.daysToDecision !== null && r.applications >= 5).sort((x, y) => y.daysToDecision! - x.daysToDecision!)[0];
          return {
            text: `Since ${q.from}, ${t.applications} applications in ${scopeName[view]}: **${p(t.approvedPct)}** of those decided were approved, ${p(t.withdrawnPct)} were withdrawn, and a decision took **${t.daysToDecision ?? '—'} days** on average. Of the open ones, ${p(t.onHoldPct)} are on hold and ${p(t.incompletePct)} are waiting on the applicant.${slowest ? ` Slowest to decide: ${slowest.name}, ${slowest.daysToDecision} days.` : ''}${q.duplicates ? ` ${q.duplicates} duplicate applications were left out.` : ''}`,
            blocks: [
              moduleTable(spec, `Application quality by ${label.toLowerCase()}`, ctx.runId, 'lap.quality', [text('name', label), { field: 'applications', headerName: 'Applications', type: 'count' }, text('decided', 'Decided'), text('approved', 'Approved'), text('denied', 'Denied'), text('withdrawn', 'Withdrawn'), text('days', 'Days to decision'), text('hold', 'On hold'), text('incomplete', 'Incomplete'), text('stalled', 'Stalled')], [...q.rows, t].map((r) => ({ name: r.name, applications: r.applications, decided: p(r.decidedPct), approved: p(r.approvedPct), denied: p(r.deniedPct), withdrawn: p(r.withdrawnPct), days: r.daysToDecision === null ? '—' : String(r.daysToDecision), hold: p(r.onHoldPct), incomplete: p(r.incompletePct), stalled: p(r.stalledPct) }))),
              ...(q.holdReasons.length ? [moduleTable(spec, 'Open applications on hold, by reason', ctx.runId, 'lap.quality.holds', [text('label', 'Waiting on'), { field: 'count', headerName: 'Applications', type: 'count' }], q.holdReasons)] : []),
            ],
            sources,
          };
        },
      },
      {
        name: 'lap_hierarchy',
        description: 'Booked loan dollars as a hierarchy, one level down at a time: institution to Direct or Indirect, then region, branch and loan officer, for loans opened from a date (default the start of the year).',
        input: z.object({ channel: z.enum(['Direct', 'Indirect']).optional(), region: z.string().max(40).optional(), branch: z.string().max(40).optional(), from: z.string().regex(/^20\d\d-\d\d-\d\d$/).optional() }).strict(),
        run: async (a: { channel?: 'Direct' | 'Indirect'; region?: string; branch?: string; from?: string }, ctx) => {
          need(ctx);
          const h = await svc.hierarchy({ channel: a.channel, region: a.region, branch: a.branch }, ctx, a.from);
          if (!h.rows.length) return { text: 'No loans were booked there in that period.' };
          const where = [a.channel, a.region, a.branch].filter(Boolean).join(' › ') || 'All loans';
          const label = { channel: 'Direct or indirect', region: 'Region', branch: 'Branch', officer: 'Loan officer' }[h.level as 'channel' | 'region' | 'branch' | 'officer'];
          const top = h.rows[0]!;
          const nextAsk = h.level === 'channel' ? `Drill into ${top.name} loans by region` : h.level === 'region' ? `Show ${a.channel} loans in ${top.name} by branch` : h.level === 'branch' ? `Show ${a.channel} loans at ${top.name} by loan officer` : null;
          return {
            text: `${where === 'All loans' ? 'For the institution' : where}: **${mm(h.total)}** booked since ${h.from}. By ${label.toLowerCase()}, **${top.name}** leads with ${mm(top.dollars)} (${top.sharePct}%).`,
            blocks: [moduleTable(spec, `${where}, by ${label.toLowerCase()}`, ctx.runId, 'lap.hierarchy', [text('name', label), { field: 'loans', headerName: 'Loans', type: 'count' }, { field: 'dollars', headerName: 'Dollars', type: 'currency' }, text('share', 'Share')], h.rows.map((r) => ({ ...r, share: `${r.sharePct}%` })))],
            sources: [{ kind: 'table', label: 'Loans booked, from the core', ref: 'table:cdm_loan' }],
            ...(nextAsk ? { suggestions: [nextAsk] } : {}),
          };
        },
      },
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
