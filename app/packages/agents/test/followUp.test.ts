import { describe, expect, it } from 'vitest';
import { describeRecent, resolvePerson, spellOut, type Shown } from '../src/followUp.ts';

const list: Shown = {
  question: 'Find members at risk of leaving',
  agent: 'DI',
  said: 'Five people need a call this week.',
  shown: ['Members at risk'],
  people: [
    { token: 'mbr_aaaaaaaaaaaaaaaaaaaa', label: 'Kenji Jackson (…8721)' },
    { token: 'mbr_bbbbbbbbbbbbbbbbbbbb', label: 'James Lopez (…5260)' },
    { token: 'mbr_cccccccccccccccccccc', label: 'Mei Adeyemi (…1174)' },
  ],
};

describe('follow-ups that point at what was shown', () => {
  it('resolves "the first one" and "the second member" to the person listed', () => {
    expect(resolvePerson('Tell me more about the first one', [list])).toMatchObject({ token: 'mbr_aaaaaaaaaaaaaaaaaaaa', text: 'Tell me more about Kenji Jackson' });
    expect(resolvePerson('Open the second member', [list])?.token).toBe('mbr_bbbbbbbbbbbbbbbbbbbb');
    expect(resolvePerson('Prepare me for the last one', [list])?.token).toBe('mbr_cccccccccccccccccccc');
    expect(resolvePerson('What about number 2?', [list])?.token).toBe('mbr_bbbbbbbbbbbbbbbbbbbb');
  });

  it('leaves a reference alone when nothing earlier settles it', () => {
    expect(resolvePerson('Tell me more about the first one', [])).toBeNull();
    expect(resolvePerson('Tell me more about the fifth one', [list])).toBeNull();
    // "her" with three people listed could be any of them.
    expect(resolvePerson('What products does she not have? Refer her', [list])).toBeNull();
    // A list from before a later result is not "the first one".
    expect(resolvePerson('The first one', [list, { question: 'Show loans by branch', agent: 'Analytics Q&A', said: 'Westport is largest.', shown: ['Loans by branch'], people: [] }])).toBeNull();
  });

  it('reads "her" as the one person just shown', () => {
    const one: Shown = { ...list, people: [list.people[0]!] };
    expect(resolvePerson('Refer her for a HELOC', [one])).toMatchObject({ token: 'mbr_aaaaaaaaaaaaaaaaaaaa', text: 'Refer Kenji Jackson for a HELOC' });
  });

  it('spells out an application, a list or a row just shown', () => {
    const one: Shown = { question: 'Why is the first one stuck?', agent: 'Loan Pipeline', said: '', shown: ['Application'], people: [], items: ['Tom Ruiz: First mortgage (#2689)'] };
    expect(spellOut('What is it waiting on?', [one], 'Analytics Q&A')).toBe('What is Tom Ruiz: First mortgage (#2689) waiting on?');
    const team: Shown = { question: 'Show my team’s open referrals', agent: 'Referral inbox', said: '', shown: ['Your team’s open referrals'], people: [], items: ['Priya Murphy: Auto loan (#88218)', 'Nora Chen: Retention follow-up (#88214)'] };
    expect(spellOut('Which of those are overdue?', [team], 'Analytics Q&A')).toBe('Which of those in “Your team’s open referrals” (Priya Murphy: Auto loan (#88218); Nora Chen: Retention follow-up (#88214)) are overdue?');
    const staff: Shown = { question: 'Who is behind?', agent: 'Goals & Incentives', said: '', shown: ['Behind on goals'], people: [], items: ['J. Ortiz', 'Sofia Ruiz'] };
    expect(spellOut('Why is the first one behind?', [staff], 'Analytics Q&A')).toBe('Why is J. Ortiz (from “Behind on goals”) behind?');
    // Analytics keeps its own memory of the figures it showed.
    expect(spellOut('Show it as a chart', [{ ...one, agent: 'Analytics Q&A' }], 'Analytics Q&A')).toBeNull();
    expect(spellOut('Show loans by branch', [team], 'Analytics Q&A')).toBeNull();
  });

  it('describes the last turns for the router in plain words', () => {
    const d = describeRecent([list]);
    expect(d).toContain('The user asked "Find members at risk of leaving".');
    expect(d).toContain('DI showed: Members at risk.');
    expect(d).toContain('People listed, in order: Kenji Jackson (…8721), James Lopez (…5260), Mei Adeyemi (…1174).');
    expect(describeRecent([])).toBe('');
  });
});
