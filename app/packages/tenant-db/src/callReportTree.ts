// Which totals each Call Report line feeds, and with what sign, so a change to one line can be carried
// up through every total above it: a manual adjustment in DI, or a difference in the institution's own
// prepared figures. Totals with a printed formula use it ("Sum of Accounts A, B less C and D, E": C and
// D subtract; FFIEC formulas use + and -). Totals without one add Schedule A's rows by loan type (025B,
// 041B, 550…). Other totals and ratios are not carried, and DI says so.
export interface CrLineShape {
  code: string;
  schedule: string;
  section: string;
  kind: string;
  name: string;
  formula: string | null;
}

const CODE = /\b(?:RCON|RIAD)[A-Z0-9]{4}\b|\b[A-Z]{0,2}\d{3,4}[A-Z]?\d?\b/g;
const granted = (x: CrLineShape) => /Granted Year-to-Date/i.test(x.name);
const BY_TYPE: Record<string, (x: CrLineShape) => boolean> = {
  '025B': (x) => x.section.startsWith('Section 1') && x.name.endsWith(' - Amount') && x.kind === 'input' && !granted(x),
  '025A': (x) => x.section.startsWith('Section 1') && x.name.endsWith(' - Number of Loans') && x.kind === 'input' && !granted(x),
  '041B': (x) => x.section.startsWith('Section 2') && x.name.endsWith('Total Amount of Loans Delinquent 60+ Days') && x.code !== '041B',
  '041A': (x) => x.section.startsWith('Section 2') && x.name.endsWith('Total Number of Loans Delinquent 60+ Days') && x.code !== '041A',
  '550': (x) => x.section.startsWith('Section 3') && x.name.endsWith(' - Charge Offs YTD'),
  '551': (x) => x.section.startsWith('Section 3') && x.name.endsWith(' - Recoveries YTD'),
};

/** The lines a formula adds (+1) and subtracts (−1). Null for a ratio, which isn't a sum. */
export function formulaTerms(formula: string): Map<string, 1 | -1> | null {
  if (/divided|ratio|percent|\//i.test(formula)) return null;
  const body = formula.split(/;\s*must equal|must equal/i)[0]!;
  const out = new Map<string, 1 | -1>();
  // FFIEC style: "RIADB522 + RIAD4605 - RIAD4635".
  if (!/\bsum of\b|\bless\b/i.test(body) && /[+-]/.test(body)) {
    let sign: 1 | -1 = 1;
    for (const tok of body.split(/\s+/)) {
      if (tok === '+') sign = 1;
      else if (tok === '-' || tok === '−') sign = -1;
      else for (const c of tok.match(CODE) ?? []) out.set(c, sign);
    }
    return out;
  }
  // "Sum of A, B less 719 and AS0048, 798A": what follows "less" up to the next comma or "plus" subtracts.
  let sign: 1 | -1 = 1;
  for (const tok of body.split(/\s+/)) {
    if (/^less$/i.test(tok)) sign = -1;
    else if (/^plus$/i.test(tok)) sign = 1;
    else {
      for (const c of tok.match(CODE) ?? []) out.set(c, sign);
      if (tok.endsWith(',')) sign = 1;
    }
  }
  return out;
}

/** For each line, the totals it feeds directly, with the sign it carries. */
export function crParents(lines: CrLineShape[]): Map<string, { parent: string; sign: 1 | -1 }[]> {
  const parents = new Map<string, { parent: string; sign: 1 | -1 }[]>();
  const add = (child: string, parent: string, sign: 1 | -1) => {
    if (child === parent) return;
    (parents.get(child) ?? parents.set(child, []).get(child)!).push({ parent, sign });
  };
  for (const t of lines.filter((l) => l.kind === 'total')) {
    if (t.formula) {
      const terms = formulaTerms(t.formula);
      if (terms) for (const [c, sign] of terms) add(c, t.code, sign);
      continue;
    }
    // Without a formula, only the loan-type totals have a rule DI trusts; other totals aren't carried.
    const rule = BY_TYPE[t.code];
    if (rule) for (const k of lines.filter((x) => x.schedule === 'A' && rule(x))) add(k.code, t.code, 1);
  }
  return parents;
}

/**
 * The credit union's own prepared 5300 for the current quarter, as it would upload it: DI's figures with
 * three differences a preparer typically has, carried through the totals above them [Assumption: demo].
 * Share drafts presented on the last day that cleared after DI's build; a used-vehicle participation sold
 * on September 30 that the core still carried; and mortgage loans locked for sale after the build.
 */
export const PREPARED_DIFFERENCES: [string, number][] = [
  ['013', 48_250],
  ['370', -1_250_000],
  ['003', 412_600],
];

export function preparedFigures(lines: CrLineShape[], values: unknown[][], diffs = PREPARED_DIFFERENCES) {
  const quarters = [...new Set(values.map((v) => String(v[1])))].sort();
  const current = quarters.at(-1)!;
  const known = new Set(lines.map((l) => l.code));
  const carried = carryUp(lines, new Map(diffs.filter(([c]) => known.has(c))));
  const rows = values.filter((v) => String(v[1]) === current && v[2] !== null).map((v) => [v[0], current, Math.round(((v[2] as number) + (carried.get(v[0] as string) ?? 0)) * 100) / 100]);
  return { quarter: current, rows };
}

/** Carry changes to some lines up through every total above them. Returns the change on every line touched. */
export function carryUp(lines: CrLineShape[], deltas: Map<string, number>, parents = crParents(lines)): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (code: string, d: number, seen: Set<string>) => {
    out.set(code, (out.get(code) ?? 0) + d);
    for (const p of parents.get(code) ?? []) if (!seen.has(p.parent)) walk(p.parent, d * p.sign, new Set([...seen, p.parent]));
  };
  for (const [code, d] of deltas) walk(code, d, new Set([code]));
  return out;
}
