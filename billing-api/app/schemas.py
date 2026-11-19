"""Request and response bodies for /api/v1."""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer

from app.models import BillStatus, Role, UsageType

# Money is Decimal internally and a JSON number on the wire (e.g. 80.0).
Money = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]

SubscriberNo = Annotated[str, Field(min_length=1, max_length=20, examples=["5551001"])]
Month = Annotated[int, Field(ge=1, le=12, examples=[10])]
Year = Annotated[int, Field(ge=2000, le=2100, examples=[2026])]


class ErrorDetail(BaseModel):
    code: str = Field(examples=["UNAUTHORIZED"])
    message: str = Field(examples=["Missing or invalid bearer token."])
    details: object | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


def error_responses(*codes: int) -> dict[int | str, dict]:
    """OpenAPI `responses=` entry so Swagger shows the error shape per status."""
    text = {
        401: "Missing, invalid or expired token",
        403: "Authenticated but not allowed (wrong role or another subscriber's data)",
        404: "Subscriber or bill not found",
        409: "Duplicate transaction ID, or bill already paid",
        422: "Validation failed or business rule violated",
    }
    return {c: {"model": ErrorResponse, "description": text[c]} for c in codes}


class BillingPeriod(BaseModel):
    month: Month
    year: Year


# ---------- auth ----------


class LoginRequest(BaseModel):
    username: str = Field(examples=["sub5551001"])
    password: str = Field(examples=["sub1001-demo-pass"])


class LoginResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    role: Role
    subscriber_no: str | None


# ---------- usage ----------


class AddUsageRequest(BillingPeriod):
    subscriber_no: SubscriberNo
    usage_type: UsageType


class AddUsageResponse(BaseModel):
    status: Literal["SUCCESS"] = "SUCCESS"
    usage_id: int
    subscriber_no: str
    month: int
    year: int
    usage_type: UsageType
    amount_added: int
    unit: Literal["MINUTES", "MB"]


# ---------- bills ----------


class CalculateBillRequest(BillingPeriod):
    subscriber_no: SubscriberNo


class BillSummary(BaseModel):
    subscriber_no: str
    month: int
    year: int
    currency: Literal["USD"] = "USD"
    total: Money
    paid_amount: Money
    remaining_balance: Money
    status: BillStatus
    due_date: date


class CalculateBillResponse(BaseModel):
    status: Literal["SUCCESS"] = "SUCCESS"
    action: Literal["CREATED", "UPDATED"]
    bill: BillSummary
    phone_minutes: int
    internet_mb: int
    phone_charge: Money
    internet_charge: Money


class UsageTotals(BaseModel):
    phone_minutes: int
    internet_mb: int
    internet_gb: float


class PhoneChargeDetail(BaseModel):
    included_minutes: int
    extra_minutes: int
    block_minutes: int
    blocks_charged: int
    price_per_block: Money
    charge: Money


class InternetChargeDetail(BaseModel):
    base_price: Money
    included_gb: int
    extra_mb: int
    block_gb: int
    blocks_charged: int
    price_per_block: Money
    charge: Money


class ChargeBreakdown(BaseModel):
    phone: PhoneChargeDetail
    internet: InternetChargeDetail
    taxes_and_fees: Money = Decimal("0")


class UsageItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    usage_type: UsageType
    amount: int
    unit: Literal["MINUTES", "MB"]
    recorded_at: datetime


class Page(BaseModel):
    page: int
    page_size: int
    total_items: int
    total_pages: int


class UsageItemsPage(Page):
    items: list[UsageItem]


class BillDetailed(BillSummary):
    calculated_at: datetime
    usage: UsageTotals
    charges: ChargeBreakdown
    usage_items: UsageItemsPage


# ---------- payments ----------


class PayBillRequest(BillingPeriod):
    subscriber_no: SubscriberNo | None = Field(
        default=None,
        description="Optional for subscribers (taken from the token); required for admins.",
    )
    amount: Annotated[Decimal, Field(gt=0, max_digits=10, decimal_places=2, examples=[30])]
    transaction_id: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_.:-]+$",
        description="Client-generated idempotency key. Reusing one returns 409.",
        examples=["3f6c2a9e-0b1d-4c55-9a51-2f1b8f0c7d10"],
    )


class PayBillResponse(BaseModel):
    payment_status: Literal["SUCCESS"] = "SUCCESS"
    transaction_id: str
    amount: Money
    paid_amount: Money
    remaining_balance: Money
    bill_status: BillStatus
    bill: BillSummary
