from datetime import datetime, timedelta, timezone

import jwt

from app.config import get_settings
from tests.conftest import PASSWORD, SUB1


def test_login_returns_token_with_role_and_subscriber(client):
    r = client.post("/api/v1/auth/login", json={"username": "sub1", "password": PASSWORD})
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["role"] == "SUBSCRIBER"
    assert body["subscriber_no"] == SUB1
    claims = jwt.decode(
        body["access_token"],
        get_settings().jwt_secret,
        algorithms=["HS256"],
        audience=get_settings().jwt_audience,
    )
    assert claims["subscriber_no"] == SUB1


def test_login_with_wrong_password_is_401(client):
    r = client.post("/api/v1/auth/login", json={"username": "sub1", "password": "nope"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "INVALID_CREDENTIALS"


def test_login_with_unknown_user_is_401(client):
    r = client.post("/api/v1/auth/login", json={"username": "ghost", "password": PASSWORD})
    assert r.status_code == 401


def _token(**overrides) -> str:
    s = get_settings()
    claims = {
        "sub": "sub1",
        "role": "SUBSCRIBER",
        "subscriber_no": SUB1,
        "iss": s.jwt_issuer,
        "aud": s.jwt_audience,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    } | overrides
    secret = claims.pop("_secret", s.jwt_secret)
    return jwt.encode(claims, secret, algorithm="HS256")


DETAILED = "/api/v1/bills/detailed?month=10&year=2026"


def test_missing_token_is_401_with_error_body(client):
    r = client.get(DETAILED)
    assert r.status_code == 401
    assert r.headers["WWW-Authenticate"] == "Bearer"
    assert r.json() == {
        "error": {"code": "UNAUTHORIZED", "message": "Missing or invalid bearer token."}
    }


def test_expired_token_is_401(client):
    token = _token(exp=datetime.now(timezone.utc) - timedelta(minutes=1))
    r = client.get(DETAILED, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
    assert r.json()["error"]["message"] == "Token has expired."


def test_token_signed_with_other_secret_is_401(client):
    token = _token(_secret="attacker-secret-that-is-long-enough-for-hs256")
    r = client.get(DETAILED, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_token_with_wrong_audience_is_401(client):
    r = client.get(DETAILED, headers={"Authorization": f"Bearer {_token(aud='someone-else')}"})
    assert r.status_code == 401


def test_subscriber_token_without_subscriber_no_is_401(client):
    r = client.get(DETAILED, headers={"Authorization": f"Bearer {_token(subscriber_no=None)}"})
    assert r.status_code == 401
