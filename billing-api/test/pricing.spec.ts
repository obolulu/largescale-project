import { dollars } from '../src/common/money';
import { BillStatus } from '../src/database/enums';
import { billStatus, calculate, dueDate, internetCharge, phoneCharge } from '../src/pricing/pricing';

describe('phone charge', () => {
  it.each([
    [0, 0],
    [1_000, 0], // §2.1: first 1,000 minutes free
    [1_001, 10], // §2.2 example
    [1_010, 10], // first value reachable through Add Usage past the free tier
    [2_000, 10],
    [2_001, 20], // §2.2 example
    [1_350, 10], // §4.3 worked example
  ])('%i minutes cost $%i', (minutes, expected) => {
    expect(phoneCharge(minutes)).toBe(dollars(expected));
  });
});

describe('internet charge', () => {
  it.each([
    [0, 50], // §3.1: $50 even with zero usage
    [20_000, 50], // §3.2: 20 GB costs $50
    [20_001, 60], // one MB over starts a new block
    [21_000, 60], // §3.2: 21 GB costs $60
    [30_000, 60], // §3.2: 30 GB costs $60
    [30_001, 70],
    [35_000, 70], // §3.2: 35 GB costs $70
  ])('%i MB cost $%i', (megabytes, expected) => {
    expect(internetCharge(megabytes)).toBe(dollars(expected));
  });
});

it('worked example total is $80 (§4.3: 1,350 minutes and 35 GB)', () => {
  const bill = calculate(1_350, 35_000);
  expect(bill.phoneCharge).toBe(dollars(10));
  expect(bill.internetCharge).toBe(dollars(70));
  expect(bill.total).toBe(dollars(80));
});

it('zero usage bill is the base internet price', () => {
  expect(calculate(0, 0).total).toBe(dollars(50));
});

it.each([
  ['phoneCharge', phoneCharge],
  ['internetCharge', internetCharge],
])('%s rejects negative usage', (_name, fn) => {
  expect(() => fn(-1)).toThrow(RangeError);
});

describe('bill status', () => {
  it.each([
    [80, 0, BillStatus.UNPAID],
    [80, 30, BillStatus.PARTIAL], // §5.1: partial payment is not PAID
    [80, 79.99, BillStatus.PARTIAL],
    [80, 80, BillStatus.PAID],
  ])('total $%d, paid $%d -> %s', (total, paid, expected) => {
    expect(billStatus(dollars(total), dollars(paid))).toBe(expected);
  });
});

describe('due date (§6.1: 15 days after the end of the billing month)', () => {
  it.each([
    [2026, 10, '2026-11-15'],
    [2026, 2, '2026-03-15'],
    [2028, 2, '2028-03-15'], // leap year: 29 Feb + 15 days
    [2026, 12, '2027-01-15'],
  ])('%i-%i is due %s', (year, month, expected) => {
    expect(dueDate(year, month)).toBe(expected);
  });
});
