/**
 * Shared test setup: a Nest app on the test database, the same fixtures as the
 * original conftest.py, and helpers for logging in, adding usage and billing.
 *
 * The schema is rebuilt once per file and the tables are truncated and
 * reseeded before every test. TEST_DATABASE_URL must point at a throwaway
 * database: the billing tables in it are dropped.
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule, configureApp } from '../src/app';
import { hashPassword } from '../src/auth/security';
import { Subscriber, UsageRecord, User } from '../src/database/entities';
import { Role, UsageType } from '../src/database/enums';

export const SUB1 = '5551001';
export const SUB2 = '5551002';
export const UNKNOWN_SUB = '5559999';
export const PASSWORD = 'test-pass';
const HASH = hashPassword(PASSWORD, 4); // low cost: tests only

export type Headers = Record<string, string>;

export interface TestContext {
  app: INestApplication;
  ds: DataSource;
  http: () => ReturnType<typeof request>;
  login: (username: string) => Promise<Headers>;
  /** Insert usage directly (one row per type), bypassing Add Usage's 10 min / 1 MB unit. */
  addUsageRows: (subscriberNo: string, year: number, month: number, usage?: { minutes?: number; mb?: number; day?: number }) => Promise<void>;
  /** Record usage and run Calculate Bill through the API. Returns the response body. */
  makeBill: (subscriberNo: string, year: number, month: number, usage?: { minutes?: number; mb?: number }) => Promise<any>;
}

async function rebuildSchema(ds: DataSource): Promise<void> {
  await ds.query('DROP TABLE IF EXISTS payments, bills, usage_records, users, subscribers, migrations CASCADE');
  await ds.query('DROP TYPE IF EXISTS bill_status, usage_type, user_role');
  await ds.runMigrations({ transaction: 'all' });
}

async function resetData(ds: DataSource): Promise<void> {
  await ds.query('TRUNCATE payments, bills, usage_records, users, subscribers RESTART IDENTITY CASCADE');
  await ds.manager.insert(Subscriber, [
    { subscriberNo: SUB1, name: 'Test One', plan: 'STANDARD' },
    { subscriberNo: SUB2, name: 'Test Two', plan: 'STANDARD' },
  ]);
  await ds.manager.insert(User, [
    { username: 'admin', passwordHash: HASH, role: Role.ADMIN, subscriberNo: null },
    { username: 'sub1', passwordHash: HASH, role: Role.SUBSCRIBER, subscriberNo: SUB1 },
    { username: 'sub2', passwordHash: HASH, role: Role.SUBSCRIBER, subscriberNo: SUB2 },
  ]);
}

/** Call in a describe/file scope: builds the app once, resets data before each test. */
export function useTestApp(): TestContext {
  const ctx = {} as TestContext;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
    configureApp(app);
    await app.init();
    const ds = app.get(DataSource);
    await rebuildSchema(ds);

    ctx.app = app;
    ctx.ds = ds;
    ctx.http = () => request(app.getHttpServer());
    ctx.login = async (username) => {
      const r = await ctx.http().post('/api/v1/auth/login').send({ username, password: PASSWORD });
      expect(r.status).toBe(200);
      return { Authorization: `Bearer ${r.body.access_token}` };
    };
    ctx.addUsageRows = async (subscriberNo, year, month, { minutes = 0, mb = 0, day = 1 } = {}) => {
      const createdAt = new Date(Date.UTC(year, month - 1, day, 12));
      const rows = [];
      if (minutes) rows.push({ subscriberNo, year, month, usageType: UsageType.PHONE, amount: minutes, createdAt });
      if (mb) rows.push({ subscriberNo, year, month, usageType: UsageType.INTERNET, amount: mb, createdAt });
      if (rows.length) await ds.manager.insert(UsageRecord, rows);
    };
    ctx.makeBill = async (subscriberNo, year, month, usage = {}) => {
      await ctx.addUsageRows(subscriberNo, year, month, usage);
      const r = await ctx
        .http()
        .post('/api/v1/bills/calculate')
        .set(await ctx.login('admin'))
        .send({ subscriber_no: subscriberNo, year, month });
      expect(r.status).toBe(200);
      return r.body;
    };
  });

  beforeEach(() => resetData(ctx.ds));

  afterAll(async () => {
    await ctx.app?.close();
  });

  return ctx;
}
