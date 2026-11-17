// Proposing how a core's columns map to DI's (Core Mapping and Ontology, phase 2). Pure functions
// over a profile of the core and DI's ontology: no database, no model. Each candidate is scored on
// five signals, and the best are assigned one to one:
// - vocabulary: the column's name (split with the ontology's words and abbreviations) and, where the
//   vendor documents it, its description, against each property's names and synonyms;
// - values: what the column holds (dates as YYYYMMDD, money, rates in thousandths, codes, flags,
//   keys, references) against the property's semantic type, or a way the ontology says it can be derived;
// - structure: which DI table the column's table lines up with, and whether a key or a reference
//   sits where the property needs one;
// - precedent: what Kinective's mapping for the same core says, when it isn't hidden;
// - tie-out: whether the mapped values add up to the regulatory return (worked out by the caller).
import type { Ontology, OntologyProperty } from '@dinext/ontology';

export type ColumnKind = 'date' | 'key' | 'reference' | 'flag' | 'money' | 'rate1000' | 'code' | 'number' | 'text' | 'empty';
export type MapTransform = 'same' | 'number' | 'date8' | 'code' | 'rate1000' | 'daysPast' | 'not' | 'nonzero';

export interface ColumnProfile {
  table: string;
  column: string;
  dataType: string;
  rows: number;
  /** Rows the value figures below were read from: every row, or a sample of a large table. */
  sampled?: number;
  /** Rows with a value: not NULL, not blank, not 00000000. */
  filled: number;
  distinct: number;
  min: string | null;
  max: string | null;
  /** Share of filled values that are a valid YYYYMMDD date, a number, a number with a fraction, a 0/1 or Y/N flag. */
  dateShare: number;
  numericShare: number;
  fractionShare: number;
  flagShare: number;
  avg: number | null;
  top: { value: string; count: number }[];
  /** Another table's key this column's values are drawn from, and the share that match. */
  refersTo?: { table: string; column: string; share: number } | null;
  kind?: ColumnKind;
}

export interface CoreTableProfile {
  table: string;
  rows: number;
  key: string | null;
  description?: string | null;
}

export interface CoreProfile {
  tables: CoreTableProfile[];
  columns: ColumnProfile[];
  /** Vendor descriptions of columns, "TABLE.COLUMN" to text, when the vendor is known. */
  descriptions?: Map<string, string>;
}

export interface Signals {
  vocabulary: number;
  values: number;
  structure: number;
  precedent: number | null;
  tieOut: number | null;
}

export interface Candidate {
  coreTable: string;
  coreColumn: string;
  diTable: string;
  diColumn: string;
  property: string;
  score: number;
  signals: Signals;
  transform: MapTransform;
  why: string[];
}

export interface Proposal extends Candidate {
  band: 'standard' | 'auto' | 'review' | 'person';
  margin: number;
  runnerUp: { coreColumn: string; diColumn: string; score: number } | null;
}

export const WEIGHTS = { vocabulary: 0.35, values: 0.3, structure: 0.15, precedent: 0.1, tieOut: 0.1 } as const;
/** A pair below this isn't proposed at all. */
export const PROPOSE_AT = 0.5;
export const BANDS = { auto: 0.9, review: 0.6, margin: 0.05 } as const;

// ---- profiles ---------------------------------------------------------------------------------

/** What a column holds, from its profile alone. */
export function kindOf(c: ColumnProfile): ColumnKind {
  if (!c.filled) return 'empty';
  if (c.dateShare >= 0.9) return 'date';
  if (c.refersTo && c.refersTo.share >= 0.95) return 'reference';
  const seen = c.sampled ?? c.rows;
  if (c.distinct === seen && c.numericShare >= 0.99 && seen > 1) return 'key';
  if (c.distinct <= 2 && c.flagShare >= 0.99) return 'flag';
  if (c.numericShare >= 0.95 && c.fractionShare > 0.05) return 'money';
  // Rates kept as whole thousandths of a percent (5250 is 5.25%): integers up to 40,000, mostly not zero.
  const hi = Number(c.max);
  const zeros = c.top.find((t) => t.value === '0')?.count ?? 0;
  if (c.numericShare >= 0.99 && c.fractionShare === 0 && c.distinct >= 40 && Number(c.min) >= 0 && hi <= 40_000 && hi >= 500 && (c.avg ?? 0) >= 50 && zeros / c.filled < 0.4) return 'rate1000';
  if (c.distinct <= 40) return 'code';
  if (c.numericShare >= 0.95) return 'number';
  return 'text';
}

/**
 * Groups tables into entities: a table without a key of its own whose rows mostly point at another
 * table's key, about one to one (Symitar's NAME under ACCOUNT), belongs to that table's entity.
 */
export function entities(p: CoreProfile) {
  const byTable = new Map(p.tables.map((t) => [t.table, t]));
  const owner = new Map<string, string>();
  for (const t of p.tables) {
    owner.set(t.table, t.table);
    if (t.key || !t.rows) continue;
    const refs = p.columns.filter((c) => c.table === t.table && c.refersTo && c.refersTo.share >= 0.95);
    const parent = refs.map((r) => byTable.get(r.refersTo!.table)).find((u) => u && u.key && u.rows && t.rows / u.rows <= 1.3);
    if (parent) owner.set(t.table, parent.table);
  }
  return owner;
}

// ---- words ------------------------------------------------------------------------------------

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'or', 'and', 'for', 'is', 'it', 'its', 'by', 'at', 'as', 'with', 'one', 'per', 'each', 'none', 'while', 'set', 'this', 'that', 'be', 'when', 'what', 'how']);
const stem = (w: string) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const wordsOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).map(stem);

export class Vocabulary {
  private readonly dict: Set<string>;
  private readonly longest: number;
  constructor(private readonly o: Ontology) {
    const dict = new Set<string>(o.words);
    const add = (s: string | undefined) => s && wordsOf(s).forEach((w) => w.length > 1 && dict.add(w));
    for (const c of o.classes.values()) {
      add(c.label);
      Object.values(c.synonyms ?? {}).flat().forEach(add);
    }
    for (const p of o.properties.values()) {
      add(p.label);
      add(p.id.split('.')[1]!.replace(/_/g, ' '));
      Object.values(p.labels_by_type ?? {}).forEach(add);
      Object.values(p.synonyms ?? {}).flat().forEach(add);
    }
    for (const k of o.abbreviations.keys()) dict.add(k);
    this.dict = dict;
    this.longest = Math.max(...[...dict].map((w) => w.length));
  }

  /** Splits a core name into words with the fewest pieces, then expands abbreviations: DIVRATE gives dividend rate. */
  split(name: string): string[] {
    const out: string[] = [];
    for (const chunk of name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const n = chunk.length;
      const best: { cost: number; parts: string[] }[] = Array.from({ length: n + 1 }, () => ({ cost: Infinity, parts: [] }));
      best[0] = { cost: 0, parts: [] };
      for (let i = 0; i < n; i++) {
        if (best[i]!.cost === Infinity) continue;
        for (let j = i + 1; j <= Math.min(n, i + this.longest); j++) {
          const w = chunk.slice(i, j);
          const known = this.dict.has(w) || this.dict.has(stem(w));
          // A known word costs 1; an unknown letter costs 3, so known words win.
          const cost = best[i]!.cost + (known ? 1 : 3 * w.length);
          if (!known && j - i > 1) continue;
          if (cost < best[j]!.cost) best[j] = { cost, parts: [...best[i]!.parts, w] };
        }
      }
      // Unknown single letters run together again: "x1" stays one piece.
      const parts: string[] = [];
      for (const p of best[n]!.parts) {
        if (!this.dict.has(p) && !this.dict.has(stem(p)) && parts.length && !this.dict.has(parts[parts.length - 1]!)) parts[parts.length - 1] += p;
        else parts.push(p);
      }
      for (const p of parts) {
        const full = this.o.abbreviations.get(p);
        out.push(...(full ? wordsOf(full) : [stem(p)]));
      }
    }
    return out.filter((w) => !STOP.has(w));
  }

  /** The names a property goes by, each as a word list: its label, both institutions' labels, synonyms and its own name. */
  phrases(p: OntologyProperty): string[][] {
    const list = [p.label, p.id.split('.')[1]!.replace(/_/g, ' '), ...Object.values(p.labels_by_type ?? {}), ...Object.values(p.synonyms ?? {}).flat()];
    return [...new Set(list.filter(Boolean) as string[])].map(wordsOf).filter((w) => w.length);
  }
}

const f1 = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  const both = [...A].filter((w) => B.has(w)).length;
  if (!both) return 0;
  const p = both / A.size;
  const r = both / B.size;
  return (2 * p * r) / (p + r);
};

// ---- scoring ----------------------------------------------------------------------------------

const COMPAT: Record<string, Partial<Record<ColumnKind, number>>> = {
  identifier: { key: 1, reference: 0.3, number: 0.2 },
  reference: { reference: 1, code: 0.6, number: 0.4, key: 0.2 },
  date: { date: 1 },
  money: { money: 1, number: 0.4 },
  rate: { rate1000: 1, money: 0.3, number: 0.3 },
  percent: { number: 0.7, money: 0.5 },
  ratio: { number: 0.7, money: 0.5 },
  code: { code: 1, flag: 0.5, number: 0.2 },
  flag: { flag: 1, code: 0.3 },
  count: { number: 0.6, code: 0.3 },
  score: { number: 0.7, code: 0.2 },
  number: { number: 0.7, money: 0.5, code: 0.3 },
  text: { text: 1, code: 0.3 },
};
const KIND_WORD: Record<ColumnKind, string> = { date: 'dates', key: 'a unique key', reference: 'references to another table', flag: 'yes or no values', money: 'dollar amounts', rate1000: 'rates in thousandths of a percent', code: 'a short list of codes', number: 'numbers', text: 'text', empty: 'nothing' };
const KIND_FROM: Record<ColumnKind, string> = { date: 'date', key: 'key', reference: 'reference', flag: 'flag', money: 'money', rate1000: 'number', code: 'code', number: 'number', text: 'text', empty: 'text' };

const plainTransform = (kind: ColumnKind, p: OntologyProperty, c: ColumnProfile): MapTransform =>
  kind === 'date' ? 'date8' : kind === 'rate1000' ? 'rate1000' : p.type === 'code' ? 'code' : ['key', 'reference', 'money', 'number'].includes(kind) || (c.numericShare >= 0.99 && p.type !== 'text') ? 'number' : 'same';

export interface ScoreOptions {
  /** Kinective's mapping for this core, "TABLE.COLUMN" to property, used as precedent; omit to hide it. */
  precedent?: Map<string, string> | null;
  /** Tie-out results, "TABLE.COLUMN|property" to pass or fail, worked out by the caller. */
  tieOuts?: Map<string, boolean>;
  /** Use the vendor's column descriptions as a vocabulary signal. */
  descriptions?: boolean;
}

/** Every DI table a core may feed, with its columns and the property each holds. */
export function diTargets(o: Ontology, tables: string[]) {
  return tables.map((t) => ({
    table: t,
    columns: [...o.columnIndex].filter(([col]) => col.startsWith(`${t}.`)).map(([col, prop]) => ({ column: col.split('.')[1]!, property: o.properties.get(prop)! })),
  }));
}

/** Lines each core entity up with the DI table whose properties its columns fit best, one to one. */
export function assignTables(o: Ontology, p: CoreProfile, targets: ReturnType<typeof diTargets>, vocab: Vocabulary) {
  const owner = entities(p);
  const ents = [...new Set(owner.values())];
  const pairs: { entity: string; table: string; score: number }[] = [];
  for (const e of ents) {
    const cols = p.columns.filter((c) => owner.get(c.table) === e && c.kind !== 'empty');
    if (!cols.length) continue;
    for (const t of targets) {
      // How well the DI table's properties are covered by the entity's columns, on names and kinds.
      let sum = 0;
      for (const { property } of t.columns) {
        let best = 0;
        for (const c of cols) best = Math.max(best, 0.6 * vocabScore(vocab, c, property, p, false) + 0.4 * valueScore(c, property, vocab).score);
        sum += best;
      }
      const cls = o.classes.get(t.columns[0]?.property.class ?? '');
      const clsWords = cls ? [cls.label, ...Object.values(cls.labels_by_type ?? {}), ...Object.values(cls.synonyms ?? {}).flat()].flatMap(wordsOf) : [];
      const tableWords = p.tables.filter((x) => owner.get(x.table) === e).flatMap((x) => vocab.split(x.table));
      const nameBonus = tableWords.some((w) => clsWords.includes(w)) ? 0.15 : 0;
      pairs.push({ entity: e, table: t.table, score: sum / Math.max(1, t.columns.length) + nameBonus });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const x of pairs) if (!out.has(x.entity) && !used.has(x.table) && x.score >= 0.25) {
    out.set(x.entity, x.table);
    used.add(x.table);
  }
  return { owner, tableOf: out, pairs };
}

function vocabScore(vocab: Vocabulary, c: ColumnProfile, p: OntologyProperty, prof: CoreProfile, useDescriptions: boolean) {
  const name = vocab.split(c.column);
  let best = 0;
  for (const ph of vocab.phrases(p)) best = Math.max(best, f1(name, ph));
  for (const d of p.derive) for (const w of d.words) best = Math.max(best, 0.9 * f1(name, wordsOf(w)));
  if (useDescriptions) {
    const desc = prof.descriptions?.get(`${c.table}.${c.column}`);
    if (desc) {
      const dw = new Set(wordsOf(desc));
      // A phrase whose words all appear in the vendor's description.
      for (const ph of vocab.phrases(p)) if (ph.every((w) => dw.has(w))) best = Math.max(best, Math.min(1, 0.6 + 0.15 * ph.length));
    }
  }
  return best;
}

function valueScore(c: ColumnProfile, p: OntologyProperty, vocab: Vocabulary): { score: number; transform: MapTransform; derived: boolean } {
  const kind = c.kind ?? kindOf(c);
  // A column with one value all through can't tell records apart, so it fits nothing well.
  const plain = (COMPAT[p.type]?.[kind] ?? 0) * (c.distinct <= 1 ? 0.3 : 1);
  let best = { score: plain, transform: plainTransform(kind, p, c), derived: false };
  const name = vocab.split(c.column);
  for (const d of p.derive) {
    const fits = d.from === KIND_FROM[kind] || (d.from === 'code' && (kind === 'number' || kind === 'code')) || (d.from === 'flag' && kind === 'flag');
    if (!fits) continue;
    const named = d.words.some((w) => wordsOf(w).every((x) => name.includes(x)));
    const s = named ? 1 : 0.5;
    // A derivation the ontology names wins a tie with the plain reading: NONMEMBER is "not a member".
    if (s > best.score || (named && s >= best.score)) best = { score: s, transform: d.transform as MapTransform, derived: true };
  }
  return best;
}

/** Scores every core column against every DI column of the targets. */
export function scoreAll(o: Ontology, p: CoreProfile, tables: string[], opts: ScoreOptions = {}) {
  for (const c of p.columns) c.kind = kindOf(c);
  const vocab = new Vocabulary(o);
  const targets = diTargets(o, tables);
  const { owner, tableOf } = assignTables(o, p, targets, vocab);
  const keyOf = new Map(p.tables.map((t) => [t.table, t.key]));
  // The entity whose key a reference points at, and the DI table it lines up with.
  const entityKey = (t: string) => keyOf.get(owner.get(t) ?? t);
  const candidates: Candidate[] = [];
  for (const c of p.columns) {
    if (c.kind === 'empty') continue;
    const entity = owner.get(c.table) ?? c.table;
    const mine = tableOf.get(entity);
    // Once a core table lines up with a DI table, its columns are candidates for that table only.
    for (const t of targets.filter((x) => !mine || x.table === mine)) for (const { column, property } of t.columns) {
      const why: string[] = [];
      const vocabulary = vocabScore(vocab, c, property, p, !!opts.descriptions);
      const v = valueScore(c, property, vocab);
      let structure = 0;
      if (mine === t.table) {
        structure = 0.6;
        const isKey = entityKey(c.table) === c.column && owner.get(c.table) === c.table;
        if (property.type === 'identifier' && isKey) structure = 1;
        else if (property.type === 'identifier') structure = 0.3;
        else if (property.type === 'reference' && c.refersTo) {
          // A reference to the entity DI's party table comes from (the member's account) fits an owner or borrower.
          const target = tableOf.get(owner.get(c.refersTo.table) ?? c.refersTo.table);
          structure = target === 'cdm_party' && (property.refers_to === 'member' || property.refers_to === 'household') ? 1 : 0.7;
        } else if (isKey) structure = 0.2;
      }
      const key = `${c.table}.${c.column}`;
      const pre = opts.precedent ? (opts.precedent.has(key) ? (opts.precedent.get(key) === property.id ? 1 : 0) : null) : null;
      const tie = opts.tieOuts?.has(`${key}|${property.id}`) ? (opts.tieOuts.get(`${key}|${property.id}`) ? 1 : 0) : null;
      const parts: [keyof typeof WEIGHTS, number | null][] = [['vocabulary', vocabulary], ['values', v.score], ['structure', structure], ['precedent', pre], ['tieOut', tie]];
      const used = parts.filter(([, s]) => s !== null) as [keyof typeof WEIGHTS, number][];
      const total = used.reduce((s, [k]) => s + WEIGHTS[k], 0);
      const score = used.reduce((s, [k, x]) => s + WEIGHTS[k] * x, 0) / total;
      if (score < 0.3) continue;
      if (vocabulary >= 0.5) why.push('the name fits');
      if (v.derived) why.push(`it can be derived (${v.transform})`);
      else if (v.score >= 0.9) why.push(`it holds ${KIND_WORD[c.kind ?? 'text']}`);
      if (structure >= 1) why.push(property.type === 'identifier' ? 'it is the table’s key' : 'it points at the member’s account');
      if (pre === 1) why.push('Kinective’s mapping says so');
      if (tie === 1) why.push('it ties out to the regulatory return');
      candidates.push({ coreTable: c.table, coreColumn: c.column, diTable: t.table, diColumn: column, property: property.id, score: Math.round(score * 1000) / 1000, signals: { vocabulary, values: v.score, structure, precedent: pre, tieOut: tie }, transform: v.transform, why });
    }
  }
  return { candidates, tableOf, owner };
}

/** The best candidates, one core column to one DI column, each with its band and the runner-up. */
export function assign(candidates: Candidate[], opts: { standard?: Map<string, string> } = {}): Proposal[] {
  const sorted = [...candidates].filter((c) => c.score >= PROPOSE_AT).sort((a, b) => b.score - a.score || a.coreColumn.localeCompare(b.coreColumn));
  const takenDi = new Set<string>();
  const takenCore = new Set<string>();
  const out: Proposal[] = [];
  for (const c of sorted) {
    const di = `${c.diTable}.${c.diColumn}`;
    const core = `${c.coreTable}.${c.coreColumn}`;
    if (takenDi.has(di) || takenCore.has(core)) continue;
    takenDi.add(di);
    takenCore.add(core);
    // The closest alternative: another core column for this DI column, or another DI column for this core column.
    const rival = candidates.filter((x) => x !== c && ((x.diTable === c.diTable && x.diColumn === c.diColumn) || (x.coreTable === c.coreTable && x.coreColumn === c.coreColumn))).sort((a, b) => b.score - a.score)[0];
    const margin = rival ? Math.round((c.score - rival.score) * 1000) / 1000 : 1;
    const std = opts.standard?.get(core) === c.property;
    const band: Proposal['band'] = std ? 'standard' : c.score >= BANDS.auto && c.signals.tieOut === 1 && margin >= BANDS.margin ? 'auto' : c.score >= BANDS.review && margin >= BANDS.margin ? 'review' : 'person';
    out.push({ ...c, band, margin, runnerUp: rival ? { coreColumn: `${rival.coreTable}.${rival.coreColumn}`, diColumn: `${rival.diTable}.${rival.diColumn}`, score: rival.score } : null });
  }
  return out;
}

/** How many of a known mapping's DI columns the proposals got right, and which they missed. */
export function compareWith(proposals: Proposal[], known: { diTable: string; diColumn: string; core: string; transform: string }[]) {
  const got = new Map(proposals.map((p) => [`${p.diTable}.${p.diColumn}`, p]));
  const rows = known.map((k) => {
    const p = got.get(`${k.diTable}.${k.diColumn}`);
    return { di: `${k.diTable}.${k.diColumn}`, expected: k.core, proposed: p ? `${p.coreTable}.${p.coreColumn}` : null, right: !!p && `${p.coreTable}.${p.coreColumn}` === k.core, transformRight: !!p && p.transform === k.transform, score: p?.score ?? null, band: p?.band ?? null };
  });
  const knownCore = new Set(known.map((k) => k.core));
  const extra = proposals.filter((p) => !knownCore.has(`${p.coreTable}.${p.coreColumn}`) && !known.some((k) => `${k.diTable}.${k.diColumn}` === `${p.diTable}.${p.diColumn}`));
  return { total: rows.length, right: rows.filter((r) => r.right).length, transformsRight: rows.filter((r) => r.right && r.transformRight).length, rows, extra };
}
