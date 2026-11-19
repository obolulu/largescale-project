"""Shared fixtures.

By default the tests run on in-memory SQLite so `pytest` works with no Docker,
cloud or LLM. Set TEST_DATABASE_URL to run the same suite against Postgres:
    TEST_DATABASE_URL=postgresql+psycopg://billing:billing_dev_password@localhost:5432/billing_test pytest
"""

import os
from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import get_db
from app.main import app
from app.models import Base, Role, Subscriber, UsageRecord, UsageType, User
from app.security import hash_password

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite+pysqlite:///:memory:")

SUB1, SUB2, UNKNOWN_SUB = "5551001", "5551002", "5559999"
PASSWORD = "test-pass"
_HASH = hash_password(PASSWORD, rounds=4)  # low cost: tests only


@pytest.fixture(scope="session")
def engine():
    if TEST_DATABASE_URL.startswith("sqlite"):
        eng = create_engine(
            TEST_DATABASE_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
    else:
        eng = create_engine(TEST_DATABASE_URL)
    yield eng
    eng.dispose()


@pytest.fixture
def session_factory(engine):
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with factory() as s, s.begin():
        s.add_all(
            [
                Subscriber(subscriber_no=SUB1, name="Test One", plan="STANDARD"),
                Subscriber(subscriber_no=SUB2, name="Test Two", plan="STANDARD"),
            ]
        )
        s.flush()
        s.add_all(
            [
                User(username="admin", password_hash=_HASH, role=Role.ADMIN),
                User(username="sub1", password_hash=_HASH, role=Role.SUBSCRIBER, subscriber_no=SUB1),
                User(username="sub2", password_hash=_HASH, role=Role.SUBSCRIBER, subscriber_no=SUB2),
            ]
        )
    return factory


@pytest.fixture
def db(session_factory) -> Iterator[Session]:
    with session_factory() as s:
        yield s


@pytest.fixture
def client(session_factory) -> Iterator[TestClient]:
    def _get_db():
        with session_factory() as s:
            yield s

    app.dependency_overrides[get_db] = _get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _login(client: TestClient, username: str) -> dict[str, str]:
    r = client.post("/api/v1/auth/login", json={"username": username, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def admin_headers(client):
    return _login(client, "admin")


@pytest.fixture
def sub1_headers(client):
    return _login(client, "sub1")


@pytest.fixture
def sub2_headers(client):
    return _login(client, "sub2")


@pytest.fixture
def add_usage_rows(db):
    """Insert usage directly (batched), bypassing Add Usage's 10 min / 1 MB unit."""

    def _add(subscriber_no: str, year: int, month: int, minutes: int = 0, mb: int = 0, day: int = 1):
        when = datetime(year, month, day, 12, tzinfo=timezone.utc)
        if minutes:
            db.add(UsageRecord(subscriber_no=subscriber_no, year=year, month=month,
                               usage_type=UsageType.PHONE, amount=minutes, created_at=when))
        if mb:
            db.add(UsageRecord(subscriber_no=subscriber_no, year=year, month=month,
                               usage_type=UsageType.INTERNET, amount=mb, created_at=when))
        db.commit()

    return _add


@pytest.fixture
def make_bill(client, admin_headers, add_usage_rows):
    """Record usage and run Calculate Bill through the API. Returns the response JSON."""

    def _make(subscriber_no: str, year: int, month: int, minutes: int = 0, mb: int = 0) -> dict:
        add_usage_rows(subscriber_no, year, month, minutes, mb)
        r = client.post(
            "/api/v1/bills/calculate",
            json={"subscriber_no": subscriber_no, "year": year, "month": month},
            headers=admin_headers,
        )
        assert r.status_code == 200, r.text
        return r.json()

    return _make
