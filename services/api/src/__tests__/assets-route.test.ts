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
  webhookHmacSecret: "test-webhook-secret",
  webhookSubscribers: [],
  institutionApiKeys: {},
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
