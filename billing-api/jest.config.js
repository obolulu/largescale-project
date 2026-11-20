/**
 * The API tests run against real PostgreSQL. With TEST_DATABASE_URL unset,
 * test/global-setup.mjs starts PGlite (Postgres compiled to WebAssembly) in
 * process, so `npm test` needs no Docker, cloud or LLM.
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  globalSetup: '<rootDir>/test/global-setup.mjs',
  globalTeardown: '<rootDir>/test/global-teardown.mjs',
  setupFiles: ['<rootDir>/test/env.ts'],
  // One shared database: run test files one at a time.
  maxWorkers: 1,
  testTimeout: 30000,
};
