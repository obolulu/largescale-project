/**
 * Write the OpenAPI spec to docs/openapi.yaml (a graded deliverable).
 *
 * Usage (from billing-api/): npm run export:openapi
 * Needs no database: the app is built in Nest's preview mode.
 * test/openapi.spec.ts fails if the committed file is out of date.
 */
import 'reflect-metadata';

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as yaml from 'js-yaml';

import { buildOpenApiDocument, createApp } from '../src/app';

/** billing-api/, whether this runs from scripts/ (ts-jest) or dist/scripts/ (compiled). */
function packageRoot(dir = __dirname): string {
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return dir;
}

export const SPEC_PATH = join(packageRoot(), '..', 'docs', 'openapi.yaml');

export async function renderOpenApi(): Promise<{ document: object; text: string }> {
  const app = await createApp({ preview: true });
  try {
    const document = buildOpenApiDocument(app);
    // Round-trip through JSON so the YAML holds plain data only.
    const plain = JSON.parse(JSON.stringify(document)) as object;
    return { document: plain, text: yaml.dump(plain, { noRefs: true, lineWidth: 100 }) };
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  renderOpenApi().then(
    ({ text }) => {
      writeFileSync(SPEC_PATH, text, 'utf8');
      console.log(`Wrote ${SPEC_PATH}`);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
