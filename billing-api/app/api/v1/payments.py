from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app import billing
from app.db import get_db
from app.schemas import PayBillRequest, PayBillResponse, error_responses
from app.security import Principal, current_principal, resolve_subscriber

router = APIRouter(prefix="/payments", tags=["payments"])


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=PayBillResponse,
    responses=error_responses(401, 403, 404, 409, 422),
)
def pay_bill(
    body: PayBillRequest,
    db: Session = Depends(get_db),
    principal: Principal = Depends(current_principal),
) -> PayBillResponse:
    """**Pay Bill** (authenticated). Records a simulated full or partial payment. No card processing.

    `transaction_id` is the idempotency key: a repeated ID returns 409 and records nothing.
    Amounts above the remaining balance are rejected.
    """
    target = resolve_subscriber(principal, body.subscriber_no)
    return billing.pay_bill(db, target, body.year, body.month, body.amount, body.transaction_id)
