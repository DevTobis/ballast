import { describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { settleIntent } from "../intents.js";
import { buildServer } from "../server.js";
import { signSessionToken } from "../session-token.js";
import { createFakeDb } from "./fake-db.js";

const config: ApiConfig = {
  port: 0, jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  sep10HomeDomain: "localhost", sep10WebAuthDomain: "localhost",
  networkPassphrase: "Test SDF Network ; September 2015",
  webhookSecretKey: "00".repeat(32), apiKeySecretKey: "00".repeat(32),
  complianceEnforced: false, consoleOrigin: "http://localhost:5173",
};

const BORROWER = { partyId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", account: "GBORROWER" };
const TRADE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const chain = { txHash: () => "topup-tx" } as unknown as ChainGateway;
const bearer = (account: string) => ({ authorization: `Bearer ${signSessionToken(account, config.jwtSigningSecret)}` });

function server(caller = BORROWER, trade: Record<string, unknown> = {}) {
  const topUp = vi.fn().mockResolvedValue("xdr-topup");
  const db = createFakeDb(
    new Map<unknown, unknown[]>([
      [schema.partyAccount, [{ partyId: caller.partyId, stellarAccount: caller.account, role: "borrower" }]],
      [schema.repoTrade, [{ id: TRADE_ID, cashBorrowerId: BORROWER.partyId, cashLenderId: "lender", status: "settled", contractTradeId: "9", ...trade }]],
    ]),
  );
  return { app: buildServer({ config, db, contracts: { repoDvp: { topUp } } as unknown as ContractClients, chain }), topUp };
}

describe("POST /v1/repo/trades/:id/top-ups", () => {
  it("builds a top_up transaction for the cash borrower", async () => {
    const { app, topUp } = server();
    const res = await app.inject({ method: "POST", url: `/v1/repo/trades/${TRADE_ID}/top-ups`, headers: bearer(BORROWER.account), payload: { units: "500000000" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ xdr: "xdr-topup", txHash: "topup-tx" });
    expect(topUp).toHaveBeenCalledWith("GBORROWER", 9n, 500000000n);
  });

  it("refuses anyone but the cash borrower", async () => {
    const { app, topUp } = server({ partyId: "lender", account: "GLENDER" });
    const res = await app.inject({ method: "POST", url: `/v1/repo/trades/${TRADE_ID}/top-ups`, headers: bearer("GLENDER"), payload: { units: "1" } });
    expect(res.statusCode).toBe(403);
    expect(topUp).not.toHaveBeenCalled();
  });

  it.each(["proposed", "unwound", "defaulted"])("refuses a trade that is %s", async (status) => {
    const { app, topUp } = server(BORROWER, { status });
    const res = await app.inject({ method: "POST", url: `/v1/repo/trades/${TRADE_ID}/top-ups`, headers: bearer(BORROWER.account), payload: { units: "1" } });
    expect(res.statusCode).toBe(409);
    expect(topUp).not.toHaveBeenCalled();
  });
});

describe("POST /v1/repo/trades/:id/unwind", () => {
  const LENDER = { partyId: "llllllll-llll-llll-llll-llllllllllll", account: "GLENDERACCOUNT" };
  const STRANGER = { partyId: "ssssssss-ssss-ssss-ssss-ssssssssssss", account: "GSTRANGERACCOUNT" };

  function unwindServer(caller = BORROWER) {
    const unwind = vi.fn().mockResolvedValue("xdr-unwind");
    const db = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.partyAccount, [
          { partyId: caller.partyId, stellarAccount: caller.account, role: "user" },
        ]],
        [schema.repoTrade, [{ id: TRADE_ID, cashBorrowerId: BORROWER.partyId, cashLenderId: LENDER.partyId, status: "settled", contractTradeId: "9" }]],
      ]),
    );
    const app = buildServer({
      config,
      db,
      contracts: { repoDvp: { unwind } } as unknown as ContractClients,
      chain: { txHash: () => "unwind-tx" } as unknown as ChainGateway,
    });
    return { app, unwind };
  }

  it("builds an unwind transaction with the lender account when lender calls", async () => {
    const { app, unwind } = unwindServer(LENDER);
    const res = await app.inject({
      method: "POST",
      url: `/v1/repo/trades/${TRADE_ID}/unwind`,
      headers: bearer(LENDER.account),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ xdr: "xdr-unwind", txHash: "unwind-tx", tradeId: TRADE_ID });
    expect(unwind).toHaveBeenCalledWith(LENDER.account, 9n);
  });

  it("builds an unwind transaction with the borrower account when borrower calls", async () => {
    const { app, unwind } = unwindServer(BORROWER);
    const res = await app.inject({
      method: "POST",
      url: `/v1/repo/trades/${TRADE_ID}/unwind`,
      headers: bearer(BORROWER.account),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ xdr: "xdr-unwind", txHash: "unwind-tx", tradeId: TRADE_ID });
    expect(unwind).toHaveBeenCalledWith(BORROWER.account, 9n);
  });

  it("returns 404 for an authenticated stranger not involved in the trade", async () => {
    const { app, unwind } = unwindServer(STRANGER);
    const res = await app.inject({
      method: "POST",
      url: `/v1/repo/trades/${TRADE_ID}/unwind`,
      headers: bearer(STRANGER.account),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "repo trade not found" });
    expect(unwind).not.toHaveBeenCalled();
  });
});

describe("settling a repo.top_up transaction", () => {
  const settle = async (onChain: object) => {
    const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];
    const chainable = (rows: unknown[]) => {
      const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
      p.where = () => chainable(rows);
      p.limit = () => chainable(rows);
      return p;
    };
    const db = {
      select: () => ({ from: (t: unknown) => chainable(t === schema.repoTrade ? [{ id: TRADE_ID, contractTradeId: "9" }] : []) }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => {
          updates.push({ table, set });
          return { where: () => Object.assign(Promise.resolve([]), { returning: async () => [{}] }) };
        },
      }),
    } as unknown as Database;
    const settleChain = { outcome: async () => ({ status: "SUCCESS", ledger: 5, returnValue: undefined }) } as unknown as ChainGateway;
    const intent = { txHash: "t", kind: "repo.top_up", refId: TRADE_ID, partyId: "p", payload: null, status: "pending", ledger: null, error: null, createdAt: new Date(), settledAt: null };
    await settleIntent(db, settleChain, { repoDvp: { trade: async () => onChain } } as unknown as ContractClients, intent);
    return updates;
  };

  it("records the new unit total and marks open margin calls cured when the contract cleared the call", async () => {
    const updates = await settle({ units: 2_000_000_000n, pendingMarginCall: false });
    expect(updates.find((u) => u.table === schema.repoTrade && "units" in u.set)!.set).toEqual({ units: "200.0000000" });
    expect(updates.some((u) => u.table === schema.repoMarginCall && u.set.curedAt instanceof Date)).toBe(true);
  });

  it("leaves the margin call open when the top-up was not enough", async () => {
    const updates = await settle({ units: 1_010_000_000n, pendingMarginCall: true });
    expect(updates.some((u) => u.table === schema.repoMarginCall)).toBe(false);
  });
});
