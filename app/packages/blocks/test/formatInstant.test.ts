// A date column holding a moment in time shows in the viewer's own time; a plain date stays as sent.
import { describe, expect, it } from 'vitest';
import { formatInstant } from '../src/format.ts';

describe('formatInstant', () => {
  it('shows a UTC timestamp in local time, as the viewer reads it', () => {
    const at = '2026-11-17T07:33:58Z';
    const local = new Intl.DateTimeFormat(navigator.language, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at));
    expect(formatInstant(at)).toBe(local);
    expect(formatInstant('2026-11-17T07:33:58.123Z')).toBe(local);
  });

  it('leaves plain dates and other text as they came', () => {
    expect(formatInstant('2026-10-25')).toBe('2026-10-25');
    expect(formatInstant('Q3 2026')).toBe('Q3 2026');
    expect(formatInstant(null)).toBe('—');
  });
});
