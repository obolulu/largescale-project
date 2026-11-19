"""Billing rules from Mobile_Provider_Billing_Guide.md (MOB-BILLING-2026-01).

Pure functions, no database, so they are trivially unit-testable.
All arithmetic is integer (minutes, MB) to avoid float rounding at block edges:
20,001 MB must cost $60, not $50.
"""

from dataclasses import dataclass
from decimal import Decimal

from app.models import BillStatus

PHONE_UNIT_MINUTES = 10  # one Add Usage phone event (§2.3)
INTERNET_UNIT_MB = 1  # one Add Usage internet event (§3.3)

FREE_MINUTES = 1_000  # §2.1
PHONE_BLOCK_MINUTES = 1_000  # §2.2
PHONE_BLOCK_PRICE = Decimal("10.00")

MB_PER_GB = 1_000  # §3.3: 1 GB = 1,000 MB for this assignment
INTERNET_BASE_PRICE = Decimal("50.00")  # §3.1, charged even at zero usage
INCLUDED_MB = 20 * MB_PER_GB  # §3.1
INTERNET_BLOCK_MB = 10 * MB_PER_GB  # §3.2
INTERNET_BLOCK_PRICE = Decimal("10.00")


def _started_blocks(amount: int, block_size: int) -> int:
    """Number of blocks needed to cover `amount`, counting a partial block as full."""
    return -(-amount // block_size)


def phone_charge(minutes: int) -> Decimal:
    """§4.2: $10 × ceil(max(0, minutes − 1000) / 1000)."""
    if minutes < 0:
        raise ValueError("minutes cannot be negative")
    extra = max(0, minutes - FREE_MINUTES)
    return PHONE_BLOCK_PRICE * _started_blocks(extra, PHONE_BLOCK_MINUTES)


def internet_charge(megabytes: int) -> Decimal:
    """§4.2: $50 + $10 × ceil(max(0, GB − 20) / 10), computed in MB."""
    if megabytes < 0:
        raise ValueError("megabytes cannot be negative")
    extra = max(0, megabytes - INCLUDED_MB)
    return INTERNET_BASE_PRICE + INTERNET_BLOCK_PRICE * _started_blocks(extra, INTERNET_BLOCK_MB)


@dataclass(frozen=True)
class BillAmounts:
    phone_minutes: int
    internet_mb: int
    phone_charge: Decimal
    internet_charge: Decimal

    @property
    def total(self) -> Decimal:
        # §4.2: no taxes, activation fees, discounts or other charges.
        return self.phone_charge + self.internet_charge


def calculate(phone_minutes: int, internet_mb: int) -> BillAmounts:
    return BillAmounts(
        phone_minutes=phone_minutes,
        internet_mb=internet_mb,
        phone_charge=phone_charge(phone_minutes),
        internet_charge=internet_charge(internet_mb),
    )


def bill_status(total: Decimal, paid: Decimal) -> BillStatus:
    """§5.1: a partial payment reduces the balance but does not mark the bill paid."""
    if paid <= 0:
        return BillStatus.UNPAID
    if paid >= total:
        return BillStatus.PAID
    return BillStatus.PARTIAL
