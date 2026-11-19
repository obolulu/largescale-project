"""Exercise the real MCP protocol in-process with the SDK client."""

import pytest
from mcp import Client

from billing_docs import indexer
from billing_docs.indexer import BillingIndex
from billing_docs.server import TOOL_NAME, build_server


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(scope="module")
def server():
    return build_server(BillingIndex.from_file())


@pytest.mark.anyio
async def test_tool_is_listed_with_schema(server):
    async with Client(server) as client:
        tools = (await client.list_tools()).tools
    assert [t.name for t in tools] == [TOOL_NAME]
    tool = tools[0]
    assert tool.input_schema["required"] == ["query"]
    assert set(tool.input_schema["properties"]) == {"query", "max_results"}
    assert "matches" in tool.output_schema["properties"]


@pytest.mark.anyio
async def test_search_returns_guide_shaped_result(server):
    async with Client(server) as client:
        result = await client.call_tool(TOOL_NAME, {"query": "extra internet price"})
    assert not result.is_error
    data = result.structured_content
    assert data["document"] == "Mobile_Provider_Billing_Guide.md"
    assert data["document_id"] == "MOB-BILLING-2026-01"
    assert len(data["matches"]) == 3
    first = data["matches"][0]
    assert set(first) == {"section", "heading", "parent_heading", "reference", "text", "score"}
    assert "3.2" in [m["section"] for m in data["matches"]]
    # Clients without structured output support get the same data as JSON text.
    assert '"document_id": "MOB-BILLING-2026-01"' in result.content[0].text


@pytest.mark.anyio
async def test_max_results_argument(server):
    async with Client(server) as client:
        result = await client.call_tool(TOOL_NAME, {"query": "payment", "max_results": 1})
    assert len(result.structured_content["matches"]) == 1


@pytest.mark.anyio
async def test_no_match_returns_empty_list(server):
    async with Client(server) as client:
        result = await client.call_tool(TOOL_NAME, {"query": "pizza recipe"})
    assert not result.is_error
    assert result.structured_content["matches"] == []


@pytest.mark.anyio
@pytest.mark.parametrize("arguments", [{}, {"query": ""}, {"query": "fees", "max_results": 50}])
async def test_invalid_arguments_are_tool_errors(server, arguments):
    async with Client(server) as client:
        result = await client.call_tool(TOOL_NAME, arguments)
    assert result.is_error


@pytest.mark.anyio
async def test_index_is_built_once_not_per_query(monkeypatch):
    builds = []
    original = indexer.BillingIndex._build
    monkeypatch.setattr(indexer.BillingIndex, "_build", lambda self: (builds.append(1), original(self)))
    server = build_server(indexer.BillingIndex.from_file())
    async with Client(server) as client:
        for q in ("extra internet price", "partial payment rules", "late payment penalty"):
            await client.call_tool(TOOL_NAME, {"query": q})
    assert len(builds) == 1
