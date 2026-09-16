import { beforeEach, describe, expect, it, vi } from "vitest";

const { fireSpy } = vi.hoisted(() => ({ fireSpy: vi.fn() }));

vi.mock("@ballast/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ballast/observability")>();
  return {
    ...actual,
    createConsoleAlerter: () => ({ fire: fireSpy }),
  };
});

const { recomputeLine } = await import("./monitor.js");

/**
 * A minimal fake `Database` whose `.select().from().where()` chain is awaitable directly (bare
 * `await db.select()...where(...)`) and also chainable with `.orderBy().limit()` or `.limit()` —
 * both draw from the same ordered queue, matching the exact call sequence `recomputeLine` issues.
 */
function makeDb(queue: unknown[][]) {
  let i = 0;
  const next = () => queue[i++] ?? [];
  const where = vi.fn(() => ({
    then: (resolve: (v: unknown) => void) => resolve(next()),
    orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(next())) })),
    limit: vi.fn(() => Promise.resolve(next())),
  }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  return { select, insert, values } as any;
}

beforeEach(() => {
  fireSpy.mockClear();
});

describe("recomputeLine", () => {
  it("is a no-op when the state hasn't changed", async () => {
    const db = makeDb([[{ toState: "Healthy" }]]); // last margin_event
    const creditLineClient = {
      ltv: vi.fn().mockResolvedValue({
        debt: 100n,
        collateralValue: 1000n,
        ltvBps: 1000,
        state: "Healthy",
        priceStatus: "Ok",
      }),
    };

    const result = await recomputeLine(db, creditLineClient as any, { id: "line-1", contractLineId: "42" });

    expect(creditLineClient.ltv).toHaveBeenCalledWith(42n);
    expect(result.changed).toBe(false);
    expect(result.toState).toBe("Healthy");
    expect(db.insert).not.toHaveBeenCalled();
    expect(fireSpy).not.toHaveBeenCalled();
  });

  it("records a margin_event and fires an alert when the state moves to MarginCall", async () => {
    const db = makeDb([
      [{ toState: "Warning" }], // last margin_event
      [{ assetId: "asset-1" }], // pledge lookup
      [{ id: "snapshot-1" }], // latest price_snapshot for that asset
    ]);
    const creditLineClient = {
      ltv: vi.fn().mockResolvedValue({
        debt: 850n,
        collateralValue: 1000n,
        ltvBps: 8500,
        state: "MarginCall",
        priceStatus: "Ok",
      }),
    };

    const result = await recomputeLine(db, creditLineClient as any, { id: "line-1", contractLineId: "42" });

    expect(result.changed).toBe(true);
    expect(result.fromState).toBe("Warning");
    expect(result.toState).toBe("MarginCall");
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        creditLineId: "line-1",
        fromState: "Warning",
        toState: "MarginCall",
        ltvBps: 8500,
        priceSnapshotId: "snapshot-1",
      }),
    );
    expect(fireSpy).toHaveBeenCalledWith(
      "margin_call",
      expect.objectContaining({ creditLineId: "line-1", state: "MarginCall" }),
    );
  });

  it("treats a line with no prior margin_event as Healthy for the fromState comparison", async () => {
    const db = makeDb([[], [{ assetId: "asset-1" }], []]);
    const creditLineClient = {
      ltv: vi.fn().mockResolvedValue({
        debt: 100n,
        collateralValue: 1000n,
        ltvBps: 1000,
        state: "Warning",
        priceStatus: "Ok",
      }),
    };

    const result = await recomputeLine(db, creditLineClient as any, { id: "line-2", contractLineId: "7" });

    expect(result.fromState).toBeNull();
    expect(result.changed).toBe(true);
    expect(db.values).toHaveBeenCalledWith(expect.objectContaining({ fromState: "Healthy", toState: "Warning" }));
  });
});
