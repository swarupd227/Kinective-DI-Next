// Semantic catalog search (spec 16.8 "Resolve", 23.5.3). Keyword and synonym matching over metric
// and dimension definitions plus dimension values. The spec's hybrid vector search is a later
// addition; this keeps the same contract: ranked items with IDs, at most 12 (AI-ARC-041).
import type { SemanticModel } from './model.ts';

export interface CatalogHit {
  kind: 'metric' | 'dimension';
  name: string;
  label: string;
  description: string;
  score: number;
  dimensionsAllowed?: string[];
  trendable?: boolean;
}

export interface ValueHit {
  dimension: string;
  value: string;
}

export interface CatalogResult {
  metrics: CatalogHit[];
  dimensions: CatalogHit[];
  values: ValueHit[];
  /** False when nothing clears the match threshold: the agent must not guess (AI-ARC-042). */
  matched: boolean;
  /** Content words the catalog does not know, for the "couldn't map" reply and the unmatched log. */
  unknownTerms: string[];
}

export const MATCH_THRESHOLD = 3;

/**
 * What DI's ontology read in the question (Core Mapping and Ontology, phase 5): the catalog's own words
 * for the person's ("DDA" is the value Checking), words it now understands, and metrics that read a
 * property the question names ("past due" is days past due). Hints add to the search; they never
 * replace the person's words.
 */
export interface CatalogHints {
  /** Words to search with as well: dimension values and labels. */
  terms?: string[];
  /** The person's words the ontology understood, so they don't count as unknown. */
  known?: string[];
  /** Metrics that read a property the question names, once per property: one that reads two named properties gains twice. */
  metrics?: string[];
  /** Words to add only when nothing matches without them: the class of a value named alone ("CDs" is a share). */
  fallback?: string[];
}

/** A metric that reads a property the question names gains this much: enough to settle a near tie, not to beat a named metric. */
const HINT_BOOST = 2.5;

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'by', 'in', 'on', 'to', 'and', 'or', 'what', 'how', 'is', 'are', 'was', 'were', 'our', 'my', 'me', 'show', 'give', 'tell', 'did', 'do', 'does', 'vs', 'versus', 'compared', 'with', 'last', 'this', 'per', 'each', 'all', 'at', 'from', 'over', 'which', 'many', 'much',
  // Everyday grammar, so "How many members do we have?" is not refused for "we" and "have".
  'we', 'us', 'i', 'you', 'your', 'they', 'their', 'it', 'its', 'have', 'has', 'had', 'got', 'get', 'be', 'been', 'being', 'there', 'that', 'these', 'those', 'any', 'so', 'just', 'right', 'whats', 'hows', 'currently',
  // Words of a follow-up ("break that down", "why did deposits move", "which branch drove that"): they ask
  // about a figure already on screen, they don't name a new one. ("Behind" stays: loans behind are delinquent.)
  'break', 'broken', 'down', 'why', 'move', 'moved', 'moves', 'moving', 'drove', 'drive', 'drives', 'driving', 'driven', 'caused', 'now', 'same', 'instead', 'again',
  // Question words and fillers, so a refusal names the subject, never "if" or "happen".
  'if', 'when', 'where', 'why', 'who', 'would', 'could', 'should', 'can', 'will', 'happen', 'happens', 'happened', 'please', 'about', 'like', 'look', 'looks', 'see', 'into', 'up', 'out', 'than', 'then', 'now', 'today', 'trend', 'trending', 'trended', 'trends']);

const stem = (w: string) => w.replace(/'s$/, '').replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})s$/, '');
export const tokens = (text: string) =>
  text
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9+&\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem);

function scoreItem(queryTokens: string[], queryText: string, fields: { name: string; label: string; synonyms: string[]; description: string }) {
  let score = 0;
  const q = new Set(queryTokens);
  for (const phrase of fields.synonyms) {
    const p = tokens(phrase);
    if (p.length && p.every((t) => q.has(t))) score += 2 + p.length * 1.5;
  }
  const labelTokens = tokens(fields.label);
  const labelHits = labelTokens.filter((t) => q.has(t)).length;
  score += labelHits * 1.6 + (labelHits === labelTokens.length && labelHits > 0 ? 1.5 : 0);
  score += tokens(fields.name.replaceAll('_', ' ')).filter((t) => q.has(t)).length * 1.2;
  score += tokens(fields.description).filter((t) => q.has(t)).length * 0.3;
  if (queryText.toLowerCase().includes(fields.label.toLowerCase())) score += 3;
  return Math.round(score * 10) / 10;
}

export function searchCatalog(model: SemanticModel, asked: string, dimensionValues: Record<string, string[]>, hints: CatalogHints = {}): CatalogResult {
  if (hints.fallback?.length) {
    const { fallback, ...rest } = hints;
    const plain = searchCatalog(model, asked, dimensionValues, rest);
    return (plain.metrics[0]?.score ?? 0) >= MATCH_THRESHOLD ? plain : searchCatalog(model, asked, dimensionValues, { ...rest, terms: [...(rest.terms ?? []), ...fallback] });
  }
  const query = hints.terms?.length ? `${asked} ${hints.terms.join(' ')}` : asked;
  const qt = tokens(query);
  const boosted = new Map<string, number>();
  for (const m of hints.metrics ?? []) boosted.set(m, (boosted.get(m) ?? 0) + 1);
  const metrics = Object.values(model.metrics)
    .map((m) => ({
      kind: 'metric' as const,
      name: m.name,
      label: m.label,
      description: m.description,
      // "Certificate share" isn't "certificates maturing": a metric that names its key words needs one.
      score: m.requiresAny.length && !m.requiresAny.some((w) => query.toLowerCase().includes(w)) ? 0 : scoreItem(qt, query, m) + HINT_BOOST * (boosted.get(m.name) ?? 0),
      dimensionsAllowed: m.dimensionsAllowed,
      trendable: !m.currentOnly,
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8);
  const dimensions = Object.values(model.dimensions)
    .map((d) => ({ kind: 'dimension' as const, name: d.name, label: d.label, description: d.description, score: scoreItem(qt, query, d) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 4);
  // Named values ("Westport", "auto", "certificates") become filter candidates.
  const lower = ` ${query.toLowerCase().replace(/[^a-z0-9&\s]/g, ' ')} `;
  const values: ValueHit[] = [];
  for (const [dimension, list] of Object.entries(dimensionValues)) {
    for (const value of list) {
      const v = value.toLowerCase();
      if (lower.includes(` ${v} `) || lower.includes(` ${stem(v)} `) || lower.includes(` ${v}s `)) values.push({ dimension, value });
    }
  }
  // A score alone can be carried by one generic word ("share" in "wallet share"). The question must
  // also be mostly made of words the catalog understands, or the agent says it cannot map it.
  const known = vocabulary(model, dimensionValues);
  const understood = new Set((hints.known ?? []).flatMap((w) => tokens(w)));
  // Coverage is of the person's own words; the hint terms are the catalog's and always known.
  const asks = tokens(asked);
  const unknown = asks.filter((t) => !known.has(t) && !understood.has(t) && !/^\d+$/.test(t));
  // The reply quotes the person's own words ("funds", "basis"), never the stems the match used ("fund", "basi").
  const said = asked.toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9+&\s-]/g, ' ').split(/[\s-]+/).filter((w) => w && !STOP.has(w));
  const asSaid = [...new Set(unknown.map((t) => said.find((w) => stem(w) === t) ?? t))];
  const coverage = asks.length ? 1 - unknown.length / asks.length : 0;
  return { metrics, dimensions, values: values.slice(0, 8), matched: (metrics[0]?.score ?? 0) >= MATCH_THRESHOLD && coverage >= 0.6, unknownTerms: asSaid };
}

/** Words about time, ranking and presentation that need no catalog entry. */
const GENERIC = tokens(
  'q1 q2 q3 q4 month months monthly quarter quarters quarterly year years yearly annual ytd mtd qtd week weeks today yesterday current currently now latest recent trend trends change changed changes compare comparison growth grow grew drop dropped fall fell rise rose up down increase decrease top bottom highest lowest most least rank ranked best worst biggest largest smallest total overall average number count breakdown split chart graph table list see view look institution credit union bank two three four five six twelve jan feb mar apr may jun jul aug sep oct nov dec january february march april june july august september october november december end ending since period between against prior previous same time over under more than less about please can could would like know',
);

const vocabCache = new WeakMap<SemanticModel, Set<string>>();
function vocabulary(model: SemanticModel, dimensionValues: Record<string, string[]>) {
  let v = vocabCache.get(model);
  if (!v) {
    v = new Set(GENERIC);
    for (const item of [...Object.values(model.metrics), ...Object.values(model.dimensions)]) {
      for (const text of [item.name.replaceAll('_', ' '), item.label, ...item.synonyms]) tokens(text).forEach((t) => v!.add(t));
    }
    vocabCache.set(model, v);
  }
  const withValues = new Set(v);
  for (const list of Object.values(dimensionValues)) for (const value of list) tokens(value).forEach((t) => withValues.add(t));
  return withValues;
}
