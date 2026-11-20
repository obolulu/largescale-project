/**
 * Billing documentation MCP server.
 *
 * Run locally for an agent that spawns it (stdio):
 *     node dist/main.js
 * Run as a network service (Streamable HTTP at /mcp, health check at /health):
 *     node dist/main.js --transport http --host 0.0.0.0 --port 8001
 *
 * The guide is indexed once, before the server starts accepting requests.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";

import { BillingIndex, DEFAULT_GUIDE } from "./indexer.ts";
import { getLogger } from "./log.ts";
import { createServer } from "./server.ts";

const log = getLogger("billing_docs");

const USAGE = "usage: billing-docs [-h] [--transport {stdio,http}] [--host HOST] [--port PORT] [--guide GUIDE]";

export interface Options {
  transport: "stdio" | "http";
  host: string;
  port: number;
  guide: string;
}

function fail(message: string): never {
  process.stderr.write(`${USAGE}\nbilling-docs: error: ${message}\n`);
  process.exit(2);
}

export function parseOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      transport: { type: "string", default: env.MCP_TRANSPORT ?? "stdio" },
      host: { type: "string", default: env.MCP_HOST ?? "127.0.0.1" },
      port: { type: "string", default: env.MCP_PORT ?? "8001" },
      guide: { type: "string", default: env.BILLING_GUIDE_PATH ?? DEFAULT_GUIDE },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n\nBilling documentation MCP server\n`);
    process.exit(0);
  }
  if (values.transport !== "stdio" && values.transport !== "http") {
    fail(`argument --transport: invalid choice: '${values.transport}' (choose from stdio, http)`);
  }
  if (!/^[+-]?\d+$/.test(values.port.trim())) fail(`argument --port: invalid int value: '${values.port}'`);
  return { transport: values.transport, host: values.host, port: Number(values.port), guide: values.guide };
}

/** Stateful Streamable HTTP at /mcp (one transport per session) plus GET /health. */
export function createHttpApp(index: BillingIndex, host: string): express.Express {
  const app = express();
  // DNS rebinding protection, as the SDK's createMcpExpressApp does for localhost binds.
  if (["127.0.0.1", "localhost", "::1"].includes(host)) app.use(localhostHostValidation());
  app.use(express.json());

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId) {
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null });
        return;
      }
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void transports.set(id, created),
      });
      created.onclose = () => {
        if (created.sessionId) transports.delete(created.sessionId);
      };
      await createServer(index).connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(sessionId ? 404 : 400).json({
        jsonrpc: "2.0",
        error: { code: sessionId ? -32001 : -32000, message: sessionId ? "Session not found" : "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", sessionRequest);
  app.delete("/mcp", sessionRequest);

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", document_id: index.documentId, chunks: index.chunks.length });
  });

  return app;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);

  const index = BillingIndex.fromFile(options.guide); // the one and only indexing pass
  log.info(`indexed ${index.document} (${index.documentId ?? "None"}): ${index.chunks.length} chunks in ${index.buildMs.toFixed(1)} ms`);

  if (options.transport === "stdio") {
    await createServer(index).connect(new StdioServerTransport());
    return;
  }

  log.info(`serving Streamable HTTP on http://${options.host}:${options.port}/mcp`);
  const app = createHttpApp(index, options.host);
  const listener = app.listen(options.port, options.host, (error?: Error) => {
    if (error) {
      log.error(String(error));
      process.exit(1);
    }
  });
  const shutdown = () => listener.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error: unknown) => {
    log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
