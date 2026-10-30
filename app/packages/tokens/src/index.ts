import type { TokenName } from './generated/tokens.ts';

export { themeValues, contrastPairs } from './generated/tokens.ts';
export type { TokenName } from './generated/tokens.ts';
export { contrastRatio } from './contrast.ts';

/** CSS `var()` reference for a token, for the rare case a value is needed in TS (e.g. inline SVG). */
export const cssVar = (name: TokenName): string => `var(--${name.replaceAll('.', '-')})`;

/** Reads a token's computed value from the document, e.g. to hand colours to the chart renderer. */
export function readToken(name: TokenName, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(`--${name.replaceAll('.', '-')}`).trim();
}

export const chartPalette: TokenName[] = [
  'color.chart.1',
  'color.chart.2',
  'color.chart.3',
  'color.chart.4',
  'color.chart.5',
  'color.chart.6',
  'color.chart.7',
  'color.chart.8',
];
