import { describe, expect, it, vi } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { pollOnce } from "./poller.js";
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

    const result = await pollOnce(db, rpc, ["CCONTRACT1"], mockLogger);

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
