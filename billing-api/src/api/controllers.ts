/** Version 1 of the public API, mounted at /api/v1. */
import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

import { AdminOnly, Authenticated, CurrentPrincipal } from '../auth/guards';
import { createAccessToken, Principal, resolveSubscriber, verifyPassword } from '../auth/security';
import { BillingService } from '../billing/billing.service';
import { ApiError } from '../common/api-error';
import { User } from '../database/entities';
import {
  AddUsageRequest,
  AddUsageResponse,
  ApiErrorResponses,
  BillDetailed,
  BillSummary,
  CalculateBillRequest,
  CalculateBillResponse,
  HealthResponse,
  LoginRequest,
  LoginResponse,
  PayBillRequest,
  PayBillResponse,
  QueryBillDetailedParams,
  QueryBillParams,
} from './schemas';

@ApiTags('meta')
@Controller()
export class HealthController {
  @Get('health')
  @ApiOperation({ summary: 'Health' })
  @ApiOkResponse({ type: HealthResponse })
  health(): HealthResponse {
    return { status: 'ok', version: 'v1' };
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly db: DataSource) {}

  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Login',
    description: 'Exchange username and password for a JWT. Send it as `Authorization: Bearer <token>`.',
  })
  @ApiOkResponse({ type: LoginResponse })
  @ApiErrorResponses(401, 422)
  async login(@Body() body: LoginRequest): Promise<LoginResponse> {
    const user = await this.db.manager.findOneBy(User, { username: body.username });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
    }
    const { token, lifetime } = createAccessToken(user);
    return {
      access_token: token,
      token_type: 'bearer',
      expires_in: lifetime,
      role: user.role,
      subscriber_no: user.subscriberNo,
    };
  }
}

@ApiTags('usage')
@Controller('usage')
export class UsageController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  @HttpCode(201)
  @AdminOnly()
  @ApiOperation({
    summary: 'Add Usage',
    description:
      '**Add Usage** (admin). Records one event: 10 minutes for PHONE, 1 MB for INTERNET.\n\n' +
      'Usage is not billed until Calculate Bill runs for that period again.',
  })
  @ApiCreatedResponse({ type: AddUsageResponse })
  @ApiErrorResponses(401, 403, 404, 422)
  addUsage(@Body() body: AddUsageRequest): Promise<AddUsageResponse> {
    return this.billing.addUsage(body.subscriber_no, body.year, body.month, body.usage_type);
  }
}

@ApiTags('bills')
@Controller('bills')
export class BillsController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @ApiOperation({
    summary: 'Query Bill',
    description: '**Query Bill** (no authentication, per the spec). Total, paid amount, remaining balance, status.',
  })
  @ApiOkResponse({ type: BillSummary })
  @ApiErrorResponses(404, 422)
  queryBill(@Query() q: QueryBillParams): Promise<BillSummary> {
    return this.billing.queryBill(q.subscriber_no, q.year, q.month);
  }

  @Get('detailed')
  @Authenticated()
  @ApiOperation({
    summary: 'Query Bill Detailed',
    description:
      '**Query Bill Detailed** (authenticated, paged). Usage totals, charge breakdown and a page of usage records.',
  })
  @ApiOkResponse({ type: BillDetailed })
  @ApiErrorResponses(401, 403, 404, 422)
  queryBillDetailed(
    @Query() q: QueryBillDetailedParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BillDetailed> {
    const target = resolveSubscriber(principal, q.subscriber_no);
    return this.billing.queryBillDetailed(target, q.year, q.month, q.page, q.page_size);
  }

  @Post('calculate')
  @HttpCode(200)
  @AdminOnly()
  @ApiOperation({
    summary: 'Calculate Bill',
    description:
      '**Calculate Bill** (admin). Computes the bill from recorded usage and stores it.\n\n' +
      'Running it again for the same period updates the charges and keeps any payments already made.',
  })
  @ApiOkResponse({ type: CalculateBillResponse })
  @ApiErrorResponses(401, 403, 404, 422)
  calculateBill(@Body() body: CalculateBillRequest): Promise<CalculateBillResponse> {
    return this.billing.calculateBill(body.subscriber_no, body.year, body.month);
  }
}

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  @HttpCode(201)
  @Authenticated()
  @ApiOperation({
    summary: 'Pay Bill',
    description:
      '**Pay Bill** (authenticated). Records a simulated full or partial payment. No card processing.\n\n' +
      '`transaction_id` is the idempotency key: a repeated ID returns 409 and records nothing.\n' +
      'Amounts above the remaining balance are rejected.',
  })
  @ApiCreatedResponse({ type: PayBillResponse })
  @ApiErrorResponses(401, 403, 404, 409, 422)
  payBill(@Body() body: PayBillRequest, @CurrentPrincipal() principal: Principal): Promise<PayBillResponse> {
    const target = resolveSubscriber(principal, body.subscriber_no);
    return this.billing.payBill(target, body.year, body.month, body.amount, body.transaction_id);
  }
}

export const CONTROLLERS = [HealthController, AuthController, UsageController, BillsController, PaymentsController];
