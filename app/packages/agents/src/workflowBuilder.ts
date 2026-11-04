// Workflow Builder agent (spec 24.7, 8.16). Drafts are low risk; publishing is high, because it
// changes live routing and forms for everyone, and it's refused while validation finds a problem.
// The definition, its checks and its test route come from DI Core.
import { z } from 'zod';
import { CoreError, splitFields, WORKSHEET_CREATORS, WORKSHEET_PRODUCTS, type Definition, type ReferralTypeSheet, type WorkflowDefService, type WorksheetService } from '@dinext/di-core';
import type { FormField, RouteRule, WfSpec, Worksheet } from '@dinext/tenant-db';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const title = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ').replace(/s$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const list = (s: string) => s.split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
const stages = (s: WfSpec) => s.stages.join(' → ');
const route = (s: WfSpec) => `${s.route.queue}${s.route.byLocation ? ' by location' : ''}${s.route.escalateDays ? `, escalating after ${s.route.escalateDays} business days` : ''}${s.route.fallback ? `, fallback ${s.route.fallback}` : ', no fallback'}`;

// ---- Referral Builder Worksheet ----------------------------------------------------------------

const CONTACT: Record<string, FormField> = {
  'preferred contact method': { id: 'preferred_contact', label: 'Preferred contact method', type: 'enum', required: true, options: ['Phone', 'Email', 'Text', 'In branch'] },
  'best time to contact': { id: 'best_time', label: 'Best time to contact', type: 'enum', required: false, options: ['Morning', 'Afternoon', 'Evening', 'Any time'] },
};
/** Worksheet section 3: the fields to capture become the referral form's fields. */
export const referralFields = (labels: string[]): FormField[] =>
  labels.map((l) => {
    const label = l.trim().replace(/^\w/, (c) => c.toUpperCase());
    const known = CONTACT[label.toLowerCase()];
    if (known) return known;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return /\b(amount|balance|\$)/i.test(label) ? { id: id.includes('amount') ? 'estimated_amount' : id, label, type: 'money', required: false } : { id, label, type: 'text', required: false };
  });
const pickAll = (asked: string[], from: string[]) => asked.map((a) => from.find((f) => f.toLowerCase().startsWith(a.toLowerCase().replace(/s$/, '').slice(0, 6))) ?? `Other: ${a}`);
const categoryOf = (products: string[]) => {
  const p = products.join(' ');
  return /credit card/i.test(p) ? 'Cards' : /mortgage/i.test(p) ? 'Mortgage' : /auto|heloc|loan/i.test(p) ? 'Lending' : /checking|savings/i.test(p) ? 'Deposits' : /business/i.test(p) ? 'Business' : 'Other';
};
const sheetLines = (t: Pick<ReferralTypeSheet, 'fields' | 'receives'> & { worksheet: Worksheet }) => [
  `1. **What is referred:** ${t.worksheet.products.join(', ') || 'Not set'}`,
  `2. **Who creates it:** ${t.worksheet.creators.join(', ') || 'Not set'}`,
  `3. **Fields to capture:** ${t.fields.map((f) => f.label).join(', ')}`,
  `4. **Who receives it:** ${t.receives}${t.worksheet.fallback ? `. If nobody is available: ${t.worksheet.fallback}` : ''}`,
  `5. **Success and credit:** success is “${t.worksheet.success || 'not set'}”; unsuccessful is “${t.worksheet.unsuccessful || 'not set'}”. Incentive credit: ${t.worksheet.credit}${t.worksheet.creditRule ? ` (${t.worksheet.creditRule})` : ''}`,
  `6. **Notes and follow-up:** ${t.worksheet.notes.length ? t.worksheet.notes.map((n) => `${n.topic}: ${n.answer || 'open'}${n.owner ? ` (owner ${n.owner})` : ''}`).join('; ') : 'None'}`,
];

/** Reads worksheet requests. Exported for tests. */
export function parseWorksheetRequest(t: string): { tool: string; args: Record<string, unknown> } | null {
  const setUp = /\b(?:set up|create|add) (?:a )?(?:new )?referral type (?:for|called) ["']?(.+?)["']?[:,]\s*(.+)$/i.exec(t);
  if (setUp) {
    const parts = setUp[2]!.split(/[,;]?\s*(?=\b(?:created by|fields?|routed|success when|credit (?:yes|no|on|off|not sure)|referring)\b)/i).map((s) => s.trim().replace(/[,;]$/, ''));
    const get = (re: RegExp) => parts.map((p) => re.exec(p)?.[1]).find(Boolean);
    const products = get(/^referring\s+(.+)$/i);
    const route = parts.find((p) => /^routed\b/i.test(p)) ?? '';
    const byBranch = /\bby branch\b/i.exec(route) ? (/lending/i.test(route) ? 'lending' : 'service') : undefined;
    return {
      tool: 'wfb_referral_type_new',
      args: {
        name: setUp[1]!.trim(),
        products: products ? list(products) : [],
        creators: list(get(/^created by\s+(.+)$/i) ?? ''),
        fields: list(get(/^fields?\s+(.+)$/i) ?? ''),
        ...(byBranch ? { route_by_branch: byBranch } : { route_queue: /^routed to\s+(?:the )?(.+?)(?: queue)?$/i.exec(route)?.[1] ?? '' }),
        success: get(/^success when\s+(.+)$/i) ?? '',
        credit: /\bcredit (yes|on)\b/i.test(setUp[2]!) ? 'Yes' : /\bcredit (no|off)\b/i.test(setUp[2]!) ? 'No' : 'Not sure yet',
      },
    };
  }
  const who = /\blet (.+?) create (.+?) referrals$/i.exec(t);
  if (who) return { tool: 'wfb_worksheet_update', args: { type: who[2]!, add_creators: list(who[1]!) } };
  const win = /\bcount (?:a |an )?(.+?) referral as (?:successful|a success) when (.+)$/i.exec(t);
  if (win) return { tool: 'wfb_worksheet_update', args: { type: win[1]!, success: win[2]! } };
  const credit = /\bturn (on|off) (?:incentive )?credit for (.+?) referrals$/i.exec(t);
  if (credit) return { tool: 'wfb_worksheet_update', args: { type: credit[2]!, credit: credit[1]!.toLowerCase() === 'on' ? 'Yes' : 'No' } };
  const note = /\badd a note to the (.+?) worksheet[:,]\s*(.+?)(?:,? owner ([A-Z][a-z]+ [A-Z][a-z]+))?$/i.exec(t);
  if (note) return { tool: 'wfb_worksheet_update', args: { type: note[1]!, note: note[2]!, ...(note[3] ? { owner: note[3] } : {}) } };
  const show = /\b(?:referral builder )?worksheet (?:for|of) (?:the )?(.+?)(?: referrals?)?$/i.exec(t) ?? /\bthe (.+?) (?:referral )?worksheet\b/i.exec(t);
  if (show) return { tool: 'wfb_worksheet', args: { type: show[1]! } };
  if (/\breferral (types|builder|worksheets?)\b/i.test(t)) return { tool: 'wfb_worksheet', args: {} };
  return null;
}

export function workflowBuilderModule(wf: WorkflowDefService, today: () => string, sheets?: WorksheetService): ModuleSpec {
  const noAccess = 'The Workflow Builder needs COM Center admin rights.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('workflow-builder')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const fieldRows = (s: WfSpec) => [...s.persistent.map((f) => ({ field: f.label, type: f.type, kept: 'Saved on the record' })), ...s.nonPersistent.map((f) => ({ field: f.label, type: f.type, kept: 'Form only' }))];
  const spec: ModuleSpec = {
    id: 'workflow-builder',
    prefix: 'wfb',
    agent: 'Workflow Builder',
    request: /\breferral (builder|types?|worksheets?)\b|\bworksheet\b|\blet .+? create .+? referrals\b|\bcount (a |an )?.+? referral as\b|\bturn (on|off) (incentive )?credit for\b|\bworkflow (definitions?|builder)\b|\bcreate a workflow\b|\bstage between\b|\badd (a |an )?["']?[^"']+?["']? (field|stage) (to|for|between)\b|\bremove the ["']?[^"']+?["']? field\b|\bpublish (the )?.+? (workflow|draft)\b|\bfallback to [A-Z]|\bwhich workflows\b|\b(test|simulate) (the )?rout/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Workflow definitions', ref: 'table:wf_definition' }],
    prompt: ({ tenant, user, title: role }) => `You are the Workflow Builder agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${role}) sets up workflows (COMs).

- "Which workflows do we have?", "Show the workflow definitions": wfb_list. One workflow in detail, with its checks and a test route: wfb_get.
- "Create a workflow for branch maintenance requests with category, location, urgency and photo, routed to Facilities by location": wfb_draft_new.
- "Add a 'Waiting on member' stage between Active and Sold for referrals", "Add a 'Best time to call' field to the task workflow", "Fallback to Sam Taylor": wfb_change. Changes always go to a draft.
- "Publish the branch maintenance request workflow": wfb_publish. It refuses while validation finds problems; say what they are and how to fix them.
- The Referral Builder Worksheet, one per referral type: "Show the worksheet for HELOC", "Which referral types do we have?": wfb_worksheet. "Let tellers and call center create HELOC referrals", "Count a HELOC referral as successful when the line is booked", "Turn on credit for certificate referrals", "Add a note to the HELOC worksheet: rename it Home equity, owner Dana Lee": wfb_worksheet_update. "Set up a referral type for Business credit cards: referring Credit card, created by Branch Managers, fields Business name and Estimated amount, routed to Business banking, success when the card is booked, credit yes": wfb_referral_type_new (high risk: creators can send it at once).`,
    plan: (text) => {
      const t = clean(text);
      const sheet = parseWorksheetRequest(t);
      if (sheet) return sheet;
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
          return { text: `**${defs.filter((d) => d.status === 'Active').length} live workflows**${drafts.length ? ` and ${drafts.length} ${drafts.length === 1 ? 'draft' : 'drafts'} (${drafts.map((d) => d.name).join(', ')})` : ''}.`, blocks: [moduleTable(spec, 'Workflow definitions', ctx.runId, 'workflow.definition.list', [{ field: 'id', headerName: 'ID', type: 'number' }, { field: 'name', headerName: 'Name', type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }, { field: 'open', headerName: 'Open items', type: 'count' }, { field: 'folder', headerName: 'Folder', type: 'text' }, { field: 'persistent', headerName: 'Saved fields', type: 'text' }, { field: 'nonPersistent', headerName: 'Form-only fields', type: 'text' }, { field: 'stages', headerName: 'Stages', type: 'text' }], defs.filter((d) => d.status === 'Active' || d.status === 'Draft').map((d) => ({ id: d.defId, name: d.name, folder: d.folder, persistent: d.spec.persistent.map((f) => f.label).join(', '), nonPersistent: d.spec.nonPersistent.map((f) => f.label).join(', ') || '—', stages: stages(d.spec), status: d.status === 'Draft' ? 'Draft' : `Live, v${d.version}`, open: d.openItems })))] };
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
      {
        name: 'wfb_worksheet',
        description: 'The Referral Builder Worksheet for one referral type (what is referred, who creates it, fields, who receives it, success and credit, notes), or every referral type with its worksheet in brief.',
        input: z.object({ type: z.string().max(80).optional() }).strict(),
        run: async (a: { type?: string }, ctx) => {
          need(ctx);
          if (!sheets) throw new CoreError('NOT_FOUND', 'Referral types aren’t loaded here.');
          if (!a.type) {
            const all = await sheets.list();
            return { text: `**${all.length} referral types.** Ask for one worksheet, such as “Show the worksheet for HELOC”.`, blocks: [moduleTable(spec, 'Referral types', ctx.runId, 'referral.worksheet.list', [{ field: 'type', headerName: 'Referral type', type: 'text' }, { field: 'products', headerName: 'What is referred', type: 'text' }, { field: 'creators', headerName: 'Who creates it', type: 'text' }, { field: 'receives', headerName: 'Who receives it', type: 'text' }, { field: 'credit', headerName: 'Credit', type: 'text' }], all.map((t) => ({ type: t.label, products: t.worksheet.products.join(', '), creators: t.worksheet.creators.join(', '), receives: t.receives, credit: t.worksheet.credit })))] };
          }
          const t = await sheets.find(a.type);
          return { text: `**${t.label} referral worksheet**\n\n${sheetLines(t).join('\n')}`, suggestions: (() => {
            // Suggest the next useful change: a creator it doesn't have yet, or turning credit on.
            const next = WORKSHEET_CREATORS.find((c) => !t.worksheet.creators.includes(c));
            return next ? [`Let ${next.toLowerCase()} create ${t.label} referrals`] : t.worksheet.credit !== 'Yes' ? [`Turn on credit for ${t.label} referrals`] : [];
          })() };
        },
      },
      {
        name: 'wfb_worksheet_update',
        description: 'Prepare a change to a referral type’s worksheet: add who can create it, what counts as success or not, whether it earns incentive credit and how, the fallback note, or a note with an owner. Routing and fields change through the referral type itself. Returns approval_required.',
        input: z.object({ type: z.string().min(2).max(80), add_creators: z.array(z.string().max(40)).max(8).optional(), success: z.string().max(200).optional(), unsuccessful: z.string().max(200).optional(), credit: z.enum(['Yes', 'No', 'Not sure yet']).optional(), credit_rule: z.string().max(200).optional(), fallback: z.string().max(200).optional(), note: z.string().max(200).optional(), owner: z.string().max(80).optional() }).strict(),
        run: async (a: { type: string; add_creators?: string[]; success?: string; unsuccessful?: string; credit?: Worksheet['credit']; credit_rule?: string; fallback?: string; note?: string; owner?: string }, ctx) => {
          need(ctx);
          if (!sheets) throw new CoreError('NOT_FOUND', 'Referral types aren’t loaded here.');
          const t = await sheets.find(a.type);
          const w: Worksheet = structuredClone(t.worksheet);
          const changes: { label: string; before: string; after: string }[] = [];
          if (a.add_creators?.length) {
            const add = pickAll(a.add_creators, WORKSHEET_CREATORS).filter((c) => !w.creators.includes(c));
            if (!add.length) throw new CoreError('INVALID', `${a.add_creators.join(' and ')} can already create ${t.label} referrals.`);
            changes.push({ label: 'Who creates it', before: w.creators.join(', ') || '—', after: [...w.creators, ...add].join(', ') });
            w.creators.push(...add);
          }
          const set = (key: 'success' | 'unsuccessful' | 'creditRule' | 'fallback', label: string, v?: string) => {
            if (v === undefined) return;
            changes.push({ label, before: w[key] || '—', after: v.trim() });
            w[key] = v.trim();
          };
          set('success', 'Success', a.success);
          set('unsuccessful', 'Unsuccessful', a.unsuccessful);
          if (a.credit) {
            changes.push({ label: 'Incentive credit', before: w.credit, after: a.credit });
            w.credit = a.credit;
          }
          set('creditRule', 'How credit is earned', a.credit_rule);
          set('fallback', 'If nobody is available', a.fallback);
          if (a.note) {
            w.notes.push({ topic: a.note.trim(), answer: '', owner: a.owner?.trim() ?? '' });
            changes.push({ label: 'Note added', before: '—', after: `${a.note.trim()}${a.owner ? ` (owner ${a.owner})` : ''}` });
          }
          if (!changes.length) throw new CoreError('INVALID', 'What should change on the worksheet: who creates it, success, credit, the fallback or a note?');
          const creditChange = a.credit !== undefined && a.credit !== t.worksheet.credit;
          return { change: { summary: `Update the ${t.label} referral worksheet`, changes, text: `I’ve prepared the change to the **${t.label}** worksheet.${creditChange ? ' Incentive plans read this, so a credit change is medium risk.' : ''}`, done: `The **${t.label}** worksheet is updated.`, risk: creditChange || a.add_creators?.length ? 'medium' : 'low', apply: { typeId: t.typeId, worksheet: w } } };
        },
        apply: async (p: { typeId: string; worksheet: Worksheet }, meta, ctx) => sheets!.update(p.typeId, p.worksheet, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }),
      },
      {
        name: 'wfb_referral_type_new',
        description: 'Prepare a new referral type from a filled-in worksheet: name, what is referred, who creates it, the fields to capture, where it goes (an existing queue by name, or by branch to the lending or member services queue), success and credit. Live for creators once approved, so high risk. Returns approval_required.',
        input: z.object({ name: z.string().min(3).max(60), products: z.array(z.string().max(60)).max(8).default([]), creators: z.array(z.string().max(40)).max(8).default([]), fields: z.array(z.string().max(60)).max(12).default([]), route_queue: z.string().max(80).optional(), route_by_branch: z.enum(['lending', 'service']).optional(), success: z.string().max(200).default(''), credit: z.enum(['Yes', 'No', 'Not sure yet']).default('Not sure yet') }).strict(),
        run: async (a: { name: string; products: string[]; creators: string[]; fields: string[]; route_queue?: string; route_by_branch?: 'lending' | 'service'; success: string; credit: Worksheet['credit'] }, ctx) => {
          need(ctx);
          if (!sheets) throw new CoreError('NOT_FOUND', 'Referral types aren’t loaded here.');
          const missing = [!a.fields.length && 'the fields to capture', !a.route_queue && !a.route_by_branch && 'where it goes', !a.creators.length && 'who creates it'].filter(Boolean);
          if (missing.length) throw new CoreError('INVALID', `To set up ${a.name}, I need ${missing.join(', ')}.`);
          const existing = await sheets.list();
          if (existing.some((t) => t.label.toLowerCase() === a.name.toLowerCase())) throw new CoreError('INVALID', `A referral type called ${a.name} already exists. Ask to change its worksheet instead.`);
          const queues = await sheets.queues();
          let route: RouteRule;
          if (a.route_by_branch) route = { kind: 'by_location', queue: a.route_by_branch, fallbackQueue: a.route_by_branch === 'lending' ? 'q_lending_central' : 'q_member_services' };
          else {
            const want = a.route_queue!.toLowerCase().replace(/\b(the|queue|team)\b/g, '').trim();
            const q = queues.find((x) => x.name.toLowerCase().includes(want));
            if (!q) throw new CoreError('INVALID', /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(a.route_queue!.trim()) ? `Routing to one person isn’t built: referrals go to a queue. Name a queue with ${a.route_queue} in it, such as ${queues[0]?.name}.` : `There’s no queue called ${a.route_queue}. Queues: ${queues.map((x) => x.name).join(', ')}. A new queue comes from the Workflow Builder.`);
            route = { kind: 'queue', queueId: q.queueId };
          }
          const products = a.products.length ? pickAll(a.products, WORKSHEET_PRODUCTS) : ['Other'];
          const fields = referralFields(a.fields);
          const worksheet: Worksheet = { products, creators: pickAll(a.creators, WORKSHEET_CREATORS), success: a.success, unsuccessful: '', credit: a.credit, creditRule: '', fallback: '', notes: [] };
          const typeId = a.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
          const receives = route.kind === 'queue' ? `One shared queue, ${queues.find((x) => x.queueId === (route as { queueId: string }).queueId)!.name}` : `By the member’s branch to its ${a.route_by_branch === 'lending' ? 'lending' : 'member services'} queue, round-robin`;
          return {
            change: {
              summary: `Set up the ${a.name} referral type`,
              changes: [
                { label: 'What is referred', before: '—', after: products.join(', ') },
                { label: 'Who creates it', before: '—', after: worksheet.creators.join(', ') },
                { label: 'Fields', before: '—', after: fields.map((f) => f.label).join(', ') },
                { label: 'Who receives it', before: '—', after: receives },
                { label: 'Success', before: '—', after: a.success || 'Not set yet' },
                { label: 'Incentive credit', before: '—', after: a.credit },
              ],
              text: `I’ve filled in the worksheet for **${a.name}**. Once approved, ${worksheet.creators.join(', ')} can send it straight away, so this is high risk.`,
              done: `**${a.name}** is set up. It appears in the referral form’s type list now.`,
              risk: 'high',
              apply: { typeId, label: a.name, category: categoryOf(products), description: `${a.name} referral`, fields, route, worksheet },
            },
          };
        },
        apply: async (p: { typeId: string; label: string; category: string; description: string; fields: FormField[]; route: RouteRule; worksheet: Worksheet }, meta, ctx) => sheets!.create(p, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }),
      },
    ],
  };
  return spec;
}
