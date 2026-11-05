// Tables agent (spec 8.11). Column stats and how tables link are reads. Snapshots, merged saved views,
// sharing, deleting to the Recycle Bin and restoring from it each wait on a card. Every figure, row
// count and column list is worked out in DI Core under the person's purview; the model only picks the
// tool. Warehouse rows come from the core system each night and can't be added or edited here.
import { z } from 'zod';
import { CoreError, SHARE_TARGETS, SNAPSHOT_ROW_CAP, keyNamed, shareTargetNamed, tableNamed, type ColumnStat, type TableObject, type TableService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const n = (x: number) => x.toLocaleString('en-US');
const usd = (x: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(x);
const kind = (o: TableObject) => (o.kind === 'View' ? 'saved view' : 'snapshot');
const audience = (cls: string | null) => (!cls ? 'Only you' : cls === 'Everyone' ? 'Everyone at the institution' : `The ${cls} class`);
/** The words for an item, without "the", "view" or "snapshot" around them. */
const itemWords = (s: string) =>
  s
    .replace(/^(?:the|my|our)\s+/i, '')
    .replace(/\s+(?:saved view|view|snapshot)s?$/i, '')
    .replace(/^"|"$/g, '')
    .trim();

/** "Restore the X view", or a snapshot by its name, which says snapshot. */
export const restoreAsk = (o: Pick<TableObject, 'kind' | 'name'>) => (o.kind === 'View' ? `Restore the ${o.name} view` : `Restore ${o.name}`);

/** Adding, editing or changing rows in a warehouse table. */
const EDIT = /\bnew record\b|\b(?:add|insert|create) (?:a |an )?(?:new )?(?:record|row)s?\b|\b(?:edit|update|change|modify|correct|overwrite) (?:a |the |this |that )?(?:record|row)s?\b|\b(?:edit|update|change|modify|correct|overwrite)\b.*\b(?:in|on) the [\w ]{2,40}? table\b/i;

export const NO_TABLE_EDITS = 'Rows in the curated tables can’t be added or edited in DI: they come from the core system in each nightly build. Records change through workflows and the core system. I can show column stats, take a snapshot, or save a merged view.';

function range(s: ColumnStat) {
  if (s.min === null || s.max === null) return '—';
  if (s.type === 'currency') return `${usd(Number(s.min))} to ${usd(Number(s.max))}`;
  if (s.type === 'percent') return `${s.min}% to ${s.max}%`;
  if (typeof s.min === 'number' && typeof s.max === 'number') return `${n(s.min)} to ${n(s.max)}`;
  return `${s.min} to ${s.max}`;
}
const mean = (s: ColumnStat) => (s.mean === null ? '—' : s.type === 'currency' ? usd(s.mean) : s.type === 'percent' ? `${s.mean.toFixed(2)}%` : n(Math.round(s.mean * 10) / 10));
const top = (s: ColumnStat) => (s.top.length ? s.top.map((t) => `${t.value} (${n(t.count)})`).join(', ') : '—');

/** Column stats as the agent and the Tables page show them, every figure formatted here. */
export const columnStatRows = (cols: ColumnStat[]) => cols.map((c) => ({ column: c.column, type: c.type, filled: `${c.nonNullPct}%`, distinct: c.distinct, range: range(c), average: mean(c), top: top(c) }));

export function tablesModule(svc: TableService | null, today: () => string): ModuleSpec {
  const noAccess = 'Tables isn’t part of your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('tables')) throw new CoreError('NO_ACCESS', noAccess);
    if (!svc) throw new CoreError('INVALID', 'Saved views and snapshots aren’t set up in this environment, so I can’t do that here.');
    return svc;
  };
  const scope = (ctx: ModuleContext) => ({ purviewBranches: ctx.purviewBranches });
  const purviewWords = (ctx: ModuleContext) => (ctx.purviewBranches ? `Your purview: ${ctx.purviewBranches.join(', ')}` : 'All branches');
  const s = () => svc!;
  const objectRows = (list: TableObject[]) => list.map((o) => ({ name: o.name, kind: o.kind === 'View' ? 'Saved view' : 'Snapshot', table: s().catalog.find((c) => c.id === o.tableId)?.label ?? o.tableId, rows: o.kind === 'View' ? 'Runs when opened' : n(o.rowCount), owner: o.ownerName, shared: audience(o.sharedClass), made: o.createdOn }));
  const objectColumns = [{ field: 'name', headerName: 'Name', type: 'text' as const }, { field: 'kind', headerName: 'Kind', type: 'text' as const }, { field: 'table', headerName: 'Table', type: 'text' as const }, { field: 'rows', headerName: 'Rows', type: 'text' as const }, { field: 'owner', headerName: 'Owner', type: 'text' as const }, { field: 'shared', headerName: 'Who can see it', type: 'text' as const }, { field: 'made', headerName: 'Made', type: 'text' as const }];

  const spec: ModuleSpec = {
    id: 'tables',
    prefix: 'tbl',
    agent: 'Tables',
    // Reports, files and the calendar have their own words. "Table summary" is a report.
    request: /^(?!.*\.(pdf|docx?|xlsx?|pptx?|csv|txt|png|jpe?g|gif|webp)\b)(?!.*\b(reports?|files?|folder|calendar|table summary)\b)(?:.*\b(column (stats?|statistics|profiles?)|snapshots?|saved views?|new record)\b|.*\bprofile (the |my )?[\w ]{2,40}? table\b|.*\bstats (for|on|of) (the )?[\w ]{2,40}? (column|table)\b|.*\bmerge\b.+\b(with|and)\b.+\bon\b|.*\bmerge\b.+\b(with|and)\b.+\b(saved? (it )?as a view|as a (saved )?view|view called)\b|.*\b(which|what) (other )?tables?\b.*\b(link|join|relate|connect)|.*\b(relationships?|links?|joins?) (for|of|on|to|with) (the )?[\w ]{2,40}? table\b|.*\b(make|share)\b.*\bviews?\b.*\b(public|with|to)\b|.*\b(delete|remove|restore|recover|undelete)\b.*\bviews?\b|.*\btables? recycle bin\b|.*\b(add|insert|create) (a |an )?(new )?(record|row)s?\b|.*\b(edit|update|change|modify|correct|overwrite) (a |the |this |that )?(record|row)s?\b|.*\b(edit|update|change|modify|correct|overwrite)\b.*\b(in|on) the [\w ]{2,40}? table\b)/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Tables', ref: 'table:tbl_object' }],
    prompt: ({ tenant, user, title }) => `You are the Tables agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) works with the curated tables: ${svc ? svc.catalog.map((c) => c.label).join(', ') : 'none'}.

- "Profile the loan accounts table", "Column stats for balance": tbl_stats, with column only when they named one.
- "Which tables link to loan accounts?": tbl_relationships.
- "Show my saved views and snapshots": tbl_list. "What's in the Tables Recycle Bin?": tbl_bin.
- "Snapshot the loan accounts table": tbl_snapshot.
- "Merge loan accounts with members on member ID as a saved view called Loans with members": tbl_merge. Ask for a name if they gave none.
- "Make the Loans with members view public to the Analyst class": tbl_share.
- "Delete the Loans with members view": tbl_delete (to the Recycle Bin). "Restore Loans with members": tbl_restore.
- Adding or editing rows in a table isn't possible: the rows come from the core system. Say so; don't call a tool.`,
    plan: (text) => {
      const t = clean(text);
      if (EDIT.test(t)) return { say: NO_TABLE_EDITS };
      const quoted = /"([^"]+)"/.exec(t)?.[1];
      const merge = /\bmerge\s+(?:the )?(.+?)\s+(?:table\s+)?(?:with|and|to)\s+(?:the )?(.+?)\s+(?:table\s+)?on\s+(?:the )?(.+?)(?:\s+(?:as|into|called|named)\s+(?:a |my )?(?:new )?(?:saved view|view)?\s*(?:called|named)?\s*(.+))?$/i.exec(t);
      if (merge) return { tool: 'tbl_merge', args: { left: merge[1]!, right: merge[2]!, key: merge[3]!.replace(/\s+column$/i, ''), ...(quoted || merge[4] ? { name: quoted ?? merge[4]!.replace(/^"|"$/g, '').trim() } : {}) } };
      const restore = /\b(?:restore|recover|undelete|bring back)\s+(.+?)(?:\s+(?:from|out of) (?:the |my )?(?:tables? )?recycle bin)?$/i.exec(t);
      if (restore) return { tool: 'tbl_restore', args: { item: quoted ?? itemWords(restore[1]!) } };
      if (/\brecycle bin\b/i.test(t)) return { tool: 'tbl_bin', args: {} };
      const drop = /\b(?:delete|remove|bin|trash)\s+(.+?)$/i.exec(t);
      if (drop) return { tool: 'tbl_delete', args: { item: quoted ?? itemWords(drop[1]!) } };
      // The item ends at "view" or "snapshot" when it says so, since its name may hold "with".
      const share = /\b(?:make|share)\s+(?:the |my )?(.+?)\s+(?:saved view|view|snapshot)\b(?:\s+public)?(?:\s+(?:to|with|for)\s+(?:the )?(.+?))?(?:\s+class)?$/i.exec(t) ?? /\bshare\s+(.+)\s+with\s+(?:the )?(.+?)(?:\s+class)?$/i.exec(t) ?? /\bmake\s+(.+?)\s+public(?:\s+(?:to|with|for)\s+(?:the )?(.+?))?(?:\s+class)?$/i.exec(t);
      if (share) return { tool: 'tbl_share', args: { item: quoted ?? itemWords(share[1]!), ...(share[2] ? { with: share[2] } : {}) } };
      if (/\b(?:show|list|what|which|my)\b.*\b(?:snapshots|saved views|views)\b/i.test(t)) return { tool: 'tbl_list', args: {} };
      const snap = /\b(?:snapshot|take a snapshot of|freeze)\s+(?:of\s+)?(?:the |my )?(.+?)(?:\s+table)?$/i.exec(t);
      if (snap) return { tool: 'tbl_snapshot', args: { table: snap[1]! } };
      const table = tableNamed(t, svc?.catalog);
      if (/\b(link|join|relat|connect)/i.test(t)) return table ? { tool: 'tbl_relationships', args: { table: table.id } } : { say: 'Which table? For example: “Which tables link to Loan Accounts?”' };
      // A column named, with the table's own name taken out first so "loan accounts" never reads as the Account column.
      const catalog = svc?.catalog ?? [];
      const rest = table ? t.toLowerCase().replace(table.label.toLowerCase(), ' ').replace(table.id.replace('_', ' '), ' ') : t.toLowerCase();
      const has = (c: { headerName: string; field: string }) => new RegExp(`\\b${c.headerName.toLowerCase()}\\b`).test(rest) || new RegExp(`\\b${c.field.replace(/_/g, ' ')}\\b`).test(rest);
      const owner = table ?? catalog.find((c) => c.columns.some(has));
      // A personal column is named too, so the tool can say it isn't profiled.
      const column = owner?.columns.find(has)?.headerName ?? owner?.personal.find((p) => rest.includes(p));
      if (!owner) return { say: `Which table? The curated tables are ${catalog.map((c) => c.label).join(', ')}.` };
      return { tool: 'tbl_stats', args: { table: owner.id, ...(column ? { column } : {}) } };
    },
    tools: [
      {
        name: 'tbl_stats',
        description: 'Column stats for a curated table, within the user’s purview: each column’s type, how full it is, distinct values, range and average for numbers, top values for text. Personal columns are left out.',
        input: z.object({ table: z.string().min(2).max(60), column: z.string().min(2).max(60).optional() }).strict(),
        run: async (a: { table: string; column?: string }, ctx) => {
          const st = await need(ctx).stats(a.table, scope(ctx), a.column);
          const t = st.table;
          const left = t.personal.length ? ` Personal columns (${t.personal.join(', ')}) are left out.` : '';
          const one = a.column && st.columns.length === 1 ? st.columns[0]! : null;
          const text = one ? `**${one.column}** in ${t.label}: ${one.nonNullPct}% filled, ${n(one.distinct)} distinct values${one.mean !== null ? `, ${range(one)}, average ${mean(one)}` : one.top.length ? `, most often ${top(one)}` : ''}. ${n(st.rows)} rows in ${ctx.purviewBranches ? 'your purview' : 'all branches'}.` : `**${t.label}**: ${st.columns.length} columns over ${n(st.rows)} rows in ${ctx.purviewBranches ? 'your purview' : 'all branches'}.${left}`;
          return {
            text,
            blocks: [moduleTable(spec, `${t.label} column stats`, ctx.runId, 'tables.stats', [{ field: 'column', headerName: 'Column', type: 'text' }, { field: 'type', headerName: 'Type', type: 'text' }, { field: 'filled', headerName: 'Filled', type: 'text' }, { field: 'distinct', headerName: 'Distinct', type: 'count' }, { field: 'range', headerName: 'Range', type: 'text' }, { field: 'average', headerName: 'Average', type: 'text' }, { field: 'top', headerName: 'Top values', type: 'text' }], columnStatRows(st.columns))],
            suggestions: [`Which tables link to ${t.label}?`, `Snapshot the ${t.label} table`],
          };
        },
      },
      {
        name: 'tbl_relationships',
        description: 'Which curated tables link to this one, and on what key.',
        input: z.object({ table: z.string().min(2).max(60) }).strict(),
        run: async (a: { table: string }, ctx) => {
          const svc2 = need(ctx);
          const t = svc2.table(a.table);
          const links = svc2.relationships(t.id);
          if (!links.length) return { text: `No other curated table links to ${t.label}.` };
          return { text: `**${links.length} ${links.length === 1 ? 'table links' : 'tables link'}** to ${t.label}: ${links.map((l) => `${l.table} on ${l.key}`).join(', ')}.`, blocks: [moduleTable(spec, `Tables linked to ${t.label}`, ctx.runId, 'tables.relationships', [{ field: 'table', headerName: 'Table', type: 'text' }, { field: 'key', headerName: 'On', type: 'text' }, { field: 'shape', headerName: 'Rows', type: 'text' }], links.map((l) => ({ table: l.table, key: l.key, shape: l.shape })))], suggestions: links[0] ? [`Merge ${t.label} with ${links[0].table} on ${links[0].key} as a saved view called ${t.label} with ${links[0].table}`] : [] };
        },
      },
      {
        name: 'tbl_list',
        description: 'The saved views and snapshots the user can see: their own and those shared with their class.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          const all = await need(ctx).objects(ctx.user.id);
          if (!all.length) return { text: 'You have no saved views or snapshots yet. Ask me to snapshot a table or merge two into a saved view.' };
          const mine = all.filter((o) => o.ownerUserId === ctx.user.id).length;
          return { text: `**${all.length} ${all.length === 1 ? 'item' : 'items'}**: ${mine} of your own${all.length > mine ? `, ${all.length - mine} shared with you` : ''}. Open one on the Tables page.`, blocks: [moduleTable(spec, 'Saved views and snapshots', ctx.runId, 'tables.objects', objectColumns, objectRows(all))] };
        },
      },
      {
        name: 'tbl_bin',
        description: 'The user’s own saved views and snapshots in the Tables Recycle Bin.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          const bin = await need(ctx).objects(ctx.user.id, { status: 'Recycle Bin' });
          if (!bin.length) return { text: 'Your Tables Recycle Bin is empty.' };
          return { text: `**${bin.length} ${bin.length === 1 ? 'item' : 'items'}** in your Tables Recycle Bin. Each can be restored.`, blocks: [moduleTable(spec, 'Tables Recycle Bin', ctx.runId, 'tables.bin', objectColumns, objectRows(bin))], suggestions: [restoreAsk(bin[0]!)] };
        },
      },
      {
        name: 'tbl_snapshot',
        description: 'Prepare a snapshot: a dated, frozen copy of a curated table’s rows in the user’s purview, up to 5,000 rows, that only they can see. Low risk. Returns approval_required.',
        input: z.object({ table: z.string().min(2).max(60) }).strict(),
        run: async (a: { table: string }, ctx) => {
          const svc2 = need(ctx);
          const t = svc2.table(a.table);
          const name = `${t.label} snapshot ${today()}`;
          const same = (await svc2.objects(ctx.user.id)).find((o) => o.ownerUserId === ctx.user.id && o.name === name);
          if (same) throw new CoreError('INVALID', `You already took ${name} today. Delete it first if you want a new one.`);
          const total = await svc2.count(t.id, scope(ctx));
          const kept = Math.min(total, SNAPSHOT_ROW_CAP);
          return {
            change: {
              summary: `Snapshot ${t.label}`,
              changes: [{ label: 'Snapshot', before: '—', after: name }, { label: 'Rows', before: '—', after: total > kept ? `The first ${n(kept)} of ${n(total)}, in ${t.label}’s usual order` : n(total) }, { label: 'Rows from', before: '—', after: purviewWords(ctx) }, { label: 'Columns', before: '—', after: t.columns.map((c) => c.headerName).join(', ') }, { label: 'Who can see it', before: '—', after: 'Only you' }],
              text: `I’ve prepared a snapshot of **${t.label}**: ${n(kept)} rows as of today, frozen so they don’t change with the nightly build${total > kept ? `. Snapshots keep up to ${n(SNAPSHOT_ROW_CAP)} rows, so ${n(total - kept)} are left out` : ''}.`,
              done: `Saved **${name}**. It’s on the Tables page.`,
              risk: 'low',
              apply: { name, tableId: t.id, purview: ctx.purviewBranches ?? null, owner: { userId: ctx.user.id, name: ctx.user.name } },
            },
          };
        },
        apply: async (p: Parameters<TableService['saveSnapshot']>[0], meta) => s().saveSnapshot(p, { approvalId: meta.approvalId, on: today() }),
      },
      {
        name: 'tbl_merge',
        description: 'Prepare a saved view that merges two curated tables on a key both have, such as member ID or branch. It saves the definition, not a copy, and only the user sees it. Low risk. Returns approval_required.',
        input: z.object({ left: z.string().min(2).max(60), right: z.string().min(2).max(60), key: z.string().min(2).max(40), name: z.string().min(2).max(120).optional() }).strict(),
        run: async (a: { left: string; right: string; key: string; name?: string }, ctx) => {
          const svc2 = need(ctx);
          const left = svc2.table(a.left);
          const right = svc2.table(a.right);
          const p = await svc2.previewMerge({ left: left.id, right: right.id, key: keyNamed(a.key) ?? a.key }, scope(ctx));
          if (!a.name) throw new CoreError('INVALID', `What should the saved view of ${left.label} with ${right.label} be called?`);
          const name = a.name.replace(/\s+/g, ' ').trim();
          if ((await svc2.objects(ctx.user.id)).some((o) => o.ownerUserId === ctx.user.id && o.name.toLowerCase() === name.toLowerCase())) throw new CoreError('INVALID', `You already have something called ${name}. Choose another name.`);
          const keyLabel = left.columns.find((c) => c.field === p.key)?.headerName ?? p.key;
          const cols = p.columns.map((c) => c.headerName);
          return {
            change: {
              summary: `Save view ${name}`,
              changes: [{ label: 'Saved view', before: '—', after: name }, { label: 'Merges', before: '—', after: `${left.label} with ${right.label} on ${keyLabel}` }, { label: 'Rows', before: '—', after: `${n(p.rowCount)} for you now. It runs again each time it’s opened.` }, { label: 'Columns', before: '—', after: `${cols.slice(0, 8).join(', ')}${cols.length > 8 ? `, and ${cols.length - 8} more` : ''}` }, { label: 'Who can see it', before: '—', after: 'Only you' }],
              text: `I’ve prepared a saved view, **${name}**: ${left.label} with ${right.label} on ${keyLabel}, ${n(p.rowCount)} rows in ${ctx.purviewBranches ? 'your purview' : 'all branches'}. It keeps the definition, not a copy, so it stays current.`,
              done: `Saved **${name}**. Open it on the Tables page.`,
              risk: 'low',
              apply: { name, definition: { left: left.id, right: right.id, key: p.key }, rowCount: p.rowCount, owner: { userId: ctx.user.id, name: ctx.user.name } },
            },
          };
        },
        apply: async (p: Parameters<TableService['saveView']>[0], meta) => s().saveView(p, { approvalId: meta.approvalId, on: today() }),
      },
      {
        name: 'tbl_share',
        description: `Prepare sharing one of the user’s saved views or snapshots with a user class (${SHARE_TARGETS.join(', ')}). Medium risk. Returns approval_required.`,
        input: z.object({ item: z.string().min(2).max(120), with: z.string().min(2).max(40).optional() }).strict(),
        run: async (a: { item: string; with?: string }, ctx) => {
          const o = await need(ctx).own(ctx.user.id, a.item);
          const to = a.with ? shareTargetNamed(a.with) : undefined;
          if (!to) throw new CoreError('INVALID', `Share ${o.name} with which class: ${SHARE_TARGETS.join(', ')}?`);
          if (o.sharedClass === to) throw new CoreError('INVALID', `${o.name} is already shared with ${audience(to).toLowerCase()}.`);
          return {
            change: {
              summary: `Share ${o.name} with ${to === 'Everyone' ? 'everyone' : `the ${to} class`}`,
              changes: [{ label: o.name, before: audience(o.sharedClass), after: audience(to) }, { label: 'What they see', before: '—', after: o.kind === 'View' ? 'The view, run under each person’s own purview' : 'The frozen rows, only those in each person’s own purview' }],
              text: `I’ve prepared sharing the ${kind(o)} **${o.name}** with **${audience(to).toLowerCase()}**. Each person sees only rows in their own purview.`,
              done: `Shared **${o.name}** with ${audience(to).toLowerCase()}.`,
              risk: 'medium',
              apply: { objId: o.objId, ownerUserId: ctx.user.id, from: o.sharedClass, to },
            },
          };
        },
        apply: async (p: Parameters<TableService['share']>[0]) => void (await s().share(p)),
      },
      {
        name: 'tbl_delete',
        description: 'Prepare deleting one of the user’s saved views or snapshots. It goes to the Tables Recycle Bin, where it can be restored; nothing is deleted for good. Low risk. Returns approval_required.',
        input: z.object({ item: z.string().min(2).max(120) }).strict(),
        run: async (a: { item: string }, ctx) => {
          const o = await need(ctx).own(ctx.user.id, a.item);
          return {
            change: { summary: `Delete ${o.name}`, changes: [{ label: o.name, before: o.sharedClass ? `Shared with ${audience(o.sharedClass).toLowerCase()}` : 'Active', after: 'Recycle Bin' }], text: `I’ve prepared moving the ${kind(o)} **${o.name}** to the Tables Recycle Bin. It isn’t deleted for good, and you can restore it.${o.sharedClass ? ' People it’s shared with won’t see it while it’s there.' : ''}`, done: `Moved **${o.name}** to the Recycle Bin.`, risk: 'low', apply: { objId: o.objId, ownerUserId: ctx.user.id } },
          };
        },
        apply: async (p: { objId: number; ownerUserId: string }) => void (await s().recycle(p, { on: today() })),
      },
      {
        name: 'tbl_restore',
        description: 'Prepare restoring one of the user’s saved views or snapshots from the Tables Recycle Bin. Low risk. Returns approval_required.',
        input: z.object({ item: z.string().min(2).max(120) }).strict(),
        run: async (a: { item: string }, ctx) => {
          const svc2 = need(ctx);
          const o = await svc2.own(ctx.user.id, a.item, 'Recycle Bin').catch(async (e: unknown) => {
            const live = e instanceof CoreError && e.code === 'NOT_FOUND' ? await svc2.object(ctx.user.id, a.item).catch(() => null) : null;
            if (live) throw new CoreError('INVALID', `${live.name} isn’t in the Recycle Bin, so it can’t be restored. It’s on the Tables page.`);
            if (e instanceof CoreError && e.code === 'NOT_FOUND') throw new CoreError('NOT_FOUND', `There’s nothing called “${a.item}” in your Tables Recycle Bin, so I can’t restore it.`);
            throw e;
          });
          return {
            change: { summary: `Restore ${o.name}`, changes: [{ label: o.name, before: 'Recycle Bin', after: o.sharedClass ? `Back, shared with ${audience(o.sharedClass).toLowerCase()}` : 'Back on the Tables page' }], text: `I’ve prepared restoring the ${kind(o)} **${o.name}** from the Tables Recycle Bin.`, done: `Restored **${o.name}**.`, risk: 'low', apply: { objId: o.objId, ownerUserId: ctx.user.id } },
          };
        },
        apply: async (p: { objId: number; ownerUserId: string }) => void (await s().restore(p)),
      },
    ],
  };
  return spec;
}
