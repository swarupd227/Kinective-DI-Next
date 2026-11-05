// Data Load (spec 8.21 Integrations > Files): a CSV or Excel file the person uploaded becomes a table.
// DI reads the file, says what each column holds and what's wrong with it, matches it to one of the
// person's uploaded tables or proposes a new one, and prepares a card that states exactly what will
// load. The approved rows are written as approved. Curated core tables are never changed here, and
// SFTP folders and scheduled uploaders come in a later slice.
import { z } from 'zod';
import { CoreError, convert, profile, tableNameFrom, type Cell, type ColumnProfile, type FileProfile, type FileStore, type IngestService, type UploadedTable, type ValueKind } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const FILE = /[“"]([^”"]+\.(?:csv|tsv|txt|xlsx|xls))[”"]|(\S+\.(?:csv|tsv|txt|xlsx|xls))\b/i;
const KIND_OF_TYPE: Record<string, ValueKind> = { number: 'number', count: 'number', currency: 'currency', percent: 'percent', date: 'date', text: 'text' };
const normal = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const KIND_LABEL: Record<ValueKind, string> = { number: 'Number', currency: 'Dollars', percent: 'Percent', date: 'Date', yesno: 'Yes or no', text: 'Text' };

/** "into a new table called Branch targets", "into the Branch targets table", "replace", from a request. */
export function loadTarget(t: string): { table?: string; mode?: 'new' | 'append' | 'replace' } {
  const replace = /\b(?:replace|overwrite)\b/i.test(t);
  const fresh = /\binto (?:a )?new table(?: (?:called|named) [“"]?([^“”".]+?)[”"]?)?\s*$/i.exec(t.replace(/[.!?]+$/, ''));
  if (fresh) return { mode: 'new', ...(fresh[1] ? { table: fresh[1].trim() } : {}) };
  const into = /\b(?:into|to|in) (?:the |my )?[“"]?([^“”".]+?)[”"]?(?: table)?\s*$/i.exec(t.replace(/[.!?]+$/, '').replace(FILE, ''));
  const table = into?.[1]?.trim();
  return { ...(table && !/^(a |an )?table$/i.test(table) ? { table } : {}), ...(replace ? { mode: 'replace' as const } : {}) };
}

export function dataLoadModule(files: FileStore | null, ingest: IngestService | null, today: () => string): ModuleSpec {
  const noAccess = 'Loading data files needs the File Manager and Tables in your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('files') || !ctx.modules.includes('tables')) throw new CoreError('NO_ACCESS', noAccess);
    if (!files || !ingest) throw new CoreError('INVALID', 'Data file loading isn’t set up in this environment.');
    return { files, ingest };
  };
  /** The person's staged upload, read and profiled. */
  const read = async (ctx: ModuleContext, file?: string) => {
    const { files, ingest } = need(ctx);
    const staged = await files.stagedContent(ctx.user.id, file).catch((e: unknown) => {
      if (e instanceof CoreError && e.code === 'NOT_FOUND') throw new CoreError('NOT_FOUND', file ? `None of the files you uploaded today is called “${file}”. Upload it on Integrations first.` : 'There’s no uploaded file to load. Choose one under “Upload a data file” on Integrations; I can’t receive files in chat.');
      throw e;
    });
    const sheet = await ingest.read(staged.name, staged.body);
    return { staged, sheet, p: profile(sheet) };
  };
  const columnRows = (cols: ColumnProfile[]) => cols.map((c) => ({ column: c.header, type: KIND_LABEL[c.kind], filled: `${c.filled.toLocaleString('en-US')} of ${(c.filled + c.blank).toLocaleString('en-US')}`, problems: c.invalid ? `${c.invalid} won’t load (${c.invalidExamples.join(', ')})` : c.filled ? 'None' : 'Empty', example: c.example.slice(0, 40) }));
  const columnTable = (spec: ModuleSpec, ctx: ModuleContext, cols: ColumnProfile[]) => moduleTable(spec, 'Columns in the file', ctx.runId, 'ingest.profile', [{ field: 'column', headerName: 'Column', type: 'text' }, { field: 'type', headerName: 'Holds', type: 'text' }, { field: 'filled', headerName: 'Filled', type: 'text' }, { field: 'problems', headerName: 'Problems', type: 'text' }, { field: 'example', headerName: 'Example', type: 'text' }], columnRows(cols));
  const preview = (spec: ModuleSpec, ctx: ModuleContext, title: string, columns: { field: string; headerName: string; type: string }[], rows: Cell[][]) =>
    moduleTable(spec, title, ctx.runId, 'ingest.preview', columns.slice(0, 12).map((c) => ({ field: c.field, headerName: c.headerName, type: (c.type === 'date' ? 'text' : c.type) as 'text' })), rows.slice(0, 8).map((r) => Object.fromEntries(columns.slice(0, 12).map((c, i) => [c.field, r[i] ?? (c.type === 'text' || c.type === 'date' ? '—' : null)]))) as Record<string, string | number>[]);

  /** Rows aligned to an existing table's columns, each converted to that column's type. */
  const fitTo = (t: UploadedTable, p: FileProfile, sheetRows: Cell[][]) => {
    const byHeader = new Map(p.columns.map((c, i) => [normal(c.header), i]));
    const extra = p.columns.filter((c) => !t.columns.some((x) => normal(x.headerName) === normal(c.header))).map((c) => c.header);
    const missing = t.columns.filter((x) => !byHeader.has(normal(x.headerName))).map((x) => x.headerName);
    let invalid = 0;
    const rows = sheetRows.map((r) =>
      t.columns.map((x) => {
        const i = byHeader.get(normal(x.headerName));
        if (i === undefined) return null;
        const v = convert(r[i] ?? null, KIND_OF_TYPE[x.type] ?? 'text');
        if (v === null && r[i] !== null && String(r[i]).trim() !== '') invalid++;
        return v;
      }),
    );
    return { extra, missing, invalid, rows };
  };

  const spec: ModuleSpec = {
    id: 'dataload',
    prefix: 'dl',
    agent: 'Data Load',
    request: /\b(?:load|import|ingest)\b[^.?!]*(?:\.(?:csv|tsv|txt|xlsx|xls)\b|\b(?:file|csv|excel|spreadsheet)\b)|\b(?:check|profile|look at)\b[^.?!]*\.(?:csv|tsv|txt|xlsx|xls)\b|\bsftp\b|\b(?:file|scheduled) uploaders?\b|\bfixed[- ]width\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Uploaded data files', ref: 'table:tbl_object' }],
    prompt: ({ tenant, user, title }) => `You are the Data Load agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) loads data files.

- "Check branch_targets.csv": dl_profile. "Load branch_targets.csv into a new table": dl_load.
- "Load it into the Branch targets table", "replace the Branch targets table with it": dl_load with table and mode.
- The file must be uploaded on Integrations first; you can't receive files in chat.
- Curated tables from the core can't be loaded into. SFTP folders and scheduled uploaders aren't built yet; say so.`,
    plan: (text) => {
      const t = text.trim();
      if (/\bsftp\b|\b(?:file|scheduled) uploaders?\b/i.test(t)) return { say: 'Loading from an SFTP folder and scheduled uploaders come next. Today, upload the file under “Upload a data file” on Integrations and I’ll load it.' };
      const file = FILE.exec(t);
      const name = (file?.[1] ?? file?.[2])?.trim();
      if (/\b(?:check|profile|look at)\b/i.test(t) && !/\b(?:load|import)\b/i.test(t)) return { tool: 'dl_profile', args: name ? { file: name } : {} };
      return { tool: 'dl_load', args: { ...(name ? { file: name } : {}), ...loadTarget(t) } };
    },
    tools: [
      {
        name: 'dl_profile',
        description: 'Read an uploaded CSV or Excel file: each column’s type, how full it is, and its problems. Changes nothing.',
        input: z.object({ file: z.string().max(160).optional() }).strict(),
        run: async (a: { file?: string }, ctx) => {
          const { staged, sheet, p } = await read(ctx, a.file);
          const problems = [...p.blockers, ...p.warnings];
          return {
            text: `**${staged.name}** has ${plural(p.rowCount, 'row')} and ${plural(p.columns.length, 'column')}. ${problems.length ? problems.join(' ') : 'I found no problems.'}${p.blockers.length ? '' : ' Say where to load it, or I’ll make a new table from it.'}`,
            blocks: [columnTable(spec, ctx, p.columns), preview(spec, ctx, 'First rows', p.columns.map((c) => ({ field: c.field, headerName: c.header, type: c.type })), sheet.rows)],
            suggestions: p.blockers.length ? [] : [`Load ${staged.name} into a new table`],
          };
        },
      },
      {
        name: 'dl_load',
        description: 'Prepare loading an uploaded CSV or Excel file into a new uploaded table, or adding it to (or replacing) one of the person’s uploaded tables. Returns approval_required.',
        input: z.object({ file: z.string().max(160).optional(), table: z.string().max(80).optional(), mode: z.enum(['new', 'append', 'replace']).optional() }).strict(),
        run: async (a: { file?: string; table?: string; mode?: 'new' | 'append' | 'replace' }, ctx) => {
          const { ingest } = need(ctx);
          const { staged, sheet, p } = await read(ctx, a.file);
          if (p.blockers.length) throw new CoreError('INVALID', `I can’t load ${staged.name} yet. ${p.blockers.join(' ')}`);
          const name = (a.table ?? tableNameFrom(staged.name)).slice(0, 80);
          const existing = await ingest.table(ctx.user.id, name);
          if (a.mode === 'new' && existing) throw new CoreError('INVALID', `You already have a table called ${existing.name}. Should I add these rows to it, replace its rows, or use another name?`);
          if (a.table && !existing && a.mode && a.mode !== 'new') throw new CoreError('NOT_FOUND', `You have no uploaded table called ${a.table}. I can load the file into a new table with that name.`);
          if (!existing) {
            const columns = p.columns.map((c) => ({ field: c.field, headerName: c.header, type: c.type }));
            return {
              change: {
                summary: `Load ${staged.name} into a new table, ${name}`,
                changes: [
                  { label: 'Table', before: '—', after: `${name} (new)` },
                  { label: 'Rows', before: '—', after: p.rowCount.toLocaleString('en-US') },
                  { label: 'Columns', before: '—', after: p.columns.map((c) => `${c.header} (${c.type === 'currency' && c.kind === 'number' ? 'dollars' : KIND_LABEL[c.kind].toLowerCase()})`).join(', ').slice(0, 240) },
                  { label: 'Checks', before: '—', after: (p.warnings.join(' ') || 'No problems found').slice(0, 240) },
                ],
                text: `I’ve read **${staged.name}**: ${plural(p.rowCount, 'row')}, ${plural(p.columns.length, 'column')}. ${p.warnings.length ? p.warnings.join(' ') : 'Every value fits its column.'} It will load as a new table, **${name}**, that only you can see until you share it.`,
                done: `Loaded **${p.rowCount.toLocaleString('en-US')} rows** into **${name}**. It’s in Tables, under your saved views and snapshots.`,
                risk: 'medium',
                records: p.rowCount,
                apply: { name, objId: null, mode: 'new', columns, rows: p.typed },
                blocks: [preview(spec, ctx, `What will load into ${name}`, columns, p.typed)],
              },
            };
          }
          const mode = a.mode === 'replace' ? 'replace' : 'append';
          const fit = fitTo(existing, p, sheet.rows);
          if (fit.extra.length) throw new CoreError('INVALID', `${staged.name} has ${fit.extra.length === 1 ? 'a column' : 'columns'} the ${existing.name} table doesn’t: ${fit.extra.join(', ')}. I can load it into a new table instead, or you can remove ${fit.extra.length === 1 ? 'that column' : 'those columns'} and upload it again.`);
          const after = mode === 'replace' ? p.rowCount : existing.rowCount + p.rowCount;
          const notes = [...p.warnings.filter((w) => !/won.t load|load blank/.test(w)), ...(fit.missing.length ? [`${fit.missing.join(', ')} ${fit.missing.length === 1 ? 'isn’t' : 'aren’t'} in the file, so ${fit.missing.length === 1 ? 'it loads' : 'they load'} blank.`] : []), ...(fit.invalid ? [`${plural(fit.invalid, 'value')} don’t fit their column’s type and will load blank.`] : [])];
          return {
            change: {
              summary: `${mode === 'replace' ? 'Replace the rows of' : 'Add rows to'} ${existing.name} from ${staged.name}`,
              changes: [
                { label: 'Table', before: existing.name, after: existing.name },
                { label: 'Rows', before: existing.rowCount.toLocaleString('en-US'), after: `${after.toLocaleString('en-US')}${mode === 'append' ? ` (+${p.rowCount.toLocaleString('en-US')})` : ''}` },
                { label: 'Checks', before: '—', after: (notes.join(' ') || 'Every column matches; no problems found').slice(0, 240) },
              ],
              text: `I’ve matched **${staged.name}** to your **${existing.name}** table. ${mode === 'replace' ? `Its ${plural(existing.rowCount, 'row')} will be replaced by these ${plural(p.rowCount, 'row')}.` : `${plural(p.rowCount, 'row')} will be added to its ${plural(existing.rowCount, 'row')}.`}${notes.length ? ` ${notes.join(' ')}` : ''}`,
              done: `${mode === 'replace' ? 'Replaced the rows of' : 'Added rows to'} **${existing.name}**: it now has **${after.toLocaleString('en-US')} rows**.`,
              risk: mode === 'replace' ? 'high' : 'medium',
              records: p.rowCount,
              apply: { name: existing.name, objId: existing.objId, mode, columns: existing.columns, rows: fit.rows },
              blocks: [preview(spec, ctx, `What will load into ${existing.name}`, existing.columns, fit.rows)],
            },
          };
        },
        apply: async (p: { name: string; objId: number | null; mode: 'new' | 'append' | 'replace'; columns: { field: string; headerName: string; type: 'text' }[]; rows: Cell[][] }, meta, ctx) => {
          await need(ctx).ingest.load({ ...p, owner: { userId: ctx.user.id, name: ctx.user.name } }, { approvalId: meta.approvalId, on: today() });
        },
      },
    ],
  };
  return spec;
}
