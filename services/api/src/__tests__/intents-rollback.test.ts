import { describe, expect, it, vi } from "vitest";
import { schema, type Database } from "@ballast/db";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { settleIntent } from "../intents.js";

/**
 * The catch block in settleIntent hands a settled-on-chain intent back to
 * `pending` with the error text when the *bookkeeping* throws, and rethrows
 * so a later call retries. These tests throw from inside applySuccess and
 * applyFailure and pin all three promises: the error propagates, the status
 * is reset with the message, and a retry applies the effect exactly once.
 */

const LINE_ID = "line-uuid";

function makeDb(
  rows: Map<unknown, unknown[]>,
  options: { failUpdateOf?: unknown } = {},
) {
  const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
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
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserted.push({ table, values });
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          if (table === options.failUpdateOf) {
            throw new Error("database update failed (simulated)");
          }
          updated.push({ table, set });
          const done: any = Promise.resolve([]);
          done.returning = async () => [{}];
          return done;
        },
      }),
    }),
  } as unknown as Database;
  return { db, inserted, updated };
}

function repayIntent() {
  return {
    txHash: "repay-tx",
    kind: "credit_line.repay",
    refId: LINE_ID,
    partyId: "party-1",
    payload: { amount: "50000000" },
    status: "pending",
    ledger: null,
    error: null,
    createdAt: new Date(),
    settledAt: null,
  } as typeof schema.txIntent.$inferSelect;
}

const successChain = () =>
  ({ txHash: () => "repay-tx", send: vi.fn(), outcome: vi.fn().mockResolvedValue({ status: "SUCCESS", ledger: 900, returnValue: null }) }) as unknown as ChainGateway;

const fixtures = () =>
  new Map<unknown, unknown[]>([
    [schema.creditLine, [{ id: LINE_ID, contractLineId: "7" }]],
    [schema.draw, [{ creditLineId: LINE_ID, amount: "10" }]],
    [schema.repayment, []],
  ]);

describe("settleIntent rollback when the bookkeeping throws", () => {
  it("resets a repay to pending with the error and settles exactly once on retry", async () => {
    const { db, inserted, updated } = makeDb(fixtures());
    const line = vi.fn().mockRejectedValueOnce(new Error("contract read timed out (simulated)"));
    line.mockResolvedValue({ drawn: "0" });
    const contracts = { creditLine: { line } } as unknown as ContractClients;

    // First call: the on-chain outcome stands, applySuccess throws reading the
    // line back, the error propagates and the intent is handed back.
    await expect(settleIntent(db, successChain(), contracts, repayIntent())).rejects.toThrow(
      "contract read timed out (simulated)",
    );
    expect(updated).toContainEqual({
      table: schema.txIntent,
      set: { status: "pending", error: "contract read timed out (simulated)" },
    });
    expect(inserted).toHaveLength(0);

    // Second call with the failure gone: the repayment books exactly once.
    const retried = await settleIntent(db, successChain(), contracts, repayIntent());
    expect(retried).toMatchObject({ status: "settled", ledger: 900 });
    const repayments = inserted.filter(({ table }) => table === schema.repayment);
    expect(repayments).toHaveLength(1);
    expect(repayments[0]!.values).toMatchObject({ creditLineId: LINE_ID, txHash: "repay-tx" });
  });

  it("resets the intent the same way when applyFailure's own db write throws", async () => {
    // A FAILED outcome books through applyFailure; its creditLine update is
    // made to throw while the txIntent writes (the claim flip and the reset)
    // still work.
    const { db, updated } = makeDb(fixtures(), { failUpdateOf: schema.creditLine });
    const failedChain = {
      txHash: () => "open-tx",
      send: vi.fn(),
      outcome: vi.fn().mockResolvedValue({ status: "FAILED", ledger: 901, returnValue: null }),
    } as unknown as ChainGateway;
    const intent = { ...repayIntent(), txHash: "open-tx", kind: "credit_line.open" } as typeof schema.txIntent.$inferSelect;

    await expect(settleIntent(db, failedChain, {} as ContractClients, intent)).rejects.toThrow(
      "database update failed (simulated)",
    );
    expect(updated).toContainEqual({
      table: schema.txIntent,
      set: { status: "pending", error: "database update failed (simulated)" },
    });

    // With the db healthy again, the same intent settles as failed in one call.
    const healthy = makeDb(fixtures());
    const retried = await settleIntent(healthy.db, failedChain, {} as ContractClients, intent);
    expect(retried).toMatchObject({ status: "failed", ledger: 901 });
    const lineUpdates = healthy.updated.filter(({ table }) => table === schema.creditLine);
    expect(lineUpdates).toEqual([{ table: schema.creditLine, set: { status: "failed" } }]);
  });
});
