import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { signSessionToken } from "../session-token.js";
import { buildServer } from "../server.js";
import { createFakeDb } from "./fake-db.js";

const PREVIOUS_ENABLE_DEV_LOGIN = process.env.ENABLE_DEV_LOGIN;
beforeAll(() => {
  process.env.ENABLE_DEV_LOGIN = "true";
});
afterAll(() => {
  process.env.ENABLE_DEV_LOGIN = PREVIOUS_ENABLE_DEV_LOGIN;
});

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

const LENDER_PARTY_ID = "44444444-4444-4444-4444-444444444444";
const LENDER_ACCOUNT = "GLENDERACCOUNT";
const LINE_ID = "55555555-5555-5555-5555-555555555555";

function tokenFor(stellarAccount: string) {
  return signSessionToken(stellarAccount, config.jwtSigningSecret);
}

describe("Fastify ZodError handler", () => {
  it("returns 400 with { error: 'invalid request', issues } when POST /v1/credit-lines/:id/fund has invalid body", async () => {
    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.partyAccount, [{ partyId: LENDER_PARTY_ID, stellarAccount: LENDER_ACCOUNT, role: "lender" }]],
        [
          schema.creditLine,
          [{ id: LINE_ID, lenderId: LENDER_PARTY_ID, borrowerId: "other-party", contractLineId: "1", status: "open" }],
        ],
      ]),
    );
    const app = buildServer({
      config,
      db,
      contracts: { creditLine: { fund: vi.fn() } } as unknown as ContractClients,
      chain: { txHash: () => "hash" } as unknown as ChainGateway,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/credit-lines/${LINE_ID}/fund`,
      headers: { authorization: `Bearer ${tokenFor(LENDER_ACCOUNT)}` },
      payload: { amount: "not-a-number" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid request");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("returns 400 with { error: 'invalid request', issues } when POST /v1/auth/dev-login has empty body", async () => {
    const db = createFakeDb(new Map());
    const app = buildServer({
      config,
      db,
      contracts: {} as ContractClients,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid request");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("leaves non-Zod errors to return 500", async () => {
    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.partyAccount, [{ partyId: LENDER_PARTY_ID, stellarAccount: LENDER_ACCOUNT, role: "lender" }]],
        [
          schema.creditLine,
          [{ id: LINE_ID, lenderId: LENDER_PARTY_ID, borrowerId: "other-party", contractLineId: "1", status: "open" }],
        ],
      ]),
    );
    const app = buildServer({
      config,
      db,
      contracts: {
        creditLine: {
          fund: vi.fn().mockRejectedValue(new Error("unexpected database or contract failure")),
        },
      } as unknown as ContractClients,
      chain: { txHash: () => "hash" } as unknown as ChainGateway,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/credit-lines/${LINE_ID}/fund`,
      headers: { authorization: `Bearer ${tokenFor(LENDER_ACCOUNT)}` },
      payload: { amount: "100000000000" },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.statusCode).toBe(500);
    expect(body.error).toBe("Internal Server Error");
  });
});
