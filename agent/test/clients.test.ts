/** The real HTTP client against a local stub server, and the real MCP client against the built mcp-server. */
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingApiClient, BillingApiError } from "../src/billing-client.ts";
import { getConfig } from "../src/config.ts";
import { McpDocsClient } from "../src/docs-client.ts";
import { SESSION } from "./fakes.ts";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

describe("BillingApiClient", () => {
  let server: Server;
  let client: BillingApiClient;
  const seen: Seen[] = [];
  const replies: [number, string][] = [];

  const readBody = async (req: IncomingMessage) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : undefined;
  };

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: await readBody(req) });
      const [status, body] = replies.shift() ?? [200, "{}"];
      res.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    client = new BillingApiClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`.replace(/\/$/, ""));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("login posts the credentials and returns the session", async () => {
    replies.push([200, JSON.stringify({ access_token: "jwt", token_type: "bearer", expires_in: 3600, role: "SUBSCRIBER", subscriber_no: "5551001" })]);
    const session = await client.login("sub5551001", "pw");
    expect(session).toEqual({ username: "sub5551001", role: "SUBSCRIBER", subscriberNo: "5551001", token: "jwt" });
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/api/v1/auth/login", body: { username: "sub5551001", password: "pw" } });
  });

  it("Query Bill is sent without a token", async () => {
    await client.queryBill("5551001", 2026, 10);
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/api/v1/bills?subscriber_no=5551001&year=2026&month=10", auth: undefined });
  });

  it("Query Bill Detailed sends the token and no subscriber number", async () => {
    await client.queryBillDetailed(SESSION, 2026, 10, 2, 20);
    expect(seen.at(-1)).toMatchObject({ url: "/api/v1/bills/detailed?year=2026&month=10&page=2&page_size=20", auth: `Bearer ${SESSION.token}` });
  });

  it("Pay Bill posts the amount and transaction ID with the token", async () => {
    await client.payBill(SESSION, 2026, 10, 29.5, "txn-1");
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/v1/payments",
      auth: `Bearer ${SESSION.token}`,
      body: { year: 2026, month: 10, amount: 29.5, transaction_id: "txn-1" },
    });
  });

  it("an error answer becomes a BillingApiError with the API's error code", async () => {
    replies.push([409, JSON.stringify({ error: { code: "DUPLICATE_TRANSACTION", message: "Transaction txn-1 was already processed." } })]);
    const err = await client.payBill(SESSION, 2026, 10, 1, "txn-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingApiError);
    expect((err as BillingApiError).status).toBe(409);
    expect((err as BillingApiError).code).toBe("DUPLICATE_TRANSACTION");
  });

  it("a non-JSON error page is kept as text", async () => {
    replies.push([502, "<html>Bad Gateway</html>"]);
    const err = (await client.queryBill("5551001", 2026, 10).catch((e: unknown) => e)) as BillingApiError;
    expect(err.status).toBe(502);
    expect(err.body).toBe("<html>Bad Gateway</html>");
    expect(err.code).toBeUndefined();
  });
});

const script = getConfig({}).mcpServerScript;

describe.skipIf(!existsSync(script))("McpDocsClient over stdio (needs `npm run build` in mcp-server)", () => {
  let docs: McpDocsClient;
  beforeAll(async () => {
    docs = await McpDocsClient.connect({ script });
  });
  afterAll(() => docs?.close());

  it("searches the real billing guide", async () => {
    const result = (await docs.search("extra internet price", 2)) as { document_id: string; matches: { section: string }[] };
    expect(result.document_id).toBe("MOB-BILLING-2026-01");
    expect(result.matches.map((m) => m.section)).toEqual(["8.1", "3.2"]);
  });

  it("passes on the server's input validation errors", async () => {
    await expect(docs.search("", 3)).rejects.toThrow();
  });
});
