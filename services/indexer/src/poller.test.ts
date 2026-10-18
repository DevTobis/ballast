import { describe, expect, it, vi } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { pollOnce } from "./poller.js";
import { withRetry, type RpcClient } from "./rpc.js";

/** Minimal fake of the slice of `Database` (drizzle) that `pollOnce` touches. */
function fakeDb(opts: { lastLedger: number | null; gapLedger?: number | null; inserted: unknown[] }) {
  let selectCount = 0;
  return {
    select: () => ({
      from: () => {
        selectCount++;
        const val = selectCount % 2 === 1 ? opts.lastLedger : (opts.gapLedger ?? null);
        return Promise.resolve([{ maxLedger: val }]);
      },
    }),
    insert: () => ({
      values: (rows: unknown) => {
        if (Array.isArray(rows)) {
          opts.inserted.push(...rows);
        } else {
          opts.inserted.push(rows);
        }
        return Object.assign(Promise.resolve(), { onConflictDoNothing: () => Promise.resolve() });
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeRpc(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 5000 }),
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

  it("detects a gap when startLedger is below oldestLedger, clamps, alerts once, and records in chain_event_gap", async () => {
    const inserted: unknown[] = [];
    const db = fakeDb({ lastLedger: 1000, inserted });
    const getEvents = vi.fn().mockResolvedValue({
      latestLedger: 6000,
      oldestLedger: 5000,
      events: [
        {
          id: "0000005000-0000000001",
          ledger: 5000,
          txHash: "cafebabe",
          contractId: "CCONTRACT1",
          topic: [nativeToScVal("pledge", { type: "symbol" })],
          value: nativeToScVal(100n, { type: "i128" }),
        },
      ],
    });
    const rpc = fakeRpc({ getEvents });
    const alerter = { fire: vi.fn() };
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any;

    const result = await pollOnce(db, rpc, ["CCONTRACT1"], alerter as any, logger);

    // Clamped startLedger
    expect(result.fromLedger).toBe(5000);
    expect(result.latestLedger).toBe(6000);
    expect(result.gap).toEqual({ fromLedger: 1001, toLedger: 4999 });

    // Alert fired once with fromLedger and toLedger
    expect(alerter.fire).toHaveBeenCalledTimes(1);
    expect(alerter.fire).toHaveBeenCalledWith(
      "indexer_gap",
      expect.objectContaining({ fromLedger: 1001, toLedger: 4999, oldestLedger: 5000 }),
    );

    // Logger logged the lost range
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fromLedger: 1001, toLedger: 4999 }),
      expect.stringContaining("detected gap in indexed ledgers from 1001 to 4999"),
    );

    // Gap recorded in chain_event_gap table
    expect(inserted).toContainEqual(
      expect.objectContaining({
        fromLedger: 1001,
        toLedger: 4999,
        status: "open",
      }),
    );
  });

  it("does not re-alert on the subsequent cycle when the gap was already clamped and recorded", async () => {
    const inserted: unknown[] = [];
    // Database now reflects the gap up to 4999, so next startLedger will be 5000
    const db = fakeDb({ lastLedger: null, gapLedger: 4999, inserted });
    const getEvents = vi.fn().mockResolvedValue({
      latestLedger: 6000,
      oldestLedger: 5000,
      events: [],
    });
    const rpc = fakeRpc({ getEvents });
    const alerter = { fire: vi.fn() };
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as any;

    const result = await pollOnce(db, rpc, ["CCONTRACT1"], alerter as any, logger);

    expect(result.fromLedger).toBe(5000);
    expect(result.gap).toBeUndefined();
    expect(alerter.fire).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
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
