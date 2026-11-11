// Predictive Models: the attrition model DI trains on its own data. Who it thinks will leave and why,
// how good it is on months it never saw, whether its High band really did leave, whether members have
// drifted from what it learned, and a new version trained on request. A new version goes to work
// only when someone other than the person who asked for it approves (model risk management: the
// developer doesn't validate their own model). The numbers come from the model; Claude explains them.
import { z } from 'zod';
import { ATTRITION_BANDS, CoreError, modelMonthLabel, type AttritionModelService, type ModelRecord } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const MODEL_REQUEST =
  /\b(?:attrition|churn|retention|leaving) model\b|\bpredictive models?\b|\bmodel(?:'s|’s)? (?:accuracy|drift|versions?|performance|validation|history)\b|\bhow (?:good|accurate|well) is the model\b|\bretrain\b|\b(?:promote|activate|approve|put)\b[^.?!]*\b(?:model|version)\b|\bdrift(?:ing|ed)?\b|\b(?:chance|probability) of leaving\b|\bmodel (?:say|says|thinks|predicts|flags?)\b/i;

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const n = (v: number) => Math.round(v).toLocaleString('en-US');
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });

/** The model's results in words a committee reads. */
export function modelSummary(m: ModelRecord) {
  const months = `${modelMonthLabel(m.trainFrom)} to ${modelMonthLabel(m.trainTo)}`;
  const checked = `${modelMonthLabel(m.validFrom)} to ${modelMonthLabel(m.validTo)}`;
  return `Attrition model **v${m.version}** (${m.algorithm.toLowerCase()}) learned from ${n(m.examples)} member-months, ${months}, and was checked on ${checked}, months it never saw: ${n(m.metrics.validationRows)} member-months, of whom ${n(m.metrics.validationLeavers)} left within the month. The 10% of members it scored highest held **${pct(m.metrics.captured10)} of those who left**, ${m.metrics.lift10.toFixed(1)} times the average; AUC ${m.metrics.auc.toFixed(2)}. On average it expected ${pct(m.metrics.predicted, 2)} a month to leave and ${pct(m.metrics.actual, 2)} did.`;
}

export function attritionModule(svc: AttritionModelService): ModuleSpec {
  const noAccess = 'Predictive Analytics isn’t part of your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('predictive')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const active = async () => {
    const m = await svc.active();
    if (!m) throw new CoreError('NOT_FOUND', 'No attrition model is in use yet. DI trains the first one when it starts; ask again in a minute.');
    return m;
  };
  const names = (ctx: ModuleContext) => ctx.modules.includes('records-members') || ctx.modules.includes('records-customers');

  const spec: ModuleSpec = {
    id: 'predictive',
    prefix: 'mdl',
    agent: 'Predictive Models',
    request: MODEL_REQUEST,
    noAccess,
    sources: [
      { kind: 'table', label: 'Model registry', ref: 'table:ml_model' },
      { kind: 'table', label: 'Member scores', ref: 'table:ml_score' },
      { kind: 'table', label: 'Member month-end snapshots', ref: 'table:hist_member_snapshot' },
    ],
    prompt: ({ tenant, user, title }) => `You are the Predictive Models agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) works with the attrition model DI trains on its own member history.

- "How good is the attrition model?": mdl_status. "Who does the model say will leave?": mdl_top. "Did the High band actually leave?": mdl_history. "Is the model drifting?": mdl_drift.
- "Retrain the attrition model": mdl_retrain. "Put version 2 to work", "promote the new model": mdl_promote; someone other than the requester approves it.
- The scores are the model's; explain them, never change them. Say "chance of leaving within 90 days", not certainty.`,
    plan: (t) => {
      const v = /\b(?:v|version )(\d+)\b/i.exec(t)?.[1];
      if (/\bretrain\b|\btrain (?:a )?new\b/i.test(t)) return { tool: 'mdl_retrain', args: {} };
      if (/\b(?:promote|activate|approve|put)\b[^.?!]*\b(?:model|version)\b/i.test(t)) return { tool: 'mdl_promote', args: v ? { version: Number(v) } : {} };
      if (/\bdrift/i.test(t)) return { tool: 'mdl_drift', args: {} };
      if (/\bhistory\b|\bactually\b|\bdid (?:they|the)\b|\bby month\b|\bover time\b|\bband\b/i.test(t)) return { tool: 'mdl_history', args: {} };
      if (/\bwho\b|\bwhich (?:members|customers)\b|\bmost likely\b|\blist\b|\bsay will leave\b|\bflag/i.test(t)) return { tool: 'mdl_top', args: {} };
      return { tool: 'mdl_status', args: {} };
    },
    tools: [
      {
        name: 'mdl_status',
        description: 'The attrition model in use: what it learned from, how it did on months it never saw, what drives it, how many members are in each band this month, and any candidate version waiting.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const m = await active();
          const all = await svc.models();
          const candidate = all.find((x) => x.status === 'Candidate');
          const hist = await svc.history(m.modelId, ctx.purviewBranches);
          const latest = hist.filter((h) => h.month === hist.at(-1)?.month);
          const high = latest.find((h) => h.band === 'High');
          return {
            text: `${modelSummary(m)} It’s been in use since ${m.activatedAt?.slice(0, 10) ?? '—'}${m.approvedBy ? `, approved by ${m.approvedBy}` : ''}. This month ${n(high?.members ?? 0)} ${high?.members === 1 ? 'member is' : 'members are'} in the High band (a ${pct(ATTRITION_BANDS.high)} or greater chance of leaving within 90 days).${candidate ? ` Version ${candidate.version} is a candidate, waiting for approval.` : ''}`,
            blocks: [
              moduleTable(spec, 'What drives the model', ctx.runId, 'model.importance', [text('feature', 'What it reads'), text('share', 'Share of what it learned')], m.importance.map((i) => ({ feature: i.label, share: pct(i.share) }))),
              moduleTable(spec, 'Model versions', ctx.runId, 'model.versions', [text('version', 'Version'), text('status', 'Status'), text('trained', 'Trained'), text('window', 'Learned from'), text('captured', 'Top 10% caught'), text('auc', 'AUC'), text('approved', 'Approved by')], all.map((x) => ({ version: `v${x.version}`, status: x.status, trained: `${x.trainedAt.slice(0, 10)} by ${x.trainedBy}`, window: `${modelMonthLabel(x.trainFrom)} to ${modelMonthLabel(x.trainTo)}`, captured: pct(x.metrics.captured10), auc: x.metrics.auc.toFixed(2), approved: x.approvedBy ?? '—' }))),
            ],
            suggestions: ['Who does the attrition model say will leave?', 'Did the High band actually leave?', 'Is the attrition model drifting?'],
          };
        },
      },
      {
        name: 'mdl_top',
        description: 'Members the attrition model scores most likely to leave within 90 days at the latest month-end, in purview, with the reasons from their own data and the rule score beside it.',
        input: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(),
        run: async (a: { limit?: number }, ctx) => {
          need(ctx);
          const m = await active();
          const top = await svc.top(m.modelId, { limit: a.limit ?? 15, purviewBranches: ctx.purviewBranches });
          const show = names(ctx);
          const who = (x: (typeof top.items)[number]) => (show ? x.name : `Member …${String(x.partyId).slice(-4).padStart(4, '0')}`);
          const first = top.items[0];
          return {
            text: first
              ? `At the ${modelMonthLabel(top.month)} month-end, the model gives **${who(first)}** (${first.branch}) the highest chance of leaving within 90 days, ${pct(first.p90)}: ${first.drivers.join('; ').toLowerCase() || 'a mix of small signs'}. These are chances, not certainties: of the members it put in the High band last month, most stayed.${show ? '' : ' Names are hidden: member details aren’t part of your access.'}`
              : 'No member is scored yet.',
            blocks: [moduleTable(spec, `Most likely to leave, ${modelMonthLabel(top.month)}`, ctx.runId, 'model.top', [text('member', show ? 'Member' : 'Member'), text('branch', 'Branch'), text('chance', 'Chance within 90 days'), text('reasons', 'Why'), text('rule', 'Rule score'), { field: 'deposits', headerName: 'Deposits', type: 'currency' }], top.items.map((x) => ({ member: who(x), branch: x.branch, chance: pct(x.p90), reasons: x.drivers.join('; ') || '—', rule: x.ruleScore === null ? '—' : `${x.ruleScore}/10`, deposits: x.deposits })))],
            suggestions: ['Did the High band actually leave?', 'How good is the attrition model?'],
          };
        },
      },
      {
        name: 'mdl_history',
        description: 'Members in each band at each of the last six month-ends, and how many of them left by the next month-end: the model checked against what happened.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const m = await active();
          const hist = await svc.history(m.modelId, ctx.purviewBranches);
          const months = [...new Set(hist.map((h) => h.month))];
          const done = months.slice(0, -1);
          const rate = (band: string) => {
            const r = hist.filter((h) => h.band === band && done.includes(h.month));
            const members = r.reduce((s, h) => s + h.members, 0);
            return { members, left: r.reduce((s, h) => s + h.leftNext, 0), rate: members ? r.reduce((s, h) => s + h.leftNext, 0) / members : 0 };
          };
          const hi = rate('High');
          const lo = rate('Low');
          return {
            text: `Over ${done.length} months, **${pct(hi.rate, 1)}** of members in the High band left by the next month-end, against ${pct(lo.rate, 2)} in the Low band: ${lo.rate ? `${(hi.rate / lo.rate).toFixed(0)} times as many` : 'far more'}. ${n(hi.left)} of the ${n(hi.members)} High-band member-months left; the rest stayed, which is why DI calls it a chance and suggests a call, not a write-off. The latest month, ${modelMonthLabel(months.at(-1) ?? '')}, has no outcome yet.`,
            blocks: [moduleTable(spec, 'Bands and what happened next', ctx.runId, 'model.history', [text('month', 'Month-end'), text('band', 'Band'), { field: 'members', headerName: 'Members', type: 'count' }, text('expected', 'Expected to leave in 90 days'), text('left', 'Left by next month-end')], hist.map((h) => ({ month: modelMonthLabel(h.month), band: h.band, members: h.members, expected: pct(h.avg90, 1), left: h.month === months.at(-1) ? 'Not yet known' : `${n(h.leftNext)} (${pct(h.members ? h.leftNext / h.members : 0, 1)})` })))],
            suggestions: ['Is the attrition model drifting?'],
          };
        },
      },
      {
        name: 'mdl_drift',
        description: 'How far this month’s members have moved from the members the model learned from, feature by feature (population stability index), and the scores themselves.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const m = await active();
          const d = await svc.driftReport(m.modelId);
          const moved = d.items.filter((i) => i.state !== 'Stable');
          return {
            text: moved.length
              ? `In ${d.month ? modelMonthLabel(d.month) : 'the latest month'}, ${moved.map((i) => `**${i.label.toLowerCase()}** (${i.state.toLowerCase()}, PSI ${i.psi.toFixed(2)})`).join(', ')} ${moved.length === 1 ? 'has' : 'have'} moved from what the model learned. Under 0.10 is stable, 0.10 to 0.25 worth watching, over 0.25 a reason to retrain.${moved.some((i) => i.state === 'Shifted') ? ' Retraining is worth it.' : ''}`
              : `In ${d.month ? modelMonthLabel(d.month) : 'the latest month'}, members look like those the model learned from: every feature’s PSI is under 0.10. No retraining is needed for drift.`,
            blocks: [moduleTable(spec, 'Drift from training', ctx.runId, 'model.drift', [text('feature', 'What it reads'), text('psi', 'PSI'), text('state', 'State')], d.items.map((i) => ({ feature: i.label, psi: i.psi.toFixed(3), state: i.state })))],
            suggestions: moved.some((i) => i.state === 'Shifted') ? ['Retrain the attrition model'] : [],
          };
        },
      },
      {
        name: 'mdl_retrain',
        description: 'Prepare training a new version of the attrition model on the latest member history, as a candidate checked on the last three months. It isn’t used until approved. Returns approval_required.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const m = await svc.active();
          const months = await svc.months();
          const next = Math.max(0, ...(await svc.models()).map((x) => x.version)) + 1;
          return {
            change: {
              summary: `Train attrition model v${next} as a candidate`,
              changes: [
                { label: 'Learns from', before: m ? `${modelMonthLabel(m.trainFrom)} to ${modelMonthLabel(m.trainTo)}` : '—', after: `${modelMonthLabel(months[0]!)} to ${modelMonthLabel(months.at(-5)!)}` },
                { label: 'Checked on', before: m ? `${modelMonthLabel(m.validFrom)} to ${modelMonthLabel(m.validTo)}` : '—', after: `${modelMonthLabel(months.at(-4)!)} to ${modelMonthLabel(months.at(-2)!)}` },
                { label: 'Used for scores', before: m ? `v${m.version}` : '—', after: m ? `Still v${m.version} until v${next} is approved` : `v${next} once approved` },
              ],
              text: `I’ll train attrition model **v${next}** on the latest member history and check it on the three most recent months with outcomes. It becomes a candidate: scores don’t change until someone other than you approves putting it to work.`,
              done: `Trained attrition model v${next} as a candidate.`,
              risk: 'low',
              apply: { by: ctx.user.name },
            },
          };
        },
        apply: async (p: { by: string }) => {
          const c = await svc.trainAttrition(p.by);
          const m = await svc.active();
          const better = m ? c.metrics.captured10 - m.metrics.captured10 : 0;
          return {
            text: `${modelSummary(c)}${m ? ` Against v${m.version} in use, it catches ${pct(Math.abs(better), 1)} ${better >= 0 ? 'more' : 'fewer'} of those who left in its top 10%.` : ''} It’s a candidate: ask to put v${c.version} to work, and someone other than you approves it.`,
            suggestions: [`Put attrition model version ${c.version} to work`],
          };
        },
      },
      {
        name: 'mdl_promote',
        description: 'Prepare putting a candidate version of the attrition model to work: it replaces the one in use and rescores every member. Needs someone other than the requester to approve. Returns approval_required.',
        input: z.object({ version: z.number().int().positive().optional() }).strict(),
        run: async (a: { version?: number }, ctx) => {
          need(ctx);
          const all = await svc.models();
          const c = a.version ? all.find((x) => x.version === a.version) : all.find((x) => x.status === 'Candidate');
          if (!c) throw new CoreError('NOT_FOUND', a.version ? `There’s no attrition model v${a.version}.` : 'There’s no candidate version waiting. Ask me to retrain the attrition model first.');
          if (c.status === 'Active') throw new CoreError('INVALID', `v${c.version} is already the model in use.`);
          const m = all.find((x) => x.status === 'Active');
          return {
            change: {
              summary: `Put attrition model v${c.version} to work${m ? ` in place of v${m.version}` : ''}`,
              changes: [
                { label: 'Model in use', before: m ? `v${m.version}` : '—', after: `v${c.version}` },
                { label: 'Top 10% caught', before: m ? pct(m.metrics.captured10) : '—', after: pct(c.metrics.captured10) },
                { label: 'AUC', before: m ? m.metrics.auc.toFixed(2) : '—', after: c.metrics.auc.toFixed(2) },
                { label: 'Expected vs actual leavers a month', before: m ? `${pct(m.metrics.predicted, 2)} vs ${pct(m.metrics.actual, 2)}` : '—', after: `${pct(c.metrics.predicted, 2)} vs ${pct(c.metrics.actual, 2)}` },
                { label: 'Trained by', before: '—', after: c.trainedBy },
              ],
              text: `I’ll put attrition model **v${c.version}** to work${m ? ` in place of v${m.version}` : ''} and rescore every member for the last six month-ends. Model risk policy: someone other than the person asking approves a model before it’s used.`,
              done: `Attrition model v${c.version} is in use.`,
              risk: 'medium',
              secondApprover: { role: 'Someone other than the requester, such as the chief risk officer or the CEO', policy: 'Model risk management: a model is approved by someone other than the person who asked for it before it is used.' },
              apply: { modelId: c.modelId, version: c.version },
            },
          };
        },
        apply: async (p: { modelId: number; version: number }, meta, ctx) => {
          const r = await svc.activate(p.modelId, ctx.user.name, meta.approvalId);
          return { text: `Attrition model **v${p.version}** is in use, approved by ${ctx.user.name}. Every member is rescored for ${r.months.length} month-ends (${n(r.scored)} scores).`, suggestions: ['Who does the attrition model say will leave?'] };
        },
      },
    ],
  };
  return spec;
}

