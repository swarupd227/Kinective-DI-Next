import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@dinext/block-schemas';
import { searchFor } from '../src/data.ts';
import { matchesAll, rank } from '../src/search.ts';

const r = (label: string, detail = '', kind: SearchResult['kind'] = 'report'): SearchResult => ({ kind, id: label, label, detail, link: `/x/${label}` });

describe('Ctrl K ranking (FE-SRCH-001)', () => {
  it('matches the start of words, so "board" finds Board report and not Onboarding', () => {
    expect(matchesAll('board', 'Board report')).toBe(true);
    expect(matchesAll('board', 'Onboarding Manager')).toBe(false);
    expect(rank('board', [[r('Onboarding Manager'), r('Board report')]]).map((x) => x.label)).toEqual(['Board report']);
  });

  it('puts the exact name first, then names that start with the text, then the rest', () => {
    const out = rank('branch scorecard', [[r('Scorecard', 'Reports / Branch'), r('Branch scorecard details'), r('Branch scorecard')]]);
    expect(out.map((x) => x.label)).toEqual(['Branch scorecard', 'Branch scorecard details', 'Scorecard']);
  });

  it('treats words people use for the same thing as matches', () => {
    expect(matchesAll('dq', 'Delinquency ratio')).toBe(true);
    expect(matchesAll('customers', 'Members')).toBe(true);
  });

  it('keeps a trusted result (a member found by number) and drops duplicate links', () => {
    const member = r('Suzanne Jackson', '…4521 · Westport', 'member');
    const out = rank('4521', [[member], [member]], { trusted: (x) => x.kind === 'member' });
    expect(out).toHaveLength(1);
  });

  it('the static catalog no longer matches inside words', () => {
    expect(searchFor('executive', 'board', []).map((x) => x.label)).not.toContain('All dashboards');
    expect(searchFor('executive', 'loan', []).map((x) => x.label)).toContain('Loan Accounts');
  });
});
