import { DataSource, type DataSourceOptions } from 'typeorm';

import { getSettings } from '../config';
import { ENTITIES } from './entities';
import { InitialSchema1763510400000 } from './migrations/1763510400000-InitialSchema';

export const MIGRATIONS = [InitialSchema1763510400000];

export function dataSourceOptions(): DataSourceOptions {
  const s = getSettings();
  return {
    type: 'postgres',
    url: s.databaseUrl,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    synchronize: false,
    extra: { max: s.dbPoolMax },
  };
}

/** A standalone DataSource for the CLI scripts (migrate, seed). */
export function createDataSource(): DataSource {
  return new DataSource(dataSourceOptions());
}

/** Postgres SQLSTATE for unique_violation. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === UNIQUE_VIOLATION || e?.driverError?.code === UNIQUE_VIOLATION;
}
