// Showing personal values by privacy class (Core Mapping and Ontology, phase 10): every property that
// can identify a person says how it's shown, and one function shows it that way everywhere.
import { describe, expect, it } from 'vitest';
import { IDENTIFYING, loadOntology, maskOf, showAs, showColumn, showProperty } from '../src/index.ts';

describe('showing personal values', () => {
  const o = loadOntology();

  it('has a mask on every property that can identify a person', () => {
    const missing = [...o.properties.values()].filter((p) => IDENTIFYING.has(p.privacy) && !p.mask).map((p) => p.id);
    expect(missing).toEqual([]);
    expect(maskOf(o, 'loan.balance')).toBe('full');
  });

  it('shows each kind of value as its mask allows', () => {
    expect(showAs('email', 'nora.chen@example.com')).toBe('n•••@example.com');
    expect(showAs('last4', '(555) 201-7788')).toBe('(•••) •••-7788');
    expect(showAs('last4', '5552017788')).toBe('(•••) •••-7788');
    expect(showAs('last4', '10004562')).toBe('…4562');
    expect(showAs('year', '1985-03-12')).toBe('1985');
    expect(showAs('year', new Date('1985-03-12T00:00:00Z'))).toBe('1985');
    expect(showAs('first3', '02139')).toBe('021••');
    expect(showAs('first3', '02139-4307')).toBe('021••');
    expect(showAs('street', '1420 Maple Ave')).toBe('••• Maple Ave');
    expect(showAs('street', '12B Oak St Apt 4')).toBe('••• Oak St Apt 4');
    expect(showAs('hidden', '4821')).toBe('•••');
    expect(showAs('full', 'Nora')).toBe('Nora');
    // Too short to keep part of: nothing is shown.
    expect(showAs('last4', '42')).toBe('•••');
    expect(showAs('email', '')).toBe('');
  });

  it('shows a property or a DI column by the ontology', () => {
    expect(showProperty(o, 'member.email', 'sam@example.com')).toBe('s•••@example.com');
    expect(showProperty(o, 'member.ssn_last4', '4821')).toBe('•••');
    expect(showProperty(o, 'member.first_name', 'Nora')).toBe('Nora');
    expect(showColumn(o, 'cdm_party.birth_date', '1985-03-12')).toBe('1985');
    expect(showColumn(o, 'cdm_party_address.zip', '02139')).toBe('021••');
    expect(showColumn(o, 'cdm_loan.balance', 1250.5)).toBe('1250.5');
  });
});
