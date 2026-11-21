// Integration tests for the API gateway. They need the running, seeded stack:
//   docker compose up -d --build
//   docker compose exec billing-api node dist/scripts/seed.js
//   cd gateway && npm test
// Settings: GATEWAY_URL (default http://localhost:8080), JWT_SECRET (default the
// local dev secret; used only to forge tokens with bad claims).
//
// None of these tests change billing data: protected writes are sent with
// bodies the backend rejects, which still proves the gateway let them through.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { before, describe, test } from "node:test";

const GATEWAY = (process.env.GATEWAY_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const SECRET = process.env.JWT_SECRET ?? "local-dev-only-secret-change-me-in-cloud-0001";
const SUB_PASSWORD = process.env.SUB_PASSWORD ?? "sub1001-demo-pass";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin-demo-pass";

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, body: json };
}

const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function sign(claims, { secret = SECRET, alg = "HS256" } = {}) {
  const head = b64url({ alg, typ: "JWT" });
  const payload = b64url(claims);
  if (alg === "none") return `${head}.${payload}.`;
  const sig = createHmac("sha256", secret).update(`${head}.${payload}`).digest("base64url");
  return `${head}.${payload}.${sig}`;
}

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "sub5551001",
    role: "SUBSCRIBER",
    subscriber_no: "5551001",
    iss: "billing-api",
    aud: "billing-clients",
    iat: now,
    exp: now + 600,
    ...overrides,
  };
}

/**
 * Kong marks responses it produced itself with X-Kong-Response-Latency, and
 * proxied ones with X-Kong-Upstream-Latency. The backend's errors are {"error": {...}}.
 */
function assertRejectedByGateway(res, status = 401) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.ok(res.headers.has("x-kong-response-latency"), "expected the gateway itself to answer");
  assert.ok(!res.headers.has("x-kong-upstream-latency"), "the request should not have reached the backend");
  assert.equal(res.body?.error, undefined);
  if (status === 401) assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
}

function assertFromBackend(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.ok(res.headers.has("x-kong-upstream-latency"), "expected a proxied response");
  if (code) assert.equal(res.body?.error?.code, code);
}

let subToken;
let adminToken;

before(async () => {
  const sub = await call("POST", "/api/v1/auth/login", { body: { username: "sub5551001", password: SUB_PASSWORD } });
  assert.equal(sub.status, 200, `login through the gateway failed: ${JSON.stringify(sub.body)}`);
  subToken = sub.body.access_token;
  const admin = await call("POST", "/api/v1/auth/login", { body: { username: "admin", password: ADMIN_PASSWORD } });
  assert.equal(admin.status, 200, `admin login failed: ${JSON.stringify(admin.body)}`);
  adminToken = admin.body.access_token;
});

describe("public routes pass through without a token", () => {
  test("health", async () => {
    const res = await call("GET", "/api/v1/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });

  test("Query Bill", async () => {
    const res = await call("GET", "/api/v1/bills?subscriber_no=5551001&month=10&year=2026");
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 80);
  });

  test("Swagger spec", async () => {
    const res = await call("GET", "/openapi.json");
    assert.equal(res.status, 200);
    assert.ok(res.body.paths["/api/v1/bills"]);
  });

  test("a wrong password is the backend's 401", async () => {
    const res = await call("POST", "/api/v1/auth/login", { body: { username: "sub5551001", password: "nope" } });
    assertFromBackend(res, 401, "INVALID_CREDENTIALS");
  });
});

describe("protected routes need a valid JWT at the gateway", () => {
  const protectedCalls = [
    ["GET", "/api/v1/bills/detailed?month=10&year=2026"],
    ["POST", "/api/v1/bills/calculate"],
    ["POST", "/api/v1/payments"],
    ["POST", "/api/v1/usage"],
  ];

  for (const [method, path] of protectedCalls) {
    test(`${method} ${path.split("?")[0]} without a token is 401 from the gateway`, async () => {
      assertRejectedByGateway(await call(method, path, { body: method === "POST" ? {} : undefined }));
    });
  }

  test("token signed with another secret", async () => {
    const token = sign(claims(), { secret: "not-the-real-secret" });
    assertRejectedByGateway(await call("GET", protectedCalls[0][1], { token }));
  });

  test("unsigned token (alg none)", async () => {
    const token = sign(claims(), { alg: "none" });
    assertRejectedByGateway(await call("GET", protectedCalls[0][1], { token }));
  });

  test("expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = sign(claims({ iat: now - 7200, exp: now - 3600 }));
    assertRejectedByGateway(await call("GET", protectedCalls[0][1], { token }));
  });

  test("wrong issuer", async () => {
    const token = sign(claims({ iss: "someone-else" }));
    assertRejectedByGateway(await call("GET", protectedCalls[0][1], { token }));
  });

  test("wrong audience", async () => {
    const token = sign(claims({ aud: "other-clients" }));
    const res = await call("GET", protectedCalls[0][1], { token });
    assertRejectedByGateway(res);
    assert.equal(res.body.message, "Invalid audience");
  });

  test("token in the URL is not accepted", async () => {
    assertRejectedByGateway(await call("GET", `${protectedCalls[0][1]}&jwt=${subToken}`));
  });
});

describe("with a valid token the backend decides", () => {
  test("Query Bill Detailed for the own account", async () => {
    const res = await call("GET", "/api/v1/bills/detailed?month=10&year=2026&page=1&page_size=5", { token: subToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.subscriber_no, "5551001");
  });

  test("another subscriber's data is the backend's 403", async () => {
    const res = await call("GET", "/api/v1/bills/detailed?month=10&year=2026&subscriber_no=5551002", {
      token: subToken,
    });
    assertFromBackend(res, 403, "FORBIDDEN");
  });

  test("Calculate Bill as a subscriber is the backend's 403", async () => {
    const res = await call("POST", "/api/v1/bills/calculate", {
      token: subToken,
      body: { subscriber_no: "5551001", month: 10, year: 2026 },
    });
    assertFromBackend(res, 403, "FORBIDDEN");
  });

  test("Pay Bill above the balance reaches the backend (422, nothing paid)", async () => {
    const res = await call("POST", "/api/v1/payments", {
      token: subToken,
      body: { month: 10, year: 2026, amount: 999999, transaction_id: `gateway-test-${Date.now()}` },
    });
    assertFromBackend(res, 422, "AMOUNT_EXCEEDS_BALANCE");
  });

  test("Add Usage as admin reaches the backend (422 for a bad body, nothing recorded)", async () => {
    const res = await call("POST", "/api/v1/usage", { token: adminToken, body: { subscriber_no: "5551001" } });
    assertFromBackend(res, 422, "VALIDATION_ERROR");
  });

  test("Calculate Bill as admin", async () => {
    // Recalculating the seeded month is idempotent: same usage, same $80 total.
    const res = await call("POST", "/api/v1/bills/calculate", {
      token: adminToken,
      body: { subscriber_no: "5551001", month: 10, year: 2026 },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.bill.total, 80);
  });
});

describe("only mapped routes are exposed", () => {
  test("unknown path", async () => {
    assertRejectedByGateway(await call("GET", "/api/v1/admin"), 404);
  });

  test("prefix look-alike is not routed", async () => {
    assertRejectedByGateway(await call("GET", "/api/v1/billsx?subscriber_no=5551001&month=10&year=2026"), 404);
  });

  test("wrong method on a public route", async () => {
    assertRejectedByGateway(await call("DELETE", "/api/v1/bills"), 404);
  });

  test("the gateway does not reveal its version", async () => {
    const res = await call("GET", "/api/v1/health");
    assert.equal(res.headers.get("server"), null);
  });
});
