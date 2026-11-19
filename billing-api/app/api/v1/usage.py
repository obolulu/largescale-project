from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app import billing
from app.db import get_db
from app.schemas import AddUsageRequest, AddUsageResponse, error_responses
from app.security import Principal, require_admin

router = APIRouter(prefix="/usage", tags=["usage"])


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=AddUsageResponse,
    responses=error_responses(401, 403, 404, 422),
)
def add_usage(
    body: AddUsageRequest,
    db: Session = Depends(get_db),
    _: Principal = Depends(require_admin),
) -> AddUsageResponse:
    """**Add Usage** (admin). Records one event: 10 minutes for PHONE, 1 MB for INTERNET.

    Usage is not billed until Calculate Bill runs for that period again.
    """
    return billing.add_usage(db, body.subscriber_no, body.year, body.month, body.usage_type)
