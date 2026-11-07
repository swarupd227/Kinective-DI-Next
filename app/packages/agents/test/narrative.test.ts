import { describe, expect, it } from 'vitest';
import { verifyNarrative, type Resolved } from '../src/answer.ts';

const r = new Map<string, Resolved>(
  Object.entries({ total: 'rose $19.8M', ng: 'rose $3.5M', rv: 'rose $3.3M', lk: 'rose $3.2M', eg: 'rose $1.5M', dt: 'rose $4.2M', wp: 'fell $89.8K', cet: 'rose 34 bp' }).map(([id, text]) => [id, { id, value: 0, text } as unknown as Resolved]),
);
const say = (template: string) => verifyNarrative(template, r, ['660.6']).text;

describe('answers that read as sentences', () => {
  it('drops the direction word where a change figure is an amount or a subject', () => {
    expect(say('Downtown {{dt}} out of a total change of {{total}}.')).toBe('Downtown rose $4.2M out of a total change of $19.8M.');
    expect(say('Northgate {{ng}}, Riverside {{rv}} and Lakeshore {{lk}} were close behind, and Eastgate {{eg}} added the least.')).toBe('Northgate ($3.5M), Riverside ($3.3M) and Lakeshore ($3.2M) were close behind, and Eastgate ($1.5M) added the least.');
    expect(say('Westport fell least {{wp}} by {{wp}}.')).toBe('Westport fell least, by $89.8K.');
    expect(say('Deposits {{total}} in September.')).toBe('Deposits rose $19.8M in September.');
    // A rate's change carries its unit; the model's own "percentage points" after it goes.
    expect(say('Capital {{cet}} percentage points over the year.')).toBe('Capital rose 34 bp over the year.');
    expect(say('The ratio {{cet}} points since last year.')).toBe('The ratio rose 34 bp since last year.');
  });

  it('removes a sentence with a placeholder the model wrote badly', () => {
    expect(say('Mortgage rose by $660.6K, out of a total branch change of {{total_chg}`. Other categories barely moved.')).toBe('Other categories barely moved.');
  });
});
