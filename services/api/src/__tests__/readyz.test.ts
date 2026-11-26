import { describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { createFakeDb } from "./fake-db.js";

const config: ApiConfig = {
  port: 0,
  jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  sep10HomeDomain: "localhost",
  sep10WebAuthDomain: "localhost",
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  webhookSecretKey: "00".repeat(32),
  apiKeySecretKey: "00".repeat(32),
  complianceEnforced: false,
  consoleOrigin: "http://localhost:5173",
};

describe("GET /readyz", () => {
  it("returns 200 when both database and RPC checks pass", async () => {
    const db = createFakeDb(new Map());
    const chain = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
    } as unknown as ChainGateway;

    const app = buildServer({ config, db, contracts: {} as ContractClients, chain });
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      dependencies: {
        database: "ok",
        rpc: "ok",
      },
    });
  });

  it("returns 503 when the database check fails", async () => {
    const db = {
      ...createFakeDb(new Map()),
      execute: vi.fn().mockRejectedValue(new Error("postgres://user:secret@localhost:5432/ballast connection failed")),
    } as unknown as Database;
    const chain = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
    } as unknown as ChainGateway;

    const app = buildServer({ config, db, contracts: {} as ContractClients, chain });
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body).toEqual({
      ok: false,
      dependencies: {
        database: "failed",
        rpc: "ok",
      },
    });
    // Ensure connection string or credentials are never leaked
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("returns 503 when the RPC check fails", async () => {
    const db = createFakeDb(new Map());
    const chain = {
      getLatestLedger: vi.fn().mockRejectedValue(new Error("https://secret-rpc-key@rpc.stellar.org failed")),
    } as unknown as ChainGateway;

    const app = buildServer({ config, db, contracts: {} as ContractClients, chain });
    const res = await app.inject({ method: "GET", url: "/readyz" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body).toEqual({
      ok: false,
      dependencies: {
        database: "ok",
        rpc: "failed",
      },
    });
    // Ensure rpc credentials are never leaked
    expect(JSON.stringify(body)).not.toContain("secret-rpc-key");
  });

  it("treats a dependency it cannot check as failed, not ok", async () => {
    const db = createFakeDb(new Map());
    const app = buildServer({ config, db, contracts: {} as ContractClients, chain: {} as ChainGateway });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, dependencies: { database: "ok", rpc: "failed" } });
  });
});
