// Which certificate questions are for Deposit Retention (phase 11): a figure about certificates with none
// of retention's own words goes to Analytics Q&A, by word or by the ontology's certificate code.
import { describe, expect, it } from 'vitest';
import { wantsRetention } from '../src/retention.ts';

describe('certificate questions', () => {
  it('sends a figure to Analytics and keeping money to Retention', () => {
    for (const q of ['How much is in CDs?', 'Total certificate balance by branch', 'How many certificates do we have?', 'Show CD balances by month']) expect(wantsRetention(q), q).toBe(false);
    for (const q of ['Which CDs mature this month?', 'Show certificates maturing at Downtown', 'What is the total balance of certificates maturing this quarter?', 'Which certificates are at risk of leaving?', 'What are our offer rules?', 'Show renewals']) expect(wantsRetention(q), q).toBe(true);
    // Words retention never claimed stay with Analytics either way.
    expect(wantsRetention('How much is in term shares?', [{ id: 'deposit_category.certificate' }])).toBe(false);
  });
});
