// FIBO alignment (Core Mapping and Ontology, phase 9): every class links to FIBO or says why it can't,
// and every link names a class read from FIBO's own source, kept in model/fibo-snapshot.json.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadOntology } from '../src/index.ts';

const MODEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'model');

describe('FIBO alignment', () => {
  const o = loadOntology();
  const links = [
    ...[...o.classes.values()].flatMap((c) => (c.fibo ?? []).map((l) => ({ at: c.id, ...l }))),
    ...[...o.valueSets.values()].flatMap((vs) => Object.entries(vs.codes).flatMap(([code, c]) => (c.fibo ?? []).map((l) => ({ at: `${vs.id}.${code}`, ...l })))),
  ];

  it('was read from FIBO at one commit, with a label for every class linked', () => {
    expect(o.fibo.source).toBe('https://github.com/edmcouncil/fibo');
    expect(o.fibo.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const l of links) expect(o.fibo.classes[l.id]?.label, l.id).toBeTruthy();
    // The snapshot holds what's linked and nothing else, so a dropped link doesn't leave a stale entry.
    expect(new Set(links.map((l) => l.id))).toEqual(new Set(Object.keys(o.fibo.classes)));
    expect(Object.values(o.fibo.classes).every((c) => c.file === `${Object.keys(o.fibo.classes).find((k) => o.fibo.classes[k] === c)!.replace(/\/[^/]+$/, '')}.rdf`)).toBe(true);
  });

  it('links most classes, and says why FIBO has nothing for the rest', () => {
    const linked = [...o.classes.values()].filter((c) => c.fibo);
    const none = [...o.classes.values()].filter((c) => c.fibo_none);
    expect(linked.length + none.length).toBe(o.classes.size);
    expect(linked.length).toBeGreaterThanOrEqual(25);
    for (const c of none) expect(c.fibo_none, c.id).toMatch(/^FIBO /);
  });

  it('matches the core concepts as FIBO defines them', () => {
    const at = (id: string) => links.filter((l) => l.at === id).map((l) => `${l.id.split('/').pop()} ${l.match}${l.type ? ` ${l.type}` : ''}`);
    expect(at('checking')).toEqual(['TransactionDepositAccount exact']);
    expect(at('deposit')).toEqual(['DepositAccount exact']);
    expect(at('loan')).toEqual(['Loan exact']);
    expect(at('collateral')).toEqual(['Collateral exact']);
    expect(at('institution')).toEqual(['CreditUnion exact credit_union', 'Bank exact bank']);
    expect(at('loan_category.heloc')).toEqual(['HomeEquityLineOfCredit exact']);
    expect(at('loan_category.auto')).toEqual(['MotorVehicleLoan exact']);
    // A membership application is broader than FIBO's loan application.
    expect(at('application')).toEqual(['LoanApplication narrower']);
    expect(o.fibo.classes['FBC/ProductsAndServices/ClientsAndAccounts/TransactionDepositAccount']!.definition).toMatch(/transfers or withdrawals/);
  });

  it('fails to load when a link names a class the snapshot lacks, or a class has neither links nor a reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onto-fibo-'));
    try {
      cpSync(MODEL, dir, { recursive: true });
      const snap = JSON.parse(readFileSync(join(dir, 'fibo-snapshot.json'), 'utf8'));
      delete snap.classes['FBC/ProductsAndServices/ClientsAndAccounts/TransactionDepositAccount'];
      writeFileSync(join(dir, 'fibo-snapshot.json'), JSON.stringify(snap));
      const yaml = readFileSync(join(dir, 'classes.yaml'), 'utf8');
      writeFileSync(join(dir, 'classes.yaml'), yaml.replace(/\n {4}fibo_none: 'FIBO has no household[^\n]*/, ''));
      expect(() => loadOntology(dir)).toThrow(/household: needs fibo links or fibo_none[\s\S]*class checking: FIBO FBC\/ProductsAndServices\/ClientsAndAccounts\/TransactionDepositAccount isn't in fibo-snapshot\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
