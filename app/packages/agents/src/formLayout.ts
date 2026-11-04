// Form Layout agent (spec 8.22): rearranges a workflow form's fields, groups them into tabs and
// sections, adds help text and adds fields, each shown in a preview of the form before anyone
// approves. Layout changes to a live form are medium risk; adding a field changes the data model,
// so it is high (spec 8.22 approval rules). A form that has a draft is changed in the draft instead.
import { z } from 'zod';
import type { Block } from '@dinext/block-schemas';
import { applyLayout, CoreError, layoutOf, previewOf, splitFields, type Definition, type LayoutOp, type WorkflowDefService } from '@dinext/di-core';
import type { WfSpec } from '@dinext/tenant-db';
import { newBlockId } from './answer.ts';
import type { ModuleContext, ModuleSpec } from './moduleAgent.ts';

export const FORM_LAYOUT_AGENT = 'Form Layout';
const SOURCES = [{ kind: 'table' as const, label: 'Workflow definitions', ref: 'table:wf_definition' }];

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const unq = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim();
const list = (s: string) => s.split(/,\s*|\s+and\s+/).map(unq).filter(Boolean);

export function formBlock(d: Pick<Definition, 'name' | 'status'>, spec: WfSpec, state: 'live' | 'draft' | 'proposed', marks?: Map<string, 'added' | 'moved' | 'changed'>, removed?: string[]): Block {
  return {
    id: newBlockId('frm'),
    type: 'form',
    version: '1.0.0',
    title: `${d.name} form`,
    provenance: { agent: FORM_LAYOUT_AGENT, sources: SOURCES },
    freshness: { kind: 'workflow_event' },
    data: { workflow: d.name, state, tabs: previewOf(spec, layoutOf(spec), marks), ...(removed?.length ? { removed } : {}) },
  };
}

/** Reads layout requests. Exported for tests. */
export function parseLayoutRequest(text: string): { tool: string; args: Record<string, unknown> } | { say: string } {
  const t = clean(text);
  const form = /\b(?:on|to|in|of|for) the ([\w ]+?) form\b/i.exec(t)?.[1];
  const add = /\badd (?:a |an )?["']?(.+?)["']? field to the ([\w ]+?) form(?: in (?:the )?["']?(.+?)["']? section)?$/i.exec(t);
  if (add) return { tool: 'fl_add_field', args: { workflow: add[2]!, field: unq(add[1]!), ...(add[3] ? { section: unq(add[3]) } : {}) } };
  if (!form) {
    const show = /\b(?:show|preview|open)(?: me)? the ([\w ]+?) form\b/i.exec(t);
    if (show) return { tool: 'fl_show', args: { workflow: show[1]! } };
    return { say: 'Which form? For example: “Move Best time to contact above Preferred contact method on the referral form.”' };
  }
  const ops: LayoutOp[] = [];
  let m: RegExpExecArray | null;
  if ((m = /\bmove the (.+?) section to (?:a )?(?:new )?tab(?: called)? ["']?(.+?)["']? (?:on|in) the /i.exec(t))) ops.push({ op: 'tab', section: unq(m[1]!), tab: unq(m[2]!) });
  else if ((m = /\bmove (.+?) (above|below|before|after) (.+?) (?:on|in) the /i.exec(t))) ops.push({ op: 'move', field: unq(m[1]!), ...(/above|before/i.test(m[2]!) ? { before: unq(m[3]!) } : { after: unq(m[3]!) }) });
  else if ((m = /\bmove (.+?) (?:in)?to (?:the |a )?(?:new )?["']?(.+?)["']? section (?:on|in) the /i.exec(t))) ops.push({ op: 'move', field: unq(m[1]!), section: unq(m[2]!) });
  else if ((m = /\b(?:put|group) (.+?) (?:in|into) (?:a |the )?(?:new )?(?:section )?(?:called )?["']?(.+?)["']?(?: section)?(?: on a (?:new )?tab called ["']?(.+?)["']?)? (?:on|in) the /i.exec(t))) ops.push({ op: 'group', fields: list(m[1]!), section: unq(m[2]!), ...(m[3] ? { tab: unq(m[3]) } : {}) });
  else if ((m = /\badd help text to (.+?) (?:on|in) the [\w ]+? form[:,]\s*(.+)$/i.exec(t))) ops.push({ op: 'help', field: unq(m[1]!), text: unq(m[2]!) });
  else if ((m = /\bmake the (.+?) section (one|two|1|2|single)[ -]columns? (?:on|in) the /i.exec(t))) ops.push({ op: 'columns', section: unq(m[1]!), columns: /two|2/i.test(m[2]!) ? 2 : 1 });
  else if ((m = /\brename the (.+?) section to ["']?(.+?)["']? (?:on|in) the /i.exec(t))) ops.push({ op: 'rename', section: unq(m[1]!), to: unq(m[2]!) });
  if (ops.length) return { tool: 'fl_change', args: { workflow: form, ops } };
  return { tool: 'fl_show', args: { workflow: form } };
}

export function formLayoutModule(wf: WorkflowDefService, today: () => string): ModuleSpec {
  const noAccess = 'Changing forms needs COM Center admin rights.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('form-layout')) throw new CoreError('NO_ACCESS', noAccess);
  };
  // The form people change is the draft when there is one; otherwise the live form.
  const target = async (name: string) => {
    const d = await wf.find(name);
    return { d, live: d.status === 'Active' };
  };
  const spec: ModuleSpec = {
    id: 'form-layout',
    prefix: 'frm',
    agent: FORM_LAYOUT_AGENT,
    request: /\b(edit )?form layout\b|\bhelp text\b|\b(move|put|group|rename|make)\b.*\b(on|in) the [\w ]+? form\b|\badd (a |an )?["'“]?[^"'”]+?["'”]? field to the [\w ]+? form\b|\b(show|preview|open)( me)? the [\w ]+? form\b/i,
    noAccess,
    sources: SOURCES,
    prompt: ({ tenant, user, title }) => `You are the Form Layout agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) changes how workflow forms look.

- "Show the referral form": fl_show. It previews the form as people see it.
- "Move Best time to contact above Preferred contact method on the referral form", "Put Estimated amount and Referral type in a section called Opportunity on the referral form", "Move the Opportunity section to a new tab called Lending on the referral form", "Add help text to Estimated amount on the referral form: what the member mentioned", "Make the Details section one column on the task form", "Rename the Details section to Request on the task form": fl_change with one op per change.
- "Add a Preferred branch field to the referral form": fl_add_field. Adding a field changes the data model, so it is high risk.
- Each change shows a preview of the form with what moves or is new marked; nothing changes until the user approves.`,
    plan: (text) => parseLayoutRequest(text),
    tools: [
      {
        name: 'fl_show',
        description: 'Preview a workflow form as people see it: tabs, sections, fields in order and help text. Uses the draft when there is one.',
        input: z.object({ workflow: z.string().min(2).max(80) }).strict(),
        run: async (a: { workflow: string }, ctx) => {
          need(ctx);
          const { d, live } = await target(a.workflow);
          const l = layoutOf(d.spec);
          const n = l.tabs.reduce((s, t) => s + t.sections.length, 0);
          return { text: `The **${d.name}** form (${live ? `live, version ${d.version}` : 'draft'}) has ${l.tabs.length} ${l.tabs.length === 1 ? 'tab' : 'tabs'} and ${n} ${n === 1 ? 'section' : 'sections'}.`, blocks: [formBlock(d, d.spec, live ? 'live' : 'draft')], suggestions: [`Make the ${l.tabs[0]!.sections[0]!.title} section one column on the ${d.name.toLowerCase()} form`] };
        },
      },
      {
        name: 'fl_change',
        description: 'Prepare layout changes to a workflow form, applied in order: move a field above/below another or into a section; group fields into a section (new or existing, optionally on a tab); move a section to a tab; set help text; set a section to one or two columns; rename a section. Returns approval_required with a preview.',
        input: z
          .object({
            workflow: z.string().min(2).max(80),
            ops: z
              .array(
                z.discriminatedUnion('op', [
                  z.object({ op: z.literal('move'), field: z.string().max(80), before: z.string().max(80).optional(), after: z.string().max(80).optional(), section: z.string().max(60).optional(), tab: z.string().max(40).optional() }).strict(),
                  z.object({ op: z.literal('group'), fields: z.array(z.string().max(80)).min(1).max(20), section: z.string().max(60), tab: z.string().max(40).optional(), columns: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
                  z.object({ op: z.literal('tab'), section: z.string().max(60), tab: z.string().max(40) }).strict(),
                  z.object({ op: z.literal('help'), field: z.string().max(80), text: z.string().max(200) }).strict(),
                  z.object({ op: z.literal('columns'), section: z.string().max(60), columns: z.union([z.literal(1), z.literal(2)]) }).strict(),
                  z.object({ op: z.literal('rename'), section: z.string().max(60), to: z.string().min(2).max(60) }).strict(),
                ]),
              )
              .min(1)
              .max(8),
          })
          .strict(),
        run: async (a: { workflow: string; ops: LayoutOp[] }, ctx) => {
          need(ctx);
          const { d, live } = await target(a.workflow);
          const { layout, marks, lines } = applyLayout(d.spec, a.ops, d.name);
          const next: WfSpec = { ...structuredClone(d.spec), layout };
          return {
            change: {
              summary: `Change the ${d.name} form layout${live ? '' : ' (draft)'}`,
              changes: lines.slice(0, 8),
              text: `Here’s the **${d.name}** form with the change; what moves is marked.${live ? ' It applies to the live form for everyone once approved; no data changes.' : ' It goes into the draft, so the live form doesn’t change until the draft is published.'}`,
              done: `The **${d.name}** form layout is updated${live ? '' : ' in the draft'}.`,
              risk: live ? 'medium' : 'low',
              apply: { mode: live ? 'live' : 'draft', defId: d.defId, spec: next },
              blocks: [formBlock(d, next, 'proposed', marks)],
            },
          };
        },
        apply: async (p: { mode: 'live' | 'draft'; defId: number; spec: WfSpec }, meta, ctx) => (p.mode === 'live' ? wf.saveLive(p.defId, p.spec, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }) : wf.updateDraft(p.defId, p.spec, { actor: ctx.user.name, on: today() })),
      },
      {
        name: 'fl_add_field',
        description: 'Prepare adding a field to a workflow form, optionally in a section. It changes the data model, so it is high risk on a live form. Attachments become form-only fields. Returns approval_required with a preview.',
        input: z.object({ workflow: z.string().min(2).max(80), field: z.string().min(2).max(60), section: z.string().max(60).optional() }).strict(),
        run: async (a: { workflow: string; field: string; section?: string }, ctx) => {
          need(ctx);
          const { d, live } = await target(a.workflow);
          const f = splitFields([a.field]);
          const added = [...f.persistent, ...f.nonPersistent][0]!;
          if ([...d.spec.persistent, ...d.spec.nonPersistent].some((x) => x.id === added.id || x.label.toLowerCase() === added.label.toLowerCase())) throw new CoreError('INVALID', `The ${d.name} form already has a ${added.label} field.`);
          let next: WfSpec = { ...structuredClone(d.spec), persistent: [...d.spec.persistent, ...f.persistent], nonPersistent: [...d.spec.nonPersistent, ...f.nonPersistent] };
          if (a.section) next = { ...next, layout: applyLayout(next, [{ op: 'move', field: added.label, section: a.section }], d.name).layout };
          else next = { ...next, layout: layoutOf(next) };
          const problems = (await wf.validate({ name: d.name, spec: next, baseId: d.baseId ?? (live ? d.defId : null) })).filter((p) => /field/i.test(p.problem));
          if (problems.length) throw new CoreError('INVALID', problems.map((p) => `${p.problem} ${p.fix}`).join(' '));
          const kept = added.type === 'file' ? 'form only' : 'saved on the record';
          return {
            change: {
              summary: `Add ${added.label} to the ${d.name} form${live ? '' : ' (draft)'}`,
              changes: [{ label: 'Field added', before: '—', after: `${added.label} (${added.type}, ${kept})` }, { label: 'Where', before: '—', after: layoutOf(next).tabs.flatMap((t) => t.sections).find((s) => s.fields.includes(added.id))!.title }],
              text: `Here’s the **${d.name}** form with **${added.label}** added.${live ? ' Adding a field changes what every new item stores, so this is high risk.' : ' It goes into the draft until the draft is published.'}`,
              done: `**${added.label}** is on the ${d.name} form${live ? '' : ' draft'}.`,
              risk: live ? 'high' : 'low',
              apply: { mode: live ? 'live' : 'draft', defId: d.defId, spec: next },
              blocks: [formBlock(d, next, 'proposed', new Map([[added.id, 'added' as const]]))],
            },
          };
        },
        apply: async (p: { mode: 'live' | 'draft'; defId: number; spec: WfSpec }, meta, ctx) => (p.mode === 'live' ? wf.saveLive(p.defId, p.spec, { approvalId: meta.approvalId, actor: ctx.user.name, on: today() }) : wf.updateDraft(p.defId, p.spec, { actor: ctx.user.name, on: today() })),
      },
    ],
  };
  return spec;
}
