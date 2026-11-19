from tests.conftest import SUB1, SUB2, UNKNOWN_SUB

CALC = "/api/v1/bills/calculate"
QUERY = "/api/v1/bills"
DETAILED = "/api/v1/bills/detailed"


# ---------- Calculate Bill ----------


def test_calculate_bill_matches_guide_worked_example(make_bill):
    """Guide §4.3: 1,350 minutes + 35 GB → $80."""
    body = make_bill(SUB1, 2026, 10, minutes=1_350, mb=35_000)
    assert body["action"] == "CREATED"
    assert body["phone_charge"] == 10
    assert body["internet_charge"] == 70
    assert body["bill"]["total"] == 80
    assert body["bill"]["status"] == "UNPAID"
    assert body["bill"]["due_date"] == "2026-11-15"  # §6.1


def test_calculate_bill_with_no_usage_charges_internet_base(make_bill):
    """Guide §3.1: $50 even with zero usage."""
    assert make_bill(SUB1, 2026, 10)["bill"]["total"] == 50


def test_calculate_uses_usage_added_through_the_api(client, admin_headers):
    for usage_type in ("PHONE", "INTERNET"):
        client.post(
            "/api/v1/usage",
            json={"subscriber_no": SUB1, "month": 10, "year": 2026, "usage_type": usage_type},
            headers=admin_headers,
        )
    r = client.post(CALC, json={"subscriber_no": SUB1, "month": 10, "year": 2026}, headers=admin_headers)
    assert (r.json()["phone_minutes"], r.json()["internet_mb"]) == (10, 1)


def test_recalculate_updates_total_and_keeps_payments(client, make_bill, sub1_headers, add_usage_rows, admin_headers):
    make_bill(SUB1, 2026, 10, minutes=0, mb=0)  # $50
    client.post(
        "/api/v1/payments",
        json={"month": 10, "year": 2026, "amount": 50, "transaction_id": "t-1"},
        headers=sub1_headers,
    )
    add_usage_rows(SUB1, 2026, 10, minutes=1_500)  # +$10 phone
    r = client.post(CALC, json={"subscriber_no": SUB1, "month": 10, "year": 2026}, headers=admin_headers)
    bill = r.json()["bill"]
    assert r.json()["action"] == "UPDATED"
    assert (bill["total"], bill["paid_amount"], bill["remaining_balance"]) == (60, 50, 10)
    assert bill["status"] == "PARTIAL"


def test_calculate_bill_as_subscriber_is_403(client, sub1_headers):
    r = client.post(CALC, json={"subscriber_no": SUB1, "month": 10, "year": 2026}, headers=sub1_headers)
    assert r.status_code == 403


def test_calculate_bill_without_token_is_401(client):
    assert client.post(CALC, json={"subscriber_no": SUB1, "month": 10, "year": 2026}).status_code == 401


def test_calculate_bill_for_unknown_subscriber_is_404(client, admin_headers):
    r = client.post(CALC, json={"subscriber_no": UNKNOWN_SUB, "month": 10, "year": 2026}, headers=admin_headers)
    assert r.status_code == 404


def test_calculate_bill_with_invalid_year_is_422(client, admin_headers):
    r = client.post(CALC, json={"subscriber_no": SUB1, "month": 10, "year": 1999}, headers=admin_headers)
    assert r.status_code == 422


# ---------- Query Bill (no auth) ----------


def test_query_bill_without_auth(client, make_bill):
    make_bill(SUB1, 2026, 10, minutes=1_350, mb=35_000)
    r = client.get(QUERY, params={"subscriber_no": SUB1, "month": 10, "year": 2026})
    assert r.status_code == 200
    body = r.json()
    assert (body["total"], body["paid_amount"], body["remaining_balance"]) == (80, 0, 80)
    assert body["status"] == "UNPAID"
    assert body["currency"] == "USD"


def test_query_bill_not_calculated_is_404(client):
    r = client.get(QUERY, params={"subscriber_no": SUB1, "month": 10, "year": 2026})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "BILL_NOT_FOUND"


def test_query_bill_missing_parameter_is_422(client):
    r = client.get(QUERY, params={"subscriber_no": SUB1, "month": 10})
    assert r.status_code == 422
    assert r.json()["error"]["details"][0]["field"] == "year"


# ---------- Query Bill Detailed (auth + paging) ----------


def test_detailed_bill_breakdown_for_own_account(client, make_bill, sub1_headers):
    make_bill(SUB1, 2026, 10, minutes=1_350, mb=35_000)
    r = client.get(DETAILED, params={"month": 10, "year": 2026}, headers=sub1_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["usage"] == {"phone_minutes": 1_350, "internet_mb": 35_000, "internet_gb": 35.0}
    phone, internet = body["charges"]["phone"], body["charges"]["internet"]
    assert (phone["extra_minutes"], phone["blocks_charged"], phone["charge"]) == (350, 1, 10)
    assert (internet["extra_mb"], internet["blocks_charged"], internet["charge"]) == (15_000, 2, 70)
    assert body["charges"]["taxes_and_fees"] == 0
    assert body["total"] == 80


def test_detailed_bill_pages_usage_items(client, make_bill, add_usage_rows, sub1_headers):
    for day in range(1, 6):  # 5 phone + 5 internet rows
        add_usage_rows(SUB1, 2026, 10, minutes=100, mb=1_000, day=day)
    make_bill(SUB1, 2026, 10)

    first = client.get(DETAILED, params={"month": 10, "year": 2026, "page_size": 4}, headers=sub1_headers).json()
    page = first["usage_items"]
    assert (page["page"], page["page_size"], page["total_items"], page["total_pages"]) == (1, 4, 10, 3)
    assert len(page["items"]) == 4

    last = client.get(
        DETAILED, params={"month": 10, "year": 2026, "page": 3, "page_size": 4}, headers=sub1_headers
    ).json()["usage_items"]
    assert len(last["items"]) == 2
    ids = [i["id"] for i in page["items"]] + [i["id"] for i in last["items"]]
    assert len(set(ids)) == len(ids)


def test_detailed_bill_page_past_the_end_is_empty(client, make_bill, sub1_headers):
    make_bill(SUB1, 2026, 10, minutes=100)
    r = client.get(DETAILED, params={"month": 10, "year": 2026, "page": 9}, headers=sub1_headers)
    assert r.status_code == 200
    assert r.json()["usage_items"]["items"] == []


def test_detailed_bill_invalid_page_size_is_422(client, sub1_headers):
    r = client.get(DETAILED, params={"month": 10, "year": 2026, "page_size": 500}, headers=sub1_headers)
    assert r.status_code == 422


def test_detailed_bill_without_token_is_401(client, make_bill):
    make_bill(SUB1, 2026, 10)
    assert client.get(DETAILED, params={"month": 10, "year": 2026, "subscriber_no": SUB1}).status_code == 401


def test_detailed_bill_for_another_subscriber_is_403(client, make_bill, sub1_headers):
    """A subscriber number typed into a prompt must not unlock someone else's data."""
    make_bill(SUB2, 2026, 10)
    r = client.get(DETAILED, params={"month": 10, "year": 2026, "subscriber_no": SUB2}, headers=sub1_headers)
    assert r.status_code == 403


def test_detailed_bill_as_admin_requires_subscriber_no(client, make_bill, admin_headers):
    make_bill(SUB2, 2026, 10)
    assert client.get(DETAILED, params={"month": 10, "year": 2026}, headers=admin_headers).status_code == 422
    r = client.get(DETAILED, params={"month": 10, "year": 2026, "subscriber_no": SUB2}, headers=admin_headers)
    assert r.status_code == 200


def test_detailed_bill_not_calculated_is_404(client, sub1_headers):
    r = client.get(DETAILED, params={"month": 10, "year": 2026}, headers=sub1_headers)
    assert r.status_code == 404
