// Data quality and privacy from the ontology (design: Core Mapping and Ontology, phase 6). Each
// property's constraints and code list become checks on the DI columns that hold it, and its privacy
// class says which columns identify a person. Pure: the checks are run by di-core.
import type { Ontology, OntologyProperty } from './model.ts';

import type { InstitutionType } from './concepts.ts';

export interface OntologyCheck {
  /** The rule as an engineer reads it, unique per check: "cdm_loan.rate between 0 and 30". */
  rule: string;
  /** What it means, for everyone else: "Loan interest rates are between 0% and 30%". */
  name: string;
  dimension: 'Accuracy' | 'Conformity';
  table: string;
  column: string;
  property: string;
  /** Rows that fail, as a WHERE clause on the table (no alias). */
  failsWhen: string;
  params: unknown[];
}

const unit = (p: OntologyProperty, x: number) => (p.type === 'rate' || p.type === 'percent' ? `${x}%` : p.type === 'money' ? `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US')}` : x.toLocaleString('en-US'));
/** "Loan type", not "loan loan type"; "credit score", not "credit score score": the owner's word once. */
const phrase = (owner: string, label: string) => {
  const stem = (w: string) => w.toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
  if (owner.toLowerCase().includes(label.toLowerCase())) return owner;
  return label.split(/[\s-]+/).some((w) => stem(w) === stem(owner.split(/[\s-]+/)[0]!)) ? label : `${owner} ${label}`;
};
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** The thing a property belongs to, in plain words, for a check's name: "loan", "share or deposit". */
const owner = (o: Ontology, p: OntologyProperty, type: InstitutionType) => {
  const c = o.classes.get(p.class);
  return lower(c?.labels_by_type?.[type] ?? c?.label ?? p.class.replace(/_/g, ' '));
};

/**
 * The checks the ontology implies for the DI tables given (those this institution has): a range for a
 * property with min or max, no date after the data's as-of date, and every code on its list when the
 * list is fixed. Columns the property is realized by, in those tables only.
 */
export function ontologyChecks(o: Ontology, tables: Set<string>, type: InstitutionType): OntologyCheck[] {
  const out: OntologyCheck[] = [];
  for (const p of o.properties.values()) {
    const label = lower(p.labels_by_type?.[type] ?? p.label);
    for (const col of p.realized_by) {
      const [table, column] = col.split('.') as [string, string];
      if (!tables.has(table)) continue;
      const of = phrase(owner(o, p, type), label);
      const c = p.constraints;
      if (c && (c.min !== undefined || c.max !== undefined)) {
        const { min, max } = c;
        const rule = min !== undefined && max !== undefined ? `${col} between ${min} and ${max}` : min !== undefined ? `${col} at least ${min}` : `${col} at most ${max}`;
        const name = min !== undefined && max !== undefined ? `Every ${of} is between ${unit(p, min)} and ${unit(p, max)}` : min !== undefined ? (min === 0 ? `No ${of} is negative` : `Every ${of} is at least ${unit(p, min)}`) : `Every ${of} is at most ${unit(p, max!)}`;
        const parts = [...(min !== undefined ? [`\`${column}\` < ?`] : []), ...(max !== undefined ? [`\`${column}\` > ?`] : [])];
        out.push({ rule, name, dimension: 'Accuracy', table, column, property: p.id, failsWhen: `\`${column}\` IS NOT NULL AND (${parts.join(' OR ')})`, params: [...(min !== undefined ? [min] : []), ...(max !== undefined ? [max] : [])] });
      }
      if (c?.not_after_as_of) out.push({ rule: `${col} not after the as-of date`, name: `No ${of} is after the data’s date`, dimension: 'Conformity', table, column, property: p.id, failsWhen: `\`${column}\` IS NOT NULL AND \`${column}\` > ?`, params: ['$asOf'] });
      const vs = p.value_set ? o.valueSets.get(p.value_set) : undefined;
      if (vs && !vs.open) {
        const values = [...new Set(Object.values(vs.codes).flatMap((x) => x.values))];
        out.push({ rule: `${col} on the ${vs.id.replace(/_/g, ' ')} list`, name: `Every ${of} is one DI knows`, dimension: 'Conformity', table, column, property: p.id, failsWhen: `\`${column}\` IS NOT NULL AND \`${column}\` NOT IN (${values.map(() => '?').join(', ')})`, params: values });
      }
    }
  }
  // The engineer's text fits the check table's name column.
  return out.filter((x) => x.rule.length <= 80);
}

export const IDENTIFYING = new Set(['direct', 'quasi']);

/** The privacy class of a DI column (direct, quasi, financial, none), or null when the ontology doesn't bind it. */
export const privacyOfColumn = (o: Ontology, column: string) => {
  const id = o.columnIndex.get(column.toLowerCase());
  return id ? (o.properties.get(id)?.privacy ?? null) : null;
};

/** Every DI column whose property can identify a person, alone (direct) or with other fields (quasi). */
export const identifyingColumns = (o: Ontology) => [...o.columnIndex].filter(([, id]) => IDENTIFYING.has(o.properties.get(id)?.privacy ?? '')).map(([col]) => col).sort();

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The property a field's name means, by its label or a synonym in either institution's words: "Email
 * address", "date of birth". Null when nothing matches exactly; a near match proves nothing.
 */
export function propertyNamed(o: Ontology, name: string): OntologyProperty | null {
  const want = norm(name);
  if (!want) return null;
  for (const p of o.properties.values()) {
    const names = [p.label, p.labels_by_type?.credit_union, p.labels_by_type?.bank, ...(p.synonyms?.credit_union ?? []), ...(p.synonyms?.bank ?? [])];
    if (names.some((x) => x && norm(x) === want)) return p;
  }
  return null;
}

/** A value shown without giving it away: its first character, then dots. Dates and numbers keep only their shape. */
export const maskValue = (v: unknown) => {
  const s = String(v ?? '');
  if (!s) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return '••••-••-••';
  if (/^[\d\s()+.-]+$/.test(s)) {
    // A number keeps its last two digits, as a phone shows "…42".
    let digits = s.replace(/\D/g, '').length;
    return s.replace(/\d/g, (d) => (--digits < 2 ? d : '•'));
  }
  return `${s.charAt(0)}•••`;
};
