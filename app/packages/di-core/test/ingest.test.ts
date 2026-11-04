// Reading and profiling data files for Data Load: delimiters, quotes, headers, types and the problems
// a person needs to hear about before anything loads.
import { describe, expect, it } from 'vitest';
import { convert, looksFixedWidth, parseDelimited, profile, tableNameFrom, type Sheet } from '../src/ingest.ts';

const sheet = (csv: string): Sheet => {
  const [headers, ...rows] = parseDelimited(csv);
  return { headers: headers!, rows, hasHeader: true };
};

describe('reading a delimited file', () => {
  it('handles quotes, embedded commas and doubled quotes', () => {
    expect(parseDelimited('Branch,Note\r\nWestport,"Main St, unit ""B"""\r\n')).toEqual([
      ['Branch', 'Note'],
      ['Westport', 'Main St, unit "B"'],
    ]);
  });

  it('picks the delimiter from the header row', () => {
    expect(parseDelimited('a;b;c\n1;2;3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseDelimited('a\tb\n1\t2')[1]).toEqual(['1', '2']);
  });

  it('spots a fixed-width file', () => {
    expect(looksFixedWidth(parseDelimited('WESTPORT    12000   2026-10-01\nEASTGATE     8000   2026-10-01'))).toBe(true);
    expect(looksFixedWidth(parseDelimited('a,b\n1,2'))).toBe(false);
  });
});

describe('profiling', () => {
  it('works out each column’s type and how full it is', () => {
    const p = profile(sheet('Branch,Target,Share,Start\nWestport,"$12,000",4.5%,2026-10-01\nEastgate,"$8,500",3%,10/1/2026\nNorthgate,,2.0%,2026-10-01'));
    expect(p.columns.map((c) => [c.header, c.kind])).toEqual([
      ['Branch', 'text'],
      ['Target', 'currency'],
      ['Share', 'percent'],
      ['Start', 'date'],
    ]);
    expect(p.columns[1]).toMatchObject({ filled: 2, blank: 1 });
    expect(p.typed[1]).toEqual(['Eastgate', 8500, 3, '2026-10-01']);
    expect(p.blockers).toEqual([]);
  });

  it('names the values that won’t load, and keeps them out', () => {
    const p = profile(sheet('Branch,Target\nA,100\nB,200\nC,300\nD,400\nE,500\nF,600\nG,700\nH,800\nI,900\nJ,lots'));
    expect(p.columns[1]).toMatchObject({ kind: 'number', invalid: 1, invalidExamples: ['lots'] });
    expect(p.warnings.join(' ')).toContain('“lots”');
    expect(p.typed[9]).toEqual(['J', null]);
  });

  it('keeps a mostly-numeric column numeric, with the odd one out flagged', () => {
    const p = profile({ headers: ['Branch', 'Target'], rows: [['A', 1200000], ['B', 850000], ['C', 'TBD'], ['D', 920000]], hasHeader: true });
    expect(p.columns[1]).toMatchObject({ kind: 'number', invalid: 1, invalidExamples: ['TBD'] });
    expect(profile({ headers: ['Note'], rows: [['1'], ['two'], ['three'], ['4']], hasHeader: true }).columns[0]!.kind).toBe('text');
  });

  it('stops on blank or repeated headers, and on an empty file', () => {
    expect(profile(sheet('Branch,\nA,1')).blockers.join(' ')).toContain('no header');
    expect(profile(sheet('Branch,Branch\nA,B')).blockers.join(' ')).toContain('share a header');
    expect(profile({ headers: ['A'], rows: [], hasHeader: true }).blockers.join(' ')).toContain('no data rows');
  });

  it('counts repeated rows', () => {
    expect(profile(sheet('a,b\n1,2\n1,2\n3,4')).duplicateRows).toBe(1);
  });
});

describe('values and names', () => {
  it('converts by type, and refuses what doesn’t fit', () => {
    expect(convert('($1,200.50)', 'currency')).toBe(-1200.5);
    expect(convert('13/40/2026', 'date')).toBeNull();
    expect(convert('Y', 'yesno')).toBe('Yes');
    expect(convert('', 'number')).toBeNull();
  });

  it('names a table after the file', () => {
    expect(tableNameFrom('branch_targets-2026.csv')).toBe('Branch targets 2026');
  });
});
