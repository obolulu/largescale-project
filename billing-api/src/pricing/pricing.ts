/**
 * Billing rules from Mobile_Provider_Billing_Guide.md (MOB-BILLING-2026-01).
 *
 * Pure functions, no database, so they are trivially unit-testable.
 * All arithmetic is integer (minutes, MB, cents) to avoid float rounding at
 * block edges: 20,001 MB must cost $60, not $50.
 */
import type { Cents } from '../common/money';
import { BillStatus } from '../database/enums';

export const PHONE_UNIT_MINUTES = 10; // one Add Usage phone event (§2.3)
export const INTERNET_UNIT_MB = 1; // one Add Usage internet event (§3.3)

export const FREE_MINUTES = 1_000; // §2.1
export const PHONE_BLOCK_MINUTES = 1_000; // §2.2
export const PHONE_BLOCK_PRICE: Cents = 10_00;

export const MB_PER_GB = 1_000; // §3.3: 1 GB = 1,000 MB for this assignment
export const INTERNET_BASE_PRICE: Cents = 50_00; // §3.1, charged even at zero usage
export const INCLUDED_MB = 20 * MB_PER_GB; // §3.1
export const INTERNET_BLOCK_MB = 10 * MB_PER_GB; // §3.2
export const INTERNET_BLOCK_PRICE: Cents = 10_00;

function assertUsage(amount: number, what: string): void {
  if (!Number.isInteger(amount)) throw new RangeError(`${what} must be an integer`);
  if (amount < 0) throw new RangeError(`${what} cannot be negative`);
}

/** Number of blocks needed to cover `amount`, counting a partial block as full. */
function startedBlocks(amount: number, blockSize: number): number {
  return Math.ceil(amount / blockSize); // exact: both are small integers
}

export function phoneExtraMinutes(minutes: number): number {
  assertUsage(minutes, 'minutes');
  return Math.max(0, minutes - FREE_MINUTES);
}

export function phoneBlocks(minutes: number): number {
  return startedBlocks(phoneExtraMinutes(minutes), PHONE_BLOCK_MINUTES);
}

/** §4.2: $10 × ceil(max(0, minutes − 1000) / 1000). */
export function phoneCharge(minutes: number): Cents {
  return PHONE_BLOCK_PRICE * phoneBlocks(minutes);
}

export function internetExtraMb(megabytes: number): number {
  assertUsage(megabytes, 'megabytes');
  return Math.max(0, megabytes - INCLUDED_MB);
}

export function internetBlocks(megabytes: number): number {
  return startedBlocks(internetExtraMb(megabytes), INTERNET_BLOCK_MB);
}

/** §4.2: $50 + $10 × ceil(max(0, GB − 20) / 10), computed in MB. */
export function internetCharge(megabytes: number): Cents {
  return INTERNET_BASE_PRICE + INTERNET_BLOCK_PRICE * internetBlocks(megabytes);
}

/** §6.1: due 15 calendar days after the end of the billing month, as YYYY-MM-DD. */
export function dueDate(year: number, month: number): string {
  // Day 0 of the next month is the last day of this one.
  const due = new Date(Date.UTC(year, month, 0));
  due.setUTCDate(due.getUTCDate() + 15);
  return due.toISOString().slice(0, 10);
}

export interface BillAmounts {
  phoneMinutes: number;
  internetMb: number;
  phoneCharge: Cents;
  internetCharge: Cents;
  /** §4.2: no taxes, activation fees, discounts or other charges. */
  total: Cents;
}

export function calculate(phoneMinutes: number, internetMb: number): BillAmounts {
  const phone = phoneCharge(phoneMinutes);
  const internet = internetCharge(internetMb);
  return { phoneMinutes, internetMb, phoneCharge: phone, internetCharge: internet, total: phone + internet };
}

/** §5.1: a partial payment reduces the balance but does not mark the bill paid. */
export function billStatus(total: Cents, paid: Cents): BillStatus {
  if (paid <= 0) return BillStatus.UNPAID;
  if (paid >= total) return BillStatus.PAID;
  return BillStatus.PARTIAL;
}
