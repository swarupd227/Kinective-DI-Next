// What DI's ontology reads in a question (Core Mapping and Ontology, phase 5), for every agent: the
// concepts named, the catalog hints Analytics Q&A searches with, and the tags routing sees.
import { conceptsIn, ontology, type Concept } from '@dinext/ontology';
import type { CatalogHints } from '@dinext/semantic';

export type { Concept } from '@dinext/ontology';

export interface ReadConcepts {
  concepts: Concept[];
  hints: CatalogHints;
}

/**
 * The concepts in a question and what they add to a catalog search: a code's value in the institution's
 * data ("DDA" adds Checking), a class's own word ("owners" adds members), and the metrics that read a
 * property the question names ("past due" favors the delinquency metrics).
 */
export function readConcepts(question: string, type: 'credit_union' | 'bank', dimensionValues: Record<string, string[]>): ReadConcepts {
  let concepts: Concept[];
  try {
    concepts = conceptsIn(ontology(), question, type, dimensionValues);
  } catch {
    // The ontology helps; it is never a reason a question goes unanswered.
    return { concepts: [], hints: {} };
  }
  const terms = new Set<string>();
  const metrics: string[] = [];
  const fallback = new Set<string>();
  for (const c of concepts) {
    if (c.kind === 'value' && c.value) {
      terms.add(c.value);
      // "How much is in CDs?" names a value and no measure: the value's class (share, loan, member) stands in.
      const cls = ontology().classes.get(c.class);
      if (cls) fallback.add(cls.labels_by_type?.[type] ?? cls.label);
    }
    if (c.kind === 'class') terms.add(c.label);
    if (c.kind === 'property') metrics.push(...(c.metrics ?? []));
  }
  return { concepts, hints: { terms: [...terms], known: concepts.map((c) => c.said), metrics, fallback: [...fallback] } };
}

/** How the concepts read, for a plan step and the model: “DDA” as Checking. Only words that differ from DI's own. */
export const conceptLine = (concepts: Concept[]) =>
  concepts
    .filter((c) => c.said.toLowerCase().replace(/s$/, '') !== (c.value ?? c.label).toLowerCase().replace(/s$/, ''))
    .map((c) => `“${c.said}” as ${c.kind === 'value' ? c.value : c.label.toLowerCase()}`)
    .join(', ');

/** The classes a question is about, for routing: loan, deposit, member. */
export const conceptTags = (concepts: Concept[]) => [...new Set(concepts.map((c) => c.class))];
