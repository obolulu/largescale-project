/** Streamable HTTP transport, /health and DNS-rebinding protection, over a real socket. */

import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingIndex } from "../src/indexer.ts";
import { createHttpApp } from "../src/main.ts";
import { TOOL_NAME } from "../src/server.ts";

let listener: Server;
let base: string;

beforeAll(async () => {
  const app = createHttpApp(BillingIndex.fromFile(), "127.0.0.1");
  listener = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => listener.close(() => resolve())));

describe("HTTP mode", () => {
  it("serves /health", async () => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toEqual({ status: "ok", document_id: "MOB-BILLING-2026-01", chunks: 25 });
  });

  it("answers tool calls over a Streamable HTTP session", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    expect(transport.sessionId).toBeTruthy();
    const result = await client.callTool({ name: TOOL_NAME, arguments: { query: "late payment penalty" } });
    expect((result.structuredContent as { matches: { section: string }[] }).matches[0]!.section).toBe("6.2");
    await transport.terminateSession();
    await client.close();
  });

  it("rejects a request without a session", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a foreign Host header on a localhost bind", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/health`, { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});
