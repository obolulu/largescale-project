/** Request and response bodies for /api/v1, with their OpenAPI descriptions. */
import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';

import { EnumField, IntField, MoneyField, StringField } from '../common/fields';
import { BILL_STATUSES, BillStatus, Role, ROLES, USAGE_TYPES, UsageType } from '../database/enums';

// ---------- shared field shapes ----------

const SubscriberNo = (opts: { required?: boolean; description?: string } = {}) =>
  StringField({ minLength: 1, maxLength: 20, example: '5551001', ...opts });
const Month = () => IntField({ min: 1, max: 12, example: 10 });
const Year = () => IntField({ min: 2000, max: 2100, example: 2026 });

const UNITS = ['MINUTES', 'MB'] as const;
export type Unit = (typeof UNITS)[number];

// ---------- errors ----------

export class ErrorDetail {
  @ApiProperty({ example: 'UNAUTHORIZED' })
  code: string;

  @ApiProperty({ example: 'Missing or invalid bearer token.' })
  message: string;

  @ApiPropertyOptional({ description: 'Field errors or extra context, when there are any.' })
  details?: unknown;
}

export class ErrorResponse {
  @ApiProperty({ type: ErrorDetail })
  error: ErrorDetail;
}

const ERROR_TEXT: Record<number, string> = {
  401: 'Missing, invalid or expired token',
  403: "Authenticated but not allowed (wrong role or another subscriber's data)",
  404: 'Subscriber or bill not found',
  409: 'Duplicate transaction ID, or bill already paid',
  422: 'Validation failed or business rule violated',
};

/** Swagger entries so each operation shows the error shape per status. */
export function ApiErrorResponses(...codes: number[]) {
  return applyDecorators(
    ApiExtraModels(ErrorResponse),
    ...codes.map((status) => ApiResponse({ status, description: ERROR_TEXT[status], type: ErrorResponse })),
  );
}

// ---------- auth ----------

export class LoginRequest {
  @StringField({ example: 'sub5551001' })
  username: string;

  @StringField({ example: 'sub1001-demo-pass' })
  password: string;
}

export class LoginResponse {
  @ApiProperty()
  access_token: string;

  @ApiProperty({ enum: ['bearer'], example: 'bearer' })
  token_type: 'bearer';

  @ApiProperty({ type: 'integer', example: 3600 })
  expires_in: number;

  @ApiProperty({ enum: ROLES, enumName: 'Role' })
  role: Role;

  @ApiProperty({ type: 'string', nullable: true, example: '5551001' })
  subscriber_no: string | null;
}

// ---------- usage ----------

export class AddUsageRequest {
  @Month() month: number;
  @Year() year: number;
  @SubscriberNo() subscriber_no: string;
  @EnumField(USAGE_TYPES, 'UsageType') usage_type: UsageType;
}

export class AddUsageResponse {
  @ApiProperty({ enum: ['SUCCESS'] }) status: 'SUCCESS';
  @ApiProperty({ type: 'integer' }) usage_id: number;
  @ApiProperty() subscriber_no: string;
  @ApiProperty({ type: 'integer' }) month: number;
  @ApiProperty({ type: 'integer' }) year: number;
  @ApiProperty({ enum: USAGE_TYPES, enumName: 'UsageType' }) usage_type: UsageType;
  @ApiProperty({ type: 'integer' }) amount_added: number;
  @ApiProperty({ enum: UNITS }) unit: Unit;
}

// ---------- bills ----------

export class CalculateBillRequest {
  @Month() month: number;
  @Year() year: number;
  @SubscriberNo() subscriber_no: string;
}

export class QueryBillParams {
  @SubscriberNo() subscriber_no: string;
  @Month() month: number;
  @Year() year: number;
}

export class QueryBillDetailedParams {
  @Month() month: number;
  @Year() year: number;

  @StringField({
    required: false,
    maxLength: 20,
    description: 'Optional for subscribers (must match the token); required for admins.',
  })
  subscriber_no?: string;

  @IntField({ required: false, min: 1, default: 1 })
  page: number = 1;

  @IntField({ required: false, min: 1, max: 100, default: 20 })
  page_size: number = 20;
}

export class BillSummary {
  @ApiProperty() subscriber_no: string;
  @ApiProperty({ type: 'integer' }) month: number;
  @ApiProperty({ type: 'integer' }) year: number;
  @ApiProperty({ enum: ['USD'] }) currency: 'USD';
  @ApiProperty({ example: 80 }) total: number;
  @ApiProperty({ example: 30 }) paid_amount: number;
  @ApiProperty({ example: 50 }) remaining_balance: number;
  @ApiProperty({ enum: BILL_STATUSES, enumName: 'BillStatus' }) status: BillStatus;
  @ApiProperty({ type: 'string', format: 'date', example: '2026-11-15' }) due_date: string;
}

export class CalculateBillResponse {
  @ApiProperty({ enum: ['SUCCESS'] }) status: 'SUCCESS';
  @ApiProperty({ enum: ['CREATED', 'UPDATED'] }) action: 'CREATED' | 'UPDATED';
  @ApiProperty({ type: BillSummary }) bill: BillSummary;
  @ApiProperty({ type: 'integer' }) phone_minutes: number;
  @ApiProperty({ type: 'integer' }) internet_mb: number;
  @ApiProperty() phone_charge: number;
  @ApiProperty() internet_charge: number;
}

export class UsageTotals {
  @ApiProperty({ type: 'integer' }) phone_minutes: number;
  @ApiProperty({ type: 'integer' }) internet_mb: number;
  @ApiProperty() internet_gb: number;
}

export class PhoneChargeDetail {
  @ApiProperty({ type: 'integer' }) included_minutes: number;
  @ApiProperty({ type: 'integer' }) extra_minutes: number;
  @ApiProperty({ type: 'integer' }) block_minutes: number;
  @ApiProperty({ type: 'integer' }) blocks_charged: number;
  @ApiProperty() price_per_block: number;
  @ApiProperty() charge: number;
}

export class InternetChargeDetail {
  @ApiProperty() base_price: number;
  @ApiProperty({ type: 'integer' }) included_gb: number;
  @ApiProperty({ type: 'integer' }) extra_mb: number;
  @ApiProperty({ type: 'integer' }) block_gb: number;
  @ApiProperty({ type: 'integer' }) blocks_charged: number;
  @ApiProperty() price_per_block: number;
  @ApiProperty() charge: number;
}

export class ChargeBreakdown {
  @ApiProperty({ type: PhoneChargeDetail }) phone: PhoneChargeDetail;
  @ApiProperty({ type: InternetChargeDetail }) internet: InternetChargeDetail;
  @ApiProperty({ example: 0 }) taxes_and_fees: number;
}

export class UsageItem {
  @ApiProperty({ type: 'integer' }) id: number;
  @ApiProperty({ enum: USAGE_TYPES, enumName: 'UsageType' }) usage_type: UsageType;
  @ApiProperty({ type: 'integer' }) amount: number;
  @ApiProperty({ enum: UNITS }) unit: Unit;
  @ApiProperty({ type: 'string', format: 'date-time' }) recorded_at: Date;
}

export class UsageItemsPage {
  @ApiProperty({ type: 'integer' }) page: number;
  @ApiProperty({ type: 'integer' }) page_size: number;
  @ApiProperty({ type: 'integer' }) total_items: number;
  @ApiProperty({ type: 'integer' }) total_pages: number;
  @ApiProperty({ type: [UsageItem] }) items: UsageItem[];
}

export class BillDetailed extends BillSummary {
  @ApiProperty({ type: 'string', format: 'date-time' }) calculated_at: Date;
  @ApiProperty({ type: UsageTotals }) usage: UsageTotals;
  @ApiProperty({ type: ChargeBreakdown }) charges: ChargeBreakdown;
  @ApiProperty({ type: UsageItemsPage }) usage_items: UsageItemsPage;
}

// ---------- payments ----------

export class PayBillRequest {
  @Month() month: number;
  @Year() year: number;

  @StringField({
    required: false,
    nullable: true,
    minLength: 1,
    maxLength: 20,
    example: '5551001',
    description: 'Optional for subscribers (taken from the token); required for admins.',
  })
  subscriber_no?: string | null;

  @MoneyField({ maxDigits: 10, decimalPlaces: 2, example: 30 })
  amount: number | string;

  @StringField({
    minLength: 1,
    maxLength: 64,
    pattern: '^[A-Za-z0-9_.:-]+$',
    description: 'Client-generated idempotency key. Reusing one returns 409.',
    example: '3f6c2a9e-0b1d-4c55-9a51-2f1b8f0c7d10',
  })
  transaction_id: string;
}

export class PayBillResponse {
  @ApiProperty({ enum: ['SUCCESS'] }) payment_status: 'SUCCESS';
  @ApiProperty() transaction_id: string;
  @ApiProperty({ example: 30 }) amount: number;
  @ApiProperty({ example: 30 }) paid_amount: number;
  @ApiProperty({ example: 50 }) remaining_balance: number;
  @ApiProperty({ enum: BILL_STATUSES, enumName: 'BillStatus' }) bill_status: BillStatus;
  @ApiProperty({ type: BillSummary }) bill: BillSummary;
}

export class HealthResponse {
  @ApiProperty({ example: 'ok' }) status: string;
  @ApiProperty({ example: 'v1' }) version: string;
}
