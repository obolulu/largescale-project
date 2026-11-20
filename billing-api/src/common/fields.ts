/**
 * Request field decorators. Each one adds the OpenAPI description, the input
 * coercion, and a single validator that reports the first problem found, so
 * every invalid field gives exactly one {field, message} entry in a 422 response.
 * The messages use the same wording as the original FastAPI/Pydantic service.
 */
import { applyDecorators, ValidationPipe } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptions } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ValidateBy, ValidationError } from 'class-validator';

import { FieldError, validationError } from './api-error';
import { parseDecimal } from './money';

type Check = (value: unknown) => string | null;

interface Common {
  required?: boolean; // default true
  nullable?: boolean; // optional fields may be sent as null
  description?: string;
  example?: unknown;
  default?: unknown;
}

function field(check: Check, api: ApiPropertyOptions, opts: Common, coerce?: (v: unknown) => unknown) {
  const required = opts.required ?? true;
  const full: Check = (value) => {
    if (value === undefined || (value === null && !required && opts.nullable !== false)) {
      return required && value === undefined ? 'Field required' : null;
    }
    return check(value);
  };
  const decorators = [
    ApiProperty({
      ...api,
      required,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.example !== undefined ? { example: opts.example } : {}),
      ...(opts.default !== undefined ? { default: opts.default } : {}),
      ...(!required && opts.nullable ? { nullable: true } : {}),
    } as ApiPropertyOptions),
    ValidateBy({
      name: 'field',
      validator: {
        validate: (value) => full(value) === null,
        defaultMessage: (args) => full(args?.value) ?? 'Input is invalid',
      },
    }),
  ];
  if (coerce) decorators.unshift(Transform(({ value }) => coerce(value)));
  return applyDecorators(...decorators);
}

// ---------- integers ----------

function coerceInt(value: unknown): unknown {
  return typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value) ? Number(value) : value;
}

export function IntField(opts: Common & { min?: number; max?: number } = {}) {
  const check: Check = (value) => {
    if (typeof value === 'string') return 'Input should be a valid integer, unable to parse string as an integer';
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Input should be a valid integer';
    if (!Number.isInteger(value)) return 'Input should be a valid integer, got a number with a fractional part';
    if (opts.min !== undefined && value < opts.min) return `Input should be greater than or equal to ${opts.min}`;
    if (opts.max !== undefined && value > opts.max) return `Input should be less than or equal to ${opts.max}`;
    return null;
  };
  return field(check, { type: 'integer', minimum: opts.min, maximum: opts.max }, opts, coerceInt);
}

// ---------- strings ----------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function StringField(opts: Common & { minLength?: number; maxLength?: number; pattern?: string } = {}) {
  const regex = opts.pattern ? new RegExp(opts.pattern) : undefined;
  const check: Check = (value) => {
    if (typeof value !== 'string') return 'Input should be a valid string';
    const length = [...value].length;
    if (opts.minLength !== undefined && length < opts.minLength) {
      return `String should have at least ${plural(opts.minLength, 'character')}`;
    }
    if (opts.maxLength !== undefined && length > opts.maxLength) {
      return `String should have at most ${plural(opts.maxLength, 'character')}`;
    }
    if (regex && !regex.test(value)) return `String should match pattern '${opts.pattern}'`;
    return null;
  };
  return field(
    check,
    { type: 'string', minLength: opts.minLength, maxLength: opts.maxLength, pattern: opts.pattern },
    opts,
  );
}

// ---------- enums ----------

function listChoices(values: readonly string[]): string {
  const quoted = values.map((v) => `'${v}'`);
  return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

export function EnumField(values: readonly string[], enumName: string, opts: Common = {}) {
  const check: Check = (value) =>
    typeof value === 'string' && values.includes(value) ? null : `Input should be ${listChoices(values)}`;
  return field(check, { enum: [...values], enumName }, opts);
}

// ---------- money ----------

export function MoneyField(opts: Common & { maxDigits: number; decimalPlaces: number }) {
  const check: Check = (value) => {
    if (typeof value !== 'number' && typeof value !== 'string') {
      return 'Decimal input should be an integer, float, string or Decimal object';
    }
    const d = parseDecimal(value);
    if (!d) return 'Input should be a valid decimal';
    if (Math.max(1, d.int.length + d.frac.length) > opts.maxDigits) {
      return `Decimal input should have no more than ${opts.maxDigits} digits in total`;
    }
    if (d.frac.length > opts.decimalPlaces) {
      return `Decimal input should have no more than ${opts.decimalPlaces} decimal places`;
    }
    if (d.sign < 0 || (d.int === '' && d.frac === '')) return 'Input should be greater than 0';
    return null;
  };
  return field(
    check,
    {
      oneOf: [{ type: 'number', exclusiveMinimum: true, minimum: 0 }, { type: 'string' }],
    } as ApiPropertyOptions,
    opts,
  );
}

// ---------- the pipe ----------

function flatten(errors: ValidationError[], prefix = ''): FieldError[] {
  return errors.flatMap((e) => {
    const name = prefix ? `${prefix}.${e.property}` : e.property;
    const own = e.constraints ? [{ field: name, message: Object.values(e.constraints)[0] }] : [];
    return [...own, ...flatten(e.children ?? [], name)];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidUnknownValues: false,
    stopAtFirstError: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => validationError(flatten(errors)),
  });
}
