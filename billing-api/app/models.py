"""Database schema. Keep in sync with alembic/versions/."""

import enum
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

Money = Numeric(10, 2)


class Base(DeclarativeBase):
    pass


class Role(str, enum.Enum):
    SUBSCRIBER = "SUBSCRIBER"
    ADMIN = "ADMIN"


class UsageType(str, enum.Enum):
    PHONE = "PHONE"  # amount is minutes
    INTERNET = "INTERNET"  # amount is MB


class BillStatus(str, enum.Enum):
    UNPAID = "UNPAID"
    PARTIAL = "PARTIAL"
    PAID = "PAID"


class Subscriber(Base):
    __tablename__ = "subscribers"

    subscriber_no: Mapped[str] = mapped_column(String(20), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    plan: Mapped[str] = mapped_column(String(50), default="STANDARD")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    bills: Mapped[list["Bill"]] = relationship(back_populates="subscriber")


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        # A subscriber login must point at a subscriber; an admin need not.
        CheckConstraint(
            "role = 'ADMIN' OR subscriber_no IS NOT NULL", name="ck_users_subscriber_has_no"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True)
    password_hash: Mapped[str] = mapped_column(String(100))
    role: Mapped[Role] = mapped_column(Enum(Role, name="user_role"))
    subscriber_no: Mapped[str | None] = mapped_column(
        ForeignKey("subscribers.subscriber_no"), nullable=True
    )


class UsageRecord(Base):
    """One recorded usage event. Add Usage writes 10 min or 1 MB; the seed script writes batches."""

    __tablename__ = "usage_records"
    __table_args__ = (
        CheckConstraint("month BETWEEN 1 AND 12", name="ck_usage_month"),
        CheckConstraint("amount > 0", name="ck_usage_amount_positive"),
        Index("ix_usage_period", "subscriber_no", "year", "month"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    subscriber_no: Mapped[str] = mapped_column(ForeignKey("subscribers.subscriber_no"))
    year: Mapped[int] = mapped_column(Integer)
    month: Mapped[int] = mapped_column(Integer)
    usage_type: Mapped[UsageType] = mapped_column(Enum(UsageType, name="usage_type"))
    amount: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Bill(Base):
    __tablename__ = "bills"
    __table_args__ = (
        UniqueConstraint("subscriber_no", "year", "month", name="uq_bills_period"),
        CheckConstraint("month BETWEEN 1 AND 12", name="ck_bills_month"),
        CheckConstraint("paid_amount >= 0", name="ck_bills_paid_nonnegative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    subscriber_no: Mapped[str] = mapped_column(ForeignKey("subscribers.subscriber_no"))
    year: Mapped[int] = mapped_column(Integer)
    month: Mapped[int] = mapped_column(Integer)
    phone_minutes: Mapped[int] = mapped_column(Integer, default=0)
    internet_mb: Mapped[int] = mapped_column(Integer, default=0)
    phone_charge: Mapped[Decimal] = mapped_column(Money)
    internet_charge: Mapped[Decimal] = mapped_column(Money)
    total: Mapped[Decimal] = mapped_column(Money)
    paid_amount: Mapped[Decimal] = mapped_column(Money, default=Decimal("0.00"))
    status: Mapped[BillStatus] = mapped_column(
        Enum(BillStatus, name="bill_status"), default=BillStatus.UNPAID
    )
    calculated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    subscriber: Mapped[Subscriber] = relationship(back_populates="bills")
    payments: Mapped[list["Payment"]] = relationship(back_populates="bill")


class Payment(Base):
    __tablename__ = "payments"
    __table_args__ = (CheckConstraint("amount > 0", name="ck_payments_amount_positive"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bill_id: Mapped[int] = mapped_column(ForeignKey("bills.id"))
    # UNIQUE gives idempotency: a retried payment with the same ID is rejected (guide §5.3).
    transaction_id: Mapped[str] = mapped_column(String(64), unique=True)
    amount: Mapped[Decimal] = mapped_column(Money)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    bill: Mapped[Bill] = relationship(back_populates="payments")
