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

describe("a retried close_liquidated settlement", () => {
  it("lists its transaction hash exactly once", async () => {
    const updated: Array<{ table: unknown; set: Record<string, unknown> }> = [];
    const rows = new Map<unknown, unknown[]>([
      [schema.creditLine, [{ id: "line-1", contractLineId: "7" }]],
      // A previous attempt already appended this hash before the next statement failed.
      [schema.liquidation, [{ id: "liq-1", creditLineId: "line-1", txHashes: ["close-tx"], startedAt: new Date() }]],
    ]);
    const base = createFakeDb(rows);
    const db = {
      ...base,
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: () => {
            updated.push({ table, set });
            const done: any = Promise.resolve([]);
            done.returning = async () => [{}];
            return done;
          },
        }),
      }),
    } as unknown as Database;
    const chain = {
      txHash: () => "close-tx",
      outcome: vi.fn().mockResolvedValue({ status: "SUCCESS", ledger: 900, returnValue: null }),
    } as unknown as ChainGateway;
    const contracts = {
      creditLine: { liquidationRecord: vi.fn().mockResolvedValue({ recovered: "100", shortfall: "0" }) },
    } as unknown as ContractClients;
    const intent = {
      txHash: "close-tx",
      kind: "credit_line.close_liquidated",
      refId: "line-1",
      partyId: "party-1",
      payload: {},
      status: "pending",
      ledger: null,
      error: null,
      createdAt: new Date(),
      settledAt: null,
    } as typeof schema.txIntent.$inferSelect;

    await settleIntent(db, chain, contracts, intent);

    const liquidationUpdate = updated.find((u) => u.table === schema.liquidation);
    expect(liquidationUpdate?.set.txHashes).toEqual(["close-tx"]);
  });
});

describe("POST /v1/credit-lines when recording the intent fails", () => {
  const LENDER_PARTY = "11111111-1111-4111-8111-111111111111";
  const BORROWER_PARTY = "22222222-2222-4222-8222-222222222222";
  const ACCOUNT = "GLENDERACCOUNT";

  /** Rows written inside a transaction are discarded if it throws, as Postgres would. */
  function transactionalDb(opts: { failIntentInsert: boolean }) {
    const written: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const base = createFakeDb(
      new Map<unknown, unknown[]>([
        [schema.partyAccount, [{ partyId: LENDER_PARTY, stellarAccount: ACCOUNT, role: "lender" }]],
      ]),
    );
    const db: any = {
      ...base,
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          const write = () => {
            if (table === schema.txIntent && opts.failIntentInsert) throw new Error("intent insert failed");
            written.push({ table, values });
            return { id: "new-row", ...values };
          };
          return {
            returning: async () => [write()],
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve().then(write).then(resolve, reject),
          };
        },
      }),
      transaction: async (cb: (trx: unknown) => Promise<unknown>) => {
        const before = written.length;
        try {
          return await cb(db);
        } catch (err) {
          written.length = before;
          throw err;
        }
      },
    };
    return { db: db as Database, written };
  }

  const payload = {
    lenderId: LENDER_PARTY,
    borrowerId: BORROWER_PARTY,
    loanCcy: "USDC",
    limit: "1000000000",
    rateBps: 500,
    cureWindowS: 86400,
    asset: "CASSET",
    agreementHash: "ab".repeat(32),
  };

  async function open(failIntentInsert: boolean) {
    const { db, written } = transactionalDb({ failIntentInsert });
    const contracts = { creditLine: { open: vi.fn().mockResolvedValue("xdr-open") } } as unknown as ContractClients;
    const chain = { txHash: () => "tx-hash" } as unknown as ChainGateway;
    const app = buildServer({ config, db, contracts, chain });
    const res = await app.inject({
      method: "POST",
      url: "/v1/credit-lines",
      headers: { authorization: `Bearer ${signSessionToken(ACCOUNT, config.jwtSigningSecret)}` },
      payload,
    });
    return { res, written };
  }

  it("leaves no pending credit line behind", async () => {
    const { res, written } = await open(true);

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(written.filter((w) => w.table === schema.creditLine)).toHaveLength(0);
  });

  it("writes both the credit line and its intent on the happy path", async () => {
    const { res, written } = await open(false);

    expect(res.statusCode).toBe(201);
    expect(written.filter((w) => w.table === schema.creditLine)).toHaveLength(1);
    expect(written.filter((w) => w.table === schema.txIntent)).toHaveLength(1);
  });
});
