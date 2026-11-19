# AI Billing Support Assistant (SE4458 Midterm)

Work in progress. The full plan and requirement checklist are in [docs/PLAN.md](docs/PLAN.md). The policy document is [docs/Mobile_Provider_Billing_Guide.md](docs/Mobile_Provider_Billing_Guide.md).

## Layout

| Folder | Contents | Status |
|---|---|---|
| `billing-api/` | FastAPI service, SQLAlchemy models, Alembic migrations, seed script, tests | all 5 operations + JWT done; not yet run against Postgres |
| `mcp-server/` | MCP server over `data/Mobile_Provider_Billing_Guide.md` | done: BM25 index, stdio + HTTP, 32 tests |
| `agent/` | LLM agent (CLI) | not started |
| `gateway/` | API gateway config | not started |

## Run the unit tests (no database, cloud or LLM needed)

```bash
cd billing-api
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt   # Linux/macOS: .venv/bin/python
.venv/Scripts/python -m pytest
```

## Run locally with Postgres (needs Docker)

```bash
cp .env.example .env
docker compose up -d db
cd billing-api
.venv/Scripts/alembic upgrade head
.venv/Scripts/python -m scripts.seed
.venv/Scripts/uvicorn app.main:app --reload
```

Swagger UI: http://localhost:8000/docs · Health check: http://localhost:8000/api/v1/health

`docker compose up --build` runs the API in a container as well, and applies migrations on start.

To run the unit tests against Postgres instead of in-memory SQLite, set `TEST_DATABASE_URL` (for example `postgresql+psycopg://billing:billing_dev_password@localhost:5432/billing_test`, an empty database the tests may wipe).

## Billing REST API (v1)

Style: REST/JSON, versioned by URL prefix (`/api/v1`). Spec: [docs/openapi.yaml](docs/openapi.yaml) (regenerate with `python -m scripts.export_openapi`; a test fails if it's stale). Swagger UI at `/docs`.

| Operation | Method and path | Auth | Paging |
|---|---|---|---|
| Login | `POST /api/v1/auth/login` | – | – |
| Add Usage | `POST /api/v1/usage` | ADMIN | – |
| Calculate Bill | `POST /api/v1/bills/calculate` | ADMIN | – |
| Query Bill | `GET /api/v1/bills?subscriber_no=&month=&year=` | none (per spec) | – |
| Query Bill Detailed | `GET /api/v1/bills/detailed?month=&year=[&subscriber_no=]&page=&page_size=` | SUBSCRIBER (own) or ADMIN | yes, over usage records |
| Pay Bill | `POST /api/v1/payments` | SUBSCRIBER (own) or ADMIN | – |

**Identity rule.** For protected calls, a subscriber's account comes from the `subscriber_no` claim in their JWT. A request that names a different subscriber gets **403**, so a number typed into the chat can't unlock someone else's data. Admins must pass `subscriber_no` explicitly.

**JWT.** HS256, 60-minute lifetime, claims `sub` (username), `role`, `subscriber_no`, `iss=billing-api`, `aud=billing-clients`.

### Errors

Every error has the body `{"error": {"code": "...", "message": "...", "details": ...}}`.

| Status | Code | When |
|---|---|---|
| 401 | `UNAUTHORIZED` | no bearer token, bad signature, wrong issuer/audience, expired |
| 401 | `INVALID_CREDENTIALS` | wrong username or password at login |
| 403 | `FORBIDDEN` | subscriber calling an admin operation, or another subscriber's data |
| 404 | `SUBSCRIBER_NOT_FOUND` / `BILL_NOT_FOUND` | unknown subscriber, or bill not calculated yet |
| 409 | `DUPLICATE_TRANSACTION` | `transaction_id` already used; nothing is recorded |
| 409 | `BILL_ALREADY_PAID` | bill has no remaining balance |
| 422 | `AMOUNT_EXCEEDS_BALANCE` | payment above the remaining balance (`details.remaining_balance`) |
| 422 | `VALIDATION_ERROR` | bad or missing fields (`details` lists them) |

Example, a protected route with no token:

```http
GET /api/v1/bills/detailed?month=10&year=2026

HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
{"error": {"code": "UNAUTHORIZED", "message": "Missing or invalid bearer token."}}
```

## MCP server (billing documentation)

Built with the official MCP Python SDK (`mcp` 2.x, `MCPServer`). It exposes one tool over the policy guide. The guide is documentation only; live bills and usage come from the REST API.

**Tool `search_billing_documentation`**

| Input | Type | Notes |
|---|---|---|
| `query` | string, 1–500 chars | required |
| `max_results` | integer 1–5 | optional, default 3 |

Output (structured content, also sent as JSON text), following the shape the guide asks for in §9:

```json
{
  "document": "Mobile_Provider_Billing_Guide.md",
  "document_id": "MOB-BILLING-2026-01",
  "query": "extra internet price",
  "matches": [
    {
      "section": "8.1",
      "heading": "What is the cost of extra internet?",
      "parent_heading": "Frequently asked questions",
      "reference": "§8.1 What is the cost of extra internet?",
      "text": "Each additional 10 GB block beyond 20 GB costs $10. Partially used blocks are rounded up. See Section 3.2.",
      "score": 7.043
    }
  ]
}
```

**Indexing approach**
- **Once, at startup.** The server reads and indexes the guide before it accepts connections (about 1 ms, logged as `indexed ... 25 chunks`). Queries only search the prebuilt index; a test checks that three queries trigger zero rebuilds.
- **Chunks:** one per `###` subsection (for example §3.2), plus one per `##` section that has no subsections (§1, §9). Headings inside code blocks are ignored. Each chunk keeps its section ID, heading and parent heading for citations.
- **Ranking:** BM25 full-text search (k1 = 1.5, b = 0.75), no embeddings. Headings count double. Words are lowercased, stopwords dropped, and simple suffixes stripped, so "charges" matches "charge".
- **Synonyms:** a small billing vocabulary expands queries at half weight (extra ↔ additional, data → internet, price ↔ cost ↔ charge, penalty → fee/late, and so on). "Extra data price" finds §3.2 even though the guide never says "data" or "price".
- Sections with no matching words are left out, so an unrelated query returns `matches: []`.

**Run it**

```bash
cd mcp-server
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
.venv/Scripts/python -m billing_docs.server                       # stdio, for an agent that spawns it
.venv/Scripts/python -m billing_docs.server --transport http --host 0.0.0.0 --port 8001   # http://host:8001/mcp
.venv/Scripts/python -m pytest
```

HTTP mode also serves `GET /health`. The Docker image runs HTTP mode on port 8001.

**Three retrieval tests:** [docs/mcp_retrieval_tests.md](docs/mcp_retrieval_tests.md), generated by `python scripts/retrieval_demo.py --write` over a real MCP transport (add `--url http://host:8001/mcp` to run against a deployed server).

| Query | Top result | Also returned |
|---|---|---|
| extra internet price | §8.1 What is the cost of extra internet? | §3.2 Additional internet blocks |
| partial payment rules | §5.1 Full and partial payments | §5.2 Payment confirmation |
| late payment penalty | §6.2 Late payment reminder ("does not add a fee") | §6.1 Due date, §6.3 Service restriction |

## Assumptions so far

- Pricing follows guide §4.2 exactly, using integer MB arithmetic (1 GB = 1,000 MB). The $50 internet base is charged even with zero usage (§3.1). There are no taxes or fees (§4.2).
- The brief's sample "Apr 2025 → $75" can't come from these rules (totals move in $10 steps from $50), so it's treated as an illustration of the response shape only.
- Add Usage records one 10-minute or 1 MB event per call. The seed script inserts batched usage rows (50 min / 500 MB) so demo months stay small. Bill totals are the same either way.
- Seed logins are test-only credentials and are listed in `billing-api/scripts/seed.py`.
- Bills are stored snapshots. Usage added after Calculate Bill isn't billed until Calculate Bill runs again for that period.
- Recalculating a bill updates its charges and keeps payments already made. If the new total is below the amount paid, the remaining balance is shown as 0 and the bill is PAID. There's no credit or refund logic (guide §7.3 leaves that to customer support).
- Calculate Bill works for any valid period, including one with no usage ($50, per §3.1).
- Payments: amount must be > 0, have at most 2 decimals, and not exceed the remaining balance. `transaction_id` is a client-generated idempotency key (the agent will use a UUID). Status follows §5.1: UNPAID → PARTIAL → PAID.
- Query Bill is unauthenticated because the spec says so. It returns only totals and status, no usage details. The agent will always fill `subscriber_no` from the logged-in user's token, never from the prompt.
- Money is stored as `NUMERIC(10,2)` and returned as a JSON number in USD. `due_date` is 15 days after the end of the billing month (§6.1).
- The MCP server has no authentication: it serves only the public policy guide, never subscriber data. Account data stays behind the JWT-protected REST API.
- Unit tests run on in-memory SQLite for portability. The application itself requires Postgres (SQLite doesn't meet the server-database requirement).
