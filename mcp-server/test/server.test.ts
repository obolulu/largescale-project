/** Exercise the real MCP protocol in-process with the SDK client. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BillingIndex } from "../src/indexer.ts";
import { TOOL_NAME, createServer } from "../src/server.ts";

type TextContent = { type: "text"; text: string };
type Data = { document: string; document_id: string | null; matches: Record<string, unknown>[] };

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const index = BillingIndex.fromFile();
let client: Client | undefined;

async function call(args: Record<string, unknown>) {
  client = await connect(createServer(index));
  return client.callTool({ name: TOOL_NAME, arguments: args });
}

afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.restoreAllMocks();
});

describe("MCP server", () => {
  it("lists the tool with its schemas", async () => {
    client = await connect(createServer(index));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([TOOL_NAME]);
    const tool = tools[0]!;
    expect(tool.inputSchema.required).toEqual(["query"]);
    expect(new Set(Object.keys(tool.inputSchema.properties ?? {}))).toEqual(new Set(["query", "max_results"]));
    expect(tool.outputSchema?.properties).toHaveProperty("matches");
  });

  it("returns a guide-shaped result", async () => {
    const result = await call({ query: "extra internet price" });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Data;
    expect(data.document).toBe("Mobile_Provider_Billing_Guide.md");
    expect(data.document_id).toBe("MOB-BILLING-2026-01");
    expect(data.matches).toHaveLength(3);
    expect(new Set(Object.keys(data.matches[0]!))).toEqual(
      new Set(["section", "heading", "parent_heading", "reference", "text", "score"]),
    );
    expect(data.matches.map((m) => m.section)).toContain("3.2");
    // Clients without structured output support get the same data as JSON text.
    expect((result.content as TextContent[])[0]!.text).toContain('"document_id": "MOB-BILLING-2026-01"');
  });

  it("honours the max_results argument", async () => {
    const result = await call({ query: "payment", max_results: 1 });
    expect((result.structuredContent as Data).matches).toHaveLength(1);
  });

  it("returns an empty list when nothing matches", async () => {
    const result = await call({ query: "pizza recipe" });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Data).matches).toEqual([]);
  });

  it.each([{}, { query: "" }, { query: "fees", max_results: 50 }])(
    "reports invalid arguments %j as a tool error",
    async (args: Record<string, unknown>) => {
      const result = await call(args);
      expect(result.isError).toBe(true);
    },
  );

  it("builds the index once, not per query", async () => {
    const build = vi.spyOn(BillingIndex.prototype, "_build");
    client = await connect(createServer(BillingIndex.fromFile()));
    for (const query of ["extra internet price", "partial payment rules", "late payment penalty"]) {
      await client.callTool({ name: TOOL_NAME, arguments: { query } });
    }
    expect(build).toHaveBeenCalledTimes(1);
  });
});
