// Concept resolution (design: Core Mapping and Ontology, phase 5): the concepts a person's words name,
// before an agent chooses a metric. "DDA", "share drafts" and "checking" are one code of the share or
// deposit type; "owners" are members at a credit union; "past due" is days past due on a loan. Plain
// phrase matching over the ontology's labels and synonyms: no model, the same answer every time.
import { metricBindings, type Ontology } from './model.ts';

export type InstitutionType = 'credit_union' | 'bank';

/** A word an institution added for one of DI's concepts (phase 11): "owners" for its customers. */
export interface InstitutionWord {
  term: string;
  /** A class (member), a property (loan.days_delinquent) or a code (deposit_category.certificate). */
  concept: string;
}

export interface Concept {
  /** The words as the person wrote them. */
  said: string;
  kind: 'value' | 'class' | 'property';
  /** The ontology id: deposit_category.checking, member, loan.days_delinquent. */
  id: string;
  /** The institution's own word for it: Share draft at a credit union, Checking at a bank. */
  label: string;
  /** The class it belongs to (deposit, loan, member), for routing tags. */
  class: string;
  /** For a code: its list, which is also the semantic dimension, and the value DI's tables hold. */
  set?: string;
  value?: string;
  /** For a property: the metrics that read it. */
  metrics?: string[];
}

export interface Phrase {
  words: string;
  /** One concept, or several of one kind that the rest of the question must choose between. */
  concepts: Omit<Concept, 'said'>[];
}

/**
 * Words that stand for a concept, longest first. When a code and a class share a phrase ("checking" is a
 * class of deposit and a code of the share or deposit type), the code wins: it is the narrower meaning
 * and the one a figure can be filtered by. A phrase concepts of one kind share ("balance" of a loan or a
 * share) keeps them all, for the rest of the question to settle.
 */
function phrases(o: Ontology, type: InstitutionType, dimensions: Record<string, string[]>, words: InstitutionWord[] = []): Phrase[] {
  const out = new Map<string, Omit<Concept, 'said'>[]>();
  // Every concept a word can name, by id, so an institution's own words can point at one.
  const byId = new Map<string, Omit<Concept, 'said'>>();
  const add = (words: string, concept: Omit<Concept, 'said'>) => {
    const w = norm(words);
    if (w.length < 2) return;
    const prior = out.get(w) ?? [];
    if (prior.some((p) => p.id === concept.id)) return;
    const rank = prior[0] ? RANK[prior[0].kind] : 0;
    if (RANK[concept.kind] > rank) out.set(w, [concept]);
    else if (RANK[concept.kind] === rank) out.set(w, [...prior, concept]);
  };
  const scoped = (s: { credit_union?: string[]; bank?: string[] } | undefined) => [...(s?.[type] ?? [])];
  // Codes of the lists the semantic model can filter by, mapped to a value the institution's data holds.
  const owner = new Map<string, string>();
  for (const p of o.properties.values()) if (p.value_set && !owner.has(p.value_set)) owner.set(p.value_set, p.class);
  for (const [set, held] of Object.entries(dimensions)) {
    const vs = o.valueSets.get(set);
    if (!vs) continue;
    const lower = new Map(held.map((v) => [v.toLowerCase(), v]));
    for (const [code, c] of Object.entries(vs.codes)) {
      const value = c.values.map((v) => lower.get(v.toLowerCase())).find((v) => v !== undefined);
      if (!value) continue;
      const concept = { kind: 'value' as const, id: `${set}.${code}`, label: c.labels_by_type?.[type] ?? c.label, class: owner.get(set) ?? set, set, value };
      byId.set(concept.id, concept);
      for (const w of [c.label, c.labels_by_type?.credit_union, c.labels_by_type?.bank, ...(c.synonyms?.credit_union ?? []), ...(c.synonyms?.bank ?? [])]) if (w) add(w, concept);
      for (const [abbr, meaning] of o.codeWords) if (norm(meaning) === norm(c.label) || norm(meaning) === code.replace(/_/g, ' ')) add(abbr, concept);
    }
  }
  for (const c of o.classes.values()) {
    const concept = { kind: 'class' as const, id: c.id, label: c.labels_by_type?.[type] ?? c.label, class: c.id };
    byId.set(c.id, concept);
    for (const w of scoped(c.synonyms)) add(w, concept);
  }
  const reads = new Map<string, string[]>();
  for (const b of bindings(o)) for (const p of b.properties) reads.set(p, [...(reads.get(p) ?? []), b.metric]);
  for (const p of o.properties.values()) {
    // Only what a person asks about in numbers: a property no metric reads can't change the answer.
    const metrics = reads.get(p.id);
    if (!metrics?.length) continue;
    const concept = { kind: 'property' as const, id: p.id, label: p.labels_by_type?.[type] ?? p.label, class: p.class, metrics };
    byId.set(p.id, concept);
    for (const w of scoped(p.synonyms)) add(w, concept);
  }
  // The institution's own words come last and take the phrase: they are its explicit choice (phase 11).
  for (const w of words) {
    const concept = byId.get(w.concept);
    const n = norm(w.term);
    if (concept && n.length >= 2) out.set(n, [concept]);
  }
  return [...out].map(([words, concepts]) => ({ words, concepts })).sort((a, b) => b.words.length - a.words.length);
}

const RANK = { value: 3, property: 2, class: 1 } as const;

export const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9&]+/g, ' ').trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let boundCache: { o: Ontology; b: ReturnType<typeof metricBindings> } | null = null;
const bindings = (o: Ontology) => (boundCache?.o === o ? boundCache.b : (boundCache = { o, b: metricBindings(o) }).b);

const phraseCache = new WeakMap<Ontology, Map<string, Phrase[]>>();

/** Every phrase DI reads for an institution type, longest first, with the concepts each names; cached. */
export function vocabulary(o: Ontology, type: InstitutionType, dimensions: Record<string, string[]>, words: InstitutionWord[] = []): Phrase[] {
  const key = `${type}|${Object.entries(dimensions).map(([k, v]) => `${k}:${v.join(',')}`).join(';')}|${words.map((w) => `${w.term}=${w.concept}`).join(';')}`;
  const byKey = phraseCache.get(o) ?? phraseCache.set(o, new Map()).get(o)!;
  return byKey.get(key) ?? byKey.set(key, phrases(o, type, dimensions, words)).get(key)!;
}

/**
 * The concepts a question names, in the order they appear. Each span of words counts once, for its
 * longest phrase: "home equity line" is the code, not "line". Plurals count ("share drafts", "CDs").
 */
export function conceptsIn(o: Ontology, question: string, type: InstitutionType, dimensions: Record<string, string[]>, words: InstitutionWord[] = []): Concept[] {
  const list = vocabulary(o, type, dimensions, words);
  const text = ` ${question.replace(/[’']s\b/g, '').replace(/[^A-Za-z0-9&]+/g, ' ')} `;
  // Every place each phrase occurs; then, reading left to right, the longest one starting at each place
  // that doesn't overlap one already taken: "car loan balances" is a car loan, not a loan balance.
  const all: { said: string; at: number; end: number; concepts: Omit<Concept, 'said'>[] }[] = [];
  for (const p of list) {
    const re = new RegExp(`(?<= )${p.words.split(' ').map(escape).join(' ')}(?:s|es)?(?= )`, 'gi');
    for (const m of text.matchAll(re)) all.push({ said: m[0], at: m.index, end: m.index + m[0].length, concepts: p.concepts });
  }
  all.sort((a, b) => a.at - b.at || b.end - a.end);
  const taken: typeof all = [];
  for (const c of all) if (!taken.some((t) => c.at < t.end && t.at < c.end)) taken.push(c);
  // A phrase with several meanings takes the one whose class the rest of the question names: "Visa card
  // balances" are loan balances. With no such clue it settles nothing and is left out.
  const named = new Set(taken.filter((t) => t.concepts.length === 1).map((t) => t.concepts[0]!.class));
  const found = taken.flatMap((t) => {
    const fits = t.concepts.length === 1 ? t.concepts : t.concepts.filter((c) => named.has(c.class));
    return fits.length === 1 ? [{ ...fits[0]!, said: t.said }] : [];
  });
  // One concept per id, where it is first named.
  const seen = new Set<string>();
  return found.filter((c) => !seen.has(c.id) && seen.add(c.id));
}
