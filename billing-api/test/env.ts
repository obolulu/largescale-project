// Runs before each test file's imports: point the app at the test database.
process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (process.env.TEST_DATABASE_PGLITE) process.env.DB_POOL_MAX = '1';
