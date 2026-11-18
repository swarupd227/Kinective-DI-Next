// The ontology as rows for each tenant database (onto_* and core_* tables), so agents and SQL can
// look concepts up and walk from a core column to a DI column, a metric and a report.
import { fromAliases, metricBindings, type Ontology } from './model.ts';

export const ONTOLOGY_TABLES = ['onto_concept', 'onto_edge', 'onto_term', 'onto_value', 'core_vocab', 'core_denotes'] as const;

export const ONTOLOGY_DDL = [
  `CREATE TABLE IF NOT EXISTS onto_concept (
     concept_id VARCHAR(80) PRIMARY KEY,
     kind VARCHAR(12) NOT NULL,
     label VARCHAR(120) NOT NULL,
     label_cu VARCHAR(120) NULL,
     label_bank VARCHAR(120) NULL,
     parent_id VARCHAR(80) NULL,
     semantic_type VARCHAR(12) NULL,
     value_set VARCHAR(40) NULL,
     refers_to VARCHAR(40) NULL,
     privacy VARCHAR(10) NULL,
     is_aggregate TINYINT NOT NULL DEFAULT 0,
     constraints JSON NULL,
     definition VARCHAR(600) NULL,
     model_version VARCHAR(12) NOT NULL,
     KEY ix_onto_concept_parent (parent_id)
   )`,
  // subclass_of, has_property, a class relation (held_in, secured_by, ...), realized_by (a DI column),
  // measured_by (a semantic-model metric), in_value_set, denoted_by (a core column).
  `CREATE TABLE IF NOT EXISTS onto_edge (
     subject_id VARCHAR(80) NOT NULL,
     predicate VARCHAR(40) NOT NULL,
     object_id VARCHAR(120) NOT NULL,
     detail VARCHAR(200) NULL,
     PRIMARY KEY (subject_id, predicate, object_id),
     KEY ix_onto_edge_object (object_id, predicate)
   )`,
  `CREATE TABLE IF NOT EXISTS onto_term (
     term VARCHAR(120) NOT NULL,
     concept_id VARCHAR(80) NOT NULL,
     scope VARCHAR(16) NOT NULL,
     kind VARCHAR(10) NOT NULL,
     PRIMARY KEY (term, concept_id, scope),
     KEY ix_onto_term_concept (concept_id)
   )`,
  `CREATE TABLE IF NOT EXISTS onto_value (
     value_set VARCHAR(40) NOT NULL,
     code VARCHAR(40) NOT NULL,
     label VARCHAR(120) NOT NULL,
     di_value VARCHAR(80) NOT NULL,
     PRIMARY KEY (value_set, di_value)
   )`,
  `CREATE TABLE IF NOT EXISTS core_vocab (
     system_id VARCHAR(20) NOT NULL,
     table_name VARCHAR(64) NOT NULL,
     column_name VARCHAR(64) NOT NULL,
     description VARCHAR(300) NOT NULL,
     encoding VARCHAR(120) NULL,
     code_set VARCHAR(40) NULL,
     PRIMARY KEY (system_id, table_name, column_name)
   )`,
  `CREATE TABLE IF NOT EXISTS core_denotes (
     system_id VARCHAR(20) NOT NULL,
     di_table VARCHAR(64) NOT NULL,
     di_column VARCHAR(64) NOT NULL,
     their_column VARCHAR(80) NOT NULL,
     transform VARCHAR(12) NOT NULL,
     code_set VARCHAR(40) NULL,
     property_id VARCHAR(80) NOT NULL,
     origin VARCHAR(12) NOT NULL,
     pack_version VARCHAR(12) NOT NULL,
     PRIMARY KEY (system_id, di_table, di_column),
     KEY ix_core_denotes_property (property_id)
   )`,
];

export const ONTOLOGY_COLUMNS = {
  onto_concept: ['concept_id', 'kind', 'label', 'label_cu', 'label_bank', 'parent_id', 'semantic_type', 'value_set', 'refers_to', 'privacy', 'is_aggregate', 'constraints', 'definition', 'model_version'],
  onto_edge: ['subject_id', 'predicate', 'object_id', 'detail'],
  onto_term: ['term', 'concept_id', 'scope', 'kind'],
  onto_value: ['value_set', 'code', 'label', 'di_value'],
  core_vocab: ['system_id', 'table_name', 'column_name', 'description', 'encoding', 'code_set'],
  core_denotes: ['system_id', 'di_table', 'di_column', 'their_column', 'transform', 'code_set', 'property_id', 'origin', 'pack_version'],
} as const;

type Row = unknown[];

/** Rows for every ontology table. Terms are lower-cased; duplicates within a scope are dropped. */
export function ontologyRows(o: Ontology, metrics = metricBindings(o)) {
  const concept: Row[] = [];
  const edge = new Map<string, Row>();
  const term = new Map<string, Row>();
  const value = new Map<string, Row>();
  const addEdge = (s: string, p: string, ob: string, detail: string | null = null) => edge.set(`${s}|${p}|${ob}`, [s, p, ob, detail]);
  const addTerm = (t: string, c: string, scope: string, kind: string) => {
    const k = t.trim().toLowerCase();
    if (k) term.set(`${k}|${c}|${scope}`, [k.slice(0, 120), c, scope, kind]);
  };
  const v = o.version;

  for (const c of o.classes.values()) {
    concept.push([c.id, 'class', c.label, c.labels_by_type?.credit_union ?? null, c.labels_by_type?.bank ?? null, c.parent ?? null, null, null, null, null, 0, null, c.definition, v]);
    if (c.parent) addEdge(c.id, 'subclass_of', c.parent);
    for (const r of c.relations) addEdge(c.id, r.predicate, r.to);
    addTerm(c.label, c.id, 'all', 'label');
    if (c.labels_by_type?.credit_union) addTerm(c.labels_by_type.credit_union, c.id, 'credit_union', 'label');
    if (c.labels_by_type?.bank) addTerm(c.labels_by_type.bank, c.id, 'bank', 'label');
    for (const s of c.synonyms?.credit_union ?? []) addTerm(s, c.id, 'credit_union', 'synonym');
    for (const s of c.synonyms?.bank ?? []) addTerm(s, c.id, 'bank', 'synonym');
  }
  for (const p of o.properties.values()) {
    concept.push([p.id, 'property', p.label, p.labels_by_type?.credit_union ?? null, p.labels_by_type?.bank ?? null, p.class, p.type, p.value_set ?? null, p.refers_to ?? null, p.privacy, p.aggregate ? 1 : 0, p.constraints ? JSON.stringify(p.constraints) : null, p.definition ?? null, v]);
    addEdge(p.class, 'has_property', p.id);
    if (p.value_set) addEdge(p.id, 'in_value_set', p.value_set);
    if (p.refers_to) addEdge(p.id, 'refers_to', p.refers_to);
    for (const col of p.realized_by) addEdge(p.id, 'realized_by', col);
    addTerm(p.label, p.id, 'all', 'label');
    if (p.labels_by_type?.credit_union) addTerm(p.labels_by_type.credit_union, p.id, 'credit_union', 'label');
    if (p.labels_by_type?.bank) addTerm(p.labels_by_type.bank, p.id, 'bank', 'label');
    for (const s of p.synonyms?.credit_union ?? []) addTerm(s, p.id, 'credit_union', 'synonym');
    for (const s of p.synonyms?.bank ?? []) addTerm(s, p.id, 'bank', 'synonym');
  }
  for (const vs of o.valueSets.values()) {
    concept.push([vs.id, 'value_set', vs.label, null, null, null, 'code', null, null, null, 0, null, vs.open ? 'Values come from the institution.' : null, v]);
    for (const [code, c] of Object.entries(vs.codes)) {
      const id = `${vs.id}.${code}`;
      concept.push([id, 'value', c.label, c.labels_by_type?.credit_union ?? null, c.labels_by_type?.bank ?? null, vs.id, null, vs.id, null, null, 0, null, null, v]);
      addEdge(id, 'in_value_set', vs.id);
      addTerm(c.label, id, 'all', 'label');
      if (c.labels_by_type?.credit_union) addTerm(c.labels_by_type.credit_union, id, 'credit_union', 'label');
      if (c.labels_by_type?.bank) addTerm(c.labels_by_type.bank, id, 'bank', 'label');
      for (const s of c.synonyms?.credit_union ?? []) addTerm(s, id, 'credit_union', 'synonym');
      for (const s of c.synonyms?.bank ?? []) addTerm(s, id, 'bank', 'synonym');
      for (const dv of c.values) {
        value.set(`${vs.id}|${dv}`, [vs.id, code, c.label, dv]);
        addTerm(dv, id, 'all', 'value');
      }
    }
  }
  for (const m of metrics) for (const p of [...m.properties, ...m.counts]) addEdge(p, 'measured_by', `metric:${m.metric}`, m.label.slice(0, 200));

  const vocab: Row[] = [];
  const denotes: Row[] = [];
  for (const pack of o.vendors.values()) {
    for (const [table, t] of Object.entries(pack.vocabulary)) for (const [col, c] of Object.entries(t.columns)) vocab.push([pack.id, table, col, c.description, c.encoding ? (pack.encodings[c.encoding] ?? c.encoding) : null, c.code_set ?? null]);
    for (const t of pack.tables) {
      const aliases = fromAliases(t.from);
      for (const c of t.columns) {
        const [alias, col] = c.their.split('.') as [string, string];
        const theirs = `${aliases.get(alias)}.${col}`;
        denotes.push([pack.id, t.di_table, c.di, theirs, c.how, c.codes ?? null, c.denotes, 'standard', v]);
        addEdge(c.denotes, 'denoted_by', `${pack.id}:${theirs}`, c.how);
        addTerm(col, c.denotes, pack.id, 'core');
      }
    }
    for (const [set, c] of Object.entries(pack.codes)) for (const [their, code] of Object.entries(c.crosswalk)) addEdge(`${c.code_set_of}.${code}`, 'denoted_by', `${pack.id}:${set}:${their}`, 'code');
  }
  return {
    onto_concept: concept,
    onto_edge: [...edge.values()],
    onto_term: [...term.values()],
    onto_value: [...value.values()],
    core_vocab: vocab,
    core_denotes: denotes,
  };
}
