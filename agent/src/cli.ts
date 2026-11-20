/**
 * Command-line chat with the billing support agent.
 *
 *   npm start                                   # asks for username and password, then chats
 *   npm start -- -u sub5551001                  # password from BILLING_PASSWORD or a hidden prompt
 *   npm start -- -u sub5551001 -m "Pay my bill" # one question, then exit (confirmation still asked)
 *
 * Needs ANTHROPIC_API_KEY (or an `ant auth login` profile), the Billing API at BILLING_API_URL
 * (the gateway in the cloud) and either MCP_SERVER_URL or a built mcp-server to spawn.
 */
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import Anthropic from "@anthropic-ai/sdk";

import { anthropicLlm, BillingAgent } from "./agent.ts";
import { BillingApiClient, BillingApiError } from "./billing-client.ts";
import { getConfig, loadEnvFiles } from "./config.ts";
import { McpDocsClient } from "./docs-client.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { ToolExecutor } from "./tools.ts";
import { TraceLog } from "./trace.ts";

/** Line-based console I/O that works for a terminal and for piped input, with a hidden mode for passwords. */
class Console {
  private muted = false;
  private readonly lines: string[] = [];
  private waiting: ((line: string | null) => void) | undefined;
  private closed = false;
  private readonly rl;

  constructor() {
    const output = new Writable({
      write: (chunk, encoding, done) => {
        if (!this.muted) process.stdout.write(chunk, encoding);
        done();
      },
    });
    this.rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
    this.rl.on("line", (line) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.waiting?.(null);
    });
  }

  /** Print `prompt` and read one line. Null when input has ended. */
  ask(prompt: string, opts: { hidden?: boolean } = {}): Promise<string | null> {
    process.stdout.write(prompt);
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    this.muted = Boolean(opts.hidden) && Boolean(process.stdin.isTTY);
    return new Promise((resolve) => {
      this.waiting = (line) => {
        if (this.muted) process.stdout.write("\n");
        this.muted = false;
        resolve(line);
      };
    });
  }

  close(): void {
    this.rl.close();
  }
}

const isYes = (answer: string | null): boolean => /^\s*(y|yes)\s*$/i.test(answer ?? "");

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      username: { type: "string", short: "u" },
      message: { type: "string", short: "m" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write("usage: billing-agent [-u USERNAME] [-m MESSAGE]\n");
    return 0;
  }

  loadEnvFiles();
  const config = getConfig();
  const io = new Console();
  let docs: McpDocsClient | undefined;
  try {
    const username = values.username ?? (await io.ask("Username: "));
    const password = process.env.BILLING_PASSWORD ?? (await io.ask("Password: ", { hidden: true }));
    if (!username || !password) {
      process.stderr.write("A username and password are needed.\n");
      return 2;
    }

    const billing = new BillingApiClient(config.apiBaseUrl);
    const session = await billing.login(username, password);
    if (session.role !== "SUBSCRIBER" || !session.subscriberNo) {
      process.stderr.write("This assistant is for subscribers. Log in with a subscriber account.\n");
      return 2;
    }

    docs = await McpDocsClient.connect({ url: config.mcpServerUrl, script: config.mcpServerScript });
    const trace = new TraceLog({
      dir: config.traceDir,
      username,
      subscriberNo: session.subscriberNo,
      model: config.model,
    });
    const tools = new ToolExecutor({
      billing,
      docs,
      session,
      confirm: async (question) => isYes(await io.ask(`\n${question} `)),
    });
    const agent = new BillingAgent({
      llm: anthropicLlm(new Anthropic()),
      tools,
      trace,
      config,
      system: buildSystemPrompt({
        subscriberNo: session.subscriberNo,
        username,
        today: new Date().toISOString().slice(0, 10),
      }),
    });

    process.stdout.write(
      `Logged in as ${username} (subscriber ${session.subscriberNo}). Model ${config.model}, trace ${trace.path}\n`,
    );

    /** False if the LLM request failed (the turn is rolled back and the chat can go on). */
    const answer = async (text: string): Promise<boolean> => {
      try {
        process.stdout.write(`\nAssistant: ${await agent.chat(text)}\n\n`);
        return true;
      } catch (err) {
        process.stderr.write(`LLM request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return false;
      }
    };

    if (values.message) return (await answer(values.message)) ? 0 : 1;
    process.stdout.write('Ask about your bills, usage, payments or billing rules. Type "exit" to quit.\n\n');
    for (;;) {
      const line = await io.ask("You: ");
      if (line === null || /^\s*(exit|quit)\s*$/i.test(line)) return 0;
      if (line.trim()) await answer(line.trim());
    }
  } catch (err) {
    if (err instanceof BillingApiError && err.status === 401) process.stderr.write("Login failed: wrong username or password.\n");
    else process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    io.close();
    await docs?.close();
  }
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = await main();
