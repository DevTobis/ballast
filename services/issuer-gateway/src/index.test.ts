import { describe, expect, it } from "vitest";
import { buildServer } from "./index.js";

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

describe("issuer-gateway internal endpoints (mock adapters, ISSUER_GATEWAY_MODE=mock)", () => {
  it("POST /internal/issuers/spiko/authorize", async () => {
    const { db, auditRows } = fakeDb();
    const app = buildServer(db);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/spiko/authorize",
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
    const app = buildServer(db);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/etherfuse/sep8-approve",
      payload: { assetCode: "CETES", txXdr: "AAAA" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ approved: true, approvedTxXdr: "AAAA" });
    expect(auditRows[0]).toMatchObject({ actor: "issuer-gateway", action: "issuer.sep8_approve" });
  });

  it("POST /internal/issuers/franklin/lien-freeze", async () => {
    const { db, auditRows } = fakeDb();
    const app = buildServer(db);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/franklin/lien-freeze",
      payload: { assetCode: "BENJI", holderAddress: "GHOLDER", units: "1000000" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lienRef: expect.any(String) });
    expect(auditRows[0]).toMatchObject({ actor: "issuer-gateway", action: "issuer.lien_freeze" });
  });

  it("POST /internal/issuers/spiko/lien-release", async () => {
    const { db, auditRows } = fakeDb();
    const app = buildServer(db);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/spiko/lien-release",
      payload: { assetCode: "EUTBL", lienRef: "spiko-lien-abc123" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(auditRows[0]).toMatchObject({ actor: "issuer-gateway", action: "issuer.lien_release" });
  });

  it("POST /internal/issuers/etherfuse/redeem", async () => {
    const { db, auditRows } = fakeDb();
    const app = buildServer(db);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/etherfuse/redeem",
      payload: { assetCode: "CETES", units: "500000", destination: "GDEST" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ redemptionRef: expect.any(String), expectedSettlementAt: expect.any(Number) });
    expect(body.expectedSettlementAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(auditRows[0]).toMatchObject({ actor: "issuer-gateway", action: "issuer.redeem" });
  });

  it("rejects an unknown issuer code with a clear error rather than a silent default", async () => {
    const { db } = fakeDb();
    const app = buildServer(db);

    const res = await app.inject({
      method: "POST",
      url: "/internal/issuers/unknown-issuer/authorize",
      payload: { assetCode: "X", holderAddress: "GHOLDER" },
    });

    expect(res.statusCode).toBe(500);
  });
});
