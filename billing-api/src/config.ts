import { existsSync } from 'node:fs';

/** Runtime settings, read from environment variables or a .env file. */
export interface Settings {
  databaseUrl: string;
  dbPoolMax: number;
  jwtSecret: string;
  jwtAlgorithm: 'HS256' | 'HS384' | 'HS512';
  jwtExpireMinutes: number;
  // The gateway's validate-jwt policy checks these too.
  jwtIssuer: string;
  jwtAudience: string;
  port: number;
}

let cached: Settings | undefined;
let envFilesLoaded = false;

function loadEnvFiles(): void {
  if (envFilesLoaded || process.env.NODE_ENV === 'test') return;
  envFilesLoaded = true;
  // Values already in the environment win; between the files, the first one found wins.
  for (const file of ['.env', '../.env']) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

/** Accepts SQLAlchemy-style URLs (postgresql+psycopg://) from older .env files. */
export function normalizeDatabaseUrl(url: string): string {
  return url.replace(/^postgres(?:ql)?\+\w+:/, 'postgresql:');
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

export function getSettings(): Settings {
  if (cached) return cached;
  loadEnvFiles();
  const env = process.env;
  cached = {
    databaseUrl: normalizeDatabaseUrl(
      env.DATABASE_URL ?? 'postgresql://billing:billing_dev_password@localhost:5432/billing',
    ),
    dbPoolMax: int('DB_POOL_MAX', 10),
    jwtSecret: env.JWT_SECRET ?? 'local-dev-only-secret-change-me-in-cloud-0001',
    jwtAlgorithm: (env.JWT_ALGORITHM ?? 'HS256') as Settings['jwtAlgorithm'],
    jwtExpireMinutes: int('JWT_EXPIRE_MINUTES', 60),
    jwtIssuer: env.JWT_ISSUER ?? 'billing-api',
    jwtAudience: env.JWT_AUDIENCE ?? 'billing-clients',
    port: int('PORT', 8000),
  };
  return cached;
}
