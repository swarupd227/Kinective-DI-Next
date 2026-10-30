// FE-ARCH-070: fail when the initial JavaScript (what index.html loads before any lazy chunk)
// exceeds 250 KB gzip, and when any lazy chunk exceeds 350 KB gzip (spec 11.10).
// Usage: node build/check-bundle.mjs apps/shell/dist
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = process.argv[2] ?? 'apps/shell/dist';
const INITIAL_BUDGET = 250 * 1024;
const CHUNK_BUDGET = 350 * 1024;

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const initial = [...html.matchAll(/<(?:script[^>]+src|link[^>]+rel="modulepreload"[^>]+href)="\/?([^"]+\.js)"/g)].map((m) => m[1]);
const gz = (file) => gzipSync(readFileSync(join(dist, file))).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const initialSize = initial.reduce((sum, f) => sum + gz(f), 0);
const lazy = readdirSync(join(dist, 'assets'))
  .filter((f) => f.endsWith('.js') && !initial.includes(`assets/${f}`))
  .map((f) => ({ f, size: gz(join('assets', f)) }));

let failed = false;
console.log(`initial JS ${kb(initialSize)} gzip (budget ${kb(INITIAL_BUDGET)}): ${initial.join(', ')}`);
if (initialSize > INITIAL_BUDGET) failed = true;
for (const { f, size } of lazy.sort((a, b) => b.size - a.size)) {
  if (size > CHUNK_BUDGET) {
    console.error(`lazy chunk ${f} is ${kb(size)} gzip (budget ${kb(CHUNK_BUDGET)})`);
    failed = true;
  }
}
if (failed) {
  console.error('Bundle budget exceeded (spec 11.10, FE-ARCH-070).');
  process.exit(1);
}
console.log(`largest lazy chunk ${lazy[0] ? `${lazy[0].f} ${kb(lazy[0].size)}` : 'none'}; budgets met`);
