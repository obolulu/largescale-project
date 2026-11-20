/** MCP server exposing search_billing_documentation(query) over the indexed billing guide. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { type BillingIndex, pyRound } from "./indexer.ts";
import { getLogger, pyListRepr, pyRepr } from "./log.ts";

const log = getLogger("billing_docs");

export const TOOL_NAME = "search_billing_documentation";

export const INSTRUCTIONS =
  "Searches the Mobile Provider Billing Guide, the policy document for billing rules: " +
  "allowances, phone and internet pricing, bill calculation, payments, due dates, late payments and disputes. " +
  "It holds no subscriber data; use the Billing REST API for actual bills, usage and payments. " +
  "Cite results by their section reference (for example §3.2).";

const TOOL_DESCRIPTION = `Search the billing policy guide and return the most relevant sections with their section references.

Use it for policy and pricing questions (e.g. "extra internet price", "partial payment rules",
"late payment penalty"). It does not know any subscriber's usage, bill or balance.`;

const inputSchema = {
  query: z.string().min(1).max(500).describe("What to look up, in plain words."),
  max_results: z.number().int().min(1).max(5).default(3).describe("How many sections to return."),
};

export const DocumentationMatch = z.object({
  section: z.string().describe("Section ID in the guide, e.g. '3.2'."),
  heading: z.string(),
  parent_heading: z.string().nullable().describe("Enclosing section heading, if any."),
  reference: z.string().describe("Citation to show users, e.g. '§3.2 Additional internet blocks'."),
  text: z.string().describe("The section text."),
  score: z.number().describe("BM25 relevance score; higher is more relevant."),
});

const outputSchema = {
  document: z.string(),
  document_id: z.string().nullable(),
  query: z.string(),
  matches: z.array(DocumentationMatch).describe("Best matches first. Empty if nothing relevant was found."),
};

export const DocumentationSearchResult = z.object(outputSchema);
export type DocumentationSearchResult = z.infer<typeof DocumentationSearchResult>;

export function search(index: BillingIndex, query: string, maxResults = 3): DocumentationSearchResult {
  const hits = index.search(query, maxResults);
  log.info(`search query=${pyRepr(query)} -> ${pyListRepr(hits.map((h) => h.chunk.section))}`);
  return {
    document: index.document,
    document_id: index.documentId,
    query,
    matches: hits.map(({ chunk, score }) => ({
      section: chunk.section,
      heading: chunk.heading,
      parent_heading: chunk.parentHeading,
      reference: chunk.reference,
      text: chunk.text,
      score: pyRound(score, 3),
    })),
  };
}

/**
 * Build the MCP server around a prebuilt index. Invalid arguments come back as
 * `isError: true` tool results: SDK 1.32's McpServer catches its own input
 * validation errors and wraps them, so no extra handling is needed here.
 */
export function createServer(index: BillingIndex): McpServer {
  const server = new McpServer(
    { name: "billing-docs", title: "Mobile Provider Billing Guide", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    TOOL_NAME,
    { title: "Search billing documentation", description: TOOL_DESCRIPTION, inputSchema, outputSchema },
    async ({ query, max_results }) => {
      const result = search(index, query, max_results);
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  return server;
}
