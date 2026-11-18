// DI's ontology as OWL in Turtle (Core Mapping and Ontology, phase 10). No RDF library is installed, so
// this checks the file's shape directly: every prefix used is declared, every statement closes, each
// subject is written once, and the concepts, properties, codes and FIBO mappings are all there.
import { describe, expect, it } from 'vitest';
import { classIri, loadOntology, ontologyTurtle, propertyIri } from '../src/index.ts';

describe('the ontology as OWL', () => {
  const o = loadOntology();
  const ttl = ontologyTurtle(o);
  // Statements without the string literals, so a "." or ";" inside a definition can't confuse the checks.
  const bare = ttl.replace(/"(?:[^"\\]|\\.)*"(?:@[a-z]+)?/g, '""').replace(/^#.*$/gm, '');

  it('declares every prefix it uses, and only IRIs it can write', () => {
    const declared = new Set([...ttl.matchAll(/^@prefix ([a-z-]*): </gm)].map((m) => m[1]));
    const used = new Set([...bare.matchAll(/(?<![\w<:/])([a-z][a-z-]*):[A-Za-z]/g)].map((m) => m[1]));
    expect([...used].filter((p) => !declared.has(p))).toEqual([]);
    expect(declared.has('di')).toBe(true);
    expect(ttl).toContain('@prefix fibo-fbc-pas-caa: <https://spec.edmcouncil.org/fibo/ontology/FBC/ProductsAndServices/ClientsAndAccounts/> .');
  });

  it('closes every statement and writes each subject once', () => {
    const statements = bare.split(/ \.\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('@prefix'));
    expect(bare.trimEnd().endsWith('.')).toBe(true);
    const subjects = statements.map((s) => s.split(/\s/)[0]!).filter((s) => s !== '[]');
    expect(subjects.length).toBe(new Set(subjects).size);
    // Brackets balance in every statement.
    for (const s of statements) expect((s.match(/\[/g) ?? []).length, s.slice(0, 80)).toBe((s.match(/\]/g) ?? []).length);
    // A literal never carries a raw newline or an unescaped quote.
    for (const m of ttl.matchAll(/"((?:[^"\\]|\\.)*)"/g)) expect(m[1]).not.toMatch(/\n/);
  });

  it('has every class, property and code, with FIBO mappings as SKOS', () => {
    for (const c of o.classes.values()) expect(ttl, c.id).toContain(`${classIri(c.id)}\n  a owl:Class`);
    for (const p of o.properties.values()) expect(ttl, p.id).toMatch(new RegExp(`${propertyIri(p.id)}\\n  a owl:(Datatype|Object)Property`));
    expect(ttl).toMatch(/di:Checking\n  a owl:Class[\s\S]*?skos:exactMatch fibo-fbc-pas-caa:TransactionDepositAccount/);
    expect(ttl).toMatch(/di:loanBalance\n  a owl:DatatypeProperty[\s\S]*?rdfs:domain di:Loan[\s\S]*?di:realizedBy "cdm_loan.balance"[\s\S]*?skos:exactMatch fibo-loan-ln-ln:hasLoanBalance/);
    expect(ttl).toMatch(/di:memberBirthDate\n[\s\S]*?di:privacy "direct" ;\n  di:mask "year"/);
    expect(ttl).toMatch(/di:loanCategoryCodes-heloc\n  a skos:Concept[\s\S]*?skos:notation "HELOC"[\s\S]*?skos:exactMatch fibo-loan-spc-cns:HomeEquityLineOfCredit/);
    // A mapping that holds at one institution type is an annotated axiom.
    expect(ttl).toMatch(/owl:annotatedSource di:Institution ;\n  owl:annotatedProperty skos:exactMatch ;\n  owl:annotatedTarget fibo-fbc-fct-fse:CreditUnion ;\n  di:institutionType "credit_union"/);
    expect(ttl).toContain('di:noFiboMatch "FIBO has no household; it relates parties one at a time."@en');
    const mappings = (ttl.match(/^ {2}skos:(exact|close|broad|narrow)Match /gm) ?? []).length;
    expect(mappings).toBeGreaterThanOrEqual(90);
  });
});
