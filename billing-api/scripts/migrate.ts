/**
 * Apply (or, with --revert, roll back one) database migration.
 *
 * Usage (from billing-api/): npm run migrate        # or: node dist/scripts/migrate.js [--revert]
 */
import 'reflect-metadata';

import { createDataSource } from '../src/database/data-source';

async function main(): Promise<number> {
  const ds = await createDataSource().initialize();
  try {
    if (process.argv.includes('--revert')) {
      await ds.undoLastMigration({ transaction: 'all' });
      console.log('Reverted the last migration.');
    } else {
      const applied = await ds.runMigrations({ transaction: 'all' });
      console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(', ')}` : 'Schema is up to date.');
    }
    return 0;
  } finally {
    await ds.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
