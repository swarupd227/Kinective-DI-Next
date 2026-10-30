// Emits JSON Schema (draft 2020-12) for each block type into json/, for the Experience Layer and
// any non-TypeScript consumer (FE-ARCH-002). The Zod schemas in src/ are the authoring source.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { blockSchemasByType } from '../src/blocks.ts';
import { BLOCK_SUPPORT } from '../src/validate.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'json');
mkdirSync(out, { recursive: true });

for (const [type, schema] of Object.entries(blockSchemasByType)) {
  const major = BLOCK_SUPPORT[type as keyof typeof BLOCK_SUPPORT].split('.')[0];
  const json = {
    $id: `https://schemas.dinext.kinective.internal/block/${type}/${major}`,
    title: `DI Next ${type} block v${major}`,
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }),
  };
  writeFileSync(join(out, `${type}.schema.json`), `${JSON.stringify(json, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(blockSchemasByType).length} schemas to ${out}`);
