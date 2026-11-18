// The ontology in each tenant database (Core Mapping and Ontology, phase 1): look a word up and get
// the concept behind it, in this institution's words, with the DI columns that hold it, the metrics
// that measure it, its code list, and the core columns it comes from. Read only; every answer is
// worked out from onto_* and core_* rows, never from a column's name.
import type { Pool } from '@dinext/tenant-db';
import { FIBO_BASE, ontology, type FiboLink } from '@dinext/ontology';

type InstitutionType = 'credit_union' | 'bank';
const rows = async <T>(pool: Pool, sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T[];

export interface ConceptView {
  id: string;
  kind: 'class' | 'property' | 'value_set' | 'value';
  label: string;
  definition: string | null;
  /** The class a property belongs to, or a class's parent. */
  parent: { id: string; label: string } | null;
  semanticType: string | null;
  privacy: string | null;
  synonyms: string[];
  /** DI columns holding a property, as table.column. */
  columns: string[];
  metrics: { name: string; label: string }[];
  /** Core columns a property comes from, by vendor: "Symitar LOAN.BALANCE". */
  core: { system: string; column: string; transform: string | null; description: string | null }[];
  /** A code list's codes, with the values DI holds for each. */
  codes: { code: string; label: string; values: string[] }[];
  /** A class's properties and relations. */
  properties: { id: string; label: string }[];
  relations: { predicate: string; to: string; label: string }[];
  /** The FIBO classes it matches at this institution type (phase 9): how closely, FIBO's label and the class's IRI. */
  fibo: { iri: string; label: string; match: 'exact' | 'close' | 'broader' | 'narrower' }[];
  /** Why FIBO has nothing for a class, when it has none. */
  fiboNone: string | null;
  /** For a code: the code list it is on. */
  valueSet?: { id: string; label: string } | null;
  /** When the word asked about is the other institution type's: "share certificate" at a bank. */
  elsewhere?: { term: string; type: InstitutionType } | null;
}

const words = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9+&' -]+/g, ' ').replace(/\s+/g, ' ').trim();

export class OntologyService {
  constructor(private readonly pool: Pool, private readonly type: InstitutionType) {}

  /** Whether the ontology is loaded for this institution. */
  async loaded() {
    const r = await rows<{ n: number }>(this.pool, 'SELECT COUNT(*) AS n FROM onto_concept').catch(() => null);
    return !!r?.[0] && Number(r[0].n) > 0;
  }

  private label(r: { label: string; label_cu: string | null; label_bank: string | null }) {
    return (this.type === 'credit_union' ? r.label_cu : r.label_bank) ?? r.label;
  }

  /**
   * The concepts a word or phrase names, best first: an exact label, synonym or value in this
   * institution's scope, then a DI column (cdm_loan.balance) or a core column (LOAN.BALANCE), then
   * labels that contain the phrase. Null when the ontology isn't loaded.
   */
  async lookup(phrase: string, limit = 5): Promise<ConceptView[] | null> {
    if (!(await this.loaded())) return null;
    const q = words(phrase);
    const scopes = ['all', this.type, 'symitar'];
    const ids: string[] = [];
    const add = (list: { concept_id: string }[]) => list.forEach((r) => !ids.includes(r.concept_id) && ids.push(r.concept_id));
    const col = /^([a-z_]+)\.([a-z_0-9]+)$/.exec(phrase.trim());
    const core = /^([A-Z][A-Z0-9_]*)\.([A-Z][A-Z0-9_]*)$/.exec(phrase.trim());
    if (col) add(await rows(this.pool, "SELECT subject_id AS concept_id FROM onto_edge WHERE predicate = 'realized_by' AND object_id = ?", [phrase.trim()]));
    if (core) add(await rows(this.pool, "SELECT subject_id AS concept_id FROM onto_edge WHERE predicate = 'denoted_by' AND object_id LIKE ?", [`%:${phrase.trim()}`]));
    let elsewhere: ConceptView['elsewhere'] = null;
    if (q) {
      // Exact first, preferring a class, then a property, then a code.
      const exact = (term: string, sc: string[]) =>
        rows<{ concept_id: string; scope: string }>(this.pool, `SELECT t.concept_id, t.scope FROM onto_term t JOIN onto_concept c ON c.concept_id = t.concept_id WHERE t.term = ? AND t.scope IN (${sc.map(() => '?').join(',')})
          ORDER BY FIELD(c.kind, 'class', 'property', 'value', 'value_set'), FIELD(t.kind, 'label', 'synonym', 'value', 'core'),
            (SELECT COUNT(*) FROM onto_edge e WHERE e.subject_id = t.concept_id AND e.predicate IN ('realized_by', 'denoted_by')) DESC, t.concept_id`, [term, ...sc]);
      const singular = q.replace(/(?:ies)$/, 'y').replace(/(?<!s)s$/, '');
      add(await exact(q, scopes));
      if (singular !== q) add(await exact(singular, scopes));
      // The other institution type's word: "share certificate" at a bank, "DDA" at a credit union.
      if (!ids.length) {
        const other = this.type === 'credit_union' ? 'bank' : 'credit_union';
        const found = [...(await exact(q, [other])), ...(singular !== q ? await exact(singular, [other]) : [])];
        add(found);
        if (found[0]) elsewhere = { term: phrase.trim().replace(/^(?:an?|the) /i, ''), type: other };
      }
      if (ids.length < limit && q.length >= 4) add(await rows(this.pool, `SELECT t.concept_id, MIN(FIELD(c.kind, 'class', 'property', 'value', 'value_set')) AS k, MIN(CHAR_LENGTH(t.term)) AS len FROM onto_term t JOIN onto_concept c ON c.concept_id = t.concept_id WHERE t.term LIKE ? AND t.scope IN (?, ?, ?) GROUP BY t.concept_id ORDER BY k, len, t.concept_id LIMIT 20`, [`%${q}%`, ...scopes]));
    }
    const out: ConceptView[] = [];
    for (const id of ids.slice(0, limit)) {
      const v = await this.concept(id);
      if (v) out.push(out.length === 0 && elsewhere ? { ...v, elsewhere } : v);
    }
    return out;
  }

  /** One concept with everything bound to it. */
  async concept(id: string): Promise<ConceptView | null> {
    const [c] = await rows<{ concept_id: string; kind: ConceptView['kind']; label: string; label_cu: string | null; label_bank: string | null; parent_id: string | null; semantic_type: string | null; value_set: string | null; privacy: string | null; definition: string | null }>(
      this.pool, 'SELECT concept_id, kind, label, label_cu, label_bank, parent_id, semantic_type, value_set, privacy, definition FROM onto_concept WHERE concept_id = ?', [id]);
    if (!c) return null;
    const [parent] = c.parent_id ? await rows<{ concept_id: string; label: string; label_cu: string | null; label_bank: string | null }>(this.pool, 'SELECT concept_id, label, label_cu, label_bank FROM onto_concept WHERE concept_id = ?', [c.parent_id]) : [];
    const edges = await rows<{ predicate: string; object_id: string; detail: string | null }>(this.pool, 'SELECT predicate, object_id, detail FROM onto_edge WHERE subject_id = ? ORDER BY predicate, object_id', [id]);
    const synonyms = (await rows<{ term: string }>(this.pool, "SELECT term FROM onto_term WHERE concept_id = ? AND scope IN ('all', ?) AND kind IN ('label', 'synonym') ORDER BY kind, term", [id, this.type])).map((r) => r.term);
    const core: ConceptView['core'] = [];
    for (const e of edges.filter((x) => x.predicate === 'denoted_by')) {
      const [system, ...rest] = e.object_id.split(':');
      const column = rest.join(':');
      const [table, name] = column.split('.');
      const [vocab] = name ? await rows<{ description: string; label: string | null }>(this.pool, 'SELECT description, encoding AS label FROM core_vocab WHERE system_id = ? AND table_name = ? AND column_name = ?', [system, table, name]) : [];
      core.push({ system: system === 'symitar' ? 'Symitar' : system!, column, transform: e.detail, description: vocab?.description ?? null });
    }
    const valueSet = c.kind === 'value_set' ? c.concept_id : c.value_set;
    const codes = valueSet && c.kind !== 'value'
      ? Object.values(
          (await rows<{ code: string; label: string; di_value: string }>(this.pool, 'SELECT code, label, di_value FROM onto_value WHERE value_set = ? ORDER BY code, di_value', [valueSet])).reduce<Record<string, { code: string; label: string; values: string[] }>>((acc, r) => {
            (acc[r.code] ??= { code: r.code, label: r.label, values: [] }).values.push(r.di_value);
            return acc;
          }, {}),
        )
      : c.kind === 'value'
        ? [{ code: id.split('.').pop()!, label: c.label, values: (await rows<{ di_value: string }>(this.pool, 'SELECT di_value FROM onto_value WHERE value_set = ? AND code = ?', [c.value_set, id.split('.').pop()])).map((r) => r.di_value) }]
        : [];
    // The most direct measures first: those that read the fewest concepts.
    const measured = edges.filter((e) => e.predicate === 'measured_by');
    const breadth = new Map(
      (measured.length ? await rows<{ object_id: string; n: number }>(this.pool, `SELECT object_id, COUNT(*) AS n FROM onto_edge WHERE predicate = 'measured_by' AND object_id IN (${measured.map(() => '?').join(',')}) GROUP BY object_id`, measured.map((e) => e.object_id)) : []).map((r) => [r.object_id, Number(r.n)]),
    );
    measured.sort((a, b) => (breadth.get(a.object_id) ?? 0) - (breadth.get(b.object_id) ?? 0) || (a.detail ?? '').localeCompare(b.detail ?? ''));
    const props = c.kind === 'class' ? await rows<{ concept_id: string; label: string; label_cu: string | null; label_bank: string | null }>(this.pool, "SELECT concept_id, label, label_cu, label_bank FROM onto_concept WHERE kind = 'property' AND parent_id = ? ORDER BY concept_id", [id]) : [];
    const relTargets = edges.filter((e) => !['subclass_of', 'has_property', 'realized_by', 'measured_by', 'denoted_by', 'in_value_set', 'refers_to'].includes(e.predicate));
    // FIBO links come from the loaded model (phase 9), so they need no reseed.
    const o = ontology();
    const cls = c.kind === 'class' ? o.classes.get(id) : undefined;
    const code = c.kind === 'value' && c.value_set ? o.valueSets.get(c.value_set)?.codes[id.slice(c.value_set.length + 1)] : undefined;
    const fibo = ((cls?.fibo ?? code?.fibo ?? []) as FiboLink[])
      .filter((l) => !l.type || l.type === this.type)
      .map((l) => ({ iri: `${FIBO_BASE}${l.id}`, label: o.fibo.classes[l.id]?.label ?? l.id.slice(l.id.lastIndexOf('/') + 1), match: l.match }));
    const targetLabels = relTargets.length ? await rows<{ concept_id: string; label: string; label_cu: string | null; label_bank: string | null }>(this.pool, `SELECT concept_id, label, label_cu, label_bank FROM onto_concept WHERE concept_id IN (${relTargets.map(() => '?').join(',')})`, relTargets.map((e) => e.object_id)) : [];
    return {
      id: c.concept_id,
      kind: c.kind,
      label: this.label(c),
      definition: c.definition,
      parent: parent ? { id: parent.concept_id, label: this.label(parent) } : null,
      semanticType: c.semantic_type,
      privacy: c.privacy,
      synonyms: [...new Set(synonyms)].filter((s) => s !== this.label(c).toLowerCase()).slice(0, 12),
      columns: edges.filter((e) => e.predicate === 'realized_by').map((e) => e.object_id).sort((a, b) => Number(a.startsWith('hist_')) - Number(b.startsWith('hist_')) || a.split('.')[0]!.length - b.split('.')[0]!.length || a.localeCompare(b)),
      metrics: measured.map((e) => ({ name: e.object_id.replace(/^metric:/, ''), label: e.detail ?? e.object_id })),
      core,
      codes,
      properties: props.map((p) => ({ id: p.concept_id, label: this.label(p) })),
      fibo,
      fiboNone: cls?.fibo_none ?? null,
      valueSet: c.kind === 'value' && parent ? { id: parent.concept_id, label: this.label(parent) } : null,
      relations: relTargets.map((e) => {
        const t = targetLabels.find((x) => x.concept_id === e.object_id);
        return { predicate: e.predicate.replace(/_/g, ' '), to: e.object_id, label: t ? this.label(t) : e.object_id };
      }),
    };
  }

  /** How much of DI the ontology covers: concepts by kind, DI columns bound, metrics tied, and core columns mapped by vendor. */
  async coverage() {
    if (!(await this.loaded())) return null;
    const kinds = await rows<{ kind: string; n: number }>(this.pool, 'SELECT kind, COUNT(*) AS n FROM onto_concept GROUP BY kind');
    const [cols] = await rows<{ n: number }>(this.pool, "SELECT COUNT(*) AS n FROM onto_edge WHERE predicate = 'realized_by'");
    const [metrics] = await rows<{ n: number }>(this.pool, "SELECT COUNT(DISTINCT object_id) AS n FROM onto_edge WHERE predicate = 'measured_by'");
    const vendors = await rows<{ system_id: string; n: number }>(this.pool, 'SELECT system_id, COUNT(*) AS n FROM core_denotes GROUP BY system_id');
    const [version] = await rows<{ v: string }>(this.pool, 'SELECT MAX(model_version) AS v FROM onto_concept');
    const o = ontology();
    const f = { class: [...o.classes.values()].filter((x) => x.fibo).length, value: [...o.valueSets.values()].flatMap((vs) => Object.values(vs.codes)).filter((x) => x.fibo).length };
    const k = Object.fromEntries(kinds.map((r) => [r.kind, Number(r.n)]));
    return { version: version?.v ?? null, classes: k.class ?? 0, properties: k.property ?? 0, valueSets: k.value_set ?? 0, codes: k.value ?? 0, columns: Number(cols?.n ?? 0), metrics: Number(metrics?.n ?? 0), fibo: { classes: f.class ?? 0, codes: f.value ?? 0 }, vendors: vendors.map((v) => ({ system: v.system_id, columns: Number(v.n) })) };
  }
}
