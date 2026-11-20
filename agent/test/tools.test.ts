/** ToolExecutor rules: input checks, payment confirmation, idempotent retries. */
import { describe, expect, it, vi } from "vitest";

import { BillingApiError } from "../src/billing-client.ts";
import { toCents, ToolExecutor } from "../src/tools.ts";
import { FakeBilling, FakeDocs, SESSION } from "./fakes.ts";

function setup(opts: { confirm?: boolean | boolean[] } = {}) {
  const billing = new FakeBilling();
  const docs = new FakeDocs();
  const answers = Array.isArray(opts.confirm) ? [...opts.confirm] : [opts.confirm ?? true];
  const always = !Array.isArray(opts.confirm);
  const confirm = vi.fn(async (_question: string): Promise<boolean> => (always ? answers[0]! : (answers.shift() ?? false)));
  let n = 0;
  const tools = new ToolExecutor({ billing, docs, session: SESSION, confirm, newTransactionId: () => `txn-${++n}` });
  const run = async (name: string, input: unknown) => {
    const out = await tools.run(name, input);
    return { ...out, data: JSON.parse(out.content) };
  };
  return { billing, docs, confirm, run };
}

const networkError = () => new TypeError("fetch failed");
const payIds = (billing: FakeBilling) => billing.calls.filter((c) => c.op === "payBill").map((c) => c.args[4]);

describe("input checks", () => {
  it.each([
    [{ month: 13, year: 2026 }],
    [{ month: 0, year: 2026 }],
    [{ month: 10.5, year: 2026 }],
    [{ month: "10", year: 2026 }],
    [{ month: 10 }],
    [null],
  ])("query_bill rejects %j", async (input) => {
    const { run, billing } = setup();
    const out = await run("query_bill", input);
    expect(out.isError).toBe(true);
    expect(out.data.error.code).toBe("INVALID_INPUT");
    expect(billing.calls).toEqual([]);
  });

  it.each([0, -5, 10.001, Number.NaN, "80"])("pay_bill rejects amount %j before asking anything", async (amount) => {
    const { run, billing, confirm } = setup();
    const out = await run("pay_bill", { month: 10, year: 2026, amount });
    expect(out.data.error.code).toBe("INVALID_INPUT");
    expect(confirm).not.toHaveBeenCalled();
    expect(billing.calls).toEqual([]);
  });

  it("toCents handles two-decimal amounts exactly", () => {
    expect(toCents(29.5)).toBe(2950);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(80)).toBe(8000);
    expect(toCents(1.005)).toBeNull();
  });
});

describe("query tools", () => {
  it("query_bill_detailed uses the session and a fixed page size", async () => {
    const { run, billing } = setup();
    await run("query_bill_detailed", { month: 10, year: 2026, page: 2 });
    expect(billing.calls).toEqual([{ op: "queryBillDetailed", args: ["5551001", 2026, 10, 2, 20] }]);
  });

  it("a documentation search failure is an error result, not a crash", async () => {
    const { run, docs } = setup();
    docs.fail = true;
    const out = await run("search_billing_documentation", { query: "late fee", max_results: 3 });
    expect(out.isError).toBe(true);
    expect(out.data.error.code).toBe("DOCS_UNAVAILABLE");
  });

  it("an unreachable API is reported as API_UNREACHABLE", async () => {
    const { run, billing } = setup();
    billing.queryBill = async () => {
      throw networkError();
    };
    const out = await run("query_bill", { month: 10, year: 2026 });
    expect(out.data.error).toMatchObject({ code: "API_UNREACHABLE", message: "fetch failed" });
  });
});

describe("pay_bill", () => {
  it("turns down an amount above the balance without asking", async () => {
    const { run, billing, confirm } = setup();
    const out = await run("pay_bill", { month: 10, year: 2026, amount: 90 });
    expect(out.isError).toBe(true);
    expect(out.data.error.code).toBe("AMOUNT_EXCEEDS_BALANCE");
    expect(out.data.error.message).toBe("$90.00 is more than the remaining balance of $80.00.");
    expect(confirm).not.toHaveBeenCalled();
    expect(billing.ops()).toEqual(["queryBill"]);
  });

  it("turns down paying a bill that is already paid", async () => {
    const { run, confirm } = setup();
    const out = await run("pay_bill", { month: 9, year: 2026, amount: 10 });
    expect(out.data.error.code).toBe("BILL_ALREADY_PAID");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("passes on BILL_NOT_FOUND without asking", async () => {
    const { run, confirm } = setup();
    const out = await run("pay_bill", { month: 1, year: 2026, amount: 10 });
    expect(out.data).toMatchObject({ http_status: 404, error: { code: "BILL_NOT_FOUND" } });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("accepts a partial payment and states it in the question", async () => {
    const { run, confirm, billing } = setup();
    const out = await run("pay_bill", { month: 10, year: 2026, amount: 29.5 });
    expect(confirm.mock.calls[0]).toEqual([
      "Pay $29.50 toward the October 2026 bill of subscriber 5551001 (remaining balance $80.00)? (yes/no)",
    ]);
    expect(billing.calls.at(-1)!.args).toEqual(["5551001", 2026, 10, 29.5, "txn-1"]);
    expect(out.data.bill_status).toBe("PARTIAL");
  });

  it("retries a lost response with the same transaction ID", async () => {
    const { run, billing } = setup();
    billing.payFailures = [networkError()];
    const out = await run("pay_bill", { month: 10, year: 2026, amount: 80 });
    expect(out.data.payment_status).toBe("SUCCESS");
    expect(payIds(billing)).toEqual(["txn-1", "txn-1"]);
  });

  it("treats DUPLICATE_TRANSACTION on a retry as the first attempt having gone through", async () => {
    const { run, billing } = setup();
    billing.payFailures = [
      new BillingApiError(502, "Bad Gateway"),
      new BillingApiError(409, { error: { code: "DUPLICATE_TRANSACTION", message: "already processed" } }),
    ];
    const out = await run("pay_bill", { month: 10, year: 2026, amount: 80 });
    expect(out.isError).toBe(false);
    expect(out.data).toMatchObject({ payment_status: "SUCCESS", transaction_id: "txn-1" });
  });

  it("reports an unknown outcome, and a later confirmed retry reuses the transaction ID", async () => {
    const { run, billing, confirm } = setup();
    billing.payFailures = [networkError(), networkError()];

    const first = await run("pay_bill", { month: 10, year: 2026, amount: 80 });
    expect(first.isError).toBe(true);
    expect(first.data).toMatchObject({ payment_status: "UNKNOWN", error: { code: "PAYMENT_STATUS_UNKNOWN" } });

    const second = await run("pay_bill", { month: 10, year: 2026, amount: 80 });
    expect(second.data.payment_status).toBe("SUCCESS");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(payIds(billing)).toEqual(["txn-1", "txn-1", "txn-1"]);
  });

  it("does not retry a definite rejection, and the next payment gets a new ID", async () => {
    const { run, billing } = setup();
    billing.payFailures = [new BillingApiError(403, { error: { code: "FORBIDDEN", message: "no" } })];

    const first = await run("pay_bill", { month: 10, year: 2026, amount: 80 });
    expect(first.data).toMatchObject({ http_status: 403, error: { code: "FORBIDDEN" } });
    await run("pay_bill", { month: 10, year: 2026, amount: 80 });
    expect(payIds(billing)).toEqual(["txn-1", "txn-2"]);
  });

  it("asks again for every payment, even an identical one", async () => {
    const { run, billing, confirm } = setup({ confirm: [true, false] });
    await run("pay_bill", { month: 10, year: 2026, amount: 10 });
    const second = await run("pay_bill", { month: 10, year: 2026, amount: 10 });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(second.data.payment_status).toBe("DECLINED_BY_USER");
    expect(payIds(billing)).toEqual(["txn-1"]);
  });
});
