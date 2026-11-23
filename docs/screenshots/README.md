# Screenshots

Images linked from the main [README](../../README.md).

| File | Shows | README section |
|---|---|---|
| `01-unit-tests.png` | `npm test` in `billing-api`, `mcp-server` and `agent`, with the pass counts | Run the unit tests |
| `02-protected-route.png` | `GET /api/v1/bills/detailed` through the cloud gateway without a token: 401 from Kong | API gateway (Kong) |
| `02-protected-route-b.png` | The same request with a Bearer token from Login: 200 | API gateway (Kong) |
| `03-mcp-retrieval-tests.png` | `npm run demo -- --url https://billing-mcp…/mcp`, all three queries and their top sections | MCP server |
| `04-agent-mcp-only.png` | Fresh agent session: "How much does extra internet cost?" answered from one `search_billing_documentation` call, with § citations | Live runs, scenario 1 |
| `05-agent-combined.png` | Fresh agent session: "Why is my October bill higher?" with `query_bill_detailed` (Oct, Sep) and `search_billing_documentation` in one turn | Live runs, scenario 3 |
| `06-agent-payment.png` | Agent session: a `query_bill_detailed` question, then a confirmed $20.00 partial payment (`yes` prompt, `pay_bill` SUCCESS, bill PARTIAL) | Live runs, scenario 4 |
| `09-swagger-ui.png` | Swagger UI at `https://billing-gateway…/docs` | Cloud deployment |
| `10-azure-resources.png` | Azure portal, resource group `rg-billing-se4458` | Cloud deployment |
