import { describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
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

const LENDER_PARTY_ID = "44444444-4444-4444-4444-444444444444";
const LENDER_ACCOUNT = "GLENDERACCOUNT";
const LINE_ID = "55555555-5555-5555-5555-555555555555";

function tokenFor(stellarAccount: string) {
  return jwt.sign({ sub: stellarAccount }, config.jwtSigningSecret);
}

describe("POST /v1/credit-lines/:id/fund", () => {
  it("builds unsigned XDR when the caller is this line's lender", async () => {
    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.partyAccount, [{ partyId: LENDER_PARTY_ID, stellarAccount: LENDER_ACCOUNT, role: "lender" }]],
        [
          schema.creditLine,
          [{ id: LINE_ID, lenderId: LENDER_PARTY_ID, borrowerId: "other-party", contractLineId: "1", status: "open" }],
        ],
      ]),
    );
    const fund = vi.fn().mockResolvedValue("unsigned-fund-xdr");
    const app = buildServer({
      config,
      db,
      contracts: { creditLine: { fund } } as unknown as ContractClients,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/credit-lines/${LINE_ID}/fund`,
      headers: { authorization: `Bearer ${tokenFor(LENDER_ACCOUNT)}` },
      payload: { amount: "100000000000" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ xdr: "unsigned-fund-xdr" });
    expect(fund).toHaveBeenCalledWith(LENDER_ACCOUNT, 1n, 100000000000n);
  });

  it("rejects a caller who is not this line's lender", async () => {
    const otherAccount = "GNOTTHELENDER";
    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [
          schema.partyAccount,
          [{ partyId: "not-the-lender-party", stellarAccount: otherAccount, role: "borrower" }],
        ],
        [
          schema.creditLine,
          [{ id: LINE_ID, lenderId: LENDER_PARTY_ID, borrowerId: "other-party", contractLineId: "1", status: "open" }],
        ],
      ]),
    );
    const fund = vi.fn();
    const app = buildServer({
      config,
      db,
      contracts: { creditLine: { fund } } as unknown as ContractClients,
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/credit-lines/${LINE_ID}/fund`,
      headers: { authorization: `Bearer ${tokenFor(otherAccount)}` },
      payload: { amount: "100000000000" },
    });

    expect(res.statusCode).toBe(403);
    expect(fund).not.toHaveBeenCalled();
  });
});
