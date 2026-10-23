import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./index.js";

const TOKEN = "gateway-test-token-0123456789abcdef0123456789";
const AUTH = { "x-internal-token": TOKEN };

/** Minimal fake of the slice of `Database` the server touches: `db.insert(...).values(...)`. */
function fakeDb() {
  const auditRows: Array<{ actor: string; action: string; payload: Record<string, unknown> }> = [];
  const db = {
    insert: () => ({
      values: (row: { actor: string; action: string; payload: Record<string, unknown> }) => {
        auditRows.push(row);
        return Promise.resolve();
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, auditRows };
}

/**
 * The endpoints run the real adapters; only the issuer's HTTP side is stubbed, with the response
 * shapes the adapters document. (No issuer publishes this back-office API, so these shapes are the
 * contract the adapters expect — not a recording of a real service.)
 */
function stubIssuerHttp() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/sep8")) return json({ status: "success", tx: "AAAA" });
      if (url.endsWith("/v1/authorizations")) return json({ approved: true, ref: "auth-1" });
      if (url.endsWith("/v1/liens") && init?.method === "POST") return json({ lienRef: "lien-1" });
      if (url.includes("/v1/liens/")) return new Response(null, { status: 204 });
      if (url.endsWith("/v1/redemptions")) {
        return json({ redemptionRef: "redeem-1", expectedSettlementAt: Math.floor(Date.now() / 1000) + 86_400 });
      }
      return json({ error: "unexpected request" }, 500);
    }),
  );
}

beforeEach(() => {
  for (const issuer of ["SPIKO", "ETHERFUSE", "FRANKLIN"]) {
    vi.stubEnv(`${issuer}_API_BASE_URL`, `https://api.${issuer.toLowerCase()}.example`);
    vi.stubEnv(`${issuer}_API_KEY`, "test-key");
  }
  stubIssuerHttp();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("issuer-gateway internal endpoints", () => {
  it("POST /internal/issuers/spiko/authorize", async () => {
    const { db, auditRows } = fakeDb();
    const app = buildServer(db, TOKEN);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/spiko/authorize",
      headers: AUTH,
      payload: { assetCode: "EUTBL", holderAddress: "GHOLDER" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ approved: true, ref: expect.any(String) });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ actor: "issuer-gateway", action: "issuer.authorize" });
  });

  it("POST /internal/issuers/etherfuse/sep8-approve", async () => {
    const { db, auditRows } = fakeDb();
    const app = buildServer(db, TOKEN);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/etherfuse/sep8-approve",
      headers: AUTH,
      payload: { assetCode: "CETES", txXdr: "AAAA" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ approved: true, approvedTxXdr: "AAAA" });
    expect(auditRows[0]).toMatchObject({ actor: "issuer-gateway", action: "issuer.sep8_approve" });
  });

  it("POST /internal/issuers/franklin/lien-freeze", async () => {
    const { db, auditRows } = fakeDb();
    const app = buildServer(db, TOKEN);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/franklin/lien-freeze",
      headers: AUTH,
      payload: { assetCode: "BENJI", holderAddress: "GHOLDER", units: "1000000" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lienRef: expect.any(String) });
    expect(auditRows[0]).toMatchObject({ actor: "issuer-gateway", action: "issuer.lien_freeze" });
  });

  it("POST /internal/issuers/spiko/lien-release", async () => {
    const { db, auditRows } = fakeDb();
    const app = buildServer(db, TOKEN);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/spiko/lien-release",
      headers: AUTH,
      payload: { assetCode: "EUTBL", lienRef: "spiko-lien-abc123" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(auditRows[0]).toMatchObject({ actor: "issuer-gateway", action: "issuer.lien_release" });
  });

  it("POST /internal/issuers/etherfuse/redeem", async () => {
    const { db, auditRows } = fakeDb();
    const app = buildServer(db, TOKEN);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/etherfuse/redeem",
      headers: AUTH,
      payload: { assetCode: "CETES", units: "500000", destination: "GDEST" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ redemptionRef: expect.any(String), expectedSettlementAt: expect.any(Number) });
    expect(body.expectedSettlementAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(auditRows[0]).toMatchObject({ actor: "issuer-gateway", action: "issuer.redeem" });
  });

  it("returns an error, not an approval, for an issuer whose back-office is not configured", async () => {
    vi.stubEnv("SPIKO_API_BASE_URL", "");
    const { db } = fakeDb();
    const app = buildServer(db, TOKEN);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/spiko/authorize",
      headers: AUTH,
      payload: { assetCode: "EUTBL", holderAddress: "GHOLDER" },
    });

    expect(res.statusCode).toBe(500);
  });

  it("rejects an unknown issuer code with a clear error rather than a silent default", async () => {
    const { db } = fakeDb();
    const app = buildServer(db, TOKEN);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/unknown-issuer/authorize",
      headers: AUTH,
      payload: { assetCode: "X", holderAddress: "GHOLDER" },
    });

    expect(res.statusCode).toBe(500);
  });

  it("refuses every endpoint without the internal token, before touching an issuer", async () => {
    const { db, auditRows } = fakeDb();
    const app = buildServer(db, TOKEN);

    for (const headers of [{}, { "x-internal-token": "wrong-token" }]) {
      const res = await app.inject({
        method: "POST",
        url: "/internal/issuers/spiko/redeem",
        headers,
        payload: { assetCode: "EUTBL", units: "1", destination: "GDEST" },
      });
      expect(res.statusCode).toBe(401);
    }
    expect(auditRows).toHaveLength(0);
  });

  it("does not change HTTP response on audit insert failure, and logs failure at error level with issuer result", async () => {
    const errorSpy = vi.fn();
    const mockLogger = {
      error: errorSpy,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const throwingDb = {
      insert: () => ({
        values: () => Promise.reject(new Error("disk full or connection reset")),
      }),
    } as any;

    const app = buildServer(throwingDb, TOKEN, mockLogger as any);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/franklin/lien-freeze",
      headers: AUTH,
      payload: { assetCode: "BENJI", holderAddress: "GHOLDER", units: "1000000" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lienRef: "lien-1" });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "issuer.lien_freeze",
        payload: expect.objectContaining({
          issuerCode: "franklin",
          assetCode: "BENJI",
          holderAddress: "GHOLDER",
          units: "1000000",
          result: expect.objectContaining({ lienRef: "lien-1" }),
        }),
      }),
      expect.stringContaining("audit log insert failed"),
    );
  });
});
