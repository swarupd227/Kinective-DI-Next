// Data Sources (spec 14.5 DB connections and remote databases, 14.6 Sync in Remote Data): a direct,
// read-only connection to the institution's core replica, in place of the nightly extract file.
// The person enters the login on Integrations; DI Core keeps the password and the agent only ever
// sees its number. DI tests it and proves it can't write, proposes Kinective's mapping for that core,
// connects and pulls on approval, reconciles every row against what DI has, and switches the build
// to the replica only when asked. The core is never written to.
import { z } from 'zod';
import { CoreError, describeTransform, type ConnectionTest, type PullResult, type SourceService } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec, type ModuleView } from './moduleAgent.ts';

const n = (x: number) => x.toLocaleString('en-US');
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const when = (at: string) => `${day(at)} at ${at.slice(11, 16)} UTC`;
/** "members, deposit accounts and loan accounts" */
const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const DETAILS = /\bconnection details #?(\d+)\b/i;
const SCHEDULE = /\b(?:nightly|every night|daily)(?: at)? (\d{1,2})(?::(\d{2}))? ?(am|pm)\b/i;
const DEFAULT_SCHEDULE = 'Nightly at 2:00 am';
const SOURCE_BEFORE = 'Core extract file';

/** "nightly at 1:30 am" from a request, as DI writes it. */
export function scheduleFrom(text: string) {
  const m = SCHEDULE.exec(text);
  if (!m) return undefined;
  const h = Number(m[1]);
  if (h < 1 || h > 12) return undefined;
  return `Nightly at ${h}:${m[2] ?? '00'} ${m[3]!.toLowerCase()}`;
}

export function sourcesModule(sources: SourceService | null, today: () => string): ModuleSpec {
  const noAccess = 'Connecting DI to a core system is part of the Integrations administrator’s access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('sources')) throw new CoreError('NO_ACCESS', noAccess);
    if (!sources) throw new CoreError('INVALID', 'Direct core connections aren’t set up in this environment.');
    return sources;
  };
  /** The connection details named, or the ones this person saved last. */
  const details = async (ctx: ModuleContext, id?: number) => {
    const s = need(ctx);
    if (id) return id;
    const last = await s.latestLogin(ctx.user.id);
    if (!last) throw new CoreError('NOT_FOUND', 'There are no connection details saved by you yet. Enter the replica’s host, database and read-only login under “Connect a source” on Integrations; I can’t take passwords in chat.');
    return last;
  };

  const spec: ModuleSpec = {
    id: 'sources',
    prefix: 'src',
    agent: 'Data Sources',
    request:
      /\bconnection details #?\d+|\b(?:connect|hook up|link|test)\b[^.?!]*\b(?:core|replica|symitar|dna|keystone|premier|database)\b|\b(?:pull|sync)\b[^.?!]*\b(?:core|replica|symitar|connection|source)\b|\b(?:core|replica|symitar) (?:connections?|syncs?|pulls?)\b|\blast pull\b|\brows? that differ\b|\breconcil\w*\b|\b(?:use|stop using|switch)\b[^.?!]*\b(?:replica|symitar)\b|\bdirect (?:core |database )?connections?\b/i,
    noAccess,
    sources: [
      { kind: 'table', label: 'Core connections', ref: 'table:src_connection' },
      { kind: 'table', label: 'Sync runs', ref: 'table:src_sync_run' },
    ],
    prompt: ({ tenant, user, title }) => `You are the Data Sources agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) connects DI directly to the institution's core replica, instead of the nightly extract file.

- "Test the connection (connection details #3)": src_test. "Connect it", "connect the Symitar replica": src_connect.
- "Pull from the replica now": src_pull. "How did the last pull go?", "show the rows that differ": src_status (differences true for rows that differ).
- "Use the Symitar replica for the next build": src_use. "Stop using it": src_use with stop true.
- Connection details are a number; the person enters the host and the password on Integrations. Never ask for a password in chat.
- DI only reads from a core. A login that can write is refused.`,
    plan: (text) => {
      const t = text.trim();
      const id = DETAILS.exec(t)?.[1];
      const conn = /\b(?:the )?([A-Z][\w-]*(?: [A-Z][\w-]*)* replica)\b/.exec(t)?.[1];
      const ref = conn ? { connection: conn } : {};
      if (/\bstop using\b/i.test(t)) return { tool: 'src_use', args: { ...ref, stop: true } };
      if (/\b(?:use|switch)\b[^.?!]*\b(?:for|to)\b[^.?!]*\b(?:build|builds)\b|\bswitch the build\b/i.test(t)) return { tool: 'src_use', args: ref };
      if (/\brows? that differ\b|\bdifferences?\b|\bwhich rows\b/i.test(t)) return { tool: 'src_status', args: { ...ref, differences: true } };
      if (/\blast pull\b|\bhow did\b|\bstatus\b|\bhealthy\b/i.test(t)) return { tool: 'src_status', args: ref };
      if (/\b(?:pull|sync)\b[^.?!]*\bnow\b|\bpull (?:from|again)\b|\bsync (?:from|again)\b/i.test(t)) return { tool: 'src_pull', args: ref };
      if (/\btest\b/i.test(t) && !/\bconnect (?:it|the)\b/i.test(t)) return { tool: 'src_test', args: id ? { details: Number(id) } : {} };
      if (/\bconnect\b/i.test(t)) {
        const named = /\b(?:as|call it|called) (?:the )?([\w -]{2,60}?)(?:,|\.|$| pulling| and)/i.exec(t)?.[1]?.trim();
        return { tool: 'src_connect', args: { ...(id ? { details: Number(id) } : {}), ...(named ? { name: named } : {}), ...(scheduleFrom(t) ? { schedule: scheduleFrom(t) } : {}) } };
      }
      return { tool: 'src_status', args: ref };
    },
    tools: [
      {
        name: 'src_test',
        description: 'Connect with saved connection details, check the login is read-only, list the core tables it can see and check Kinective’s ready-made mapping for that core. Changes nothing.',
        input: z.object({ details: z.number().int().positive().optional() }).strict(),
        run: async (a: { details?: number }, ctx) => testView(spec, ctx, await need(ctx).test(await details(ctx, a.details), ctx.user.id)),
      },
      {
        name: 'src_connect',
        description: 'Prepare connecting DI to the core replica with saved connection details: record the connection, its table mappings and nightly schedule, then pull and reconcile once. Returns approval_required.',
        input: z.object({ details: z.number().int().positive().optional(), name: z.string().min(2).max(60).optional(), schedule: z.string().max(40).optional() }).strict(),
        run: async (a: { details?: number; name?: string; schedule?: string }, ctx) => {
          const s = need(ctx);
          const id = await details(ctx, a.details);
          const t = await s.test(id, ctx.user.id);
          if (!t.readOnly) throw new CoreError('INVALID', `I won’t connect with ${t.login.login}: it can change data in the core (${t.writeGrants.join('; ')}). DI connects to a core only with a login that can read and nothing else. Ask the core’s administrator for one, and enter it on Integrations.`);
          if (!t.mappings) throw new CoreError('INVALID', `There’s no ready-made mapping for ${t.login.system.label} yet, so I can’t connect its tables on my own. Kinective maps a new core during onboarding; these connection details are saved for that.`);
          const ready = t.mappings.filter((m) => !m.missing.length);
          if (!ready.length) throw new CoreError('INVALID', `The login can’t see the columns the ${t.login.system.short} mapping needs: ${t.mappings.flatMap((m) => m.missing).slice(0, 6).join(', ')}. Ask the core’s administrator to grant it read access to them.`);
          const name = (a.name ?? `${t.login.system.short} replica`).trim();
          const existing = (await s.connections()).find((c) => c.name.toLowerCase() === name.toLowerCase());
          if (existing) throw new CoreError('INVALID', `There’s already a connection called ${existing.name}. Ask me to pull from it, or give this one another name.`);
          const schedule = a.schedule ? (scheduleFrom(a.schedule) ?? DEFAULT_SCHEDULE) : DEFAULT_SCHEDULE;
          const total = ready.reduce((x, m) => x + m.rows, 0);
          const skipped = t.mappings.filter((m) => m.missing.length);
          return {
            change: {
              summary: `Connect the ${name} and pull it ${schedule.toLowerCase()}`,
              changes: [
                { label: 'Connection', before: '—', after: `${name} (new)` },
                { label: 'Core', before: '—', after: `${t.login.system.label}: ${t.login.database} on ${t.login.host}` },
                { label: 'Login', before: '—', after: `${t.login.login}, read-only` },
                { label: 'Tables', before: '—', after: ready.map((m) => `${m.map.label} from ${m.map.theirTables.join(' + ')}`).join('; ') },
                { label: 'Schedule', before: '—', after: schedule },
                { label: 'First pull', before: '—', after: `${n(total)} rows, right after you approve, into DI’s landing tables` },
              ],
              text: `I’ll connect DI to the **${name}** and pull its ${plural(ready.length, 'mapped table')}, ${n(total)} rows, into DI’s landing tables. Then I’ll check every row against what DI has now.${skipped.length ? ` ${skipped.map((m) => m.map.label).join(' and ')} can’t be mapped with this login, so ${skipped.length === 1 ? 'it stays' : 'they stay'} on the extract file.` : ''} Nothing is ever written to the core, and DI’s figures don’t change until you switch the build to this source.`,
              done: `Connected the **${name}**.`,
              risk: 'medium',
              records: total,
              apply: { credentialId: id, name, schedule, tables: ready.map((m) => m.map.diTable) },
            },
          };
        },
        apply: async (p: { credentialId: number; name: string; schedule: string; tables: string[] }, meta, ctx) => {
          const s = need(ctx);
          const connectionId = await s.create(p, { userId: ctx.user.id, name: ctx.user.name }, { approvalId: meta.approvalId, on: today() });
          const result = await s.pull(connectionId, { approvalId: meta.approvalId });
          return pullView(spec, ctx, result, `Connected the **${p.name}**, to pull ${p.schedule.toLowerCase()}. `);
        },
      },
      {
        name: 'src_pull',
        description: 'Prepare pulling every mapped table from a core connection now, then reconciling it against DI. Returns approval_required.',
        input: z.object({ connection: z.string().max(80).optional() }).strict(),
        run: async (a: { connection?: string }, ctx) => {
          const c = await need(ctx).connection(a.connection);
          return {
            change: {
              summary: `Pull from the ${c.name} now`,
              changes: [
                { label: 'Connection', before: c.name, after: c.name },
                { label: 'Tables', before: '—', after: list(c.tables.map((t) => t.label)) },
                { label: 'Landing tables', before: c.lastRun ? `Pulled ${when(c.lastRun.at)}` : 'Empty', after: 'Replaced with what the core has now' },
              ],
              text: `I’ll pull ${list(c.tables.map((t) => t.label.toLowerCase()))} from the **${c.name}** now and check them against DI. Only DI’s landing tables change; the core and DI’s figures don’t.`,
              done: `Pulled from the **${c.name}**.`,
              risk: 'low',
              apply: { connectionId: c.connectionId },
            },
          };
        },
        apply: async (p: { connectionId: number }, meta, ctx) => pullView(spec, ctx, await need(ctx).pull(p.connectionId, { approvalId: meta.approvalId }), ''),
      },
      {
        name: 'src_status',
        description: 'A core connection: what it reads, its schedule, whether builds use it, and its last pull’s reconciliation. With differences, the rows whose values differ from DI.',
        input: z.object({ connection: z.string().max(80).optional(), differences: z.boolean().optional() }).strict(),
        run: async (a: { connection?: string; differences?: boolean }, ctx) => {
          const s = need(ctx);
          const c = await s.connection(a.connection);
          const last = await s.lastPull(c.connectionId);
          const about = `The **${c.name}** reads ${list(c.tables.map((t) => `${t.label.toLowerCase()} from ${t.theirTables.join(' + ')}`))} with the read-only login ${c.login}, ${c.schedule.toLowerCase()}. ${c.inUse ? `Builds read it in place of the core extract file from the first build after ${day(c.inUseSince!)}.` : 'Builds still use the core extract file.'}`;
          if (!last) return { text: `${about} It hasn’t pulled yet.`, suggestions: [`Pull from the ${c.name} now`] };
          if (a.differences) {
            const d = last.differences;
            return {
              text: d.length ? `${about} In the last pull, ${when(last.at)}, these rows differ from DI. The build will take the core’s values once it uses this source.` : `${about} In the last pull, ${when(last.at)}, every row matched DI.`,
              blocks: d.length ? [differenceTable(spec, ctx, last)] : [],
              suggestions: c.inUse ? [] : [`Use the ${c.name} for the next build`],
            };
          }
          return pullView(spec, ctx, last, `${about} `, false);
        },
      },
      {
        name: 'src_use',
        description: 'Prepare making a core connection the source of members, deposits and loans from the next build on, in place of the core extract file; or, with stop, going back to the file. Returns approval_required.',
        input: z.object({ connection: z.string().max(80).optional(), stop: z.boolean().optional() }).strict(),
        run: async (a: { connection?: string; stop?: boolean }, ctx) => {
          const s = need(ctx);
          const c = await s.connection(a.connection);
          const tables = list(c.tables.map((t) => t.label));
          if (a.stop) {
            if (!c.inUse) throw new CoreError('INVALID', `Builds don’t use the ${c.name}; they already read the core extract file.`);
            return {
              change: {
                summary: `Go back to the core extract file for ${tables.toLowerCase()}`,
                changes: c.tables.map((t) => ({ label: t.label, before: c.name, after: SOURCE_BEFORE })),
                text: `From the next build, ${tables.toLowerCase()} will load from the nightly core extract file again. The **${c.name}** stays connected, and you can switch back at any time.`,
                done: `From the next build, ${tables.toLowerCase()} load from the **core extract file** again.`,
                risk: 'high',
                apply: { connectionId: c.connectionId, inUse: false },
              },
            };
          }
          if (c.inUse) throw new CoreError('INVALID', `Builds already read the ${c.name}, from the first build after ${day(c.inUseSince!)}.`);
          const last = await s.lastPull(c.connectionId);
          if (!last) throw new CoreError('INVALID', `The ${c.name} hasn’t pulled yet, so I can’t check it against DI. Pull from it first.`);
          const totals = last.tables.reduce((x, t) => ({ pulled: x.pulled + t.pulled, matched: x.matched + t.matched, odd: x.odd + t.newInCore + t.notInCore + t.differ }), { pulled: 0, matched: 0, odd: 0 });
          return {
            change: {
              summary: `Use the ${c.name} for ${tables.toLowerCase()} from the next build`,
              changes: [...c.tables.map((t) => ({ label: t.label, before: SOURCE_BEFORE, after: `${c.name}, direct` })), { label: 'Starts', before: '—', after: 'With the next nightly build' }, { label: 'Last check', before: '—', after: `${n(totals.matched)} of ${n(totals.pulled)} rows matched${totals.odd ? `; ${plural(totals.odd, 'row')} to check` : ''}` }],
              text: `From the next build, DI will read ${tables.toLowerCase()} from the **${c.name}** instead of the nightly core extract file. The last pull, ${when(last.at)}, matched ${n(totals.matched)} of ${n(totals.pulled)} rows.${totals.odd ? ` ${plural(totals.odd, 'row')} differ or exist on one side only; the build will take the core’s values for those.` : ''} Lineage will show the replica as the source.`,
              done: `From the next build, ${tables.toLowerCase()} come from the **${c.name}**. Lineage shows it now.`,
              risk: 'high',
              apply: { connectionId: c.connectionId, inUse: true },
            },
          };
        },
        apply: async (p: { connectionId: number; inUse: boolean }, _meta, ctx) => {
          await need(ctx).setInUse(p.connectionId, p.inUse, { on: today() });
          return p.inUse ? { text: '', suggestions: ['Where does total loan balance come from?'] } : undefined;
        },
      },
    ],
  };
  return spec;
}

function testView(spec: ModuleSpec, ctx: ModuleContext, t: ConnectionTest): ModuleView {
  const { login } = t;
  const where = `**${login.database}** on ${login.host}:${login.port} as **${login.login}**`;
  const tableBlock = moduleTable(
    spec,
    'Tables the login can see',
    ctx.runId,
    'src.test',
    [
      { field: 'table', headerName: 'Table', type: 'text' },
      { field: 'rows', headerName: 'Rows', type: 'number' },
      { field: 'use', headerName: 'Maps to', type: 'text' },
    ],
    t.tables.map((x) => ({ table: x.name, rows: x.rows, use: t.mappings?.filter((m) => m.map.theirTables.some((y) => y.toUpperCase() === x.name.toUpperCase())).map((m) => m.map.label).join(', ') || '—' })),
  );
  if (!t.readOnly)
    return {
      text: `I reached ${where}, but this login can change data in the core: ${t.writeGrants.join('; ')}. DI connects to a core only with a login that can read and nothing else, so I won’t use it. Ask the core’s administrator for a read-only login and enter it on Integrations.`,
      blocks: [tableBlock],
    };
  const process = t.processDate ? ` The core’s process date is ${day(t.processDate)}.` : '';
  if (!t.mappings)
    return {
      text: `Connected to ${where} (${t.version}). The login is **read-only**, and it can see ${plural(t.tables.length, 'table')}.${process} There’s no ready-made mapping for ${login.system.label} yet, so Kinective maps its tables to DI during onboarding. These connection details are saved for that.`,
      blocks: [tableBlock],
    };
  const ready = t.mappings.filter((m) => !m.missing.length);
  const missing = t.mappings.filter((m) => m.missing.length);
  const mapBlock = moduleTable(
    spec,
    `How ${login.system.short} maps to DI`,
    ctx.runId,
    'src.test',
    [
      { field: 'table', headerName: 'DI table', type: 'text' },
      { field: 'column', headerName: 'DI column', type: 'text' },
      { field: 'from', headerName: `From ${login.system.short}`, type: 'text' },
      { field: 'how', headerName: 'How', type: 'text' },
    ],
    t.mappings.flatMap((m) => m.map.columns.map((col) => ({ table: m.map.label, column: col.di, from: col.their.replace(/^([a-z])\./, (_, a: string) => `${aliasTable(m.map.from, a)}.`), how: describeTransform(col.how) }))),
  );
  return {
    text: `Connected to ${where}. The login is **read-only**: it can’t change anything in the core.${process} Kinective’s ready-made ${login.system.short} mapping ${missing.length ? 'mostly fits' : 'fits'}: ${ready.map((m) => `**${m.map.label}** from ${m.map.theirTables.join(' + ')} (${n(m.rows)} rows)`).join(', ')}.${missing.length ? ` ${missing.map((m) => `${m.map.label} needs ${m.missing.join(', ')}, which the login can’t see`).join('. ')}.` : ' Every column it needs is there.'}`,
    blocks: [mapBlock, tableBlock],
    suggestions: ready.length ? [`Connect the ${login.system.short} replica, pulling nightly at 2:00 am`] : [],
  };
}

const aliasTable = (from: string, alias: string) => new RegExp(`(?:^|JOIN\\s+)([A-Z][A-Z0-9_]*)\\s+${alias}\\b`).exec(from)?.[1] ?? alias;

function reconcileTable(spec: ModuleSpec, ctx: ModuleContext, r: PullResult) {
  return moduleTable(
    spec,
    `Checked against DI, ${when(r.at)}`,
    ctx.runId,
    'src.reconcile',
    [
      { field: 'table', headerName: 'Table', type: 'text' },
      { field: 'core', headerName: 'In the core', type: 'number' },
      { field: 'di', headerName: 'In DI', type: 'number' },
      { field: 'matched', headerName: 'Match', type: 'number' },
      { field: 'onlyCore', headerName: 'Only in the core', type: 'number' },
      { field: 'onlyDi', headerName: 'Only in DI', type: 'number' },
      { field: 'differ', headerName: 'Differ', type: 'number' },
    ],
    r.tables.map((t) => ({ table: t.label, core: t.pulled, di: t.inDi, matched: t.matched, onlyCore: t.newInCore, onlyDi: t.notInCore, differ: t.differ })),
  );
}

const FIELD: Record<string, string> = { balance: 'Balance', first_name: 'First name', last_name: 'Last name', rate: 'Rate', days_delinquent: 'Days past due', '(whole row)': 'Whole record' };
const shownValue = (field: string, v: string | number | null) => (v === null ? '—' : typeof v === 'number' && /balance|amount/.test(field) ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(v));

function differenceTable(spec: ModuleSpec, ctx: ModuleContext, r: PullResult) {
  return moduleTable(
    spec,
    'Rows that differ',
    ctx.runId,
    'src.reconcile',
    [
      { field: 'record', headerName: 'Record', type: 'text' },
      { field: 'field', headerName: 'Field', type: 'text' },
      { field: 'di', headerName: 'DI has', type: 'text' },
      { field: 'core', headerName: 'The core has', type: 'text' },
    ],
    r.differences.map((d) => ({ record: `${d.label.replace(/s$/, '')} #${d.key}`, field: FIELD[d.field] ?? d.field.replaceAll('_', ' '), di: d.field === '(whole row)' ? 'Not in DI' : shownValue(d.field, d.di), core: d.field === '(whole row)' ? 'Opened in the core' : shownValue(d.field, d.core) })),
  );
}

function pullView(spec: ModuleSpec, ctx: ModuleContext, r: PullResult, lead: string, offerNext = true): ModuleView {
  const parts = r.tables.map((t) => {
    const odd = [t.newInCore ? `${n(t.newInCore)} only in the core` : '', t.notInCore ? `${n(t.notInCore)} only in DI` : '', t.differ ? `${plural(t.differ, 'row')} with different values` : ''].filter(Boolean);
    return odd.length ? `**${t.label}**: ${n(t.matched)} match, ${odd.join(', ')}` : `**${t.label}** match exactly (${n(t.matched)})`;
  });
  const odd = r.tables.reduce((x, t) => x + t.newInCore + t.notInCore + t.differ, 0);
  const process = r.processDate ? ` (core process date ${day(r.processDate)})` : '';
  const next = r.connection.inUse ? [] : [`Use the ${r.connection.name} for the next build`];
  return {
    text: `${lead}Pulled **${n(r.rows)} rows** on ${when(r.at)}${process} and checked them against DI. ${parts.join('. ')}.${odd ? ' Those are the rows to look at before the build uses this source.' : ''}`,
    blocks: [reconcileTable(spec, ctx, r), ...(odd && offerNext ? [differenceTable(spec, ctx, r)] : [])],
    suggestions: [...(odd && !offerNext ? ['Show the rows that differ'] : []), ...next],
  };
}
