from sqlalchemy import func, select

from app.models import Payment
from tests.conftest import SUB1, SUB2

URL = "/api/v1/payments"


def _pay(client, headers, amount, transaction_id, month=10, year=2026, **extra):
    body = {"month": month, "year": year, "amount": amount, "transaction_id": transaction_id} | extra
    return client.post(URL, json=body, headers=headers)


def test_partial_payment_leaves_bill_partial(client, make_bill, sub1_headers):
    """Guide §5.1: a partial payment reduces the balance but doesn't mark the bill paid."""
    make_bill(SUB1, 2026, 10, minutes=1_350, mb=35_000)  # $80
    r = _pay(client, sub1_headers, 30, "tx-1")
    assert r.status_code == 201
    body = r.json()
    assert body["payment_status"] == "SUCCESS"
    assert (body["amount"], body["paid_amount"], body["remaining_balance"]) == (30, 30, 50)
    assert body["bill_status"] == "PARTIAL"


def test_payments_add_up_to_paid(client, make_bill, sub1_headers):
    make_bill(SUB1, 2026, 10)  # $50
    _pay(client, sub1_headers, 20.5, "tx-1")
    body = _pay(client, sub1_headers, 29.5, "tx-2").json()
    assert (body["paid_amount"], body["remaining_balance"], body["bill_status"]) == (50, 0, "PAID")

    q = client.get("/api/v1/bills", params={"subscriber_no": SUB1, "month": 10, "year": 2026}).json()
    assert q["status"] == "PAID"


def test_duplicate_transaction_id_is_409_and_records_nothing(client, make_bill, sub1_headers, db):
    make_bill(SUB1, 2026, 10)
    assert _pay(client, sub1_headers, 10, "tx-dup").status_code == 201
    r = _pay(client, sub1_headers, 10, "tx-dup")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "DUPLICATE_TRANSACTION"
    assert db.scalar(select(func.count()).select_from(Payment)) == 1
    q = client.get("/api/v1/bills", params={"subscriber_no": SUB1, "month": 10, "year": 2026}).json()
    assert q["paid_amount"] == 10


def test_overpayment_is_422(client, make_bill, sub1_headers):
    make_bill(SUB1, 2026, 10)  # $50
    r = _pay(client, sub1_headers, 50.01, "tx-1")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "AMOUNT_EXCEEDS_BALANCE"
    assert r.json()["error"]["details"] == {"remaining_balance": 50}


def test_paying_a_paid_bill_is_409(client, make_bill, sub1_headers):
    make_bill(SUB1, 2026, 10)
    _pay(client, sub1_headers, 50, "tx-1")
    r = _pay(client, sub1_headers, 1, "tx-2")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "BILL_ALREADY_PAID"


def test_zero_and_negative_amounts_are_422(client, make_bill, sub1_headers):
    make_bill(SUB1, 2026, 10)
    assert _pay(client, sub1_headers, 0, "tx-0").status_code == 422
    assert _pay(client, sub1_headers, -5, "tx-neg").status_code == 422


def test_amount_with_more_than_two_decimals_is_422(client, make_bill, sub1_headers):
    make_bill(SUB1, 2026, 10)
    assert _pay(client, sub1_headers, 10.005, "tx-1").status_code == 422


def test_invalid_transaction_id_is_422(client, make_bill, sub1_headers):
    make_bill(SUB1, 2026, 10)
    assert _pay(client, sub1_headers, 10, "bad id with spaces").status_code == 422


def test_pay_without_token_is_401(client, make_bill):
    make_bill(SUB1, 2026, 10)
    r = client.post(URL, json={"subscriber_no": SUB1, "month": 10, "year": 2026, "amount": 10, "transaction_id": "t"})
    assert r.status_code == 401


def test_paying_another_subscribers_bill_is_403(client, make_bill, sub1_headers):
    make_bill(SUB2, 2026, 10)
    r = _pay(client, sub1_headers, 10, "tx-1", subscriber_no=SUB2)
    assert r.status_code == 403


def test_pay_bill_that_does_not_exist_is_404(client, sub1_headers):
    r = _pay(client, sub1_headers, 10, "tx-1", month=1)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "BILL_NOT_FOUND"


def test_admin_can_pay_for_named_subscriber(client, make_bill, admin_headers):
    make_bill(SUB2, 2026, 10)
    assert _pay(client, admin_headers, 10, "tx-1").status_code == 422  # no subscriber_no
    r = _pay(client, admin_headers, 10, "tx-2", subscriber_no=SUB2)
    assert r.status_code == 201
    assert r.json()["bill"]["subscriber_no"] == SUB2
