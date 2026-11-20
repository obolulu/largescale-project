/** MCP client for the billing documentation server (search_billing_documentation). */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const DOCS_TOOL = "search_billing_documentation";

export interface DocsSearch {
  search(query: string, maxResults: number): Promise<unknown>;
}

export class McpDocsClient implements DocsSearch {
  private readonly client: Client;

  private constructor(client: Client) {
    this.client = client;
  }

  /** Connect over Streamable HTTP when `url` is set, otherwise spawn the server script over stdio. */
  static async connect(opts: { url?: string; script: string }): Promise<McpDocsClient> {
    const transport: Transport = opts.url
      ? new StreamableHTTPClientTransport(new URL(opts.url))
      : new StdioClientTransport({ command: process.execPath, args: [opts.script], stderr: "ignore" });
    const client = new Client({ name: "billing-agent", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    if (!tools.some((t) => t.name === DOCS_TOOL)) {
      await client.close();
      throw new Error(`MCP server does not offer ${DOCS_TOOL}`);
    }
    return new McpDocsClient(client);
  }

  async search(query: string, maxResults: number): Promise<unknown> {
    const result = await this.client.callTool({ name: DOCS_TOOL, arguments: { query, max_results: maxResults } });
    const content = Array.isArray(result.content) ? (result.content as { type: string; text?: string }[]) : [];
    const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
    if (result.isError) throw new Error(text || "documentation search failed");
    return result.structuredContent ?? JSON.parse(text);
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
