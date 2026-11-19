// Data Lineage (spec 24.10) and AI usage and governance (8.21) on the shared agent. Both are read
// only, and every figure and graph is written by code. The model chooses the tool and nothing else.
import { z } from 'zod';
import type { AuditLogPage, AuditRunTrace, LineageGraphBlock } from '@dinext/block-schemas';
import { CoreError, type ConceptView, type GovernanceService, type LineageService, type OntologyService, type UsageGroup } from '@dinext/di-core';
import { ontology } from '@dinext/ontology';
import { newBlockId } from './answer.ts';
import { moduleTable, type ModuleContext, type ModuleSpec } from './moduleAgent.ts';
import { WORDS_REQUEST, wordsPlan, wordsTools, type WordsDeps } from './words.ts';

const clean = (t: string) => t.trim().replace(/[.!?]+$/, '').replace(/’/g, "'");
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// ---- lineage ----------------------------------------------------------------------------------

/** Data dictionary questions the ontology answers: what a word means in DI, which column holds it, which core column it comes from. */
/** Asking for the ontology as a file (phase 10): "Export the ontology as OWL", "Download the data dictionary as Turtle". */
export const OWL_EXPORT = /\b(?:export|download|give me|get)\b[^?]*\b(?:ontology|data dictionary)\b[^?]*\b(?:owl|turtle|rdf|file|protégé|protege)\b|\b(?:owl|turtle|rdf)\b[^?]*\b(?:file|export|download)\b[^?]*\b(?:ontology|data dictionary)\b/i;

export const ONTOLOGY_REQUEST = /\bwhat (?:does|do) (?:DI|we|you) mean by\b|\b(?:which|what) (?:DI )?(?:columns?|fields?) (?:holds?|has|have|stores?|keeps?|contains?)\b|\b(?:which|what) (?:symitar|core) (?:columns?|fields?)\b|\bdata dictionary\b|\bontology\b|\bfibo\b|\bowl\b|\bwhat do (?:banks|credit unions) call\b/i;

/**
 * Impact by meaning or by core column (phase 5): "What changes if the core changes how it codes loan
 * type?", "What breaks if LOAN.TYPE changes?". A DI table.column goes to lin_impact as before.
 */
export const CONCEPT_IMPACT = /\bwhat (?:changes|breaks|moves|is affected|would change|would break|depends on)\b[^?]*?\b(?:if|when)\b[^?]*\b(?:core|symitar|codes?|coded|column|field)\b|\bwhat breaks if\b[^?]*\b[A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*\b|\bimpact of (?:a |the )?(?:core|symitar)\b/i;

/** What an impact question is about: a core column (LOAN.TYPE) as written, or the concept in plain words ("loan type"). */
export function impactSubject(text: string) {
  const t = clean(text).replace(/["“”]/g, '');
  const core = /\b([A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*)\b/.exec(t);
  if (core) return core[1]!;
  const after = /\b(?:if|when)\b(.+)$/i.exec(t)?.[1] ?? /\bimpact of\b(.+)$/i.exec(t)?.[1] ?? '';
  return after
    .replace(/\b(?:the|our|a|an|its|their|it|we|they|(?:the )?core(?: system)?|symitar|vendor)\b/gi, ' ')
    .replace(/\b(?:changes?|changed|changing|renames?|renamed|drops?|dropped|adds?|added|new|how|codes?|coded|coding|column|field|values?|list|is|are|was|were|to|for|in|of|way|starts?|stops?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The word or phrase a data dictionary question is about; '' for the dictionary as a whole. */
export function ontologyTerm(text: string) {
  const t = clean(text).replace(/["“”]/g, '');
  const pick = [
    /\bmean by (?:an? |the )?(.+)$/i,
    /\b(?:columns?|fields?) (?:holds?|has|have|stores?|keeps?|contains?) (?:an? |the )?(.+?)(?: in DI)?$/i,
    /\b(?:symitar|core) (?:columns?|fields?) (?:is|are|holds?|has|for|gives?) (?:an? |the )?(.+)$/i,
    /\bwhat do (?:banks|credit unions) call (?:an? |the )?(.+)$/i,
    /\bwhat (?:does|is) fibo(?:'s| name| term| class)? (?:call|for) (?:an? |the )?(.+)$/i,
    /\b(?:what|which) (?:is|class is) (?:an? |the )?(.+?) in fibo$/i,
    /\bfibo (?:term|class|name|equivalent|match) (?:for|of) (?:an? |the )?(.+)$/i,
    /\b(?:how does|does) (?:an? |the |DI'?s )?(.+?) (?:map|line up|match|correspond) (?:to|with) fibo$/i,
    /\b(?:look up|define|entry for|is) (?:an? |the )?(.+?) in the (?:data dictionary|ontology)$/i,
    /\b(?:data dictionary|ontology) (?:entry )?for (?:an? |the )?(.+)$/i,
  ];
  for (const re of pick) {
    const m = re.exec(t);
    if (m?.[1]) return m[1].trim();
  }
  return '';
}

export function lineageModule(lineage: LineageService, onto: OntologyService | null = null, words: WordsDeps | null = null): ModuleSpec {
  const noAccess = 'Data lineage isn’t part of your DI access.';
  const need = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('lineage')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const ontoSources = [{ kind: 'table' as const, label: 'DI ontology', ref: 'table:onto_concept' }];
  const spec: ModuleSpec = {
    id: 'lineage',
    prefix: 'lin',
    agent: 'Data Lineage',
    request: new RegExp(`${/^(?![\s\S]*\b(?:diversif\w*|share of revenue|how much|mix|fee income|non-?interest income|noninterest income)\b)[\s\S]*?\bwhere does\b.*\bcome from\b|\blineage\b|\btrace\b.*\bsources?\b|\bwhat breaks if\b|\bwhat depends on\b/.source}|${ONTOLOGY_REQUEST.source}|${CONCEPT_IMPACT.source}|${WORDS_REQUEST.source}`, 'i'),
    noAccess,
    sources: [{ kind: 'table', label: 'Lineage catalog', ref: 'table:meta_lineage' }],
    prompt: ({ tenant, user, title }) => `You are the Data Lineage agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) wants to know where data comes from.

- "Where does 60+ delinquency come from?", "Trace total loan balance to its source": lin_trace with the measure in their words.
- "What breaks if we change cdm_loan.days_delinquent?": lin_impact.
- "What changes if the core changes how it codes loan type?", "What breaks if LOAN.TYPE changes?": onto_impact with the concept in plain words or the core column as written.
- "What does DI mean by a share draft?", "Which column holds the loan balance?", "Which Symitar column is the dividend rate?", "What do banks call a share certificate?": onto_lookup with the word or phrase.
- "What is a share certificate in FIBO?", "What does FIBO call a HELOC?": onto_lookup with the word or phrase; the answer names the FIBO class and how closely it matches.
- "How much does the data dictionary cover?", "How does DI line up with FIBO?": onto_coverage.
- "Export the ontology as OWL", "Download the data dictionary for Protégé": onto_export.
- "Which questions couldn't DI read?": onto_unread. "Treat “owners” as customers", "“brnch” means branch": onto_word_add with the word and its meaning. "Stop treating “owners” as customers": onto_word_remove. "Which words have we added?": onto_words. Adding or removing a word changes how DI reads everyone's questions, so it goes through approval.
- The graph comes from lineage metadata, and meanings from DI's ontology. Never work out lineage or a meaning from table or column names. Connection secrets are never shown.`,
    plan: (text) => {
      const t = clean(text);
      const w = words ? wordsPlan(t) : null;
      if (w) return w;
      if (onto && OWL_EXPORT.test(t)) return { tool: 'onto_export', args: {} };
      if (onto && ONTOLOGY_REQUEST.test(t)) {
        const term = ontologyTerm(t);
        return term && !/^(?:DI|we|us|our (?:data|ontology|data dictionary)|(?:the|DI'?s) (?:data dictionary|ontology))$/i.test(term) ? { tool: 'onto_lookup', args: { term } } : { tool: 'onto_coverage', args: {} };
      }
      const diTarget = /\b[a-z]+_[a-z_]+(?:\.[a-z_0-9]+)?\b/.test(t);
      if (onto && !diTarget && CONCEPT_IMPACT.test(t)) {
        const subject = impactSubject(t);
        return subject.length >= 2 ? { tool: 'onto_impact', args: { subject } } : { say: 'Which concept or core column do you mean, such as loan type or LOAN.TYPE?' };
      }
      if (/\bwhat breaks if\b|\bwhat depends on\b/i.test(t)) {
        const target = /\b([a-z]+_[a-z_]+(?:\.[a-z_0-9]+)?)\b/.exec(t)?.[1];
        return target ? { tool: 'lin_impact', args: { target } } : { say: 'Which table or column do you mean?' };
      }
      return { tool: 'lin_trace', args: { measure: t } };
    },
    tools: [
      {
        name: 'lin_trace',
        description: 'Trace a measure back to its tables, columns, load jobs, files and source system, with the last load and data quality result for each step.',
        input: z.object({ measure: z.string().min(2).max(200) }).strict(),
        run: async (a: { measure: string }, ctx) => {
          need(ctx);
          const metric = lineage.find(a.measure);
          const g = await lineage.trace(metric.name);
          const failed = g.checks.filter((c) => !c.passed);
          const graph: LineageGraphBlock = {
            id: newBlockId('lin'),
            type: 'lineage_graph',
            version: '1.0.0',
            title: `Where ${metric.label} comes from`,
            provenance: { agent: spec.agent, runId: ctx.runId, operations: ['catalog.lineage.get'], sources: spec.sources },
            freshness: { kind: 'nightly_build', asOf: `${g.asOf}T00:00:00Z` },
            a11y: { summary: `${metric.label} reads ${plural(g.lanes.length, 'table')}. ${g.lanes.map((l) => l.nodes.map((n) => n.label).join(', then ')).join('. ')}.`.slice(0, 600) },
            data: { metric: metric.label, definition: metric.description, lanes: g.lanes },
          };
          const gap = g.unknown.length ? ` I have no lineage recorded for ${g.unknown.join(', ')}, so that step shows as an unknown source.` : '';
          const dq = !g.checks.length ? 'No data quality checks cover these steps.' : failed.length ? `**${failed.length} of ${g.checks.length} data quality checks failed** on these steps: ${failed.map((c) => `${c.name} (${c.rowsFailed.toLocaleString('en-US')} rows)`).join(', ')}.` : `All ${g.checks.length} data quality checks passed.`;
          return { text: `**${metric.label}**: ${metric.description} It reads ${plural(g.lanes.length, 'table')}. ${dq}${gap}`, blocks: [graph, ...(g.checks.length ? [moduleTable(spec, 'Data quality checks', ctx.runId, 'dq.status_report', [{ field: 'domain', headerName: 'Domain', type: 'text' }, { field: 'dimension', headerName: 'Dimension', type: 'text' }, { field: 'name', headerName: 'Check', type: 'text' }, { field: 'result', headerName: 'Result', type: 'text' }], g.checks.map((c) => ({ domain: c.domain, dimension: c.dimension, name: c.name, result: c.passed ? 'Passed' : `Failed, ${c.rowsFailed} rows` })), g.asOf)] : [])], suggestions: failed.length ? ['Which checks failed?'] : [] };
        },
      },
      {
        name: 'lin_impact',
        description: 'What depends on a table or column: the measures that read it and the reports that use them.',
        input: z.object({ target: z.string().min(3).max(80).describe('A table, or table.column, such as cdm_loan.days_delinquent') }).strict(),
        run: async (a: { target: string }, ctx) => {
          need(ctx);
          const r = await lineage.impact(a.target);
          return { text: `Changing **${a.target}** would affect **${plural(r.metrics.length, 'measure')}** and **${plural(r.reports.length, 'report')}**.`, blocks: [moduleTable(spec, `What depends on ${a.target}`, ctx.runId, 'catalog.lineage.impact', [{ field: 'kind', headerName: 'Kind', type: 'text' }, { field: 'name', headerName: 'Name', type: 'text' }], [...r.metrics.map((m) => ({ kind: 'Measure', name: m.label })), ...r.reports.map((name) => ({ kind: 'Report', name }))])] };
        },
      },
    ],
  };
  if (onto) spec.tools.push(ontoLookupTool(spec, onto, need, ontoSources), ontoCoverageTool(spec, onto, need, ontoSources), ontoImpactTool(spec, onto, lineage, need, ontoSources), ontoExportTool(need, ontoSources));
  if (onto && words) spec.tools.push(...wordsTools(spec, words, need, ontoSources));
  return spec;
}

/**
 * Impact by meaning (phase 5): from a concept or a core column, through the ontology to every DI column
 * that holds it, then the lineage of each to the measures and reports that read it. The ontology gives
 * the columns; lineage gives what reads them. Neither is guessed from names.
 */
function ontoImpactTool(spec: ModuleSpec, onto: OntologyService, lineage: LineageService, need: (ctx: ModuleContext) => void, sources: ModuleSpec['sources']) {
  return {
    name: 'onto_impact',
    description: 'What changes if a concept or a core column changes ("loan type", LOAN.TYPE): the DI columns that hold it, by DI’s ontology, and the measures and reports that read those columns, by lineage.',
    input: z.object({ subject: z.string().min(2).max(80) }).strict(),
    run: async (a: { subject: string }, ctx: ModuleContext) => {
      need(ctx);
      const found = await onto.lookup(a.subject);
      if (!found) return { text: 'DI’s data dictionary isn’t loaded for this institution yet.' };
      // The property the words name; a code list or a code stands for the property that holds it.
      const prop = found.find((c) => c.kind === 'property' && c.columns.length) ?? null;
      if (!prop) {
        const near = found[0];
        return { text: near ? `**${near.label}** is ${KIND_WORD[near.kind]} in DI’s data dictionary, not a field DI holds, so no column changes with it. Name a field, such as loan type or LOAN.TYPE.` : `“${a.subject}” isn’t in DI’s data dictionary. Try a field, such as loan type, or a core column, such as LOAN.TYPE.`, suggestions: ['How much does the data dictionary cover?'] };
      }
      const byMetric = new Map<string, { label: string; through: Set<string> }>();
      const reports = new Set<string>();
      const dims = new Set<string>();
      for (const col of prop.columns) {
        const r = await lineage.impact(col).catch((e: unknown) => (e instanceof CoreError && e.code === 'NOT_FOUND' ? null : Promise.reject(e)));
        if (!r) continue;
        for (const m of r.metrics) (byMetric.get(m.name) ?? byMetric.set(m.name, { label: m.label, through: new Set() }).get(m.name)!).through.add(col);
        r.reports.forEach((x) => reports.add(x));
        r.dimensions.forEach((d) => dims.add(d.label.toLowerCase()));
      }
      const core = prop.core.map((c) => `${c.system} ${c.column}`);
      const from = core.length ? ` (from ${list(core, 3)})` : '';
      const codes = prop.semanticType === 'code' ? ' A code the mapping doesn’t know is held on the next pull and proposed for a person to map, so it never reaches a report as the wrong type.' : '';
      const text = byMetric.size
        ? `**${prop.label}**${from} is held in ${plural(prop.columns.length, 'DI column')}. A change to it moves **${plural(byMetric.size, 'measure')}** and **${plural(reports.size, 'report')}**${dims.size ? `, through the ${list([...dims])} breakdown` : ''}.${codes}`
        : `**${prop.label}**${from} is held in ${plural(prop.columns.length, 'DI column')} (${list(prop.columns)}), and no measure in the catalog reads them. That doesn’t prove nothing else does.`;
      const rows = [...[...byMetric.values()].map((m) => ({ kind: 'Measure', name: m.label, through: [...m.through].join(', ') })), ...[...reports].sort().map((name) => ({ kind: 'Report', name, through: '' }))];
      return {
        text,
        blocks: rows.length ? [moduleTable({ ...spec, sources }, `What changes with ${prop.label.toLowerCase()}`, ctx.runId, 'onto.impact', [{ field: 'kind', headerName: 'Kind', type: 'text' }, { field: 'name', headerName: 'Name', type: 'text' }, { field: 'through', headerName: 'Through', type: 'text' }], rows)] : [],
        suggestions: [`What does DI mean by ${prop.label.toLowerCase()}?`],
      };
    },
  };
}

// ---- the data dictionary: DI's ontology ---------------------------------------------------------

const KIND_WORD: Record<ConceptView['kind'], string> = { class: 'a concept', property: 'a property', value_set: 'a code list', value: 'a code' };
const TYPE_WORD: Record<string, string> = { identifier: 'an identifier', reference: 'a link to another record', text: 'text', code: 'a code', money: 'dollars', rate: 'a yearly rate', percent: 'a percent', ratio: 'a ratio', count: 'a count', date: 'a date', flag: 'yes or no', score: 'a score', number: 'a number' };
const PRIVACY_WORD: Record<string, string> = { direct: 'identifies a person on its own', quasi: 'can identify a person together with other fields', financial: 'is financial information', none: '' };
const FIBO_MATCH: Record<ConceptView['fibo'][number]['match'], string> = { exact: 'the same meaning', close: 'close in meaning', broader: 'FIBO’s broader term', narrower: 'FIBO’s narrower term' };
const MASK_WORD: Record<NonNullable<ConceptView['mask']>, string> = { full: 'DI shows it in full to people who may see the record', last4: 'DI shows only its last four digits', year: 'DI shows only the year', email: 'DI shows only its first letter and domain', first3: 'DI shows only its first three digits', street: 'DI shows the street without the house number', hidden: 'DI never shows it' };
const fiboLine = (c: ConceptView) =>
  c.fibo.length ? `In FIBO, the industry’s standard financial ontology, it is ${list(c.fibo.map((f) => `*${f.label}* (${FIBO_MATCH[f.match]})`), 2)}.` : c.fiboNone ?? '';
const list = (xs: string[], n = 4) => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`);

function ontoLookupTool(spec: ModuleSpec, onto: OntologyService, need: (ctx: ModuleContext) => void, sources: ModuleSpec['sources']) {
  return {
    name: 'onto_lookup',
    description: 'Look a word, a DI column (cdm_loan.balance) or a core column (LOAN.BALANCE) up in DI’s ontology: what it means at this institution, its other names, the DI columns that hold it, the measures that use it, its codes, and the core columns it comes from.',
    input: z.object({ term: z.string().min(2).max(80) }).strict(),
    run: async (a: { term: string }, ctx: ModuleContext) => {
      need(ctx);
      const found = await onto.lookup(a.term);
      if (!found) return { text: 'DI’s data dictionary isn’t loaded for this institution yet.' };
      if (!found.length) return { text: `“${a.term}” isn’t in DI’s data dictionary. Try another word for it, a DI column such as cdm_loan.balance, or a core column such as LOAN.BALANCE.`, suggestions: ['How much does the data dictionary cover?'] };
      const c = found[0]!;
      const def = c.definition ? `: ${c.definition.charAt(0).toLowerCase()}${c.definition.slice(1).replace(/\.$/, '')}.` : '.';
      const name = `**${c.label}**${c.elsewhere ? ` (“${c.elsewhere.term}” at a ${c.elsewhere.type === 'bank' ? 'bank' : 'credit union'})` : ''}`;
      const opening =
        c.kind === 'class'
          ? c.parent ? `${name} is a kind of ${c.parent.label.toLowerCase()}${def}` : `${name}: ${c.definition ? c.definition.charAt(0).toLowerCase() + c.definition.slice(1) : 'a concept in DI’s data dictionary.'}`
          : c.kind === 'property'
            ? `${name} is a property of a ${c.parent?.label.toLowerCase() ?? 'record'}${def}`
            : c.kind === 'value'
              ? `${name} is a code on DI’s ${c.valueSet?.label.toLowerCase() ?? 'code'} list${c.codes[0]?.values.length ? `, held in DI as ${list(c.codes[0].values.map((v) => `“${v}”`))}` : ''}.`
              : `${name} is ${KIND_WORD[c.kind]} in DI’s data dictionary${def}`;
      const others = [...new Set(found.slice(1).map((f) => f.label))].filter((l) => l !== c.label);
      const parts = [
        opening,
        c.kind === 'property' && c.semanticType ? `It holds ${TYPE_WORD[c.semanticType] ?? c.semanticType}${c.privacy && PRIVACY_WORD[c.privacy] ? ` and ${PRIVACY_WORD[c.privacy]}` : ''}.` : '',
        c.synonyms.length ? `Also called ${list(c.synonyms.map((s) => `“${s}”`))}.` : '',
        c.columns.length ? `DI keeps it in ${list(c.columns.map((x) => `\`${x}\``), 3)}.` : '',
        c.metrics.length ? `${c.metrics.length === 1 ? 'One measure uses it' : `${c.metrics.length} measures use it`}: ${list(c.metrics.map((m) => m.label), 3)}.` : '',
        c.core.length ? `From the core: ${list(c.core.map((x) => `${x.system} \`${x.column}\``), 3)}.` : '',
        fiboLine(c),
        c.mask ? `${MASK_WORD[c.mask]}.` : '',
        c.kind === 'class' && c.properties.length ? `It has ${plural(c.properties.length, 'property', 'properties')}.` : '',
        others.length ? `Other matches: ${list(others, 4)}.` : '',
      ].filter(Boolean);
      const blocks = [];
      const detail = [
        ...c.columns.map((x) => ({ kind: 'DI column', name: x, note: '' })),
        ...c.metrics.map((m) => ({ kind: 'Measure', name: m.label, note: m.name })),
        ...c.core.map((x) => ({ kind: `${x.system} column`, name: x.column, note: x.description ?? '' })),
        ...c.relations.map((r) => ({ kind: 'Related', name: r.label, note: r.predicate })),
        ...c.fibo.map((f) => ({ kind: 'FIBO', name: f.label, note: `${FIBO_MATCH[f.match]}: ${f.iri}` })),
        ...c.properties.map((p) => ({ kind: 'Property', name: p.label, note: p.id })),
      ];
      if (detail.length) blocks.push(moduleTable(spec, `${c.label} in DI`, ctx.runId, 'catalog.ontology.concept', [{ field: 'kind', headerName: 'Kind', type: 'text' }, { field: 'name', headerName: 'Name', type: 'text' }, { field: 'note', headerName: 'Detail', type: 'text' }], detail));
      if (c.codes.length) blocks.push(moduleTable(spec, `${c.label}: codes`, ctx.runId, 'catalog.ontology.codes', [{ field: 'label', headerName: 'Code', type: 'text' }, { field: 'values', headerName: 'Values in DI', type: 'text' }], c.codes.map((x) => ({ label: x.label, values: x.values.join(', ') }))));
      const next = c.metrics[0] ? [`Where does ${c.metrics[0].label.toLowerCase()} come from?`] : [];
      return { text: parts.join(' '), blocks, sources, suggestions: [...next, 'How much does the data dictionary cover?'] };
    },
  };
}

/** The ontology as a file (phase 10): OWL in Turtle, with every FIBO mapping, from the server. */
function ontoExportTool(need: (ctx: ModuleContext) => void, sources: ModuleSpec['sources']) {
  return {
    name: 'onto_export',
    description: 'A link to download DI’s ontology as OWL (Turtle): its concepts, properties, code lists, privacy classes, the DI columns that hold each, and every FIBO mapping, for Protégé, a triple store or a data catalog.',
    input: z.object({}).strict(),
    run: async (_: unknown, ctx: ModuleContext) => {
      need(ctx);
      const o = ontology();
      const codes = [...o.valueSets.values()].reduce((n, vs) => n + Object.keys(vs.codes).length, 0);
      const mapped = [...o.classes.values(), ...o.properties.values(), ...[...o.valueSets.values()].flatMap((vs) => Object.values(vs.codes))].filter((x) => x.fibo).length;
      return {
        text: `Here is DI’s ontology (version ${o.version}) as OWL, in Turtle: [di-ontology-${o.version}.ttl](/v1/exports/di-ontology.ttl). It has ${o.classes.size} concepts, ${o.properties.size} properties and ${codes} codes in ${o.valueSets.size} code lists, each property with its privacy class and the DI columns that hold it, and ${mapped} SKOS mappings to FIBO, checked against FIBO ${o.fibo.commit.slice(0, 7)}. It opens in Protégé or loads into any triple store; it names FIBO’s classes rather than importing FIBO.`,
        sources,
        suggestions: ['How does DI line up with FIBO?', 'What is a share draft in FIBO?'],
      };
    },
  };
}

function ontoCoverageTool(spec: ModuleSpec, onto: OntologyService, need: (ctx: ModuleContext) => void, sources: ModuleSpec['sources']) {
  return {
    name: 'onto_coverage',
    description: 'How much of DI the data dictionary (DI’s ontology) covers: concepts, properties, code lists, DI columns bound, measures tied to a concept, and core columns mapped by vendor.',
    input: z.object({}).strict(),
    run: async (_: unknown, ctx: ModuleContext) => {
      need(ctx);
      const x = await onto.coverage();
      if (!x) return { text: 'DI’s data dictionary isn’t loaded for this institution yet.' };
      const vendors = x.vendors.map((v) => `${v.system === 'symitar' ? 'Symitar' : v.system}, ${v.columns} columns`).join('; ');
      return {
        text: `DI’s data dictionary (version ${x.version}) has **${x.classes} concepts** and **${x.properties} properties**, with ${x.valueSets} code lists and ${x.codes} codes. It ties **${x.columns.toLocaleString('en-US')} DI columns** to what they mean and **${x.metrics} measures** to what they measure.${vendors ? ` Core mappings as data: ${vendors}.` : ''}${x.fibo.classes ? ` **${x.fibo.classes} of ${x.classes} concepts**, ${x.fibo.properties} properties and ${x.fibo.codes} codes are linked to FIBO, the industry’s standard financial ontology, each checked against FIBO’s own definition.` : ''} The build fails if a main table gains a column the dictionary doesn’t cover.`,
        blocks: [moduleTable(spec, 'What the data dictionary covers', ctx.runId, 'catalog.ontology.coverage', [{ field: 'what', headerName: 'What', type: 'text' }, { field: 'count', headerName: 'Count', type: 'count' }], [
          { what: 'Concepts', count: x.classes },
          { what: 'Properties', count: x.properties },
          { what: 'Code lists', count: x.valueSets },
          { what: 'Codes', count: x.codes },
          { what: 'DI columns bound', count: x.columns },
          { what: 'Measures tied to a concept', count: x.metrics },
          { what: 'Concepts linked to FIBO', count: x.fibo.classes },
          { what: 'Properties linked to FIBO', count: x.fibo.properties },
          { what: 'Codes linked to FIBO', count: x.fibo.codes },
          ...x.vendors.map((v) => ({ what: `${v.system === 'symitar' ? 'Symitar' : v.system} columns mapped`, count: v.columns })),
        ])],
        sources,
        suggestions: ['What does DI mean by a share draft?', 'What is a home equity line in FIBO?', 'Which Symitar column is the loan balance?'],
      };
    },
  };
}

// ---- AI usage and governance --------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthLabel = (m: string) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-15T00:00:00Z`));
const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n < 0.01 ? 4 : 2 }).format(n);
const monthIn = (t: string) => {
  const i = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`, 'i').test(t));
  return i < 0 ? undefined : MONTHS[i];
};
const GROUP_LABEL: Record<UsageGroup, string> = { user: 'Person', class: 'Class', agent: 'Agent', model: 'Model' };

/** The Agent Audit Log's reader (the permanent audit store), when there is one. */
export interface AuditLogReader {
  runs(f: { userId?: string; agent?: string; outcome?: string; days?: number; q?: string; limit?: number }, everyone: boolean): Promise<AuditLogPage>;
  trace(runId: string): Promise<(AuditRunTrace & { ownerId: string }) | null>;
}

const OUTCOME_WORDS: Record<string, string> = { answer: 'Answered', approval_requested: 'Sent for approval', clarify: 'Asked to clarify', unmatched: 'No measure for it', not_supported: 'Out of scope', no_access: 'Refused: access', failed: 'Failed', cancelled: 'Stopped', scripted: 'Sample scenario', not_found: 'Not found' };
const seconds = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const DAYS: Record<string, number> = { today: 1, week: 7, month: 30, quarter: 90 };
/** Answers read from the audit store name it, not the usage ledger the module's other answers read. */
const AUDIT_SOURCES = [{ kind: 'table' as const, label: 'Agent Audit Log', ref: 'table:ai_audit_event' }];
const withSources = <B extends { provenance: { sources?: unknown[] } }>(b: B, sources: typeof AUDIT_SOURCES): B => ({ ...b, provenance: { ...b.provenance, sources } });

export function governanceModule(gov: GovernanceService, year: () => number, trail: () => AuditLogReader | undefined = () => undefined): ModuleSpec {
  const noAccess = 'AI usage reports need the AI usage permission. You can ask about your own usage.';
  const admin = (ctx: ModuleContext) => {
    if (!ctx.modules.includes('ai-admin')) throw new CoreError('NO_ACCESS', noAccess);
  };
  const resolve = async (month: string | undefined, userId?: string) => {
    if (month) {
      const i = MONTHS.indexOf(month.toLowerCase());
      if (i < 0) throw new CoreError('INVALID', 'Which month?');
      return `${year()}-${String(i + 1).padStart(2, '0')}`;
    }
    const m = await gov.latestMonth(userId);
    if (!m) throw new CoreError('NOT_FOUND', 'There’s no AI usage recorded yet.');
    return m;
  };
  const spec: ModuleSpec = {
    id: 'governance',
    prefix: 'gov',
    agent: 'AI Governance',
    request: /\baudit (log|trail)\b|\bagent runs?\b|\b(failed|refused) runs?\b|\bruns? (that )?(failed|were refused)\b|\bAI (cost|usage|spend)\b|\btokens?\b|\b(run )?trace (for|of) (run )?R-|\bR-\d{8}-\w+\b|\bhigh[- ]risk approvals?\b|\bapprovals? (made )?through agents\b|\bhow much have I used\b|\bmy (AI )?usage\b|\b(answer|negative|user) feedback\b|\bthumbs[- ]down\b/i,
    noAccess,
    sources: [{ kind: 'table', label: 'AI usage ledger', ref: 'table:ai_run' }],
    prompt: ({ tenant, user, title }) => `You are the AI Governance agent inside Kinective Data Intelligence (DI) for ${tenant}. ${user} (${title}) is asking what the AI has done.

- "Show AI cost by agent for October", "Who used the most tokens last month?": gov_usage.
- "How much have I used this month?": gov_my_usage.
- "Open the trace for run R-20261026-0042", "How did DI work out run R-…?": gov_trace.
- "Show the audit log", "Which agent runs failed this week, and why?", "What did the Referrals agent do today?": gov_audit_log.
- "Show every high-risk approval made through agents this month": gov_approvals.
- "Show the negative feedback": gov_feedback.
- Everything here is read only.`,
    plan: (text) => {
      const t = clean(text);
      const month = monthIn(t);
      const when = month ? { month } : {};
      const run = /\bR-\d{8}-\w+\b/.exec(t)?.[0];
      if (run) return { tool: 'gov_trace', args: { run_id: run } };
      if (/\baudit (log|trail)\b|\bagent runs?\b|\b(failed|refused) runs?\b|\bruns? (that )?(failed|were refused)\b/i.test(t)) {
        const period = /\btoday\b/i.test(t) ? 'today' : /\bmonth\b|\b30 days\b/i.test(t) ? 'month' : /\bquarter\b|\b90 days\b/i.test(t) ? 'quarter' : 'week';
        const outcome = /\brefused\b|\baccess\b/i.test(t) ? 'no_access' : /\bfail/i.test(t) ? 'failed' : /\bproblems?\b|\bwent wrong\b/i.test(t) ? 'problems' : undefined;
        return { tool: 'gov_audit_log', args: { period, ...(outcome ? { outcome } : {}) } };
      }
      if (/\bapprovals?\b/i.test(t)) return { tool: 'gov_approvals', args: { ...when, ...(/\bhigh[- ]risk\b/i.test(t) ? { risk: 'high' } : {}) } };
      if (/\bfeedback\b|\bthumbs\b/i.test(t)) return { tool: 'gov_feedback', args: {} };
      if (/\bhow much have I\b|\bmy\b/i.test(t) && !/\bmy team\b/i.test(t)) return { tool: 'gov_my_usage', args: when };
      const by = /\bby class\b/i.test(t) ? 'class' : /\bby model\b/i.test(t) ? 'model' : /\bby (agent)\b/i.test(t) ? 'agent' : /\bby (user|person)\b|\bwho\b/i.test(t) ? 'user' : 'agent';
      return { tool: 'gov_usage', args: { group_by: by, ...when } };
    },
    tools: [
      {
        name: 'gov_usage',
        description: 'Tokens, cost, prompts, tool calls and approvals for a month, by person, class, agent or model. Needs the AI usage permission.',
        input: z.object({ group_by: z.enum(['user', 'class', 'agent', 'model']).default('agent'), month: z.string().max(12).optional().describe('A month name. Leave out for the latest month.') }).strict(),
        run: async (a: { group_by: UsageGroup; month?: string }, ctx) => {
          admin(ctx);
          const month = await resolve(a.month);
          const u = await gov.usage(month, a.group_by);
          if (!u.items.length) return { text: `There’s no AI usage recorded for ${monthLabel(month)}.` };
          const top = u.items[0]!;
          return { text: `In ${monthLabel(month)}, DI ran **${plural(u.totals.prompts, 'prompt')}** for **${usd(u.totals.cost)}**, using ${u.totals.tokens.toLocaleString('en-US')} tokens. **${top.name}** cost the most, at ${usd(top.cost)}. Tokens and cost cover the model only; voice isn’t included yet.`, blocks: [moduleTable(spec, `AI usage by ${GROUP_LABEL[a.group_by].toLowerCase()}, ${monthLabel(month)}`, ctx.runId, 'ai.usage.report', [{ field: 'name', headerName: GROUP_LABEL[a.group_by], type: 'text' }, { field: 'prompts', headerName: 'Prompts', type: 'count' }, { field: 'tokens', headerName: 'Tokens', type: 'count' }, { field: 'tools', headerName: 'Tool calls', type: 'count' }, { field: 'approvals', headerName: 'Approvals', type: 'count' }, { field: 'cost', headerName: 'Cost', type: 'text' }], u.items.map((i) => ({ name: i.name, prompts: i.prompts, tokens: i.tokens, tools: i.tools, approvals: i.approvals, cost: usd(i.cost) })))] };
        },
      },
      {
        name: 'gov_my_usage',
        description: 'The person’s own AI usage for a month. Anyone can ask.',
        input: z.object({ month: z.string().max(12).optional() }).strict(),
        run: async (a: { month?: string }, ctx) => {
          const month = await resolve(a.month, ctx.user.id);
          const u = await gov.own(ctx.user.id, month);
          return { text: u.prompts ? `In ${monthLabel(month)} you ran **${plural(u.prompts, 'prompt')}**, using ${u.tokens.toLocaleString('en-US')} tokens, for about ${usd(u.cost)}.` : `You have no AI usage recorded for ${monthLabel(month)}.` };
        },
      },
      {
        name: 'gov_trace',
        description: 'Every step of one run: prompt, tool calls with parameters, approvals with approver and channel, and cost. Your own runs, or any with the AI usage permission.',
        input: z.object({ run_id: z.string().regex(/^R-\d{8}-\w+$/).max(40) }).strict(),
        run: async (a: { run_id: string }, ctx) => {
          // The full trace from the audit store when there is one: every step in order, with its timing.
          const full = await trail()?.trace(a.run_id);
          if (full) {
            if (full.ownerId !== ctx.user.id && !ctx.modules.includes('ai-admin')) throw new CoreError('NOT_FOUND', 'That run was not found, or it is not yours to see.');
            const failed = full.timeline.filter((e) => e.status === 'failed').length;
            const tokens = full.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0);
            const rows = full.timeline.map((e) => ({ at: e.offsetMs === null ? '—' : seconds(e.offsetMs), step: e.title, by: [e.agent, e.operation].filter(Boolean).join(' · ') || '—', detail: (e.detail ?? '').replace(/\s+/g, ' ').slice(0, 200), status: e.status === 'failed' ? 'Failed' : e.status === 'started' ? 'Started' : e.status === 'waiting' ? 'Waiting' : e.status === 'skipped' ? 'Skipped' : 'Done' }));
            return {
              text: `Run **${full.runId}**: **${full.user.name}** asked “${full.question}”. **${full.agent}** handled it in ${seconds(full.durationMs)}, in ${plural(full.timeline.length, 'step')}${failed ? `, **${failed} of them failed**` : ''}, using ${plural(tokens, 'token')} for ${usd(full.costUsd)}. The outcome: ${(OUTCOME_WORDS[full.outcome] ?? full.outcome).toLowerCase()}. The full trace, with each tool call’s inputs, is in the Agent Audit Log.`,
              blocks: [withSources(moduleTable(spec, `Trace of ${full.runId}`, ctx.runId, 'ai.trace.get', [{ field: 'at', headerName: 'At', type: 'text' }, { field: 'step', headerName: 'Step', type: 'text' }, { field: 'by', headerName: 'Agent or operation', type: 'text' }, { field: 'detail', headerName: 'Detail', type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }], rows), AUDIT_SOURCES)],
              sources: AUDIT_SOURCES,
            };
          }
          const t = await gov.trace(a.run_id, { userId: ctx.user.id, all: ctx.modules.includes('ai-admin') });
          const steps = [...t.tools.map((c) => ({ step: 'Tool call', operation: c.name, detail: JSON.stringify(c.input ?? {}).slice(0, 160), ms: c.ms ? `${c.ms} ms` : '—', result: c.ok ? 'OK' : `Failed${c.error ? `, ${c.error}` : ''}` })), ...t.approvals.map((p) => ({ step: 'Approval', operation: p.operation, detail: `${p.risk} risk`, ms: '—', result: `${p.status}, ${p.by} by ${p.channel}` }))];
          return { text: `Run **${t.runId}**, ${t.at}: **${t.user}** asked “${t.question}”. ${t.agent} handled it${t.model ? ` on ${t.model}` : ''}, using ${(t.inputTokens + t.outputTokens).toLocaleString('en-US')} tokens for ${usd(t.cost)}. The outcome was ${t.outcome.replaceAll('_', ' ')}.`, blocks: steps.length ? [moduleTable(spec, `Trace of ${t.runId}`, ctx.runId, 'ai.trace.get', [{ field: 'step', headerName: 'Step', type: 'text' }, { field: 'operation', headerName: 'Operation', type: 'text' }, { field: 'detail', headerName: 'Parameters', type: 'text' }, { field: 'ms', headerName: 'Duration', type: 'text' }, { field: 'result', headerName: 'Result', type: 'text' }], steps)] : [] };
        },
      },
      {
        name: 'gov_audit_log',
        description: 'The Agent Audit Log: agent runs over a period, with who asked, which agent answered, how it ended, steps and time. Everyone with the AI usage permission, otherwise the person’s own runs. Filter by outcome (failed, refused for access, or any problem) or agent.',
        input: z
          .object({
            period: z.enum(['today', 'week', 'month', 'quarter']).default('week'),
            outcome: z.enum(['failed', 'no_access', 'problems', 'approval_requested']).optional(),
            agent: z.string().max(60).optional().describe('An agent name, such as Referrals or Analytics Q&A'),
          })
          .strict(),
        run: async (a: { period: string; outcome?: string; agent?: string }, ctx) => {
          const reader = trail();
          if (!reader) throw new CoreError('NOT_FOUND', 'The audit log isn’t set up in this environment yet.');
          const everyone = ctx.modules.includes('ai-admin');
          const days = DAYS[a.period] ?? 7;
          const page = await reader.runs({ days, outcome: a.outcome, agent: a.agent, userId: everyone ? undefined : ctx.user.id, limit: 25 }, everyone);
          const when = a.period === 'today' ? 'today' : `in the last ${days} days`;
          const what = a.outcome === 'failed' ? 'failed runs' : a.outcome === 'no_access' ? 'runs refused for access' : a.outcome === 'problems' ? 'runs that went wrong' : a.outcome === 'approval_requested' ? 'runs sent for approval' : 'agent runs';
          const whose = everyone ? '' : ' of yours';
          if (!page.items.length) return { text: `No ${what}${whose} ${when}${a.agent ? ` by ${a.agent}` : ''}.`, sources: AUDIT_SOURCES };
          // Why runs failed: the recorded error of each, in the person's words where there is one.
          const why = a.outcome === 'failed' || a.outcome === 'problems' ? await Promise.all(page.items.slice(0, 5).map((r) => reader.trace(r.runId).then((t) => t?.error ?? t?.timeline.findLast((e) => e.status === 'failed')?.title ?? null, () => null))) : [];
          const reasons = why.filter((w): w is string => Boolean(w));
          const lead = `**${plural(page.total, what.replace(/s$/, ''), what)}**${whose} ${when}${a.agent ? ` by ${a.agent}` : ''}.`;
          return {
            text: `${lead}${reasons.length ? ` What went wrong, newest first: ${[...new Set(reasons)].slice(0, 3).map((r) => `“${r.slice(0, 160)}”`).join('; ')}.` : ''} Each run’s full trace is in the Agent Audit Log.`,
            blocks: [
              withSources(moduleTable(
                spec,
                `Agent runs ${when}`,
                ctx.runId,
                'ai.audit.list',
                [
                  { field: 'at', headerName: 'When', type: 'date' },
                  ...(everyone ? [{ field: 'person', headerName: 'Person', type: 'text' as const }] : []),
                  { field: 'agent', headerName: 'Agent', type: 'text' },
                  { field: 'question', headerName: 'Question', type: 'text' },
                  { field: 'outcome', headerName: 'Outcome', type: 'text' },
                  { field: 'time', headerName: 'Time', type: 'text' },
                  { field: 'runId', headerName: 'Run', type: 'text' },
                ],
                page.items.map((r) => ({ at: r.at.replace(/\.\d+Z$/, 'Z'), person: r.user.name, agent: r.agent, question: r.question, outcome: OUTCOME_WORDS[r.outcome] ?? r.outcome, time: seconds(r.durationMs), runId: r.runId })),
              ), AUDIT_SOURCES),
            ],
            suggestions: [`Open the trace for run ${page.items[0]!.runId}`],
            sources: AUDIT_SOURCES,
          };
        },
      },
      {
        name: 'gov_approvals',
        description: 'Decisions on agent changes in a month, with approver, channel and run. Needs the AI usage permission.',
        input: z.object({ risk: z.enum(['low', 'medium', 'high']).optional(), month: z.string().max(12).optional() }).strict(),
        run: async (a: { risk?: string; month?: string }, ctx) => {
          admin(ctx);
          const month = a.month ? await resolve(a.month) : new Date().toISOString().slice(0, 7);
          let list = await gov.approvals(month, a.risk);
          let shown = month;
          // Nothing yet this month: the last month with a decision is what the question is after.
          if (!list.length && !a.month) {
            const latest = await resolve(undefined);
            list = await gov.approvals(latest, a.risk);
            shown = latest;
          }
          const what = a.risk ? `${a.risk}-risk ` : '';
          if (!list.length) return { text: `No ${what}approvals were decided in ${monthLabel(shown)}.` };
          return { text: `**${plural(list.length, `${what}approval`)}** decided in ${monthLabel(shown)}.`, blocks: [moduleTable(spec, 'Approvals through agents', ctx.runId, 'audit.approvals.list', [{ field: 'summary', headerName: 'Change', type: 'text' }, { field: 'status', headerName: 'Status', type: 'text' }, { field: 'by', headerName: 'Decided by', type: 'text' }, { field: 'channel', headerName: 'Channel', type: 'text' }, { field: 'at', headerName: 'When', type: 'text' }, { field: 'runId', headerName: 'Run', type: 'text' }], list)], suggestions: [`Open the trace for run ${list[0]!.runId}`] };
        },
      },
      {
        name: 'gov_feedback',
        description: 'The review queue of ratings on DI’s answers, thumbs down first, and notes sent with the Feedback button. Needs the AI usage permission.',
        input: z.object({}).strict(),
        run: async (_: unknown, ctx) => {
          admin(ctx);
          const list = await gov.feedbackQueue();
          if (!list.length) return { text: 'Nobody has rated an answer yet.' };
          const down = list.filter((f) => f.rating === 'down').length;
          const notes = list.filter((f) => f.rating === 'note').length;
          return { text: `**${plural(list.length - notes, 'rating')}** on DI’s answers, ${down} thumbs down${notes ? `, and ${plural(notes, 'note')} from the Feedback button` : ''}.`, blocks: [moduleTable(spec, 'Answer feedback', ctx.runId, 'ai.feedback.list', [{ field: 'rating', headerName: 'Rating', type: 'text' }, { field: 'question', headerName: 'Question', type: 'text' }, { field: 'comment', headerName: 'Comment', type: 'text' }, { field: 'agent', headerName: 'Agent', type: 'text' }, { field: 'by', headerName: 'From', type: 'text' }, { field: 'runId', headerName: 'Run', type: 'text' }], list.map((f) => ({ rating: f.rating === 'down' ? 'Thumbs down' : 'Thumbs up', question: f.question, comment: f.comment, agent: f.agent, by: f.by, runId: f.runId })))] };
        },
      },
    ],
  };
  return spec;
}
