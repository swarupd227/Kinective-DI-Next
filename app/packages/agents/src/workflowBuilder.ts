// Workflow Builder agent (spec 24.7, 8.16). Drafts are low risk; publishing is high, because it
// changes live routing and forms for everyone, and it's refused while validation finds a problem.
// The definition, its checks and its test route come from DI Core.
import { z } from 'zod';
import { CoreError, splitFields, type Definition, type WorkflowDefService } from '@dinext/di-core';
import type { WfSpec } from '@dinext/tenant-db';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const title = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ').replace(/s$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const list = (s: string) => s.split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
const stages = (s: WfSpec) => s.stages.join(' → ');
const route = (s: WfSpec) => `${s.route.queue}${s.route.byLocation ? ' by location' : ''}${s.route.escalateDays ? `, escalating after ${s.route.escalateDays} business days` : ''}${s.route.fallback ? `, fallback ${s.route.fallback}` : ', no fallback'}`;

export function workflowBuilderModule(wf: WorkflowDefService, today: () => string): ModuleSpec {
  const noAccess = 'The Workflow Builder needs COM Center admin rights.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('workflow-builder')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const fieldRows = (s: WfSpec) => [...s.persistent.map((f) => ({ field: f.label, type: f.type, kept: 'Persistent' })), ...s.nonPersistent.map((f) => ({ field: f.label, type: f.type, kept: 'Non-persistent' }))];
  const spec: ModuleSpec = {
    id: 'workflow-builder',
    prefix: 'wfb',
    agent: 'Workflow Builder',
    request: /\bworkflow (definitions?|builder)\b|\bcreate a workflow\b|\bstage between\b|\badd (a |an )?["']?[^"']+?["']? (field|stage) (to|for|between)\b|\bremove the ["']?[^"']+?["']? field\b|\bpublish (the )?.+? (workflow|draft)\b|\bfallback to [A-Z]|\bwhich workflows\b|\b(test|simulate) (the )?rout/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Workflow definitions', ref: 'table:wf_definition' }],
    prompt: ({ tenant, user, title: role }) => `You are the Workflow Builder agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${role}) sets up workflows (COMs).

- "Which workflows do we have?", "Show the workflow definitions": wfb_list. One workflow in detail, with its checks and a test route: wfb_get.
- "Create a workflow for branch maintenance requests with category, location, urgency and photo, routed to Facilities by location": wfb_draft_new.
- "Add a 'Waiting on member' stage between Active and Sold for referrals", "Add a 'Best time to call' field to the task workflow", "Fallback to Sam Taylor": wfb_change. Changes always go to a draft.
- "Publish the branch maintenance request workflow": wfb_publish. It refuses while validation finds problems; say what they are and how to fix them.`,
    plan: (text) => {
      const t = clean(text);
      const create = /\bcreate a workflow for (.+?) with (.+?),? routed to ([A-Z][\w &]*?)(?: (by (?:location|branch)))?$/i.exec(t);
      if (create) return { tool: 'wfb_draft_new', args: { name: title(create[1]!), fields: list(create[2]!), queue: create[3]!.trim(), by_location: Boolean(create[4]) } };
      if (/\bcreate a workflow\b/i.test(t)) return { say: 'What should it be called, which fields does it need, and where should items go? For example: “Create a workflow for branch maintenance requests with category, location and urgency, routed to Facilities by location.”' };
      const stage = /\badd (?:a |an )?"?'?(.+?)"?'? stage between (.+?) and (.+?) (?:for|in|on) (?:the )?(.+)$/i.exec(t);
      if (stage) return { tool: 'wfb_change', args: { workflow: stage[4]!, add_stage: stage[1]!, after_stage: stage[2]! } };
      const field = /\badd (?:a |an )?"?'?(.+?)"?'? field to (?:the )?(.+)$/i.exec(t);
      if (field) return { tool: 'wfb_change', args: { workflow: field[2]!, add_field: field[1]! } };
      const remove = /\bremove the "?'?(.+?)"?'? field from (?:the )?(.+)$/i.exec(t);
      if (remove) return { tool: 'wfb_change', args: { workflow: remove[2]!, remove_field: remove[1]! } };
      const fallback = /\b[Ff]allback to ([A-Z][a-z]+ [A-Z][a-z]+)(?: (?:for|on) (?:the )?(.+))?/.exec(t);
      if (fallback) return { tool: 'wfb_change', args: { ...(fallback[2] ? { workflow: fallback[2] } : {}), fallback: fallback[1]! } };
      const publish = /\bpublish (?:the )?(.+?)(?: workflow| draft)?$/i.exec(t);
      if (publish) return { tool: 'wfb_publish', args: { workflow: publish[1]! } };
      const one = /\b(?:test|simulate) (?:the )?rout\w* (?:for|of) (?:the )?(.+)$/i.exec(t);
      if (one) return { tool: 'wfb_get', args: { workflow: one[1]! } };
      return { tool: 'wfb_list', args: {} };
    },
    tools: [
      {
        name: 'wfb_list',
        description: 'Every workflow definition: folder, fields, stages, status, version and open items.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          need(ctx);
          const defs = await wf.list();
          const drafts = defs.filter((d) => d.status === 'Draft');
          return { text: `**${defs.filter((d) => d.status === 'Active').length} live workflows**${drafts.length ? ` and ${drafts.length} ${drafts.length === 1 ? 'draft' : 'drafts'} (${drafts.map((d) => d.name).join(', ')})` : ''}.`, blocks: [moduleTable(spec, 'Workflow definitions', ctx.runId, 'workflow.definition.list', [{ field: 'id', headerName: 'ID', type: 'number' }, { field: 'name', headerName: 'Name', type: 'text' }, { field: 'folder', headerName: 'Folder', type: 'text' }, { field: 'persistent', headerName: 'Persistent fields', type: 'text' }, { field: 'nonPersistent', headerName: 'Non-persistent fields', type: 'text' }, { field: 'stages', headerName: 'Stages', type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }, { field: 'open', headerName: 'Open items', type: 'count' }], defs.filter((d) => d.status === 'Active' || d.status === 'Draft').map((d) => ({ id: d.defId, name: d.name, folder: d.folder, persistent: d.spec.persistent.map((f) => f.label).join(', '), nonPersistent: d.spec.nonPersistent.map((f) => f.label).join(', ') || '—', stages: stages(d.spec), status: d.status === 'Draft' ? 'Draft' : `Live, v${d.version}`, open: d.openItems })))] };
        },
      },
      {
        name: 'wfb_get',
        description: 'One workflow in detail: fields, stages, routing, its validation and a test route for a sample item per rule.',
        input: z.object({ workflow: z.string().min(2).max(80) }).strict(),
        run: async (a: { workflow: string }, ctx) => {
          need(ctx);
          const d = await wf.find(a.workflow);
          const [problems, sim] = await Promise.all([wf.validate(d), wf.simulate(d.spec)]);
          return { text: `**${d.name}** (${d.status === 'Draft' ? 'draft' : `live, version ${d.version}`}). Stages: ${stages(d.spec)}. Routing: ${route(d.spec)}.\n\nTest route:\n${sim.map((s) => `- ${s.sample}: ${s.route}`).join('\n')}${problems.length ? `\n\n**${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} to fix before publishing:**\n${problems.map((p) => `- ${p.problem} ${p.fix}`).join('\n')}` : '\n\nIt passes validation.'}`, blocks: [moduleTable(spec, `${d.name} fields`, ctx.runId, 'workflow.definition.get', [{ field: 'field', headerName: 'Field', type: 'text' }, { field: 'type', headerName: 'Type', type: 'text' }, { field: 'kept', headerName: 'Kept', type: 'text' }], fieldRows(d.spec))], suggestions: d.status === 'Draft' && !problems.length ? [`Publish the ${d.name} workflow`] : [] };
        },
      },
      {
        name: 'wfb_draft_new',
        description: 'Prepare a draft of a new workflow from a description: name, fields, the queue it routes to, and whether by location. Attachments become non-persistent fields. Returns approval_required.',
        input: z.object({ name: z.string().min(3).max(80), fields: z.array(z.string().min(2).max(60)).min(1).max(20), queue: z.string().min(2).max(60), by_location: z.boolean().default(false), stages: z.array(z.string().min(2).max(40)).max(10).optional(), folder: z.string().max(60).optional() }).strict(),
        run: async (a: { name: string; fields: string[]; queue: string; by_location: boolean; stages?: string[]; folder?: string }, ctx) => {
          need(ctx);
          const split = splitFields(a.fields);
          const draft: WfSpec = { ...split, stages: a.stages?.length ? a.stages : ['New', 'In progress', 'Done'], route: { queue: a.queue, byLocation: a.by_location, escalateDays: null, fallback: null }, notify: 'Assignee' };
          const problems = await wf.validate({ name: a.name, spec: draft, baseId: null });
          return { change: { summary: `Save a draft workflow: ${a.name}`, changes: [...fieldRows(draft).map((f) => ({ label: `${f.kept} field`, before: '—', after: `${f.field} (${f.type})` })), { label: 'Stages', before: '—', after: stages(draft) }, { label: 'Routing', before: '—', after: route(draft) }].slice(0, 8), text: `I’ve drafted **${a.name}**. Nothing is live until it’s published.${problems.length ? ` Before it can be published: ${problems.map((p) => `${p.problem} ${p.fix}`).join(' ')}` : ''}`, done: `Saved the draft **${a.name}**.${problems.length ? ` ${problems[0]!.fix}` : ` It passes validation; say “Publish the ${a.name} workflow” when you’re ready.`}`, risk: 'low', apply: { mode: 'new', name: a.name, folder: a.folder ?? 'General', spec: draft } } };
        },
        apply: async (p: { name: string; folder: string; spec: WfSpec }, meta, ctx) => wf.saveDraft({ name: p.name, folder: p.folder, baseId: null, spec: p.spec }, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }),
      },
      {
        name: 'wfb_change',
        description: 'Prepare a change to a workflow as a draft: add a stage after another, add or remove a field, set the fallback recipient or escalation days. A live workflow is copied to a draft first. Returns approval_required.',
        input: z.object({ workflow: z.string().max(80).optional(), add_stage: z.string().max(40).optional(), after_stage: z.string().max(40).optional(), add_field: z.string().max(60).optional(), remove_field: z.string().max(60).optional(), fallback: z.string().max(80).optional(), escalate_days: z.number().int().min(1).max(30).optional() }).strict(),
        run: async (a: { workflow?: string; add_stage?: string; after_stage?: string; add_field?: string; remove_field?: string; fallback?: string; escalate_days?: number }, ctx) => {
          need(ctx);
          const d: Definition = a.workflow ? await wf.find(a.workflow) : await wf.latestDraft();
          const next: WfSpec = structuredClone(d.spec);
          const changes: { label: string; before: string; after: string }[] = [];
          if (a.add_stage) {
            const at = next.stages.findIndex((s) => s.toLowerCase() === (a.after_stage ?? '').toLowerCase());
            if (at < 0) throw new CoreError('INVALID', `${d.name} has no stage called ${a.after_stage}. Its stages are ${stages(d.spec)}.`);
            next.stages.splice(at + 1, 0, a.add_stage);
            changes.push({ label: 'Stages', before: stages(d.spec), after: stages(next) });
          }
          if (a.add_field) {
            const f = splitFields([a.add_field]);
            next.persistent.push(...f.persistent);
            next.nonPersistent.push(...f.nonPersistent);
            changes.push({ label: 'Field added', before: '—', after: a.add_field });
          }
          if (a.remove_field) {
            const is = (x: { label: string }) => x.label.toLowerCase() === a.remove_field!.toLowerCase();
            if (![...next.persistent, ...next.nonPersistent].some(is)) throw new CoreError('INVALID', `${d.name} has no field called ${a.remove_field}.`);
            next.persistent = next.persistent.filter((x) => !is(x));
            next.nonPersistent = next.nonPersistent.filter((x) => !is(x));
            changes.push({ label: 'Field removed', before: a.remove_field, after: '—' });
          }
          if (a.fallback) {
            next.route.fallback = a.fallback;
            changes.push({ label: 'Fallback', before: d.spec.route.fallback ?? 'None', after: a.fallback });
          }
          if (a.escalate_days) {
            next.route.escalateDays = a.escalate_days;
            changes.push({ label: 'Escalate after', before: d.spec.route.escalateDays ? `${d.spec.route.escalateDays} days` : 'Never', after: `${a.escalate_days} business days` });
          }
          if (!changes.length) throw new CoreError('INVALID', 'What should change: a stage, a field, the fallback or the escalation?');
          const live = d.status === 'Active';
          return { change: { summary: `${live ? 'Draft a change to' : 'Update the draft of'} ${d.name}`, changes, text: `I’ve prepared the change to **${d.name}** as a draft.${live ? ' The live workflow doesn’t change until it’s published.' : ''}`, done: `The draft of **${d.name}** is updated. Say “Publish the ${d.name} workflow” when you’re ready.`, risk: 'low', apply: live ? { mode: 'copy', baseId: d.defId, name: d.name, folder: d.folder, spec: next } : { mode: 'update', defId: d.defId, spec: next } } };
        },
        apply: async (p: { mode: 'copy'; baseId: number; name: string; folder: string; spec: WfSpec } | { mode: 'update'; defId: number; spec: WfSpec }, meta, ctx) => (p.mode === 'copy' ? wf.saveDraft({ name: p.name, folder: p.folder, baseId: p.baseId, spec: p.spec }, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }) : wf.updateDraft(p.defId, p.spec, { actor: ctx.user.name, on: today() })),
      },
      {
        name: 'wfb_publish',
        description: 'Prepare publishing a draft: it must pass validation; the card shows the test route, the differences from the live version and the open items affected. High risk. Returns approval_required.',
        input: z.object({ workflow: z.string().min(2).max(80) }).strict(),
        run: async (a: { workflow: string }, ctx) => {
          need(ctx);
          const d = await wf.find(a.workflow, 'Draft').catch(async () => {
            const live = await wf.find(a.workflow, 'Active');
            throw new CoreError('INVALID', `${live.name} has no draft to publish. Describe the change first.`);
          });
          const problems = await wf.validate(d);
          if (problems.length) throw new CoreError('INVALID', `It can’t be published yet. ${problems.map((p) => `${p.problem} ${p.fix}`).join(' ')}`);
          const live = d.baseId ? await wf.find(d.name, 'Active') : null;
          const [sim, open] = await Promise.all([wf.simulate(d.spec), live ? wf.openItems(live.name) : Promise.resolve(0)]);
          return { change: { summary: `Publish the ${d.name} workflow${live ? `, affecting ${open} open ${open === 1 ? 'item' : 'items'}` : ''}`, changes: [...wf.diff(live?.spec ?? null, d.spec), ...sim.map((s) => ({ label: `Test route: ${s.sample}`, before: '—', after: s.route })), ...(live ? [{ label: 'Open items affected', before: '—', after: String(open) }] : [])].slice(0, 8), text: `**${d.name}** passes validation, and the test route is on the card. Publishing changes live routing and forms for everyone${live ? `, and ${open} open ${open === 1 ? 'item' : 'items'} move to the new version` : ''}.`, done: `**${d.name}** is live.`, risk: 'high', apply: { draftId: d.defId } } };
        },
        apply: async (p: { draftId: number }, meta, ctx) => wf.publish(p.draftId, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }),
      },
    ],
  };
  return spec;
}
