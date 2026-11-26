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

const HOLDER = { partyId: "99999999-9999-9999-9999-999999999999", account: "GHOLDERACCOUNT" };
const QUOTE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ASSET_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const chain = { txHash: () => "tx-hash" } as unknown as ChainGateway;
const bearer = () => ({ authorization: `Bearer ${signSessionToken(HOLDER.account, config.jwtSigningSecret)}` });

// The quote pays 99 USDC (990000000 scaled), so the 99% floor is 980100000.
const QUOTED = 990_000_000n;
const FLOOR = 980_100_000n;

function server(opts: { pending?: boolean } = {}) {
  const exitDesk = { exit: vi.fn().mockResolvedValue("xdr-exit") };
  const db = createFakeDb(
    new Map<unknown, unknown[]>([
      [schema.partyAccount, [{ partyId: HOLDER.partyId, stellarAccount: HOLDER.account, role: "borrower" }]],
      [
        schema.exitQuote,
        [
          {
            id: QUOTE_ID,
            holderId: HOLDER.partyId,
            assetId: ASSET_ID,
            units: "100.0000000",
            usdcOut: "99.0000000",
            expiresAt: new Date(Date.now() + 60_000),
            status: "open",
          },
        ],
      ],
      [schema.asset, [{ id: ASSET_ID, contractC: "CASSET" }]],
      [
        schema.txIntent,
        opts.pending ? [{ txHash: "earlier", refId: QUOTE_ID, kind: "exit.execute", status: "pending" }] : [],
      ],
    ]),
  );
  const app = buildServer({ config, db, contracts: { exitDesk } as unknown as ContractClients, chain });
  return { app, exitDesk };
}

const execute = (app: ReturnType<typeof server>["app"], payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/v1/exit/quotes/${QUOTE_ID}/execute`, headers: bearer(), payload });

describe("POST /v1/exit/quotes/:id/execute", () => {
  it("refuses a second execute while one is already pending for the quote", async () => {
    const { app, exitDesk } = server({ pending: true });

    const res = await execute(app, { minUsdcOut: QUOTED.toString(), to: "GDEST" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already pending/);
    expect(exitDesk.exit).not.toHaveBeenCalled();
  });

  it("rejects a minUsdcOut below the slippage floor", async () => {
    const { app, exitDesk } = server();

    const res = await execute(app, { minUsdcOut: "1", to: "GDEST" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      minUsdcOutFloor: FLOOR.toString(),
      quotedUsdcOut: QUOTED.toString(),
    });
    expect(exitDesk.exit).not.toHaveBeenCalled();
  });

  it("accepts a minUsdcOut exactly at the floor", async () => {
    const { app, exitDesk } = server();

    const res = await execute(app, { minUsdcOut: FLOOR.toString(), to: "GDEST" });

    expect(res.statusCode).toBe(201);
    expect(exitDesk.exit).toHaveBeenCalledWith(HOLDER.account, "CASSET", 1_000_000_000n, FLOOR, "GDEST");
  });

  it("uses the quoted payout when minUsdcOut is omitted", async () => {
    const { app, exitDesk } = server();

    const res = await execute(app, { to: "GDEST" });

    expect(res.statusCode).toBe(201);
    expect(exitDesk.exit).toHaveBeenCalledWith(HOLDER.account, "CASSET", 1_000_000_000n, QUOTED, "GDEST");
  });
});
