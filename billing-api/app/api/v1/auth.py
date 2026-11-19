from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.errors import ApiError
from app.models import User
from app.schemas import LoginRequest, LoginResponse, error_responses
from app.security import create_access_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse, responses=error_responses(401, 422))
def login(body: LoginRequest, db: Session = Depends(get_db)) -> LoginResponse:
    """Exchange username and password for a JWT. Send it as `Authorization: Bearer <token>`."""
    user = db.scalar(select(User).where(User.username == body.username))
    if user is None or not verify_password(body.password, user.password_hash):
        raise ApiError(401, "INVALID_CREDENTIALS", "Username or password is incorrect.")
    token, lifetime = create_access_token(user)
    return LoginResponse(
        access_token=token, expires_in=lifetime, role=user.role, subscriber_no=user.subscriber_no
    )
