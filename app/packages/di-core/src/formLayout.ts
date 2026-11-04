// Form layout for workflow forms (spec 8.22): the Form Layout agent rearranges fields, groups them
// into tabs and sections and adds help text. Every change is worked out here, as a new layout plus
// the fields it moved or changed, so the preview and the approval card show exactly what applies.
import type { WfField, WfLayout, WfSpec } from '@dinext/tenant-db';
import { CoreError } from './referrals.ts';

export type LayoutOp =
  | { op: 'move'; field: string; before?: string; after?: string; section?: string; tab?: string }
  | { op: 'group'; fields: string[]; section: string; tab?: string; columns?: 1 | 2 }
  | { op: 'tab'; section: string; tab: string }
  | { op: 'help'; field: string; text: string }
  | { op: 'columns'; section: string; columns: 1 | 2 }
  | { op: 'rename'; section: string; to: string };

export const allFields = (s: WfSpec): WfField[] => [...s.persistent, ...s.nonPersistent];

/** The layout a form has: its saved one with fields that came or went reconciled, or one Details tab. */
export function layoutOf(s: WfSpec): WfLayout {
  const ids = allFields(s).map((f) => f.id);
  const base: WfLayout = s.layout
    ? structuredClone(s.layout)
    : { tabs: [{ title: 'Details', sections: [{ title: 'Details', columns: 2, fields: s.persistent.map((f) => f.id) }, ...(s.nonPersistent.length ? [{ title: 'Notes and attachments', columns: 1 as const, fields: s.nonPersistent.map((f) => f.id) }] : [])] }], help: {} };
  for (const t of base.tabs) for (const sec of t.sections) sec.fields = sec.fields.filter((id) => ids.includes(id));
  const placed = new Set(base.tabs.flatMap((t) => t.sections.flatMap((x) => x.fields)));
  const missing = ids.filter((id) => !placed.has(id));
  if (missing.length) {
    if (!base.tabs.length) base.tabs.push({ title: 'Details', sections: [] });
    if (!base.tabs[0]!.sections.length) base.tabs[0]!.sections.push({ title: 'Details', columns: 2, fields: [] });
    base.tabs[0]!.sections[0]!.fields.push(...missing);
  }
  for (const k of Object.keys(base.help)) if (!ids.includes(k)) delete base.help[k];
  return base;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/^the /, '').replace(/ (field|section|tab)$/, '');

/** Applies layout changes in order. Throws CoreError naming what doesn't exist. */
export function applyLayout(s: WfSpec, ops: LayoutOp[], workflow: string) {
  const fields = allFields(s);
  const layout = layoutOf(s);
  const marks = new Map<string, 'moved' | 'changed'>();
  const lines: { label: string; before: string; after: string }[] = [];
  const field = (name: string) => {
    const f = fields.find((x) => norm(x.label) === norm(name) || x.id === norm(name).replace(/[^a-z0-9]+/g, '_'));
    if (!f) throw new CoreError('INVALID', `I can’t find a field called ${name} on the ${workflow} form. Its fields are ${fields.map((x) => x.label).join(', ')}.`);
    return f;
  };
  const sections = () => layout.tabs.flatMap((t) => t.sections.map((sec) => ({ tab: t, sec })));
  const where = (id: string) => sections().find((x) => x.sec.fields.includes(id))!;
  const findSection = (name: string) => sections().find((x) => norm(x.sec.title) === norm(name));
  const needSection = (name: string) => {
    const hit = findSection(name);
    if (!hit) throw new CoreError('INVALID', `I can’t find a section called ${name} on the ${workflow} form. Its sections are ${sections().map((x) => x.sec.title).join(', ')}.`);
    return hit;
  };
  const tabNamed = (name: string) => {
    let t = layout.tabs.find((x) => norm(x.title) === norm(name));
    if (!t) {
      if (layout.tabs.length >= 6) throw new CoreError('INVALID', 'A form can have at most 6 tabs.');
      t = { title: name.trim().replace(/^\w/, (c) => c.toUpperCase()), sections: [] };
      layout.tabs.push(t);
    }
    return t;
  };
  const take = (id: string) => {
    const at = where(id);
    at.sec.fields = at.sec.fields.filter((x) => x !== id);
    return at;
  };

  for (const op of ops) {
    if (op.op === 'move') {
      const f = field(op.field);
      const from = where(f.id).sec.title;
      const anchorName = op.before ?? op.after;
      if (anchorName) {
        const anchor = field(anchorName);
        if (anchor.id === f.id) throw new CoreError('INVALID', `Move ${f.label} relative to another field.`);
        take(f.id);
        const at = where(anchor.id);
        const i = at.sec.fields.indexOf(anchor.id);
        at.sec.fields.splice(op.before ? i : i + 1, 0, f.id);
        lines.push({ label: f.label, before: from, after: `${op.before ? 'Above' : 'Below'} ${anchor.label}${at.sec.title !== from ? `, in ${at.sec.title}` : ''}` });
      } else if (op.section) {
        const target = findSection(op.section) ?? (() => {
          const t = op.tab ? tabNamed(op.tab) : layout.tabs[0]!;
          const sec = { title: op.section!.trim().replace(/^\w/, (c) => c.toUpperCase()), columns: 2 as const, fields: [] as string[] };
          t.sections.push(sec);
          return { tab: t, sec };
        })();
        take(f.id);
        target.sec.fields.push(f.id);
        lines.push({ label: f.label, before: from, after: target.sec.title });
      } else throw new CoreError('INVALID', `Where should ${f.label} go: above or below another field, or into a section?`);
      marks.set(f.id, 'moved');
    } else if (op.op === 'group') {
      const fs = op.fields.map(field);
      const t = op.tab ? tabNamed(op.tab) : where(fs[0]!.id).tab;
      let target = findSection(op.section);
      if (!target) {
        if (t.sections.length >= 10) throw new CoreError('INVALID', 'A tab can have at most 10 sections.');
        const sec = { title: op.section.trim().replace(/^\w/, (c) => c.toUpperCase()), columns: op.columns ?? 2, fields: [] as string[] };
        t.sections.push(sec);
        target = { tab: t, sec };
      }
      for (const f of fs) {
        const from = where(f.id).sec.title;
        take(f.id);
        target.sec.fields.push(f.id);
        marks.set(f.id, 'moved');
        if (from !== target.sec.title) lines.push({ label: f.label, before: from, after: `${target.sec.title}${t !== layout.tabs[0] ? ` (${t.title} tab)` : ''}` });
      }
    } else if (op.op === 'tab') {
      const hit = needSection(op.section);
      const t = tabNamed(op.tab);
      if (hit.tab === t) continue;
      hit.tab.sections = hit.tab.sections.filter((x) => x !== hit.sec);
      t.sections.push(hit.sec);
      for (const id of hit.sec.fields) marks.set(id, 'moved');
      lines.push({ label: `${hit.sec.title} section`, before: `${hit.tab.title} tab`, after: `${t.title} tab` });
    } else if (op.op === 'help') {
      const f = field(op.field);
      const text = op.text.trim().slice(0, 200);
      lines.push({ label: `${f.label} help`, before: layout.help[f.id] ?? '—', after: text || '—' });
      if (text) layout.help[f.id] = text;
      else delete layout.help[f.id];
      marks.set(f.id, 'changed');
    } else if (op.op === 'columns') {
      const hit = needSection(op.section);
      lines.push({ label: `${hit.sec.title} section`, before: `${hit.sec.columns} ${hit.sec.columns === 1 ? 'column' : 'columns'}`, after: `${op.columns} ${op.columns === 1 ? 'column' : 'columns'}` });
      hit.sec.columns = op.columns;
    } else if (op.op === 'rename') {
      const hit = needSection(op.section);
      lines.push({ label: 'Section name', before: hit.sec.title, after: op.to.trim() });
      hit.sec.title = op.to.trim().slice(0, 60);
    }
  }
  // Sections and tabs left empty by a move go away, but the form always keeps one tab.
  for (const t of layout.tabs) t.sections = t.sections.filter((x) => x.fields.length);
  layout.tabs = layout.tabs.filter((t) => t.sections.length);
  if (!layout.tabs.length) throw new CoreError('INVALID', 'That would leave the form empty.');
  if (!lines.length) throw new CoreError('INVALID', 'That doesn’t change the layout.');
  return { layout, marks, lines };
}

/** The preview the form block shows: fields by tab and section, with marks for what a change touches. */
export function previewOf(s: WfSpec, layout: WfLayout, marks: Map<string, 'added' | 'moved' | 'changed'> = new Map()) {
  const byId = new Map(allFields(s).map((f) => [f.id, f]));
  return layout.tabs.map((t) => ({
    title: t.title,
    sections: t.sections.map((sec) => ({
      title: sec.title,
      columns: sec.columns,
      fields: sec.fields.map((id) => {
        const f = byId.get(id)!;
        return { id: f.id, label: f.label, type: f.type, ...(layout.help[id] ? { help: layout.help[id] } : {}), ...(marks.get(id) ? { mark: marks.get(id)! } : {}) };
      }),
    })),
  }));
}
