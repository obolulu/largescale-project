from sqlalchemy import func, select

from app.models import UsageRecord, UsageType
from tests.conftest import SUB1, UNKNOWN_SUB

URL = "/api/v1/usage"


def _body(usage_type="PHONE", subscriber_no=SUB1, month=10, year=2026):
    return {"subscriber_no": subscriber_no, "month": month, "year": year, "usage_type": usage_type}


def test_add_phone_usage_records_10_minutes(client, admin_headers, db):
    r = client.post(URL, json=_body("PHONE"), headers=admin_headers)
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "SUCCESS"
    assert (body["amount_added"], body["unit"]) == (10, "MINUTES")
    assert db.get(UsageRecord, body["usage_id"]).amount == 10


def test_add_internet_usage_records_1_mb(client, admin_headers):
    r = client.post(URL, json=_body("INTERNET"), headers=admin_headers)
    assert r.status_code == 201
    assert (r.json()["amount_added"], r.json()["unit"]) == (1, "MB")


def test_repeated_add_usage_accumulates(client, admin_headers, db):
    for _ in range(3):
        client.post(URL, json=_body("PHONE"), headers=admin_headers)
    total = db.scalar(
        select(func.sum(UsageRecord.amount)).where(UsageRecord.usage_type == UsageType.PHONE)
    )
    assert total == 30


def test_add_usage_without_token_is_401(client):
    assert client.post(URL, json=_body()).status_code == 401


def test_add_usage_as_subscriber_is_403(client, sub1_headers):
    r = client.post(URL, json=_body(), headers=sub1_headers)
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "FORBIDDEN"


def test_add_usage_for_unknown_subscriber_is_404(client, admin_headers):
    r = client.post(URL, json=_body(subscriber_no=UNKNOWN_SUB), headers=admin_headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "SUBSCRIBER_NOT_FOUND"


def test_add_usage_with_invalid_month_is_422(client, admin_headers):
    r = client.post(URL, json=_body(month=13), headers=admin_headers)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"
    assert r.json()["error"]["details"][0]["field"] == "month"


def test_add_usage_with_unknown_type_is_422(client, admin_headers):
    r = client.post(URL, json=_body(usage_type="SMS"), headers=admin_headers)
    assert r.status_code == 422
