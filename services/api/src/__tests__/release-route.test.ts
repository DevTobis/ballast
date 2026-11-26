import { describe, expect, it, vi } from "vitest";
import { schema } from "@ballast/db";
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

const BORROWER = { partyId: "66666666-6666-6666-6666-666666666666", account: "GBORROWERACCOUNT" };
const LINE_ID = "77777777-7777-7777-7777-777777777777";
const ASSET_ID = "88888888-8888-8888-8888-888888888888";
const RELEASED = "p-released";
const chain = { txHash: () => "tx-hash" } as unknown as ChainGateway;
const bearer = () => ({ authorization: `Bearer ${signSessionToken(BORROWER.account, config.jwtSigningSecret)}` });

/**
 * 200 units are being released and 800 stay. At a $1.00 price and no haircut the remaining
 * collateral is worth 800, so the contract's threshold (80%) breaks above 640 of debt.
 * Postgres only knows the 500 of principal drawn: 500 / 800 = 62.5%, which passes.
 */
function server(creditLine: Record<string, unknown>) {
  const contracts = {
    creditLine,
    pledgeVault: { release: vi.fn().mockResolvedValue("xdr-release") },
  } as unknown as ContractClients;
  const db = createFakeDb(
    new Map<unknown, unknown[]>([
      [schema.partyAccount, [{ partyId: BORROWER.partyId, stellarAccount: BORROWER.account, role: "borrower" }]],
      [schema.creditLine, [{ id: LINE_ID, lenderId: "lender-party", borrowerId: BORROWER.partyId, contractLineId: "7", status: "open" }]],
      [
        schema.pledge,
        [
          { id: RELEASED, creditLineId: LINE_ID, assetId: ASSET_ID, units: "200.0000000", status: "active" },
          { id: "p-kept", creditLineId: LINE_ID, assetId: ASSET_ID, units: "800.0000000", status: "active" },
        ],
      ],
      [schema.asset, [{ id: ASSET_ID, contractC: "CASSET", haircutBaseBps: 0, haircutFxBps: 0 }]],
      [schema.priceSnapshot, [{ assetId: ASSET_ID, guardedValue: "1.0000000", status: "Ok", createdAt: new Date() }]],
      [schema.draw, [{ creditLineId: LINE_ID, amount: "500.0000000" }]],
      [schema.repayment, []],
    ]),
  );
  return { app: buildServer({ config, db, contracts, chain }), contracts };
}

const release = (app: ReturnType<typeof server>["app"]) =>
  app.inject({ method: "DELETE", url: `/v1/credit-lines/${LINE_ID}/pledges/${RELEASED}`, headers: bearer() });

describe("DELETE /v1/credit-lines/:id/pledges/:pledgeId", () => {
  it("refuses a release that only breaches once accrued interest is counted", async () => {
    // 500 principal + 200 interest = 700 owed: 700 / 800 = 87.5%, past the 70% threshold.
    const { app, contracts } = server({ ltv: vi.fn().mockResolvedValue({ debt: 7_000_000_000n }) });

    const res = await release(app);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ projectedLtvBps: 8750, debtSource: "on-chain" });
    expect(contracts.pledgeVault.release).not.toHaveBeenCalled();
  });

  it("refuses a release that would leave the line in Warning, as the contract does", async () => {
    // 600 owed against 800 left: 75%, past the 70% warning threshold but short of margin call.
    const { app, contracts } = server({ ltv: vi.fn().mockResolvedValue({ debt: 6_000_000_000n }) });

    const res = await release(app);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ projectedLtvBps: 7500, debtSource: "on-chain" });
    expect(contracts.pledgeVault.release).not.toHaveBeenCalled();
  });

  it("allows the release when the on-chain debt is within the threshold", async () => {
    const { app } = server({ ltv: vi.fn().mockResolvedValue({ debt: 5_000_000_000n }) });

    const res = await release(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ xdr: "xdr-release", projectedLtvBps: 6250, debtSource: "on-chain" });
  });

  it("falls back to the Postgres estimate when the contract read throws", async () => {
    const { app } = server({ ltv: vi.fn().mockRejectedValue(new Error("rpc down")) });

    const res = await release(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ projectedLtvBps: 6250, debtSource: "estimate" });
  });
});
