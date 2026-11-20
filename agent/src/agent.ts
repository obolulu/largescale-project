/**
 * The agent loop: user message -> Claude -> tool calls -> the agent runs them -> results go back
 * to Claude -> final answer. Claude only chooses tools; this code runs every call.
 *
 * The conversation history is append-only (each response's content is sent back unchanged,
 * thinking and fallback blocks included), which keeps thinking blocks valid and the prompt cache warm.
 */
import type Anthropic from "@anthropic-ai/sdk";

import type { AgentConfig } from "./config.ts";
import { TOOLS, type ToolExecutor } from "./tools.ts";
import type { TraceLog, TurnTrace } from "./trace.ts";

export type MessageParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type Message = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;
type UserContent = Anthropic.Beta.Messages.BetaContentBlockParam[];

/** The one LLM call the agent makes. Tests pass a scripted fake. */
export interface LlmClient {
  create(params: MessageParams): Promise<Message>;
}

export function anthropicLlm(client: Anthropic): LlmClient {
  return { create: (params) => client.beta.messages.create(params) };
}

/** Upper bound on LLM requests per user message, so a confused model can't loop forever. */
export const MAX_STEPS = 10;

export class BillingAgent {
  private readonly messages: MessageParam[] = [];
  private readonly llm: LlmClient;
  private readonly tools: ToolExecutor;
  private readonly trace: TraceLog;
  private readonly config: Pick<AgentConfig, "model" | "effort" | "maxTokens">;
  private readonly system: string;

  constructor(opts: {
    llm: LlmClient;
    tools: ToolExecutor;
    trace: TraceLog;
    config: Pick<AgentConfig, "model" | "effort" | "maxTokens">;
    system: string;
  }) {
    this.llm = opts.llm;
    this.tools = opts.tools;
    this.trace = opts.trace;
    this.config = opts.config;
    this.system = opts.system;
  }

  /** The conversation so far, as sent to the API. */
  get history(): readonly MessageParam[] {
    return this.messages;
  }

  private params(): MessageParams {
    return {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: this.system,
      tools: TOOLS,
      messages: this.messages,
      output_config: { effort: this.config.effort },
      // Cache the whole prefix (tools, system, history) between requests.
      cache_control: { type: "ephemeral" },
      // On a policy decline, the API retries on a model chosen for the decline category.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
  }

  /** Append user content, merging into a trailing user message (e.g. tool results of an unfinished turn). */
  private pushUser(content: UserContent): void {
    const last = this.messages.at(-1);
    if (last?.role === "user") {
      const previous: UserContent = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
      last.content = [...previous, ...content];
    } else {
      this.messages.push({ role: "user", content });
    }
  }

  /** Answer one user message. Throws only if the LLM API itself fails; the history is then rolled back. */
  async chat(userText: string): Promise<string> {
    const turn = this.trace.startTurn(userText);
    const mark = this.messages.length;
    const markContent = this.messages.at(-1)?.content;
    this.pushUser([{ type: "text", text: userText }]);
    try {
      turn.final_answer = await this.runTurn(turn);
      return turn.final_answer;
    } catch (err) {
      // Drop this turn so the next message starts from a valid conversation.
      this.messages.length = mark;
      const last = this.messages.at(-1);
      if (last && markContent !== undefined) last.content = markContent;
      turn.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.trace.endTurn(turn);
    }
  }

  private async runTurn(turn: TurnTrace): Promise<string> {
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await this.llm.create(this.params());
      turn.llm_requests++;
      turn.stop_reason = response.stop_reason;
      addUsage(turn, response);
      this.messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((b): b is ToolUse => b.type === "tool_use");
      const text = textOf(response);

      switch (response.stop_reason) {
        case "tool_use":
          this.pushUser(await this.runTools(turn, toolUses));
          continue;
        case "pause_turn":
          continue;
        case "refusal":
          await this.closeOpenToolUses(toolUses, "The response was declined.");
          return text || "Sorry, I can't help with that request. I can help with your bills, usage, payments and billing policy.";
        case "max_tokens":
          await this.closeOpenToolUses(toolUses, "The response was cut off before this tool ran.");
          return `${text}\n\n(The answer was cut off because it reached the length limit.)`.trim();
        default: // end_turn, stop_sequence, and anything newer
          await this.closeOpenToolUses(toolUses, "The turn ended before this tool ran.");
          return text;
      }
    }
    return "Sorry, I couldn't finish that request. Please try again or ask in smaller steps.";
  }

  /** Run every tool call of one response in order and return all results in one user message. */
  private async runTools(turn: TurnTrace, toolUses: ToolUse[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    // Sequential, not parallel: pay_bill may stop to ask the user a question.
    for (const call of toolUses) {
      const started = performance.now();
      const outcome = await this.tools.run(call.name, call.input);
      this.trace.toolCall(turn, {
        id: call.id,
        name: call.name,
        input: call.input,
        result: parseJson(outcome.content),
        is_error: outcome.isError,
        duration_ms: Math.round(performance.now() - started),
      });
      results.push({ type: "tool_result", tool_use_id: call.id, content: outcome.content, is_error: outcome.isError });
    }
    return results;
  }

  /** Every tool_use needs a tool_result before the next request, even when the turn stops early. */
  private async closeOpenToolUses(toolUses: ToolUse[], reason: string): Promise<void> {
    if (toolUses.length === 0) return;
    this.pushUser(
      toolUses.map((call) => ({
        type: "tool_result" as const,
        tool_use_id: call.id,
        content: JSON.stringify({ error: { code: "NOT_RUN", message: reason } }),
        is_error: true,
      })),
    );
  }
}

function textOf(message: Message): string {
  return message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function addUsage(turn: TurnTrace, message: Message): void {
  const u = message.usage;
  turn.usage.input_tokens += u.input_tokens ?? 0;
  turn.usage.output_tokens += u.output_tokens ?? 0;
  turn.usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  turn.usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
