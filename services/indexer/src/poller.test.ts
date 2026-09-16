import { describe, expect, it, vi } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { pollOnce } from "./poller.js";
import type { RpcClient } from "./rpc.js";

/** Minimal fake of the slice of `Database` (drizzle) that `pollOnce` touches. */
function fakeDb(opts: { lastLedger: number | null; inserted: unknown[] }) {
  return {
    select: () => ({
      from: () => Promise.resolve([{ maxLedger: opts.lastLedger }]),
    }),
    insert: () => ({
      values: (rows: unknown[]) => {
        opts.inserted.push(...rows);
        return Promise.resolve();
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

  it("resumes from max(ledger) + 1 on a warm start and inserts one row per event", async () => {
    const inserted: Array<{ ledger: number; txHash: string; contract: string; topic: string; data: unknown }> = [];
    const db = fakeDb({ lastLedger: 4200, inserted });

    const topic = [nativeToScVal("pledge", { type: "symbol" }), nativeToScVal(42, { type: "u32" })];
    const value = nativeToScVal(1_000_000n, { type: "i128" });

    const getEvents = vi.fn().mockResolvedValue({
      latestLedger: 4300,
      events: [
        {
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

    const row = inserted[0];
    expect(row.ledger).toBe(4201);
    expect(row.txHash).toBe("deadbeef");
    expect(row.contract).toBe("CCONTRACT1");
    expect(row.topic).toBe("pledge");
    // bigint values must be stringified before hitting the jsonb column — this would throw if not
    JSON.stringify(row.data);
    expect((row.data as { value: string }).value).toBe("1000000");
    expect((row.data as { topics: number[] }).topics).toEqual([42]);
  });
});
