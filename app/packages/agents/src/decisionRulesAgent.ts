// Decision Rules: DMN decision tables people read and change in words. Show a table, try it on a case
// ("what does a 690 score, 95% LTV, 72-month loan get?"), see what it decides across today's data, and
// change it: DI checks every cell, runs the old and new tables over the same data to say who or what
// moves, and makes the change a new version once someone other than the person asking approves it.
import { z } from 'zod';
import { CoreError, PRICING_EXCEPTION_BP, compileTable, type CellValue, type DecisionTable, type DecisionTableService, type TableEdit } from '@dinext/di-core';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';

export const DECISION_RULES_REQUEST =
  /\b(?:decision|business|dmn) (?:tables?|rules?)\b|\brules? tables?\b|\b(?:retention|outreach) (?:rules?|table|actions? table)\b|\b(?:loan )?pricing (?:rules?|table|grid|adjustments?)\b|\brate adjustments? (?:table|rules?)\b|\b(?:change|edit|update|set|add|remove|delete)\b[^.?!]*\brule \d+\b|\brule \d+\b[^.?!]*\b(?:to|of the)\b[^.?!]*\b(?:table|rules?|pricing|retention)\b|\bwhat (?:adjustment|pricing|rate adjustment)\b[^.?!]*\b(?:score|ltv)\b/i;

const text = (field: string, headerName: string) => ({ field, headerName, type: 'text' as const });
const n = (v: number) => Math.round(v).toLocaleString('en-US');

/** The table a question names. */
export function tableIn(t: string): string | null {
  if (/\bretention\b|\boutreach\b|\bat[- ]risk\b|\battrition\b/i.test(t)) return 'retention_action';
  if (/\bpric|\brate adjustment|\bloan\b|\bcredit score\b|\bltv\b/i.test(t)) return 'loan_pricing';
  return null;
}

/** Edits read from plain words: "set rule 1's within to 3 days", "remove rule 6". */
export function editsIn(t: string): TableEdit[] {
  const out: TableEdit[] = [];
  for (const m of t.matchAll(/\b(?:remove|delete|drop) rule (\d+)\b/gi)) out.push({ rule: Number(m[1]), remove: true });
  // "... in the pricing table" says which table, not what to set.
  const plain = t.trim().replace(/\s*[.?!]+$/, '').replace(/\s+(?:in|of|on|for) the [\w -]+? (?:table|rules?)$/i, '');
  const set = /\b(?:set|change|make|update)\s+rule (\d+)(?:['’]s)?\s+(.+?)\s+(?:to|=)\s+(.+?)\s*(?:days?|bp|basis points)?$/i.exec(plain);
  if (set) {
    const value = set[3]!.replace(/\s*(?:days?|bp|basis points)$/i, '').trim();
    out.push({ rule: Number(set[1]), set: { [set[2]!.replace(/^(?:the|its)\s+/i, '').trim()]: value } });
  }
  return out;
}

/** A case's values read from plain words, for trying a table. */
export function caseIn(table: string, t: string): Record<string, CellValue> {
  if (table === 'loan_pricing') {
    const score = /\b(\d{3})\s*(?:credit )?score\b|\bscore (?:of )?(\d{3})\b/i.exec(t);
    const ltv = /\b(\d{1,3}(?:\.\d+)?)\s*%\s*ltv\b|\bltv (?:of )?(\d{1,3}(?:\.\d+)?)/i.exec(t);
    const term = /\b(\d{2,3})[- ]month\b|\bterm (?:of )?(\d{2,3})\b/i.exec(t);
    return {
      score: score ? Number(score[1] ?? score[2]) : null,
      ltv: ltv ? Number(ltv[1] ?? ltv[2]) : null,
      term: term ? Number(term[1] ?? term[2]) : null,
      direct_deposit: /\b(?:no|without) direct deposit\b/i.test(t) ? false : /\bdirect deposit\b/i.test(t),
    };
  }
  const band = /\b(high|medium|low)\b/i.exec(t)?.[1];
  const dep = /\$\s?([\d,.]+)\s*(k|m|thousand|million)?/i.exec(t);
  const products = /\b(\d+) products?\b|\bone product\b/i.exec(t);
  const years = /\b(\d+) years?\b/i.exec(t);
  const scale = (u?: string) => (!u ? 1 : /^k|^t/i.test(u) ? 1e3 : 1e6);
  return {
    band: band ? band[0]!.toUpperCase() + band.slice(1).toLowerCase() : null,
    deposits: dep ? Number(dep[1]!.replace(/,/g, '')) * scale(dep[2]) : null,
    products: products ? (products[1] ? Number(products[1]) : 1) : null,
    years: years ? Number(years[1]) : null,
  };
}

/** The table's rules as a grid: one row per rule, inputs then outputs. */
function grid(spec: Pick<ModuleSpec, 'agent' | 'sources'>, t: DecisionTable, runId: string, title?: string) {
  return moduleTable(
    spec,
    title ?? `${t.name}, version ${t.version} (${t.hitPolicy === 'FIRST' ? 'first match decides' : t.hitPolicy === 'COLLECT' ? (t.aggregation === 'SUM' ? 'every match, summed' : 'every match') : t.hitPolicy === 'UNIQUE' ? 'only one may match' : 'every match, in order'})`,
    runId,
    'dmn.rules',
    [text('n', '#'), ...t.inputs.map((c) => text(`in_${c.key}`, c.label)), ...t.outputs.map((c) => text(`out_${c.key}`, c.label)), text('note', 'Note')],
    t.rules.map((r, i) => ({ n: String(i + 1), ...Object.fromEntries(t.inputs.map((c) => [`in_${c.key}`, r.when[c.key] ?? '-'])), ...Object.fromEntries(t.outputs.map((c) => [`out_${c.key}`, r.then[c.key] ?? ''])), note: r.note ?? '' })),
  );
}

export function decisionRulesModule(svc: DecisionTableService): ModuleSpec {
  const noAccess = 'A decision table isn’t part of your DI access: each follows the access of what it decides.';
  const tableFor = async (ctx: ModuleContext, key?: string | null, question?: string) => {
    const list = await svc.list(ctx.modules);
    if (!list.length) throw new CoreError('NO_ACCESS', noAccess);
    const k = key ?? (question ? tableIn(question) : null);
    const t = k ? list.find((x) => x.key === k) : list.length === 1 ? list[0] : null;
    if (k && !t) {
      if ((await svc.get(k)) !== null) throw new CoreError('NO_ACCESS', 'That decision table isn’t part of your DI access.');
      throw new CoreError('NOT_FOUND', `There’s no decision table by that name. The tables are ${list.map((x) => x.name.toLowerCase()).join(' and ')}.`);
    }
    return { t: t ?? null, list };
  };

  const spec: ModuleSpec = {
    id: 'governance',
    prefix: 'dmn',
    agent: 'Decision Rules',
    request: DECISION_RULES_REQUEST,
    noAccess,
    sources: [{ kind: 'table', label: 'Decision tables', ref: 'table:dmn_table_version' }],
    prompt: ({ tenant, user, title }) => `You are the Decision Rules agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) reads and changes DI's decision tables (DMN): retention outreach and consumer loan pricing adjustments.

- "Show the decision tables": dmn_list. "Show the pricing table": dmn_show with table loan_pricing; retention: retention_action.
- "What does a 690 score, 95% LTV, 72-month loan get?": dmn_try with table and values by input key.
- "What does the retention table decide today?": dmn_apply.
- "Set rule 1's deposits to >= 25000", "add a rule for terms over 84 months at +75 bp", "remove rule 6": dmn_change with edits (rule numbers from 1; cells by column key or label; DMN cells: - for any, < 640, >= 50000, [640..700), High, Medium). It returns approval_required; someone other than the requester approves.
- "Who changed the pricing table?": dmn_history.`,
    plan: (t) => {
      const table = tableIn(t);
      if (/\bhistory\b|\bwho changed\b|\bversions?\b|\bchanged when\b/i.test(t)) return { tool: 'dmn_history', args: { table: table ?? 'loan_pricing' } };
      const edits = editsIn(t);
      if (edits.length) return { tool: 'dmn_change', args: { table: table ?? 'retention_action', edits } };
      if (/\b(?:add|change|set|remove|delete|edit|update)\b[^.?!]*\brule\b/i.test(t)) return { say: 'Say which rule and what to set, for example “set rule 1’s deposits to >= 25000 in the retention table” or “remove rule 6 of the pricing table”. I’ll show who or what it moves before anyone approves it.' };
      if (/\bwhat (?:adjustment|pricing|rate adjustment|does)\b[^.?!]*\b(?:score|ltv|month)\b/i.test(t)) return { tool: 'dmn_try', args: { table: 'loan_pricing', values: caseIn('loan_pricing', t) } };
      if (/\bwhat (?:would|does|should) (?:we|the table)?\s*(?:do|decide)\b[^.?!]*\b(?:high|medium|low)\b/i.test(t)) return { tool: 'dmn_try', args: { table: 'retention_action', values: caseIn('retention_action', t) } };
      if (/\b(?:decide|apply|applied|today|across|how many|impact)\b/i.test(t) && table) return { tool: 'dmn_apply', args: { table } };
      if (table && /\bshow|\bwhat(?:'s| is) in\b|\brules?\b|\btable\b/i.test(t)) return { tool: 'dmn_show', args: { table } };
      return { tool: 'dmn_list', args: {} };
    },
    tools: [
      {
        name: 'dmn_list',
        description: 'The decision tables DI applies, those the person may see: what each decides, its hit policy, how many rules and versions, and who last changed it.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          const { list } = await tableFor(ctx);
          return {
            text: `DI applies ${list.length === 1 ? 'one decision table' : `${list.length} decision tables`} you can see. ${list.map((t) => `**${t.name}** (version ${t.version}, ${t.rules.length} rules): ${t.description}`).join(' ')}`,
            blocks: [moduleTable(spec, 'Decision tables', ctx.runId, 'dmn.list', [text('name', 'Table'), text('policy', 'Hit policy'), { field: 'rules', headerName: 'Rules', type: 'count' }, { field: 'version', headerName: 'Version', type: 'count' }, text('changed', 'Last changed')], list.map((t) => ({ name: t.name, policy: t.hitPolicy === 'COLLECT' && t.aggregation ? `COLLECT, ${t.aggregation.toLowerCase()}` : t.hitPolicy, rules: t.rules.length, version: t.version, changed: `${t.changedAt.slice(0, 10)} by ${t.changedBy}` })))],
            suggestions: list.map((t) => `Show the ${t.key === 'loan_pricing' ? 'pricing' : 'retention'} table`),
          };
        },
      },
      {
        name: 'dmn_show',
        description: 'One decision table’s rules as a grid: inputs, outputs, notes and how the rules combine.',
        input: z.object({ table: z.enum(['retention_action', 'loan_pricing']) }).strict(),
        run: async (a: { table: string }, ctx) => {
          const { t } = await tableFor(ctx, a.table);
          return {
            text: `**${t!.name}**, version ${t!.version}: ${t!.description} Last changed ${t!.changedAt.slice(0, 10)} by ${t!.changedBy}${t!.approvedBy && t!.approvedBy !== t!.changedBy ? `, approved by ${t!.approvedBy}` : ''}.`,
            blocks: [grid(spec, t!, ctx.runId)],
            suggestions: [`What does the ${a.table === 'loan_pricing' ? 'pricing' : 'retention'} table decide today?`, a.table === 'loan_pricing' ? 'What adjustment does a 690 score, 95% LTV, 72-month loan get?' : 'Set rule 1’s deposits to >= 25000 in the retention table'],
          };
        },
      },
      {
        name: 'dmn_try',
        description: 'Runs one case through a decision table: which rules match and what it decides. values by input key; leave out what isn’t known.',
        input: z.object({ table: z.enum(['retention_action', 'loan_pricing']), values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).strict(),
        run: async (a: { table: string; values: Record<string, CellValue> }, ctx) => {
          const { t } = await tableFor(ctx, a.table);
          const d = compileTable(t!)(a.values);
          const given = t!.inputs.map((c) => `${c.label.replace(/\s*\(.*\)$/, '').toLowerCase()} ${a.values[c.key] === null || a.values[c.key] === undefined ? 'not given' : a.values[c.key] === true ? 'yes' : a.values[c.key] === false ? 'no' : String(a.values[c.key])}`).join(', ');
          const result = svc.outcome(t!, d);
          const why = d.matched.map((m) => `rule ${m}${t!.rules[m - 1]!.then.reason ? ` (${t!.rules[m - 1]!.then.reason})` : ''}`).join(', ');
          return {
            text: d.matched.length ? `With ${given}, the ${t!.name.toLowerCase()} table gives **${result}**, from ${why}.${t!.key === 'loan_pricing' && (d.total ?? 0) > PRICING_EXCEPTION_BP ? ` That’s over +${PRICING_EXCEPTION_BP} bp, so it needs a pricing exception.` : ''}` : `With ${given}, no rule in the ${t!.name.toLowerCase()} table matches.`,
            blocks: d.matched.length ? [grid(spec, { ...t!, rules: d.matched.map((m) => t!.rules[m - 1]!) }, ctx.runId, `Rules that matched (${d.matched.map((m) => `#${m}`).join(', ')})`)] : [],
          };
        },
      },
      {
        name: 'dmn_apply',
        description: 'What a decision table decides across today’s data in purview: retention outreach over everyone the attrition model scored, pricing over consumer loans opened in the last 90 days. Counts by outcome, how often each rule fires and rules that never do.',
        input: z.object({ table: z.enum(['retention_action', 'loan_pricing']) }).strict(),
        run: async (a: { table: string }, ctx) => {
          const { t } = await tableFor(ctx, a.table);
          const r = await svc.apply(t!, ctx.purviewBranches);
          const top = r.outcomes.filter((o) => !/^No action/.test(o.outcome)).slice(0, 3);
          const ex = t!.key === 'loan_pricing' ? r.decided.filter((x) => (x.d.total ?? 0) > PRICING_EXCEPTION_BP).length : 0;
          return {
            text: `Over ${r.about}, the ${t!.name.toLowerCase()} table decides: ${top.map((o) => `**${o.outcome}** for ${n(o.n)}`).join(', ')}${r.outcomes.length > top.length ? ', and the rest below' : ''}.${t!.key === 'loan_pricing' ? ` ${n(ex)} would need a pricing exception (over +${PRICING_EXCEPTION_BP} bp).` : ''}${r.neverFires.length ? ` ${r.neverFires.length === 1 ? 'Rule' : 'Rules'} ${r.neverFires.join(', ')} never ${r.neverFires.length === 1 ? 'fires' : 'fire'} on today’s data.` : ''}${r.unmatched ? ` ${n(r.unmatched)} match no rule.` : ''}`,
            blocks: [
              moduleTable(spec, `What it decides, ${r.about}`, ctx.runId, 'dmn.apply', [text('outcome', 'Outcome'), { field: 'n', headerName: 'How many', type: 'count' }], r.outcomes.map((o) => ({ outcome: o.outcome, n: o.n }))),
              moduleTable(spec, 'How often each rule fires', ctx.runId, 'dmn.fired', [text('rule', 'Rule'), text('when', 'When'), { field: 'n', headerName: 'Fires', type: 'count' }], t!.rules.map((x, i) => ({ rule: `#${i + 1}`, when: t!.inputs.map((c) => (x.when[c.key] && x.when[c.key] !== '-' ? `${c.label.replace(/\s*\(.*\)$/, '')} ${x.when[c.key]}` : null)).filter(Boolean).join(', ') || 'Anything else', n: r.fired[i]! }))),
            ],
            suggestions: [`Show the ${a.table === 'loan_pricing' ? 'pricing' : 'retention'} table`],
          };
        },
      },
      {
        name: 'dmn_change',
        description: 'Prepare a change to a decision table: set cells of a rule, add a rule or remove one. DI checks every cell and shows who or what the change moves across today’s data. It becomes a new version once someone other than the requester approves. Returns approval_required.',
        input: z
          .object({
            table: z.enum(['retention_action', 'loan_pricing']),
            edits: z.array(z.object({ rule: z.number().int().positive().optional(), set: z.record(z.string(), z.string()).optional(), remove: z.boolean().optional(), position: z.number().int().positive().optional(), note: z.string().max(200).optional() }).strict()).min(1).max(12),
            note: z.string().max(300).optional(),
          })
          .strict(),
        run: async (a: { table: string; edits: TableEdit[]; note?: string }, ctx) => {
          const { t } = await tableFor(ctx, a.table);
          const p = await svc.propose(t!.key, a.edits, ctx.purviewBranches);
          if (p.problems.length) return { text: `That change can’t go in as written: ${p.problems.join(' ')} Nothing has changed.` };
          const im = p.impact!;
          const moveWords = im.moves.slice(0, 3).map((m) => `${n(m.n)} from ${m.from} to ${m.to}`).join('; ');
          const exWords = im.exceptions ? ` Pricing exceptions go from ${n(im.exceptions.before)} to ${n(im.exceptions.after)}.` : '';
          return {
            change: {
              summary: `Change the ${t!.name.toLowerCase()}: version ${t!.version} to ${t!.version + 1}`,
              changes: [
                ...p.changed.map((c) => ({ label: `Rule ${c.rule}`, before: c.what.includes('→') ? c.what.split('→')[0]!.trim() : c.what === 'Removed' ? 'In the table' : '—', after: c.what.includes('→') ? `${c.what.split(':')[0]}: ${c.what.split('→')[1]!.trim()}` : c.what })),
                { label: 'Moves', before: '—', after: im.moved ? `${n(im.moved)} of ${im.about}` : 'No one today' },
                ...(im.neverFires.length ? [{ label: 'Never fires today', before: '—', after: `Rule ${im.neverFires.join(', ')}` }] : []),
              ],
              text: `I’ll change the **${t!.name.toLowerCase()}** to version ${t!.version + 1}. Over ${im.about}, it ${im.moved ? `moves **${n(im.moved)}**: ${moveWords}.` : 'moves no one today.'}${exWords}${im.neverFires.length ? ` After the change, rule ${im.neverFires.join(', ')} never fires on today’s data.` : ''} A rule change is approved by someone other than the person asking.`,
              done: `The ${t!.name.toLowerCase()} is at version ${t!.version + 1}.`,
              risk: 'medium',
              secondApprover: { role: 'Someone other than the requester, such as the head of lending or the CRO', policy: 'Decision rule changes' },
              apply: { next: p.next, fromVersion: t!.version, requestedBy: ctx.user.name, note: a.note ?? p.changed.map((c) => `Rule ${c.rule}: ${c.what}`).join('; ').slice(0, 480) },
            },
            blocks: [grid(spec, { ...t!, rules: p.next.rules, version: t!.version + 1 }, ctx.runId, `${t!.name}, as it would be (version ${t!.version + 1})`)],
          };
        },
        apply: async (p: { next: Parameters<DecisionTableService['activate']>[0]; fromVersion: number; requestedBy: string; note: string }, meta, ctx) => {
          const r = await svc.activate(p.next, { requestedBy: p.requestedBy, approvedBy: ctx.user.name, approvalId: meta.approvalId, note: p.note, fromVersion: p.fromVersion });
          return { text: `The ${p.next.name.toLowerCase()} is at **version ${r.version}**, asked for by ${p.requestedBy} and approved by ${ctx.user.name}. DI applies it from now on; version ${r.version - 1} is kept.`, suggestions: [`What does the ${p.next.key === 'loan_pricing' ? 'pricing' : 'retention'} table decide today?`] };
        },
      },
      {
        name: 'dmn_history',
        description: 'Every version of a decision table: who asked for each change, who approved it, when and what changed.',
        input: z.object({ table: z.enum(['retention_action', 'loan_pricing']) }).strict(),
        run: async (a: { table: string }, ctx) => {
          const { t } = await tableFor(ctx, a.table);
          const h = await svc.history(t!.key);
          return {
            text: `The ${t!.name.toLowerCase()} has ${h.length} ${h.length === 1 ? 'version' : 'versions'}; version ${t!.version} is in use.`,
            blocks: [moduleTable(spec, `${t!.name}: versions`, ctx.runId, 'dmn.history', [text('version', 'Version'), text('status', 'Status'), text('by', 'Asked for by'), text('approved', 'Approved by'), text('when', 'When'), text('note', 'What changed')], h.map((v) => ({ version: `v${v.version}`, status: v.status, by: v.changedBy, approved: v.approvedBy ?? '—', when: v.changedAt.slice(0, 16).replace('T', ' '), note: v.note ?? '' })))],
          };
        },
      },
    ],
  };
  return spec;
}
