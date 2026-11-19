// Proposing what an institution's own word means (Core Mapping and Ontology, phase 11), from the
// ontology alone, and reading the word once it's added.
import { describe, expect, it } from 'vitest';
import { conceptsIn, loadOntology, meaningNamed, proposeMeaning, wordMeans } from '../src/index.ts';

const DIMS = { deposit_category: ['Share Savings', 'Share Draft', 'Money Market', 'Certificates of Deposit', 'IRA', 'Checking', 'Savings'], loan_category: ['Auto', 'Personal', 'Mortgage', 'HELOC', 'Credit Card'] };

describe('an institution’s own words', () => {
  const o = loadOntology();

  it('proposes the other institution type’s word for a concept, strongly', () => {
    expect(proposeMeaning(o, 'owners', 'bank', DIMS)).toEqual([{ concept: 'member', kind: 'class', label: 'Customer', strength: 'strong', why: 'A credit union uses “owner” for what you call a customer.' }]);
    expect(proposeMeaning(o, 'customers', 'credit_union', DIMS)[0]).toMatchObject({ concept: 'member', label: 'Member', strength: 'strong' });
  });

  it('proposes a phrase one slip away, as likely', () => {
    expect(proposeMeaning(o, 'certficates', 'bank', DIMS)[0]).toMatchObject({ concept: 'deposit_category.certificate', strength: 'likely' });
    expect(proposeMeaning(o, 'delinquincy', 'credit_union', DIMS)[0]).toMatchObject({ concept: 'delinquency', strength: 'likely', why: '“delinquincy” is spelled nearly like “delinquency”.' });
  });

  it('proposes nothing for a figure nothing defines, or a word DI already reads', () => {
    expect(proposeMeaning(o, 'dividends paid', 'credit_union', DIMS)).toEqual([]);
    expect(proposeMeaning(o, 'promoter', 'bank', DIMS)).toEqual([]);
    expect(proposeMeaning(o, 'share drafts', 'credit_union', DIMS)).toEqual([]);
    expect(wordMeans(o, 'share drafts', 'credit_union', DIMS)?.id).toBe('deposit_category.checking');
  });

  it('reads an added word in a question, and lets it take a phrase over', () => {
    expect(conceptsIn(o, 'How many owners do we have?', 'bank', DIMS)).toEqual([]);
    const words = [{ term: 'owners', concept: 'member' }, { term: 'brnch', concept: 'branch' }];
    expect(conceptsIn(o, 'How many owners do we have?', 'bank', DIMS, words).map((c) => [c.said, c.id])).toEqual([['owners', 'member']]);
    expect(conceptsIn(o, 'Deposits by brnch', 'bank', DIMS, words).map((c) => c.id)).toContain('branch');
    // A word naming something DI doesn't have is ignored.
    expect(conceptsIn(o, 'widgets', 'bank', DIMS, [{ term: 'widgets', concept: 'nothing_here' }])).toEqual([]);
  });

  it('finds a meaning a person names, by id, words or a label at either institution type', () => {
    expect(meaningNamed(o, 'customers', 'bank', DIMS)).toMatchObject({ id: 'member', label: 'Customer' });
    expect(meaningNamed(o, 'members', 'bank', DIMS)).toMatchObject({ id: 'member', label: 'Customer' });
    expect(meaningNamed(o, 'certificates', 'bank', DIMS)).toMatchObject({ id: 'deposit_category.certificate' });
    expect(meaningNamed(o, 'deposit_category.certificate', 'credit_union', DIMS)).toMatchObject({ kind: 'value', value: 'Certificates of Deposit' });
    expect(meaningNamed(o, 'flux capacitors', 'bank', DIMS)).toBeNull();
  });
});
