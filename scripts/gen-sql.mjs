#!/usr/bin/env node
/**
 * Generates demo/src/generated/sql.ts from the canonical files in db/.
 *
 * The demo is deployed as its own Vercel project rooted at demo/, so it must
 * not depend on files above that root at build time. Committing the generated
 * module keeps the deploy hermetic; `--check` (used in CI) fails when the
 * committed copy drifts from db/.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const SOURCES = ['schema.sql', 'roles.sql', 'policies.sql', 'seed.sql', 'ops.sql', 'ops_seed.sql'];
const OUT = resolve(root, 'demo/src/generated/sql.ts');

const parts = SOURCES.map((name) => {
  const content = readFileSync(resolve(root, 'db', name), 'utf8');
  return `export const ${name.replace(/[^a-z]/gi, '_').toUpperCase()} = ${JSON.stringify(content)};`;
});

const header = `// GENERATED FILE - do not edit by hand.
// Source: db/{${SOURCES.join(',')}}
// Regenerate: node scripts/gen-sql.mjs
`;

const output = `${header}\n${parts.join('\n\n')}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error('gen-sql: generated file is missing. Run: node scripts/gen-sql.mjs');
    process.exit(1);
  }
  if (current !== output) {
    console.error('gen-sql: generated file is out of date. Run: node scripts/gen-sql.mjs');
    process.exit(1);
  }
  console.log('gen-sql: generated SQL is up to date');
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, output, 'utf8');
console.log(`gen-sql: wrote ${OUT} (${SOURCES.length} files, ${output.length} bytes)`);
