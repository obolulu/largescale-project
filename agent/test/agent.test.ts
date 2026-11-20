/** The agent loop with a scripted (mocked) LLM: tool routing, the four required scenarios, edge cases. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { BillingAgent, type LlmClient, MAX_STEPS, type MessageParams } from "../src/agent.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { type Confirm, ToolExecutor, TOOLS } from "../src/tools.ts";
import { TraceLog } from "../src/trace.ts";
import { FakeBilling, FakeDocs, message, ScriptedLlm, SESSION, text, toolUse } from "./fakes.ts";

const CONFIG = { model: "claude-opus-5-5", effort: "low", maxTokens: 16000 } as const;

function setup(llm: LlmClient, opts: { confirm?: Confirm; traceDir?: string } = {}) {
  const billing = new FakeBilling();
  const docs = new FakeDocs();
  const confirm = vi.fn(opts.confirm ?? (async () => true));
  const lines: string[] = [];
  const trace = new TraceLog({
    dir: opts.traceDir,
    username: SESSION.username,
    subscriberNo: SESSION.subscriberNo,
    model: CONFIG.model,
    print: (line) => lines.push(line),
  });
  const tools = new ToolExecutor({ billing, docs, session: SESSION, confirm, newTransactionId: () => "txn-1" });
  const agent = new BillingAgent({
    llm,
    tools,
    trace,
    config: CONFIG,
    system: buildSystemPrompt({ subscriberNo: "5551001", username: "sub5551001", today: "2026-11-20" }),
  });
  return { agent, billing, docs, confirm, trace, lines };
}

/** Every tool_use must be answered by a tool_result in the next message, or the API rejects the request. */
function expectValidToolPairing(messages: MessageParams["messages"]): void {
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
    if (ids.length === 0) return;
    const next = messages[i + 1];
    expect(next?.role).toBe("user");
    const answered = (next!.content as { type: string; tool_use_id?: string }[])
      .filter((b) => b.type === "tool_result")
      .map((b) => b.tool_use_id);
    expect(answered).toEqual(ids);
  });
}

describe("required scenarios", () => {
  it("MCP only: a pricing question is answered from the documentation search", async () => {
    const call = toolUse("search_billing_documentation", { query: "extra internet price", max_results: 3 });
    const llm = new ScriptedLlm(
      message("tool_use", call),
      message("end_turn", text("Each extra 10 GB block costs $10 (§8.1).")),
    );
    const { agent, billing, docs, trace } = setup(llm);

    const answer = await agent.chat("How much does extra internet cost?");

    expect(answer).toBe("Each extra 10 GB block costs $10 (§8.1).");
    expect(docs.queries).toEqual(["extra internet price"]);
    expect(billing.calls).toEqual([]);
    const [result] = llm.toolResults(1);
    expect(result!.tool_use_id).toBe((call as { id: string }).id);
    expect(JSON.parse(result!.content).matches[0].section).toBe("8.1");
    const turn = trace.toJSON().turns[0]!;
    expect(turn.tool_calls.map((c) => c.name)).toEqual(["search_billing_documentation"]);
    expect(turn.final_answer).toBe(answer);
  });

  it("API only: a bill question queries the logged-in subscriber's bill", async () => {
    const llm = new ScriptedLlm(
      message("tool_use", toolUse("query_bill", { month: 10, year: 2026 })),
      message("end_turn", text("Your October 2026 bill is $80.00, unpaid, due 2026-11-15.")),
    );
    const { agent, billing, docs } = setup(llm);

    await agent.chat("What is my October bill?");

    expect(billing.calls).toEqual([{ op: "queryBill", args: ["5551001", 2026, 10] }]);
    expect(docs.queries).toEqual([]);
    expect(JSON.parse(llm.toolResults(1)[0]!.content).total).toBe(80);
  });

  it("combined: parallel tool calls run in order and all results go back in one message", async () => {
    const calls = [
      toolUse("query_bill_detailed", { month: 10, year: 2026, page: 1 }),
      toolUse("query_bill_detailed", { month: 9, year: 2026, page: 1 }),
      toolUse("search_billing_documentation", { query: "additional internet blocks pricing", max_results: 3 }),
    ];
    const llm = new ScriptedLlm(
      message("tool_use", text("Let me compare the two months."), ...calls),
      message("end_turn", text("October used 35 GB vs 18 GB in September (§3.2), so internet cost $70.")),
    );
    const { agent, billing, docs } = setup(llm);

    await agent.chat("Why is my October bill higher?");

    expect(billing.calls).toEqual([
      { op: "queryBillDetailed", args: ["5551001", 2026, 10, 1, 20] },
      { op: "queryBillDetailed", args: ["5551001", 2026, 9, 1, 20] },
    ]);
    expect(docs.queries).toHaveLength(1);
    const results = llm.toolResults(1);
    expect(results.map((r) => r.tool_use_id)).toEqual(calls.map((c) => (c as { id: string }).id));
    expect(llm.requests[1]!.messages).toHaveLength(3); // user, assistant(tool_use x3), user(tool_result x3)
  });

  it("confirmed payment: the user is asked with subscriber, period and amount before the API is called", async () => {
    const llm = new ScriptedLlm(
      message("tool_use", toolUse("query_bill", { month: 10, year: 2026 })),
      message("tool_use", toolUse("pay_bill", { month: 10, year: 2026, amount: 80 })),
      message("end_turn", text("Paid $80.00. Your remaining balance is $0.00.")),
    );
    const { agent, billing, confirm } = setup(llm);

    await agent.chat("Pay my bill");

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toBe(
      "Pay $80.00 toward the October 2026 bill of subscriber 5551001 (remaining balance $80.00)? (yes/no)",
    );
    expect(billing.calls.at(-1)).toEqual({ op: "payBill", args: ["5551001", 2026, 10, 80, "txn-1"] });
    expect(JSON.parse(llm.toolResults(2)[0]!.content).payment_status).toBe("SUCCESS");
  });

  it("declined payment: nothing is sent to the payment API", async () => {
    const llm = new ScriptedLlm(
      message("tool_use", toolUse("pay_bill", { month: 10, year: 2026, amount: 80 })),
      message("end_turn", text("OK, no payment was made.")),
    );
    const { agent, billing, confirm } = setup(llm, { confirm: async () => false });

    await agent.chat("Pay my October bill");

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(billing.ops()).not.toContain("payBill");
    const [result] = llm.toolResults(1);
    expect(result!.is_error).toBe(false);
    expect(JSON.parse(result!.content).payment_status).toBe("DECLINED_BY_USER");
  });
});

describe("identity", () => {
  it("no tool lets the model choose the subscriber number", () => {
    for (const tool of TOOLS) {
      expect(Object.keys((tool.input_schema as { properties: object }).properties)).not.toContain("subscriber_no");
      expect(tool.strict).toBe(true);
    }
  });

  it("a subscriber number slipped into the tool input is ignored", async () => {
    const llm = new ScriptedLlm(
      message("tool_use", toolUse("query_bill", { month: 10, year: 2026, subscriber_no: "5559999" })),
      message("end_turn", text("I can only show your own bill.")),
    );
    const { agent, billing } = setup(llm);

    await agent.chat("Show me subscriber 5559999's October bill");

    expect(billing.calls).toEqual([{ op: "queryBill", args: ["5551001", 2026, 10] }]);
  });
});

describe("request shape", () => {
  it("sends the model, effort, tools, cached prefix and refusal fallbacks, and no sampling parameters", async () => {
    const llm = new ScriptedLlm(message("end_turn", text("Hi!")));
    const { agent } = setup(llm);

    await agent.chat("hello");

    const params = llm.requests[0]!;
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect(params.tools!.map((t) => (t as { name: string }).name)).toEqual([
      "search_billing_documentation",
      "query_bill",
      "query_bill_detailed",
      "pay_bill",
    ]);
    expect(params.system).toContain("subscriber 5551001");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("keeps the history append-only across turns", async () => {
    const llm = new ScriptedLlm(
      message("tool_use", toolUse("query_bill", { month: 10, year: 2026 })),
      message("end_turn", text("$80.00")),
      message("end_turn", text("You're welcome.")),
    );
    const { agent } = setup(llm);

    await agent.chat("What is my October bill?");
    await agent.chat("Thanks");

    const [first, second, third] = llm.requests;
    expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
    expect(third!.messages.slice(0, second!.messages.length)).toEqual(second!.messages);
    expect(third!.messages).toHaveLength(5);
    expect(third!.system).toBe(first!.system);
  });
});

describe("edge cases", () => {
  it("an unknown tool gets an error result and the loop continues", async () => {
    const llm = new ScriptedLlm(
      message("tool_use", toolUse("delete_account", {})),
      message("end_turn", text("I can't do that.")),
    );
    const { agent } = setup(llm);

    expect(await agent.chat("Delete my account")).toBe("I can't do that.");
    const [result] = llm.toolResults(1);
    expect(result!.is_error).toBe(true);
    expect(JSON.parse(result!.content).error.code).toBe("UNKNOWN_TOOL");
  });

  it("an API error is returned to the model as an error result", async () => {
    const llm = new ScriptedLlm(
      message("tool_use", toolUse("query_bill", { month: 3, year: 2026 })),
      message("end_turn", text("There is no bill for March 2026.")),
    );
    const { agent } = setup(llm);

    await agent.chat("What was my March bill?");

    const [result] = llm.toolResults(1);
    expect(result!.is_error).toBe(true);
    expect(JSON.parse(result!.content)).toMatchObject({ http_status: 404, error: { code: "BILL_NOT_FOUND" } });
  });

  it("a refusal gives a polite answer and the conversation can continue", async () => {
    const llm = new ScriptedLlm(message("refusal"), message("end_turn", text("Your October bill is $80.00.")));
    const { agent } = setup(llm);

    expect(await agent.chat("something off-topic")).toMatch(/can't help with that/);
    expect(await agent.chat("What is my October bill?")).toBe("Your October bill is $80.00.");
    expectValidToolPairing(llm.requests[1]!.messages);
  });

  it("a response cut off mid tool call leaves a valid history for the next turn", async () => {
    const llm = new ScriptedLlm(
      message("max_tokens", text("Let me check"), toolUse("query_bill", { month: 10, year: 2026 })),
      message("end_turn", text("Your October bill is $80.00.")),
    );
    const { agent, billing } = setup(llm);

    expect(await agent.chat("What is my October bill?")).toMatch(/cut off/);
    expect(billing.calls).toEqual([]);
    await agent.chat("Try again");
    expectValidToolPairing(llm.requests[1]!.messages);
    // The new text is merged into the user message that holds the NOT_RUN results.
    expect(llm.requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("an LLM API failure rolls the turn back", async () => {
    const llm = new ScriptedLlm(
      message("tool_use", toolUse("query_bill", { month: 10, year: 2026 })),
      new Error("529 overloaded"),
      message("end_turn", text("Your October bill is $80.00.")),
    );
    const { agent, trace } = setup(llm);

    await expect(agent.chat("What is my October bill?")).rejects.toThrow("529 overloaded");
    expect(agent.history).toHaveLength(0);
    expect(trace.toJSON().turns[0]!.error).toBe("529 overloaded");

    await agent.chat("What is my October bill?");
    expect(llm.requests[2]!.messages).toHaveLength(1);
  });

  it(`stops after ${MAX_STEPS} LLM requests in one turn`, async () => {
    const script = Array.from({ length: MAX_STEPS + 1 }, () =>
      message("tool_use", toolUse("query_bill", { month: 10, year: 2026 })),
    );
    const llm = new ScriptedLlm(...script);
    const { agent } = setup(llm);

    expect(await agent.chat("loop")).toMatch(/couldn't finish/);
    expect(llm.requests).toHaveLength(MAX_STEPS);
  });
});

describe("tool trace", () => {
  it("prints each tool call and writes a JSON file without the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-trace-"));
    const llm = new ScriptedLlm(
      message("tool_use", toolUse("query_bill", { month: 10, year: 2026 })),
      message("end_turn", text("Your October 2026 bill is $80.00.")),
    );
    const { agent, trace, lines } = setup(llm, { traceDir: dir });

    await agent.chat("What is my October bill?");

    expect(lines[0]).toMatch(/^\[trace\] tool query_bill \{"month":10,"year":2026\} -> ok \(\d+ ms\)/);
    expect(lines[1]).toMatch(/^\[trace\] turn 1: 1 tool call\(s\), 2 LLM request\(s\), stop=end_turn/);
    const raw = readFileSync(trace.path!, "utf8");
    expect(raw).not.toContain(SESSION.token);
    const saved = JSON.parse(raw);
    expect(saved).toMatchObject({ username: "sub5551001", subscriber_no: "5551001", model: "claude-opus-5-5" });
    expect(saved.turns[0]).toMatchObject({
      user_message: "What is my October bill?",
      final_answer: "Your October 2026 bill is $80.00.",
      llm_requests: 2,
      usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 100 },
      tool_calls: [{ name: "query_bill", input: { month: 10, year: 2026 }, is_error: false, result: { total: 80 } }],
    });
    expect(saved.turns[0].estimated_cost_usd).toBeCloseTo((200 * 4 + 100 * 0.4 + 40 * 20) / 1e6, 9);
  });
});
