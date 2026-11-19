"""Load demo data for the agent scenarios (see docs/PLAN.md, "Seed data").

Usage (from billing-api/, after `alembic upgrade head`):
    python -m scripts.seed           # refuses to run if data already exists
    python -m scripts.seed --reset   # wipes all billing tables first

The logins below are TEST credentials for local and demo use only.

Usage is inserted in batched records (for example 500 MB per row) instead of
the 10 min / 1 MB units that Add Usage writes, so a 35 GB month is 70 rows
rather than 35,000. Bills are computed with the same pricing module the API uses.
"""

import argparse
import sys
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import pricing
from app.db import SessionLocal
from app.models import Bill, Payment, Role, Subscriber, UsageRecord, UsageType, User
from app.security import hash_password

PHONE_BATCH_MINUTES = 50
INTERNET_BATCH_MB = 500

SUBSCRIBERS = [
    ("5551001", "Demo Subscriber One"),
    ("5551002", "Demo Subscriber Two"),
]

# username, password, role, subscriber_no
USERS = [
    ("admin", "admin-demo-pass", Role.ADMIN, None),
    ("sub5551001", "sub1001-demo-pass", Role.SUBSCRIBER, "5551001"),
    ("sub5551002", "sub1002-demo-pass", Role.SUBSCRIBER, "5551002"),
]

# subscriber_no, year, month, phone minutes, internet MB, amount already paid
PERIODS = [
    ("5551001", 2026, 9, 800, 18_000, Decimal("50.00")),  # $50, PAID
    ("5551001", 2026, 10, 1_350, 35_000, Decimal("0.00")),  # $80, UNPAID (guide §4.3 example)
    ("5551002", 2026, 9, 2_010, 30_001, Decimal("40.00")),  # $90, PARTIAL
    ("5551002", 2026, 10, 600, 0, Decimal("0.00")),  # $50, UNPAID (zero internet)
]


def _batched_usage(
    subscriber_no: str, year: int, month: int, usage_type: UsageType, total: int, batch: int
) -> list[UsageRecord]:
    """Split `total` into rows of at most `batch`, spread over days 1-28 of the month."""
    sizes = [batch] * (total // batch) + ([total % batch] if total % batch else [])
    return [
        UsageRecord(
            subscriber_no=subscriber_no,
            year=year,
            month=month,
            usage_type=usage_type,
            amount=size,
            created_at=datetime(year, month, 1 + i * 28 // len(sizes), 12, tzinfo=timezone.utc),
        )
        for i, size in enumerate(sizes)
    ]


def wipe(session: Session) -> None:
    for model in (Payment, Bill, UsageRecord, User, Subscriber):
        session.execute(delete(model))


def seed(session: Session) -> None:
    session.add_all(Subscriber(subscriber_no=no, name=name, plan="STANDARD") for no, name in SUBSCRIBERS)
    session.flush()

    session.add_all(
        User(username=u, password_hash=hash_password(p), role=r, subscriber_no=s)
        for u, p, r, s in USERS
    )

    for subscriber_no, year, month, minutes, mb, paid in PERIODS:
        session.add_all(
            _batched_usage(subscriber_no, year, month, UsageType.PHONE, minutes, PHONE_BATCH_MINUTES)
        )
        session.add_all(
            _batched_usage(subscriber_no, year, month, UsageType.INTERNET, mb, INTERNET_BATCH_MB)
        )

        amounts = pricing.calculate(minutes, mb)
        bill = Bill(
            subscriber_no=subscriber_no,
            year=year,
            month=month,
            phone_minutes=minutes,
            internet_mb=mb,
            phone_charge=amounts.phone_charge,
            internet_charge=amounts.internet_charge,
            total=amounts.total,
            paid_amount=paid,
            status=pricing.bill_status(amounts.total, paid),
        )
        session.add(bill)
        session.flush()

        if paid > 0:
            session.add(
                Payment(
                    bill_id=bill.id,
                    transaction_id=f"seed-{subscriber_no}-{year}{month:02d}",
                    amount=paid,
                )
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reset", action="store_true", help="delete all billing data before seeding")
    args = parser.parse_args()

    with SessionLocal() as session, session.begin():
        if args.reset:
            wipe(session)
        elif session.scalar(select(Subscriber.subscriber_no).limit(1)) is not None:
            print("Database already has data. Re-run with --reset to wipe and reseed.", file=sys.stderr)
            return 1
        seed(session)

    print(f"Seeded {len(SUBSCRIBERS)} subscribers, {len(USERS)} users, {len(PERIODS)} bills.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
