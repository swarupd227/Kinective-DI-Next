import { describe, expect, it } from 'vitest';
import { contrastPairs, contrastRatio, themeValues } from '../src/index.ts';

describe('design token contrast (WCAG 2.2 AA, spec 10.2 and 10.9)', () => {
  for (const theme of ['light', 'dark'] as const) {
    const values = themeValues[theme] as Record<string, string>;
    for (const [fg, bg, min] of contrastPairs) {
      it(`${theme}: ${fg} on ${bg} >= ${min}:1`, () => {
        expect(values[fg], `${fg} missing`).toBeDefined();
        expect(values[bg], `${bg} missing`).toBeDefined();
        expect(contrastRatio(values[fg]!, values[bg]!)).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it('matches the spec reference ratio for teal.600 on white', () => {
    expect(contrastRatio('#057186', '#ffffff')).toBeCloseTo(5.7, 0);
  });
});
