// Core Mapping: Kinective's standard column-to-column mapping for a core, locked, and the columns an
// institution adds itself (a Symitar tracking record, a user-defined field). DI proposes a mapping,
// tries it on the core's real rows and shows what it would bring in; an administrator approves it, and
// it applies from the next pull. A mapping's expression is DI's small read-only language, never SQL:
// DI writes the SQL, so nothing typed reaches the core.
import { z } from 'zod';
import { CoreError, MAP_TARGETS, type ColumnMapRow, type CustomValueType, type MapPreview, type SourceService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec, type ModuleView } from './moduleAgent.ts';

const n = (x: number) => x.toLocaleString('en-US');
const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '0%');
const TARGET_LABEL: Record<string, string> = { members: 'members', deposits: 'deposit accounts', loans: 'loans' };
const TYPES: CustomValueType[] = ['text', 'number', 'date', 'flag'];
const typeName = (t: CustomValueType) => (t === 'flag' ? 'yes or no' : t);
const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });

/** Proposing a whole mapping for a core (Core Mapping and Ontology, phase 2): discover, review, explain. */
export const DISCOVER_REQUEST =
  /\b(?:propose|work out|discover|auto-?map)\b[^.?!]*\bmappings?\b|\bmap (?:our|the|this) (?:new )?(?:core|connection|replica|symitar)(?: connection| replica)?\s*[.?!]?$|\bhow well (?:would|does|can|could) DI map\b|\bwithout (?:its|the|kinective['’]s) (?:standard )?mapping\b|\b(?:proposed|discovered) mappings?\b|\bwhich (?:proposed )?mappings? need(?:s)? (?:me|a person|review|my review)\b|\bwhy (?:did|do|does) (?:you|DI) (?:map|propose|think)\b|\bexplain (?:the )?(?:proposed )?mapping (?:for|of)\b/i;

export const MAPPING_REQUEST =
  /^(?![\s\S]*\b(?:pull|sync|connect|reconnect|test the connection)\b)[\s\S]*?(?:\b(?:column |core |custom |field |symitar )?mappings?\b[^.?!]*\b(?:core|symitar|tracking|fields?|columns?|replica|custom|standard)\b|\b(?:core|symitar|replica|custom|standard) (?:column |field )?mappings?\b|\b(?:custom|tracking) (?:fields?|records?|columns?)\b|\bunmapped\b|\b(?:not|aren['’]?t|isn['’]?t) (?:yet )?mapped\b|\bmap(?:ping)? (?:the |our |a )?(?:tracking|symitar|core|custom|user)\b|\bmap(?:ping)? [A-Z_]+\(|\bmap(?:ping)? (?:a\.|n\.|s\.|l\.)[A-Z])/i;

/** "Map FIRST_OF(...) to email consent as a yes or no on members" → its parts. */
export function mappingFrom(text: string): { expression: string; label: string; type?: CustomValueType; target?: string } | null {
  const m = /\bmap(?:ping)?\s+(.+?)\s+(?:to|as)\s+(?:a |an |the )?["“]?([A-Za-z][\w ’'-]{1,60}?)["”]?(?:\s+(?:as (?:a |an )?(yes or no|yes\/no|flag|text|number|date)))?(?:\s+on\s+(members|deposits|deposit accounts|loans))?\s*[.?!]?$/i.exec(text.trim());
  if (!m || !/[A-Z_]+\(|\b[ansl]\.[A-Z]/.test(m[1]!)) return null;
  const t = m[3]?.toLowerCase();
  const type: CustomValueType | undefined = t === 'yes or no' || t === 'yes/no' || t === 'flag' ? 'flag' : t === 'text' || t === 'number' || t === 'date' ? t : undefined;
  const target = m[4] ? (/^deposit/i.test(m[4]) ? 'deposits' : m[4].toLowerCase()) : undefined;
  return { expression: m[1]!.trim(), label: m[2]!.trim(), ...(type ? { type } : {}), ...(target ? { target } : {}) };
}

export function coreMappingModule(sources: SourceService | null, today: () => string): ModuleSpec {
  const noAccess = 'Core mappings are part of the Integrations administrator’s access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('sources')) throw new CoreError('NO_ACCESS', noAccess);
    if (!sources) throw new CoreError('INVALID', 'Direct core connections aren’t set up in this environment.');
    return sources;
  };
  const previewTable = (who: Pick<ModuleSpec, 'agent' | 'sources'>, runId: string, p: MapPreview) => [
    moduleTable(who, `What it would bring in: ${pct(p.filled, p.total)} of ${TARGET_LABEL[p.target]}`, runId, 'coremap.preview', [text('value', 'Value'), { field: 'count', headerName: TARGET_LABEL[p.target]![0]!.toUpperCase() + TARGET_LABEL[p.target]!.slice(1), type: 'count' }], p.top.map((t) => ({ value: t.value, count: t.count }))),
    moduleTable(who, 'Ten records from the core', runId, 'coremap.sample', [text('key', p.target === 'members' ? 'Account' : 'Record'), text('value', 'Value')], p.sample),
  ];

  const spec: ModuleSpec = {
    id: 'sources',
    prefix: 'map',
    agent: 'Core Mapping',
    request: new RegExp(`${DISCOVER_REQUEST.source}|${MAPPING_REQUEST.source}`, 'i'),
    noAccess,
    sources: [
      { kind: 'table', label: 'Core column mappings', ref: 'table:src_column_map' },
      { kind: 'table', label: 'Custom field values', ref: 'table:cdm_custom_field' },
    ],
    prompt: ({ tenant, user, title }) => `You are the Core Mapping agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) manages how the core's columns map to DI's.

- "Show the Symitar mapping", "which columns are custom?": map_list.
- "What core fields aren't mapped?", "suggest mappings for our tracking records": map_suggest.
- "Map our core connection", "Propose a mapping for the Symitar connection": map_discover, which profiles the core's columns and proposes where each goes in DI, with tie-outs to the 5300. "How well would DI map Symitar without its standard mapping?": map_discover with measure.
- "Which mappings need me?": map_review. "Why did you map LOAN.DUEDATE to days past due?": map_explain with the core column.
- "Try mapping ...": map_preview. "Map ... to email consent": map_add, which previews on real rows and asks for approval. "Remove the email consent mapping": map_remove.
- Kinective's standard columns are locked. Custom mappings go on members, deposits or loans, and apply from the next pull.
- An expression is DI's read-only mapping language, never SQL. Columns go through the mapping's aliases: members a (ACCOUNT) and n (NAME), deposits s (SAVINGS), loans l (LOAN). Functions: IF(c, a, b), COALESCE, TRIM, UPPER, LOWER, ROUND, ABS, LEFT; comparisons, AND, OR, NOT, IS NULL, IN (...). Lookups into another core table, where a bare column belongs to that table: COUNT_OF(LOAN, PARENTACCOUNT = a.ACCOUNTNUMBER AND CLOSEDATE = '00000000'), FIRST_OF(ACCOUNTTRACKING, USERCHAR1, PARENTACCOUNT = a.ACCOUNTNUMBER AND TYPE = 12), SUM_OF(LOAN, BALANCE, PARENTACCOUNT = a.ACCOUNTNUMBER). Symitar dates are YYYYMMDD text, '00000000' when empty.
- A value type is text, number, date (YYYYMMDD) or flag (yes or no: Y, 1 and true are yes).`,
    plan: (t) => {
      const ask = t.trim();
      if (/\b(?:remove|stop|delete|drop)\b[^.?!]*\bmapping\b/i.test(ask)) {
        const label = /\b(?:the |our )?([\w ’'-]{2,60}?) mapping\b/i.exec(ask)?.[1]?.replace(/^(?:remove|stop|delete|drop) (?:the |our )?/i, '').trim();
        return { tool: 'map_remove', args: label ? { label } : {} };
      }
      const parts = mappingFrom(ask);
      if (parts) return { tool: /\b(?:try|preview|test|what would)\b/i.test(ask) ? 'map_preview' : 'map_add', args: { target: parts.target ?? 'members', label: parts.label, expression: parts.expression, type: parts.type ?? 'text' } };
      if (DISCOVER_REQUEST.test(ask)) {
        if (/\bwhy\b|\bexplain\b/i.test(ask)) {
          const column = /\b([A-Z][A-Z0-9_]+\.[A-Z][A-Z0-9_]+)\b/.exec(ask)?.[1] ?? /\b([A-Z][A-Z0-9_]{3,})\b/.exec(ask.replace(/^\w+/, ''))?.[1];
          return column ? { tool: 'map_explain', args: { column } } : { say: 'Which core column? For example, LOAN.DUEDATE.' };
        }
        if (/\bneed(?:s)? (?:me|a person|review|my review)\b|\breview\b/i.test(ask)) return { tool: 'map_review', args: {} };
        return { tool: 'map_discover', args: /\bhow well\b|\bwithout\b|\bmeasure\b/i.test(ask) ? { measure: true } : {} };
      }
      if (/\bsuggest|\bunmapped\b|\b(?:not|aren['’]?t|isn['’]?t) (?:yet )?mapped\b|\bwhat else\b|\btracking records?\b|\bcustom fields? (?:could|can|should)\b/i.test(ask)) return { tool: 'map_suggest', args: {} };
      return { tool: 'map_list', args: /\bcustom\b/i.test(ask) ? { custom_only: true } : {} };
    },
    tools: [
      {
        name: 'map_list',
        description: 'The core column mapping: Kinective’s standard columns (locked) and the institution’s custom ones, with what each brought in on the last pull. custom_only for the custom ones.',
        input: z.object({ custom_only: z.boolean().optional() }).strict(),
        run: async (a: { custom_only?: boolean }, ctx): Promise<ModuleView> => {
          const s = need(ctx);
          const all = await s.columnMaps();
          const custom = all.filter((r) => r.origin === 'Custom');
          const shown = a.custom_only ? custom : all;
          const row = (r: ColumnMapRow) => ({ target: TARGET_LABEL[r.target] ?? r.target, field: r.origin === 'Custom' ? r.label : r.field, source: r.source, how: r.origin === 'Custom' ? typeName(r.valueType ?? 'text') : r.how, origin: r.locked ? 'Kinective, locked' : `Custom, ${r.addedBy ?? ''}`, filled: r.origin === 'Custom' ? n(r.filled ?? 0) : '—' });
          return {
            text: `The Symitar mapping has **${n(all.length - custom.length)} standard columns** from Kinective, locked, and **${n(custom.length)} custom ${custom.length === 1 ? 'column' : 'columns'}** this institution added.${custom.length ? ` ${custom.map((c) => `${c.label} (${n(c.filled ?? 0)} ${TARGET_LABEL[c.target]} after the last pull)`).join('; ')}.` : ' Ask me which core fields aren’t mapped yet, and I’ll suggest some.'}`,
            blocks: [moduleTable(spec, a.custom_only ? 'Custom column mappings' : 'Core column mapping', ctx.runId, 'coremap.list', [text('target', 'In DI'), text('field', 'DI column'), text('source', 'From the core'), text('how', 'As'), text('origin', 'Mapped by'), text('filled', 'Records with a value')], shown.map(row))],
            suggestions: ['What core fields aren’t mapped yet?', 'Pull from the Symitar replica now'],
          };
        },
      },
      {
        name: 'map_suggest',
        description: 'Core fields Kinective’s standard mapping doesn’t read, such as Symitar tracking records, with a proposed mapping for each and how many records have a value. Reads the core; changes nothing.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx): Promise<ModuleView> => {
          const s = need(ctx);
          const list = await s.suggestColumnMaps();
          if (!list.length) return { text: 'Every tracking field with values is already mapped. Ask me to map another core column with an expression if you need one.', suggestions: ['Show the Symitar mapping'] };
          const top = list.slice(0, 3);
          return {
            text: `The core has **${n(list.length)} tracking ${list.length === 1 ? 'field' : 'fields'}** with values that Kinective’s standard mapping doesn’t read. ${top.map((x) => `${x.label}: ${n(x.filled)} members, values such as ${x.samples.slice(0, 3).map((v) => `“${v}”`).join(', ')}`).join('; ')}. Tell me what each one means, and I’ll map it: for example “Map ${top[0]!.expression} to email consent as a yes or no”.`,
            blocks: [moduleTable(spec, 'Core fields not mapped yet', ctx.runId, 'coremap.suggest', [text('label', 'Field'), { field: 'filled', headerName: 'Members with a value', type: 'count' }, text('samples', 'Values'), text('type', 'Looks like'), text('expression', 'Proposed mapping')], list.map((x) => ({ label: x.label, filled: x.filled, samples: x.samples.join(', '), type: typeName(x.valueType), expression: x.expression })))],
            suggestions: ['Show the Symitar mapping'],
          };
        },
      },
      {
        name: 'map_preview',
        description: 'Try a custom mapping on the core’s real rows without saving it: how many records get a value, the commonest values and ten records. target members, deposits or loans; expression in DI’s mapping language; type text, number, date or flag.',
        input: z.object({ target: z.enum(['members', 'deposits', 'loans']), label: z.string().min(2).max(60), expression: z.string().min(3).max(400), type: z.enum(['text', 'number', 'date', 'flag']) }).strict(),
        run: async (a: { target: string; label: string; expression: string; type: CustomValueType }, ctx): Promise<ModuleView> => {
          const s = need(ctx);
          const p = await s.previewMap({ target: a.target, expression: a.expression, valueType: a.type });
          return {
            text: `Mapped as **${a.label}** (${typeName(a.type)}), this gives **${n(p.filled)} of ${n(p.total)} ${TARGET_LABEL[a.target]}** a value (${pct(p.filled, p.total)}), ${n(p.distinct)} different ${p.distinct === 1 ? 'value' : 'values'}${p.top[0] ? `, most often “${p.top[0].value}”` : ''}. Nothing is saved; ask me to map it to add it.`,
            blocks: previewTable(spec, ctx.runId, p),
            suggestions: [`Map ${a.expression} to ${a.label} as ${a.type === 'flag' ? 'a yes or no' : a.type}${a.target !== 'members' ? ` on ${a.target}` : ''}`],
          };
        },
      },
      {
        name: 'map_add',
        description: 'Prepare adding a custom column mapping: DI checks the expression, tries it on the core’s real rows, and on approval adds it from the next pull. A field of the same name is replaced; Kinective’s standard columns can’t be. Returns approval_required.',
        input: z.object({ target: z.enum(['members', 'deposits', 'loans']), label: z.string().min(2).max(60), expression: z.string().min(3).max(400), type: z.enum(['text', 'number', 'date', 'flag']), note: z.string().max(200).optional() }).strict(),
        run: async (a: { target: string; label: string; expression: string; type: CustomValueType; note?: string }, ctx) => {
          const s = need(ctx);
          if (!TYPES.includes(a.type) || !MAP_TARGETS[a.target]) throw new CoreError('INVALID', 'A custom field goes on members, deposits or loans, as text, a number, a date or a yes or no.');
          const p = await s.previewMap({ target: a.target, expression: a.expression, valueType: a.type });
          if (!p.filled) throw new CoreError('INVALID', `That expression gives no ${TARGET_LABEL[a.target]} a value, so I won’t add it. Try it with a preview and check the core’s codes.`);
          const existing = (await s.columnMaps()).find((r) => r.origin === 'Custom' && r.target === a.target && r.label.toLowerCase() === a.label.toLowerCase());
          return {
            change: {
              summary: `${existing ? 'Replace' : 'Add'} the custom mapping “${a.label}” on ${TARGET_LABEL[a.target]}`,
              changes: [
                { label: 'DI field', before: existing ? existing.label : '—', after: `${a.label} (${typeName(a.type)}), on ${TARGET_LABEL[a.target]}` },
                { label: 'From the core', before: existing ? existing.source : '—', after: p.expression },
                { label: 'Coverage', before: existing ? `${n(existing.filled ?? 0)} records` : '—', after: `${n(p.filled)} of ${n(p.total)} ${TARGET_LABEL[a.target]} (${pct(p.filled, p.total)})` },
                { label: 'Commonest values', before: '—', after: p.top.slice(0, 4).map((t) => `${t.value} (${n(t.count)})`).join(', ') || '—' },
                { label: 'Takes effect', before: '—', after: 'From the next pull from the core' },
              ],
              text: `I tried it on the core: **${n(p.filled)} of ${n(p.total)} ${TARGET_LABEL[a.target]}** get a value, most often “${p.top[0]?.value ?? '—'}”. Once you approve, DI reads it on every pull from the core, starting with the next. Kinective’s standard columns aren’t touched.`,
              done: `Added the custom mapping **${a.label}**.`,
              risk: 'medium',
              records: p.filled,
              apply: { target: a.target, label: a.label, expression: p.expression, valueType: a.type, ...(a.note ? { note: a.note } : {}) },
            },
            blocks: previewTable(spec, ctx.runId, p),
          };
        },
        apply: async (p: { target: string; label: string; expression: string; valueType: CustomValueType; note?: string }, meta, ctx): Promise<ModuleView> => {
          const s = need(ctx);
          const r = await s.addColumnMap(p, { userId: ctx.user.id, name: ctx.user.name }, { approvalId: meta.approvalId, on: today() });
          return { text: `Added **${p.label}** as a custom mapping on ${TARGET_LABEL[p.target]} (field ${r.field}). It’s read on every pull from the core, from the next one. Pull now to bring its values in.`, suggestions: ['Pull from the Symitar replica now', 'Show the custom mappings'] };
        },
      },
      {
        name: 'map_remove',
        description: 'Prepare removing a custom column mapping by its name; the values it brought in are cleared. Kinective’s standard columns can’t be removed. Returns approval_required.',
        input: z.object({ label: z.string().min(2).max(60).optional() }).strict(),
        run: async (a: { label?: string }, ctx) => {
          const s = need(ctx);
          const custom = (await s.columnMaps()).filter((r) => r.origin === 'Custom');
          if (!a.label) throw new CoreError('INVALID', custom.length ? `Which mapping? The custom ones are ${custom.map((c) => c.label).join(', ')}.` : 'There are no custom mappings to remove.');
          const target = custom.find((c) => c.label.toLowerCase() === a.label!.toLowerCase());
          if (!target) {
            const standard = (await s.columnMaps()).find((r) => r.origin === 'Kinective' && r.field === a.label!.toLowerCase());
            throw new CoreError('INVALID', standard ? `${standard.field} is one of Kinective’s standard columns, which can’t be removed.` : `There’s no custom mapping called ${a.label}.${custom.length ? ` The custom ones are ${custom.map((c) => c.label).join(', ')}.` : ''}`);
          }
          return {
            change: {
              summary: `Remove the custom mapping “${target.label}”`,
              changes: [
                { label: 'DI field', before: `${target.label}, on ${TARGET_LABEL[target.target]}`, after: 'Removed' },
                { label: 'Values in DI', before: `${n(target.filled ?? 0)} records`, after: 'Cleared' },
              ],
              text: `I’ll stop reading **${target.label}** from the core and clear the ${n(target.filled ?? 0)} values it brought in.`,
              done: `Removed the custom mapping **${target.label}**.`,
              risk: 'medium',
              records: target.filled ?? 0,
              apply: { mapId: target.mapId, label: target.label },
            },
          };
        },
        apply: async (p: { mapId: number; label: string }, _meta, ctx): Promise<ModuleView> => {
          const s = need(ctx);
          await s.removeColumnMap(p.mapId);
          return { text: `Removed **${p.label}**; its values are cleared and the next pull won’t read it.`, suggestions: ['Show the custom mappings'] };
        },
      },
    ],
  };
  spec.tools.push(...discoverTools(spec, need));
  return spec;
}

// ---- proposing a whole mapping (phase 2) ----------------------------------------------------------

const BAND_WORD: Record<string, string> = { standard: 'Kinective’s standard', auto: 'Ready to approve', review: 'Review', person: 'Needs you' };
const TABLE_WORD: Record<string, string> = { cdm_party: 'members', cdm_deposit_account: 'shares and deposits', cdm_loan: 'loans' };
const TRANSFORM_WORD: Record<string, string> = { same: 'as is', number: 'number', date8: 'YYYYMMDD date', code: 'code list', rate1000: 'thousandths of a percent', daysPast: 'days past the due date', not: 'reversed yes or no', nonzero: 'yes when not zero' };
const usd = (x: number) => (Math.abs(x) >= 1e9 ? `$${(x / 1e9).toFixed(3)}B` : Math.abs(x) >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : n(Math.round(x)));
const tieWord = (t: { property: string; core: number; reported: number; code: string; pass: boolean }) =>
  `${t.property === 'member.id' ? `${n(t.core)} members` : usd(t.core)} against line ${t.code}’s ${t.property === 'member.id' ? n(t.reported) : usd(t.reported)}${t.pass ? '' : ', which doesn’t tie out'}`;

function discoverTools(spec: ModuleSpec, need: (ctx: ModuleContext) => SourceService) {
  const proposalCols = [text('di', 'DI column'), text('label', 'Meaning'), text('core', 'From the core'), text('as', 'As'), text('score', 'Score'), text('band', 'Band'), text('why', 'Why')];
  return [
    {
      name: 'map_discover',
      description: 'Propose where each of the core’s columns goes in DI: profiles every column (read-only), lines core tables up with DI’s members, shares and loans, scores each pair on its name, its values, its place in the tables, Kinective’s mapping where there is one, and tie-outs to the 5300, and sorts the proposals into bands. measure: leave Kinective’s mapping out and report how many columns the proposals get right against it. Changes no mapping and no pull.',
      input: z.object({ measure: z.boolean().optional() }).strict(),
      run: async (a: { measure?: boolean }, ctx: ModuleContext): Promise<ModuleView> => {
        const s = need(ctx);
        const r = await s.discover({ hideStandard: !!a.measure, runBy: ctx.user.id });
        const lined = [...r.tableOf].map(([core, di]) => {
          const joined = [...r.owner].filter(([t, o]) => o === core && t !== core).map(([t]) => t);
          return `${core}${joined.length ? ` (with ${joined.join(', ')})` : ''} to ${TABLE_WORD[di] ?? di}`;
        });
        const b = r.bands;
        const counts = b.standard === r.proposals.length ? `all ${b.standard} are Kinective’s standard mapping` : [b.standard ? `${b.standard} Kinective’s standard` : '', b.auto ? `${b.auto} ready to approve` : '', b.review ? `${b.review} to review` : '', b.person ? `${b.person} that need you` : ''].filter(Boolean).join(', ');
        const tieName = (prop: string) => (prop === 'loan.balance' ? 'loans' : prop === 'deposit.balance' ? 'shares' : 'members');
        const ties = r.ties.filter((t) => t.pass || r.ties.filter((x) => x.property === t.property).length === 1);
        const head = a.measure && r.comparison
          ? `With Kinective’s ${r.connection.system.short} mapping left out, DI’s proposals match it on **${r.comparison.right} of ${r.comparison.total} columns**, and read ${r.comparison.transformsRight} of them the same way (dates, rates, codes).`
          : `I profiled **${n(r.profiled)} columns** in ${r.tables.filter((t) => t.rows).length} ${r.connection.system.short} tables and proposed **${r.proposals.length} mappings**: ${counts}.`;
        const body = [
          head,
          lined.length ? `The tables line up as ${lined.join('; ')}.` : '',
          ties.length ? `Tie-outs to the 5300: ${ties.map((t) => (t.property === 'member.id' ? tieWord(t) : `${tieName(t.property)} ${tieWord(t)}`)).join('; ')}.` : '',
          a.measure && r.comparison?.rows.some((x) => !x.right) ? `Missed: ${r.comparison.rows.filter((x) => !x.right).map((x) => `${x.di} (expected ${x.expected}, proposed ${x.proposed ?? 'nothing'})`).join('; ')}.` : '',
          !a.measure && r.unmatched.length ? `${n(r.unmatched.length)} columns with values fit no DI column, such as ${r.unmatched.slice(0, 3).join(', ')}; ask which core fields aren’t mapped to make custom fields of them.` : '',
          'Nothing changes until a mapping is approved.',
        ].filter(Boolean);
        const rows = r.proposals.map((p) => ({ di: `${p.diTable}.${p.diColumn}`, label: p.label, core: `${p.coreTable}.${p.coreColumn}`, as: TRANSFORM_WORD[p.transform] ?? p.transform, score: p.score.toFixed(2), band: BAND_WORD[p.band] ?? p.band, why: p.why.join('; ') }));
        return {
          text: body.join(' '),
          blocks: [
            moduleTable(spec, a.measure ? `Proposals against Kinective’s mapping (run ${r.runId})` : `Proposed mapping (run ${r.runId})`, ctx.runId, 'coremap.discover', proposalCols, rows),
            ...(r.ties.length ? [moduleTable(spec, 'Tie-outs to the 5300', ctx.runId, 'coremap.tieout', [text('what', 'Total'), text('column', 'Core column'), text('core', 'In the core'), text('reported', 'On the 5300'), text('result', 'Result')], r.ties.map((t) => ({ what: t.property === 'loan.balance' ? 'Loans' : t.property === 'deposit.balance' ? 'Shares and deposits' : 'Members', column: t.column, core: t.property === 'member.id' ? n(t.core) : usd(t.core), reported: `${t.property === 'member.id' ? n(t.reported) : usd(t.reported)} (line ${t.code})`, result: t.pass ? 'Ties out' : 'Doesn’t tie out' })))] : []),
          ],
          suggestions: ['Which mappings need me?', ...(r.proposals.find((p) => p.band === 'person') ? [`Why did you map ${r.proposals.find((p) => p.band === 'person')!.coreTable}.${r.proposals.find((p) => p.band === 'person')!.coreColumn}?`] : [])],
        };
      },
    },
    {
      name: 'map_review',
      description: 'The latest proposed mapping’s proposals that need a person: those to review and those where two candidates are too close to call, each with a question about what the column means, from its values.',
      input: z.object({}).strict(),
      run: async (_: unknown, ctx: ModuleContext): Promise<ModuleView> => {
        const s = need(ctx);
        const run = await s.mapRun();
        if (!run) return { text: 'No mapping has been proposed yet. Ask me to map the core connection first.', suggestions: ['Map our core connection'] };
        const open = run.proposals.filter((p) => p.band === 'person' || p.band === 'review').sort((a, b) => (a.band === b.band ? a.score - b.score : a.band === 'person' ? -1 : 1));
        if (!open.length) return { text: `Nothing from run ${run.runId} needs you: every proposal is Kinective’s standard or ready to approve.` };
        const prof = new Map(run.profiles.map((p) => [p.core, p]));
        const question = (p: (typeof open)[number]) => {
          const pr = prof.get(p.core);
          const codes = pr?.top.length && p.transform === 'code' ? ` Its ${n(pr.distinct)} codes: ${pr.top.slice(0, 5).map((t) => `${t.value} (${n(t.count)})`).join(', ')}. Which ${p.label.toLowerCase()} is each code?` : '';
          // The close call: another core column for this DI column, or another DI column for this core column.
          const rival = p.band === 'person' && p.runnerUp ? (p.runnerUp.coreColumn === p.core ? ` It could also be ${p.runnerUp.diColumn} (${p.runnerUp.score.toFixed(2)} against ${p.score.toFixed(2)}).` : ` ${p.runnerUp.coreColumn} fits it almost as well (${p.runnerUp.score.toFixed(2)} against ${p.score.toFixed(2)}).`) : '';
          return `Is ${p.core} the ${p.label.toLowerCase()}?${rival}${codes}`;
        };
        const people = open.filter((p) => p.band === 'person');
        return {
          text: `From run ${run.runId}, **${people.length} ${people.length === 1 ? 'proposal needs' : 'proposals need'} you** and ${open.length - people.length} are to review. ${people.slice(0, 3).map(question).join(' ')}`,
          blocks: [moduleTable(spec, `Proposals to decide (run ${run.runId})`, ctx.runId, 'coremap.review', [text('band', 'Band'), text('di', 'DI column'), text('core', 'From the core'), text('score', 'Score'), text('question', 'Question')], open.map((p) => ({ band: BAND_WORD[p.band] ?? p.band, di: p.di, core: p.core, score: p.score.toFixed(2), question: question(p) })))],
          suggestions: people[0] ? [`Why did you map ${people[0].core}?`] : [],
        };
      },
    },
    {
      name: 'map_explain',
      description: 'Why the latest proposed mapping put a core column where it did: its profile, the five signals and the runner-up. column: TABLE.COLUMN or COLUMN.',
      input: z.object({ column: z.string().min(2).max(130) }).strict(),
      run: async (a: { column: string }, ctx: ModuleContext): Promise<ModuleView> => {
        const s = need(ctx);
        const run = await s.mapRun();
        if (!run) return { text: 'No mapping has been proposed yet. Ask me to map the core connection first.', suggestions: ['Map our core connection'] };
        const want = a.column.toUpperCase();
        const match = (core: string) => core.toUpperCase() === want || core.toUpperCase().endsWith(`.${want}`);
        const p = run.proposals.find((x) => match(x.core));
        const pr = run.profiles.find((x) => match(x.core));
        if (!pr) return { text: `${a.column} isn’t among the ${n(run.profiled)} columns run ${run.runId} profiled.` };
        const sample = run.summary.sample ?? pr.rows;
        const seen = pr.rows > sample ? `In a sample of ${n(sample)} of its ${n(pr.rows)} rows, ${pr.core} has a value on ${n(pr.filled)}` : `${pr.core} has a value on ${n(pr.filled)} of ${n(pr.rows)} rows`;
        const what = `${seen}, ${n(pr.distinct)} different values${pr.min !== null ? ` from ${pr.min} to ${pr.max}` : ''}; DI reads it as ${pr.kind === 'rate1000' ? 'rates in thousandths of a percent' : pr.kind}${pr.refersTo ? `, pointing at ${pr.refersTo}` : ''}.`;
        if (!p) return { text: `${what} It fits no DI column well enough to propose, so it’s a candidate for a custom field.`, suggestions: ['What core fields aren’t mapped yet?'] };
        const sig = p.signals;
        const parts = [`**${p.core} → ${p.di}** (${p.label}), score ${p.score.toFixed(2)}, ${BAND_WORD[p.band]?.toLowerCase() ?? p.band}.`, what, p.signals.why.length ? `Because ${p.signals.why.length > 1 ? `${p.signals.why.slice(0, -1).join(', ')} and ${p.signals.why[p.signals.why.length - 1]}` : p.signals.why[0]}.` : '', p.runnerUp ? `Runner-up: ${p.runnerUp.coreColumn} → ${p.runnerUp.diColumn} at ${p.runnerUp.score.toFixed(2)}.` : ''];
        const show = (x: number | null) => (x === null ? 'not used' : x.toFixed(2));
        return {
          text: parts.filter(Boolean).join(' '),
          blocks: [moduleTable(spec, `Signals for ${p.core}`, ctx.runId, 'coremap.explain', [text('signal', 'Signal'), text('weight', 'Weight'), text('value', 'Score')], [
            { signal: 'Name and description', weight: '35%', value: show(sig.vocabulary) },
            { signal: 'What the values look like', weight: '30%', value: show(sig.values) },
            { signal: 'Place in the tables', weight: '15%', value: show(sig.structure) },
            { signal: 'Kinective’s mapping', weight: '10%', value: show(sig.precedent) },
            { signal: 'Tie-out to the 5300', weight: '10%', value: show(sig.tieOut) },
          ])],
        };
      },
    },
  ];
}
