/** Thin client for the Billing REST API (v1). All calls go to the configured base URL (the gateway). */

export interface Session {
  username: string;
  role: "SUBSCRIBER" | "ADMIN";
  subscriberNo: string;
  token: string;
}

export type Json = Record<string, unknown>;

/** A non-2xx answer from the API. `body` is the API's `{"error": {...}}` object when it sent one. */
export class BillingApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    super(`HTTP ${status}${err?.code ? ` ${err.code}` : ""}${err?.message ? `: ${err.message}` : ""}`);
    this.name = "BillingApiError";
    this.status = status;
    this.body = body;
  }

  get code(): string | undefined {
    return (this.body as { error?: { code?: string } } | null)?.error?.code;
  }
}

export interface BillingApi {
  queryBill(subscriberNo: string, year: number, month: number): Promise<Json>;
  queryBillDetailed(session: Session, year: number, month: number, page: number, pageSize: number): Promise<Json>;
  payBill(session: Session, year: number, month: number, amount: number, transactionId: string): Promise<Json>;
}

export class BillingApiClient implements BillingApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  private async request(method: string, path: string, opts: { token?: string; query?: Json; body?: Json } = {}) {
    const url = new URL(`${this.baseUrl}/api/v1/${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Keep the raw text, e.g. an HTML error page from a gateway.
    }
    if (!res.ok) throw new BillingApiError(res.status, body);
    return body as Json;
  }

  async login(username: string, password: string): Promise<Session> {
    const body = await this.request("POST", "auth/login", { body: { username, password } });
    return {
      username,
      role: body.role as Session["role"],
      subscriberNo: (body.subscriber_no as string | null) ?? "",
      token: body.access_token as string,
    };
  }

  queryBill(subscriberNo: string, year: number, month: number): Promise<Json> {
    return this.request("GET", "bills", { query: { subscriber_no: subscriberNo, year, month } });
  }

  queryBillDetailed(session: Session, year: number, month: number, page: number, pageSize: number): Promise<Json> {
    // subscriber_no is left out on purpose: the API takes it from the token.
    return this.request("GET", "bills/detailed", {
      token: session.token,
      query: { year, month, page, page_size: pageSize },
    });
  }

  payBill(session: Session, year: number, month: number, amount: number, transactionId: string): Promise<Json> {
    return this.request("POST", "payments", {
      token: session.token,
      body: { year, month, amount, transaction_id: transactionId },
    });
  }
}
