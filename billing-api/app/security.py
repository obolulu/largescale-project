"""Password hashing, JWT issue/verify, and the auth dependencies routers use."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings
from app.errors import ApiError, forbidden, unauthorized
from app.models import Role, User

_bearer = HTTPBearer(auto_error=False, description="JWT from POST /api/v1/auth/login")


def hash_password(password: str, rounds: int = 12) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=rounds)).decode()


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode(), password_hash.encode())


@dataclass(frozen=True)
class Principal:
    username: str
    role: Role
    subscriber_no: str | None

    @property
    def is_admin(self) -> bool:
        return self.role is Role.ADMIN


def create_access_token(user: User) -> tuple[str, int]:
    """Return (token, lifetime in seconds)."""
    s = get_settings()
    now = datetime.now(timezone.utc)
    lifetime = s.jwt_expire_minutes * 60
    claims = {
        "sub": user.username,
        "role": user.role.value,
        "subscriber_no": user.subscriber_no,
        "iss": s.jwt_issuer,
        "aud": s.jwt_audience,
        "iat": now,
        "exp": now + timedelta(seconds=lifetime),
    }
    return jwt.encode(claims, s.jwt_secret, algorithm=s.jwt_algorithm), lifetime


def decode_access_token(token: str) -> Principal:
    s = get_settings()
    try:
        claims = jwt.decode(
            token,
            s.jwt_secret,
            algorithms=[s.jwt_algorithm],
            audience=s.jwt_audience,
            issuer=s.jwt_issuer,
            options={"require": ["sub", "role", "exp", "iss", "aud"]},
        )
        role = Role(claims["role"])
    except jwt.ExpiredSignatureError as exc:
        raise unauthorized("Token has expired.") from exc
    except (jwt.InvalidTokenError, ValueError) as exc:
        raise unauthorized("Token is invalid.") from exc
    if role is Role.SUBSCRIBER and not claims.get("subscriber_no"):
        raise unauthorized("Token is invalid.")
    return Principal(claims["sub"], role, claims.get("subscriber_no"))


def current_principal(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> Principal:
    if credentials is None:
        raise unauthorized()
    return decode_access_token(credentials.credentials)


def require_admin(principal: Principal = Depends(current_principal)) -> Principal:
    if not principal.is_admin:
        raise forbidden("This operation requires the ADMIN role.")
    return principal


def resolve_subscriber(principal: Principal, requested: str | None) -> str:
    """Which subscriber a protected call acts on.

    A subscriber always acts on the subscriber number in their token. Passing a
    different number (for example one typed into the chat) is refused, so the
    agent can never read or pay another person's bill. Admins must name one.
    """
    if principal.is_admin:
        if not requested:
            raise ApiError(
                422,
                "VALIDATION_ERROR",
                "subscriber_no is required for admin requests.",
                details=[{"field": "subscriber_no", "message": "Field required"}],
            )
        return requested
    if requested and requested != principal.subscriber_no:
        raise forbidden("You can only access your own subscriber account.")
    assert principal.subscriber_no is not None  # guaranteed by decode_access_token
    return principal.subscriber_no
