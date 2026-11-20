/** Test doubles: a scripted LLM, a fake Billing API and a fake docs search. */
import type { LlmClient, Message, MessageParams } from "../src/agent.ts";
import { type BillingApi, BillingApiError, type Json, type Session } from "../src/billing-client.ts";
import type { DocsSearch } from "../src/docs-client.ts";

export const SESSION: Session = { username: "sub5551001", role: "SUBSCRIBER", subscriberNo: "5551001", token: "secret.jwt.token" };

type Block = Message["content"][number];
let ids = 0;

export const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
export const toolUse = (name: string, input: Json, id = `toolu_${++ids}`): Block =>
  ({ type: "tool_use", id, name, input, caller: { type: "direct" } }) as unknown as Block;

export function message(stopReason: Message["stop_reason"], ...content: Block[]): Message {
  return {
    id: `msg_${++ids}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
  } as unknown as Message;
}

/** Returns the scripted responses in order and keeps a snapshot of every request. */
export class ScriptedLlm implements LlmClient {
  readonly requests: MessageParams[] = [];
  private readonly script: (Message | Error)[];

  constructor(...script: (Message | Error)[]) {
    this.script = script;
  }

  async create(params: MessageParams): Promise<Message> {
    this.requests.push(structuredClone(params));
    const next = this.script.shift();
    if (!next) throw new Error("ScriptedLlm ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  }

  /** The tool_result blocks of the last user message in request `i`. */
  toolResults(i: number): { tool_use_id: string; content: string; is_error?: boolean }[] {
    const last = this.requests[i]!.messages.at(-1)!;
    return (last.content as { type: string }[]).filter((b) => b.type === "tool_result") as never;
  }
}

export const BILLS: Record<string, Json> = {
  "2026-10": { subscriber_no: "5551001", month: 10, year: 2026, currency: "USD", total: 80, paid_amount: 0, remaining_balance: 80, status: "UNPAID", due_date: "2026-11-15" },
  "2026-9": { subscriber_no: "5551001", month: 9, year: 2026, currency: "USD", total: 50, paid_amount: 50, remaining_balance: 0, status: "PAID", due_date: "2026-10-15" },
};

export class FakeBilling implements BillingApi {
  readonly calls: { op: string; args: unknown[] }[] = [];
  /** Errors to throw from the next payBill calls, in order. */
  payFailures: unknown[] = [];

  async queryBill(subscriberNo: string, year: number, month: number): Promise<Json> {
    this.calls.push({ op: "queryBill", args: [subscriberNo, year, month] });
    const bill = subscriberNo === "5551001" ? BILLS[`${year}-${month}`] : undefined;
    if (!bill) throw new BillingApiError(404, { error: { code: "BILL_NOT_FOUND", message: "No calculated bill." } });
    return structuredClone(bill);
  }

  async queryBillDetailed(session: Session, year: number, month: number, page: number, pageSize: number): Promise<Json> {
    this.calls.push({ op: "queryBillDetailed", args: [session.subscriberNo, year, month, page, pageSize] });
    const bill = BILLS[`${year}-${month}`];
    if (!bill) throw new BillingApiError(404, { error: { code: "BILL_NOT_FOUND", message: "No calculated bill." } });
    const usage = month === 10 ? { phone_minutes: 1350, internet_mb: 35000 } : { phone_minutes: 800, internet_mb: 18000 };
    return { ...bill, usage };
  }

  async payBill(session: Session, year: number, month: number, amount: number, transactionId: string): Promise<Json> {
    this.calls.push({ op: "payBill", args: [session.subscriberNo, year, month, amount, transactionId] });
    const failure = this.payFailures.shift();
    if (failure) throw failure;
    const bill = BILLS[`${year}-${month}`]!;
    const remaining = (bill.remaining_balance as number) - amount;
    return {
      payment_status: "SUCCESS",
      transaction_id: transactionId,
      amount,
      remaining_balance: remaining,
      bill_status: remaining === 0 ? "PAID" : "PARTIAL",
    };
  }

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }
}

export class FakeDocs implements DocsSearch {
  readonly queries: string[] = [];
  fail = false;

  async search(query: string, maxResults: number): Promise<unknown> {
    this.queries.push(query);
    if (this.fail) throw new Error("connection closed");
    return {
      document: "Mobile_Provider_Billing_Guide.md",
      document_id: "MOB-BILLING-2026-01",
      query,
      matches: [
        {
          section: "8.1",
          heading: "What is the cost of extra internet?",
          reference: "§8.1 What is the cost of extra internet?",
          text: "Each additional 10 GB block beyond 20 GB costs $10.",
          score: 7.0,
        },
      ].slice(0, maxResults),
    };
  }
}
