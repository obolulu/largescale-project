from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app import billing
from app.db import get_db
from app.schemas import (
    BillDetailed,
    BillSummary,
    CalculateBillRequest,
    CalculateBillResponse,
    error_responses,
)
from app.security import Principal, current_principal, require_admin, resolve_subscriber

router = APIRouter(prefix="/bills", tags=["bills"])

MonthQ = Annotated[int, Query(ge=1, le=12, examples=[10])]
YearQ = Annotated[int, Query(ge=2000, le=2100, examples=[2026])]


@router.get("", response_model=BillSummary, responses=error_responses(404, 422))
def query_bill(
    subscriber_no: Annotated[str, Query(min_length=1, max_length=20, examples=["5551001"])],
    month: MonthQ,
    year: YearQ,
    db: Session = Depends(get_db),
) -> BillSummary:
    """**Query Bill** (no authentication, per the spec). Total, paid amount, remaining balance, status."""
    return billing.query_bill(db, subscriber_no, year, month)


@router.get(
    "/detailed", response_model=BillDetailed, responses=error_responses(401, 403, 404, 422)
)
def query_bill_detailed(
    month: MonthQ,
    year: YearQ,
    subscriber_no: Annotated[
        str | None,
        Query(
            max_length=20,
            description="Optional for subscribers (must match the token); required for admins.",
        ),
    ] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    db: Session = Depends(get_db),
    principal: Principal = Depends(current_principal),
) -> BillDetailed:
    """**Query Bill Detailed** (authenticated, paged). Usage totals, charge breakdown and a page of usage records."""
    target = resolve_subscriber(principal, subscriber_no)
    return billing.query_bill_detailed(db, target, year, month, page, page_size)


@router.post(
    "/calculate", response_model=CalculateBillResponse, responses=error_responses(401, 403, 404, 422)
)
def calculate_bill(
    body: CalculateBillRequest,
    db: Session = Depends(get_db),
    _: Principal = Depends(require_admin),
) -> CalculateBillResponse:
    """**Calculate Bill** (admin). Computes the bill from recorded usage and stores it.

    Running it again for the same period updates the charges and keeps any payments already made.
    """
    return billing.calculate_bill(db, body.subscriber_no, body.year, body.month)
