"""Initial schema: subscribers, users, usage_records, bills, payments.

Revision ID: 0001
Revises:
Create Date: 2026-11-19
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

user_role = postgresql.ENUM("SUBSCRIBER", "ADMIN", name="user_role", create_type=False)
usage_type = postgresql.ENUM("PHONE", "INTERNET", name="usage_type", create_type=False)
bill_status = postgresql.ENUM("UNPAID", "PARTIAL", "PAID", name="bill_status", create_type=False)
money = sa.Numeric(10, 2)


def upgrade() -> None:
    bind = op.get_bind()
    for enum_type in (user_role, usage_type, bill_status):
        enum_type.create(bind, checkfirst=True)

    op.create_table(
        "subscribers",
        sa.Column("subscriber_no", sa.String(20), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("plan", sa.String(50), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("username", sa.String(50), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(100), nullable=False),
        sa.Column("role", user_role, nullable=False),
        sa.Column("subscriber_no", sa.String(20), sa.ForeignKey("subscribers.subscriber_no"), nullable=True),
        sa.CheckConstraint("role = 'ADMIN' OR subscriber_no IS NOT NULL", name="ck_users_subscriber_has_no"),
    )

    op.create_table(
        "usage_records",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("subscriber_no", sa.String(20), sa.ForeignKey("subscribers.subscriber_no"), nullable=False),
        sa.Column("year", sa.Integer, nullable=False),
        sa.Column("month", sa.Integer, nullable=False),
        sa.Column("usage_type", usage_type, nullable=False),
        sa.Column("amount", sa.Integer, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("month BETWEEN 1 AND 12", name="ck_usage_month"),
        sa.CheckConstraint("amount > 0", name="ck_usage_amount_positive"),
    )
    op.create_index("ix_usage_period", "usage_records", ["subscriber_no", "year", "month"])

    op.create_table(
        "bills",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("subscriber_no", sa.String(20), sa.ForeignKey("subscribers.subscriber_no"), nullable=False),
        sa.Column("year", sa.Integer, nullable=False),
        sa.Column("month", sa.Integer, nullable=False),
        sa.Column("phone_minutes", sa.Integer, nullable=False),
        sa.Column("internet_mb", sa.Integer, nullable=False),
        sa.Column("phone_charge", money, nullable=False),
        sa.Column("internet_charge", money, nullable=False),
        sa.Column("total", money, nullable=False),
        sa.Column("paid_amount", money, nullable=False),
        sa.Column("status", bill_status, nullable=False),
        sa.Column("calculated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("subscriber_no", "year", "month", name="uq_bills_period"),
        sa.CheckConstraint("month BETWEEN 1 AND 12", name="ck_bills_month"),
        sa.CheckConstraint("paid_amount >= 0", name="ck_bills_paid_nonnegative"),
    )

    op.create_table(
        "payments",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("bill_id", sa.Integer, sa.ForeignKey("bills.id"), nullable=False),
        sa.Column("transaction_id", sa.String(64), nullable=False, unique=True),
        sa.Column("amount", money, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_payments_amount_positive"),
    )


def downgrade() -> None:
    for table in ("payments", "bills", "usage_records", "users", "subscribers"):
        op.drop_table(table)
    bind = op.get_bind()
    for enum_type in (bill_status, usage_type, user_role):
        enum_type.drop(bind, checkfirst=True)
