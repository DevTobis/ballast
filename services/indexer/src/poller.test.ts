import { describe, expect, it, vi } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { pollOnce, computeRpcLag, runIndexerCycle, type IndexerState } from "./poller.js";
import { withRetry, type RpcClient } from "./rpc.js";

/** Minimal fake of the slice of `Database` (drizzle) that `pollOnce` touches. */
function fakeDb(opts: { lastLedger: number | null; inserted: unknown[] }) {
  return {
    select: () => ({
      from: () => Promise.resolve([{ maxLedger: opts.lastLedger }]),
    }),
    insert: () => ({
      values: (rows: unknown[]) => {
        opts.inserted.push(...rows);
        return Object.assign(Promise.resolve(), { onConflictDoNothing: () => Promise.resolve() });
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeRpc(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 5000 }),
    getHealth: vi
      .fn()
      .mockResolvedValue({ latestLedger: 5000, oldestLedger: 1, ledgerRetentionWindow: 120960 }),
    getEvents: vi.fn().mockResolvedValue({ latestLedger: 5000, events: [] }),
    ...overrides,
  };
}

describe("pollOnce", () => {
  it("cold-starts from latestLedger - 1000 when chain_event is empty", async () => {
    const inserted: unknown[] = [];
    const db = fakeDb({ lastLedger: null, inserted });
    const getEvents = vi.fn().mockResolvedValue({ latestLedger: 5000, events: [] });
    const rpc = fakeRpc({ getEvents });

    const result = await pollOnce(db, rpc, ["CCONTRACT1"]);

    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 4000, filters: [{ contractIds: ["CCONTRACT1"] }] }),
    );
    expect(result.fromLedger).toBe(4000);
    expect(result.latestLedger).toBe(5000);
    expect(inserted).toHaveLength(0);
  });

  it("splits more than 5 contracts across filters (the RPC rejects a larger filter)", async () => {
    const db = fakeDb({ lastLedger: 10, inserted: [] });
    const getEvents = vi.fn().mockResolvedValue({ latestLedger: 20, events: [] });
    const ids = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"];

    await pollOnce(db, fakeRpc({ getEvents }), ids);

    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ contractIds: ["C1", "C2", "C3", "C4", "C5"] }, { contractIds: ["C6", "C7"] }],
      }),
    );
  });

  it("resumes from max(ledger) + 1 on a warm start and inserts one row per event", async () => {
    const inserted: Array<{ ledger: number; txHash: string; contract: string; topic: string; data: unknown }> = [];
    const db = fakeDb({ lastLedger: 4200, inserted });

    const topic = [nativeToScVal("pledge", { type: "symbol" }), nativeToScVal(42, { type: "u32" })];
    const value = nativeToScVal(1_000_000n, { type: "i128" });

    const getEvents = vi.fn().mockResolvedValue({
      latestLedger: 4300,
      events: [
        {
          id: "0000004201-0000000001",
          ledger: 4201,
          txHash: "deadbeef",
          contractId: "CCONTRACT1",
          topic,
          value,
        },
      ],
    });
    const rpc = fakeRpc({ getEvents });

    const result = await pollOnce(db, rpc, ["CCONTRACT1"]);

    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 4201 }),
    );
    expect(result.insertedCount).toBe(1);
    expect(inserted).toHaveLength(1);

    const row = inserted[0] as (typeof inserted)[number] & { eventId: string };
    // The RPC's event id is what makes re-ingesting the same range a no-op.
    expect(row.eventId).toBe("0000004201-0000000001");
    expect(row.ledger).toBe(4201);
    expect(row.txHash).toBe("deadbeef");
    expect(row.contract).toBe("CCONTRACT1");
    expect(row.topic).toBe("pledge");
    // bigint values must be stringified before hitting the jsonb column — this would throw if not
    JSON.stringify(row.data);
    expect((row.data as { value: string }).value).toBe("1000000");
    expect((row.data as { topics: number[] }).topics).toEqual([42]);
  });

  it("stores an undecodable event with raw XDR, logs a warning with event id and ledger, and does not block later events", async () => {
    const inserted: Array<{ eventId: string; ledger: number; txHash: string; contract: string; topic: string; data: any }> = [];
    const db = fakeDb({ lastLedger: 5000, inserted });

    const goodTopic = [nativeToScVal("draw", { type: "symbol" })];
    const goodValue = nativeToScVal(500_000n, { type: "i128" });

    // Poison event with value that makes scValToNative throw
    const badValue = {
      toXDR: () => "cG9pc29uLXhkcg==",
      get type(): never {
        throw new Error("unsupported ScVal type");
      },
    } as any;

    const warnSpy = vi.fn();
    const mockLogger = {
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const getEvents = vi.fn().mockResolvedValue({
      latestLedger: 5010,
      events: [
        {
          id: "0000005001-0000000001",
          ledger: 5001,
          txHash: "hash-bad",
          contractId: "CCONTRACT1",
          topic: [nativeToScVal("unknown_type", { type: "symbol" })],
          value: badValue,
        },
        {
          id: "0000005001-0000000002",
          ledger: 5001,
          txHash: "hash-good",
          contractId: "CCONTRACT1",
          topic: goodTopic,
          value: goodValue,
        },
      ],
    });
    const rpc = fakeRpc({ getEvents });

    const result = await pollOnce(db, rpc, ["CCONTRACT1"], undefined, mockLogger);

    expect(result.insertedCount).toBe(2);
    expect(inserted).toHaveLength(2);

    // First event is stored as undecodable
    const badRow = inserted[0];
    expect(badRow.eventId).toBe("0000005001-0000000001");
    expect(badRow.ledger).toBe(5001);
    expect(badRow.topic).toBe("undecodable");
    expect(badRow.data).toMatchObject({
      raw: "cG9pc29uLXhkcg==",
    });
    expect(badRow.data.error).toBeDefined();

    // Logger warned with eventId and ledger
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "0000005001-0000000001",
        ledger: 5001,
      }),
      expect.stringContaining("undecodable event"),
    );

    // Second event was NOT blocked and decoded properly
    const goodRow = inserted[1];
    expect(goodRow.eventId).toBe("0000005001-0000000002");
    expect(goodRow.ledger).toBe(5001);
    expect(goodRow.topic).toBe("draw");
    expect(goodRow.data).toMatchObject({
      value: "500000",
    });
  });

  it("resumes from cursorLedger + 1 without querying database max(ledger) when cursorLedger is provided", async () => {
    const selectSpy = vi.fn(() => ({
      from: () => Promise.resolve([{ maxLedger: 100 }]),
    }));
    const db = {
      select: selectSpy,
      insert: () => ({
        values: () => Object.assign(Promise.resolve(), { onConflictDoNothing: () => Promise.resolve() }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const getEvents = vi.fn().mockResolvedValue({ latestLedger: 550, events: [] });
    const rpc = fakeRpc({ getEvents });

    const result = await pollOnce(db, rpc, ["CCONTRACT1"], 500);

    // select was not called because cursorLedger was provided directly
    expect(selectSpy).not.toHaveBeenCalled();
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 501 }),
    );
    expect(result.fromLedger).toBe(501);
    expect(result.latestLedger).toBe(550);
    expect(result.scannedUpTo).toBe(550);
  });

  it("clamps a resume cursor older than the RPC retention window instead of retrying forever", async () => {
    const db = fakeDb({ lastLedger: 1000, inserted: [] });
    const oldestLedger = 1200;

    // Mirrors Stellar RPC: a startLedger below the retained range is rejected outright.
    const getEvents = vi.fn(async (args: { startLedger: number }) => {
      if (args.startLedger < oldestLedger) {
        throw new Error(`startLedger must be within the ledger range: ${oldestLedger} - 5000`);
      }
      return { latestLedger: 5000, events: [] };
    });
    const rpc = fakeRpc({
      getEvents,
      getHealth: vi
        .fn()
        .mockResolvedValue({ latestLedger: 5000, oldestLedger, ledgerRetentionWindow: 120960 }),
    });

    const result = await pollOnce(db, rpc, ["CCONTRACT1"]);

    expect(getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: oldestLedger }));
    expect(result.fromLedger).toBe(oldestLedger);
    expect(result.skippedFrom).toBe(1001);
    expect(result.skippedTo).toBe(1199);
    expect(result.scannedUpTo).toBe(5000);
  });
});

describe("computeRpcLag", () => {
  it("reports zero lag and not lagging when lastScannedLedger is undefined", () => {
    const result = computeRpcLag(5000, undefined, 12);
    expect(result).toEqual({ lagLedgers: 0, isLagging: false });
  });

  it("reports not lagging when difference is at or below threshold", () => {
    expect(computeRpcLag(5012, 5000, 12)).toEqual({ lagLedgers: 12, isLagging: false });
    expect(computeRpcLag(5001, 5000, 12)).toEqual({ lagLedgers: 1, isLagging: false });
    expect(computeRpcLag(5000, 5000, 12)).toEqual({ lagLedgers: 0, isLagging: false });
  });

  it("reports lagging when difference exceeds threshold", () => {
    expect(computeRpcLag(5013, 5000, 12)).toEqual({ lagLedgers: 13, isLagging: true });
    expect(computeRpcLag(5120, 5000, 12)).toEqual({ lagLedgers: 120, isLagging: true });
  });
});

describe("runIndexerCycle", () => {
  it("does not fire rpc_lag_high during a long quiet period when indexer is caught up", async () => {
    const db = fakeDb({ lastLedger: 4000, inserted: [] });
    const alerter = { fire: vi.fn() };
    const getEvents = vi.fn().mockResolvedValue({ latestLedger: 5000, events: [] });
    const rpc = fakeRpc({
      getEvents,
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 5000 }),
    });
    const state: IndexerState = {};

    // Cycle 1: initial run catches up to tip 5000 (chain quiet, no events)
    await runIndexerCycle(db, rpc, ["CCONTRACT1"], state, alerter, 12);
    expect(state.lastScannedLedger).toBe(5000);
    expect(alerter.fire).not.toHaveBeenCalled();

    // Cycle 2: 1 ledger later on quiet chain
    rpc.getLatestLedger = vi.fn().mockResolvedValue({ sequence: 5001 });
    getEvents.mockResolvedValue({ latestLedger: 5001, events: [] });
    await runIndexerCycle(db, rpc, ["CCONTRACT1"], state, alerter, 12);
    expect(state.lastScannedLedger).toBe(5001);
    expect(alerter.fire).not.toHaveBeenCalled();
    // Verify it asked for 5001, not DB's 4001
    expect(getEvents).toHaveBeenLastCalledWith(expect.objectContaining({ startLedger: 5001 }));

    // Cycle 3: simulate 120 ledgers of quiet chain (10 minutes) where poller kept up to ledger 5119
    state.lastScannedLedger = 5119;
    rpc.getLatestLedger = vi.fn().mockResolvedValue({ sequence: 5120 });
    getEvents.mockResolvedValue({ latestLedger: 5120, events: [] });
    await runIndexerCycle(db, rpc, ["CCONTRACT1"], state, alerter, 12);
    expect(state.lastScannedLedger).toBe(5120);
    expect(alerter.fire).not.toHaveBeenCalled();
    expect(getEvents).toHaveBeenLastCalledWith(expect.objectContaining({ startLedger: 5120 }));
  });

  it("fires rpc_lag_high when RPC tip is far ahead of what has been scanned", async () => {
    const db = fakeDb({ lastLedger: 5000, inserted: [] });
    const alerter = { fire: vi.fn() };
    const getEvents = vi.fn().mockResolvedValue({ latestLedger: 5025, events: [] });
    const rpc = fakeRpc({
      getEvents,
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 5025 }), // 25 ledgers ahead of 5000
    });
    const state: IndexerState = { lastScannedLedger: 5000 };

    await runIndexerCycle(db, rpc, ["CCONTRACT1"], state, alerter, 12);

    expect(alerter.fire).toHaveBeenCalledTimes(1);
    expect(alerter.fire).toHaveBeenCalledWith("rpc_lag_high", {
      lagLedgers: 25,
      latestLedger: 5025,
      lastScannedLedger: 5000,
      lastIngestedFrom: 5000,
    });
    expect(state.lastScannedLedger).toBe(5025);
  });

  it("fires event_gap_skipped when the resume cursor is older than the RPC retention window", async () => {
    const db = fakeDb({ lastLedger: 5000, inserted: [] });
    const alerter = { fire: vi.fn() };
    const rpc = fakeRpc({
      getHealth: vi
        .fn()
        .mockResolvedValue({ latestLedger: 5000, oldestLedger: 4800, ledgerRetentionWindow: 120960 }),
    });
    const state: IndexerState = { lastScannedLedger: 4700 };

    await runIndexerCycle(db, rpc, ["CCONTRACT1"], state, alerter, 10000);

    expect(alerter.fire).toHaveBeenCalledWith("event_gap_skipped", {
      fromLedger: 4701,
      toLedger: 4799,
    });
    expect(state.lastScannedLedger).toBe(5000);
  });
});

describe("withRetry", () => {
  it("returns the first successful result after transient failures", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValue("ok");

    await expect(withRetry(fn, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured attempts and rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("rpc down"));

    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow("rpc down");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
