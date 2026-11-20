/** Business operations behind the v1 endpoints. Controllers stay thin; this owns the rules. */
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import type {
  AddUsageResponse,
  BillDetailed,
  BillSummary,
  CalculateBillResponse,
  PayBillResponse,
  Unit,
} from '../api/schemas';
import { ApiError, notFound } from '../common/api-error';
import { formatCents, parseCents, toAmount, type Cents } from '../common/money';
import { isUniqueViolation } from '../database/data-source';
import { Bill, Payment, Subscriber, UsageRecord } from '../database/entities';
import { UsageType } from '../database/enums';
import * as pricing from '../pricing/pricing';

export const UNIT: Record<UsageType, Unit> = { [UsageType.PHONE]: 'MINUTES', [UsageType.INTERNET]: 'MB' };
export const UNIT_AMOUNT: Record<UsageType, number> = {
  [UsageType.PHONE]: pricing.PHONE_UNIT_MINUTES,
  [UsageType.INTERNET]: pricing.INTERNET_UNIT_MB,
};

const pad2 = (n: number) => String(n).padStart(2, '0');

// Recalculation can push the total below what was already paid. There is no
// credit or refund logic (guide §7.3: support decides), so the floor is 0.
const remaining = (bill: Bill): Cents => Math.max(0, bill.total - bill.paidAmount);

export function summarize(bill: Bill): BillSummary {
  return {
    subscriber_no: bill.subscriberNo,
    month: bill.month,
    year: bill.year,
    currency: 'USD',
    total: toAmount(bill.total),
    paid_amount: toAmount(bill.paidAmount),
    remaining_balance: toAmount(remaining(bill)),
    status: bill.status,
    due_date: pricing.dueDate(bill.year, bill.month),
  };
}

function duplicateTransaction(transactionId: string): ApiError {
  return new ApiError(
    409,
    'DUPLICATE_TRANSACTION',
    `Transaction ${transactionId} was already processed. No new payment was recorded.`,
  );
}

@Injectable()
export class BillingService {
  constructor(private readonly db: DataSource) {}

  private async requireSubscriber(m: EntityManager, subscriberNo: string): Promise<void> {
    if (!(await m.existsBy(Subscriber, { subscriberNo }))) {
      throw notFound('SUBSCRIBER_NOT_FOUND', `Subscriber ${subscriberNo} does not exist.`);
    }
  }

  private findBill(m: EntityManager, subscriberNo: string, year: number, month: number, lock = false) {
    const qb = m
      .createQueryBuilder(Bill, 'b')
      .where('b.subscriber_no = :subscriberNo AND b.year = :year AND b.month = :month', {
        subscriberNo,
        year,
        month,
      });
    if (lock) qb.setLock('pessimistic_write'); // SELECT ... FOR UPDATE
    return qb.getOne();
  }

  private async requireBill(m: EntityManager, subscriberNo: string, year: number, month: number, lock = false) {
    const bill = await this.findBill(m, subscriberNo, year, month, lock);
    if (!bill) {
      throw notFound(
        'BILL_NOT_FOUND',
        `No calculated bill for subscriber ${subscriberNo} in ${year}-${pad2(month)}. Run Calculate Bill first.`,
      );
    }
    return bill;
  }

  // ---------- Add Usage ----------

  /** §2.3 / §3.3: each call records one fixed unit, 10 minutes or 1 MB. */
  async addUsage(subscriberNo: string, year: number, month: number, usageType: UsageType): Promise<AddUsageResponse> {
    const m = this.db.manager;
    await this.requireSubscriber(m, subscriberNo);
    const record = await m.save(
      m.create(UsageRecord, { subscriberNo, year, month, usageType, amount: UNIT_AMOUNT[usageType] }),
    );
    return {
      status: 'SUCCESS',
      usage_id: record.id,
      subscriber_no: subscriberNo,
      month,
      year,
      usage_type: usageType,
      amount_added: record.amount,
      unit: UNIT[usageType],
    };
  }

  // ---------- Calculate Bill ----------

  private async usageTotals(m: EntityManager, subscriberNo: string, year: number, month: number) {
    const rows: { usage_type: UsageType; amount: string }[] = await m
      .createQueryBuilder(UsageRecord, 'u')
      .select('u.usage_type', 'usage_type')
      .addSelect('COALESCE(SUM(u.amount), 0)', 'amount')
      .where('u.subscriber_no = :subscriberNo AND u.year = :year AND u.month = :month', {
        subscriberNo,
        year,
        month,
      })
      .groupBy('u.usage_type')
      .getRawMany();
    const totals: Record<UsageType, number> = { [UsageType.PHONE]: 0, [UsageType.INTERNET]: 0 };
    for (const row of rows) totals[row.usage_type] = Number(row.amount);
    return totals;
  }

  /** Compute from recorded usage and store. Recalculating keeps payments already made. */
  calculateBill(subscriberNo: string, year: number, month: number): Promise<CalculateBillResponse> {
    return this.db.transaction(async (m) => {
      await this.requireSubscriber(m, subscriberNo);
      const totals = await this.usageTotals(m, subscriberNo, year, month);
      const amounts = pricing.calculate(totals[UsageType.PHONE], totals[UsageType.INTERNET]);

      let bill = await this.findBill(m, subscriberNo, year, month, true);
      const action = bill ? 'UPDATED' : 'CREATED';
      bill ??= m.create(Bill, { subscriberNo, year, month, paidAmount: 0 });

      bill.phoneMinutes = amounts.phoneMinutes;
      bill.internetMb = amounts.internetMb;
      bill.phoneCharge = amounts.phoneCharge;
      bill.internetCharge = amounts.internetCharge;
      bill.total = amounts.total;
      bill.status = pricing.billStatus(bill.total, bill.paidAmount);
      bill.calculatedAt = new Date();
      bill = await m.save(bill);

      return {
        status: 'SUCCESS',
        action,
        bill: summarize(bill),
        phone_minutes: bill.phoneMinutes,
        internet_mb: bill.internetMb,
        phone_charge: toAmount(bill.phoneCharge),
        internet_charge: toAmount(bill.internetCharge),
      };
    });
  }

  // ---------- Query Bill / Query Bill Detailed ----------

  async queryBill(subscriberNo: string, year: number, month: number): Promise<BillSummary> {
    return summarize(await this.requireBill(this.db.manager, subscriberNo, year, month));
  }

  async queryBillDetailed(
    subscriberNo: string,
    year: number,
    month: number,
    page: number,
    pageSize: number,
  ): Promise<BillDetailed> {
    const m = this.db.manager;
    const bill = await this.requireBill(m, subscriberNo, year, month);

    const period = { subscriberNo, year, month };
    const [records, totalItems] = await m.findAndCount(UsageRecord, {
      where: period,
      order: { createdAt: 'ASC', id: 'ASC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    // The breakdown explains the stored bill, so it uses the bill's usage snapshot.
    const minutes = bill.phoneMinutes;
    const mb = bill.internetMb;
    return {
      ...summarize(bill),
      calculated_at: bill.calculatedAt,
      usage: { phone_minutes: minutes, internet_mb: mb, internet_gb: mb / pricing.MB_PER_GB },
      charges: {
        phone: {
          included_minutes: pricing.FREE_MINUTES,
          extra_minutes: pricing.phoneExtraMinutes(minutes),
          block_minutes: pricing.PHONE_BLOCK_MINUTES,
          blocks_charged: pricing.phoneBlocks(minutes),
          price_per_block: toAmount(pricing.PHONE_BLOCK_PRICE),
          charge: toAmount(bill.phoneCharge),
        },
        internet: {
          base_price: toAmount(pricing.INTERNET_BASE_PRICE),
          included_gb: Math.floor(pricing.INCLUDED_MB / pricing.MB_PER_GB),
          extra_mb: pricing.internetExtraMb(mb),
          block_gb: Math.floor(pricing.INTERNET_BLOCK_MB / pricing.MB_PER_GB),
          blocks_charged: pricing.internetBlocks(mb),
          price_per_block: toAmount(pricing.INTERNET_BLOCK_PRICE),
          charge: toAmount(bill.internetCharge),
        },
        taxes_and_fees: 0,
      },
      usage_items: {
        page,
        page_size: pageSize,
        total_items: totalItems,
        total_pages: Math.ceil(totalItems / pageSize),
        items: records.map((r) => ({
          id: r.id,
          usage_type: r.usageType,
          amount: r.amount,
          unit: UNIT[r.usageType],
          recorded_at: r.createdAt,
        })),
      },
    };
  }

  // ---------- Pay Bill ----------

  /** Simulated payment (no card processing). §5.1 partial payments, §5.3 idempotency. */
  async payBill(
    subscriberNo: string,
    year: number,
    month: number,
    rawAmount: number | string,
    transactionId: string,
  ): Promise<PayBillResponse> {
    const amount = parseCents(rawAmount);
    try {
      return await this.db.transaction(async (m) => {
        if (await m.existsBy(Payment, { transactionId })) throw duplicateTransaction(transactionId);

        const bill = await this.requireBill(m, subscriberNo, year, month, true);
        const balance = remaining(bill);
        if (balance <= 0) throw new ApiError(409, 'BILL_ALREADY_PAID', 'This bill has no outstanding balance.');
        if (amount > balance) {
          throw new ApiError(
            422,
            'AMOUNT_EXCEEDS_BALANCE',
            `Payment of ${String(rawAmount).trim()} exceeds the remaining balance of ${formatCents(balance)}.`,
            { remaining_balance: toAmount(balance) },
          );
        }

        await m.insert(Payment, { billId: bill.id, transactionId, amount });
        bill.paidAmount += amount;
        bill.status = pricing.billStatus(bill.total, bill.paidAmount);
        await m.save(bill);

        const summary = summarize(bill);
        return {
          payment_status: 'SUCCESS',
          transaction_id: transactionId,
          amount: toAmount(amount),
          paid_amount: summary.paid_amount,
          remaining_balance: summary.remaining_balance,
          bill_status: summary.status,
          bill: summary,
        };
      });
    } catch (err) {
      // A concurrent request won the race on transaction_id.
      if (isUniqueViolation(err)) throw duplicateTransaction(transactionId);
      throw err;
    }
  }
}
