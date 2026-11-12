// Data Load (spec 8.21 Integrations > Files): a CSV or Excel file the person uploaded becomes a table.
// DI reads the file, says what each column holds and what's wrong with it, matches it to one of the
// person's uploaded tables or proposes a new one, and prepares a card that states exactly what will
// load. The approved rows are written as approved. Curated core tables are never changed here, and
// SFTP folders and scheduled uploaders come in a later slice.
import { z } from 'zod';
import { CoreError, OFFCORE_FIELDS, convert, profile, tableNameFrom, type Cell, type ColumnProfile, type FileProfile, type FileStore, type IngestService, type OffcorePlan, type OffcoreService, type UploadedTable, type ValueKind } from '@dinext/di-core';
import { clearBriefingCache } from './briefing.ts';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

const FILE = /[“"]([^”"]+\.(?:csv|tsv|txt|xlsx|xls))[”"]|(\S+\.(?:csv|tsv|txt|xlsx|xls))\b/i;
const KIND_OF_TYPE: Record<string, ValueKind> = { number: 'number', count: 'number', currency: 'currency', percent: 'percent', date: 'date', text: 'text' };
const normal = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
/** The loan fields an off-core file can't load without. */
const OFFCORE_REQUIRED = new Set<string>(OFFCORE_FIELDS.filter((f) => f.required).map((f) => f.field));
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

export function dataLoadModule(files: FileStore | null, ingest: IngestService | null, today: () => string, offcore: OffcoreService | null = null): ModuleSpec {
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

  // ---- off-core loans ----
  const needOffcore = (ctx: ModuleContext) => {
    need(ctx);
    if (!offcore) throw new CoreError('INVALID', 'Off-core loan loading isn’t set up in this environment.');
    return offcore;
  };
  const usd = (v: number) => (Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);
  const n = (v: number) => v.toLocaleString('en-US');
  const offcorePlan = async (ctx: ModuleContext, file?: string, types?: Record<string, string>) => {
    const svc = needOffcore(ctx);
    const { staged, sheet } = await read(ctx, file);
    return { staged, plan: await svc.prepare(staged.name, sheet, { types }) };
  };
  const offcoreMapping = (ctx: ModuleContext, plan: OffcorePlan) =>
    moduleTable(spec, 'How the columns map', ctx.runId, 'offcore.mapping', [{ field: 'di', headerName: 'DI loan field', type: 'text' }, { field: 'column', headerName: 'Column in the file', type: 'text' }, { field: 'how', headerName: 'Match', type: 'text' }], [
      ...plan.columns.map((c) => ({ di: c.label, column: c.header ?? '—', how: c.how === 'exact' ? 'Same name' : c.how === 'close' ? 'Close name: check it' : OFFCORE_REQUIRED.has(c.field) ? 'Missing: needed' : 'Not in the file' })),
      ...plan.ignored.map((x) => ({ di: '—', column: x.header, how: x.why })),
    ]);
  const offcoreTypes = (ctx: ModuleContext, plan: OffcorePlan) =>
    moduleTable(spec, 'Loan types as your categories', ctx.runId, 'offcore.types', [{ field: 'type', headerName: 'In the file', type: 'text' }, { field: 'category', headerName: 'DI category', type: 'text' }, { field: 'loans', headerName: 'Loans', type: 'count' }, { field: 'balance', headerName: 'Balance', type: 'currency' }], plan.types.map((t) => ({ type: t.type, category: t.category === '—' ? 'Not placed: say which' : `${t.category}${t.indirect ? ', indirect' : ''}${t.how === 'said' ? ' (as you said)' : ''}`, loans: t.loans, balance: t.balance })));
  const sourceTable = (ctx: ModuleContext, by: { source: string; loans: number; balance: number; delinquent60: number }[]) => {
    const total = by.reduce((s, x) => s + x.balance, 0);
    return moduleTable(spec, 'Loans by source', ctx.runId, 'offcore.by_source', [{ field: 'source', headerName: 'Source', type: 'text' }, { field: 'loans', headerName: 'Loans', type: 'count' }, { field: 'balance', headerName: 'Balance', type: 'currency' }, { field: 'share', headerName: 'Share', type: 'text' }, { field: 'dq', headerName: '60+ delinquent', type: 'text' }], by.map((x) => ({ source: x.source, loans: x.loans, balance: x.balance, share: total ? `${((x.balance / total) * 100).toFixed(1)}%` : '—', dq: x.balance ? `${((x.delinquent60 / x.balance) * 100).toFixed(2)}%` : '—' })));
  };
  const offcoreView = (ctx: ModuleContext, file: string, plan: OffcorePlan, _loaded: boolean) => {
    const blocks = [offcoreMapping(ctx, plan), offcoreTypes(ctx, plan)];
    if (plan.skipped.length) blocks.push(moduleTable(spec, 'Rows that won’t load', ctx.runId, 'offcore.skipped', [{ field: 'line', headerName: 'Row', type: 'number' }, { field: 'ref', headerName: 'Loan number', type: 'text' }, { field: 'why', headerName: 'Why', type: 'text' }], plan.skipped.map((x) => ({ line: x.line, ref: x.ref, why: x.why }))));
    if (plan.blockers.length) return { text: `I can’t load **${file}** as off-core loans yet. ${plan.blockers.join(' ')}`, blocks, suggestions: [] as string[] };
    const close = plan.columns.filter((c) => c.how === 'close');
    return {
      text: `**${file}** is ${plural(plan.rows.length + plan.skipped.length, 'row')} of loans ${plan.servicer ? `from ${plan.servicer}` : 'from a servicer'}, as of ${plan.asOf}: ${plural(plan.rows.length, 'loan')} can load, **${usd(plan.balance)}** (${plan.byCategory.map((c) => `${c.category} ${usd(c.balance)}`).join(', ')}).${plan.delinquent60 ? ` ${usd(plan.delinquent60)} of it is 60 or more days past due.` : ''}${plan.skipped.length ? ` ${plural(plan.skipped.length, 'row')} won’t load: ${plan.skipped.map((x) => `${x.ref} (${x.why.toLowerCase()})`).join('; ')}.` : ''}${close.length ? ` Check ${close.map((c) => `${c.header} as ${c.label.toLowerCase()}`).join(' and ')}: the names are close, not the same.` : ''}${plan.warnings.length ? ` ${plan.warnings.join(' ')}` : ''}${plan.previous ? ` Last month’s load was ${plural(plan.previous.loans, 'loan')}, ${usd(plan.previous.balance)}, as of ${plan.previous.asOf}; this one has ${n(plan.previous.added)} new and ${n(plan.previous.gone)} gone.` : ''}`,
      blocks,
      suggestions: [`Load ${file} as off-core loans`],
    };
  };

  const spec: ModuleSpec = {
    id: 'dataload',
    prefix: 'dl',
    agent: 'Data Load',
    request: /\b(?:load|import|ingest)\b[^.?!]*(?:\.(?:csv|tsv|txt|xlsx|xls)\b|\b(?:file|csv|excel|spreadsheet)\b)|\b(?:check|profile|look at)\b[^.?!]*\.(?:csv|tsv|txt|xlsx|xls)\b|\bsftp\b|\b(?:file|scheduled) uploaders?\b|\bfixed[- ]width\b|\boff[- ]core\b|\bparticipations? (?:file|spreadsheet|report)\b|\bloans? by source\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'Uploaded data files', ref: 'table:tbl_object' }],
    prompt: ({ tenant, user, title }) => `You are the Data Load agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) loads data files.

- "Check branch_targets.csv": dl_profile. "Load branch_targets.csv into a new table": dl_load.
- "Load it into the Branch targets table", "replace the Branch targets table with it": dl_load with table and mode.
- The file must be uploaded on Integrations first; you can't receive files in chat.
- "Check the participations file as off-core loans": dl_offcore_check. "Load it as off-core loans": dl_offcore_load. Off-core loans are loans the institution holds that its core doesn't carry (participations, purchased pools, partner programs); once loaded they're in every loan figure, tagged by source. "Treat Taxi medallion as Business" goes in types.
- "Show the off-core loans", "loans by source": dl_offcore_status.
- Curated tables from the core can't be loaded into, except off-core loans through dl_offcore_load. SFTP folders and scheduled uploaders aren't built yet; say so.`,
    plan: (text) => {
      const t = text.trim();
      if (/\bsftp\b|\b(?:file|scheduled) uploaders?\b/i.test(t)) return { say: 'Loading from an SFTP folder and scheduled uploaders come next. Today, upload the file under “Upload a data file” on Integrations and I’ll load it.' };
      const file = FILE.exec(t);
      const name = (file?.[1] ?? file?.[2])?.trim();
      // "treat Taxi medallion as Business"
      const types = Object.fromEntries([...t.matchAll(/\btreat ([^,.;]+?) as (?:an? )?([A-Za-z&][\w &]*?)(?=,| and treat|[.;]|$)/gi)].map((m) => [m[1]!.trim(), m[2]!.trim()]));
      const said = { ...(name ? { file: name } : {}), ...(Object.keys(types).length ? { types } : {}) };
      if (/\boff[- ]core\b|\bparticipations? (?:file|spreadsheet|report)\b|\bloans? by source\b|\btreat .+ as /i.test(t)) {
        if (/\b(?:show|which|what|list|how much)\b|\bby source\b/i.test(t) && !/\b(?:load|import|check)\b/i.test(t)) return { tool: 'dl_offcore_status', args: {} };
        if (/\b(?:check|profile|look at|map|preview)\b/i.test(t) && !/\bload\b/i.test(t)) return { tool: 'dl_offcore_check', args: said };
        return { tool: 'dl_offcore_load', args: said };
      }
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
      {
        name: 'dl_offcore_check',
        description: 'Read an uploaded servicer spreadsheet as off-core loans: which column holds each DI loan field, which DI category each loan type becomes, which rows can’t load and why, and the balance it would add. Changes nothing.',
        input: z.object({ file: z.string().max(160).optional(), types: z.record(z.string().max(60), z.string().max(40)).optional() }).strict(),
        run: async (a: { file?: string; types?: Record<string, string> }, ctx) => {
          const { staged, plan } = await offcorePlan(ctx, a.file, a.types);
          return offcoreView(ctx, staged.name, plan, false);
        },
      },
      {
        name: 'dl_offcore_load',
        description: 'Prepare loading an uploaded servicer spreadsheet as off-core loans: they join every DI loan figure, tagged with the spreadsheet as their source, replacing that spreadsheet’s previous month. Returns approval_required (high risk: loan figures change for everyone).',
        input: z.object({ file: z.string().max(160).optional(), types: z.record(z.string().max(60), z.string().max(40)).optional() }).strict(),
        run: async (a: { file?: string; types?: Record<string, string> }, ctx) => {
          const svc = needOffcore(ctx);
          const { staged, plan } = await offcorePlan(ctx, a.file, a.types);
          if (plan.blockers.length) return offcoreView(ctx, staged.name, plan, false);
          const before = await svc.bySource();
          const total = before.reduce((s, x) => s + x.balance, 0);
          const replaced = before.find((x) => x.source === plan.source)?.balance ?? 0;
          const after = total - replaced + plan.balance;
          const dqBefore = before.reduce((s, x) => s + x.delinquent60, 0);
          const dqAfter = dqBefore - (before.find((x) => x.source === plan.source)?.delinquent60 ?? 0) + plan.delinquent60;
          const ratio = (dq: number, bal: number) => (bal ? `${((dq / bal) * 100).toFixed(2)}%` : '—');
          return {
            change: {
              summary: `Add ${plural(plan.rows.length, 'off-core loan')}, ${usd(plan.balance)}, to DI’s loans as “${plan.feed}”`,
              changes: [
                { label: 'Source', before: plan.previous ? `${plan.source}, as of ${plan.previous.asOf}` : '—', after: `${plan.source}, as of ${plan.asOf}` },
                { label: 'Loans', before: plan.previous ? `${n(plan.previous.loans)}, ${usd(plan.previous.balance)}` : '—', after: `${n(plan.rows.length)}, ${usd(plan.balance)}${plan.previous ? ` (${n(plan.previous.added)} new, ${n(plan.previous.gone)} gone since last month)` : ''}` },
                { label: 'By category', before: '—', after: plan.byCategory.map((c) => `${c.category} ${usd(c.balance)}`).join('; ') },
                { label: 'Won’t load', before: '—', after: plan.skipped.length ? plan.skipped.map((x) => `${x.ref}: ${x.why.toLowerCase()}`).join('; ').slice(0, 240) : 'Every row loads' },
                { label: 'Total loan balance', before: usd(total), after: usd(after) },
                { label: 'Delinquency 60+', before: ratio(dqBefore, total), after: ratio(dqAfter, after) },
              ],
              text: `I’ll add **${plural(plan.rows.length, 'loan')}, ${usd(plan.balance)},** from **${staged.name}** to DI’s loans, tagged “${plan.source}”${plan.previous ? `, replacing the ${plan.previous.asOf} load` : ''}. Every loan figure includes them from then on: total loan balance goes from ${usd(total)} to ${usd(after)}, and 60+ delinquency from ${ratio(dqBefore, total)} to ${ratio(dqAfter, after)}. Month-end history isn’t rewritten, so growth against last month-end compares core with core. The Call Report comes from the general ledger and doesn’t change.${plan.skipped.length ? ` ${plural(plan.skipped.length, 'row')} won’t load: ${plan.skipped.map((x) => `${x.ref} (${x.why.toLowerCase()})`).join('; ')}.` : ''}`,
              done: `Added ${plural(plan.rows.length, 'off-core loan')} to DI’s loans.`,
              risk: 'high',
              records: plan.rows.length,
              apply: { file: staged.name, feed: plan.feed, source: plan.source, servicer: plan.servicer, asOf: plan.asOf, rows: plan.rows, skipped: plan.skipped, balance: plan.balance, delinquent60: plan.delinquent60, columns: plan.columns },
              blocks: [offcoreMapping(ctx, plan), offcoreTypes(ctx, plan)],
            },
          };
        },
        apply: async (p: Pick<OffcorePlan, 'file' | 'feed' | 'source' | 'servicer' | 'asOf' | 'rows' | 'skipped' | 'balance' | 'delinquent60' | 'columns'>, meta, ctx) => {
          const svc = needOffcore(ctx);
          const r = await svc.publish(p, { userId: ctx.user.id, name: ctx.user.name }, { approvalId: meta.approvalId });
          clearBriefingCache(); // Home's figures include off-core loans: show the new ones at once.
          const by = await svc.bySource();
          const total = by.reduce((s, x) => s + x.balance, 0);
          return {
            text: `Added **${plural(r.loans, 'off-core loan')}, ${usd(r.balance)},** to DI’s loans as “${r.source}”. Total loan balance is now **${usd(total)}**, of which ${usd(total - (by.find((x) => x.source === 'Core')?.balance ?? 0))} is off-core. Ask for loan balance by source to see it split.`,
            blocks: [sourceTable(ctx, by)],
            suggestions: ['Show loan balance by source', 'What’s our delinquency 60+ by loan category?'],
          };
        },
      },
      {
        name: 'dl_offcore_status',
        description: 'Off-core loans in DI: each servicer spreadsheet, its latest load and as-of date, and loans by source (core and each off-core spreadsheet) with balance and 60+ delinquency.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          const svc = needOffcore(ctx);
          const [feeds, by] = await Promise.all([svc.feeds(), svc.bySource()]);
          const total = by.reduce((s, x) => s + x.balance, 0);
          const off = by.filter((x) => x.source !== 'Core');
          if (!feeds.length) return { text: `No off-core loans are loaded: all ${usd(total)} of DI’s loans come from the core. Upload a servicer’s spreadsheet on Integrations and ask me to load it as off-core loans.`, suggestions: [] };
          return {
            text: `**${usd(off.reduce((s, x) => s + x.balance, 0))}** of DI’s ${usd(total)} in loans is off-core, from ${plural(feeds.length, 'spreadsheet')}: ${feeds.map((f) => `${f.name}, ${plural(f.loans, 'loan')} as of ${f.asOf ?? '—'}, loaded by ${f.loadedBy ?? '—'}`).join('; ')}. Month-end history doesn’t include them, so growth against last month-end compares core with core.`,
            blocks: [sourceTable(ctx, by)],
            suggestions: ['Show loan balance by source'],
          };
        },
      },
    ],
  };
  return spec;
}
