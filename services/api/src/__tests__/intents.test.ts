import { describe, expect, it, vi } from "vitest";
import { signSessionToken } from "../session-token.js";
import { schema, type Database } from "@ballast/db";
import type { ChainGateway } from "../chain.js";
import type { ApiConfig } from "../config.js";
import type { ContractClients } from "../contract-clients.js";
import { INTENT_EXPIRY_MS, settleIntent, sweepPendingIntents } from "../intents.js";
import { buildServer } from "../server.js";

/**
 * Fake DB for the settlement path: `select().from(table)` returns that table's fixture rows
 * (chained `where`/`limit` don't filter), every `insert`/`update` is recorded, and
 * `update(...).returning()` yields `claimRows` — one row means "this caller won the
 * pending -> final flip", none means someone else already had.
 */
function makeDb(rows: Map<unknown, unknown[]>, claimRows: unknown[] = [{}]) {
  const inserted: Array<{ table: unknown; values: any }> = [];
  const updated: Array<{ table: unknown; set: any }> = [];
  const chain = (data: unknown[]): any => {
    const promise: any = Promise.resolve(data);
    promise.where = () => chain(data);
    promise.limit = () => chain(data);
    return promise;
  };
  const db: any = {
    select: () => ({ from: (table: unknown) => chain(rows.get(table) ?? []) }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        inserted.push({ table, values });
      },
    }),
    update: (table: unknown) => ({
      set: (set: unknown) => ({
        where: () => {
          updated.push({ table, set });
          const done: any = Promise.resolve([]);
          done.returning = async () => claimRows;
          return done;
        },
      }),
    }),
    transaction: async (cb: (trx: any) => Promise<any>) => cb(db),
  };
  return { db: db as Database, inserted, updated };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    txHash: "abc123",
    kind: "credit_line.open",
    refId: "line-uuid",
    partyId: "party-1",
    payload: {},
    status: "pending",
    ledger: null,
    error: null,
    createdAt: new Date(),
    settledAt: null,
    ...overrides,
  } as typeof schema.txIntent.$inferSelect;
}

const chainWith = (outcome: unknown) =>
  ({ txHash: () => "abc123", send: vi.fn(), outcome: vi.fn().mockResolvedValue(outcome) }) as unknown as ChainGateway;

const noContracts = {} as ContractClients;

describe("settleIntent", () => {
  it("books the on-chain line id when an open transaction succeeds", async () => {
    const { db, updated } = makeDb(new Map());
    const chain = chainWith({ status: "SUCCESS", ledger: 777, returnValue: 4n });

    const result = await settleIntent(db, chain, noContracts, intent());

    expect(result).toMatchObject({ status: "settled", ledger: 777, kind: "credit_line.open" });
    expect(updated).toContainEqual({ table: schema.creditLine, set: { contractLineId: "4", status: "open" } });
  });

  it("changes nothing while the network has no verdict", async () => {
    const { db, updated, inserted } = makeDb(new Map());

    const result = await settleIntent(db, chainWith({ status: "NOT_FOUND" }), noContracts, intent());

    expect(result.status).toBe("pending");
    expect(updated).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it("records a draw with its amount, hash and ledger", async () => {
    const { db, inserted } = makeDb(new Map());
    const chain = chainWith({ status: "SUCCESS", ledger: 900, returnValue: undefined });

    await settleIntent(db, chain, noContracts, intent({ kind: "credit_line.draw", payload: { amount: "200000000" } }));

    expect(inserted).toEqual([
      {
        table: schema.draw,
        values: { creditLineId: "line-uuid", amount: "20.0000000", txHash: "abc123", ledger: 900 },
      },
    ]);
  });

  it("splits a repayment into principal and interest from what the contract still shows as drawn", async () => {
    // 20 drawn and nothing repaid in Postgres; the contract shows 0.0000004 still drawn after a
    // 20.0000000 payment, so 19.9999996 went to principal and the rest to interest.
    const { db, inserted } = makeDb(
      new Map<unknown, unknown[]>([
        [schema.creditLine, [{ id: "line-uuid", contractLineId: "4" }]],
        [schema.draw, [{ amount: "20.0000000" }]],
        [schema.repayment, []],
      ]),
    );
    const contracts = { creditLine: { line: vi.fn().mockResolvedValue({ drawn: 4n }) } } as unknown as ContractClients;
    const chain = chainWith({ status: "SUCCESS", ledger: 901, returnValue: undefined });

    await settleIntent(db, chain, contracts, intent({ kind: "credit_line.repay", payload: { amount: "200000000" } }));

    expect(inserted[0].values).toMatchObject({ principal: "19.9999996", interest: "0.0000004", ledger: 901 });
  });

  it("puts a pledge back to active when its release transaction fails on-chain", async () => {
    const { db, updated } = makeDb(new Map());

    const result = await settleIntent(
      db,
      chainWith({ status: "FAILED", ledger: 5 }),
      noContracts,
      intent({ kind: "pledge.release", refId: "pledge-uuid" }),
    );

    expect(result.status).toBe("failed");
    expect(updated).toContainEqual({ table: schema.pledge, set: { status: "active" } });
  });

  it("applies nothing when another caller already settled the same intent", async () => {
    const { db, updated } = makeDb(new Map([[schema.txIntent, [intent({ status: "settled", ledger: 777 })]]]), []);
    const chain = chainWith({ status: "SUCCESS", ledger: 777, returnValue: 4n });

    const result = await settleIntent(db, chain, noContracts, intent());

    expect(result).toMatchObject({ status: "settled", ledger: 777 });
    expect(updated.filter((u) => u.table === schema.creditLine)).toHaveLength(0);
  });

  it("rolls back the intent claim and leaves it pending if book update fails", async () => {
    let rolledBack = false;
    let committed = false;
    const { db } = makeDb(new Map());
    // Simulate real transaction rollback on error:
    db.transaction = async (cb: any) => {
      try {
        const res = await cb(db);
        committed = true;
        return res;
      } catch (e) {
        rolledBack = true;
        throw e;
      }
    };
    // Force book update failure by throwing on creditLine update
    db.update = ((orig: any) => (table: unknown) => {
      if (table === schema.creditLine) {
        throw new Error("DB connection lost during line update");
      }
      return orig(table);
    })(db.update) as any;

    const chain = chainWith({ status: "SUCCESS", ledger: 777, returnValue: 4n });

    await expect(settleIntent(db, chain, noContracts, intent())).rejects.toThrow("DB connection lost during line update");
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
  });

  it("doesn't ask the network about an intent that is already final", async () => {
    const { db } = makeDb(new Map());
    const chain = chainWith({ status: "SUCCESS", ledger: 1 });

    const result = await settleIntent(db, chain, noContracts, intent({ status: "failed", ledger: 9 }));

    expect(result).toMatchObject({ status: "failed", ledger: 9 });
    expect(chain.outcome).not.toHaveBeenCalled();
  });
});

describe("sweepPendingIntents", () => {
  it("writes off a transaction that was never submitted and can no longer land", async () => {
    const stale = intent({ createdAt: new Date(Date.now() - INTENT_EXPIRY_MS - 1000) });
    const { db, updated } = makeDb(new Map([[schema.txIntent, [stale]]]));

    const tally = await sweepPendingIntents(db, chainWith({ status: "NOT_FOUND" }), noContracts);

    expect(tally).toEqual({ settled: 0, failed: 0, expired: 1, errors: 0 });
    expect(updated).toContainEqual({ table: schema.creditLine, set: { status: "failed" } });
    expect(updated.some((u) => u.table === schema.txIntent && u.set.status === "expired")).toBe(true);
  });

  it("keeps going past an intent the network errors on, and still ages it out", async () => {
    const broken = intent({ txHash: "bad", createdAt: new Date(Date.now() - INTENT_EXPIRY_MS - 1000) });
    const fine = intent({ txHash: "good" });
    const { db } = makeDb(new Map([[schema.txIntent, [broken, fine]]]));
    const chain = {
      outcome: vi.fn(async (hash: string) => {
        if (hash === "bad") throw new Error("unexpected hash length");
        return { status: "SUCCESS", ledger: 5, returnValue: 1n };
      }),
    } as unknown as ChainGateway;

    const tally = await sweepPendingIntents(db, chain, noContracts);

    expect(tally).toEqual({ settled: 1, failed: 0, expired: 1, errors: 1 });
  });

  it("leaves a recent unsubmitted transaction pending", async () => {
    const { db, updated } = makeDb(new Map([[schema.txIntent, [intent()]]]));

    const tally = await sweepPendingIntents(db, chainWith({ status: "NOT_FOUND" }), noContracts);

    expect(tally).toEqual({ settled: 0, failed: 0, expired: 0, errors: 0 });
    expect(updated).toHaveLength(0);
  });

  it("settles a transaction that landed without going through /v1/tx/submit", async () => {
    const { db } = makeDb(new Map([[schema.txIntent, [intent()]]]));

    const tally = await sweepPendingIntents(
      db,
      chainWith({ status: "SUCCESS", ledger: 12, returnValue: 7n }),
      noContracts,
    );

    expect(tally).toEqual({ settled: 1, failed: 0, expired: 0, errors: 0 });
  });
});

describe("POST /v1/tx/submit", () => {
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
  const ACCOUNT = "GCALLERACCOUNT";
  const headers = { authorization: `Bearer ${signSessionToken(ACCOUNT, config.jwtSigningSecret)}` };
  const account: [unknown, unknown[]] = [schema.partyAccount, [{ partyId: "party-1", stellarAccount: ACCOUNT }]];

  it("refuses to relay a transaction this API never built", async () => {
    const { db } = makeDb(new Map<unknown, unknown[]>([account]));
    const chain = chainWith({ status: "NOT_FOUND" });
    const app = buildServer({ config, db, contracts: noContracts, chain });

    const res = await app.inject({ method: "POST", url: "/v1/tx/submit", headers, payload: { signedXdr: "x" } });

    expect(res.statusCode).toBe(404);
    expect(chain.send).not.toHaveBeenCalled();
  });

  it("refuses to submit another party's transaction", async () => {
    const { db } = makeDb(new Map<unknown, unknown[]>([account, [schema.txIntent, [intent({ partyId: "someone-else" })]]]));
    const chain = chainWith({ status: "NOT_FOUND" });
    const app = buildServer({ config, db, contracts: noContracts, chain });

    const res = await app.inject({ method: "POST", url: "/v1/tx/submit", headers, payload: { signedXdr: "x" } });

    expect(res.statusCode).toBe(404);
    expect(chain.send).not.toHaveBeenCalled();
  });

  it("sends the caller's own transaction and reports it settled", async () => {
    const { db, updated } = makeDb(new Map<unknown, unknown[]>([account, [schema.txIntent, [intent()]]]));
    const chain = chainWith({ status: "SUCCESS", ledger: 321, returnValue: 9n });
    const app = buildServer({ config, db, contracts: noContracts, chain });

    const res = await app.inject({ method: "POST", url: "/v1/tx/submit", headers, payload: { signedXdr: "signed" } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ txHash: "abc123", status: "settled", ledger: 321 });
    expect(chain.send).toHaveBeenCalledWith("signed");
    expect(updated).toContainEqual({ table: schema.creditLine, set: { contractLineId: "9", status: "open" } });
  });
});
