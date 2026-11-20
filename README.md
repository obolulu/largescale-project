# AI Billing Support Assistant (SE4458 Midterm)

Work in progress. The full plan and requirement checklist are in [docs/PLAN.md](docs/PLAN.md). The policy document is [docs/Mobile_Provider_Billing_Guide.md](docs/Mobile_Provider_Billing_Guide.md).

## Layout

| Folder | Contents | Status |
|---|---|---|
| `billing-api/` | TypeScript: NestJS 11 + TypeORM on PostgreSQL, migrations, seed script, Jest tests | all 5 operations + JWT done; 86 tests pass on Postgres |
| `mcp-server/` | TypeScript MCP server over `data/Mobile_Provider_Billing_Guide.md` | BM25 index, stdio + HTTP; 42 Vitest tests, retrieval scores identical to the Python version |
| `agent/` | TypeScript CLI agent: Claude tool calling over the REST API and the MCP server | loop, payment confirmation and tool trace done; 48 Vitest tests with a mocked LLM; not yet run against the live LLM |
| `gateway/` | API gateway config | not started |

All three are TypeScript on Node.js 22.18+ (the Docker images use Node 24). Each is its own npm package.

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

`docker compose up --build` runs the API in a container as well, and applies migrations on start. Seed it with `docker compose exec billing-api node dist/scripts/seed.js`.

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

**Three retrieval tests:** [docs/mcp_retrieval_tests.md](docs/mcp_retrieval_tests.md), generated by `npm run demo -- --write` over a real MCP transport (add `--url http://host:8001/mcp` to run against a deployed server).

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
| `BILLING_API_URL` | `http://localhost:8000` | API origin; in the cloud, the gateway URL |
| `MCP_SERVER_URL` | unset | e.g. `http://host:8001/mcp`; unset spawns `../mcp-server/dist/main.js` over stdio |
| `AGENT_MODEL` / `AGENT_EFFORT` | `claude-opus-5-5` / `low` | Claude model and effort |
| `AGENT_TRACE_DIR` | `agent/traces` | where session traces are written |
| `BILLING_PASSWORD` | unset | skips the password prompt (for scripted demos) |

Only subscriber logins are accepted; the admin account is refused, since admins have no own account to act on.

## Assumptions so far

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
- The MCP server has no authentication: it serves only the public policy guide, never subscriber data. Account data stays behind the JWT-protected REST API.
- The API tests run on PostgreSQL: in-process PGlite by default, or any server named by `TEST_DATABASE_URL`. SQLite isn't used anywhere (it doesn't meet the server-database requirement).
- Money is integer cents in code, so there is no floating-point rounding. Payment amounts may be sent as a JSON number or a string (`30`, `"29.50"`).
- Unlike the earlier FastAPI version, a trailing slash (`/api/v1/bills/`) reaches the same route instead of redirecting, and a wrong HTTP method on a known path returns 404 rather than 405.
- `DATABASE_URL` uses the `postgresql://` scheme. The older SQLAlchemy form `postgresql+psycopg://` is still accepted.
