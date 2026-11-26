import { describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { signSessionToken } from "../session-token.js";

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

const PARTY = { partyId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", account: "GCALLER" };
const OTHER_PARTY = { partyId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", account: "GOTHER" };
const TX_HASH = "abcd1234ef567890";
const bearer = (account: string) => ({
  authorization: `Bearer ${signSessionToken(account, config.jwtSigningSecret)}`,
});

function createMockDb(intents: Array<Record<string, unknown>>) {
  const chainRows = (data: unknown[]): any => {
    const promise: any = Promise.resolve(data);
    promise.where = () => chainRows(data);
    promise.orderBy = () => chainRows(data);
    promise.limit = () => chainRows(data);
    return promise;
  };

  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.partyAccount) {
          return chainRows([
            { partyId: PARTY.partyId, stellarAccount: PARTY.account, role: "borrower" },
            { partyId: OTHER_PARTY.partyId, stellarAccount: OTHER_PARTY.account, role: "lender" },
          ]);
        }
        if (table === schema.txIntent) {
          return {
            where: () => ({
              limit: (n: number) => Promise.resolve(intents.slice(0, n)),
            }),
          };
        }
        return chainRows([]);
      },
    }),
  } as unknown as Database;
}

describe("GET /v1/tx/:hash", () => {
  it("returns stored status without calling chain.outcome", async () => {
    const now = new Date();
    const storedIntent = {
      txHash: TX_HASH,
      kind: "credit_line.open",
      refId: "line-123",
      partyId: PARTY.partyId,
      status: "settled",
      ledger: 54321,
      error: null,
      createdAt: now,
      settledAt: now,
    };

    const outcomeSpy = vi.fn();
    const chain = { outcome: outcomeSpy } as unknown as ChainGateway;
    const db = createMockDb([storedIntent]);

    const app = buildServer({ config, db, contracts: {} as ContractClients, chain });

    const res = await app.inject({
      method: "GET",
      url: `/v1/tx/${TX_HASH}`,
      headers: bearer(PARTY.account),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      txHash: TX_HASH,
      kind: "credit_line.open",
      refId: "line-123",
      status: "settled",
      ledger: 54321,
      createdAt: now.toISOString(),
      settledAt: now.toISOString(),
    });
    // Crucial check: chain.outcome must NOT be called for read-only GET
    expect(outcomeSpy).not.toHaveBeenCalled();
  });

  it("returns 404 for a transaction belonging to another party or not found", async () => {
    const foreignIntent = {
      txHash: TX_HASH,
      kind: "credit_line.open",
      refId: "line-123",
      partyId: OTHER_PARTY.partyId,
      status: "pending",
      ledger: null,
      error: null,
      createdAt: new Date(),
      settledAt: null,
    };

    const outcomeSpy = vi.fn();
    const chain = { outcome: outcomeSpy } as unknown as ChainGateway;
    const db = createMockDb([foreignIntent]);

    const app = buildServer({ config, db, contracts: {} as ContractClients, chain });

    const res = await app.inject({
      method: "GET",
      url: `/v1/tx/${TX_HASH}`,
      headers: bearer(PARTY.account),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not a transaction this API built for you" });
    expect(outcomeSpy).not.toHaveBeenCalled();
  });
});
