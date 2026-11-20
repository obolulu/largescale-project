export default async function globalTeardown() {
  const pglite = globalThis.__PGLITE__;
  if (!pglite) return;
  await pglite.server.stop();
  await pglite.db.close();
}
