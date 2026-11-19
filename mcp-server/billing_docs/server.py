"""MCP server exposing search_billing_documentation(query) over the indexed billing guide.

Run locally for an agent that spawns it (stdio):
    python -m billing_docs.server
Run as a network service (Streamable HTTP at /mcp, health check at /health):
    python -m billing_docs.server --transport http --host 0.0.0.0 --port 8001

The guide is indexed once, before the server starts accepting requests.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from mcp.server.mcpserver import MCPServer

from billing_docs.indexer import DEFAULT_GUIDE, BillingIndex

# stdout carries the MCP protocol in stdio mode, so logs must go to stderr.
logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("billing_docs")

TOOL_NAME = "search_billing_documentation"


class DocumentationMatch(BaseModel):
    section: str = Field(description="Section ID in the guide, e.g. '3.2'.", examples=["3.2"])
    heading: str = Field(examples=["Additional internet blocks"])
    parent_heading: str | None = Field(description="Enclosing section heading, if any.", examples=["Internet pricing"])
    reference: str = Field(description="Citation to show users, e.g. '§3.2 Additional internet blocks'.")
    text: str = Field(description="The section text.")
    score: float = Field(description="BM25 relevance score; higher is more relevant.")


class DocumentationSearchResult(BaseModel):
    document: str = Field(examples=["Mobile_Provider_Billing_Guide.md"])
    document_id: str | None = Field(examples=["MOB-BILLING-2026-01"])
    query: str
    matches: list[DocumentationMatch] = Field(description="Best matches first. Empty if nothing relevant was found.")


INSTRUCTIONS = (
    "Searches the Mobile Provider Billing Guide, the policy document for billing rules: "
    "allowances, phone and internet pricing, bill calculation, payments, due dates, late payments and disputes. "
    "It holds no subscriber data; use the Billing REST API for actual bills, usage and payments. "
    "Cite results by their section reference (for example §3.2)."
)


def build_server(index: BillingIndex) -> MCPServer:
    server = MCPServer("billing-docs", title="Mobile Provider Billing Guide", instructions=INSTRUCTIONS, version="1.0.0")

    @server.tool(name=TOOL_NAME, title="Search billing documentation")
    def search_billing_documentation(
        query: Annotated[str, Field(min_length=1, max_length=500, description="What to look up, in plain words.")],
        max_results: Annotated[int, Field(ge=1, le=5, description="How many sections to return.")] = 3,
    ) -> DocumentationSearchResult:
        """Search the billing policy guide and return the most relevant sections with their section references.

        Use it for policy and pricing questions (e.g. "extra internet price", "partial payment rules",
        "late payment penalty"). It does not know any subscriber's usage, bill or balance.
        """
        hits = index.search(query, max_results)
        log.info("search query=%r -> %s", query, [h.chunk.section for h in hits])
        return DocumentationSearchResult(
            document=index.document,
            document_id=index.document_id,
            query=query,
            matches=[
                DocumentationMatch(
                    section=h.chunk.section,
                    heading=h.chunk.heading,
                    parent_heading=h.chunk.parent_heading,
                    reference=h.chunk.reference,
                    text=h.chunk.text,
                    score=round(h.score, 3),
                )
                for h in hits
            ],
        )

    @server.custom_route("/health", methods=["GET"], include_in_schema=False)
    async def health(_: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "document_id": index.document_id, "chunks": len(index.chunks)})

    return server


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Billing documentation MCP server")
    parser.add_argument("--transport", choices=["stdio", "http"], default=os.environ.get("MCP_TRANSPORT", "stdio"))
    parser.add_argument("--host", default=os.environ.get("MCP_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MCP_PORT", "8001")))
    parser.add_argument("--guide", type=Path, default=Path(os.environ.get("BILLING_GUIDE_PATH", DEFAULT_GUIDE)))
    args = parser.parse_args(argv)

    index = BillingIndex.from_file(args.guide)  # the one and only indexing pass
    log.info("indexed %s (%s): %d chunks in %.1f ms", index.document, index.document_id, len(index.chunks), index.build_ms)
    server = build_server(index)

    if args.transport == "stdio":
        server.run("stdio")
    else:
        log.info("serving Streamable HTTP on http://%s:%d/mcp", args.host, args.port)
        server.run("streamable-http", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
