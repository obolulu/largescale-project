"""Check the seed data matches the demo table in docs/PLAN.md, without a database."""

from decimal import Decimal

from app import pricing
from app.models import BillStatus, UsageType
from scripts.seed import INTERNET_BATCH_MB, PERIODS, _batched_usage

EXPECTED = {
    ("5551001", 9): ("50", BillStatus.PAID),
    ("5551001", 10): ("80", BillStatus.UNPAID),
    ("5551002", 9): ("90", BillStatus.PARTIAL),
    ("5551002", 10): ("50", BillStatus.UNPAID),
}


def test_seed_periods_produce_documented_bills():
    for subscriber_no, _year, month, minutes, mb, paid in PERIODS:
        total, status = EXPECTED[(subscriber_no, month)]
        amounts = pricing.calculate(minutes, mb)
        assert amounts.total == Decimal(total)
        assert pricing.bill_status(amounts.total, paid) is status


def test_batched_usage_preserves_total_and_month():
    rows = _batched_usage("5551002", 2026, 9, UsageType.INTERNET, 30_001, INTERNET_BATCH_MB)
    assert sum(r.amount for r in rows) == 30_001
    assert rows[-1].amount == 1
    assert all(r.created_at.month == 9 for r in rows)


def test_batched_usage_with_zero_total_has_no_rows():
    assert _batched_usage("5551002", 2026, 10, UsageType.INTERNET, 0, INTERNET_BATCH_MB) == []
