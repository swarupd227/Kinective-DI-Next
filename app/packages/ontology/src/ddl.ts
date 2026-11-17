// DI's tables and columns, read from every CREATE TABLE under packages/*/src, so a binding can't name
// a column that doesn't exist. The same reading the ESP alignment generator does.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

export function diSchema(root = PACKAGES): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const pkg of readdirSync(root)) {
    const src = join(root, pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?\s*\(/g)) {
        let depth = 1;
        let i = m.index! + m[0].length;
        const start = i;
        while (depth && i < text.length) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') depth--;
          i++;
        }
        const parts: string[] = [];
        let d = 0;
        let cur = '';
        for (const ch of text.slice(start, i - 1)) {
          if (ch === '(') d++;
          if (ch === ')') d--;
          if (ch === ',' && d === 0) {
            parts.push(cur);
            cur = '';
          } else cur += ch;
        }
        parts.push(cur);
        const cols = parts
          .map((p) => p.trim())
          .filter((p) => p && !/^(KEY|PRIMARY|UNIQUE|INDEX|CONSTRAINT|FOREIGN)\b/i.test(p) && !/^\$\{/.test(p))
          .map((p) => p.split(/\s+/)[0]!.replace(/`/g, ''));
        const set = out.get(m[1]!) ?? new Set<string>();
        cols.forEach((c) => set.add(c));
        out.set(m[1]!, set);
      }
    }
  }
  return out;
}
