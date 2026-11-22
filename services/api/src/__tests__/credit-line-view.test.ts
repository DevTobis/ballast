import { describe, expect, it, vi } from "vitest";
import { schema } from "@ballast/db";
import type { ApiConfig } from "../config.js";
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

const PARTY = { partyId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", account: "GBORROWER" };
const LINE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const bearer = () => ({ authorization: `Bearer ${signSessionToken(PARTY.account, config.jwtSigningSecret)}` });

describe("GET /v1/credit-lines/:id accrued interest and breach info", () => {
  it("returns accruedInterest, onChainStatus and breachLedger when on-chain read succeeds", async () => {
    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.partyAccount, [{ partyId: PARTY.partyId, stellarAccount: PARTY.account, role: "borrower" }]],
        [
          schema.creditLine,
          [
            {
              id: LINE_ID,
              lenderId: "lender-party",
              borrowerId: PARTY.partyId,
              loanCcy: "USDC",
              limitAmount: "100.0000000",
              rateBps: 500,
              feeBps: 50,
              cureWindowS: 86400,
              status: "active",
              contractLineId: "123",
            },
          ],
        ],
        [schema.pledge, []],
        [schema.draw, []],
        [schema.repayment, []],
      ]),
    );

    const contracts = {
      creditLine: {
        ltv: vi.fn().mockResolvedValue({
          debt: 10_000_000n,
          ltvBps: 2500,
          state: "Healthy",
          priceStatus: "Ok",
          collateralValue: 40_000_000n,
        }),
        line: vi.fn().mockResolvedValue({
          lender: "GLENDER",
          borrower: PARTY.account,
          asset: "CASSET",
          limit: 100_000_000n,
          funded: 50_000_000n,
          drawn: 10_000_000n,
          pledgedUnits: 40_000_000n,
          accruedInterest: 1_234_567n,
          status: "Open",
          breachLedger: 98765,
        }),
        claimableInterest: vi.fn().mockResolvedValue(0n),
      },
    } as unknown as ContractClients;

    const app = buildServer({ config, db, contracts });
    const res = await app.inject({ method: "GET", url: `/v1/credit-lines/${LINE_ID}`, headers: bearer() });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accruedInterest).toBe("1234567");
    expect(body.onChainStatus).toBe("Open");
    expect(body.breachLedger).toBe(98765);
  });

  it("returns null for accruedInterest, onChainStatus and breachLedger on fallback", async () => {
    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.partyAccount, [{ partyId: PARTY.partyId, stellarAccount: PARTY.account, role: "borrower" }]],
        [
          schema.creditLine,
          [
            {
              id: LINE_ID,
              lenderId: "lender-party",
              borrowerId: PARTY.partyId,
              loanCcy: "USDC",
              limitAmount: "100.0000000",
              rateBps: 500,
              feeBps: 50,
              cureWindowS: 86400,
              status: "active",
              contractLineId: "123",
            },
          ],
        ],
        [schema.pledge, []],
        [schema.draw, []],
        [schema.repayment, []],
      ]),
    );

    const contracts = {
      creditLine: {
        ltv: vi.fn().mockRejectedValue(new Error("RPC timeout")),
        line: vi.fn().mockRejectedValue(new Error("RPC timeout")),
      },
    } as unknown as ContractClients;

    const app = buildServer({ config, db, contracts });
    const res = await app.inject({ method: "GET", url: `/v1/credit-lines/${LINE_ID}`, headers: bearer() });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accruedInterest).toBeNull();
    expect(body.onChainStatus).toBeNull();
    expect(body.breachLedger).toBeNull();
  });
});
