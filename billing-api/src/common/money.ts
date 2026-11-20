/**
 * Money is integer cents in code, NUMERIC(10,2) in the database and a JSON
 * number of dollars on the wire (80 for $80.00), so there is no float drift.
 */
import type { ValueTransformer } from 'typeorm';

export type Cents = number;

/**
 * Parse a decimal given as a JSON number or string into sign, integer digits
 * (no leading zeros) and fraction digits (no trailing zeros). Null if it is not a decimal.
 */
export function parseDecimal(value: unknown): { sign: number; int: string; frac: string } | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/.exec(String(value));
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) return null;
  const int = match[2].replace(/^0+/, '');
  const frac = (match[3] ?? '').replace(/0+$/, '');
  const sign = match[1] === '-' && (int !== '' || frac !== '') ? -1 : 1;
  return { sign, int, frac };
}

export const dollars = (amount: number): Cents => Math.round(amount * 100);

/** Cents to the JSON number sent to clients. */
export const toAmount = (cents: Cents): number => cents / 100;

/** Cents as fixed two-decimal text, e.g. 5000 -> "50.00". */
export function formatCents(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A validated request amount (see MoneyField) to cents. */
export function parseCents(value: unknown): Cents {
  const d = parseDecimal(value);
  if (!d || d.frac.length > 2) throw new Error(`Not a money amount: ${String(value)}`);
  return d.sign * (Number(d.int || '0') * 100 + Number(d.frac.padEnd(2, '0')));
}

/** NUMERIC(10,2) column <-> cents. The pg driver returns NUMERIC as a string. */
export const centsTransformer: ValueTransformer = {
  to: (value: Cents | null | undefined) => (value === null || value === undefined ? value : formatCents(value)),
  from: (value: string | null) => (value === null ? null : parseCents(value)),
};
