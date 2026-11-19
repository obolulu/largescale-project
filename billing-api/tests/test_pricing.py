from decimal import Decimal

import pytest

from app.models import BillStatus
from app.pricing import bill_status, calculate, internet_charge, phone_charge


@pytest.mark.parametrize(
    ("minutes", "expected"),
    [
        (0, "0"),
        (1_000, "0"),  # §2.1: first 1,000 minutes free
        (1_001, "10"),  # §2.2 example
        (1_010, "10"),  # first value reachable through Add Usage past the free tier
        (2_000, "10"),
        (2_001, "20"),  # §2.2 example
        (1_350, "10"),  # §4.3 worked example
    ],
)
def test_phone_charge(minutes, expected):
    assert phone_charge(minutes) == Decimal(expected)


@pytest.mark.parametrize(
    ("megabytes", "expected"),
    [
        (0, "50"),  # §3.1: $50 even with zero usage
        (20_000, "50"),  # §3.2: 20 GB costs $50
        (20_001, "60"),  # one MB over starts a new block
        (21_000, "60"),  # §3.2: 21 GB costs $60
        (30_000, "60"),  # §3.2: 30 GB costs $60
        (30_001, "70"),
        (35_000, "70"),  # §3.2: 35 GB costs $70
    ],
)
def test_internet_charge(megabytes, expected):
    assert internet_charge(megabytes) == Decimal(expected)


def test_worked_example_total_is_80():
    """§4.3: 1,350 minutes and 35 GB → $10 + $70 = $80."""
    bill = calculate(phone_minutes=1_350, internet_mb=35_000)
    assert bill.phone_charge == Decimal("10")
    assert bill.internet_charge == Decimal("70")
    assert bill.total == Decimal("80")


def test_zero_usage_bill_is_base_internet_price():
    assert calculate(0, 0).total == Decimal("50")


@pytest.mark.parametrize("func", [phone_charge, internet_charge])
def test_negative_usage_is_rejected(func):
    with pytest.raises(ValueError):
        func(-1)


@pytest.mark.parametrize(
    ("total", "paid", "expected"),
    [
        ("80", "0", BillStatus.UNPAID),
        ("80", "30", BillStatus.PARTIAL),  # §5.1: partial payment is not PAID
        ("80", "79.99", BillStatus.PARTIAL),
        ("80", "80", BillStatus.PAID),
    ],
)
def test_bill_status(total, paid, expected):
    assert bill_status(Decimal(total), Decimal(paid)) is expected
