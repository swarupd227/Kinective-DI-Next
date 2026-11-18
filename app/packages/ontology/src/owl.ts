// DI's ontology as OWL, in Turtle (Core Mapping and Ontology, phase 10), so other tools (Protégé, a
// triple store, a data catalog) can read it: classes with their parents and relations, properties
// with their class, type, privacy class, mask and the DI columns that hold them, each code list as a
// SKOS concept scheme, and every FIBO link as a SKOS mapping. A link limited to a credit union or a
// bank carries that as an annotation on the mapping. FIBO isn't imported; the mappings name its IRIs.
import { FIBO_BASE, type FiboLink, type Ontology, type OntologyProperty } from './model.ts';

export const DI_BASE = 'https://kinective.com/ontology/di-next/';

const SKOS_MATCH: Record<FiboLink['match'], string> = { exact: 'skos:exactMatch', close: 'skos:closeMatch', broader: 'skos:broadMatch', narrower: 'skos:narrowMatch' };
const XSD: Record<OntologyProperty['type'], string> = {
  identifier: 'xsd:string', reference: '', text: 'xsd:string', code: 'xsd:string', money: 'xsd:decimal', rate: 'xsd:decimal', percent: 'xsd:decimal',
  ratio: 'xsd:decimal', count: 'xsd:integer', date: 'xsd:date', flag: 'xsd:boolean', score: 'xsd:decimal', number: 'xsd:decimal',
};

const words = (id: string) => id.split(/[_.]/).filter(Boolean);
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
/** di:Loan, di:LineOfCredit for classes; di:loanBalance for properties; di:loanCategoryCodes for a code list, di:loanCategoryCodes-heloc for a code. */
export const classIri = (id: string) => `di:${words(id).map(cap).join('')}`;
export const propertyIri = (id: string) => `di:${words(id).map((w, i) => (i ? cap(w) : w)).join('')}`;
const schemeIri = (id: string) => `di:${words(id).map((w, i) => (i ? cap(w) : w)).join('')}Codes`;
const codeIri = (set: string, code: string) => `${schemeIri(set)}-${code.replace(/_/g, '-')}`;

const lit = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
const en = (s: string) => `${lit(s)}@en`;

/** The ontology as Turtle. */
export function ontologyTurtle(o: Ontology): string {
  const out: string[] = [];
  const fiboPrefixes = new Map<string, string>();
  // FIBO's own prefix for each module (fibo-fbc-pas-caa: for FBC/ProductsAndServices/ClientsAndAccounts/), from the snapshot.
  const fibo = (id: string) => {
    const mod = id.slice(0, id.lastIndexOf('/') + 1);
    const p = o.fibo.terms[id]!.prefix;
    fiboPrefixes.set(mod, p);
    return `${p}:${id.slice(mod.length)}`;
  };
  const block = (subject: string, lines: string[]) => out.push(`${subject}\n  ${lines.join(' ;\n  ')} .\n`);
  const links = (subject: string, list: FiboLink[] | undefined) => {
    const ls: string[] = [];
    for (const l of list ?? []) {
      if (l.type) {
        // A mapping that holds at one institution type only: stated as an annotated axiom.
        out.push(`[] a owl:Axiom ;\n  owl:annotatedSource ${subject} ;\n  owl:annotatedProperty ${SKOS_MATCH[l.match]} ;\n  owl:annotatedTarget ${fibo(l.id)} ;\n  di:institutionType ${lit(l.type)} .\n`);
      }
      ls.push(`${SKOS_MATCH[l.match]} ${fibo(l.id)}`);
    }
    return ls;
  };
  const byType = (x: { labels_by_type?: { credit_union?: string; bank?: string } }) => [
    ...(x.labels_by_type?.credit_union ? [`di:labelAtCreditUnion ${en(x.labels_by_type.credit_union)}`] : []),
    ...(x.labels_by_type?.bank ? [`di:labelAtBank ${en(x.labels_by_type.bank)}`] : []),
  ];
  const synonyms = (x: { synonyms?: { credit_union?: string[]; bank?: string[] } }) => [...new Set([...(x.synonyms?.credit_union ?? []), ...(x.synonyms?.bank ?? [])])].map((s) => `skos:altLabel ${en(s)}`);

  out.push(`<${DI_BASE}> a owl:Ontology ;\n  rdfs:label "DI Next ontology"@en ;\n  owl:versionInfo ${lit(o.version)} ;\n  rdfs:comment ${en(`What credit unions and banks deal in, as Kinective Data Intelligence models it. FIBO mappings checked against FIBO ${o.fibo.commit.slice(0, 7)} (${o.fibo.source}).`)} .\n`);
  // DI's own annotation properties.
  for (const [p, label] of [['labelAtCreditUnion', 'label at a credit union'], ['labelAtBank', 'label at a bank'], ['privacy', 'privacy class'], ['mask', 'how a value is shown'], ['realizedBy', 'DI column that holds it'], ['institutionType', 'institution type a mapping holds at'], ['noFiboMatch', 'why FIBO has no match']] as const) {
    block(`di:${p}`, ['a owl:AnnotationProperty', `rdfs:label ${en(label)}`]);
  }

  // Relations: one object property per predicate; each class says what its relation reaches.
  const predicates = new Set([...o.classes.values()].flatMap((c) => c.relations.map((r) => r.predicate)));
  for (const p of [...predicates].sort()) block(propertyIri(`rel_${p}`), ['a owl:ObjectProperty', `rdfs:label ${en(p.replace(/_/g, ' '))}`]);

  for (const c of o.classes.values()) {
    const lines = ['a owl:Class', `rdfs:label ${en(c.label)}`, `skos:definition ${en(c.definition)}`, ...byType(c), ...synonyms(c)];
    if (c.parent) lines.push(`rdfs:subClassOf ${classIri(c.parent)}`);
    // Anything a loan is secured by is collateral: allValuesFrom, since not every loan has collateral.
    for (const r of c.relations) lines.push(`rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ${propertyIri(`rel_${r.predicate}`)} ; owl:allValuesFrom ${classIri(r.to)} ]`);
    lines.push(...links(classIri(c.id), c.fibo));
    if (c.fibo_none) lines.push(`di:noFiboMatch ${en(c.fibo_none)}`);
    block(classIri(c.id), lines);
  }

  for (const p of o.properties.values()) {
    const object = p.type === 'reference' && p.refers_to;
    const lines = [
      `a ${object ? 'owl:ObjectProperty' : 'owl:DatatypeProperty'}`,
      `rdfs:label ${en(p.label)}`,
      ...(p.definition ? [`skos:definition ${en(p.definition)}`] : []),
      `rdfs:domain ${classIri(p.class)}`,
      `rdfs:range ${object ? classIri(p.refers_to!) : XSD[p.type]}`,
      ...byType(p),
      ...synonyms(p),
      `di:privacy ${lit(p.privacy)}`,
      ...(p.mask ? [`di:mask ${lit(p.mask)}`] : []),
      ...p.realized_by.map((col) => `di:realizedBy ${lit(col)}`),
      ...(p.value_set ? [`rdfs:seeAlso ${schemeIri(p.value_set)}`] : []),
      ...links(propertyIri(p.id), p.fibo),
    ];
    block(propertyIri(p.id), lines);
  }

  for (const vs of o.valueSets.values()) {
    block(schemeIri(vs.id), ['a skos:ConceptScheme', `rdfs:label ${en(vs.label)}`, ...(vs.open ? [`skos:scopeNote ${en('Values come from the institution.')}`] : [])]);
    for (const [code, c] of Object.entries(vs.codes)) {
      block(codeIri(vs.id, code), [
        'a skos:Concept',
        `skos:inScheme ${schemeIri(vs.id)}`,
        `skos:prefLabel ${en(c.label)}`,
        ...(c.definition ? [`skos:definition ${en(c.definition)}`] : []),
        ...byType(c),
        ...synonyms(c),
        ...c.values.map((v) => `skos:notation ${lit(v)}`),
        ...links(codeIri(vs.id, code), c.fibo),
      ]);
    }
  }

  const prefixes = [
    `@prefix di: <${DI_BASE}> .`,
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    ...[...fiboPrefixes].sort((a, b) => a[1].localeCompare(b[1])).map(([mod, p]) => `@prefix ${p}: <${FIBO_BASE}${mod}> .`),
  ];
  return `# DI Next ontology ${o.version}, as OWL in Turtle. Generated from packages/ontology/model; don't edit by hand.\n${prefixes.join('\n')}\n\n${out.join('\n')}`;
}
