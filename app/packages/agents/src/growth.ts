// Indirect Lending (spec 8.28) and Outbound Prospecting (8.31) on the shared agent. Figures, visit
// orders and distances come from DI Core. Logging a visit or a call is low risk; changing a dealer's
// rep or a prospect's stage is medium (spec approval rules).
import { z } from 'zod';
import { CoreError, type IndirectService, type ProspectService } from '@dinext/di-core';
import { money } from './pipelineAgent.ts';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/’/g, "'");
const pct = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 1000) / 10 : 0);
const change = (now: number, before: number) => (before ? `${now >= before ? 'up' : 'down'} ${Math.abs(pct(now, before))}%` : 'new this period');

export function indirectModule(ind: IndirectService, dealerNames: string[], today: () => string): ModuleSpec {
  const noAccess = 'Indirect Lending isn’t part of your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('indirect')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const names = dealerNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const dealerIn = (t: string) => dealerNames.find((n) => t.toLowerCase().includes(n.toLowerCase()));
  const spec: ModuleSpec = {
    id: 'indirect',
    prefix: 'ind',
    agent: 'Indirect Lending',
    // A dealer's agreement or documents belong to Files.
    request: new RegExp(`^(?!.*\\b(agreement|docs?|documents?)\\b).*(\\bdealers?\\b|\\bindirect[- ]to[- ]direct\\b|\\bindirect borrowers\\b|\\b(${names})\\b)`, 'i'),
    noAccess,
    sources: [{ kind: 'table', label: 'Dealer performance', ref: 'table:ind_dealer_month' }],
    prompt: ({ tenant, user, title }) => `You are the Indirect Lending agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) works with auto dealers.

- "How did Smith Ford do this quarter compared with last?": ind_performance with the dealer and period quarter.
- "Which dealers had the biggest drop in funded loans this month?": ind_performance with period month.
- "Plan visits for my top ten dealers near Westport": ind_visit_plan.
- "Log a visit to Smith Ford: met the finance manager": ind_visit_log with their words as note.
- "Make Tom Walsh the rep for Smith Ford": ind_rep_change.
- "How many indirect borrowers became direct members this year?": ind_direct_conversion.`,
    plan: (text) => {
      const t = clean(text);
      const dealer = dealerIn(t);
      const period = /\bquarter\b/i.test(t) ? 'quarter' : 'month';
      if (/\bindirect[- ]to[- ]direct\b|\bbecame direct\b|\bdirect members\b/i.test(t)) return { tool: 'ind_direct_conversion', args: {} };
      if (/^\s*log\b|\blog a visit\b/i.test(t)) return dealer ? { tool: 'ind_visit_log', args: { dealer, note: /[:—;]\s*(.+)$/.exec(t)?.[1] ?? 'Visited.' } } : { say: 'Which dealer did you visit?' };
      const rep = /\b[Mm]ake ((?:[A-Z][\w'-]*\s?){1,3}?)\s+the rep\b/.exec(t)?.[1];
      if (rep) return dealer ? { tool: 'ind_rep_change', args: { dealer, rep: rep.trim() } } : { say: 'Which dealer?' };
      if (/\bplan\b.*\bvisits?\b/i.test(t)) return { tool: 'ind_visit_plan', args: { count: Number(/\btop (\d+)\b/i.exec(t)?.[1] ?? (/\bten\b/i.test(t) ? 10 : 5)), near: /\bnear ([A-Z][a-z]+)/.exec(t)?.[1] ?? '' } };
      return { tool: 'ind_performance', args: { period, ...(dealer ? { dealer } : {}) } };
    },
    tools: [
      {
        name: 'ind_performance',
        description: 'Dealer performance for this month or quarter against the one before: applications received, decisions, funded loans and dollars, and average FICO. One dealer, or the ranking.',
        input: z.object({ period: z.enum(['month', 'quarter']).default('month'), dealer: z.string().max(80).optional() }).strict(),
        run: async (a: { period: 'month' | 'quarter'; dealer?: string }, ctx) => {
          need(ctx);
          const p = await ind.performance(a.period, ctx);
          if (a.dealer) {
            const one = await ind.dealer(a.dealer, ctx);
            const d = p.dealers.find((x) => x.dealerId === one.dealerId)!;
            return { text: `**${d.name}** funded **${d.funded} loans** for ${money(d.fundedAmount)} in ${p.label}, ${p.partial ? `against ${d.prior.funded} in all of ${p.priorLabel}` : `${change(d.funded, d.prior.funded)} on ${p.priorLabel} (${d.prior.funded})`}. Received ${d.received} applications: ${d.approved} approved, ${d.declined} declined, ${d.countered} countered. Average FICO ${d.avgFico}. ${one.rep} is the rep; last visit ${one.lastVisited ?? 'not recorded'}.`, suggestions: [`Log a visit to ${d.name}`] };
          }
          const drops = p.dealers.filter((d) => d.prior.funded > d.funded).sort((x, y) => (x.funded - x.prior.funded) - (y.funded - y.prior.funded));
          const top = p.dealers[0];
          return { text: `${p.dealers.length} dealers in ${p.label}. ${top ? `**${top.name}** sent the most applications (${top.received}).` : ''} ${drops.length ? `The biggest drop in funded loans is **${drops[0]!.name}**: ${drops[0]!.funded}, down from ${drops[0]!.prior.funded} in ${p.priorLabel}.` : `No dealer funded fewer loans than in ${p.priorLabel}.`}${p.partial ? ` ${p.label.replace(' to date', '')} isn’t over yet, so it’s set against a whole ${p.priorLabel}.` : ''}`, blocks: [moduleTable(spec, `Dealers, ${p.label}`, ctx.runId, 'indirect.dealer.performance', [{ field: 'name', headerName: 'Dealer', type: 'text' }, { field: 'received', headerName: 'Received', type: 'count' }, { field: 'approved', headerName: 'Approved', type: 'count' }, { field: 'funded', headerName: 'Funded', type: 'count' }, { field: 'amount', headerName: 'Funded $', type: 'currency' }, { field: 'change', headerName: `vs ${p.priorLabel}`, type: 'text' }, { field: 'fico', headerName: 'Avg FICO', type: 'number' }], p.dealers.map((d) => ({ name: d.name, received: d.received, approved: d.approved, funded: d.funded, amount: d.fundedAmount, change: change(d.funded, d.prior.funded), fico: d.avgFico })))] };
        },
      },
      {
        name: 'ind_visit_plan',
        description: 'The busiest active dealers this month, in visit order from a branch, with miles between stops and a directions link.',
        input: z.object({ count: z.number().int().min(1).max(12).default(5), near: z.string().min(2).max(40).describe('A branch name') }).strict(),
        run: async (a: { count: number; near: string }, ctx) => {
          need(ctx);
          if (!a.near) throw new CoreError('INVALID', 'Which branch should the visits start from?');
          const v = await ind.planVisits(a.count, a.near, ctx);
          return { text: `Visit order from ${v.start} for ${v.stops.length} dealers, about **${v.total} miles** of driving between stops.${v.directions ? ` [Open directions](${v.directions})` : ''}`, blocks: [moduleTable(spec, 'Visit plan', ctx.runId, 'indirect.visit.plan', [{ field: 'stop', headerName: 'Stop', type: 'number' }, { field: 'name', headerName: 'Dealer', type: 'text' }, { field: 'leg', headerName: 'Miles from last', type: 'number' }, { field: 'received', headerName: 'Received this month', type: 'count' }, { field: 'rep', headerName: 'Rep', type: 'text' }], v.stops.map((s, i) => ({ stop: i + 1, name: s.name, leg: s.leg, received: s.received, rep: s.rep })))] };
        },
      },
      {
        name: 'ind_visit_log',
        description: 'Prepare logging a visit to a dealer today. Adds a visit and sets Date Last Visited. Returns approval_required.',
        input: z.object({ dealer: z.string().min(2).max(80), note: z.string().min(2).max(300) }).strict(),
        run: async (a: { dealer: string; note: string }, ctx) => {
          need(ctx);
          const d = await ind.dealer(a.dealer, ctx);
          const on = today();
          return { change: { summary: `Log a visit to ${d.name}`, changes: [{ label: 'Visit', before: '—', after: a.note }, { label: 'Date last visited', before: d.lastVisited ?? '—', after: on }, { label: 'Visits this year', before: String(d.ytdVisits), after: String(d.ytdVisits + 1) }], text: `I’ve prepared the visit to **${d.name}**.`, done: `Logged the visit to **${d.name}**.`, risk: 'low', apply: { dealerId: d.dealerId, note: a.note } } };
        },
        apply: async (p: { dealerId: number; note: string }, meta, ctx) => ind.logVisit(p.dealerId, p.note, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }),
      },
      {
        name: 'ind_rep_change',
        description: 'Prepare giving a dealer a different rep. Returns approval_required.',
        input: z.object({ dealer: z.string().min(2).max(80), rep: z.string().min(2).max(80) }).strict(),
        run: async (a: { dealer: string; rep: string }, ctx) => {
          need(ctx);
          const d = await ind.dealer(a.dealer, ctx);
          return { change: { summary: `Make ${a.rep} the rep for ${d.name}`, changes: [{ label: `${d.name} rep`, before: d.rep, after: a.rep }], text: `I’ve prepared the rep change for **${d.name}**.`, done: `**${a.rep}** is now the rep for ${d.name}.`, risk: 'medium', apply: { dealerId: d.dealerId, rep: a.rep } } };
        },
        apply: async (p: { dealerId: number; rep: string }) => ind.setRep(p.dealerId, p.rep),
      },
      {
        name: 'ind_direct_conversion',
        description: 'How many indirect borrowers went on to open a deposit account this year. Needs the indirect-to-direct permission.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          if (!ctx.modules.includes('indirect-direct')) throw new CoreError('NO_ACCESS', 'The indirect-to-direct report needs its own permission.');
          const year = Number(today().slice(0, 4));
          const c = await ind.directConversion(year, ctx);
          return { text: `**${c.converted.toLocaleString('en-US')} of ${c.borrowers.toLocaleString('en-US')} indirect borrowers** opened a deposit account in ${year}, after their loan: ${c.borrowers ? Math.round((c.converted / c.borrowers) * 1000) / 10 : 0}%.` };
        },
      },
    ],
  };
  return spec;
}

export function prospectingModule(prs: ProspectService, companies: string[], stages: string[], today: () => string): ModuleSpec {
  const noAccess = 'Outbound Prospecting isn’t part of your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('prospecting')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const companyIn = (t: string) => companies.find((c) => t.toLowerCase().includes(c.toLowerCase())) ?? companies.find((c) => new RegExp(`\\b${escape(c.split(' ')[0]!)}\\b`, 'i').test(t));
  const stageIn = (t: string) => [...stages].sort((a, b) => b.length - a.length).find((s) => new RegExp(`\\b${escape(s)}\\b`, 'i').test(t));
  const spec: ModuleSpec = {
    id: 'prospecting',
    prefix: 'prs',
    agent: 'Prospecting',
    // Full names only, or a move to one of its own stages: SEG has an "Acme HR" too.
    request: new RegExp(`\\bprospects?\\b|\\bprospecting\\b|\\bplan a route\\b|\\blog a call with (${companies.map(escape).join('|')})\\b|\\bmove\\b.*\\bto (${stages.map(escape).join('|')})\\s*$`, 'i'),
    noAccess,
    sources: [{ kind: 'table', label: 'Prospects', ref: 'table:prs_prospect' }],
    prompt: ({ tenant, user, title }) => `You are the Outbound Prospecting agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) develops business prospects.

- "Show my prospects in Qualified with assets over $5 million": prs_list.
- "Plan a route for tomorrow to prospects within 10 miles of Westport": prs_route.
- "Log a call with Acme Manufacturing: no answer, try Thursday": prs_call_log.
- "Move Acme to Pre-Qualified": prs_stage.
- "What's our conversion from Prospect to Application this quarter?": prs_conversion.
Stages: ${stages.join(', ')}.`,
    plan: (text) => {
      const t = clean(text);
      const company = companyIn(t);
      if (/\bconversion\b/i.test(t)) {
        const m = /\bfrom ([\w-]+)\s+to\s+([\w-]+)/i.exec(t);
        return m ? { tool: 'prs_conversion', args: { from: m[1]!, to: m[2]! } } : { say: 'Conversion from which stage to which?' };
      }
      if (/\broute\b/i.test(t)) return { tool: 'prs_route', args: { near: /\b(?:of|near|from) ([A-Z][a-z]+)/.exec(t)?.[1] ?? '', miles: Number(/(\d+)\s*miles?\b/i.exec(t)?.[1] ?? 10) } };
      if (/^\s*log\b/i.test(t)) return company ? { tool: 'prs_call_log', args: { company, note: /[:—;]\s*(.+)$/.exec(t)?.[1] ?? 'Called.' } } : { say: 'Which prospect did you call?' };
      const stage = stageIn(t);
      if (/^\s*move\b/i.test(t)) return company && stage ? { tool: 'prs_stage', args: { company, stage } } : { say: 'Which prospect, and to which stage?' };
      const assets = /\bover \$?(\d+(?:\.\d+)?)\s*(million|m)\b/i.exec(t);
      return { tool: 'prs_list', args: { ...(stage ? { stage } : {}), ...(assets ? { min_assets: Number(assets[1]) * 1e6 } : {}) } };
    },
    tools: [
      {
        name: 'prs_list',
        description: 'Prospects, optionally in one stage and over an asset size, with the funnel.',
        input: z.object({ stage: z.string().max(40).optional(), min_assets: z.number().min(0).optional() }).strict(),
        run: async (a: { stage?: string; min_assets?: number }, ctx) => {
          need(ctx);
          const list = await prs.list({ stage: a.stage, minAssets: a.min_assets }, ctx);
          const funnel = await prs.funnel(ctx);
          const filters = [a.stage ? `in ${a.stage}` : '', a.min_assets ? `with assets over ${money(a.min_assets)}` : ''].filter(Boolean).join(' ');
          return { text: `**${list.length} ${list.length === 1 ? 'prospect' : 'prospects'}**${filters ? ` ${filters}` : ''}. The funnel: ${funnel.map((f) => `${f.stage} ${f.count}`).join(', ')}.`, blocks: list.length ? [moduleTable(spec, 'Prospects', ctx.runId, 'prospect.list', [{ field: 'company', headerName: 'Company', type: 'text' }, { field: 'stage', headerName: 'Stage', type: 'text' }, { field: 'grade', headerName: 'Grade', type: 'text' }, { field: 'assets', headerName: 'Assets', type: 'currency' }, { field: 'disposition', headerName: 'Disposition', type: 'text' }, { field: 'owner', headerName: 'Owner', type: 'text' }, { field: 'next', headerName: 'Next follow-up', type: 'text' }], list.map((p) => ({ company: p.company, stage: p.stage, grade: p.grade, assets: p.assets, disposition: p.disposition, owner: p.owner, next: p.nextFollowUp ?? '—' })))] : [] };
        },
      },
      {
        name: 'prs_route',
        description: 'Open prospects within a number of miles of a branch, in visit order, with a directions link.',
        input: z.object({ near: z.string().max(40).describe('A branch name'), miles: z.number().min(1).max(60).default(10) }).strict(),
        run: async (a: { near: string; miles: number }, ctx) => {
          need(ctx);
          if (!a.near) throw new CoreError('INVALID', 'Which branch should the route start from?');
          const r = await prs.route(a.near, a.miles, ctx);
          if (!r.stops.length) return { text: `No open prospects are within ${a.miles} miles of ${r.start}.` };
          return { text: `**${r.stops.length} ${r.stops.length === 1 ? 'prospect is' : 'prospects are'}** within ${a.miles} miles of ${r.start}. In this order it’s about **${r.total} miles** between stops.${r.directions ? ` [Open directions](${r.directions})` : ''}`, blocks: [moduleTable(spec, `Route from ${r.start}`, ctx.runId, 'prospect.route', [{ field: 'stop', headerName: 'Stop', type: 'number' }, { field: 'company', headerName: 'Company', type: 'text' }, { field: 'away', headerName: 'Miles from branch', type: 'number' }, { field: 'leg', headerName: 'Miles from last', type: 'number' }, { field: 'stage', headerName: 'Stage', type: 'text' }, { field: 'contact', headerName: 'Contact', type: 'text' }], r.stops.map((s, i) => ({ stop: i + 1, company: s.company, away: s.away, leg: s.leg, stage: s.stage, contact: s.contact })))] };
        },
      },
      {
        name: 'prs_call_log',
        description: 'Prepare logging a call with a prospect, on its timeline. Returns approval_required.',
        input: z.object({ company: z.string().min(2).max(80), note: z.string().min(2).max(300), disposition: z.string().max(40).optional() }).strict(),
        run: async (a: { company: string; note: string; disposition?: string }, ctx) => {
          need(ctx);
          const p = await prs.find(a.company, ctx);
          const { dispositions } = await prs.config();
          const disposition = a.disposition ? dispositions.find((d) => d.toLowerCase() === a.disposition!.toLowerCase()) : dispositions.find((d) => new RegExp(`\\b${d}\\b`, 'i').test(a.note));
          return { change: { summary: `Log a call with ${p.company}`, changes: [{ label: 'Call', before: '—', after: a.note }, ...(disposition && disposition !== p.disposition ? [{ label: 'Disposition', before: p.disposition, after: disposition }] : [])], text: `I’ve prepared the call log for **${p.company}**.`, done: `Logged the call with **${p.company}**.`, risk: 'low', apply: { prospectId: p.prospectId, note: a.note, disposition: disposition ?? null } } };
        },
        apply: async (p: { prospectId: number; note: string; disposition: string | null }, meta, ctx) => prs.logCall(p.prospectId, p, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }),
      },
      {
        name: 'prs_stage',
        description: 'Prepare moving a prospect to another stage. The change goes on its timeline. Returns approval_required.',
        input: z.object({ company: z.string().min(2).max(80), stage: z.string().min(2).max(40) }).strict(),
        run: async (a: { company: string; stage: string }, ctx) => {
          need(ctx);
          const p = await prs.find(a.company, ctx);
          const stage = stages.find((s) => s.toLowerCase() === a.stage.toLowerCase());
          if (!stage) throw new CoreError('INVALID', `Which stage: ${stages.join(', ')}?`);
          if (stage === p.stage) throw new CoreError('INVALID', `${p.company} is already in ${stage}.`);
          return { change: { summary: `Move ${p.company} to ${stage}`, changes: [{ label: p.company, before: p.stage, after: stage }], text: `I’ve prepared moving **${p.company}** to ${stage}.`, done: `**${p.company}** is now in ${stage}.`, risk: 'medium', apply: { prospectId: p.prospectId, from: p.stage, to: stage } } };
        },
        apply: async (p: { prospectId: number; from: string; to: string }, meta, ctx) => prs.setStage(p.prospectId, p.from, p.to, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }),
      },
      {
        name: 'prs_conversion',
        description: 'Of the prospects that entered one stage this quarter, how many have since reached a later stage.',
        input: z.object({ from: z.string().min(2).max(40), to: z.string().min(2).max(40) }).strict(),
        run: async (a: { from: string; to: string }, ctx) => {
          need(ctx);
          const now = today();
          const q = Math.floor((Number(now.slice(5, 7)) - 1) / 3);
          const start = (k: number) => new Date(Date.UTC(Number(now.slice(0, 4)), k * 3, 1)).toISOString().slice(0, 10);
          let c = await prs.conversion(a.from, a.to, { start: start(q), end: now }, ctx);
          let when = 'this quarter';
          // Early in a quarter there may be nothing yet: the last full quarter answers the question.
          if (!c.entered) {
            c = await prs.conversion(a.from, a.to, { start: start(q - 1), end: new Date(Date.parse(`${start(q)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) }, ctx);
            when = 'last quarter, since none have this quarter yet';
          }
          if (!c.entered) return { text: `No prospects entered ${c.from} this quarter or last, so there’s no conversion to report yet.` };
          return { text: `**${c.pct}%**: of the ${c.entered} prospects that entered ${c.from} ${when}, ${c.reached} have reached ${c.to} or beyond.` };
        },
      },
    ],
  };
  return spec;
}
