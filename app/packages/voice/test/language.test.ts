// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { approvalReadBack, classifyConfirmation, normaliseTranscript, sentences, speakable } from '../src/index.ts';

const n = (s: string) => normaliseTranscript(s).normalised;

describe('spoken banking language (spec 7.7)', () => {
  it('turns magnitudes into money and numbers', () => {
    expect(n('loans over two point five million dollars')).toBe('Loans over $2,500,000');
    expect(n('balances above sixty thousand')).toBe('Balances above 60,000');
    expect(n('refer her for about 60 thousand dollars')).toBe('Refer her for about $60,000');
    expect(n('$2.5 million in new loans')).toBe('$2,500,000 in new loans');
  });

  it('handles basis points, quarters, buckets and report names', () => {
    expect(n('rates up fifty bips')).toBe('Rates up 0.50% (50 bp)');
    expect(n('loan growth for q three versus q two')).toBe('Loan growth for Q3 versus Q2');
    expect(n('deposits in the third quarter')).toBe('Deposits in the Q3');
    expect(n('delinquency sixty plus by branch')).toBe('Delinquency 60+ by branch');
    expect(n('show the five three hundred')).toBe('Show the 5300 Call Report');
  });

  it('leaves ordinary words alone', () => {
    expect(n('show me the one at Westport')).toBe('Show me the one at Westport');
    expect(n('refer Suzanne Jackson for a HELOC she prefers email')).toBe('Refer Suzanne Jackson for a HELOC she prefers email');
  });

  it('flags spoken member numbers for an on-screen lookup and keeps only four digits', () => {
    const r = normaliseTranscript('show member four five two one');
    expect(r.normalised).toBe('Show member …4521');
    expect(r.identifiers).toEqual([{ kind: 'member', last4: '4521' }]);
    expect(normaliseTranscript('account number 004521998877 balance').normalised).toBe('Account …8877 balance');
  });

  it('removes SSNs and card numbers before anything is stored (spec 7.9)', () => {
    const r = normaliseTranscript('her social is 123-45-6789 and card 4111 1111 1111 1111');
    expect(r.text).not.toMatch(/6789|4111/);
    expect(r.redactions).toEqual(['SSN', 'CARD']);
  });
});

describe('confirmations (spec 7.6)', () => {
  it('accepts only clear confirmations', () => {
    expect(classifyConfirmation('Confirm.')).toBe('confirm');
    expect(classifyConfirmation('yes, do it')).toBe('confirm');
    expect(classifyConfirmation('sure')).toBe('ambiguous');
    expect(classifyConfirmation('okay, but change the time')).toBe('ambiguous');
    expect(classifyConfirmation('no')).toBe('deny');
    expect(classifyConfirmation('show loans by branch')).toBeNull();
  });

  it('reads back medium cards and never offers voice for high ones', () => {
    expect(approvalReadBack({ summary: 'Send 1 HELOC referral to the Westport Lending Queue', riskTier: 'medium' }, true)).toBe('This will send 1 HELOC referral to the Westport Lending Queue. Say confirm, or press Approve.');
    expect(approvalReadBack({ summary: 'Send 1 HELOC referral to the Westport Lending Queue', riskTier: 'medium' }, false)).toMatch(/press Approve\.$/);
    expect(approvalReadBack({ summary: 'Approve October incentive payouts for Westport branch', riskTier: 'high' }, true)).toBe('This needs your approval on screen.');
  });
});

describe('text for listening (spec 7.11)', () => {
  it('says figures as words and never reads identifiers in full', () => {
    expect(speakable('Total loan balance is **$1.21B**, up **0.4%**. Delinquency rose **5 bp**.')).toBe('Total loan balance is 1.21 billion dollars, up 0.4 percent. Delinquency rose 5 basis points.');
    expect(speakable('Northgate fell -$1.1M. Suzanne Jackson (…4521) at 60+ days.')).toBe('Northgate fell minus 1.1 million dollars. Suzanne Jackson ending in 4521 at 60 plus days.');
    expect(speakable('Referral **#88227** for about $60,000.')).toBe('Referral number 88227 for about 60,000 dollars.');
    expect(speakable('Account 004521998877')).toBe('Account ending in 8877');
  });

  it('splits sentences for captions', () => {
    expect(sentences('One thing. Two things! 3 more?')).toEqual(['One thing.', 'Two things!', '3 more?']);
  });
});
