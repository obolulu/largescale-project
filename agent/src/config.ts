/** Runtime settings, read from environment variables (and an optional .env file). */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface AgentConfig {
  /** Billing REST API origin. In the cloud this is the API gateway, never the backend directly. */
  apiBaseUrl: string;
  /** Streamable HTTP endpoint of the docs MCP server. Unset: spawn it locally over stdio. */
  mcpServerUrl: string | undefined;
  /** Script for the stdio MCP server, used when mcpServerUrl is unset. */
  mcpServerScript: string;
  model: string;
  effort: Effort;
  maxTokens: number;
  /** Where per-session tool traces (JSON) are written. */
  traceDir: string;
}

const here = dirname(fileURLToPath(import.meta.url));
/** agent/, whether this runs from src/ or dist/. */
export const PACKAGE_ROOT = resolve(here, "..");

export function loadEnvFiles(): void {
  // Values already in the environment win; between the files, the first one found wins.
  for (const file of [resolve(PACKAGE_ROOT, ".env"), resolve(PACKAGE_ROOT, "..", ".env")]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const effort = (env.AGENT_EFFORT ?? "low") as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`AGENT_EFFORT must be one of ${EFFORTS.join(", ")}, got "${effort}"`);
  const maxTokens = Number(env.AGENT_MAX_TOKENS ?? 16000);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("AGENT_MAX_TOKENS must be a positive integer");
  return {
    apiBaseUrl: (env.BILLING_API_URL ?? "http://localhost:8080").replace(/\/+$/, ""),
    mcpServerUrl: env.MCP_SERVER_URL || undefined,
    mcpServerScript: env.MCP_SERVER_SCRIPT ?? resolve(PACKAGE_ROOT, "..", "mcp-server", "dist", "main.js"),
    model: env.AGENT_MODEL ?? "claude-opus-5-5",
    effort,
    maxTokens,
    traceDir: env.AGENT_TRACE_DIR ?? resolve(PACKAGE_ROOT, "traces"),
  };
}
