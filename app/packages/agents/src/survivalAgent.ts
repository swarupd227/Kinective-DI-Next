// Lifetime and Survival: how long members stay and what makes them stay longer. Retention curves from
// what members of every tenure actually did, a Cox model's hazard ratios (each thing about a member
// that raises or lowers the rate of leaving), and the deposits at risk over the next year. A new version
// goes to work only when someone other than the person who asked for it approves, as with the other
// models. The numbers come from the models; Claude explains them.
import { z } from 'zod';
import { CoreError, modelMonthLabel, type SurvivalModelService, type SurvivalRecord } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const SURVIVAL_REQUEST =
  /\bsurvival (?:model|curves?|analysis)\b|\bretention curves?\b|\bkaplan[- ]meier\b|\bcox (?:model|regression)\b|\bhazard ratios?\b|\bhow long (?:do|will|does|would) (?:our |the |new |a )?(?:members?|customers?|people|relationships?) (?:stay|last)\b|\b(?:median|average|expected) (?:tenure|lifetime|membership length|relationship length)\b|\bstill (?:here|members|customers|with us) (?:after|in)\b|\bdeposits?(?: are| is)? at risk (?:over|in|across) (?:the next|a) (?:year|12 months)\b|\bdeposits?(?: are| is)? at risk (?:from|if) (?:members|customers) (?:leave|leaving)\b|\b(?:what|which things?) (?:makes?|keeps?) (?:members|customers) (?:stay|longer)\b|\bstay longer\b|\b(?:member|customer) lifetimes?\b|\blifetime (?:model|curve)\b|\bretrain\b[^.?!]*\bsurvival\b|\b(?:promote|activate|approve|put)\b[^.?!]*\bsurvival model\b/i;

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const n = (v: number) => Math.round(v).toLocaleString('en-US');
const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);
const years = (months: number | null) => (months === null ? 'more than 25 years' : months < 24 ? `${months} months` : `${(months / 12).toFixed(1)} years`);
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });

export function survivalModule(svc: SurvivalModelService): ModuleSpec {
  const noAccess = 'Predictive Analytics isn’t part of your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('predictive')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const active = async () => {
    const m = await svc.active();
    if (!m) throw new CoreError('NOT_FOUND', 'No survival model is in use yet. DI fits the first one when it starts; ask again in a few minutes.');
    return m;
  };
  const names = (ctx: ModuleContext) => ctx.modules.includes('records-members') || ctx.modules.includes('records-customers');
  const people = svc.people;
  const one = people.slice(0, -1);
  const ratioWords = (m: SurvivalRecord) => {
    const sig = m.metrics.ratios.filter((r) => r.p < 0.05);
    const up = [...sig].filter((r) => r.hr > 1).sort((a, b) => b.hr - a.hr).slice(0, 3);
    const down = [...sig].filter((r) => r.hr < 1).sort((a, b) => a.hr - b.hr).slice(0, 3);
    return { up, down };
  };

  const spec: ModuleSpec = {
    id: 'predictive',
    prefix: 'sv',
    agent: 'Lifetime and Survival',
    request: SURVIVAL_REQUEST,
    noAccess,
    sources: [
      { kind: 'table', label: 'Model registry', ref: 'table:ml_model' },
      { kind: 'table', label: 'Membership closures', ref: 'table:cdm_membership_exit' },
      { kind: 'table', label: 'Month-end snapshots', ref: 'table:hist_member_snapshot' },
    ],
    prompt: ({ tenant, user, title }) => `You are the Lifetime and Survival agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) asks how long ${people} stay and what makes them stay longer.

- "How long do ${people} stay?", "what share of new ${people} are still here after 5 years?": sv_curves; by age band or branch: by "age" or "branch".
- "What makes ${people} stay longer?", "hazard ratios": sv_drivers.
- "What deposits are at risk over the next year?": sv_at_risk.
- "How good is the survival model?": sv_status. "Retrain the survival model": sv_retrain. "Put survival model version 2 to work": sv_promote; someone other than the requester approves it.
- Say what the figures are: curves from what ${people} actually did over the months DI holds closures for, and a model checked on months it never saw. Remaining-life figures assume a ${one} stays as they are now.`,
    plan: (t) => {
      const v = /\b(?:v|version )(\d+)\b/i.exec(t)?.[1];
      if (/\bretrain\b/i.test(t)) return { tool: 'sv_retrain', args: {} };
      if (/\b(?:promote|activate|approve|put)\b[^.?!]*\b(?:model|version)\b/i.test(t)) return { tool: 'sv_promote', args: v ? { version: Number(v) } : {} };
      if (/\bat risk\b/i.test(t)) return { tool: 'sv_at_risk', args: {} };
      if (/\bhazard\b|\bwhat (?:makes|keeps)\b|\bstay longer\b|\bdrivers?\b|\bwhy\b/i.test(t)) return { tool: 'sv_drivers', args: {} };
      if (/\bhow good\b|\baccura|\bvalidat|\bversions?\b/i.test(t)) return { tool: 'sv_status', args: {} };
      return { tool: 'sv_curves', args: { by: /\bage\b|\bolder\b|\byounger\b/i.test(t) ? 'age' : /\bbranch/i.test(t) ? 'branch' : 'all' } };
    },
    tools: [
      {
        name: 'sv_curves',
        description: 'Retention curves (Kaplan–Meier, period method): of those who join, the share still here after 1, 3, 5, 10 and 15 years and the median tenure, from what members of every tenure actually did over the months DI holds closures for. by: all, age (band at the start of the window) or branch.',
        input: z.object({ by: z.enum(['all', 'age', 'branch']).optional() }).strict(),
        run: async (a: { by?: 'all' | 'age' | 'branch' }, ctx) => {
          need(ctx);
          const c = await svc.curves(a.by ?? 'all', ctx.purviewBranches);
          const all = a.by && a.by !== 'all' ? (await svc.curves('all', ctx.purviewBranches)).groups[0]! : c.groups[0]!;
          const spread = c.groups.length > 1 ? [...c.groups].sort((x, y) => (y.at[60] ?? 0) - (x.at[60] ?? 0)) : [];
          return {
            text: `Of ${people} who join, **${pct(all.at[12]!)} are still here after a year, ${pct(all.at[60]!)} after five and ${pct(all.at[120]!)} after ten**; half have left by ${years(all.median)}. That’s from what ${people} of every tenure actually did from ${modelMonthLabel(c.window.from)} to ${modelMonthLabel(c.window.to)} (${n(all.exits)} closures), the way an actuary’s period table reads.${spread.length > 1 ? ` By ${a.by === 'age' ? 'age' : 'branch'}, five-year retention runs from ${pct(spread.at(-1)!.at[60]!)} (${spread.at(-1)!.group}) to ${pct(spread[0]!.at[60]!)} (${spread[0]!.group}).` : ''} The first year is where most are lost.`,
            blocks: [
              moduleTable(spec, `Still here after joining${a.by && a.by !== 'all' ? `, by ${a.by === 'age' ? 'age band' : 'branch'}` : ''}`, ctx.runId, 'sv.curves', [text('group', a.by === 'age' ? 'Age band' : a.by === 'branch' ? 'Branch' : 'Who'), ...c.milestones.map((m) => text(`m${m}`, m < 24 ? `${m} months` : `${m / 12} years`)), text('median', 'Half have left by'), { field: 'exits', headerName: 'Closures seen', type: 'count' }], c.groups.map((g) => ({ group: g.group === 'All' ? `All ${people}` : g.group, ...Object.fromEntries(c.milestones.map((m) => [`m${m}`, pct(g.at[m]!)])), median: years(g.median), exits: g.exits }))),
            ],
            suggestions: [`What makes ${people} stay longer?`, 'What deposits are at risk over the next year?', a.by === 'age' ? `How long do ${people} stay, by branch?` : `How long do ${people} stay, by age?`],
          };
        },
      },
      {
        name: 'sv_drivers',
        description: 'The Cox model’s hazard ratios: how much each thing about a member raises (above 1) or lowers (below 1) the rate of leaving at any tenure, with 95% intervals, checked on months it never saw.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const m = await active();
          const { up, down } = ratioWords(m);
          const w = (r: SurvivalRecord['metrics']['ratios'][number]) => `${r.label.toLowerCase()} (${r.hr.toFixed(2)}×)`;
          return {
            text: `What changes how fast ${people} leave, at any tenure: ${down.length ? `**${down.map(w).join(', ')}** lower the rate` : 'nothing clearly lowers it'}; ${up.length ? `**${up.map(w).join(', ')}** raise it` : 'nothing clearly raises it'}. Each is a hazard ratio from a Cox model with tenure as its clock: 0.5× halves the rate of leaving, 2× doubles it, holding everything else the same. It ranks who leaves next with an AUC of ${m.metrics.auc.toFixed(2)} on ${modelMonthLabel(m.validFrom)} to ${modelMonthLabel(m.validTo)}, months it never saw. These are associations in DI’s data, not proof that changing one would change the other.`,
            blocks: [moduleTable(spec, 'Hazard ratios', ctx.runId, 'sv.ratios', [text('feature', 'What it reads'), text('hr', 'Hazard ratio'), text('ci', '95% interval'), text('effect', 'Effect')], [...m.metrics.ratios].sort((a, b) => Math.abs(Math.log(b.hr)) - Math.abs(Math.log(a.hr))).map((r) => ({ feature: r.label, hr: `${r.hr.toFixed(2)}×`, ci: `${r.lo.toFixed(2)} to ${r.hi.toFixed(2)}`, effect: r.p >= 0.05 ? 'Not clear' : r.hr < 1 ? `Leave ${pct(1 - r.hr)} less often` : `Leave ${pct(r.hr - 1)} more often` })))],
            suggestions: ['What deposits are at risk over the next year?', `How long do ${people} stay?`],
          };
        },
      },
      {
        name: 'sv_at_risk',
        description: 'Deposits at risk over the next 12 months: each member’s chance of leaving within a year from the survival model, times their deposits, by branch and the members with the most at stake, in purview.',
        input: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(),
        run: async (a: { limit?: number }, ctx) => {
          need(ctx);
          await active();
          const r = (await svc.atRisk({ limit: a.limit ?? 15, purviewBranches: ctx.purviewBranches }))!;
          const total = r.branches.reduce((s, b) => s + b.atRisk, 0);
          const deposits = r.branches.reduce((s, b) => s + b.deposits, 0);
          const leavers = r.branches.reduce((s, b) => s + b.leave, 0);
          const members = r.branches.reduce((s, b) => s + b.members, 0);
          const show = names(ctx);
          const who = (x: (typeof r.items)[number]) => (show ? x.name : `…${String(x.partyId).slice(-4).padStart(4, '0')}`);
          const first = r.items[0];
          return {
            text: `Over the next 12 months the survival model expects about **${n(leavers)} of ${n(members)} ${people}** to leave (${pct(leavers / Math.max(1, members), 1)}), taking about **${money(total)}** of ${money(deposits)} in deposits if they leave with their balances. ${r.branches[0] ? `${r.branches[0].branch} has the most at risk, ${money(r.branches[0].atRisk)}.` : ''}${first ? ` The most at stake is ${who(first)} (${first.branch}): ${money(first.deposits)} on deposit, a ${pct(first.leave)} chance of leaving within a year.` : ''} These assume each ${one} stays as they are now.${show ? '' : ' Names are hidden: member details aren’t part of your access.'}`,
            blocks: [
              moduleTable(spec, 'Deposits at risk over 12 months, by branch', ctx.runId, 'sv.branches', [text('branch', 'Branch'), { field: 'members', headerName: people[0]!.toUpperCase() + people.slice(1), type: 'count' }, text('leave', 'Expected to leave'), { field: 'deposits', headerName: 'Deposits', type: 'currency' }, { field: 'atRisk', headerName: 'At risk', type: 'currency' }], r.branches.map((b) => ({ branch: b.branch, members: b.members, leave: `${n(b.leave)} (${pct(b.leave / Math.max(1, b.members), 1)})`, deposits: Math.round(b.deposits), atRisk: Math.round(b.atRisk) }))),
              moduleTable(spec, 'Most at stake', ctx.runId, 'sv.top', [text('who', show ? 'Name' : one[0]!.toUpperCase() + one.slice(1)), text('branch', 'Branch'), text('tenure', 'With us'), text('leave', 'Chance of leaving in a year'), text('median', 'Half like them stay'), { field: 'deposits', headerName: 'Deposits', type: 'currency' }, { field: 'atRisk', headerName: 'At risk', type: 'currency' }], r.items.map((x) => ({ who: who(x), branch: x.branch, tenure: years(x.tenure), leave: pct(x.leave), median: `another ${years(x.median)}`, deposits: Math.round(x.deposits), atRisk: Math.round(x.atRisk) }))),
            ],
            suggestions: [`What makes ${people} stay longer?`, 'Who does the attrition model say will leave?'],
          };
        },
      },
      {
        name: 'sv_status',
        description: 'The survival model in use: what it learned from, how it did on months it never saw (AUC, expected against actual leavers), and its versions.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const m = await active();
          const all = await svc.models();
          return {
            text: `Survival model **v${m.version}** (Cox proportional hazards, tenure as its clock) learned from ${n(m.examples)} ${one}-months, ${modelMonthLabel(m.trainFrom)} to ${modelMonthLabel(m.trainTo)}, and was checked on ${modelMonthLabel(m.validFrom)} to ${modelMonthLabel(m.validTo)}, months it never saw: AUC ${m.metrics.auc.toFixed(2)}; it expected ${pct(m.metrics.predicted, 2)} a month to leave and ${pct(m.metrics.actual, 2)} did. In use since ${m.activatedAt?.slice(0, 10) ?? '—'}${m.approvedBy ? `, approved by ${m.approvedBy}` : ''}.`,
            blocks: [moduleTable(spec, 'Survival model versions', ctx.runId, 'sv.versions', [text('version', 'Version'), text('status', 'Status'), text('trained', 'Trained'), text('auc', 'AUC'), text('cal', 'Expected vs actual a month'), text('approved', 'Approved by')], all.map((x) => ({ version: `v${x.version}`, status: x.status, trained: `${x.trainedAt.slice(0, 10)} by ${x.trainedBy}`, auc: x.metrics.auc.toFixed(2), cal: `${pct(x.metrics.predicted, 2)} vs ${pct(x.metrics.actual, 2)}`, approved: x.approvedBy ?? '—' })))],
            suggestions: [`What makes ${people} stay longer?`, 'Retrain the survival model'],
          };
        },
      },
      {
        name: 'sv_retrain',
        description: 'Prepare fitting a new version of the survival model on the latest history, as a candidate checked on the last three months. It isn’t used until approved. Returns approval_required.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const m = await svc.active();
          const months = await svc.months();
          const next = Math.max(0, ...(await svc.models()).map((x) => x.version)) + 1;
          return {
            change: {
              summary: `Fit survival model v${next} as a candidate`,
              changes: [
                { label: 'Learns from', before: m ? `${modelMonthLabel(m.trainFrom)} to ${modelMonthLabel(m.trainTo)}` : '—', after: `${modelMonthLabel(months[0]!)} to ${modelMonthLabel(months.at(-5)!)}` },
                { label: 'Checked on', before: m ? `${modelMonthLabel(m.validFrom)} to ${modelMonthLabel(m.validTo)}` : '—', after: `${modelMonthLabel(months.at(-4)!)} to ${modelMonthLabel(months.at(-2)!)}` },
                { label: 'Used for scores', before: m ? `v${m.version}` : '—', after: m ? `Still v${m.version} until v${next} is approved` : `v${next} once approved` },
              ],
              text: `I’ll fit survival model **v${next}** on the latest ${one} history and check it on the three most recent months with outcomes. It becomes a candidate: nothing changes until someone other than you approves putting it to work.`,
              done: `Fitted survival model v${next} as a candidate.`,
              risk: 'low',
              apply: { by: ctx.user.name },
            },
          };
        },
        apply: async (p: { by: string }) => {
          const c = await svc.train(p.by);
          return { text: `Survival model **v${c.version}** is fitted: AUC ${c.metrics.auc.toFixed(2)} on months it never saw, expecting ${pct(c.metrics.predicted, 2)} a month to leave against ${pct(c.metrics.actual, 2)} who did. It’s a candidate: ask to put v${c.version} to work, and someone other than you approves it.`, suggestions: [`Put survival model version ${c.version} to work`] };
        },
      },
      {
        name: 'sv_promote',
        description: 'Prepare putting a candidate version of the survival model to work: it replaces the one in use and rescores every member. Needs someone other than the requester to approve. Returns approval_required.',
        input: z.object({ version: z.number().int().positive().optional() }).strict(),
        run: async (a: { version?: number }, ctx) => {
          need(ctx);
          const all = await svc.models();
          const c = a.version ? all.find((x) => x.version === a.version) : all.find((x) => x.status === 'Candidate');
          if (!c) throw new CoreError('NOT_FOUND', a.version ? `There’s no survival model v${a.version}.` : 'There’s no candidate version waiting. Ask me to retrain the survival model first.');
          if (c.status === 'Active') throw new CoreError('INVALID', `v${c.version} is already the model in use.`);
          const m = all.find((x) => x.status === 'Active');
          return {
            change: {
              summary: `Put survival model v${c.version} to work${m ? ` in place of v${m.version}` : ''}`,
              changes: [
                { label: 'Model in use', before: m ? `v${m.version}` : '—', after: `v${c.version}` },
                { label: 'AUC', before: m ? m.metrics.auc.toFixed(2) : '—', after: c.metrics.auc.toFixed(2) },
                { label: 'Expected vs actual leavers a month', before: m ? `${pct(m.metrics.predicted, 2)} vs ${pct(m.metrics.actual, 2)}` : '—', after: `${pct(c.metrics.predicted, 2)} vs ${pct(c.metrics.actual, 2)}` },
                { label: 'Fitted by', before: '—', after: c.trainedBy },
              ],
              text: `I’ll put survival model **v${c.version}** to work${m ? ` in place of v${m.version}` : ''} and rescore every ${one}. Model risk policy: someone other than the person asking approves a model before it’s used.`,
              done: `Survival model v${c.version} is in use.`,
              risk: 'medium',
              secondApprover: { role: 'Someone other than the requester, such as the chief risk officer or the CEO', policy: 'Model risk management' },
              apply: { modelId: c.modelId, version: c.version },
            },
          };
        },
        apply: async (p: { modelId: number; version: number }, meta, ctx) => {
          const r = await svc.activate(p.modelId, ctx.user.name, meta.approvalId);
          return { text: `Survival model **v${p.version}** is in use, approved by ${ctx.user.name}: ${n(r.scored)} ${people} scored at the ${modelMonthLabel(r.month)} month-end.`, suggestions: ['What deposits are at risk over the next year?'] };
        },
      },
    ],
  };
  return spec;
}
