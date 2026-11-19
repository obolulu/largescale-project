"""Business operations behind the v1 endpoints. Routers stay thin; this owns the rules."""

from decimal import Decimal
from math import ceil

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import pricing
from app.errors import ApiError, not_found
from app.models import Bill, Payment, Subscriber, UsageRecord, UsageType
from app.schemas import (
    AddUsageResponse,
    BillDetailed,
    BillSummary,
    CalculateBillResponse,
    ChargeBreakdown,
    InternetChargeDetail,
    PayBillResponse,
    PhoneChargeDetail,
    UsageItem,
    UsageItemsPage,
    UsageTotals,
)

UNIT = {UsageType.PHONE: "MINUTES", UsageType.INTERNET: "MB"}
UNIT_AMOUNT = {UsageType.PHONE: pricing.PHONE_UNIT_MINUTES, UsageType.INTERNET: pricing.INTERNET_UNIT_MB}


def _require_subscriber(db: Session, subscriber_no: str) -> None:
    if db.get(Subscriber, subscriber_no) is None:
        raise not_found("SUBSCRIBER_NOT_FOUND", f"Subscriber {subscriber_no} does not exist.")


def _find_bill(db: Session, subscriber_no: str, year: int, month: int, lock: bool = False) -> Bill | None:
    stmt = select(Bill).where(
        Bill.subscriber_no == subscriber_no, Bill.year == year, Bill.month == month
    )
    if lock:
        stmt = stmt.with_for_update()
    return db.scalar(stmt)


def _require_bill(db: Session, subscriber_no: str, year: int, month: int, lock: bool = False) -> Bill:
    bill = _find_bill(db, subscriber_no, year, month, lock)
    if bill is None:
        raise not_found(
            "BILL_NOT_FOUND",
            f"No calculated bill for subscriber {subscriber_no} in {year}-{month:02d}. "
            "Run Calculate Bill first.",
        )
    return bill


def _remaining(bill: Bill) -> Decimal:
    # Recalculation can push the total below what was already paid. There is no
    # credit or refund logic (guide §7.3: support decides), so the floor is 0.
    return max(Decimal("0"), bill.total - bill.paid_amount)


def summarize(bill: Bill) -> BillSummary:
    return BillSummary(
        subscriber_no=bill.subscriber_no,
        month=bill.month,
        year=bill.year,
        total=bill.total,
        paid_amount=bill.paid_amount,
        remaining_balance=_remaining(bill),
        status=bill.status,
        due_date=pricing.due_date(bill.year, bill.month),
    )


# ---------- Add Usage ----------


def add_usage(db: Session, subscriber_no: str, year: int, month: int, usage_type: UsageType) -> AddUsageResponse:
    """§2.3 / §3.3: each call records one fixed unit, 10 minutes or 1 MB."""
    _require_subscriber(db, subscriber_no)
    record = UsageRecord(
        subscriber_no=subscriber_no,
        year=year,
        month=month,
        usage_type=usage_type,
        amount=UNIT_AMOUNT[usage_type],
    )
    db.add(record)
    db.commit()
    return AddUsageResponse(
        usage_id=record.id,
        subscriber_no=subscriber_no,
        month=month,
        year=year,
        usage_type=usage_type,
        amount_added=record.amount,
        unit=UNIT[usage_type],
    )


# ---------- Calculate Bill ----------


def _usage_totals(db: Session, subscriber_no: str, year: int, month: int) -> dict[UsageType, int]:
    rows = db.execute(
        select(UsageRecord.usage_type, func.coalesce(func.sum(UsageRecord.amount), 0))
        .where(
            UsageRecord.subscriber_no == subscriber_no,
            UsageRecord.year == year,
            UsageRecord.month == month,
        )
        .group_by(UsageRecord.usage_type)
    ).all()
    totals = {UsageType.PHONE: 0, UsageType.INTERNET: 0}
    totals.update({usage_type: int(amount) for usage_type, amount in rows})
    return totals


def calculate_bill(db: Session, subscriber_no: str, year: int, month: int) -> CalculateBillResponse:
    """Compute from recorded usage and store. Recalculating keeps payments already made."""
    _require_subscriber(db, subscriber_no)
    totals = _usage_totals(db, subscriber_no, year, month)
    amounts = pricing.calculate(totals[UsageType.PHONE], totals[UsageType.INTERNET])

    bill = _find_bill(db, subscriber_no, year, month, lock=True)
    action = "UPDATED"
    if bill is None:
        action = "CREATED"
        bill = Bill(subscriber_no=subscriber_no, year=year, month=month, paid_amount=Decimal("0"))
        db.add(bill)

    bill.phone_minutes = amounts.phone_minutes
    bill.internet_mb = amounts.internet_mb
    bill.phone_charge = amounts.phone_charge
    bill.internet_charge = amounts.internet_charge
    bill.total = amounts.total
    bill.status = pricing.bill_status(bill.total, bill.paid_amount)
    bill.calculated_at = func.now()
    db.commit()
    db.refresh(bill)

    return CalculateBillResponse(
        action=action,
        bill=summarize(bill),
        phone_minutes=bill.phone_minutes,
        internet_mb=bill.internet_mb,
        phone_charge=bill.phone_charge,
        internet_charge=bill.internet_charge,
    )


# ---------- Query Bill / Query Bill Detailed ----------


def query_bill(db: Session, subscriber_no: str, year: int, month: int) -> BillSummary:
    return summarize(_require_bill(db, subscriber_no, year, month))


def query_bill_detailed(
    db: Session, subscriber_no: str, year: int, month: int, page: int, page_size: int
) -> BillDetailed:
    bill = _require_bill(db, subscriber_no, year, month)

    period = (
        UsageRecord.subscriber_no == subscriber_no,
        UsageRecord.year == year,
        UsageRecord.month == month,
    )
    total_items = db.scalar(select(func.count()).select_from(UsageRecord).where(*period)) or 0
    records = db.scalars(
        select(UsageRecord)
        .where(*period)
        .order_by(UsageRecord.created_at, UsageRecord.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    minutes, mb = bill.phone_minutes, bill.internet_mb
    return BillDetailed(
        **summarize(bill).model_dump(),
        calculated_at=bill.calculated_at,
        usage=UsageTotals(
            phone_minutes=minutes, internet_mb=mb, internet_gb=round(mb / pricing.MB_PER_GB, 3)
        ),
        charges=ChargeBreakdown(
            phone=PhoneChargeDetail(
                included_minutes=pricing.FREE_MINUTES,
                extra_minutes=pricing.phone_extra_minutes(minutes),
                block_minutes=pricing.PHONE_BLOCK_MINUTES,
                blocks_charged=pricing.phone_blocks(minutes),
                price_per_block=pricing.PHONE_BLOCK_PRICE,
                charge=bill.phone_charge,
            ),
            internet=InternetChargeDetail(
                base_price=pricing.INTERNET_BASE_PRICE,
                included_gb=pricing.INCLUDED_MB // pricing.MB_PER_GB,
                extra_mb=pricing.internet_extra_mb(mb),
                block_gb=pricing.INTERNET_BLOCK_MB // pricing.MB_PER_GB,
                blocks_charged=pricing.internet_blocks(mb),
                price_per_block=pricing.INTERNET_BLOCK_PRICE,
                charge=bill.internet_charge,
            ),
        ),
        usage_items=UsageItemsPage(
            page=page,
            page_size=page_size,
            total_items=total_items,
            total_pages=ceil(total_items / page_size),
            items=[
                UsageItem(
                    id=r.id,
                    usage_type=r.usage_type,
                    amount=r.amount,
                    unit=UNIT[r.usage_type],
                    recorded_at=r.created_at,
                )
                for r in records
            ],
        ),
    )


# ---------- Pay Bill ----------


def _duplicate_transaction(transaction_id: str) -> ApiError:
    return ApiError(
        409,
        "DUPLICATE_TRANSACTION",
        f"Transaction {transaction_id} was already processed. No new payment was recorded.",
    )


def pay_bill(
    db: Session, subscriber_no: str, year: int, month: int, amount: Decimal, transaction_id: str
) -> PayBillResponse:
    """Simulated payment (no card processing). §5.1 partial payments, §5.3 idempotency."""
    if db.scalar(select(Payment.id).where(Payment.transaction_id == transaction_id)) is not None:
        raise _duplicate_transaction(transaction_id)

    bill = _require_bill(db, subscriber_no, year, month, lock=True)
    remaining = _remaining(bill)
    if remaining <= 0:
        raise ApiError(409, "BILL_ALREADY_PAID", "This bill has no outstanding balance.")
    if amount > remaining:
        raise ApiError(
            422,
            "AMOUNT_EXCEEDS_BALANCE",
            f"Payment of {amount} exceeds the remaining balance of {remaining}.",
            details={"remaining_balance": float(remaining)},
        )

    db.add(Payment(bill_id=bill.id, transaction_id=transaction_id, amount=amount))
    bill.paid_amount = bill.paid_amount + amount
    bill.status = pricing.bill_status(bill.total, bill.paid_amount)
    try:
        db.commit()
    except IntegrityError as exc:  # a concurrent request won the race on transaction_id
        db.rollback()
        raise _duplicate_transaction(transaction_id) from exc
    db.refresh(bill)

    summary = summarize(bill)
    return PayBillResponse(
        transaction_id=transaction_id,
        amount=amount,
        paid_amount=summary.paid_amount,
        remaining_balance=summary.remaining_balance,
        bill_status=summary.status,
        bill=summary,
    )
