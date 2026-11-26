import { describe, expect, it } from "vitest";
import { schema } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { createFakeDb } from "./fake-db.js";

const config: ApiConfig = {
  port: 0,
  jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  sep10HomeDomain: "localhost",
  sep10WebAuthDomain: "localhost",
  networkPassphrase: "Test SDF Network ; September 2015",
  webhookSecretKey: "00".repeat(32),
  apiKeySecretKey: "00".repeat(32),
  complianceEnforced: false,
  consoleOrigin: "http://localhost:5173",
};

describe("GET /v1/assets", () => {
  it("returns a well-formed asset list against a mocked db layer", async () => {
    const assetRow = {
      id: "11111111-1111-1111-1111-111111111111",
      code: "RWA1",
      issuerG: "GISSUER",
      contractC: "CCONTRACT",
      standard: "classic_sac",
      yieldType: "accumulating",
      custodyMode: "escrow",
      ccy: "USD",
      redemptionLagDays: 2,
      redemptionDailyCap: "1000000",
      navSchedule: "daily",
      priceBandBps: 100,
      dailyMoveBandBps: 200,
      haircutBaseBps: 500,
      haircutFxBps: 50,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const snapshotRow = {
      id: "22222222-2222-2222-2222-222222222222",
      assetId: assetRow.id,
      guardedValue: "1.0500000",
      status: "Ok",
      sources: [],
      ledger: 100,
      createdAt: new Date("2026-01-02T00:00:00Z"),
    };

    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.asset, [assetRow]],
        [schema.priceSnapshot, [snapshotRow]],
      ]),
    );

    const app = buildServer({ config, db, contracts: {} as ContractClients });

    const res = await app.inject({ method: "GET", url: "/v1/assets" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0]).toMatchObject({
      id: assetRow.id,
      code: "RWA1",
      ccy: "USD",
      haircutBps: 550,
      status: "active",
      price: { value: "1.0500000", status: "Ok" },
    });
  });
});

describe("GET /v1/assets/:id/price", () => {
  const assetId = "11111111-1111-1111-1111-111111111111";
  const assetRow = {
    id: assetId,
    code: "RWA1",
    status: "active",
  };

  const snapshots = Array.from({ length: 60 }, (_, i) => ({
    id: `snap-${i}`,
    assetId,
    guardedValue: `1.0${String(i).padStart(5, "0")}`,
    status: "Ok",
    sources: [{ source: "redstone", value: "1.0" }],
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, i, 0)),
  }));

  function extractDateBounds(sqlObj: any): { from?: Date; to?: Date } {
    const bounds: { from?: Date; to?: Date } = {};
    function walk(node: any, op?: string) {
      if (!node) return;
      if (node && typeof node.value?.getTime === "function") {
        if (op === ">=") bounds.from = node.value;
        if (op === "<=") bounds.to = node.value;
      }
      if (node && typeof node.getTime === "function") {
        if (op === ">=") bounds.from = node;
        if (op === "<=") bounds.to = node;
      }
      if (Array.isArray(node.queryChunks)) {
        let currentOp = op;
        for (const chunk of node.queryChunks) {
          if (chunk?.value && Array.isArray(chunk.value)) {
            const str = chunk.value.join("");
            if (str.includes(">=")) currentOp = ">=";
            else if (str.includes("<=")) currentOp = "<=";
          } else {
            walk(chunk, currentOp);
          }
        }
      }
    }
    walk(sqlObj);
    return bounds;
  }

  const mockDb = {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.asset) {
          return {
            where: () => ({
              limit: () => Promise.resolve([assetRow]),
            }),
          };
        }
        if (table === schema.priceSnapshot) {
          return {
            where: (condition: any) => ({
              orderBy: () => ({
                limit: (n: number) => {
                  const bounds = extractDateBounds(condition);
                  let filtered = [...snapshots];
                  if (bounds.from) {
                    filtered = filtered.filter((s) => s.createdAt >= bounds.from!);
                  }
                  if (bounds.to) {
                    filtered = filtered.filter((s) => s.createdAt <= bounds.to!);
                  }
                  filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
                  return Promise.resolve(filtered.slice(0, n));
                },
              }),
            }),
          };
        }
        return { where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) };
      },
    }),
  } as unknown as ReturnType<typeof createFakeDb>;

  const app = buildServer({ config, db: mockDb, contracts: {} as ContractClients });

  it("returns default 50 snapshots and latest reading when no query parameters are provided", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/assets/${assetId}/price` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assetId).toBe(assetId);
    expect(body.history).toHaveLength(50);
    expect(body.value).toBe(snapshots[59].guardedValue);
    expect(body.status).toBe("Ok");
  });

  it("respects limit parameter (1-500)", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/assets/${assetId}/price?limit=5` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.history).toHaveLength(5);
  });

  it("respects from and to time window parameters", async () => {
    const from = "2026-01-01T00:10:00.000Z";
    const to = "2026-01-01T00:20:00.000Z";
    const res = await app.inject({
      method: "GET",
      url: `/v1/assets/${assetId}/price?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Minutes 10 through 20 inclusive = 11 snapshots
    expect(body.history).toHaveLength(11);
    for (const snap of body.history) {
      expect(new Date(snap.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(from).getTime());
      expect(new Date(snap.createdAt).getTime()).toBeLessThanOrEqual(new Date(to).getTime());
    }
  });

  it("rejects invalid limit values with 400", async () => {
    const resZero = await app.inject({ method: "GET", url: `/v1/assets/${assetId}/price?limit=0` });
    expect(resZero.statusCode).toBe(400);

    const resOver = await app.inject({ method: "GET", url: `/v1/assets/${assetId}/price?limit=501` });
    expect(resOver.statusCode).toBe(400);

    const resNaN = await app.inject({ method: "GET", url: `/v1/assets/${assetId}/price?limit=foo` });
    expect(resNaN.statusCode).toBe(400);
  });

  it("rejects invalid from/to dates with 400", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/assets/${assetId}/price?from=not-a-date` });
    expect(res.statusCode).toBe(400);
  });
});
