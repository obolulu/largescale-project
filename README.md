# AI Billing Support Assistant (SE4458 Midterm)

Work in progress. The full plan and requirement checklist are in [docs/PLAN.md](docs/PLAN.md). The policy document is [docs/Mobile_Provider_Billing_Guide.md](docs/Mobile_Provider_Billing_Guide.md).

## Layout

| Folder | Contents | Status |
|---|---|---|
| `billing-api/` | FastAPI service, SQLAlchemy models, Alembic migrations, seed script, tests | schema, pricing, seed done; endpoints next |
| `mcp-server/` | MCP server over `data/Mobile_Provider_Billing_Guide.md` | not started |
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

## Assumptions so far

- Pricing follows guide §4.2 exactly, using integer MB arithmetic (1 GB = 1,000 MB). The $50 internet base is charged even with zero usage (§3.1). There are no taxes or fees (§4.2).
- The brief's sample "Apr 2025 → $75" can't come from these rules (totals move in $10 steps from $50), so it's treated as an illustration of the response shape only.
- Add Usage records one 10-minute or 1 MB event per call. The seed script inserts batched usage rows (50 min / 500 MB) so demo months stay small. Bill totals are the same either way.
- Seed logins are test-only credentials and are listed in `billing-api/scripts/seed.py`.
