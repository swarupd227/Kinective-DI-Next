// Reads every FIBO class and property the ontology links to from FIBO's own source, at one commit, and writes
// model/fibo-snapshot.json with each one's label and definition (phases 9 and 10). The loader fails on a
// link that isn't in the snapshot, so a link can't name a class FIBO doesn't have.
//
//   node packages/ontology/scripts/fibo-snapshot.ts [commit]
//
// A new commit is a review: diff the snapshot and reread each changed definition against DI's.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const MODEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'model');
const OUT = join(MODEL, 'fibo-snapshot.json');
const REPO = 'edmcouncil/fibo';
const prior = (() => {
  try {
    return JSON.parse(readFileSync(OUT, 'utf8')) as { commit: string };
  } catch {
    return null;
  }
})();
const commit = process.argv[2] ?? prior?.commit;
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('Give the FIBO commit to read, as a full 40-character hash.');

// Every link's id, from the YAML as written (the loader needs the snapshot, so it can't be used here).
const ids = new Set<string>();
const collect = (x: unknown): void => {
  if (Array.isArray(x)) x.forEach(collect);
  else if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      if (k === 'fibo' && Array.isArray(v)) for (const l of v) ids.add((l as { id: string }).id);
      else collect(v);
    }
  }
};
for (const f of ['classes.yaml', 'values.yaml', 'properties.yaml']) collect(parse(readFileSync(join(MODEL, f), 'utf8')));

// A class's path names its ontology module: FBC/ProductsAndServices/ClientsAndAccounts/DepositAccount
// is declared in FBC/ProductsAndServices/ClientsAndAccounts.rdf.
const byFile = new Map<string, string[]>();
for (const id of ids) {
  const file = `${id.slice(0, id.lastIndexOf('/'))}.rdf`;
  byFile.set(file, [...(byFile.get(file) ?? []), id]);
}

const unescape = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
const terms: Record<string, { kind: 'class' | 'property'; label: string; definition: string | null; file: string; prefix: string }> = {};
const missing: string[] = [];
for (const [file, list] of [...byFile].sort()) {
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${commit}/${file}`);
  if (!res.ok) throw new Error(`${file}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const entities = new Map([...text.matchAll(/<!ENTITY\s+([\w-]+)\s+"([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
  for (const id of list) {
    const name = id.slice(id.lastIndexOf('/') + 1);
    const ns = `https://spec.edmcouncil.org/fibo/ontology/${id.slice(0, id.lastIndexOf('/'))}/`;
    const prefix = [...entities].find(([, iri]) => iri === ns)?.[0];
    // A class, or an object or datatype property.
    const found = prefix ? new RegExp(`\\n\\t<owl:(Class|ObjectProperty|DatatypeProperty) rdf:about="&${prefix};${name}">([\\s\\S]*?)\\n\\t</owl:\\1>`).exec(text) : null;
    const block = found?.[2];
    const label = block && /<rdfs:label[^>]*>([^<]+)<\/rdfs:label>/.exec(block)?.[1];
    if (!label) {
      missing.push(id);
      continue;
    }
    const definition = /<skos:definition[^>]*>([^<]+)<\/skos:definition>/.exec(block!)?.[1];
    // FIBO's own prefix for the module (fibo-fbc-pas-caa), as its source declares it.
    terms[id] = { kind: found![1] === 'Class' ? 'class' : 'property', label: unescape(label), definition: definition ? unescape(definition) : null, file, prefix: prefix! };
  }
}
if (missing.length) throw new Error(`Not declared in FIBO at ${commit}:\n- ${missing.join('\n- ')}`);

const sorted = Object.fromEntries(Object.entries(terms).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(OUT, `${JSON.stringify({ source: `https://github.com/${REPO}`, commit, read: new Date().toISOString().slice(0, 10), terms: sorted }, null, 1)}\n`);
console.log(`${Object.keys(sorted).length} FIBO classes and properties from ${byFile.size} files at ${commit.slice(0, 7)}`);
