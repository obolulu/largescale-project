/**
 * The four tools the LLM may call, and the code that runs them.
 *
 * Safety rules live here, not in the prompt:
 * - The subscriber number always comes from the logged-in session. No tool takes one,
 *   so a number typed into the chat can't reach the API.
 * - pay_bill asks the user for an explicit yes (subscriber, period, amount) before
 *   calling the API, and generates the transaction ID itself (§5.2, §5.3).
 */
import { randomUUID } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";

import { type BillingApi, BillingApiError, type Json, type Session } from "./billing-client.ts";
import { DOCS_TOOL, type DocsSearch } from "./docs-client.ts";

type Tool = Anthropic.Beta.Messages.BetaTool;

const MONTH = { type: "integer", description: "Billing month, 1-12." } as const;
const YEAR = { type: "integer", description: "Billing year, e.g. 2026." } as const;

/** Tool definitions in a fixed order, so the request prefix stays cacheable. */
export const TOOLS: Tool[] = [
  {
    name: DOCS_TOOL,
    description:
      "Search the Mobile Provider Billing Guide (policy document MOB-BILLING-2026-01) for pricing rules, " +
      "allowances, bill calculation, payments, due dates, late payments and disputes. Returns sections with " +
      "references such as '§3.2 Additional internet blocks'. It has no subscriber data.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up, in plain words." },
        max_results: { type: "integer", description: "How many sections to return, 1-5. Use 3 unless you need more." },
      },
      required: ["query", "max_results"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "query_bill",
    description:
      "Get the logged-in subscriber's stored bill for one month: total, paid amount, remaining balance, " +
      "status (UNPAID, PARTIAL, PAID) and due date. Returns BILL_NOT_FOUND if no bill was calculated for that month.",
    input_schema: {
      type: "object",
      properties: { month: MONTH, year: YEAR },
      required: ["month", "year"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "query_bill_detailed",
    description:
      "Get the logged-in subscriber's bill for one month with usage totals (phone minutes, internet MB/GB), " +
      "the phone and internet charge breakdown, and one page of raw usage records. Use it to explain why a bill " +
      "is what it is. Page 1 is enough unless you need the individual usage records.",
    input_schema: {
      type: "object",
      properties: {
        month: MONTH,
        year: YEAR,
        page: { type: "integer", description: "Page of usage records, starting at 1." },
      },
      required: ["month", "year", "page"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "pay_bill",
    description:
      "Pay all or part of the logged-in subscriber's bill for one month (simulated, no card). The app shows the " +
      "user the subscriber, period and amount and pays only after they answer yes, so call this directly when the " +
      "user asks to pay; don't ask for confirmation in chat first. Returns payment_status SUCCESS when the payment " +
      "is recorded, or DECLINED_BY_USER when the user said no.",
    input_schema: {
      type: "object",
      properties: {
        month: MONTH,
        year: YEAR,
        amount: {
          type: "number",
          description: "Amount in USD, more than 0 and at most the remaining balance, with at most 2 decimals.",
        },
      },
      required: ["month", "year", "amount"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export interface ToolOutcome {
  /** JSON text sent back to the LLM as the tool_result content. */
  content: string;
  isError: boolean;
}

/** Asks the human a yes/no question. Resolves true only on an explicit yes. */
export type Confirm = (question: string) => Promise<boolean>;

export const DETAIL_PAGE_SIZE = 20;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

class InvalidInput extends Error {}

function int(input: Json, key: string, min: number, max: number): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidInput(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function period(input: Json): { month: number; year: number } {
  return { month: int(input, "month", 1, 12), year: int(input, "year", 2000, 2100) };
}

/** Dollars to integer cents, or null if it isn't a positive amount with at most 2 decimals. */
export function toCents(amount: unknown): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 1e-6 ? cents : null;
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const ok = (data: unknown): ToolOutcome => ({ content: JSON.stringify(data), isError: false });
const fail = (data: unknown): ToolOutcome => ({ content: JSON.stringify(data), isError: true });

/** Network failures and 5xx answers may or may not have reached the database. */
function isRetryable(err: unknown): boolean {
  return !(err instanceof BillingApiError) || err.status >= 500;
}

function apiFailure(err: unknown): ToolOutcome {
  if (err instanceof BillingApiError) return fail({ http_status: err.status, ...(err.body as object) });
  return fail({ error: { code: "API_UNREACHABLE", message: err instanceof Error ? err.message : String(err) } });
}

export interface ToolDeps {
  billing: BillingApi;
  docs: DocsSearch;
  session: Session;
  confirm: Confirm;
  newTransactionId?: () => string;
  /** Attempts per pay_bill call when the outcome is unknown (network error or 5xx). */
  payAttempts?: number;
}

export class ToolExecutor {
  /**
   * Transaction IDs of payments the user confirmed whose outcome is unknown (network error or 5xx).
   * A retry for the same period and amount reuses the ID, so the API's idempotency check
   * prevents a second charge (§5.3).
   */
  private readonly pendingPayments = new Map<string, string>();

  private readonly deps: ToolDeps;

  constructor(deps: ToolDeps) {
    this.deps = deps;
  }

  async run(name: string, rawInput: unknown): Promise<ToolOutcome> {
    const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Json;
    try {
      switch (name) {
        case DOCS_TOOL:
          return await this.searchDocs(input);
        case "query_bill":
          return await this.queryBill(input);
        case "query_bill_detailed":
          return await this.queryBillDetailed(input);
        case "pay_bill":
          return await this.payBill(input);
        default:
          return fail({ error: { code: "UNKNOWN_TOOL", message: `No tool named ${name}.` } });
      }
    } catch (err) {
      if (err instanceof InvalidInput) return fail({ error: { code: "INVALID_INPUT", message: err.message } });
      return apiFailure(err);
    }
  }

  private async searchDocs(input: Json): Promise<ToolOutcome> {
    const query = input.query;
    if (typeof query !== "string" || query.trim() === "" || query.length > 500) {
      throw new InvalidInput("query must be a non-empty string of at most 500 characters");
    }
    const maxResults = input.max_results === undefined ? 3 : int(input, "max_results", 1, 5);
    try {
      return ok(await this.deps.docs.search(query, maxResults));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail({ error: { code: "DOCS_UNAVAILABLE", message } });
    }
  }

  private async queryBill(input: Json): Promise<ToolOutcome> {
    const { month, year } = period(input);
    return ok(await this.deps.billing.queryBill(this.deps.session.subscriberNo, year, month));
  }

  private async queryBillDetailed(input: Json): Promise<ToolOutcome> {
    const { month, year } = period(input);
    const page = input.page === undefined ? 1 : int(input, "page", 1, 10_000);
    return ok(await this.deps.billing.queryBillDetailed(this.deps.session, year, month, page, DETAIL_PAGE_SIZE));
  }

  private async payBill(input: Json): Promise<ToolOutcome> {
    const { month, year } = period(input);
    const cents = toCents(input.amount);
    if (cents === null) throw new InvalidInput("amount must be more than 0 with at most 2 decimals");
    const { billing, session } = this.deps;

    // Look the bill up first, so the confirmation shows real figures and an impossible
    // payment is turned down before the user is asked anything.
    const bill = await billing.queryBill(session.subscriberNo, year, month);
    const remaining = toCents(bill.remaining_balance) ?? 0;
    if (remaining === 0) {
      return fail({ error: { code: "BILL_ALREADY_PAID", message: "This bill has no outstanding balance." }, bill });
    }
    if (cents > remaining) {
      return fail({
        error: {
          code: "AMOUNT_EXCEEDS_BALANCE",
          message: `${usd(cents)} is more than the remaining balance of ${usd(remaining)}.`,
        },
        bill,
      });
    }

    const label = `${MONTH_NAMES[month - 1]} ${year}`;
    const question =
      `Pay ${usd(cents)} toward the ${label} bill of subscriber ${session.subscriberNo}` +
      ` (remaining balance ${usd(remaining)})? (yes/no)`;
    if (!(await this.deps.confirm(question))) {
      return ok({
        payment_status: "DECLINED_BY_USER",
        message: "The user did not confirm. No payment was made.",
        subscriber_no: session.subscriberNo,
        month,
        year,
        amount: cents / 100,
      });
    }

    const key = `${year}-${month}-${cents}`;
    const transactionId = this.pendingPayments.get(key) ?? (this.deps.newTransactionId ?? randomUUID)();
    this.pendingPayments.set(key, transactionId);
    const attempts = this.deps.payAttempts ?? 2;

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await billing.payBill(session, year, month, cents / 100, transactionId);
        this.pendingPayments.delete(key);
        return ok(result);
      } catch (err) {
        if (err instanceof BillingApiError && err.code === "DUPLICATE_TRANSACTION" && attempt > 1) {
          // An earlier attempt with this ID went through; only its response was lost.
          this.pendingPayments.delete(key);
          const current = await billing.queryBill(session.subscriberNo, year, month);
          return ok({ payment_status: "SUCCESS", transaction_id: transactionId, amount: cents / 100, bill: current });
        }
        if (!isRetryable(err)) {
          this.pendingPayments.delete(key);
          return apiFailure(err);
        }
        if (attempt >= attempts) {
          const message = err instanceof Error ? err.message : String(err);
          return fail({
            payment_status: "UNKNOWN",
            transaction_id: transactionId,
            error: {
              code: "PAYMENT_STATUS_UNKNOWN",
              message:
                `The payment API did not answer (${message}). The payment may or may not have been recorded. ` +
                "Do not tell the user it succeeded. Retrying pay_bill for the same month and amount reuses this " +
                "transaction ID, so it cannot charge twice.",
            },
          });
        }
      }
    }
  }
}
