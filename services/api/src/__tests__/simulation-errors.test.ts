import { describe, expect, it, vi } from "vitest";
import { schema } from "@ballast/db";
import { ContractRejectedError } from "@ballast/contract-clients";
import type { ApiConfig } from "../config.js";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { signSessionToken } from "../session-token.js";
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

const BORROWER = { partyId: "33333333-3333-3333-3333-333333333333", account: "GBORROWERACCOUNT" };
const LINE_ID = "55555555-5555-5555-5555-555555555555";
const chain = { txHash: () => "tx-hash" } as unknown as ChainGateway;
const bearer = (account: string) => ({ authorization: `Bearer ${signSessionToken(account, config.jwtSigningSecret)}` });

function server(creditLineOverrides: Record<string, unknown> = {}) {
  const creditLine = {
    draw: vi.fn(),
    ...creditLineOverrides,
  };
  const db = createFakeDb(
    new Map<unknown, unknown[]>([
      [schema.partyAccount, [{ partyId: BORROWER.partyId, stellarAccount: BORROWER.account, role: "borrower" }]],
      [
        schema.creditLine,
        [
          {
            id: LINE_ID,
            lenderId: "lender-party",
            borrowerId: BORROWER.partyId,
            contractLineId: "7",
            status: "open",
          },
        ],
      ],
      [schema.auditLog, []],
      [schema.txIntent, []],
    ]),
  );
  const app = buildServer({ config, db, contracts: { creditLine } as unknown as ContractClients, chain });
  return { app, creditLine };
}

describe("Simulation errors mapping on contract routes", () => {
  it("maps a simulated contract panic to 422 with contract message and no stack or rpc url", async () => {
    const { app, creditLine } = server({
      draw: vi.fn().mockRejectedValue(new ContractRejectedError("HostError: Error(Contract, #1)")),
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/credit-lines/${LINE_ID}/draws`,
      headers: bearer(BORROWER.account),
      payload: { amount: "100000000", to: BORROWER.account },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body).toEqual({
      error: "contract rejected the request",
      detail: "HostError: Error(Contract, #1)",
    });
    expect(body.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("https://");
    expect(creditLine.draw).toHaveBeenCalled();
  });

  it("maps simulated contract failure from error message to 422 without leaking stack or URLs", async () => {
    const { app, creditLine } = server({
      draw: vi.fn().mockRejectedValue(new Error("HostError: Error(Contract, #42)")),
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/credit-lines/${LINE_ID}/draws`,
      headers: bearer(BORROWER.account),
      payload: { amount: "100000000", to: BORROWER.account },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("contract rejected the request");
    expect(body.detail).toBe("HostError: Error(Contract, #42)");
    expect(body.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("https://");
    expect(creditLine.draw).toHaveBeenCalled();
  });

  it("maps an RPC timeout to 502/503 without leaking stack or rpc URLs", async () => {
    const { app, creditLine } = server({
      draw: vi.fn().mockRejectedValue(new Error("fetch failed: request timed out to https://rpc.testnet.stellar.org/soroban/rpc")),
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/credit-lines/${LINE_ID}/draws`,
      headers: bearer(BORROWER.account),
      payload: { amount: "100000000", to: BORROWER.account },
    });

    expect([502, 503]).toContain(res.statusCode);
    const body = res.json();
    expect(body.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("https://rpc.testnet.stellar.org");
    expect(creditLine.draw).toHaveBeenCalled();
  });
});
