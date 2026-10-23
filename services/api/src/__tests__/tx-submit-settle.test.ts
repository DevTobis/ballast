import { afterEach, describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@ballast/db";
import type { ApiConfig } from "../config.js";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { signSessionToken } from "../session-token.js";

/**
 * `POST /v1/tx/submit` once the envelope is on the network: a settle attempt
 * that throws (an RPC blip in `chain.outcome`, bookkeeping that fails) must
 * never surface as a 5xx — the wallet user would retry, sign again, and
 * because the first envelope was real, possibly double-act. The intent is
 * back to `pending` and the sweeper will settle it, so the honest answers
 * are 200 once a later poll succeeds, else 202 "accepted, still pending".
 */

const config: ApiConfig = {
  port: 0, jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  sep10HomeDomain: "localhost", sep10WebAuthDomain: "localhost",
  networkPassphrase: "Test SDF Network ; September 2015",
  webhookSecretKey: "00".repeat(32), apiKeySecretKey: "00".repeat(32),
  complianceEnforced: false, consoleOrigin: "http://localhost:5173",
};

const PARTY = { partyId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", account: "GCALLER" };
const TX_HASH = "feedface";
const bearer = (account: string) => ({ authorization: `Bearer ${signSessionToken(account, config.jwtSigningSecret)}` });

/** The intents.test.ts fake, plus select fixtures: settleIntent needs
 * `update(...).set(...).where(...).returning()` for the pending -> final flip. */
function makeDb(rows: Map<unknown, unknown[]>, claimRows: unknown[] = [{}]) {
  const updated: Array<{ table: unknown; set: Record<string, unknown> }> = [];
  const chainRows = (data: unknown[]): any => {
    const promise: any = Promise.resolve(data);
    promise.where = () => chainRows(data);
    promise.orderBy = () => chainRows(data);
    promise.limit = () => chainRows(data);
    return promise;
  };
  const db = {
    select: () => ({ from: (table: unknown) => chainRows(rows.get(table) ?? []) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const done: any = Promise.resolve();
        done.returning = async () => [{ id: "fixture-id", ...values }];
        return done;
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          updated.push({ table, set });
          const done: any = Promise.resolve([]);
          done.returning = async () => claimRows;
          return done;
        },
      }),
    }),
  } as unknown as Database;
  return { db, updated };
}

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    txHash: TX_HASH,
    kind: "credit_line.open",
    refId: "line-uuid",
    partyId: PARTY.partyId,
    payload: {},
    status: "pending",
    ledger: null,
    error: null,
    createdAt: new Date(),
    settledAt: null,
    ...overrides,
  };
}

function server(outcome: ReturnType<typeof vi.fn>) {
  const { db, updated } = makeDb(
    new Map<unknown, unknown[]>([
      [schema.partyAccount, [{ partyId: PARTY.partyId, stellarAccount: PARTY.account, role: "borrower" }]],
      [schema.txIntent, [intentRow()]],
    ]),
  );
  const send = vi.fn().mockResolvedValue(undefined);
  const chain = { txHash: () => TX_HASH, send, outcome } as unknown as ChainGateway;
  const app = buildServer({ config, db, contracts: {} as ContractClients, chain });
  return { app, send, updated };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /v1/tx/submit when settling throws after the send", () => {
  it("still answers 200 settled when outcome throws once and succeeds on the next poll", async () => {
    vi.useFakeTimers();
    const outcome = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc hiccup (simulated)"))
      .mockResolvedValue({ status: "SUCCESS", ledger: 777, returnValue: 4n });
    const { app, send } = server(outcome);

    const pending = app.inject({
      method: "POST", url: "/v1/tx/submit",
      headers: bearer(PARTY.account), payload: { signedXdr: "AAAA-signed" },
    });
    await vi.runAllTimersAsync();
    const res = await pending;

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ txHash: TX_HASH, status: "settled", ledger: 777 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome).toHaveBeenCalledTimes(2);
  });

  it("answers 202 pending, not 500, when every settle attempt throws", async () => {
    vi.useFakeTimers();
    const outcome = vi.fn().mockRejectedValue(new Error("rpc still down (simulated)"));
    const { app } = server(outcome);

    const pending = app.inject({
      method: "POST", url: "/v1/tx/submit",
      headers: bearer(PARTY.account), payload: { signedXdr: "AAAA-signed" },
    });
    await vi.runAllTimersAsync();
    const res = await pending;

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ txHash: TX_HASH, kind: "credit_line.open", status: "pending", ledger: null });
  });

  it("still reports a failed send as 502 — that step is the caller's to retry", async () => {
    const outcome = vi.fn();
    const { app, send } = server(outcome);
    send.mockRejectedValue(new Error("the network rejected the envelope"));

    const res = await app.inject({
      method: "POST", url: "/v1/tx/submit",
      headers: bearer(PARTY.account), payload: { signedXdr: "AAAA-signed" },
    });

    expect(res.statusCode).toBe(502);
    expect(outcome).not.toHaveBeenCalled();
  });
});
