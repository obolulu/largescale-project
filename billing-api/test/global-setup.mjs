/**
 * Gives the API tests a real PostgreSQL server.
 *
 * TEST_DATABASE_URL set: use that server (for example the docker-compose db:
 *   postgresql://billing:billing_dev_password@localhost:5432/billing_test).
 * Unset: start PGlite, Postgres compiled to WebAssembly, in process and serve it
 * over the Postgres wire protocol, so `npm test` needs no Docker or cloud.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export default async function globalSetup() {
  if (process.env.TEST_DATABASE_URL) return;
  const db = await PGlite.create();
  // PGlite runs one query at a time, so the app's pool is capped at 1 (test/env.ts) to keep
  // transactions from interleaving. The server still accepts a few sockets so the next test
  // file can connect while the previous file's connection is closing.
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 4 });
  await server.start();
  const address = server.getServerConn(); // "127.0.0.1:<port>"
  process.env.TEST_DATABASE_URL = `postgresql://postgres:postgres@${address}/postgres`;
  process.env.TEST_DATABASE_PGLITE = '1';
  globalThis.__PGLITE__ = { db, server };
}
