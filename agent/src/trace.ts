/**
 * Tool trace for every turn: the user message, each tool call (name, input, result), the final
 * answer and token usage. Printed to the console as it happens and saved as one JSON file per
 * session. The JWT is never recorded.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ToolCallTrace {
  id: string;
  name: string;
  input: unknown;
  result: unknown;
  is_error: boolean;
  duration_ms: number;
}

export interface TurnTrace {
  turn: number;
  started_at: string;
  user_message: string;
  llm_requests: number;
  tool_calls: ToolCallTrace[];
  final_answer: string;
  stop_reason: string | null;
  usage: Usage;
  estimated_cost_usd: number | null;
  error?: string;
}

/** USD per million tokens [input, output]; cache writes cost 1.25x input, cache reads 0.1x. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

export function estimateCost(model: string, u: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const [input, output] = price;
  const dollars =
    (u.input_tokens * input +
      u.cache_creation_input_tokens * input * 1.25 +
      u.cache_read_input_tokens * input * 0.1 +
      u.output_tokens * output) /
    1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

const short = (value: unknown, max = 160): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export class TraceLog {
  readonly path: string | undefined;
  private readonly turns: TurnTrace[] = [];
  private readonly meta: { session_started_at: string; username: string; subscriber_no: string; model: string };
  private readonly print: (line: string) => void;

  constructor(opts: {
    dir?: string;
    username: string;
    subscriberNo: string;
    model: string;
    print?: (line: string) => void;
    now?: Date;
  }) {
    const now = opts.now ?? new Date();
    this.meta = {
      session_started_at: now.toISOString(),
      username: opts.username,
      subscriber_no: opts.subscriberNo,
      model: opts.model,
    };
    this.print = opts.print ?? ((line) => process.stderr.write(`${line}\n`));
    if (opts.dir) {
      mkdirSync(opts.dir, { recursive: true });
      const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      this.path = join(opts.dir, `session-${stamp}.json`);
    }
  }

  startTurn(userMessage: string): TurnTrace {
    const turn: TurnTrace = {
      turn: this.turns.length + 1,
      started_at: new Date().toISOString(),
      user_message: userMessage,
      llm_requests: 0,
      tool_calls: [],
      final_answer: "",
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      estimated_cost_usd: null,
    };
    this.turns.push(turn);
    return turn;
  }

  toolCall(turn: TurnTrace, call: ToolCallTrace): void {
    turn.tool_calls.push(call);
    const status = call.is_error ? "ERROR" : "ok";
    this.print(`[trace] tool ${call.name} ${short(call.input)} -> ${status} (${call.duration_ms} ms) ${short(call.result)}`);
  }

  endTurn(turn: TurnTrace): void {
    turn.estimated_cost_usd = estimateCost(this.meta.model, turn.usage);
    const u = turn.usage;
    const cost = turn.estimated_cost_usd === null ? "" : `, ~$${turn.estimated_cost_usd.toFixed(4)}`;
    this.print(
      `[trace] turn ${turn.turn}: ${turn.tool_calls.length} tool call(s), ${turn.llm_requests} LLM request(s), ` +
        `stop=${turn.stop_reason}, tokens in=${u.input_tokens} cache_read=${u.cache_read_input_tokens} ` +
        `cache_write=${u.cache_creation_input_tokens} out=${u.output_tokens}${cost}`,
    );
    this.save();
  }

  toJSON() {
    return { ...this.meta, turns: this.turns };
  }

  private save(): void {
    if (this.path) writeFileSync(this.path, `${JSON.stringify(this.toJSON(), null, 2)}\n`, "utf8");
  }
}
