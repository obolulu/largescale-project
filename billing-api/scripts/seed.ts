/**
 * Load demo data for the agent scenarios (see docs/PLAN.md, "Seed data").
 *
 * Usage (from billing-api/, after migrating):
 *     npm run seed               # refuses to run if data already exists
 *     npm run seed -- --reset    # wipes all billing tables first
 *
 * The logins below are TEST credentials for local and demo use only.
 *
 * Usage is inserted in batched records (for example 500 MB per row) instead of
 * the 10 min / 1 MB units that Add Usage writes, so a 35 GB month is 70 rows
 * rather than 35,000. Bills are computed with the same pricing module the API uses.
 */
import 'reflect-metadata';

import type { EntityManager } from 'typeorm';

import { hashPassword } from '../src/auth/security';
import { dollars, type Cents } from '../src/common/money';
import { createDataSource } from '../src/database/data-source';
import { Bill, Payment, Subscriber, UsageRecord, User } from '../src/database/entities';
import { Role, UsageType } from '../src/database/enums';
import * as pricing from '../src/pricing/pricing';

export const PHONE_BATCH_MINUTES = 50;
export const INTERNET_BATCH_MB = 500;

export const SUBSCRIBERS: [subscriberNo: string, name: string][] = [
  ['5551001', 'Demo Subscriber One'],
  ['5551002', 'Demo Subscriber Two'],
];

export const USERS: [username: string, password: string, role: Role, subscriberNo: string | null][] = [
  ['admin', 'admin-demo-pass', Role.ADMIN, null],
  ['sub5551001', 'sub1001-demo-pass', Role.SUBSCRIBER, '5551001'],
  ['sub5551002', 'sub1002-demo-pass', Role.SUBSCRIBER, '5551002'],
];

export interface SeedPeriod {
  subscriberNo: string;
  year: number;
  month: number;
  minutes: number;
  mb: number;
  paid: Cents;
}

export const PERIODS: SeedPeriod[] = [
  { subscriberNo: '5551001', year: 2026, month: 9, minutes: 800, mb: 18_000, paid: dollars(50) }, // $50, PAID
  { subscriberNo: '5551001', year: 2026, month: 10, minutes: 1_350, mb: 35_000, paid: 0 }, // $80, UNPAID (guide §4.3)
  { subscriberNo: '5551002', year: 2026, month: 9, minutes: 2_010, mb: 30_001, paid: dollars(40) }, // $90, PARTIAL
  { subscriberNo: '5551002', year: 2026, month: 10, minutes: 600, mb: 0, paid: 0 }, // $50, UNPAID (zero internet)
];

export interface UsageRow {
  subscriberNo: string;
  year: number;
  month: number;
  usageType: UsageType;
  amount: number;
  createdAt: Date;
}

/** Split `total` into rows of at most `batch`, spread over days 1-28 of the month. */
export function batchedUsage(
  subscriberNo: string,
  year: number,
  month: number,
  usageType: UsageType,
  total: number,
  batch: number,
): UsageRow[] {
  const sizes = [...Array<number>(Math.floor(total / batch)).fill(batch), ...(total % batch ? [total % batch] : [])];
  return sizes.map((amount, i) => ({
    subscriberNo,
    year,
    month,
    usageType,
    amount,
    createdAt: new Date(Date.UTC(year, month - 1, 1 + Math.floor((i * 28) / sizes.length), 12)),
  }));
}

export async function wipe(m: EntityManager): Promise<void> {
  for (const entity of [Payment, Bill, UsageRecord, User, Subscriber]) {
    await m.createQueryBuilder().delete().from(entity).execute();
  }
}

export async function seed(m: EntityManager): Promise<void> {
  await m.insert(
    Subscriber,
    SUBSCRIBERS.map(([subscriberNo, name]) => ({ subscriberNo, name, plan: 'STANDARD' })),
  );
  await m.insert(
    User,
    USERS.map(([username, password, role, subscriberNo]) => ({
      username,
      passwordHash: hashPassword(password),
      role,
      subscriberNo,
    })),
  );

  for (const { subscriberNo, year, month, minutes, mb, paid } of PERIODS) {
    const rows = [
      ...batchedUsage(subscriberNo, year, month, UsageType.PHONE, minutes, PHONE_BATCH_MINUTES),
      ...batchedUsage(subscriberNo, year, month, UsageType.INTERNET, mb, INTERNET_BATCH_MB),
    ];
    if (rows.length) await m.insert(UsageRecord, rows);

    const amounts = pricing.calculate(minutes, mb);
    const bill = await m.save(
      m.create(Bill, {
        subscriberNo,
        year,
        month,
        phoneMinutes: minutes,
        internetMb: mb,
        phoneCharge: amounts.phoneCharge,
        internetCharge: amounts.internetCharge,
        total: amounts.total,
        paidAmount: paid,
        status: pricing.billStatus(amounts.total, paid),
      }),
    );

    if (paid > 0) {
      await m.insert(Payment, {
        billId: bill.id,
        transactionId: `seed-${subscriberNo}-${year}${String(month).padStart(2, '0')}`,
        amount: paid,
      });
    }
  }
}

async function main(): Promise<number> {
  const reset = process.argv.includes('--reset');
  const ds = await createDataSource().initialize();
  try {
    const seeded = await ds.transaction(async (m) => {
      if (reset) await wipe(m);
      else if ((await m.count(Subscriber)) > 0) return false;
      await seed(m);
      return true;
    });
    if (!seeded) {
      console.error('Database already has data. Re-run with --reset to wipe and reseed.');
      return 1;
    }
    console.log(`Seeded ${SUBSCRIBERS.length} subscribers, ${USERS.length} users, ${PERIODS.length} bills.`);
    return 0;
  } finally {
    await ds.destroy();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
