// The expression a custom core mapping may carry (today's DI allows raw SQL here, such as
// IF(CLOSEDATE IS NULL,0,1)). DI Next accepts a small, read-only language instead and writes the SQL
// itself, so nothing a person or a model types can reach the core as SQL:
//
//   a.CLOSEDATE                                  a core column, through the mapping's own aliases
//   'Y', 12, NULL                                literals
//   = <> < > <= >=   AND OR NOT   + - * /        comparison, logic, arithmetic
//   x IS NULL, x IS NOT NULL, x IN ('A', 'B')
//   IF(cond, then, else)  COALESCE(a, b)  TRIM(x)  UPPER(x)  LOWER(x)  ROUND(x, n)  ABS(x)  LEFT(x, n)
//   COUNT_OF(LOAN, PARENTACCOUNT = a.ACCOUNTNUMBER AND CLOSEDATE = '00000000')
//   FIRST_OF(ACCOUNTTRACKING, USERCHAR1, PARENTACCOUNT = a.ACCOUNTNUMBER AND TYPE = 12)
//   SUM_OF(LOAN, BALANCE, PARENTACCOUNT = a.ACCOUNTNUMBER)
//
// Inside COUNT_OF, FIRST_OF and SUM_OF a bare column belongs to the table being looked up; an
// aliased one (a.ACCOUNTNUMBER) to the record being mapped. Tables come from an allow-list for the
// core, every identifier is checked, and strings are escaped by DI, never passed through.

export class MapExprError extends Error {}

type Tok = { k: 'num' | 'str' | 'id' | 'op' | 'punct'; v: string; at: number };

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'IS', 'NULL', 'IN']);
const FUNCS: Record<string, [number, number]> = { IF: [3, 3], COALESCE: [2, 4], TRIM: [1, 1], UPPER: [1, 1], LOWER: [1, 1], ROUND: [1, 2], ABS: [1, 1], LEFT: [2, 2] };
const LOOKUPS = new Set(['COUNT_OF', 'FIRST_OF', 'SUM_OF']);
const MAX_LENGTH = 400;

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/\d/.test(ch)) {
      const m = /^\d+(?:\.\d+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          s += "'";
          j += 2;
        } else if (src[j] === "'") break;
        else s += src[j++];
      }
      if (src[j] !== "'") throw new MapExprError('A text value is missing its closing quote.');
      if (s.length > 80) throw new MapExprError('A text value can be at most 80 characters.');
      out.push({ k: 'str', v: s, at: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '--' || two === '/*' || ch === '#') throw new MapExprError('Comments aren’t allowed in a mapping expression.');
    if (two === '<>' || two === '<=' || two === '>=' || two === '!=') {
      out.push({ k: 'op', v: two === '!=' ? '<>' : two, at: i });
      i += 2;
      continue;
    }
    if ('=<>+-*/'.includes(ch)) {
      out.push({ k: 'op', v: ch, at: i });
      i++;
      continue;
    }
    if ('(),'.includes(ch)) {
      out.push({ k: 'punct', v: ch, at: i });
      i++;
      continue;
    }
    // A semicolon, a comment, a backtick or anything else that isn't the language ends here.
    throw new MapExprError(`“${ch}” isn’t part of a mapping expression.`);
  }
  return out;
}

export interface CompileScope {
  /** The aliases the mapping's FROM gives, such as { a: 'ACCOUNT', n: 'NAME' }. */
  aliases: Record<string, string>;
  /** Core tables a lookup may read. */
  tables: string[];
  /** Columns known per core table, when the caller has them; unknown columns are refused. */
  columns?: Record<string, string[]>;
}

/** Compiles an expression to read-only SQL over the mapping's aliases, or explains what's wrong. */
export function compileMapExpr(src: string, scope: CompileScope): { sql: string; columns: string[] } {
  const text = src.trim();
  if (!text) throw new MapExprError('The expression is empty.');
  if (text.length > MAX_LENGTH) throw new MapExprError(`An expression can be at most ${MAX_LENGTH} characters.`);
  const toks = lex(text);
  let p = 0;
  let sub = 0;
  const used = new Set<string>();
  const peek = () => toks[p];
  const take = () => toks[p++]!;
  const isKw = (w: string) => peek()?.k === 'id' && peek()!.v.toUpperCase() === w;
  const expect = (v: string) => {
    const t = take();
    if (!t || t.v !== v) throw new MapExprError(`Expected “${v}”${t ? ` before “${t.v}”` : ' at the end'}.`);
  };
  const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  const known = (table: string, col: string) => {
    const cols = scope.columns?.[table];
    if (cols && !cols.includes(col)) throw new MapExprError(`${table} has no column ${col}.`);
  };

  // Columns: "a.CLOSEDATE" through an alias, or a bare name inside a lookup.
  const column = (raw: string, inner: { alias: string; table: string } | null): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(raw)) throw new MapExprError(`“${raw}” isn’t a column.`);
    const [first, second] = raw.split('.');
    if (second) {
      const table = scope.aliases[first!];
      if (!table) throw new MapExprError(`“${first}.” isn’t one of this mapping’s tables (${Object.entries(scope.aliases).map(([a, t]) => `${a} for ${t}`).join(', ')}).`);
      const col = second.toUpperCase();
      known(table, col);
      used.add(`${table}.${col}`);
      return `${first}.${col}`;
    }
    if (!inner) throw new MapExprError(`Say which table “${raw}” is from, such as ${Object.keys(scope.aliases)[0]}.${raw.toUpperCase()}.`);
    const col = first!.toUpperCase();
    known(inner.table, col);
    used.add(`${inner.table}.${col}`);
    return `${inner.alias}.${col}`;
  };

  const expr = (inner: { alias: string; table: string } | null): string => or(inner);
  const or = (inner: { alias: string; table: string } | null): string => {
    let left = and(inner);
    while (isKw('OR')) {
      take();
      left = `(${left} OR ${and(inner)})`;
    }
    return left;
  };
  const and = (inner: { alias: string; table: string } | null): string => {
    let left = not(inner);
    while (isKw('AND')) {
      take();
      left = `(${left} AND ${not(inner)})`;
    }
    return left;
  };
  const not = (inner: { alias: string; table: string } | null): string => {
    if (isKw('NOT')) {
      take();
      return `(NOT ${not(inner)})`;
    }
    return compare(inner);
  };
  const compare = (inner: { alias: string; table: string } | null): string => {
    const left = sum(inner);
    if (isKw('IS')) {
      take();
      const neg = isKw('NOT') ? (take(), true) : false;
      if (!isKw('NULL')) throw new MapExprError('“IS” is followed by NULL or NOT NULL.');
      take();
      return `(${left} IS ${neg ? 'NOT ' : ''}NULL)`;
    }
    if (isKw('IN') || (isKw('NOT') && toks[p + 1]?.v.toUpperCase() === 'IN')) {
      const neg = isKw('NOT') ? (take(), true) : false;
      take();
      expect('(');
      const items = [atom(inner)];
      while (peek()?.v === ',') {
        take();
        items.push(atom(inner));
      }
      expect(')');
      if (items.length > 20) throw new MapExprError('An IN list can have at most 20 values.');
      return `(${left} ${neg ? 'NOT ' : ''}IN (${items.join(', ')}))`;
    }
    const t = peek();
    if (t?.k === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
      take();
      return `(${left} ${t.v} ${sum(inner)})`;
    }
    return left;
  };
  const sum = (inner: { alias: string; table: string } | null): string => {
    let left = product(inner);
    while (peek()?.k === 'op' && (peek()!.v === '+' || peek()!.v === '-')) left = `(${left} ${take().v} ${product(inner)})`;
    return left;
  };
  const product = (inner: { alias: string; table: string } | null): string => {
    let left = atom(inner);
    while (peek()?.k === 'op' && (peek()!.v === '*' || peek()!.v === '/')) left = `(${left} ${take().v} ${atom(inner)})`;
    return left;
  };
  const atom = (inner: { alias: string; table: string } | null): string => {
    const t = take();
    if (!t) throw new MapExprError('The expression ends too soon.');
    if (t.k === 'num') return t.v;
    if (t.k === 'str') return quote(t.v);
    if (t.k === 'op' && t.v === '-') return `(-${atom(inner)})`;
    if (t.k === 'punct' && t.v === '(') {
      const e = expr(inner);
      expect(')');
      return `(${e})`;
    }
    if (t.k !== 'id') throw new MapExprError(`“${t.v}” can’t start a value.`);
    const word = t.v.toUpperCase();
    if (word === 'NULL') return 'NULL';
    if (KEYWORDS.has(word)) throw new MapExprError(`“${t.v}” can’t start a value.`);
    if (peek()?.v === '(' && (FUNCS[word] || LOOKUPS.has(word))) {
      take();
      if (LOOKUPS.has(word)) {
        if (inner) throw new MapExprError('A lookup can’t sit inside another lookup.');
        const tab = take();
        if (!tab || tab.k !== 'id') throw new MapExprError(`${word} starts with the table to look in.`);
        const table = tab.v.toUpperCase();
        if (!scope.tables.includes(table)) throw new MapExprError(`${table} isn’t a table this mapping can read. It can read ${scope.tables.join(', ')}.`);
        const alias = `x${sub++}`;
        const me = { alias, table };
        let value = '';
        if (word !== 'COUNT_OF') {
          expect(',');
          const c = take();
          if (!c || c.k !== 'id') throw new MapExprError(`${word} needs the column to read from ${table}.`);
          value = column(c.v, me);
        }
        expect(',');
        const where = expr(me);
        expect(')');
        if (word === 'COUNT_OF') return `(SELECT COUNT(*) FROM ${table} ${alias} WHERE ${where})`;
        if (word === 'SUM_OF') return `(SELECT COALESCE(SUM(${value}), 0) FROM ${table} ${alias} WHERE ${where})`;
        return `(SELECT ${value} FROM ${table} ${alias} WHERE ${where} LIMIT 1)`;
      }
      const args: string[] = [];
      if (peek()?.v !== ')') {
        args.push(expr(inner));
        while (peek()?.v === ',') {
          take();
          args.push(expr(inner));
        }
      }
      expect(')');
      const [lo, hi] = FUNCS[word]!;
      if (args.length < lo || args.length > hi) throw new MapExprError(`${word} takes ${lo === hi ? lo : `${lo} to ${hi}`} values.`);
      return `${word}(${args.join(', ')})`;
    }
    if (FUNCS[word] || LOOKUPS.has(word)) throw new MapExprError(`${word} needs its values in brackets.`);
    return column(t.v, inner);
  };

  const sql = expr(null);
  if (p < toks.length) throw new MapExprError(`Unexpected “${toks[p]!.v}”.`);
  return { sql, columns: [...used] };
}
