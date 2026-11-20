/** Check the seed data matches the demo table in docs/PLAN.md, without a database. */
import { dollars } from '../src/common/money';
import { BillStatus, UsageType } from '../src/database/enums';
import * as pricing from '../src/pricing/pricing';
import { batchedUsage, INTERNET_BATCH_MB, PERIODS } from '../scripts/seed';

const EXPECTED: Record<string, [number, BillStatus]> = {
  '5551001-9': [50, BillStatus.PAID],
  '5551001-10': [80, BillStatus.UNPAID],
  '5551002-9': [90, BillStatus.PARTIAL],
  '5551002-10': [50, BillStatus.UNPAID],
};

it('seed periods produce the documented bills', () => {
  for (const { subscriberNo, month, minutes, mb, paid } of PERIODS) {
    const [total, status] = EXPECTED[`${subscriberNo}-${month}`];
    const amounts = pricing.calculate(minutes, mb);
    expect(amounts.total).toBe(dollars(total));
    expect(pricing.billStatus(amounts.total, paid)).toBe(status);
  }
});

it('batched usage preserves the total and the month', () => {
  const rows = batchedUsage('5551002', 2026, 9, UsageType.INTERNET, 30_001, INTERNET_BATCH_MB);
  expect(rows.reduce((sum, r) => sum + r.amount, 0)).toBe(30_001);
  expect(rows[rows.length - 1].amount).toBe(1);
  expect(rows.every((r) => r.createdAt.getUTCMonth() === 8)).toBe(true);
});

it('batched usage with a zero total has no rows', () => {
  expect(batchedUsage('5551002', 2026, 10, UsageType.INTERNET, 0, INTERNET_BATCH_MB)).toEqual([]);
});
