import { describe, expect, it } from "vitest";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { RateWindow, TIMESTAMP_TOLERANCE_S, signRequest, verifyApiKeyRequest } from "../apiKeys.js";
import { buildServer } from "../server.js";
import { signSessionToken } from "../session-token.js";
import { encryptSecret } from "../webhooks/secretBox.js";

const SECRET_KEY = "ab".repeat(32);
const KEY_ID = "bk_0123456789abcdef0123456789abcdef";
const SECRET = "c0ffee".repeat(10);
const PARTY = "33333333-3333-3333-3333-333333333333";
const ACCOUNT = "GABCDEFTESTACCOUNT";
const NOW_MS = Date.UTC(2026, 9, 8, 12, 0, 0);
const NOW_S = String(NOW_MS / 1000);

/** Stateful stand-in for the tables the API-key path touches: keys, nonces and last-used. */
function keyDb(keyOverrides: Record<string, unknown> | null = {}) {
  const nonces = new Set<string>();
  const created: Array<Record<string, unknown>> = [];
  const audit: Array<Record<string, unknown>> = [];
  const key =
    keyOverrides === null
      ? null
      : {
          id: "row-1", partyId: PARTY, stellarAccount: ACCOUNT, keyId: KEY_ID,
          secretCiphertext: encryptSecret(SECRET, SECRET_KEY), label: null, status: "active",
          createdAt: new Date(NOW_MS), lastUsedAt: null, revokedAt: null, ...keyOverrides,
        };
  const keys: unknown[] = key ? [key] : [];
  const chain = (rows: unknown[]) => {
    const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    p.where = () => chain(rows);
    p.limit = () => chain(rows);
    return p;
  };
  const db = {
    select: () => ({
      from: (table: unknown) =>
        table === schema.partyApiKey ? chain(keys) : table === schema.partyAccount
          ? chain([{ partyId: PARTY, stellarAccount: ACCOUNT, role: "borrower" }]) : chain([]),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === schema.apiKeyNonce) {
          const id = `${v.keyId}:${v.nonce}`;
          const isNew = !nonces.has(id);
          nonces.add(id);
          return { onConflictDoNothing: () => ({ returning: async () => (isNew ? [{ nonce: v.nonce }] : []) }) };
        }
        if (table === schema.partyApiKey) {
          created.push(v);
          keys.push({ id: `row-${keys.length + 1}`, status: "active", createdAt: new Date(), lastUsedAt: null, revokedAt: null, ...v });
        }
        if (table === schema.auditLog) audit.push(v);
        return Object.assign(Promise.resolve(), { returning: async () => [{ id: "x", ...v }] });
      },
    }),
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async () => { if (key) Object.assign(key, patch); } }) }),
    delete: () => ({ where: async () => undefined }),
    transaction: async (fn: (tx: any) => any) => fn(db),
    execute: async () => [{ "?column?": 1 }],
  } as unknown as Database;
  return { db, created, audit, key };
}

const base = { method: "POST", url: "/v1/credit-lines?x=1", rawBody: Buffer.from('{"limit":"5"}') };
const sign = (over: Partial<Parameters<typeof signRequest>[1]> = {}) => {
  const args = { timestamp: NOW_S, nonce: "nonce-0123456789ab", method: base.method, url: base.url, rawBody: base.rawBody, ...over };
  return { args, signature: signRequest(SECRET, args) };
};
const request = (over: Record<string, unknown> = {}) => {
  const { args, signature } = sign();
  return { keyId: KEY_ID, signature, timestamp: args.timestamp, nonce: args.nonce, method: base.method, url: base.url, rawBody: base.rawBody, ...over };
};

describe("verifyApiKeyRequest", () => {
  it("accepts a correctly signed request and returns the key's party and account", async () => {
    const { db } = keyDb();
    await expect(verifyApiKeyRequest(db, SECRET_KEY, request(), NOW_MS)).resolves.toEqual({
      ok: true, partyId: PARTY, stellarAccount: ACCOUNT, keyId: KEY_ID,
    });
  });

  it("rejects a replayed nonce", async () => {
    const { db } = keyDb();
    expect((await verifyApiKeyRequest(db, SECRET_KEY, request(), NOW_MS)).ok).toBe(true);
    await expect(verifyApiKeyRequest(db, SECRET_KEY, request(), NOW_MS)).resolves.toEqual({ ok: false, reason: "replayed" });
  });

  it("does not let a badly signed request use up a nonce", async () => {
    const { db } = keyDb();
    await verifyApiKeyRequest(db, SECRET_KEY, request({ signature: "00".repeat(32) }), NOW_MS);
    expect((await verifyApiKeyRequest(db, SECRET_KEY, request(), NOW_MS)).ok).toBe(true);
  });

  it.each([
    ["a changed body", { rawBody: Buffer.from('{"limit":"500"}') }, "bad_signature"],
    ["a different path", { url: "/v1/credit-lines/1/draws" }, "bad_signature"],
    ["a different query", { url: "/v1/credit-lines?x=2" }, "bad_signature"],
    ["a different method", { method: "DELETE" }, "bad_signature"],
    ["a different nonce than was signed", { nonce: "another-nonce-0123456" }, "bad_signature"],
    ["a malformed nonce", { nonce: "short" }, "bad_nonce"],
    ["a missing timestamp", { timestamp: undefined }, "bad_timestamp"],
    ["an unknown key", { keyId: "bk_nope" }, "unknown_key"],
  ])("rejects %s", async (_label, over, reason) => {
    const { db } = keyDb(reason === "unknown_key" ? null : {});
    await expect(verifyApiKeyRequest(db, SECRET_KEY, request(over), NOW_MS)).resolves.toEqual({ ok: false, reason });
  });

  it("rejects timestamps outside the tolerance, past and future", async () => {
    const { db } = keyDb();
    for (const skew of [-(TIMESTAMP_TOLERANCE_S + 1), TIMESTAMP_TOLERANCE_S + 1]) {
      const timestamp = String(NOW_MS / 1000 + skew);
      const { signature } = sign({ timestamp });
      await expect(verifyApiKeyRequest(db, SECRET_KEY, request({ timestamp, signature }), NOW_MS)).resolves.toEqual({
        ok: false, reason: "stale_timestamp",
      });
    }
  });

  it("rejects a revoked key", async () => {
    const { db } = keyDb({ status: "revoked" });
    await expect(verifyApiKeyRequest(db, SECRET_KEY, request(), NOW_MS)).resolves.toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects a signature made under another secret", async () => {
    const { db } = keyDb();
    const args = { timestamp: NOW_S, nonce: "nonce-0123456789ab", method: base.method, url: base.url, rawBody: base.rawBody };
    await expect(
      verifyApiKeyRequest(db, SECRET_KEY, request({ signature: signRequest("attacker-secret", args) }), NOW_MS),
    ).resolves.toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("RateWindow", () => {
  it("allows up to the limit per key and window, then refuses, then resets", () => {
    const w = new RateWindow(2, 1000);
    expect([w.hit("a", 0), w.hit("a", 1), w.hit("a", 2)]).toEqual([true, true, false]);
    expect(w.hit("b", 2)).toBe(true);
    expect(w.hit("a", 1001)).toBe(true);
  });
});

describe("API-key requests through the server", () => {
  const config: ApiConfig = {
    port: 0, jwtSigningSecret: "test-signing-key",
    sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    sep10HomeDomain: "localhost", sep10WebAuthDomain: "localhost",
    networkPassphrase: "Test SDF Network ; September 2015",
    webhookSecretKey: SECRET_KEY, apiKeySecretKey: SECRET_KEY, consoleOrigin: "http://localhost:5173",
 complianceEnforced: false,
  };
  const session = { authorization: `Bearer ${signSessionToken(ACCOUNT, config.jwtSigningSecret)}` };
  const headersFor = (method: string, url: string, body: string, nonce: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      "x-api-key": KEY_ID, "x-timestamp": timestamp, "x-nonce": nonce,
      "x-signature": signRequest(SECRET, { timestamp, nonce, method, url, rawBody: body }),
    };
  };

  it("authenticates a signed request and refuses an exact replay", async () => {
    const { db } = keyDb();
    const app = buildServer({ config, db, contracts: {} as ContractClients });
    const url = "/v1/api-keys";
    const headers = headersFor("GET", url, "", "nonce-aaaaaaaaaaaaaaaa");

    const first = await app.inject({ method: "GET", url, headers });
    const replay = await app.inject({ method: "GET", url, headers });

    // Authenticated (not 401), but key management is session-only, so the key is turned away.
    expect(first.statusCode).toBe(403);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toMatch(/replayed/);
  });

  it("verifies against the raw body bytes the client sent", async () => {
    const { db } = keyDb();
    const app = buildServer({ config, db, contracts: {} as ContractClients });
    const body = '{ "label" :  "spacing  matters" }';
    const headers = { ...headersFor("POST", "/v1/api-keys", body, "nonce-bbbbbbbbbbbbbbbb"), "content-type": "application/json" };

    const ok = await app.inject({ method: "POST", url: "/v1/api-keys", headers, payload: body });
    expect(ok.statusCode).toBe(403); // authenticated, then refused as a non-session caller

    const tampered = await app.inject({
      method: "POST", url: "/v1/api-keys",
      headers: { ...headersFor("POST", "/v1/api-keys", body, "nonce-cccccccccccccccc"), "content-type": "application/json" },
      payload: body.replace("spacing", "spacing "),
    });
    expect(tampered.statusCode).toBe(401);
  });

  it("locks an address out after repeated failed attempts", async () => {
    const { db } = keyDb();
    const app = buildServer({ config, db, contracts: {} as ContractClients });
    const bad = { "x-api-key": "bk_unknown", "x-signature": "00", "x-timestamp": NOW_S, "x-nonce": "nonce-dddddddddddddddd" };
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await app.inject({ method: "GET", url: "/v1/positions?party=x", headers: bad })).statusCode;
    expect(last).toBe(429);
  });

  it("creates a key from a session, shows the secret once and never lists it", async () => {
    const { db, created, audit } = keyDb(null);
    const app = buildServer({ config, db, contracts: {} as ContractClients });

    const res = await app.inject({ method: "POST", url: "/v1/api-keys", headers: session, payload: { label: "ops" } });
    expect(res.statusCode).toBe(201);
    const { keyId, secret } = res.json();
    expect(keyId).toMatch(/^bk_[0-9a-f]{32}$/);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created[0].secretCiphertext).not.toContain(secret);
    expect(audit[0]).toMatchObject({ action: "api_key.create" });

    const listed = await app.inject({ method: "GET", url: "/v1/api-keys", headers: session });
    expect(listed.json().keys).toHaveLength(1);
    expect(JSON.stringify(listed.json())).not.toContain(secret);
    expect(JSON.stringify(listed.json())).not.toMatch(/ciphertext/i);
  });

  it("refuses to create keys while no encryption key is configured", async () => {
    const { db } = keyDb(null);
    const app = buildServer({ config: { ...config, apiKeySecretKey: "" }, db, contracts: {} as ContractClients });
    const res = await app.inject({ method: "POST", url: "/v1/api-keys", headers: session, payload: {} });
    expect(res.statusCode).toBe(503);
  });

  it("leaves exactly 10 active keys when 15 creates are sent concurrently", async () => {
    const { db, created } = keyDb(null);
    const app = buildServer({ config, db, contracts: {} as ContractClients });

    const requests = Array.from({ length: 15 }, (_, i) =>
      app.inject({
        method: "POST",
        url: "/v1/api-keys",
        headers: session,
        payload: { label: `key-${i}` },
      }),
    );

    const responses = await Promise.all(requests);
    const successes = responses.filter((r) => r.statusCode === 201);
    const conflicts = responses.filter((r) => r.statusCode === 409);

    expect(successes).toHaveLength(10);
    expect(conflicts).toHaveLength(5);
    expect(created).toHaveLength(10);
    for (const c of conflicts) {
      expect(c.json()).toEqual({ error: "at most 10 active API keys per party" });
    }
  });

  it("revokes a key and audits it", async () => {
    const { db, audit, key } = keyDb();
    const app = buildServer({ config, db, contracts: {} as ContractClients });
    const res = await app.inject({ method: "DELETE", url: `/v1/api-keys/${KEY_ID}`, headers: session });
    expect(res.statusCode).toBe(204);
    expect(key!.status).toBe("revoked");
    expect(audit[0]).toMatchObject({ action: "api_key.revoke" });
  });

  it("is idempotent: second revoke returns 204 without updating revokedAt or adding duplicate audit log", async () => {
    const { db, audit, key } = keyDb();
    const app = buildServer({ config, db, contracts: {} as ContractClients });

    const first = await app.inject({ method: "DELETE", url: `/v1/api-keys/${KEY_ID}`, headers: session });
    expect(first.statusCode).toBe(204);
    const originalRevokedAt = key!.revokedAt;
    expect(audit).toHaveLength(1);

    const second = await app.inject({ method: "DELETE", url: `/v1/api-keys/${KEY_ID}`, headers: session });
    expect(second.statusCode).toBe(204);
    expect(key!.revokedAt).toEqual(originalRevokedAt);
    expect(audit).toHaveLength(1);
  });
});

describe("client address behind a proxy", () => {
  const config: ApiConfig = {
    port: 0, jwtSigningSecret: "test-signing-key",
    sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    sep10HomeDomain: "localhost", sep10WebAuthDomain: "localhost",
    networkPassphrase: "Test SDF Network ; September 2015",
    webhookSecretKey: SECRET_KEY, apiKeySecretKey: SECRET_KEY, complianceEnforced: false, consoleOrigin: "http://localhost:5173",
  };
  const bad = (ip: string) => ({
    "x-api-key": "bk_unknown", "x-signature": "00", "x-timestamp": NOW_S, "x-nonce": "nonce-eeeeeeeeeeeeeeee", "x-forwarded-for": ip,
  });
  const hammer = async (app: ReturnType<typeof buildServer>, ip: string) => {
    let last = 0;
    for (let i = 0; i < 32; i++) last = (await app.inject({ method: "GET", url: "/v1/positions?party=x", headers: bad(ip) })).statusCode;
    return last;
  };

  it("with TRUST_PROXY, one abusive client is locked out without locking out anyone else", async () => {
    const app = buildServer({ config: { ...config, trustProxy: true }, db: keyDb().db, contracts: {} as ContractClients });
    expect(await hammer(app, "203.0.113.7")).toBe(429);
    const other = await app.inject({ method: "GET", url: "/v1/positions?party=x", headers: bad("198.51.100.9") });
    expect(other.statusCode).toBe(401); // refused for a bad key, not for being locked out
  });

  it("without it, X-Forwarded-For is ignored, so a client cannot choose its own address", async () => {
    const app = buildServer({ config, db: keyDb().db, contracts: {} as ContractClients });
    expect(await hammer(app, "203.0.113.7")).toBe(429);
    // A different claimed address does not escape the lockout: they all look like the same caller.
    const other = await app.inject({ method: "GET", url: "/v1/positions?party=x", headers: bad("198.51.100.9") });
    expect(other.statusCode).toBe(429);
  });
});
