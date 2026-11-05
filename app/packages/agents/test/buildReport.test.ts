// Asking to build a report goes to the Report Builder, whatever else the request mentions.
import { describe, expect, it } from 'vitest';
import { BUILD_REPORT } from '../src/concierge.ts';
import { RETENTION_REQUEST } from '../src/retention.ts';

describe('building a report routes to the Report Builder', () => {
  it('wins over the words other agents listen for', () => {
    const alco = 'Build me a quarterly ALCO report with deposit mix, loan growth by branch, and certificates maturing in the next 90 days';
    // The certificate agent would have taken this: it says "certificates" and "maturing".
    expect(RETENTION_REQUEST.test(alco)).toBe(true);
    expect(BUILD_REPORT.test(alco)).toBe(true);
    for (const t of ['Create a monthly pack for the board with delinquency by branch', 'Put together a scorecard for Westport', 'Make me a dashboard of payouts by branch']) expect(BUILD_REPORT.test(t), t).toBe(true);
  });

  it('leaves questions that only mention a report alone', () => {
    for (const t of ['Which certificates mature in the next 90 days?', 'Show the October payouts', 'Make the deposit chart a donut', 'Create follow-up tasks for my stalled applications']) expect(BUILD_REPORT.test(t), t).toBe(false);
  });
});
