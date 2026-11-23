# AI Billing Support Assistant (SE4458 Midterm)

A conversational billing assistant for mobile subscribers: an LLM agent that answers from the billing guide (over MCP) and from live account data (over a REST API behind an API gateway), deployed on Azure. The policy document is [docs/Mobile_Provider_Billing_Guide.md](docs/Mobile_Provider_Billing_Guide.md); the plan and requirement checklist are in [docs/PLAN.md](docs/PLAN.md).

**Quick links:** [Gateway (cloud)](https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io) · [Swagger UI](https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io/docs) · [MCP server](https://billing-mcp.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io/health) · [Test data and how to reproduce](#test-data-and-how-to-reproduce) · [Agent scenarios](#live-runs-against-azure) · Demo video: _link to be added_

## Architecture

```mermaid
flowchart LR
    user([Subscriber]) -->|chat in the terminal| agent
    agent["agent/ CLI<br/>tool loop, payment confirmation, tool trace"]
    agent <-->|"Messages API: tools, tool calls, results"| llm["Claude API<br/>(Anthropic)"]
    agent -->|"MCP: stdio, or Streamable HTTP at /mcp"| mcp["mcp-server<br/>search_billing_documentation"]
    mcp --> index["BM25 index of the billing guide<br/>built once at startup"]
    agent -->|"HTTPS + JWT"| gw["gateway/ Kong (DB-less)<br/>route mapping, JWT check"]
    gw --> api["billing-api<br/>NestJS REST, /api/v1, Swagger at /docs"]
    api --> db[("PostgreSQL")]
```

- The LLM never calls a service. It only chooses tools; the agent runs every call, policy questions through the MCP server and account data through the REST API, and sends the results back for the final answer.
- **API style:** REST with JSON bodies, versioned by URL prefix (`/api/v1`), JWT bearer auth on the protected operations. Details in [Billing REST API (v1)](#billing-rest-api-v1).
- **Stack:** TypeScript on Node.js throughout. NestJS 11 + TypeORM on PostgreSQL for the API, the official MCP TypeScript SDK for the documentation server, and the Anthropic TypeScript SDK for the agent.
- Every REST call, the agent's included, goes through the gateway. It checks the JWT before a protected call reaches the API, and the API checks it again. Details in [API gateway](#api-gateway-kong).

## Layout

| Folder | Contents | Status |
|---|---|---|
| `billing-api/` | TypeScript: NestJS 11 + TypeORM on PostgreSQL, migrations, seed script, Jest tests | all 5 operations + JWT done; 86 tests pass on Postgres |
| `mcp-server/` | TypeScript MCP server over `data/Mobile_Provider_Billing_Guide.md` | BM25 index, stdio + HTTP; 42 Vitest tests, retrieval scores identical to the Python version |
| `deploy/` | `azure.ps1`: deploys the stack to Azure (Postgres, registry, Container Apps) | deployed and seeded |
| `agent/` | TypeScript CLI agent: Claude tool calling over the REST API and the MCP server | loop, payment confirmation and tool trace done; 48 Vitest tests with a mocked LLM; run live against Azure (traces in `docs/traces/`) |
| `gateway/` | Kong 3.9 (OSS, DB-less) declarative config, Docker image, integration tests | route mapping + JWT validation done; 24 integration tests pass locally and against Azure |

The three services are TypeScript on Node.js 22.18+ (the Docker images use Node 24). Each is its own npm package.

## Run the unit tests (no Docker, cloud or LLM needed)

```bash
cd billing-api
npm ci
npm test
```

The API tests run against a real PostgreSQL engine. With `TEST_DATABASE_URL` unset, the test setup starts [PGlite](https://pglite.dev) (Postgres compiled to WebAssembly) in process and serves it over the Postgres wire protocol, so nothing has to be installed. To use a real server instead, for example the docker-compose `db`, set `TEST_DATABASE_URL=postgresql://billing:billing_dev_password@localhost:5432/billing_test`. Use an empty database: the tests drop and recreate the billing tables.

```bash
cd mcp-server
npm ci
npm test
```

```bash
cd agent
npm ci
npm test
```

The agent tests replace the LLM with a scripted one, so they need no API key. One test also talks to the real MCP server over stdio when `mcp-server` has been built (`npm run build` there); otherwise it is skipped.

**Last run** (2026-11-22, Windows 11, Node 26, no Docker, cloud or API key), summary lines from each suite:

```text
billing-api> npm test
Test Suites: 7 passed, 7 total
Tests:       86 passed, 86 total

mcp-server> npm test
 Test Files  5 passed (5)
      Tests  42 passed (42)

agent> npm test
 Test Files  3 passed (3)
      Tests  48 passed (48)
```

Every REST operation (Login, Add Usage, Calculate Bill, Query Bill, Query Bill Detailed, Pay Bill) has success and failure/edge-case tests in `billing-api/test/` (`auth`, `usage`, `bills`, `payments`, `pricing`, `seed`, `openapi` specs). <!-- TODO: add a screenshot of the full test output under docs/ and link it here -->

The gateway has a further 24 integration tests (`gateway/test/`), which need the running stack: see [API gateway](#api-gateway-kong).

## Run locally with Postgres (needs Docker)

```bash
cp .env.example .env
docker compose up -d db
cd billing-api
npm ci
npm run migrate
npm run seed            # add -- --reset to wipe and reseed
npm run build && npm start
```

Swagger UI: http://localhost:8000/docs · Spec: http://localhost:8000/openapi.json · Health check: http://localhost:8000/api/v1/health

**Whole stack in containers** (Postgres, API, MCP server, gateway):

```bash
docker compose up -d --build
docker compose exec billing-api node dist/scripts/seed.js
```

The API applies migrations on start. In this mode the API isn't published to the host; use the gateway at http://localhost:8080 (Swagger at http://localhost:8080/docs). The MCP server is at http://localhost:8001/mcp.

## Billing REST API (v1)

Style: REST/JSON, versioned by URL prefix (`/api/v1`). Spec: [docs/openapi.yaml](docs/openapi.yaml), generated from the controllers and DTOs by `npm run export:openapi` (a test fails if it's stale). Swagger UI at `/docs`.

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

For `VALIDATION_ERROR`, `details` is a list of `{"field", "message"}` entries, one per invalid field, for example `{"field": "month", "message": "Input should be less than or equal to 12"}`. Malformed JSON is a 422 too. A missing or invalid token is checked before the request body, so an anonymous request with a bad body gets 401, not 422.

Example, a protected route with no token:

```http
GET /api/v1/bills/detailed?month=10&year=2026

HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
{"error": {"code": "UNAUTHORIZED", "message": "Missing or invalid bearer token."}}
```

### Data model (ER diagram)

PostgreSQL schema from [the initial migration](billing-api/src/database/migrations/1763510400000-InitialSchema.ts). Usage is stored as raw records so Query Bill Detailed can page through them; a bill is a stored snapshot of one subscriber's month, and payments hang off the bill.

```mermaid
erDiagram
    subscribers |o--o{ users : "logs in as"
    subscribers ||--o{ usage_records : "has"
    subscribers ||--o{ bills : "is billed"
    bills ||--o{ payments : "is paid by"

    subscribers {
        varchar subscriber_no PK
        varchar name
        varchar plan
        timestamptz created_at
    }
    users {
        serial id PK
        varchar username UK
        varchar password_hash "bcrypt"
        user_role role "SUBSCRIBER or ADMIN"
        varchar subscriber_no FK "NULL only for ADMIN"
    }
    usage_records {
        serial id PK
        varchar subscriber_no FK
        int year
        int month "1-12"
        usage_type usage_type "PHONE or INTERNET"
        int amount "minutes or MB, above 0"
        timestamptz created_at
    }
    bills {
        serial id PK
        varchar subscriber_no FK "UNIQUE with year and month"
        int year
        int month "1-12"
        int phone_minutes
        int internet_mb
        numeric phone_charge "NUMERIC(10,2)"
        numeric internet_charge "NUMERIC(10,2)"
        numeric total "NUMERIC(10,2)"
        numeric paid_amount "NUMERIC(10,2), 0 or more"
        bill_status status "UNPAID, PARTIAL or PAID"
        timestamptz calculated_at
    }
    payments {
        serial id PK
        int bill_id FK
        varchar transaction_id UK "idempotency key"
        numeric amount "NUMERIC(10,2), above 0"
        timestamptz created_at
    }
```

- `bills (subscriber_no, year, month)` is unique: one bill per subscriber and month. Calculate Bill updates it in place and keeps `paid_amount`.
- `payments.transaction_id` is unique, which is what makes a repeated Pay Bill a 409 that records nothing.
- `usage_records` has an index on `(subscriber_no, year, month)` for Calculate Bill's sums and the detailed paging.
- A check constraint makes every SUBSCRIBER user point at a subscriber; ADMIN users have none.

## API gateway (Kong)

[Kong Gateway](https://developer.konghq.com/gateway/) 3.9 (open source), DB-less: the whole configuration is one declarative file, [gateway/kong.yml.tmpl](gateway/kong.yml.tmpl), and there is no Admin API at runtime. At container start, [gateway/render-config.sh](gateway/render-config.sh) fills in the backend URL and the JWT secret from environment variables, so neither is in git or in the image.

**Route mapping.** Paths are forwarded unchanged. Each route is an anchored regex for one method, so look-alikes such as `/api/v1/billsx` and unmapped paths get the gateway's 404 and never reach the API.

| Gateway route (method + path) | Kong route | Backend | JWT at gateway |
|---|---|---|---|
| `GET /api/v1/health` | `health` | `billing-api` `/api/v1/health` | – |
| `POST /api/v1/auth/login` | `auth-login` | `/api/v1/auth/login` | – |
| `GET /api/v1/bills` | `query-bill` | `/api/v1/bills` | – (public by spec) |
| `GET /api/v1/bills/detailed` | `query-bill-detailed` | `/api/v1/bills/detailed` | **yes** |
| `POST /api/v1/bills/calculate` | `calculate-bill` | `/api/v1/bills/calculate` | **yes** |
| `POST /api/v1/payments` | `pay-bill` | `/api/v1/payments` | **yes** |
| `POST /api/v1/usage` | `add-usage` | `/api/v1/usage` | **yes** |
| `GET /docs`, `/openapi.json`, `/openapi.yaml` | `api-docs` | Swagger UI and spec | – |

**JWT validation.** The protected routes sit on their own Kong service with the bundled `jwt` plugin. It checks the HS256 signature against the secret the API signs with, looks the issuer up through the `iss` claim (`billing-api`), and rejects expired tokens. The OSS plugin has no audience check, so a short `post-function` right after it requires `aud = billing-clients`. Tokens are read only from the `Authorization: Bearer` header, never from a query string or cookie. The API then validates the token again and enforces roles and the own-subscriber rule, so the gateway decides whether a token is genuine and the API decides what it is allowed to do.

Other settings: the gateway never retries a request on its own (`retries: 0`), so a Pay Bill can't be replayed behind the agent's back. Retries stay with the agent and reuse the same `transaction_id`. The `Server` version header is off, and every response carries an `X-Kong-Request-Id`. There's no rate limit, because Group 2's spec has none.

**Gateway URL.** Cloud: **https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io**. Locally: `http://localhost:8080` (docker compose). See [Cloud deployment](#cloud-deployment-azure).

**Protected route through the gateway.** The first request below, captured from the cloud gateway on 2026-11-22, has no token, and Kong answers it itself (`X-Kong-Response-Latency`, no upstream). The second has a login token and is proxied (`X-Kong-Upstream-Latency`).

```http
GET https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io/api/v1/bills/detailed?month=10&year=2026

HTTP/1.1 401 Unauthorized
content-type: application/json; charset=utf-8
www-authenticate: Bearer
x-kong-response-latency: 0
x-kong-request-id: a101c5682a6c1845dde90a10bc00f50d

{"message":"Unauthorized"}
```

```bash
GW=https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io   # or http://localhost:8080
TOKEN=$(curl -s -X POST "$GW/api/v1/auth/login" -H 'content-type: application/json' \
  -d '{"username":"sub5551001","password":"sub1001-demo-pass"}' | jq -r .access_token)
curl -s "$GW/api/v1/bills/detailed?month=10&year=2026" -H "Authorization: Bearer $TOKEN"
```

Errors the gateway produces itself are Kong's bodies, not the API's `{"error": ...}` shape. A missing token gives `{"message":"Unauthorized"}`, a bad signature `{"message":"Invalid signature"}`, an unknown issuer `{"message":"No credentials found for given 'iss'"}`, an expired token `{"exp":"token expired"}`, a wrong audience `{"message":"Invalid audience"}`, and an unmapped path is a 404 with `{"message":"no Route matched with those values"}`. The agent passes these to the LLM as they are.

**Settings** (container environment):

| Variable | Default | Meaning |
|---|---|---|
| `JWT_SECRET` | – (required) | the same secret as `billing-api`; the container refuses to start without it |
| `BILLING_API_UPSTREAM` | `http://billing-api:8000` | backend origin; `http://host.docker.internal:8000` for an API started with `npm start` |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `billing-api` / `billing-clients` | expected `iss` / `aud` |

Proxy on port 8080, health (`GET /status`) on 8100.

**Tests.** [gateway/test/gateway.test.mjs](gateway/test/gateway.test.mjs) (Node's built-in test runner, no dependencies) runs against the running, seeded stack. It covers the public routes; a 401 from the gateway for every protected route without a token, and for a forged signature, `alg: none`, an expired token, a wrong issuer, a wrong audience, and a token in the URL; valid tokens reaching the API, which still returns its own 403 for another subscriber's data and for a subscriber calling an admin route; and unmapped paths, look-alikes and wrong methods getting a 404. None of the tests change billing data.

```bash
docker compose up -d --build
docker compose exec billing-api node dist/scripts/seed.js
cd gateway && npm test            # GATEWAY_URL=... to test a deployed gateway
```

## MCP server (billing documentation)

Built with the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`, `McpServer`). It exposes one tool over the policy guide. The guide is documentation only; live bills and usage come from the REST API.

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
npm ci
npm run build
npm start                                                     # stdio, for an agent that spawns it
npm start -- --transport http --host 0.0.0.0 --port 8001      # http://host:8001/mcp
npm test
```

HTTP mode also serves `GET /health`. The Docker image runs HTTP mode on port 8001.

**Three retrieval tests:** [docs/mcp_retrieval_tests.md](docs/mcp_retrieval_tests.md), generated by `npm run demo -- --write` over a real MCP transport. The committed file was produced against the deployed server on Azure (`--url https://billing-mcp.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io/mcp`); without `--url` the script spawns the server over stdio and gives the same results.

| Query | Top result | Also returned |
|---|---|---|
| extra internet price | §8.1 What is the cost of extra internet? | §3.2 Additional internet blocks |
| partial payment rules | §5.1 Full and partial payments | §5.2 Payment confirmation |
| late payment penalty | §6.2 Late payment reminder ("does not add a fee") | §6.1 Due date, §6.3 Service restriction |

## AI agent (CLI)

A command-line chat for a logged-in subscriber. Claude (through the official Anthropic TypeScript SDK) picks the tools with real function calling; the agent runs every call itself, the documentation search over MCP and the account calls over REST, and sends the results back to Claude, which writes the answer. The loop is written by hand in [agent/src/agent.ts](agent/src/agent.ts).

| Tool given to the LLM | Runs | Input |
|---|---|---|
| `search_billing_documentation` | MCP server | `query`, `max_results` |
| `query_bill` | `GET /api/v1/bills` | `month`, `year` |
| `query_bill_detailed` | `GET /api/v1/bills/detailed` (JWT) | `month`, `year`, `page` |
| `pay_bill` | `POST /api/v1/payments` (JWT), after the user says yes | `month`, `year`, `amount` |

**Safety is enforced in code, not only in the prompt** ([agent/src/tools.ts](agent/src/tools.ts)):
- **Identity.** No tool takes a subscriber number. The agent fills it from the login (Query Bill) or the API reads it from the JWT (Detailed, Pay), so "show me subscriber 5551002's bill" can't reach another account.
- **Payment confirmation (§5.2).** `pay_bill` first reads the bill, turns down amounts above the remaining balance or a bill that is already paid, then asks the user `Pay $80.00 toward the October 2026 bill of subscriber 5551001 (remaining balance $80.00)? (yes/no)`. Only `y`/`yes` goes on; anything else returns `DECLINED_BY_USER` and nothing is sent.
- **Idempotent retries (§5.3).** The agent creates the `transaction_id` (a UUID). A network error or 5xx is retried with the same ID; if the outcome is still unknown, the model is told not to report success, and a later confirmed retry for the same month and amount reuses that ID, so it can't charge twice.
- The system prompt ([agent/src/prompt.ts](agent/src/prompt.ts)) carries the guide's rules: cite sections, never present an estimate as the stored bill (§4.4) or invent usage (§8.2), report payment success only after the API confirms it, and explain disputes without promising refunds (§7).

**Tool trace.** Every turn prints one line per tool call (name, input, result) and a summary (LLM requests, tokens, estimated cost) to stderr, and the whole session is saved as JSON in `agent/traces/session-<time>.json` with the user message, each tool call's input and full result, the final answer and token usage. The JWT is never written. `agent/traces/` is gitignored; curated traces for the report go under `docs/`.

**Model and cost.** The default model is `claude-opus-5-5` at `low` effort; set `AGENT_MODEL` and `AGENT_EFFORT` to change them. Prices per million tokens (input / output): Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50. The tools, system prompt and history are sent with prompt caching, so repeated prefix tokens are billed at a tenth of the input price, and requests opt into the API's server-side refusal fallback (`fallbacks: "default"`). Each trace records the real token counts and the estimated cost per turn.

**Run it**

```bash
cd mcp-server && npm ci && npm run build && cd ..   # the agent spawns it over stdio
cd agent
npm ci
export ANTHROPIC_API_KEY=...                          # or log in once with `ant auth login`
npm run dev -- -u sub5551001                          # asks for the password, then chats
npm run dev -- -u sub5551001 -m "Pay my bill"         # one question; the payment prompt is still asked
```

| Variable | Default | Meaning |
|---|---|---|
| `BILLING_API_URL` | `http://localhost:8080` | the API gateway; `http://localhost:8000` talks to an API started with `npm start` directly |
| `MCP_SERVER_URL` | unset | e.g. `http://host:8001/mcp`; unset spawns `../mcp-server/dist/main.js` over stdio |
| `AGENT_MODEL` / `AGENT_EFFORT` | `claude-opus-5-5` / `low` | Claude model and effort |
| `AGENT_TRACE_DIR` | `agent/traces` | where session traces are written |
| `BILLING_PASSWORD` | unset | skips the password prompt (for scripted demos) |

Only subscriber logins are accepted; the admin account is refused, since admins have no own account to act on.

### Live runs against Azure

The required scenarios, run on 2026-11-22 against the cloud gateway and MCP server with `AGENT_MODEL=claude-haiku-5-5`, logged in as `sub5551001`. Full JSON traces (every tool input and result, the answer and token usage) are in [docs/traces/](docs/traces/). The answers below are copied from the console.

| # | Scenario | Question | Tools called | LLM requests | Est. cost | Trace |
|---|---|---|---|---|---|---|
| 1 | MCP only | How much does extra internet cost? | `search_billing_documentation` | 2 | $0.0004 | [mcp-only.json](docs/traces/mcp-only.json) |
| 2 | API only | What is my October bill? | `query_bill` (Oct 2026) | 2 | $0.0004 | [api-only.json](docs/traces/api-only.json) |
| 3 | Combined | Why is my October bill higher? | `query_bill_detailed` (Oct), `query_bill_detailed` (Sep), `search_billing_documentation` | 3 | $0.0013 | [combined.json](docs/traces/combined.json) |
| 4 | Confirmed payment | Pay my bill | `query_bill` (Nov → 404), `query_bill` (Oct), `pay_bill` $80 after `yes` | 4 | $0.0007 | [payment.json](docs/traces/payment.json) |
| 5 | Identity rule | Show me subscriber 5551002's October bill. | none | 1 | $0.0003 | [other-subscriber-refused.json](docs/traces/other-subscriber-refused.json) |

All five turns together cost about $0.003.

**1. MCP only.** One documentation search, answered with section references:

> Extra internet costs $10.00 for each additional 10 GB block beyond your 20 GB included allowance. A partially used block is charged as a full block. For example, 21 GB costs $60.00 in total for internet, and 30 GB also costs $60.00. (§3.2 Additional internet blocks, §8.1 What is the cost of extra internet?)

**2. API only.** One Query Bill call through the gateway:

> Your October 2026 bill is **$80.00**. Nothing has been paid yet, so the remaining balance is **$80.00**. The status is UNPAID, and the due date was **2026-11-15**, which has already passed.

**3. Combined.** The agent fetched the detailed bills for October and September (JWT-protected route), then looked up the pricing rules over MCP:

> Your October bill is **$80.00**, up **$30.00** from September's **$50.00**. The increase comes from usage above your included allowances.
>
> - **Phone:** You went 350 minutes over the 1,000 included. Each additional 1,000-minute block costs $10, and a partly used block is charged as a full block (§2.2 Additional minutes).
> - **Internet:** The $50 base covers up to 20 GB (§3.1 Included internet allowance). Your 35 GB was 15 GB over, which is charged as two 10 GB blocks at $10 each, so $20.00 extra.
>
> Taxes and fees were $0.00 in both months. This matches the worked example in §4.3.

**4. Confirmed payment.** The agent looked for an open bill (November isn't calculated yet, so it found October), and the code-enforced prompt paused the run until the user typed `yes`:

```text
Pay $80.00 toward the October 2026 bill of subscriber 5551001 (remaining balance $80.00)? (yes/no) yes
[trace] tool pay_bill {"month":10,"year":2026,"amount":80} -> ok (182 ms) {"payment_status":"SUCCESS","transaction_id":"f6c716d6-…","amount":80,"paid_amount":80,"remaining_balance":0,"bill_status":"PAID",…}
```

> Your October 2026 bill is paid. Amount paid: $80.00. Remaining balance: $0.00. Transaction ID: f6c716d6-d380-482c-b6c9-712e4fb11d5f.

The cloud database was reseeded afterwards (`.\deploy\azure.ps1 -Step seed -Reset`), so October 2026 is UNPAID again.

**5. Identity rule.** The request is refused without any tool call. Even if the model tried, no tool accepts a subscriber number:

> I can only help with your own account (subscriber 5551001), so I can't show subscriber 5551002's bill. If you'd like, I can show you your October 2026 bill instead.

To reproduce (the cloud apps scale to zero, so the first request can take about 25 s):

```bash
cd agent && npm ci
export ANTHROPIC_API_KEY=...   # or put it in .env at the repo root
export BILLING_API_URL=https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io
export MCP_SERVER_URL=https://billing-mcp.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io/mcp
export AGENT_MODEL=claude-haiku-5-5 BILLING_PASSWORD=sub1001-demo-pass
npm run dev -- -u sub5551001 -m "Why is my October bill higher?"
```

## Cloud deployment (Azure)

Deployed on Azure for Students with one rerunnable script, [deploy/azure.ps1](deploy/azure.ps1).

| Service | URL | Reachable from |
|---|---|---|
| **API gateway** (Kong) | https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io | the internet (HTTPS) |
| Swagger UI, through the gateway | https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io/docs | the internet |
| **MCP server** | https://billing-mcp.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io/mcp (health: `/health`) | the internet |
| Billing API | `billing-api.internal…azurecontainerapps.io` | **only the gateway** (internal ingress; a direct call from outside gets 404) |
| PostgreSQL 16 | `pg-billing-1nxgw2-swedencentral.postgres.database.azure.com` | the Container Apps (Azure services) and the IP the seed ran from; TLS required |

```mermaid
flowchart LR
    agent["agent CLI<br/>(laptop)"] -->|HTTPS + JWT| gw
    agent -->|HTTPS /mcp| mcp
    subgraph aca["Container Apps environment cae-billing (Sweden Central)"]
        gw["billing-gateway<br/>Kong, external ingress :8080"] -->|HTTPS, internal ingress| api["billing-api<br/>NestJS :8000"]
        mcp["billing-mcp<br/>external ingress :8001"]
    end
    api -->|"TLS (sslmode=verify-full)"| db[("Azure Database for PostgreSQL<br/>Flexible Server, B1ms")]
    acr[("Azure Container Registry<br/>acrbilling1nxgw2")] -.->|image pull| aca
```

**Try it** (the apps scale to zero, so the first request after a quiet period takes a few seconds):

```bash
GW=https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io
curl "$GW/api/v1/bills?subscriber_no=5551001&month=10&year=2026"          # public: 200, total 80
curl -i "$GW/api/v1/bills/detailed?month=10&year=2026"                    # protected, no token: 401 from Kong
TOKEN=$(curl -s -X POST "$GW/api/v1/auth/login" -H 'content-type: application/json' \
  -d '{"username":"sub5551001","password":"sub1001-demo-pass"}' | jq -r .access_token)
curl "$GW/api/v1/bills/detailed?month=10&year=2026" -H "Authorization: Bearer $TOKEN"   # 200
```

Point the agent at the cloud with `BILLING_API_URL=https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io` and `MCP_SERVER_URL=https://billing-mcp.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io/mcp`.

**Resources** (resource group `rg-billing-se4458`):

| Resource | Type / size | Region |
|---|---|---|
| `pg-billing-1nxgw2-swedencentral` | PostgreSQL 16 Flexible Server, Burstable `Standard_B1ms`, 32 GB, database `billing` | Sweden Central |
| `cae-billing` | Container Apps environment, WorkloadProfiles mode (Consumption profile), Log Analytics logs | Sweden Central |
| `billing-api`, `billing-gateway`, `billing-mcp` | Container Apps, 0.5 vCPU / 1 GiB, 0–1 replicas | Sweden Central |
| `acrbilling1nxgw2` | Container Registry, Basic | France Central |

**Secrets.** The script generates the JWT secret and the database password and keeps them in `deploy/.azure.local.json`, which is gitignored. In Azure they're Container Apps secrets (`jwt-secret`, `database-url`), referenced by the `JWT_SECRET` and `DATABASE_URL` environment variables, so they never appear in the image or in git. The gateway and the API share the JWT secret.

### Deploy it yourself

Needs the Azure CLI (`winget install --exact --id Microsoft.AzureCLI`), Docker Desktop and Node.js 22.18+.

```powershell
az login                                   # choose the "Azure for Students" subscription
.\deploy\azure.ps1 -Step infra -Location swedencentral   # resource group, registry, Postgres, environment (~15 min)
.\deploy\azure.ps1 -Step images           # build the three images and push them
.\deploy\azure.ps1 -Step apps             # create/update the Container Apps, print the URLs
.\deploy\azure.ps1 -Step seed             # firewall rule for this IP, migrate, demo data (-Reset to wipe first)
.\deploy\azure.ps1 -Step test             # gateway/test against the cloud gateway
.\deploy\azure.ps1 -Step status           # URLs and health
```

Each step can be rerun: existing resources are reused, and `images` followed by `apps` deploys a new version as a new revision. The first `infra` run remembers the regions, so later steps don't need `-Location`. The API container applies migrations when it starts.

**Cost.** Everything comes from the $100 student credit. The database is the main cost: B1ms compute is billed hourly while the server runs, plus its storage. The registry (Basic) is a few dollars a month. The Container Apps scale to zero and fit in the monthly free grant for a demo's traffic. To pause the database between sessions:

```powershell
.\deploy\azure.ps1 -Step stop     # compute billing stops; storage continues
.\deploy\azure.ps1 -Step start
```

**Deployment notes**
- **Regions.** This Azure for Students subscription may only deploy to France Central, Spain Central, Sweden Central, Switzerland North and UAE North. France Central answered `SkuNotAvailable` for Postgres B1ms in every zone, so the database and the apps are in Sweden Central. The registry was already in France Central, which only affects image pull speed.
- **Environment mode.** With Azure CLI 2.93 the environment came up in *Express* mode. There, managed identities aren't supported and app revisions failed to provision (`Artifact app provisioning failed`). The script asks for `WorkloadProfiles` explicitly and refuses to reuse an Express environment.
- **Registry access.** Images are pulled with the registry's admin credentials, which Container Apps keeps as an app secret. A managed identity would be the next hardening step.
- **Database access.** "Allow Azure services" is on so the Container Apps can connect (connections still need the password over TLS). The seed step adds a firewall rule for the deploying machine's IP only. Remove it when you no longer need it: `az postgres flexible-server firewall-rule delete -g rg-billing-se4458 --server-name pg-billing-1nxgw2-swedencentral --name seed-from-laptop --yes`.
- **No retries at the gateway**, and at most one replica per app, so the demo behaves predictably. Raise `--max-replicas` for real traffic.

## Test data and how to reproduce

The same demo data is in the cloud database and in any local database after `npm run seed`. It's defined in [billing-api/scripts/seed.ts](billing-api/scripts/seed.ts); `-- --reset` (or `.\deploy\azure.ps1 -Step seed -Reset` for the cloud) wipes and reseeds, for example after trying a payment.

**Logins** (test values only, not real credentials):

| Username | Password | Role | Subscriber |
|---|---|---|---|
| `sub5551001` | `sub1001-demo-pass` | SUBSCRIBER | 5551001 |
| `sub5551002` | `sub1002-demo-pass` | SUBSCRIBER | 5551002 |
| `admin` | `admin-demo-pass` | ADMIN | – |

**Bills:**

| Subscriber | Period | Usage | Bill | Paid | Status | Shows |
|---|---|---|---|---|---|---|
| 5551001 | Sep 2026 | 800 min, 18,000 MB | $50 | $50 | PAID | baseline month |
| 5551001 | Oct 2026 | 1,350 min, 35,000 MB | $80 | $0 | UNPAID | "Why is my October bill higher?", "Pay my bill"; the guide's §4.3 example |
| 5551002 | Sep 2026 | 2,010 min, 30,001 MB | $90 | $40 | PARTIAL | a partial payment; block rounding on both lines |
| 5551002 | Oct 2026 | 600 min, 0 MB | $50 | $0 | UNPAID | the $50 internet base with zero usage |

**Steps for the instructor** (against the cloud; no Azure account needed):

1. **Unit tests:** `npm ci && npm test` in `billing-api/`, `mcp-server/` and `agent/` (see [Run the unit tests](#run-the-unit-tests-no-docker-cloud-or-llm-needed)).
2. **Gateway, public and protected routes:** the `curl` commands under [Try it](#cloud-deployment-azure). Expected: Query Bill 200 with `total: 80`; Query Bill Detailed 401 without a token and 200 with one; a token for `sub5551001` asking for `subscriber_no=5551002` gets 403.
3. **Swagger UI:** open `/docs` on the gateway, click *Authorize* with a token from `POST /api/v1/auth/login`, and try any operation. Admin operations (Add Usage, Calculate Bill) need the `admin` login.
   **Postman:** import the collection [docs/postman/billing-api.postman_collection.json](docs/postman/billing-api.postman_collection.json) and an environment, [billing-azure](docs/postman/billing-azure.postman_environment.json) for the cloud or [billing-local](docs/postman/billing-local.postman_environment.json) for docker compose. Select the environment, then run the folders in order. Each request has tests for the expected status and error code. The warm-up request retries through a cold start, and the logins save their tokens into the environment. Folders 4 (Pay Bill) and 5 (Admin) change data, so reseed afterwards. To run it headless: `npx newman run docs/postman/billing-api.postman_collection.json -e docs/postman/billing-azure.postman_environment.json` (60 assertions on freshly seeded data).
4. **MCP retrieval:** `cd mcp-server && npm ci && npm run demo -- --url https://billing-mcp.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io/mcp`. Expected top results: §8.1, §5.1, §6.2.
5. **Agent scenarios:** the commands under [Live runs against Azure](#live-runs-against-azure) with your own `ANTHROPIC_API_KEY`. Ask the questions in that table; for "Pay my bill", answer `yes` at the prompt. Then reseed, or the October bill stays PAID.

The cloud apps scale to zero, so the first request after a quiet period can take about 25 s.

## Assumptions

- Pricing follows guide §4.2 exactly, using integer MB arithmetic (1 GB = 1,000 MB). The $50 internet base is charged even with zero usage (§3.1). There are no taxes or fees (§4.2).
- The brief's sample "Apr 2025 → $75" can't come from these rules (totals move in $10 steps from $50), so it's treated as an illustration of the response shape only.
- Add Usage records one 10-minute or 1 MB event per call. The seed script inserts batched usage rows (50 min / 500 MB) so demo months stay small. Bill totals are the same either way.
- Seed logins are test-only credentials and are listed in `billing-api/scripts/seed.ts`.
- Bills are stored snapshots. Usage added after Calculate Bill isn't billed until Calculate Bill runs again for that period.
- Recalculating a bill updates its charges and keeps payments already made. If the new total is below the amount paid, the remaining balance is shown as 0 and the bill is PAID. There's no credit or refund logic (guide §7.3 leaves that to customer support).
- Calculate Bill works for any valid period, including one with no usage ($50, per §3.1).
- Payments: amount must be > 0, have at most 2 decimals, and not exceed the remaining balance. `transaction_id` is a client-generated idempotency key (the agent uses a UUID). Status follows §5.1: UNPAID → PARTIAL → PAID.
- Query Bill is unauthenticated because the spec says so. It returns only totals and status, no usage details. The agent always fills `subscriber_no` from the logged-in session, never from the prompt.
- Money is stored as `NUMERIC(10,2)` and returned as a JSON number in USD. `due_date` is 15 days after the end of the billing month (§6.1).
- Deployment: Azure Container Apps for the three services and Azure Database for PostgreSQL Flexible Server, in Sweden Central (see [Deployment notes](#cloud-deployment-azure)). The agent runs on the user's machine and talks to the cloud gateway and MCP server.
- The MCP server has no authentication: it serves only the public policy guide, never subscriber data. Account data stays behind the JWT-protected REST API.
- The API tests run on PostgreSQL: in-process PGlite by default, or any server named by `TEST_DATABASE_URL`. SQLite isn't used anywhere (it doesn't meet the server-database requirement).
- Money is integer cents in code, so there is no floating-point rounding. Payment amounts may be sent as a JSON number or a string (`30`, `"29.50"`).
- Unlike the earlier FastAPI version, a trailing slash (`/api/v1/bills/`) reaches the same route instead of redirecting, and a wrong HTTP method on a known path returns 404 rather than 405.
- `DATABASE_URL` uses the `postgresql://` scheme. The older SQLAlchemy form `postgresql+psycopg://` is still accepted.
