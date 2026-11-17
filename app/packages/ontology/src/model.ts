// Loads and checks the DI Next ontology (design: Core Mapping and Ontology, phase 1): the classes of
// things credit unions and banks deal in, their properties and the DI columns that hold them, code
// lists, and each core vendor's vocabulary and standard mapping. Everything here is reviewed data in
// model/; the loader fails on any reference that doesn't resolve.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const MODEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'model');
const SEMANTIC_STOCK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'semantic', 'models', 'stock', 'model.yaml');

const ident = z.string().regex(/^[a-z][a-z0-9_]*$/);
const column = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
const byType = z.object({ credit_union: z.string().optional(), bank: z.string().optional() }).strict().optional();
const synonyms = z.object({ credit_union: z.array(z.string()).optional(), bank: z.array(z.string()).optional() }).strict().optional();

export const SEMANTIC_TYPES = ['identifier', 'reference', 'text', 'code', 'money', 'rate', 'percent', 'ratio', 'count', 'date', 'flag', 'score', 'number'] as const;
export const PRIVACY = ['direct', 'quasi', 'financial', 'none'] as const;

const ClassSchema = z.object({
  label: z.string(),
  labels_by_type: byType,
  parent: ident.optional(),
  definition: z.string(),
  fibo: z.string().optional(),
  synonyms,
  relations: z.array(z.object({ predicate: ident, to: ident }).strict()).default([]),
}).strict();

const PropertySchema = z.object({
  label: z.string(),
  labels_by_type: byType,
  type: z.enum(SEMANTIC_TYPES),
  value_set: ident.optional(),
  refers_to: ident.optional(),
  privacy: z.enum(PRIVACY),
  aggregate: z.boolean().default(false),
  definition: z.string().optional(),
  constraints: z.object({ min: z.number().optional(), max: z.number().optional(), not_after_as_of: z.boolean().optional() }).strict().optional(),
  synonyms,
  /** How a core column of another kind can give this property: a due date gives days past due. */
  derive: z.array(z.object({ transform: z.enum(['same', 'number', 'date8', 'code', 'rate1000', 'daysPast', 'not', 'nonzero']), from: z.enum(['date', 'flag', 'code', 'number', 'money', 'text', 'key', 'reference']), words: z.array(z.string()).min(1) }).strict()).default([]),
  realized_by: z.array(column).min(1),
}).strict();

const ValueSetSchema = z.object({
  label: z.string(),
  open: z.boolean().default(false),
  codes: z.record(ident, z.object({ label: z.string(), labels_by_type: byType, values: z.array(z.string()).min(1) }).strict()),
}).strict();

export const TRANSFORMS = ['same', 'number', 'date8', 'code', 'rate1000', 'daysPast', 'not', 'nonzero'] as const;

const VendorSchema = z.object({
  id: ident,
  label: z.string(),
  short: z.string(),
  process_date: z.string().optional(),
  encodings: z.record(ident, z.string()).default({}),
  vocabulary: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.object({
    description: z.string(),
    columns: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.object({ description: z.string(), encoding: ident.optional(), code_set: z.string().optional() }).strict()),
  }).strict()),
  codes: z.record(z.string(), z.object({ code_set_of: ident, crosswalk: z.record(z.string(), ident) }).strict()).default({}),
  tables: z.array(z.object({
    di_table: ident,
    label: z.string(),
    their_tables: z.array(z.string()).min(1),
    from: z.string(),
    key: ident,
    columns: z.array(z.object({ di: ident, their: z.string().regex(/^[a-z]\.[A-Z][A-Z0-9_]*$/), how: z.enum(TRANSFORMS).default('same'), codes: z.string().optional(), denotes: z.string() }).strict()),
  }).strict()).default([]),
}).strict();

export type OntologyClass = z.infer<typeof ClassSchema> & { id: string };
export type OntologyProperty = z.infer<typeof PropertySchema> & { id: string; class: string };
export type ValueSet = z.infer<typeof ValueSetSchema> & { id: string };
export type VendorPack = z.infer<typeof VendorSchema>;

export interface Ontology {
  version: string;
  classes: Map<string, OntologyClass>;
  properties: Map<string, OntologyProperty>;
  valueSets: Map<string, ValueSet>;
  vendors: Map<string, VendorPack>;
  /** table.column to the property it realizes. */
  columnIndex: Map<string, string>;
  /** How core names abbreviate words (div: dividend), and extra words the name splitter knows. */
  abbreviations: Map<string, string>;
  words: Set<string>;
  /** How cores abbreviate code values (CHK: checking), for proposing a code crosswalk. */
  codeWords: Map<string, string>;
}

/** The core tables in a vendor mapping's FROM, by alias: "ACCOUNT a JOIN NAME n ON ..." gives a and n. */
export const fromAliases = (from: string) => new Map([...from.matchAll(/(?:^|\bJOIN)\s*([A-Z][A-Z0-9_]*)\s+([a-z])\b/g)].map((m) => [m[2]!, m[1]!]));

const read = (file: string) => parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

/** Loads model/ and checks every reference: parents, relations, value sets, property targets, columns claimed twice, and each vendor's mapping. */
export function loadOntology(dir = MODEL_DIR): Ontology {
  const errors: string[] = [];
  const top = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), classes: z.record(ident, ClassSchema) }).strict().parse(read(join(dir, 'classes.yaml')));
  const props = z.object({ properties: z.record(ident, z.record(ident, PropertySchema)) }).strict().parse(read(join(dir, 'properties.yaml')));
  const values = z.object({ value_sets: z.record(ident, ValueSetSchema) }).strict().parse(read(join(dir, 'values.yaml')));

  const classes = new Map(Object.entries(top.classes).map(([id, c]) => [id, { ...c, id }]));
  for (const c of classes.values()) {
    if (c.parent && !classes.has(c.parent)) errors.push(`class ${c.id}: parent ${c.parent} isn't a class`);
    for (const r of c.relations) if (!classes.has(r.to)) errors.push(`class ${c.id}: relation ${r.predicate} names ${r.to}, which isn't a class`);
  }
  const valueSets = new Map(Object.entries(values.value_sets).map(([id, v]) => [id, { ...v, id }]));
  const properties = new Map<string, OntologyProperty>();
  const columnIndex = new Map<string, string>();
  for (const [cls, list] of Object.entries(props.properties)) {
    if (!classes.has(cls)) errors.push(`properties under ${cls}, which isn't a class`);
    for (const [name, p] of Object.entries(list)) {
      const id = `${cls}.${name}`;
      properties.set(id, { ...p, id, class: cls });
      if (p.type === 'code' && p.value_set === undefined && cls !== 'regulatory_line') errors.push(`${id}: a code needs a value_set`);
      if (p.value_set && !valueSets.has(p.value_set)) errors.push(`${id}: value set ${p.value_set} doesn't exist`);
      if (p.type === 'reference' && (!p.refers_to || !classes.has(p.refers_to))) errors.push(`${id}: a reference needs refers_to naming a class`);
      for (const col of p.realized_by) {
        const prior = columnIndex.get(col);
        if (prior) errors.push(`${col} is claimed by both ${prior} and ${id}`);
        columnIndex.set(col, id);
      }
    }
  }
  const vendors = new Map<string, VendorPack>();
  for (const f of readdirSync(join(dir, 'vendors')).filter((x) => x.endsWith('.yaml'))) {
    const v = VendorSchema.parse(read(join(dir, 'vendors', f)));
    vendors.set(v.id, v);
    for (const [set, c] of Object.entries(v.codes)) {
      const vs = valueSets.get(c.code_set_of);
      if (!vs) errors.push(`${v.id} codes ${set}: value set ${c.code_set_of} doesn't exist`);
      else for (const [their, code] of Object.entries(c.crosswalk)) if (!vs.codes[code]) errors.push(`${v.id} codes ${set}: ${their} crosswalks to ${code}, not a code of ${vs.id}`);
    }
    for (const t of v.tables) {
      const aliases = fromAliases(t.from);
      for (const c of t.columns) {
        const p = properties.get(c.denotes);
        if (!p) errors.push(`${v.id} ${t.di_table}.${c.di}: denotes ${c.denotes}, which isn't a property`);
        else if (!p.realized_by.includes(`${t.di_table}.${c.di}`)) errors.push(`${v.id} ${t.di_table}.${c.di}: denotes ${c.denotes}, but that property isn't held in ${t.di_table}.${c.di}`);
        const [alias, col] = c.their.split('.') as [string, string];
        const table = aliases.get(alias);
        if (!table) errors.push(`${v.id} ${t.di_table}.${c.di}: alias ${alias} isn't in the mapping's FROM`);
        else if (!v.vocabulary[table]?.columns[col]) errors.push(`${v.id} ${t.di_table}.${c.di}: ${table}.${col} isn't in the vocabulary`);
        if (c.how === 'code' && (!c.codes || !v.codes[c.codes])) errors.push(`${v.id} ${t.di_table}.${c.di}: a code transform needs a code set from codes`);
      }
    }
  }
  // Classes, properties, code lists and codes share one namespace in the database.
  const seen = new Map<string, string>();
  const claim = (id: string, what: string) => {
    const prior = seen.get(id);
    if (prior) errors.push(`${id} is both ${prior} and ${what}`);
    seen.set(id, what);
  };
  for (const id of classes.keys()) claim(id, 'a class');
  for (const id of properties.keys()) claim(id, 'a property');
  for (const vs of valueSets.values()) {
    claim(vs.id, 'a code list');
    for (const code of Object.keys(vs.codes)) claim(`${vs.id}.${code}`, 'a code');
    // The database compares values without regard to case, so Email and email would be one value.
    const values = new Map<string, string>();
    for (const [code, c] of Object.entries(vs.codes)) for (const v of c.values) {
      const prior = values.get(v.toLowerCase());
      if (prior) errors.push(`${vs.id}: ${v} is listed twice (${prior} and ${code}), ignoring case`);
      values.set(v.toLowerCase(), code);
    }
  }
  if (errors.length) throw new Error(`The ontology doesn't load:\n- ${errors.join('\n- ')}`);
  const abbr = z.object({ abbreviations: z.record(z.string().regex(/^[a-z]+$/), z.string()), code_words: z.record(z.string().regex(/^[a-z]+$/), z.string()).default({}), words: z.array(z.string().regex(/^[a-z]+$/)) }).strict().parse(read(join(dir, 'abbreviations.yaml')));
  return { version: top.version, classes, properties, valueSets, vendors, columnIndex, abbreviations: new Map(Object.entries(abbr.abbreviations)), words: new Set(abbr.words), codeWords: new Map(Object.entries(abbr.code_words)) };
}

let cached: Ontology | null = null;
/** The ontology from model/, loaded once. */
export const ontology = () => (cached ??= loadOntology());

// ---- Metrics: which properties each semantic-model metric measures -------------------------------

interface Semantic {
  sources: Record<string, { table: string; alias: string; joins?: string[]; filters?: string[]; time_column?: string; purview_column?: string }>;
  measures: Record<string, { exprs?: Record<string, string> }>;
  metrics: Record<string, { label?: string; measure?: string; numerator?: string; denominator?: string; measures?: string[]; type?: string; [k: string]: unknown }>;
}

/** The semantic model's stock file, read as data (the semantic package depends on the tenant database; this doesn't). */
export const readSemanticStock = (file = SEMANTIC_STOCK) => parse(readFileSync(file, 'utf8')) as Semantic;

/** Every table.column an expression reads, given a source's aliases and any FROM or JOIN inside the expression. */
export function columnsRead(expr: string, aliases: Record<string, string>): { columns: string[]; unresolved: string[] } {
  const local = { ...aliases };
  for (const m of expr.matchAll(/\b(?:FROM|JOIN)\s+([a-z]\w*)\s+(?:AS\s+)?([a-z]\w*)\b/gi)) local[m[2]!] = m[1]!;
  const columns = new Set<string>();
  const unresolved = new Set<string>();
  for (const m of expr.matchAll(/\b([a-z]\w*)\.([a-z_]\w*)\b/g)) {
    if (m[1] === 'setting') continue;
    const t = local[m[1]!];
    if (t) columns.add(`${t}.${m[2]}`);
    else unresolved.add(`${m[1]}.${m[2]}`);
  }
  return { columns: [...columns], unresolved: [...unresolved] };
}

export const sourceAliases = (src: Semantic['sources'][string]) => {
  const a: Record<string, string> = { [src.alias]: src.table };
  for (const j of src.joins ?? []) for (const m of j.matchAll(/JOIN\s+(\w+)\s+(?:AS\s+)?(\w+)/gi)) a[m[2]!] = m[1]!;
  return a;
};

/** For each metric: the measures behind it, the columns they read, and the properties those columns hold. */
export function metricBindings(o: Ontology, sem: Semantic = readSemanticStock()) {
  // The class a table holds: the class of the property realized by its key or, failing that, most of its columns.
  const classOfTable = (table: string) => {
    const tally = new Map<string, number>();
    for (const [col, prop] of o.columnIndex) if (col.startsWith(`${table}.`)) {
      const cls = o.properties.get(prop)!.class;
      tally.set(cls, (tally.get(cls) ?? 0) + (prop.endsWith('.id') || prop.endsWith('.number') ? 100 : 1));
    }
    return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const measureColumns = (name: string) => {
    const m = sem.measures[name];
    const cols = new Set<string>();
    const unresolved = new Set<string>();
    const counts = new Set<string>();
    for (const [src, expr] of Object.entries(m?.exprs ?? {})) {
      const s = sem.sources[src];
      if (!s) continue;
      const r = columnsRead(String(expr), sourceAliases(s));
      r.columns.forEach((c) => cols.add(c));
      r.unresolved.forEach((c) => unresolved.add(`${src}:${c}`));
      // COUNT(*) counts the source's rows: the class its table holds.
      if (/COUNT\(\s*\*\s*\)/i.test(String(expr))) {
        const cls = classOfTable(s.table);
        if (cls) counts.add(cls);
      }
    }
    return { cols, unresolved, counts };
  };
  return Object.entries(sem.metrics).map(([name, m]) => {
    const used = [m.measure, m.numerator, m.denominator, ...(Array.isArray(m.measures) ? m.measures : [])].filter((x): x is string => typeof x === 'string');
    const cols = new Set<string>();
    const unresolved = new Set<string>();
    const counted = new Set<string>();
    for (const u of used) {
      const r = measureColumns(u);
      r.cols.forEach((c) => cols.add(c));
      r.unresolved.forEach((c) => unresolved.add(c));
      r.counts.forEach((c) => counted.add(c));
    }
    const properties = [...new Set([...cols].map((c) => o.columnIndex.get(c)).filter((p): p is string => !!p))].sort();
    const unbound = [...cols].filter((c) => !o.columnIndex.has(c)).sort();
    // A regulatory line the metric reads, by its code: cv.code = '115', fv.code = 'RIAD4107'.
    const lines = new Set<string>();
    for (const u of used) for (const expr of Object.values(sem.measures[u]?.exprs ?? {})) for (const x of String(expr).matchAll(/\.code\s*=\s*'([A-Z0-9]+)'/g)) lines.add(x[1]!);
    return { metric: name, label: m.label ?? name, measures: used, columns: [...cols].sort(), properties, counts: [...counted].sort(), unbound, unresolved: [...unresolved], lines: [...lines].sort() };
  });
}

/** Every table.column the semantic model reads anywhere: measures, dimensions, filters, time and purview columns. */
export function semanticColumns(sem: Semantic = readSemanticStock() as Semantic & { dimensions?: Record<string, { exprs?: Record<string, string> }> }) {
  const out = new Set<string>();
  const scan = (src: string, expr: string) => {
    const s = sem.sources[src];
    if (s) columnsRead(expr, sourceAliases(s)).columns.forEach((c) => out.add(c));
  };
  for (const m of Object.values(sem.measures)) for (const [s, e] of Object.entries(m.exprs ?? {})) scan(s, String(e));
  for (const d of Object.values((sem as unknown as { dimensions: Record<string, { exprs?: Record<string, string> }> }).dimensions ?? {})) for (const [s, e] of Object.entries(d.exprs ?? {})) scan(s, String(e));
  for (const [n, s] of Object.entries(sem.sources)) for (const f of [...(s.filters ?? []), s.time_column, s.purview_column].filter((x): x is string => !!x)) scan(n, f);
  return [...out].sort();
}
