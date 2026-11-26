import { describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { signSessionToken } from "../session-token.js";
import { BACKOFF_S, MAX_ATTEMPTS, deliverDue, eventsForMarginTransition, fanOutRecentEvents } from "../webhooks/outbox.js";
import { decryptSecret, encryptSecret } from "../webhooks/secretBox.js";
import { SIGNATURE_TOLERANCE_S, signWebhook, verifyWebhook } from "../webhooks/signing.js";
import { assertSafeWebhookUrl, isPrivateAddress } from "../webhooks/ssrf.js";
import { createFakeDb } from "./fake-db.js";

const KEY = "ab".repeat(32);
const PUBLIC_RESOLVE = async () => ["93.184.216.34"];

/** Scripted stand-in for the tables the outbox touches; records inserts and updates. */
function outboxDb(tables: Map<unknown, unknown[]>) {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];
  const chain = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    p.where = () => chain(rows);
    p.limit = () => chain(rows);
    return p;
  };
  const db = {
    select: () => ({ from: (t: unknown) => chain(tables.get(t) ?? []) }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: "new" }] }) };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        return { where: async () => undefined };
      },
    }),
  } as unknown as Database;
  return { db, inserts, updates };
}

describe("secretBox", () => {
  it("round-trips and never stores the plaintext", () => {
    const boxed = encryptSecret("whsec-123", KEY);
    expect(boxed).not.toContain("whsec-123");
    expect(decryptSecret(boxed, KEY)).toBe("whsec-123");
  });

  it("fails to decrypt with another key or a tampered box", () => {
    const boxed = encryptSecret("whsec-123", KEY);
    expect(() => decryptSecret(boxed, "cd".repeat(32))).toThrow();
    const [iv, tag, ct] = boxed.split(".");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 1;
    expect(() => decryptSecret([iv, tag, flipped.toString("base64")].join("."), KEY)).toThrow();
  });
});

describe("delivery signatures", () => {
  const body = '{"event":"margin.state_changed"}';

  it("verifies a fresh signature and rejects a wrong secret or body", () => {
    const header = signWebhook("s3cret", 1_000_000, body);
    expect(verifyWebhook("s3cret", header, body, 1_000_010)).toBe(true);
    expect(verifyWebhook("other", header, body, 1_000_010)).toBe(false);
    expect(verifyWebhook("s3cret", header, body + " ", 1_000_010)).toBe(false);
  });

  it("rejects a replay outside the tolerance window", () => {
    const header = signWebhook("s3cret", 1_000_000, body);
    expect(verifyWebhook("s3cret", header, body, 1_000_000 + SIGNATURE_TOLERANCE_S + 1)).toBe(false);
  });
});

describe("SSRF guard", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])(
    "treats %s as private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])("treats %s as public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );

  it("accepts an https URL that resolves publicly", async () => {
    await expect(assertSafeWebhookUrl("https://hooks.example.com/ballast", { resolve: PUBLIC_RESOLVE })).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ["http://hooks.example.com/x", "https"],
    ["https://user:pw@hooks.example.com/x", "credentials"],
    ["https://localhost/x", "local"],
    ["https://metadata.internal/x", "local"],
    ["https://169.254.169.254/latest/meta-data", "private"],
    ["https://[::1]/x", "private"],
    ["not a url", "valid URL"],
  ])("rejects %s", async (url, why) => {
    await expect(assertSafeWebhookUrl(url, { resolve: PUBLIC_RESOLVE })).rejects.toThrow(new RegExp(why));
  });

  it("rejects a public-looking name that resolves to a private address (DNS rebinding)", async () => {
    await expect(assertSafeWebhookUrl("https://evil.example.com/x", { resolve: async () => ["10.0.0.5"] })).rejects.toThrow(/private/);
  });

  it("allows http only when explicitly permitted", async () => {
    await expect(assertSafeWebhookUrl("http://hooks.example.com/x", { allowHttp: true, resolve: PUBLIC_RESOLVE })).resolves.toBeInstanceOf(URL);
  });
});

describe("eventsForMarginTransition", () => {
  it("emits the specific event alongside state_changed", () => {
    expect(eventsForMarginTransition("Warning", "MarginCall")).toEqual(["margin.state_changed", "margin.call_issued"]);
    expect(eventsForMarginTransition("MarginCall", "Healthy")).toEqual(["margin.state_changed", "margin.cured"]);
    expect(eventsForMarginTransition("MarginCall", "Liquidation")).toEqual(["margin.state_changed", "liquidation.started"]);
    expect(eventsForMarginTransition("Healthy", "Warning")).toEqual(["margin.state_changed"]);
  });
});

describe("fanOutRecentEvents", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const sub = (id: string, partyId: string, events: string[], active = true) => ({
    id, partyId, url: "https://hooks.example.com/x", events, secretCiphertext: "x", active, createdAt: new Date("2026-10-01T00:00:00Z"),
  });

  it("sends a margin event only to the line's lender and borrower, filtered by event", async () => {
    const { db, inserts } = outboxDb(
      new Map<unknown, unknown[]>([
        [schema.webhookSubscription, [
          sub("s-lender", "lender", ["margin.call_issued"]),
          sub("s-borrower", "borrower", ["margin.state_changed"]),
          sub("s-stranger", "stranger", ["margin.call_issued", "margin.state_changed"]),
          sub("s-off", "lender", ["margin.call_issued"], false),
        ]],
        [schema.creditLine, [{ id: "line-1", lenderId: "lender", borrowerId: "borrower" }]],
        [schema.marginEvent, [{ id: "me-1", creditLineId: "line-1", fromState: "Warning", toState: "MarginCall", ltvBps: 8100, createdAt: new Date("2026-10-08T11:00:00Z") }]],
      ]),
    );

    await fanOutRecentEvents(db, now);

    const keys = inserts.map((i) => `${i.values.subscriptionId}|${i.values.eventKey}`).sort();
    expect(keys).toEqual([
      "s-borrower|margin_event:me-1:margin.state_changed",
      "s-lender|margin_event:me-1:margin.call_issued",
    ]);
    expect(inserts[0].values.payload).toMatchObject({ data: { creditLineId: "line-1", toState: "MarginCall", ltvBps: 8100 } });
  });

  it("ignores margin events older than the scan window", async () => {
    const { db, inserts } = outboxDb(
      new Map<unknown, unknown[]>([
        [schema.webhookSubscription, [sub("s1", "lender", ["margin.state_changed"])]],
        [schema.creditLine, [{ id: "line-1", lenderId: "lender", borrowerId: "borrower" }]],
        [schema.marginEvent, [{ id: "old", creditLineId: "line-1", fromState: "Healthy", toState: "Warning", ltvBps: 7000, createdAt: new Date("2026-10-01T00:00:00Z") }]],
      ]),
    );
    await fanOutRecentEvents(db, now);
    expect(inserts).toHaveLength(0);
  });

  it("emits price.status_changed only when the status actually changes", async () => {
    const snap = (id: string, status: string, at: string) => ({ id, assetId: "a1", status, guardedValue: "1.0764250", createdAt: new Date(at) });
    const { db, inserts } = outboxDb(
      new Map<unknown, unknown[]>([
        [schema.webhookSubscription, [sub("s1", "anyone", ["price.status_changed"])]],
        [schema.priceSnapshot, [
          snap("p1", "Ok", "2026-10-08T08:00:00Z"),
          snap("p2", "Ok", "2026-10-08T09:00:00Z"),
          snap("p3", "Degraded", "2026-10-08T10:00:00Z"),
          snap("p4", "Degraded", "2026-10-08T11:00:00Z"),
        ]],
      ]),
    );

    await fanOutRecentEvents(db, now);

    expect(inserts).toHaveLength(1);
    expect(inserts[0].values.eventKey).toBe("price_snapshot:p3");
    expect(inserts[0].values.payload).toMatchObject({ data: { fromStatus: "Ok", toStatus: "Degraded" } });
  });
});

describe("deliverDue", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const secret = "whsec-test";
  const subscription = (over: Record<string, unknown> = {}) => ({
    id: "sub-1", partyId: "p", url: "https://hooks.example.com/x", events: [], secretCiphertext: encryptSecret(secret, KEY), active: true, createdAt: now, ...over,
  });
  const delivery = (over: Record<string, unknown> = {}) => ({
    id: "d-1", subscriptionId: "sub-1", eventKey: "k", event: "margin.state_changed", payload: { event: "margin.state_changed", data: { x: 1 } },
    status: "pending", attempts: 0, nextAttemptAt: now, ...over,
  });
  const setup = (d: Record<string, unknown>, s: Record<string, unknown> | null = subscription()) =>
    outboxDb(new Map<unknown, unknown[]>([[schema.webhookDelivery, [d]], [schema.webhookSubscription, s ? [s] : []]]));

  it("posts a signed body and marks the delivery delivered", async () => {
    const { db, updates } = setup(delivery());
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const tally = await deliverDue(db, { now, secretKey: KEY, fetchImpl, resolve: PUBLIC_RESOLVE });

    expect(tally).toEqual({ delivered: 1, retried: 0, dead: 0 });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("https://hooks.example.com/x");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-ballast-event"]).toBe("margin.state_changed");
    expect(verifyWebhook(secret, headers["x-ballast-signature"], init.body as string, Math.floor(now.getTime() / 1000))).toBe(true);
    expect(updates[0].set).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("reschedules a failed delivery with backoff", async () => {
    const { db, updates } = setup(delivery({ attempts: 1 }));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

    const tally = await deliverDue(db, { now, secretKey: KEY, fetchImpl, resolve: PUBLIC_RESOLVE });

    expect(tally).toEqual({ delivered: 0, retried: 1, dead: 0 });
    expect(updates[0].set).toMatchObject({ status: "pending", attempts: 2, lastError: "subscriber responded 503" });
    expect((updates[0].set.nextAttemptAt as Date).getTime()).toBe(now.getTime() + BACKOFF_S[1] * 1000);
  });

  it("dead-letters a delivery once it has used every attempt", async () => {
    const { db, updates } = setup(delivery({ attempts: MAX_ATTEMPTS - 1 }));
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;

    const tally = await deliverDue(db, { now, secretKey: KEY, fetchImpl, resolve: PUBLIC_RESOLVE });

    expect(tally.dead).toBe(1);
    expect(updates[0].set).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS, lastError: "ECONNRESET" });
  });

  it("treats a redirect as a failure instead of following it", async () => {
    const { db, updates } = setup(delivery());
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } })) as unknown as typeof fetch;

    await deliverDue(db, { now, secretKey: KEY, fetchImpl, resolve: PUBLIC_RESOLVE });

    expect(updates[0].set).toMatchObject({ status: "pending", lastError: "subscriber responded 302" });
  });

  it("never calls a subscriber whose URL now resolves to a private address", async () => {
    const { db, updates } = setup(delivery());
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await deliverDue(db, { now, secretKey: KEY, fetchImpl, resolve: async () => ["169.254.169.254"] });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updates[0].set.lastError).toMatch(/private/);
  });

  it("dead-letters immediately when the subscription is gone or inactive", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    for (const sub of [null, subscription({ active: false })]) {
      const { db, updates } = setup(delivery(), sub);
      const tally = await deliverDue(db, { now, secretKey: KEY, fetchImpl, resolve: PUBLIC_RESOLVE });
      expect(tally.dead).toBe(1);
      expect(updates[0].set).toMatchObject({ status: "dead" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("webhook routes", () => {
  const config: ApiConfig = {
    port: 0,
    jwtSigningSecret: "test-signing-key",
    sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    sep10HomeDomain: "localhost",
    sep10WebAuthDomain: "localhost",
    networkPassphrase: "Test SDF Network ; September 2015",
    webhookSecretKey: KEY,
    apiKeySecretKey: "00".repeat(32),
    complianceEnforced: false,
    consoleOrigin: "http://localhost:5173",
  };
  const ACCOUNT = "GABCDEFTESTACCOUNT";
  const PARTY = "33333333-3333-3333-3333-333333333333";
  const authed = { authorization: `Bearer ${signSessionToken(ACCOUNT, config.jwtSigningSecret)}` };
  const server = (cfg = config, extra: [unknown, unknown[]][] = []) =>
    buildServer({
      config: cfg,
      contracts: {} as ContractClients,
      db: createFakeDb(new Map<unknown, unknown[]>([[schema.partyAccount, [{ partyId: PARTY, stellarAccount: ACCOUNT, role: "borrower" }]], ...extra])),
    });

  it("lists the deliverable events", async () => {
    const res = await server().inject({ method: "GET", url: "/v1/webhooks/events", headers: authed });
    expect(res.json().events).toContain("margin.call_issued");
    expect(res.json().events).not.toContain("repo.defaulted");
  });

  it("requires authentication", async () => {
    const res = await server().inject({ method: "GET", url: "/v1/webhooks/subscriptions" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses to create a subscription while no secret key is configured", async () => {
    const res = await server({ ...config, webhookSecretKey: "" }).inject({
      method: "POST", url: "/v1/webhooks/subscriptions", headers: authed,
      payload: { url: "https://hooks.example.com/x", events: ["margin.call_issued"] },
    });
    expect(res.statusCode).toBe(503);
  });

  it("rejects an unknown event, an unsafe URL and an empty event list", async () => {
    const app = server();
    for (const payload of [
      { url: "https://hooks.example.com/x", events: ["repo.defaulted"] },
      { url: "https://169.254.169.254/x", events: ["margin.call_issued"] },
      { url: "https://hooks.example.com/x", events: [] },
    ]) {
      const res = await app.inject({ method: "POST", url: "/v1/webhooks/subscriptions", headers: authed, payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("creates a subscription, returns the signing secret once and keeps it out of the listing", async () => {
    const sub = { id: "sub-1", partyId: PARTY, url: "https://93.184.216.34/hook", events: ["margin.call_issued"], secretCiphertext: "iv.tag.ct", active: true, createdAt: new Date() };
    const app = server(config, [[schema.webhookSubscription, [sub]]]);

    const created = await app.inject({
      method: "POST", url: "/v1/webhooks/subscriptions", headers: authed,
      payload: { url: sub.url, events: ["margin.call_issued", "margin.call_issued"] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.json().events).toEqual(["margin.call_issued"]);
    expect(JSON.stringify(created.json())).not.toContain("secretCiphertext");

    const listed = await app.inject({ method: "GET", url: "/v1/webhooks/subscriptions", headers: authed });
    expect(listed.json().subscriptions).toHaveLength(1);
    expect(JSON.stringify(listed.json())).not.toMatch(/secret/i);
  });

  it("answers 404 when redelivering another party's delivery", async () => {
    const theirs = { id: "sub-x", partyId: "someone-else", url: "https://93.184.216.34/h", events: [], secretCiphertext: "x", active: true, createdAt: new Date() };
    // The fake db ignores WHERE, so only the handler's own ownership check can produce the 404.
    const app = server(config, [
      [schema.webhookSubscription, [theirs]],
      [schema.webhookDelivery, [{ id: "d-x", subscriptionId: "sub-x", status: "dead" }]],
    ]);
    const redeliver = await app.inject({ method: "POST", url: "/v1/webhooks/deliveries/d-x/redeliver", headers: authed });
    expect(redeliver.statusCode).toBe(404);
  });

  it("patches subscription url and events without changing or exposing secret", async () => {
    const sub = {
      id: "sub-patch",
      partyId: PARTY,
      url: "https://93.184.216.34/old",
      events: ["margin.call_issued"],
      secretCiphertext: "secret-ciphertext",
      active: true,
      createdAt: new Date(),
    };
    const app = server(config, [[schema.webhookSubscription, [sub]]]);

    const res = await app.inject({
      method: "PATCH",
      url: "/v1/webhooks/subscriptions/sub-patch",
      headers: authed,
      payload: { url: "https://93.184.216.34/new", events: ["margin.cured"] },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.id).toBe("sub-patch");
    expect(json.url).toBe("https://93.184.216.34/new");
    expect(json.events).toEqual(["margin.cured"]);
    expect(json.active).toBe(true);
    expect(json).not.toHaveProperty("secret");
    expect(json).not.toHaveProperty("secretCiphertext");

    // Unsafe URL is rejected with 400
    const unsafeRes = await app.inject({
      method: "PATCH",
      url: "/v1/webhooks/subscriptions/sub-patch",
      headers: authed,
      payload: { url: "https://127.0.0.1/unsafe" },
    });
    expect(unsafeRes.statusCode).toBe(400);

    // Patch on non-existent or other party's subscription returns 404
    const otherRes = await app.inject({
      method: "PATCH",
      url: "/v1/webhooks/subscriptions/other-id",
      headers: authed,
      payload: { url: "https://93.184.216.34/new" },
    });
    expect(otherRes.statusCode).toBe(404);
  });

  it("answers 409 when redelivering for a deactivated subscription", async () => {
    const inactive = { id: "sub-1", partyId: PARTY, url: "https://93.184.216.34/h", events: [], secretCiphertext: "x", active: false, createdAt: new Date() };
    const app = server(config, [
      [schema.webhookSubscription, [inactive]],
      [schema.webhookDelivery, [{ id: "d-1", subscriptionId: "sub-1", status: "dead" }]],
    ]);
    const res = await app.inject({ method: "POST", url: "/v1/webhooks/deliveries/d-1/redeliver", headers: authed });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "subscription is inactive" });
  });

  it("produces one 202 and one 409 on concurrent redelivers", async () => {
    const sub = { id: "sub-1", partyId: PARTY, url: "https://93.184.216.34/h", events: [], secretCiphertext: "x", active: true, createdAt: new Date() };
    let updatedCount = 0;
    const fakeDb = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.partyAccount, [{ partyId: PARTY, stellarAccount: ACCOUNT, role: "borrower" }]],
        [schema.webhookSubscription, [sub]],
        [schema.webhookDelivery, [{ id: "d-1", subscriptionId: "sub-1", status: "dead" }]],
      ]),
    );
    // Custom update to simulate atomic conditional update where only the first concurrent call updates the row
    fakeDb.update = (() => {
      const query: any = {
        where: () => query,
        returning: async () => {
          if (updatedCount === 0) {
            updatedCount++;
            return [{ id: "d-1" }];
          }
          return [];
        },
      };
      return { set: () => query };
    }) as any;

    const app = buildServer({ config, db: fakeDb, contracts: {} as ContractClients });
    const [res1, res2] = await Promise.all([
      app.inject({ method: "POST", url: "/v1/webhooks/deliveries/d-1/redeliver", headers: authed }),
      app.inject({ method: "POST", url: "/v1/webhooks/deliveries/d-1/redeliver", headers: authed }),
    ]);

    const statuses = [res1.statusCode, res2.statusCode].sort();
    expect(statuses).toEqual([202, 409]);
    const results = [res1.json(), res2.json()];
    expect(results).toContainEqual({ id: "d-1", status: "pending" });
    expect(results).toContainEqual({ error: "delivery is not dead" });
  });
});

describe("fanOutRecentEvents: exit, liquidation and repo events", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const sub = (id: string, partyId: string, events: string[], createdAt = new Date("2026-10-01T00:00:00Z")) => ({
    id, partyId, url: "https://hooks.example.com/x", events, secretCiphertext: "x", active: true, createdAt,
  });

  it("tells the holder when an exit quote is filled", async () => {
    const { db, inserts } = outboxDb(
      new Map<unknown, unknown[]>([
        [schema.webhookSubscription, [sub("s-holder", "holder", ["exit.filled"]), sub("s-other", "other", ["exit.filled"])]],
        [schema.exitFill, [{ id: "f1", quoteId: "q1", txHash: "tx1", createdAt: new Date("2026-10-08T11:00:00Z") }]],
        [schema.exitQuote, [{ id: "q1", holderId: "holder", units: "10.0000000", usdcOut: "10.7000000" }]],
      ]),
    );
    await fanOutRecentEvents(db, now);
    expect(inserts.map((i) => `${i.values.subscriptionId}|${i.values.eventKey}`)).toEqual(["s-holder|exit_fill:f1"]);
    expect(inserts[0].values.payload).toMatchObject({ event: "exit.filled", data: { quoteId: "q1", usdcOut: "10.7000000", txHash: "tx1" } });
  });

  it("reports a liquidation as completed only once the lender has closed it", async () => {
    const line = { id: "l1", lenderId: "lender", borrowerId: "borrower" };
    const done = new Date("2026-10-08T10:00:00Z");
    const { db, inserts } = outboxDb(
      new Map<unknown, unknown[]>([
        [schema.webhookSubscription, [sub("s-lender", "lender", ["liquidation.completed"]), sub("s-borrower", "borrower", ["liquidation.completed"])]],
        [schema.creditLine, [line]],
        [schema.liquidation, [
          { id: "open", creditLineId: "l1", units: "100", proceeds: null, shortfall: null, completedAt: done },
          { id: "closed", creditLineId: "l1", units: "100", proceeds: "107.6", shortfall: "0", completedAt: done },
        ]],
      ]),
    );
    await fanOutRecentEvents(db, now);
    expect(inserts.map((i) => i.values.eventKey)).toEqual(["liquidation:closed", "liquidation:closed"]);
    expect(inserts[0].values.payload).toMatchObject({ data: { proceeds: "107.6", shortfall: "0" } });
  });

  it("announces repo leg 1 to both sides, from the settled accept transaction", async () => {
    const { db, inserts } = outboxDb(
      new Map<unknown, unknown[]>([
        [schema.webhookSubscription, [sub("s-lender", "lender", ["repo.leg1_settled"]), sub("s-borrower", "borrower", ["repo.leg1_settled"])]],
        [schema.repoTrade, [{ id: "t1", cashLenderId: "lender", cashBorrowerId: "borrower", units: "100", cashAmount: "50", maturityAt: new Date("2026-10-09T00:00:00Z") }]],
        [schema.txIntent, [
          { txHash: "accept-tx", kind: "repo.accept", status: "settled", refId: "t1", settledAt: new Date("2026-10-08T09:00:00Z") },
          { txHash: "pending-tx", kind: "repo.accept", status: "pending", refId: "t1", settledAt: null },
          { txHash: "other-tx", kind: "repo.unwind", status: "settled", refId: "t1", settledAt: new Date("2026-10-08T09:30:00Z") },
        ]],
      ]),
    );
    await fanOutRecentEvents(db, now);
    expect(inserts.map((i) => i.values.eventKey)).toEqual(["tx_intent:accept-tx", "tx_intent:accept-tx"]);
  });

  it("does not send a new subscriber what happened before it subscribed", async () => {
    const { db, inserts } = outboxDb(
      new Map<unknown, unknown[]>([
        [schema.webhookSubscription, [sub("s-new", "holder", ["exit.filled"], new Date("2026-10-08T11:30:00Z"))]],
        [schema.exitFill, [{ id: "f1", quoteId: "q1", txHash: "tx1", createdAt: new Date("2026-10-08T11:00:00Z") }]],
        [schema.exitQuote, [{ id: "q1", holderId: "holder", units: "10", usdcOut: "10" }]],
      ]),
    );
    await fanOutRecentEvents(db, now);
    expect(inserts).toHaveLength(0);
  });
});
