// Axis ticks in a narrow range must stay distinct, or a chart reads "$1B, $1B, $1B".
import { describe, expect, it } from 'vitest';
import { formatAxis } from '../src/format.ts';

describe('axis labels', () => {
  it('keeps balances in a narrow range apart', () => {
    expect(new Set([1.2e9, 1.22e9, 1.24e9].map((v) => formatAxis(v, 'currency'))).size).toBe(3);
    expect(formatAxis(1.22e9, 'currency')).toBe('$1.22B');
    expect(formatAxis(2e6, 'currency')).toBe('$2M');
  });

  it('keeps rates in a narrow range apart', () => {
    expect(new Set([0.39, 0.395, 0.4, 0.405].map((v) => formatAxis(v, 'percent'))).size).toBe(4);
  });
});
