// An institution's own words (Core Mapping and Ontology, phase 11). When DI can't read a word in a
// question, it proposes what the word might mean from the ontology alone, with no model: the other
// institution type's word for a concept ("owners" are members at a credit union, so perhaps customers
// at a bank), or a phrase one slip away ("delinquincy"). A person approves a proposal, or names the
// meaning themselves; nothing is added on a guess. A word nothing in the ontology fits is said to need
// a new measure or concept from the data team.
import { conceptsIn, norm, vocabulary, type Concept, type InstitutionType, type InstitutionWord } from './concepts.ts';
import type { Ontology } from './model.ts';
import { jaroWinkler, oneSlipApart } from './text.ts';

export interface MeaningProposal {
  /** The concept's id: member, loan.days_delinquent, deposit_category.certificate. */
  concept: string;
  kind: Concept['kind'];
  /** The institution's own word for it. */
  label: string;
  /** Why DI thinks so, in a sentence. */
  why: string;
  /** strong: another institution type uses this very word for it; likely: a spelling one slip away. */
  strength: 'strong' | 'likely';
}

const singular = (w: string) => w.replace(/(?<=[a-z]{3})(?:ies)$/, 'y').replace(/(?<=[a-z]{3})(?<!s)s$/, '');
const other = (t: InstitutionType): InstitutionType => (t === 'bank' ? 'credit_union' : 'bank');
const typeWord = (t: InstitutionType) => (t === 'bank' ? 'bank' : 'credit union');
const a = (w: string) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;

/**
 * What DI already reads a word as, if anything: the concept when the whole word names exactly one.
 * "share drafts" is Checking; "dividends paid" is nothing.
 */
export function wordMeans(o: Ontology, term: string, type: InstitutionType, dimensions: Record<string, string[]>, words: InstitutionWord[] = []): Concept | null {
  const found = conceptsIn(o, term, type, dimensions, words);
  const t = singular(norm(term));
  return found.length === 1 && singular(norm(found[0]!.said)) === t ? found[0]! : null;
}

/** Up to three meanings for a word DI can't read, strongest first; none when nothing in the ontology fits. */
export function proposeMeaning(o: Ontology, term: string, type: InstitutionType, dimensions: Record<string, string[]>, words: InstitutionWord[] = []): MeaningProposal[] {
  const t = singular(norm(term));
  if (t.length < 2 || wordMeans(o, term, type, dimensions, words)) return [];
  const mine = vocabulary(o, type, dimensions, words);
  // The same concept as this institution names it, when this institution can name it at all.
  const here = new Map(mine.flatMap((p) => p.concepts).map((c) => [c.id, c]));
  const out = new Map<string, MeaningProposal>();
  const put = (p: MeaningProposal) => {
    const prior = out.get(p.concept);
    if (!prior || (prior.strength === 'likely' && p.strength === 'strong')) out.set(p.concept, p);
  };
  // The other institution type's word for a concept.
  for (const p of vocabulary(o, other(type), dimensions)) {
    if (singular(p.words) !== t || p.concepts.length !== 1) continue;
    const c = here.get(p.concepts[0]!.id) ?? (p.concepts[0]!.kind === 'class' ? { ...p.concepts[0]!, label: o.classes.get(p.concepts[0]!.id)?.labels_by_type?.[type] ?? p.concepts[0]!.label } : null);
    if (!c) continue;
    put({ concept: c.id, kind: c.kind, label: c.label, strength: 'strong', why: `A ${typeWord(other(type))} uses “${p.words}” for what you call ${a(c.label.toLowerCase())}.` });
  }
  // A phrase of this institution's one slip away, or nearly alike, for words long enough to tell.
  if (t.length >= 5) {
    // Concepts by their own names as well as their synonyms: "delinquincy" is the delinquency concept.
    const named = [...o.classes.values()].map((c) => ({ words: norm(c.labels_by_type?.[type] ?? c.label), concepts: [{ kind: 'class' as const, id: c.id, label: c.labels_by_type?.[type] ?? c.label, class: c.id }] }));
    for (const p of [...mine, ...named]) {
      if (p.concepts.length !== 1) continue;
      const w = singular(p.words);
      if (w === t || Math.abs(w.length - t.length) > 2) continue;
      if (oneSlipApart(w, t) || jaroWinkler(w, t) >= 0.94) {
        const c = p.concepts[0]!;
        put({ concept: c.id, kind: c.kind, label: c.label, strength: 'likely', why: `“${term.trim()}” is spelled nearly like “${p.words}”${norm(c.label) === p.words ? '' : `, which is ${c.label.toLowerCase()}`}.` });
      }
    }
  }
  return [...out.values()].sort((a, b) => (a.strength === b.strength ? a.label.localeCompare(b.label) : a.strength === 'strong' ? -1 : 1)).slice(0, 3);
}

/**
 * The concept a person names as a word's meaning ("customers", "share certificates", "member", an id):
 * an id as written, or what DI reads the words as.
 */
export function meaningNamed(o: Ontology, meaning: string, type: InstitutionType, dimensions: Record<string, string[]>): Omit<Concept, 'said'> | null {
  const id = meaning.trim();
  const all = vocabulary(o, type, dimensions).flatMap((p) => p.concepts);
  const byId = all.find((c) => c.id === id);
  if (byId) return byId;
  const cls = o.classes.get(id);
  if (cls) return { kind: 'class', id, label: cls.labels_by_type?.[type] ?? cls.label, class: id };
  const read = wordMeans(o, meaning, type, dimensions);
  if (read) return { kind: read.kind, id: read.id, label: read.label, class: read.class, ...(read.set ? { set: read.set, value: read.value } : {}), ...(read.metrics ? { metrics: read.metrics } : {}) };
  // A class by its own label, at either institution type: "customers", "members".
  const n = singular(norm(meaning));
  for (const c of o.classes.values()) {
    const names = [c.label, c.labels_by_type?.credit_union, c.labels_by_type?.bank].filter((x): x is string => !!x).map((x) => singular(norm(x)));
    if (names.includes(n)) return { kind: 'class', id: c.id, label: c.labels_by_type?.[type] ?? c.label, class: c.id };
  }
  return null;
}
