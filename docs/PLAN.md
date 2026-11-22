# SE4458 Midterm: AI Billing Support Assistant (Group 2): Project Plan

> **Individual work.** The brief says "Every student will do their own midterm, no groups." "Group 2" is only the scenario assignment.

## 1. What we're building

Four parts, each its own service:

1. **Billing REST API + PostgreSQL**: Add Usage, Calculate Bill, Query Bill, Query Bill Detailed, Pay Bill. All versioned under `/api/v1/...`.
2. **API Gateway**: every REST call goes through it, including the agent's calls. It also checks JWTs on the protected routes.
3. **MCP server**: indexes `Mobile_Provider_Billing_Guide.md` once at startup and exposes `search_billing_documentation(query)`. It returns excerpts with section references.
4. **AI agent**: a CLI or simple web chat. The LLM picks tools through real function calling, the agent runs them (MCP directly, REST through the gateway), and the LLM writes the final answer from the results.

> The billing guide was embedded in the brief .docx as an attached file. It's extracted to [`docs/Mobile_Provider_Billing_Guide.md`](Mobile_Provider_Billing_Guide.md) (document ID `MOB-BILLING-2026-01`, effective Nov 1, 2026), and a copy lives in `mcp-server/data/` for indexing. Section numbers quoted below (§x.y) refer to it.

### Architecture

```
User ──> AI Agent <──> LLM (tool selection + answer generation)
            │
            ├── MCP Client ──> MCP Server ──> indexed billing guide
            │
            └── HTTP + JWT ──> API Gateway ──> Billing REST API ──> PostgreSQL
```

The LLM never calls backend services directly. The agent runs every tool call.

---

## 2. Tech stack

| Part | Choice | Why |
|---|---|---|
| API | TypeScript + NestJS 11 (Express) | `@nestjs/swagger` generates Swagger UI at `/docs` and `openapi.yaml` from the DTOs; guards give clean JWT/role checks |
| DB | PostgreSQL (TypeORM, hand-written SQL migrations) | SQLite isn't allowed |
| MCP | Official MCP TypeScript SDK (`@modelcontextprotocol/sdk`, `McpServer`) + a small built-in BM25 index | Counts as a "real MCP SDK server", and full-text search is enough |
| Agent | TypeScript CLI on the Anthropic SDK (`@anthropic-ai/sdk`), a hand-written tool loop; Claude Opus 5.5 at low effort by default, any model via `AGENT_MODEL` | The brief asks for low cost, and the cost must be documented: each turn logs its token usage and estimated cost |
| Gateway | Kong Gateway 3.9 OSS, DB-less (declarative config) | Named in the brief; free, runs the same in docker-compose and on Azure Container Apps, and can be tested locally (APIM can't) |
| Cloud | Azure for Students: Container Apps (WorkloadProfiles env, Consumption) + Azure Database for PostgreSQL Flexible (B1ms), Sweden Central | Deploying locally costs points; France Central had no B1ms capacity for the subscription |
| Tests | Jest + supertest (API) on Postgres via in-process PGlite or `TEST_DATABASE_URL`; Vitest (MCP); LLM mocked | Tests must run without the cloud or a live LLM |

> The project was first written in Python (FastAPI, SQLAlchemy, MCP Python SDK) and then ported to TypeScript with the same API contract and MCP tool behaviour. The Python version is the "Python implementation snapshot" commit in git history.

---

## 3. Business logic (25 pts)

### Add Usage
- [x] Each call adds a fixed unit, **10 minutes** of phone or **1 MB** of internet, keyed by subscriber, month and year.

### Calculate Bill
- [x] **Phone:** the first 1,000 minutes are free, then $10 for each started 1,000-minute block.
  - 1,000 min → $0 · 1,001 min → $10 · 2,001 min → $20
- [x] **Internet:** $50 for up to 20 GB, then $10 for each started extra 10 GB block. **1 GB = 1,000 MB.**
  - 20,000 MB → $50 · 20,001 MB → $60 · 30,001 MB → $70
  - Guide formula (§4.2): phone = `$10 × ceil(max(0, min − 1000) / 1000)`, internet = `$50 + $10 × ceil(max(0, GB − 20) / 10)`. Implemented in integer MB so 20,001 MB is never rounded away.
- [x] The $50 **is** charged when internet use is 0 (§3.1: "including months with zero usage").
- [x] No taxes, activation fees or discounts (§4.2). Total = phone + internet.
- [x] Test against the worked example (§4.3): 1,350 min + 35 GB → $10 + $70 = **$80**.
- [x] Decide and document what happens when a partly paid bill is recalculated. Decided: update the total and keep `paid_amount`; the remaining balance floors at 0 (README assumptions, tested).

### Pay Bill
- [x] UNIQUE constraint on `transaction_id`, so duplicates return 409.
- [x] Reject amounts ≤ 0 or above the remaining balance.
- [x] Status: `UNPAID`, `PARTIAL` or `PAID`.
- [x] Simulated only: no real card processing.

### Query Bill / Query Bill Detailed
- [x] Query Bill returns total, paid amount, remaining balance and status.
- [x] Query Bill Detailed returns total, paid, remaining, phone minutes, internet MB/GB and the charge breakdown, **paged** over usage line items.

> **Resolved:** the brief's sample "Apr 2025 → $75" can't come from these rules, since totals only move in $10 steps from $50 and the guide rules out fees and tax (§4.2). Treat it as an illustration of the response shape and say so in the README assumptions.

---

## 4. Data model (ER diagram)

The implemented schema, with constraints, is drawn as a Mermaid ER diagram in the README ("Data model (ER diagram)").

- `users` (id, username, password_hash, role: SUBSCRIBER/ADMIN, subscriber_no)
- `subscribers` (subscriber_no PK, name, plan)
- `usage_records` (id, subscriber_no FK, year, month, usage_type PHONE/INTERNET, amount, created_at). Raw records make detailed paging possible. Add Usage always writes 10 min / 1 MB. The seed script writes larger batched records (for example 500 MB) so a 35 GB month doesn't need 35,000 rows. Document this.
- `bills` (id, subscriber_no FK, year, month, phone_minutes, internet_mb, phone_charge, internet_charge, total, paid_amount, status, UNIQUE(subscriber_no, year, month))
- `payments` (id, bill_id FK, transaction_id UNIQUE, amount, created_at)

---

## 5. Auth and safety (10 pts + part of the agent score)

| Endpoint | Auth | Paging |
|---|---|---|
| Query Bill | NO | NO |
| Query Bill Detailed | YES | YES |
| Pay Bill | YES | NO |
| Calculate Bill | YES (admin) | NO |
| Add Usage | YES (admin) | NO |

- [x] `POST /api/v1/auth/login` returns a JWT with `sub=username`, `role`, `subscriber_no`, `iss` and `aud` (the gateway checks `iss`/`aud` too).
- [x] Add Usage and Calculate Bill are admin-only; Pay Bill and Query Bill Detailed allow the subscriber (own account) or an admin. Documented in the README.
- [x] **Key rule:** for protected calls, the subscriber number comes from the **token**, never from the prompt. If someone types "show me subscriber 999's details," the API returns 403. Covered by tests, verified against the cloud gateway, and shown in the identity-refusal agent trace.
- [x] Query Bill is public by spec, so the **agent** must always fill `subscriber_no` from the logged-in session, never from the prompt (Phase 5).
- [x] **Payment confirmation is enforced in code, not just in the prompt.** When the LLM asks for `pay_bill`, the agent pauses, shows `Pay $X for Oct 2025? (yes/no)` and only calls the API after an explicit yes. The agent generates the transaction ID (a UUID).

---

## 6. MCP server (20 pts)

- [x] Split the markdown into one chunk per `###` subsection (the guide's subsections are all short, so no further splitting is needed). Sections without subsections (§1, §9) become one chunk each. 25 chunks.
- [x] Keep the section ID and heading on each chunk, for example `3.2` / `Additional internet blocks`, plus the parent heading and a `reference` string for citations.
- [x] Build the index **once at startup**, never per query. Stated in the README and covered by a test.
- [x] Tool: `search_billing_documentation(query, max_results=3)` → `{document, document_id, query, matches: [{section, heading, parent_heading, reference, text, score}]}`.
- [x] Transports: stdio (local agent) and Streamable HTTP at `/mcp` with `/health` (for hosting).
- [x] Three retrieval tests written to `docs/mcp_retrieval_tests.md` by `scripts/retrieval-demo.ts`:
  1. "extra internet price" → §8.1, §3.2
  2. "partial payment rules" → §5.1
  3. "late payment penalty" → §6.2 (the reminder adds **no** fee), §6.1, §6.3

---

## 7. AI agent (20 pts)

- [x] Tools given to the LLM: `search_billing_documentation`, `query_bill`, `query_bill_detailed`, `pay_bill`.
- [x] Loop: user message → LLM → tool_calls → agent runs them → tool results go back to the LLM → final answer with section references.
- [x] System prompt rules taken from the guide:
  - Never present a calculated estimate as a stored bill (§4.4). Use Query Bill results.
  - Before paying, state the subscriber, billing period and amount, and get explicit consent (§5.2).
  - Report payment success only after the API confirms it, and reuse the same transaction ID on retries (§5.3).
  - Explain the dispute process, but never promise a refund or adjustment (§7.2, §7.3). There is no Dispute API.
  - Never invent usage numbers. Fetch them with Query Bill Detailed (§8.2).
- [x] Log a **tool trace** for every turn (tool name, inputs, result, final answer) to the console and a JSON file. This is a graded deliverable.
- [x] Required scenarios (pass with a mocked LLM, and live with Haiku 5.5 against Azure on 2026-11-22; traces in `docs/traces/`, plus an identity-refusal trace):
  1. **MCP only:** "How much does extra internet cost?"
  2. **API only:** "What is my October bill?"
  3. **Combined:** "Why is my October bill higher?" (Detailed API + MCP)
  4. **Confirmed payment:** "Pay my bill"

---

## 8. API Gateway (10 pts)

Built with Kong 3.9 OSS, DB-less (`gateway/`). Details and the route table are in the README ("API gateway (Kong)").

- [x] Public routes, each mapped to the backend:
  - `/api/v1/bills`
  - `/api/v1/bills/detailed`
  - `/api/v1/bills/calculate`
  - `/api/v1/payments`
  - `/api/v1/usage`
- [x] JWT validation at the gateway (Kong `jwt` plugin: signature, `iss`, `exp`; a `post-function` checks `aud`) and again in the API. 24 integration tests in `gateway/test/` pass against the docker-compose stack.
- [x] Document the gateway URL, a route-mapping table and one error response (for example a 401 with no token). Cloud gateway: https://billing-gateway.orangeplant-9349f6a6.swedencentral.azurecontainerapps.io
- [x] Group 2 has no rate limit in the spec. None added (stated in the README).

---

## 9. Unit tests (part of testing + docs, 10 pts)

- [x] At least one success test and one failure or edge-case test **per API operation**.
- [x] Pricing edge cases (1,000 vs 1,001 min; 20,000 vs 20,001 MB; 0 usage).
- [x] Duplicate transaction ID, overpayment, negative amount.
- [x] 401 (no token) and 403 (another subscriber's data).
- [x] Paging on Query Bill Detailed.
- [x] MCP indexer/search tests.
- [x] Agent tests with a **mocked LLM** (tool routing, confirmation required before pay).
- [x] Runs with one command per service (`npm test`), with no cloud and no live LLM.

---

## 10. Build order

| Phase | Work | Rough effort | Done |
|---|---|---|---|
| 0 | Setup: GitHub repo, install Docker Desktop and the Azure CLI, activate Azure for Students, get one LLM API key | 1 hour | [x] done |
| 1 | Repo skeleton, docker-compose (Postgres), schema + migrations, seed data, pricing functions + tests | 1 day | [x] migrations and seed run on Postgres (PGlite and Azure); images built and deployed |
| 2 | REST API + business logic + Swagger + JWT (write each operation's tests alongside it) | 2–3 days | [x] ported to NestJS; 86 tests pass on Postgres |
| 2b | **Cloud skeleton:** API and Kong gateway containers on Azure Container Apps, with one public and one JWT-protected route | 0.5 day | [x] done with Phase 6 (`deploy/azure.ps1`) |
| 3 | Fill test gaps: run the suite on Postgres, test output screenshot for the README | 0.5 day | [~] suite runs on Postgres; test output pasted in the README; screenshot still to do |
| 4 | MCP server + index + three retrieval tests | 1 day | [x] ported to the TypeScript SDK |
| 5 | Agent loop + confirmation step + tool trace, tested locally against all four scenarios | 2 days | [x] 48 tests pass with a mocked LLM; live run against Azure done, traces in `docs/traces/` |
| 6 | Cloud: deploy the managed DB and MCP server, redeploy the API, point the agent at the gateway URL | 1 day | [x] all deployed in Sweden Central and seeded; 24 gateway tests pass against Azure; agent run against the cloud |
| 7 | README, ER diagram, screenshots/logs, demo video | 1 day | [~] README, ER diagram, logs and test data done; test screenshot and demo video still to do |

About two weeks of steady work. Phase 2b deliberately comes early, because cloud and gateway setup is where surprises usually show up and redeploying later is cheap.

### Seed data (for the demo scenarios)

| Subscriber | Period | Usage | Bill | Paid | Demo use |
|---|---|---|---|---|---|
| 5551001 | Sep 2026 | 800 min, 18,000 MB | $50 | $50 (PAID) | baseline month |
| 5551001 | Oct 2026 | 1,350 min, 35,000 MB | $80 | $0 (UNPAID) | "Why is my October bill higher?", "Pay my bill"; matches the guide's §4.3 example |
| 5551002 | Sep 2026 | 2,010 min, 30,001 MB | $90 | $40 (PARTIAL) | partial payment |
| 5551002 | Oct 2026 | 600 min, 0 MB | $50 | $0 (UNPAID) | the zero-internet case |

Logins (test values only, also in `billing-api/scripts/seed.ts`): `admin`, `sub5551001`, `sub5551002`.

---

## 11. Repo layout

```
billing-api/       NestJS app: src/ (api, auth, billing, pricing, database), scripts/, test/
mcp-server/        src/indexer.ts, src/server.ts, data/Mobile_Provider_Billing_Guide.md, test/
agent/             agent, tools, confirmation, trace logging, tests (mock LLM)
gateway/           kong.yml.tmpl (Kong DB-less), Dockerfile, render-config.sh, integration tests
deploy/            azure.ps1 (Azure deployment, rerunnable steps)
docs/              PLAN.md, billing guide, ER diagram, openapi.yaml, screenshots, tool traces
docker-compose.yml
README.md
```

---

## 12. README checklist (all of it goes in the README, nothing in Moodle)

- [x] Architecture diagram, stack, and the API style chosen
- [x] Gateway URL, route mappings, a protected route example, an error response example
- [x] Swagger link + `openapi.yaml`
- [x] ER diagram
- [x] MCP tool schema and how the indexing works
- [x] Cloud URLs and deployment steps
- [~] How to run the tests + evidence of the output (pasted summary done; screenshot still to add)
- [x] Test data, credentials and steps for the instructor to reproduce results
- [x] Three agent scenarios with tool traces (MCP-only, API-only, combined)
- [x] Three MCP retrieval tests (regenerated against the cloud MCP server)
- [x] Protected gateway route demo (cloud 401 without a token, 200 with one, 403 for another subscriber)
- [x] Confirmed simulated payment
- [x] Assumptions: rounding, the $0-usage case, recalculation, error codes, identity, deployment choices, LLM cost
- [ ] Link to the demo video

---

## 13. Grading reference

| Area | Points |
|---|---|
| REST APIs and business logic | 25 |
| AI Agent / LLM tool calling | 20 |
| MCP server and indexing | 20 |
| API Gateway | 10 |
| Database and authentication | 10 |
| Cloud deployment | 5 |
| Testing and documentation | 10 |
| **Total** | **100** |
