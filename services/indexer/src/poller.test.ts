import { describe, expect, it, vi } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { schema } from "@ballast/db";
import { pollOnce } from "./poller.js";
import { withRetry, type RpcClient } from "./rpc.js";

/** Minimal fake of the slice of `Database` (drizzle) that `pollOnce` touches. */
function fakeDb(opts: {
  lastLedger?: number | null;
  cursorLedger?: number | null;
  inserted?: unknown[];
  cursors?: Array<{ id: string; lastLedger: number }>;
}) {
  const inserted = opts.inserted ?? [];
  const cursors =
    opts.cursors ??
    (opts.cursorLedger !== undefined && opts.cursorLedger !== null
      ? [{ id: "default", lastLedger: opts.cursorLedger }]
      : []);

  return {
    select: () => ({
      from: (table: any) => {
        if (table === schema.indexerCursor) {
          return {
            where: () => ({
              limit: () => Promise.resolve(cursors),
            }),
            limit: () => Promise.resolve(cursors),
          };
        }
        return Promise.resolve([{ maxLedger: opts.lastLedger ?? null }]);
      },
    }),
    insert: (table: any) => ({
      values: (val: any) => {
        if (table === schema.indexerCursor) {
          const row = Array.isArray(val) ? val[0] : val;
          const existing = cursors.find((c) => c.id === row.id);
          if (existing) {
            existing.lastLedger = row.lastLedger;
          } else {
            cursors.push({ id: row.id, lastLedger: row.lastLedger });
          }
          return {
            onConflictDoUpdate: () => Promise.resolve(),
          };
        }
        const rows = Array.isArray(val) ? val : [val];
        inserted.push(...rows);
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

  it("first run: cold starts and records indexer_cursor at latestLedger", async () => {
    const cursors: Array<{ id: string; lastLedger: number }> = [];
    const db = fakeDb({ lastLedger: null, cursors });
    const rpc = fakeRpc({
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 8000 }),
      getEvents: vi.fn().mockResolvedValue({ latestLedger: 8000, events: [] }),
    });

    const result = await pollOnce(db, rpc, ["C1"]);
    expect(result.fromLedger).toBe(7000);
    expect(cursors).toEqual([{ id: "default", lastLedger: 8000 }]);
  });

  it("warm start without a cursor row: falls back to chain_event max ledger and writes cursor", async () => {
    const cursors: Array<{ id: string; lastLedger: number }> = [];
    const db = fakeDb({ lastLedger: 6500, cursors });
    const getEvents = vi.fn().mockResolvedValue({ latestLedger: 6520, events: [] });
    const rpc = fakeRpc({ getEvents });

    const result = await pollOnce(db, rpc, ["C1"]);
    expect(getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 6501 }));
    expect(result.fromLedger).toBe(6501);
    expect(cursors).toEqual([{ id: "default", lastLedger: 6520 }]);
  });

  it("warm start with a cursor row: resumes from cursor.lastLedger + 1", async () => {
    const cursors = [{ id: "default", lastLedger: 9100 }];
    const db = fakeDb({ lastLedger: 4000, cursors }); // chain_event is older than cursor
    const getEvents = vi.fn().mockResolvedValue({ latestLedger: 9110, events: [] });
    const rpc = fakeRpc({ getEvents });

    const result = await pollOnce(db, rpc, ["C1"]);
    expect(getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 9101 }));
    expect(result.fromLedger).toBe(9101);
    expect(cursors[0].lastLedger).toBe(9110);
  });

  it("advances cursor during quiet periods with 0 events returned", async () => {
    const cursors = [{ id: "default", lastLedger: 10000 }];
    const db = fakeDb({ lastLedger: null, cursors });
    const getEvents = vi.fn().mockResolvedValue({ latestLedger: 10025, events: [] });
    const rpc = fakeRpc({ getEvents });

    const result = await pollOnce(db, rpc, ["C1"]);
    expect(result.insertedCount).toBe(0);
    expect(cursors[0].lastLedger).toBe(10025);

    // Next poll resumes from the updated cursor
    const nextGetEvents = vi.fn().mockResolvedValue({ latestLedger: 10030, events: [] });
    await pollOnce(db, fakeRpc({ getEvents: nextGetEvents }), ["C1"]);
    expect(nextGetEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 10026 }));
    expect(cursors[0].lastLedger).toBe(10030);
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
