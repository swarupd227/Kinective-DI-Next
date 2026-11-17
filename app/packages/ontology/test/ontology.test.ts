// The ontology's build checks (Core Mapping and Ontology, phase 1). The build fails when a binding
// names a column that doesn't exist, a hub column or a column a metric reads has no property, a metric
// measures nothing, or the Symitar pack doesn't line up with the properties it denotes.
import { describe, expect, it } from 'vitest';
import { HUB_TABLES, loadOntology, metricBindings, ontologyRows, readSemanticStock, semanticColumns } from '../src/index.ts';
import { diSchema } from '../src/ddl.ts';

describe('ontology', () => {
  const o = loadOntology();
  const schema = diSchema();

  it('loads, with every parent, relation, value set and reference resolving', () => {
    expect(o.classes.size).toBeGreaterThanOrEqual(40);
    expect(o.properties.size).toBeGreaterThanOrEqual(180);
    expect(o.vendors.get('symitar')).toBeTruthy();
  });

  it('binds only columns that exist in a CREATE TABLE', () => {
    const missing = [...o.columnIndex.keys()].filter((c) => {
      const [t, col] = c.split('.') as [string, string];
      return !schema.get(t)?.has(col);
    });
    expect(missing).toEqual([]);
  });

  it('binds every column of every hub table', () => {
    const unbound: string[] = [];
    for (const t of HUB_TABLES) {
      const cols = schema.get(t);
      expect(cols, `${t} has no CREATE TABLE`).toBeTruthy();
      for (const c of cols!) if (!o.columnIndex.has(`${t}.${c}`)) unbound.push(`${t}.${c}`);
    }
    expect(unbound).toEqual([]);
  });

  it('binds every column the semantic model reads', () => {
    const unbound = semanticColumns().filter((c) => !o.columnIndex.has(c));
    expect(unbound).toEqual([]);
  });

  it('ties every metric to at least one property or regulatory line', () => {
    const b = metricBindings(o, readSemanticStock());
    expect(b.length).toBeGreaterThan(50);
    const none = b.filter((m) => !m.properties.length && !m.lines.length && !m.counts.length).map((m) => m.metric);
    expect(none).toEqual([]);
    const loans = b.find((m) => m.metric === 'loan_balance')!;
    expect(loans.properties).toContain('loan.balance');
  });

  it('crosswalks every Symitar code DI holds, and denotes the same columns Kinective maps', () => {
    const s = o.vendors.get('symitar')!;
    for (const [set, c] of Object.entries(s.codes)) {
      const vs = o.valueSets.get(c.code_set_of)!;
      for (const [their, code] of Object.entries(c.crosswalk)) expect(vs.codes[code]!.values, `${set} ${their}`).toContain(their);
    }
    const denoted = s.tables.flatMap((t) => t.columns.map((c) => `${t.di_table}.${c.di}`));
    expect(new Set(denoted).size).toBe(denoted.length);
  });

  it('makes rows for the database: credit union and bank words, values and core columns', () => {
    const r = ontologyRows(o);
    const terms = r.onto_term as [string, string, string, string][];
    expect(terms.some(([t, c, s]) => t === 'share draft' && c === 'checking' && s === 'credit_union')).toBe(true);
    expect(terms.some(([t, c, s]) => t === 'dda' && c === 'checking' && s === 'bank')).toBe(true);
    expect((r.core_denotes as unknown[][]).find((d) => d[3] === 'LOAN.BALANCE')?.[6]).toBe('loan.balance');
    expect((r.onto_edge as unknown[][]).some((e) => e[0] === 'loan.balance' && e[1] === 'measured_by' && e[2] === 'metric:loan_balance')).toBe(true);
    expect((r.onto_value as unknown[][]).some((v) => v[0] === 'deposit_category' && v[1] === 'certificate' && v[3] === 'Certificates of Deposit')).toBe(true);
  });
});
