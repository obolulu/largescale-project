import { existsSync, readFileSync } from 'node:fs';

import * as yaml from 'js-yaml';

import { renderOpenApi, SPEC_PATH } from '../scripts/export-openapi';

type Paths = Record<string, Record<string, { security?: unknown[] }>>;
let document: { paths: Paths };

beforeAll(async () => {
  document = (await renderOpenApi()).document as { paths: Paths };
});

it('the committed docs/openapi.yaml is current', () => {
  expect(existsSync(SPEC_PATH)).toBe(true); // otherwise run: npm run export:openapi
  const committed = yaml.load(readFileSync(SPEC_PATH, 'utf8'));
  expect(committed).toEqual(document); // stale? run: npm run export:openapi
});

it('all operations are versioned', () => {
  const paths = Object.keys(document.paths);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((p) => p.startsWith('/api/v1/'))).toBe(true);
});

it('protected operations declare bearer auth and Query Bill does not', () => {
  const protectedOps: [string, string][] = [
    ['/api/v1/usage', 'post'],
    ['/api/v1/bills/calculate', 'post'],
    ['/api/v1/bills/detailed', 'get'],
    ['/api/v1/payments', 'post'],
  ];
  for (const [path, method] of protectedOps) {
    expect(document.paths[path][method].security).toEqual([{ HTTPBearer: [] }]);
  }
  expect(document.paths['/api/v1/bills'].get.security).toBeUndefined();
});
